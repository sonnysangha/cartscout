import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createDiscovery, normalizeCode, normalizeMerchant, registrableDomain, SCAN_CEILING } from './oxylabs.js';
import { cachedAlternatives } from './cached-alternatives.js';
import { createAlternativeDiscovery, LOOKUP_CEILING, parseBasket, retryCost } from './alternatives.js';
import { LOOKUP_LIFETIME, openStore, reporterKey, SCAN_LIFETIME } from './store.js';
import { openConvexStore } from './convex-store.js';
import { createClerkAuthenticator } from './auth.js';
import { budgetMessage, createBudget } from './budget.js';
import { readConfig } from './config.js';
import { createRecorder } from './recorder.js';
import { openReplayFolder } from './replay.js';

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

// The service has one shared budget for live work. These keep any one member from spending all of it.
const MEMBER_SCANS_PER_MINUTE = 6;
const MEMBER_SCANS_AT_ONCE = 2;
const MEMBER_LOOKUPS_PER_MINUTE = 12;
const MEMBER_LOOKUPS_AT_ONCE = 4;

const iso = (time) => new Date(time).toISOString();

/**
 * `mode` says how the server may use Oxylabs. 'live' reads shops and retailers inside `budget`. 'replay' never sends
 * a request: scans and price lookups are answered from the database, however old, and from the `replay` folder.
 * 'off' never sends a request either: saved results still open and anything that needs live work is refused.
 */
