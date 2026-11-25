import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createDiscovery, normalizeCode, normalizeMerchant } from './oxylabs.js';
import { createAlternativeDiscovery, parseBasket } from './alternatives.js';
import { openStore, reporterKey } from './store.js';
import { createClerkAuthenticator } from './auth.js';

class HttpError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new HttpError(415, 'Expected JSON.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw new HttpError(413, 'Request too large.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

export function createCouponServer({
  store, discover, findAlternatives, authenticate, allowAnonymous = false, now = Date.now, log = console.error,
}) {
  if (!authenticate && !allowAnonymous) throw new Error('Configure Clerk authentication.');
  const pending = new Map();
  const pendingAlternativeItems = new Map();
  const alternativeCache = new Map();
  let budgetWindow = 0;
  let discoveryCount = 0;

  function accountDetails(identity, reporter) {
    return {
      userId: identity.userId,
      plan: identity.plan,
      scans: identity.plan === 'free' ? store.weeklyScans(reporter, now()) : null,
    };
  }

  function payload(merchant, cacheKey, reporter, source, identity) {
    const search = store.get(cacheKey);
    return {
      merchant, source, refreshedAt: search?.refreshed_at ?? null, partial: !!search?.partial,
      coupons: store.listing(cacheKey, reporter, now()),
      ...(identity && { account: accountDetails(identity, reporter) }),
    };
  }

  async function lookup(merchant, cacheKey, reporter, identity, cacheOnly) {
    const time = now();
    const cached = store.get(cacheKey);
    if (cached?.retry_at > time) return payload(merchant, cacheKey, reporter, 'cache', identity);
    if (cacheOnly && identity) {
      throw new HttpError(409, 'Scan this site to find coupon codes.', {
        code: 'scan_required', account: accountDetails(identity, reporter),
      });
    }

    let refresh = pending.get(cacheKey);
    if (!refresh) {
      const window = Math.floor(time / 60_000);
      if (budgetWindow !== window) {
        budgetWindow = window;
        discoveryCount = 0;
      }
      const limited = identity?.plan === 'free';
      const reservation = limited ? store.reserveScan(reporter, time) : null;
      if (limited && !reservation) {
        throw new HttpError(429, 'You’ve used all 5 free site scans for this week.', {
          code: 'scan_limit', account: accountDetails(identity, reporter),
        });
      }
      if (pending.size >= 5 || discoveryCount >= 15) {
        if (reservation) store.releaseScan(reservation);
        if (cached) return payload(merchant, cacheKey, reporter, 'stale', identity);
        throw new HttpError(429, 'Coupon search is busy. Try again shortly.');
      }
      discoveryCount += 1;
      refresh = (async () => {
        try {
          const result = await discover(merchant);
          store.save(cacheKey, result, now(), reservation);
        } catch (error) {
          if (reservation) store.releaseScan(reservation);
          throw error;
        }
      })();
      pending.set(cacheKey, refresh);
    }
    try {
      await refresh;
      return payload(merchant, cacheKey, reporter, 'live', identity);
    } catch (error) {
      log('Coupon discovery failed:', error.message);
      if (cached) return payload(merchant, cacheKey, reporter, 'stale', identity);
      throw new HttpError(502, 'Coupon search is temporarily unavailable. Try again shortly.');
    } finally {
      if (pending.get(cacheKey) === refresh) pending.delete(cacheKey);
    }
  }

  async function alternatives(merchant, cacheKey, country, items) {
    if (!findAlternatives) throw new HttpError(503, 'Retailer search is unavailable.');
    const lookups = items.map(async (item) => {
      const key = JSON.stringify([cacheKey, country, item.name.toLowerCase(), item.variant.toLowerCase()]);
      const cached = alternativeCache.get(key);
      if (cached?.expiresAt > now()) return cached.value;
      if (pendingAlternativeItems.has(key)) return pendingAlternativeItems.get(key);
      if (pendingAlternativeItems.size >= 8) throw new HttpError(429, 'Retailer search is busy. Try again shortly.');

      const lookup = (async () => {
        const value = await findAlternatives(merchant, country, item);
        if (!value.partial) {
          if (alternativeCache.size >= 256) alternativeCache.delete(alternativeCache.keys().next().value);
          alternativeCache.set(key, { value, expiresAt: now() + 15 * 60_000 });
        }
        return value;
      })();
      pendingAlternativeItems.set(key, lookup);
      try {
        return await lookup;
      } finally {
        pendingAlternativeItems.delete(key);
      }
    });
    const settled = await Promise.allSettled(lookups);
    if (settled.every((result) => result.status === 'rejected')) {
      const reason = settled[0].reason;
      if (reason instanceof HttpError) throw reason;
      log('Retailer lookup failed:', reason?.message);
      throw new HttpError(502, 'Retailer lookup is temporarily unavailable.');
    }
    return { country, results: items.map((item, index) => {
      const result = settled[index];
      return result.status === 'fulfilled'
        ? { ...item, ...result.value }
        : { ...item, offers: [], error: 'This item could not be checked.' };
    }) };
  }

  return createServer(async (request, response) => {
    function send(status, body) {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(body));
    }

    try {
      if (request.url === '/health' && request.method === 'GET') return send(200, { ok: true });
      const wantsAccount = request.method === 'GET' && request.url === '/v1/account';
      if (!wantsAccount && (request.method !== 'POST' || !['/v1/coupons', '/v1/reports', '/v1/alternatives'].includes(request.url))) {
        throw new HttpError(404, 'Route not found.');
      }

      const token = request.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
      const identity = authenticate && token ? await authenticate(token) : null;
      if (!identity && (wantsAccount || authenticate || !token || !/^[a-f0-9]{64}$/.test(token))) {
        throw new HttpError(401, 'Sign in to CartScout to continue.', { code: 'sign_in_required' });
      }
      const reporter = reporterKey(identity ? `clerk:${identity.userId}` : token);
      if (wantsAccount) return send(200, accountDetails(identity, reporter));

      const body = await readJson(request);
      const merchant = normalizeMerchant(body.merchant);
      if (!merchant) throw new HttpError(400, 'Enter a public merchant hostname.');
      const cacheKey = identity?.plan === 'free' ? `private:${reporter}:${merchant}` : merchant;
      if (request.url === '/v1/alternatives') {
        const basket = parseBasket(body);
        if (!basket) throw new HttpError(400, 'Choose a supported country and provide basket products.');
        return send(200, await alternatives(merchant, cacheKey, basket.country, basket.items));
      }
      if (request.url === '/v1/coupons') {
        if (Object.hasOwn(body, 'cacheOnly') && typeof body.cacheOnly !== 'boolean') {
          throw new HttpError(400, 'The cacheOnly option must be true or false.');
        }
        return send(200, await lookup(merchant, cacheKey, reporter, identity, body.cacheOnly));
      }
      const code = normalizeCode(body.code);
      if (!code || typeof body.worked !== 'boolean') {
        throw new HttpError(400, 'Enter a coupon and whether it worked.');
      }
      if (!store.report(cacheKey, code, reporter, body.worked, now())) {
        throw new HttpError(404, 'This code is no longer in the merchant results.');
      }
      return send(200, payload(merchant, cacheKey, reporter, 'cache', identity));
    } catch (error) {
      if (error instanceof HttpError) return send(error.status, { error: error.message, ...error.details });
      log('Coupon API request failed:', error.message);
      return send(500, { error: 'Coupon service error.' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const key = process.env.OXYLABS_WEB_API_KEY?.trim();
  if (!key) throw new Error('Set OXYLABS_WEB_API_KEY on the coupon server.');
  const location = process.env.OXYLABS_LOCATION?.trim().toUpperCase();
  if (location && !/^[A-Z]{2}$/.test(location)) throw new Error('Use a two-letter OXYLABS_LOCATION.');
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8787);
  const configured = process.env.CLERK_SECRET_KEY || process.env.CLERK_PUBLISHABLE_KEY || process.env.CLERK_ALLOWED_ORIGINS;
  const allowAnonymous = !configured && process.env.CARTSCOUT_ALLOW_ANONYMOUS === '1'
    && process.env.NODE_ENV !== 'production' && ['127.0.0.1', '::1', 'localhost'].includes(host);
  const authenticate = allowAnonymous ? undefined : createClerkAuthenticator({
    secretKey: process.env.CLERK_SECRET_KEY,
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
    allowedOrigins: process.env.CLERK_ALLOWED_ORIGINS,
    proPlan: process.env.CLERK_PRO_PLAN || 'pro',
  });
  const store = openStore(process.env.DATABASE_PATH || 'data/cartscout.sqlite');
  const server = createCouponServer({
    store, authenticate, allowAnonymous,
    discover: createDiscovery({ key, location }), findAlternatives: createAlternativeDiscovery({ key }),
  });
  server.listen(port, host, () => console.log(`CartScout API listening on ${host}:${server.address().port}`));
}
