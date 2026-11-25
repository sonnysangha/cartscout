import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createDiscovery, normalizeCode, normalizeMerchant } from './oxylabs.js';
import { createAlternativeDiscovery, parseBasket } from './alternatives.js';
import { openStore, reporterKey } from './store.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
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

export function createCouponServer({ store, discover, findAlternatives, now = Date.now, log = console.error }) {
  const pending = new Map();
  const pendingAlternativeItems = new Map();
  const alternativeCache = new Map();
  let budgetWindow = 0;
  let discoveryCount = 0;

  function payload(merchant, reporter, source) {
    const search = store.get(merchant);
    return {
      merchant, source, refreshedAt: search?.refreshed_at ?? null, partial: !!search?.partial,
      coupons: store.listing(merchant, reporter, now()),
    };
  }

  async function lookup(merchant, reporter) {
    const time = now();
    const cached = store.get(merchant);
    if (cached?.retry_at > time) return payload(merchant, reporter, 'cache');

    let refresh = pending.get(merchant);
    if (!refresh) {
      const window = Math.floor(time / 60_000);
      if (budgetWindow !== window) {
        budgetWindow = window;
        discoveryCount = 0;
      }
      if (pending.size >= 5 || discoveryCount >= 15) {
        if (cached) return payload(merchant, reporter, 'stale');
        throw new HttpError(429, 'Coupon search is busy. Try again shortly.');
      }
      discoveryCount += 1;
      refresh = (async () => {
        const result = await discover(merchant);
        store.save(merchant, result, now());
      })();
      pending.set(merchant, refresh);
    }
    try {
      await refresh;
      return payload(merchant, reporter, 'live');
    } catch (error) {
      log('Coupon discovery failed:', error.message);
      if (cached) return payload(merchant, reporter, 'stale');
      throw new HttpError(502, 'Coupon search is temporarily unavailable. Try again shortly.');
    } finally {
      if (pending.get(merchant) === refresh) pending.delete(merchant);
    }
  }

  async function alternatives(merchant, country, items) {
    if (!findAlternatives) throw new HttpError(503, 'Retailer search is unavailable.');
    const lookups = items.map(async (item) => {
      const key = JSON.stringify([merchant, country, item.name.toLowerCase(), item.variant.toLowerCase()]);
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
      if (request.method !== 'POST' || !['/v1/coupons', '/v1/reports', '/v1/alternatives'].includes(request.url)) {
        throw new HttpError(404, 'Route not found.');
      }
      const body = await readJson(request);
      const merchant = normalizeMerchant(body.merchant);
      if (!merchant) throw new HttpError(400, 'Enter a public merchant hostname.');
      const token = request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      if (!token) throw new HttpError(401, 'Missing installation token.');
      if (request.url === '/v1/alternatives') {
        const basket = parseBasket(body);
        if (!basket) throw new HttpError(400, 'Choose a supported country and provide basket products.');
        return send(200, await alternatives(merchant, basket.country, basket.items));
      }
      const reporter = reporterKey(token);
      if (request.url === '/v1/coupons') return send(200, await lookup(merchant, reporter));
      const code = normalizeCode(body.code);
      if (!code || typeof body.worked !== 'boolean') {
        throw new HttpError(400, 'Enter a coupon and whether it worked.');
      }
      if (!store.report(merchant, code, reporter, body.worked, now())) {
        throw new HttpError(404, 'This code is no longer in the merchant results.');
      }
      return send(200, payload(merchant, reporter, 'cache'));
    } catch (error) {
      if (!(error instanceof HttpError)) log('Coupon API request failed:', error.message);
      return send(error.status ?? 500, { error: error.status ? error.message : 'Coupon service error.' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const key = process.env.OXYLABS_WEB_API_KEY?.trim();
  if (!key) throw new Error('Set OXYLABS_WEB_API_KEY on the coupon server.');
  const location = process.env.OXYLABS_LOCATION?.trim().toUpperCase();
  if (location && !/^[A-Z]{2}$/.test(location)) throw new Error('Use a two-letter OXYLABS_LOCATION.');
  const store = openStore(process.env.DATABASE_PATH || 'data/cartscout.sqlite');
  const server = createCouponServer({
    store, discover: createDiscovery({ key, location }), findAlternatives: createAlternativeDiscovery({ key }),
  });
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8787);
  server.listen(port, host, () => console.log(`CartScout API listening on ${host}:${server.address().port}`));
}