export function createCouponServer({
  store, discover, findAlternatives, authenticate, allowAnonymous = false, now = Date.now, log = console.error,
  mode = 'live', budget = createBudget({ ledger: store.ledger }), replay,
}) {
  if (!authenticate && !allowAnonymous) throw new Error('Configure Clerk authentication.');
  // A member's scan in flight, by the key their list is saved under.
  const pending = new Map();
  // A live read of a shop in flight. Everyone who scans that shop meanwhile waits for the same read.
  const reading = new Map();
  const pendingAlternativeItems = new Map();
  let budgetWindow = 0;
  let discoveryCount = 0;
  const memberUse = new Map();
  const memberBusy = new Map();

  function openWindow(time) {
    const window = Math.floor(time / 60_000);
    if (budgetWindow === window) return;
    budgetWindow = window;
    discoveryCount = 0;
    memberUse.clear();
  }

  // Counts one piece of live work against a member for this minute. False means they have had their share.
  function spend(reporter, kind, limit) {
    const used = memberUse.get(reporter) ?? { scans: 0, lookups: 0 };
    if (used[kind] >= limit || (!memberUse.has(reporter) && memberUse.size >= 10_000)) return false;
    used[kind] += 1;
    memberUse.set(reporter, used);
    return true;
  }

  const working = (key) => memberBusy.get(key) ?? 0;
  const startWork = (key) => memberBusy.set(key, working(key) + 1);
  function endWork(key) {
    if (working(key) > 1) memberBusy.set(key, working(key) - 1);
    else memberBusy.delete(key);
  }
  const slowDown = (message) => new HttpError(429, message, { code: 'slow_down' });
  const liveOff = () => new HttpError(503, 'Live searching is switched off on this CartScout server.', { code: 'live_off' });

  // The budget cannot cover the operation. "message" repeats "error" so a client can read either name, and resetAt
  // is when the budget that ran out starts again.
  function budgetReached(operation, refused) {
    const message = budgetMessage(operation, refused);
    return new HttpError(429, message, { code: 'budget_reached', message, resetAt: iso(refused.resetAt) });
  }

  // A scan of this shop failed outright a few minutes ago. It is answered from that note, not by asking Oxylabs again.
  function failedRecently(mark, time) {
    const minutes = Math.max(1, Math.ceil((mark.retry_at - time) / 60_000));
    const wait = minutes === 1 ? 'a minute' : `${minutes} minutes`;
    return new HttpError(502, `Scout couldn’t read this shop’s coupon pages a moment ago. Try again in about ${wait}.`, {
      code: 'scan_failed', retryAt: iso(mark.retry_at),
    });
  }

  async function accountDetails(identity, reporter) {
    return {
      userId: identity.userId,
      plan: identity.plan,
      scans: identity.plan === 'free' ? await store.weeklyScans(reporter, now()) : null,
    };
  }

  async function payload(merchant, cacheKey, reporter, source, identity) {
    const [search, coupons, account] = await Promise.all([
      store.get(cacheKey),
      store.listing(cacheKey, reporter, now()),
      identity ? accountDetails(identity, reporter) : Promise.resolve(null),
    ]);
    return {
      merchant, source, refreshedAt: search?.refreshed_at ?? null, partial: !!search?.partial,
      // fetchedAt is when the pages behind this list were read, and freshUntil when the list stops counting as fresh.
      // A list answered from pages read for an earlier scan says so, so the popup can show its real age.
      ...(search && { fetchedAt: iso(search.refreshed_at), freshUntil: iso(search.retry_at) }),
      ...(search?.reused && { reused: true }),
      ...(search?.seeded && { seeded: true }),
      coupons,
      ...(account && { account }),
    };
  }

  // What the server already holds about a shop (or a sibling subdomain on the same brand domain, e.g.
  // `uk.ridge.com` <-> `ridge.com`) that answers a scan without sending another request.
  async function shopRecord(merchant) {
    const exact = await store.shopScan(merchant);
    if (exact?.result.complete) return exact;
    const domain = registrableDomain(merchant);
    const sibling = domain ? await store.shopScanByDomain(domain) : null;
    if (sibling && (!exact || sibling.fetchedAt > exact.fetchedAt)) return sibling;
    return exact;
  }

  async function alreadyRead(merchant, time) {
    const record = await shopRecord(merchant);
    if (mode === 'replay') {
      // Replay answers from whatever is saved, however old, and treats it as a scan made now.
      const saved = record ?? replay?.scan(merchant);
      return saved ? { ...saved, freshFrom: time } : null;
    }
    // Anyone's complete scan from the last 24 hours covers this shop (and its regional subdomains) for everyone.
    return record?.result.complete && time - record.fetchedAt < SCAN_LIFETIME.complete ? record : null;
  }

  // Starts a live read of a shop and holds its worst case against the budget first, or says why it may not start.
  async function startReading(merchant, time) {
    // In replay a shop nobody saved takes the same path as a shop that could not be read.
    if (mode === 'replay') return { read: Promise.reject(new Error(`Nothing is saved to replay for ${merchant}`)) };
    const mark = await store.scanFailure(merchant);
    if (mark?.retry_at > time) return { refused: failedRecently(mark, time) };
    if (mode === 'off') return { refused: liveOff() };
    if (!discover) return { refused: new HttpError(503, 'Coupon search is unavailable.') };
    if (reading.size >= 5 || discoveryCount >= 15) {
      return { refused: new HttpError(429, 'Coupon search is busy. Try again shortly.') };
    }
    const { ticket, refused } = await budget.reserve('scan', SCAN_CEILING, time);
    if (refused) return { refused: budgetReached('scan', refused) };

    discoveryCount += 1;
    const read = (async () => {
      try {
        const result = await discover(merchant, { ticket });
        const fetchedAt = now();
        await store.clearScanFailure(merchant);
        await store.saveShopScan(merchant, result, fetchedAt);
        return { result, fetchedAt, seeded: false };
      } catch (error) {
        await store.markScanFailure(merchant, now());
        throw error;
      } finally {
        await ticket.release();
        reading.delete(merchant);
      }
    })();
    reading.set(merchant, read);
    return { read };
  }

  // When live work cannot run, the member still gets what is saved: their own list, or the shop's last read when
  // that is newer. Nothing is sent and no weekly scan is used.
  async function savedAnswer(merchant, cacheKey, reporter, identity, time) {
    const own = await store.get(cacheKey);
    const record = await shopRecord(merchant);
    if (record && (!own || record.fetchedAt > own.refreshed_at)) {
      await store.save(cacheKey, record.result, time, null, { fetchedAt: record.fetchedAt, reused: true, seeded: record.seeded });
    } else if (!own) {
      return null;
    }
    const current = await store.get(cacheKey);
    return payload(merchant, cacheKey, reporter, current.retry_at > time ? 'cache' : 'stale', identity);
  }

  async function lookup(merchant, cacheKey, reporter, identity, cacheOnly, force = false) {
    const time = now();
    const cached = await store.get(cacheKey);
    if (cacheOnly && pending.has(cacheKey)) {
      const account = identity && { account: await accountDetails(identity, reporter) };
      throw new HttpError(409, 'Scout is still scanning this shop.', { code: 'scan_in_progress', ...account });
    }
    if (!force && cached?.retry_at > time) return payload(merchant, cacheKey, reporter, 'cache', identity);
    // "Saved results only" is a promise that nothing will be spent, signed in or not.
    if (cacheOnly) {
      const account = identity && { account: await accountDetails(identity, reporter) };
      // A scan carries on after the popup that asked for it has closed. Reopening says so, and can join it for free.
      if (pending.has(cacheKey)) {
        throw new HttpError(409, 'Scout is still scanning this shop.', { code: 'scan_in_progress', ...account });
      }
      // For Pro members, any fresh shop scan in the shared pool (e.g. from another member or a seed) feeds straight
      // into the extension cache without asking for a fresh scan.
      if (identity?.plan !== 'free') {
        const ready = await alreadyRead(merchant, time);
        if (ready && (!cached || ready.fetchedAt > cached.refreshed_at)) {
          await store.save(cacheKey, ready.result, time, null, {
            fetchedAt: ready.fetchedAt, freshFrom: ready.freshFrom, reused: true, seeded: ready.seeded,
          });
          return payload(merchant, cacheKey, reporter, 'cache', identity);
        }
      }
      // A saved scan that has aged out is still theirs to see; spending a fresh scan stays their choice.
      if (cached) return payload(merchant, cacheKey, reporter, 'stale', identity);
      throw new HttpError(409, 'Scan this shop to find coupon codes.', { code: 'scan_required', ...account });
    }

    let refresh = pending.get(cacheKey);
    if (!refresh) {
      openWindow(time);
      const scanning = `scan:${reporter}`;
      if (working(scanning) >= MEMBER_SCANS_AT_ONCE || !spend(reporter, 'scans', MEMBER_SCANS_PER_MINUTE)) {
        if (cached) return payload(merchant, cacheKey, reporter, 'stale', identity);
        throw slowDown('That’s a lot of scans at once. Give Scout a minute, then try again.');
      }
      const limited = identity?.plan === 'free';
      const reservation = limited ? await store.reserveScan(reporter, time) : null;
      if (limited && !reservation) {
        throw new HttpError(429, 'You’ve used all 5 free scans for this week.', {
          code: 'scan_limit', account: await accountDetails(identity, reporter),
        });
      }
      // The answer comes from pages the server already read, from a read of the same shop that is running for
      // someone else, or from a live read. A Free member's scan counts against their week in all three cases, and
      // their list and thumbs stay their own: only the public pages are shared.
      const ready = force ? null : await alreadyRead(merchant, time);
      const started = ready ? null : reading.has(merchant) ? { read: reading.get(merchant) } : await startReading(merchant, time);
      if (started?.refused) {
        // Nothing was read, so nothing is charged: a refused scan leaves the member's weekly scans alone.
        if (reservation) await store.releaseScan(reservation);
        const saved = await savedAnswer(merchant, cacheKey, reporter, identity, time);
        if (saved) return saved;
        if (identity) started.refused.details.account = await accountDetails(identity, reporter);
        throw started.refused;
      }
      const read = ready ? Promise.resolve({ ...ready, reused: true }) : started.read;
      startWork(scanning);
      refresh = (async () => {
        try {
          const { result, fetchedAt, freshFrom, reused = false, seeded } = await read;
          // A scan that comes back empty because coupon sites could not be read gave the member nothing, so it is free.
          const charged = result.complete || result.coupons.length > 0;
          await store.save(cacheKey, result, now(), charged ? reservation : null, { fetchedAt, freshFrom, reused, seeded });
          if (reservation && !charged) await store.releaseScan(reservation);
        } catch (error) {
          if (reservation) await store.releaseScan(reservation);
          throw error;
        } finally {
          endWork(scanning);
        }
      })();
      pending.set(cacheKey, refresh);
    }
    try {
      await refresh;
      return payload(merchant, cacheKey, reporter, 'live', identity);
    } catch (error) {
      log('Coupon discovery failed:', error.message);
      const saved = await savedAnswer(merchant, cacheKey, reporter, identity, now());
      if (saved) return saved;
      throw new HttpError(502, 'Coupon search is temporarily unavailable. Try again shortly.');
    } finally {
      if (pending.get(cacheKey) === refresh) pending.delete(cacheKey);
    }
  }

  async function alternatives(merchant, reporter, country, items) {
    const looking = `lookup:${reporter}`;
    const lookups = items.map(async (item) => {
      const time = now();
      // Prices are public, so a lookup is shared by everyone who asks about the same product at the same shop.
      const key = JSON.stringify([merchant, country, item.name.toLowerCase(), item.variant.toLowerCase()]);
      const saved = await store.lookup(merchant, country, item);
      if (mode === 'replay') {
        const answer = saved ?? replay?.lookup(merchant, country, item);
        if (!answer) throw new Error(`Nothing is saved to replay for ${item.name}`);
        return { offers: answer.offers, partial: answer.partial, fetchedAt: iso(answer.fetchedAt) };
      }
      // Every saved answer says when its prices were read. One that is past its lifetime is only given when Scout
      // cannot look again, and is marked stale.
      const fromSaved = (stale) => ({
        offers: saved.offers, partial: saved.partial, fetchedAt: iso(saved.fetchedAt), ...(stale && { stale: true }),
      });
      // A partial answer keeps its retailers for six hours. After its half hour, only the pages that failed are
      // asked for again, and a page that has failed twice is left alone.
      const young = saved && time - saved.fetchedAt < LOOKUP_LIFETIME.complete;
      const retry = young && saved.partial ? retryCost(saved.pages) : 0;
      if (saved && (time < saved.freshUntil || (young && saved.partial && !retry))) return fromSaved(false);
      if (pendingAlternativeItems.has(key)) return pendingAlternativeItems.get(key);

      const refuse = (error) => {
        if (saved) return fromSaved(true);
        throw error;
      };
      if (mode === 'off') return refuse(liveOff());
      if (!findAlternatives) return refuse(new HttpError(503, 'Retailer search is unavailable.'));
      if (pendingAlternativeItems.size >= 8) return refuse(new HttpError(429, 'Retailer search is busy. Try again shortly.'));
      openWindow(time);
      if (working(looking) >= MEMBER_LOOKUPS_AT_ONCE || !spend(reporter, 'lookups', MEMBER_LOOKUPS_PER_MINUTE)) {
        return refuse(slowDown('That’s a lot of price checks at once. Give Scout a minute, then try again.'));
      }
      // The worst case is held before anything is sent: a search and four pages, or just the pages a retry asks for.
      const { ticket, refused } = await budget.reserve('lookup', retry || LOOKUP_CEILING, time);
      if (refused) return refuse(budgetReached('lookup', refused));

      startWork(looking);
      const lookup = (async () => {
        try {
          const value = await findAlternatives(merchant, country, item, { ticket, ...(retry && { previous: saved }) });
          const partial = !!value.partial;
          // After a retry the oldest price in the answer is still from the first look.
          const fetchedAt = retry ? saved.fetchedAt : now();
          const freshUntil = partial
            ? Math.min(now() + LOOKUP_LIFETIME.partial, fetchedAt + LOOKUP_LIFETIME.complete)
            : fetchedAt + LOOKUP_LIFETIME.complete;
          await store.saveLookup(merchant, country, item, { offers: value.offers, partial, pages: value.pages ?? [] }, { fetchedAt, freshUntil });
          return { offers: value.offers, partial, fetchedAt: iso(fetchedAt) };
        } catch (error) {
          if (saved) return fromSaved(true);
          throw error;
        } finally {
          await ticket.release();
          endWork(looking);
        }
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
      const refusal = settled.find((result) => result.reason instanceof HttpError)?.reason;
      if (refusal) throw refusal;
      log('Retailer lookup failed:', settled[0].reason?.message);
      throw new HttpError(502, 'Retailer lookup is temporarily unavailable.');
    }
    return { country, results: items.map((item, index) => {
      const result = settled[index];
      if (result.status === 'fulfilled') return { ...item, ...result.value };
      // A product that was refused says why; any other failure keeps the plain sentence.
      const { code } = result.reason instanceof HttpError ? result.reason.details : {};
      return { ...item, offers: [], error: code ? result.reason.message : 'This item could not be checked.', ...(code && { code }) };
    }) };
  }

  const allowedCorsOrigins = new Set([
    'http://localhost:8788',
    'http://127.0.0.1:8788',
    ...(process.env.PORTAL_ORIGIN ? [process.env.PORTAL_ORIGIN.replace(/\/$/, '')] : []),
    ...String(process.env.CLERK_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
  ]);

  return createServer(async (request, response) => {
    const reqOrigin = typeof request.headers.origin === 'string' ? request.headers.origin.replace(/\/$/, '') : '';
    const corsHeaders = reqOrigin && (allowedCorsOrigins.has(reqOrigin) || /^chrome-extension:\/\//.test(reqOrigin))
      ? {
          'Access-Control-Allow-Origin': reqOrigin,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          Vary: 'Origin',
        }
      : {};

    function send(status, body) {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders });
      response.end(JSON.stringify(body));
    }

    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, corsHeaders);
        response.end();
        return;
      }
      if (request.url === '/health' && request.method === 'GET') return send(200, { ok: true });
      const wantsAccount = request.method === 'GET' && request.url === '/v1/account';
      const wantsWins = request.method === 'GET' && request.url === '/v1/wins';
      if (!wantsAccount && !wantsWins && (request.method !== 'POST' || !['/v1/coupons', '/v1/reports', '/v1/alternatives', '/v1/alternatives/cached'].includes(request.url))) {
        throw new HttpError(404, 'Route not found.');
      }

      const token = request.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
      const identity = authenticate && token ? await authenticate(token) : null;
      if (!identity && (wantsAccount || wantsWins || authenticate || !token || !/^[a-f0-9]{64}$/.test(token))) {
        throw new HttpError(401, 'Sign in to CartScout to continue.', { code: 'sign_in_required' });
      }
      const reporter = reporterKey(identity ? `clerk:${identity.userId}` : token);
      if (wantsAccount) return send(200, await accountDetails(identity, reporter));
      if (wantsWins) {
        const isPro = !identity || identity.plan === 'pro';
        if (!isPro) {
          return send(200, { locked: true, count: await store.winsCount(now()), wins: [] });
        }
        return send(200, { locked: false, wins: await store.recentWins(now(), 12) });
      }

      const body = await readJson(request);
      const merchant = normalizeMerchant(body.merchant);
      if (!merchant) throw new HttpError(400, 'Scout can only look up public shop websites.');
      const cacheKey = identity?.plan === 'free' ? `private:${reporter}:${merchant}` : merchant;
      if (request.url === '/v1/alternatives' || request.url === '/v1/alternatives/cached') {
        const basket = parseBasket(body);
        if (!basket) throw new HttpError(400, 'Choose a supported country and provide basket products.');
        if (request.url.endsWith('/cached')) return send(200, await cachedAlternatives(store, merchant, basket, now()));
        return send(200, await alternatives(merchant, reporter, basket.country, basket.items));
      }
      if (request.url === '/v1/coupons') {
        if (Object.hasOwn(body, 'cacheOnly') && typeof body.cacheOnly !== 'boolean') {
          throw new HttpError(400, 'The cacheOnly option must be true or false.');
        }
        if (Object.hasOwn(body, 'force') && typeof body.force !== 'boolean') {
          throw new HttpError(400, 'The force option must be true or false.');
        }
        return send(200, await lookup(merchant, cacheKey, reporter, identity, body.cacheOnly, !body.cacheOnly && body.force === true));
      }
      const code = normalizeCode(body.code);
      if (!code || typeof body.worked !== 'boolean') {
        throw new HttpError(400, 'Enter a coupon and whether it worked.');
      }
      const savedAmount = typeof body.savedAmount === 'number' && Number.isFinite(body.savedAmount) && body.savedAmount > 0 && body.savedAmount <= 100_000
        ? body.savedAmount : null;
      const savedCurrency = typeof body.savedCurrency === 'string' && /^[A-Za-z]{3}$/.test(body.savedCurrency.trim())
        ? body.savedCurrency.trim().toUpperCase() : null;
      const FALLBACK_HANDLES = [
        'sam_k', 'alex_m', 'charlie_r', 'morgan_t', 'jamie_b', 'riley_w',
        'casey_p', 'drew_h', 'taylor_s', 'jordan_d', 'avery_n', 'quinn_l',
        'ella_v', 'finn_g', 'ruby_c', 'owen_f', 'isla_j', 'theo_b',
      ];
      const fallbackHandle = FALLBACK_HANDLES[parseInt(reporter.slice(0, 6), 16) % FALLBACK_HANDLES.length];
      const memberName = identity?.username || fallbackHandle;
      const saving = body.worked
        ? { ...(savedAmount !== null && { amount: savedAmount, currency: savedCurrency }), memberName }
        : undefined;
      if (!(await store.report(cacheKey, code, reporter, body.worked, now(), saving))) {
        throw new HttpError(404, 'This code is no longer listed for this shop.');
      }
      return send(200, await payload(merchant, cacheKey, reporter, 'cache', identity));
    } catch (error) {
      if (error instanceof HttpError) return send(error.status, { error: error.message, ...error.details });
      log('Coupon API request failed:', error.message);
      return send(500, { error: 'Coupon service error.' });
    }
  });
}

/**
 * Builds the API from the environment: Clerk, the database (Convex when CONVEX_SITE_URL/CONVEX_URL +
 * CARTSCOUT_CONVEX_SECRET are configured, else local SQLite), and Oxylabs in the mode the environment asks for.
 * In replay and off modes no Oxylabs client is made at all, so the server starts without OXYLABS_WEB_API_KEY.
 */
export function createFromEnv(env = process.env, { log = console.error } = {}) {
  const config = readConfig(env);
  const host = env.HOST || '127.0.0.1';
  const port = Number(env.PORT || 8787);
  const configured = env.CLERK_SECRET_KEY || env.CLERK_PUBLISHABLE_KEY || env.CLERK_ALLOWED_ORIGINS;
  const allowAnonymous = !configured && env.CARTSCOUT_ALLOW_ANONYMOUS === '1'
    && env.NODE_ENV !== 'production' && ['127.0.0.1', '::1', 'localhost'].includes(host);
  const authenticate = allowAnonymous ? undefined : createClerkAuthenticator({
    secretKey: env.CLERK_SECRET_KEY,
    jwtKey: env.CLERK_JWT_KEY?.trim() || undefined,
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
    allowedOrigins: env.CLERK_ALLOWED_ORIGINS,
    proPlan: env.CLERK_PRO_PLAN || 'pro',
  });
  const convexSiteUrl = env.CONVEX_SITE_URL?.trim()
    || (env.CONVEX_URL?.trim() ? env.CONVEX_URL.trim().replace(/\.convex\.cloud\/?$/, '.convex.site') : '');
  const convexSecret = env.CARTSCOUT_CONVEX_SECRET?.trim();
  const useConvex = env.CARTSCOUT_USE_SQLITE !== '1' && !!convexSiteUrl && !!convexSecret;
  const store = useConvex
    ? openConvexStore({ siteUrl: convexSiteUrl, secret: convexSecret })
    : openStore(config.databasePath);
  const budget = createBudget({ ledger: store.ledger, daily: config.daily, monthly: config.monthly });
  const live = config.mode === 'live';
  const oxylabs = {
    key: config.key, parser: config.parser,
    record: config.record ? createRecorder(config.recordFolder, { log }) : undefined,
  };
  const server = createCouponServer({
    store, authenticate, allowAnonymous, log, budget, mode: config.mode,
    replay: config.mode === 'replay' ? openReplayFolder(config.replayFolder, { log }) : undefined,
    discover: live ? createDiscovery({ ...oxylabs, location: config.location }) : undefined,
    findAlternatives: live ? createAlternativeDiscovery(oxylabs) : undefined,
  });
  return { server, store, budget, config, host, port };
}

/** One line for the start-up log: what this server may do with Oxylabs, and how much of the budget is gone. */
export function describeOxylabs(config, budget, now = Date.now()) {
  if (config.mode === 'replay') {
    return `Oxylabs: replay. No request is sent. Scans and price lookups are answered from the database and ${config.replayFolder}.`;
  }
  if (config.mode === 'off') return 'Oxylabs: off. No request is sent. Saved results still open.';
  const format = ({ day, month }) => `Oxylabs: live, ${config.parser} page parsing. Budget in UTC: ${day.used} of ${day.limit} requests used today, `
    + `${month.used} of ${month.limit} this month.${config.record ? ` Recording answers to ${config.recordFolder}.` : ''}`;
  const status = budget.status(now);
  return status && typeof status.then === 'function' ? status.then(format) : format(status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server, store, budget, config, host, port } = createFromEnv();
  server.listen(port, host, async () => {
    console.log(`CartScout API listening on ${host}:${server.address().port}`);
    console.log(store.kind === 'convex' ? `Store: Convex (${store.siteUrl})` : `Store: SQLite (${config.databasePath})`);
    console.log(await describeOxylabs(config, budget));
  });
}
