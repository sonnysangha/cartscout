import assert from 'node:assert/strict';
import test from 'node:test';
import { createBudget } from './budget.js';
import { openConvexStore } from './convex-store.js';
import { fakeOxylabs, page, startApi } from './fixtures/kit.js';
import { createDiscovery } from './oxylabs.js';

/**
 * Minimal in-memory simulator of convex/http.ts + convex/store.ts + convex/ledger.ts
 * so openConvexStore is verified offline alongside the full HTTP server pipeline.
 */
function createMockConvexRpc(expectedSecret) {
  const searches = new Map();
  const coupons = new Map();
  const shopScans = new Map();
  const reports = new Map();
  const freeScans = new Map();
  const lookups = new Map();
  const holds = new Map();
  const requests = [];

  return async (url, init) => {
    assert.equal(url, 'https://mock.convex.site/internal/rpc');
    if (init.headers.Authorization !== `Bearer ${expectedSecret}`) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }
    const { op, args } = JSON.parse(init.body);
    let result = null;
    if (op === 'store:getSearch') {
      result = searches.get(args.merchant) ?? null;
    } else if (op === 'store:shopScan') {
      result = shopScans.get(args.merchant) ?? null;
    } else if (op === 'store:shopScanByDomain') {
      const matches = [...shopScans.values()].filter((s) => s.domain === args.domain && s.result.complete);
      matches.sort((a, b) => b.fetchedAt - a.fetchedAt);
      result = matches[0] ? { result: matches[0].result, fetchedAt: matches[0].fetchedAt, seeded: matches[0].seeded } : null;
    } else if (op === 'store:saveShopScan') {
      shopScans.set(args.merchant, {
        domain: args.domain,
        result: { coupons: args.coupons, complete: args.complete },
        fetchedAt: args.fetchedAt,
        seeded: args.seeded,
      });
      result = true;
    } else if (op === 'store:scanFailure' || op === 'store:clearScanFailure' || op === 'store:markScanFailure') {
      result = null;
    } else if (op === 'store:saveScan') {
      const ttl = args.complete ? 86_400_000 : 3_600_000;
      for (const c of args.coupons) {
        coupons.set(`${args.merchant}\0${c.code}`, { ...c, merchant: args.merchant, seenAt: args.now, seeded: args.seeded });
      }
      searches.set(args.merchant, {
        merchant: args.merchant, refreshed_at: args.fetchedAt, retry_at: args.freshFrom + ttl,
        partial: args.complete ? 0 : 1, discovery_version: 2, reused: args.reused ? 1 : 0, seeded: args.seeded ? 1 : 0,
      });
      if (args.reservation && freeScans.has(args.reservation)) freeScans.get(args.reservation).complete = true;
    } else if (op === 'store:listing') {
      result = [...coupons.values()]
        .filter((c) => c.merchant === args.merchant)
        .map((c) => {
          const reps = [...reports.values()].filter((r) => r.merchant === c.merchant && r.code === c.code);
          const worked = reps.filter((r) => r.worked).length;
          const failed = reps.filter((r) => !r.worked).length;
          const mine = reps.find((r) => r.reporter === args.reporter);
          return {
            code: c.code, offer: c.offer, sources: c.sources, expiresOn: c.expiresOn,
            worked, failed, myReport: mine ? (mine.worked ? 1 : 0) : null,
          };
        });
    } else if (op === 'store:recordReport') {
      if (!coupons.has(`${args.merchant}\0${args.code}`)) {
        result = false;
      } else {
        reports.set(`${args.merchant}\0${args.code}\0${args.reporter}`, args);
        result = true;
      }
    } else if (op === 'store:recentWins') {
      result = [...reports.values()]
        .filter((r) => r.worked && !r.merchant.startsWith('private:'))
        .map((r) => ({
          merchant: r.merchant, code: r.code, offer: coupons.get(`${r.merchant}\0${r.code}`)?.offer ?? '',
          savedAmount: r.savedAmount, savedCurrency: r.savedCurrency, memberName: r.memberName,
          reportedAt: r.now, workedCount: 1,
        }));
    } else if (op === 'store:winsCount') {
      result = [...reports.values()].filter((r) => r.worked && !r.merchant.startsWith('private:')).length;
    } else if (op === 'store:weeklyScans') {
      const used = [...freeScans.values()].filter((s) => s.reporter === args.reporter && s.complete).length;
      result = { used, limit: 5, remaining: Math.max(0, 5 - used), resetsAt: new Date(args.now + 86_400_000).toISOString() };
    } else if (op === 'store:reserveScan') {
      freeScans.set(args.scanId, { reporter: args.reporter, complete: false });
      result = args.scanId;
    } else if (op === 'store:releaseScan') {
      freeScans.delete(args.scanId);
    } else if (op === 'store:getLookup') {
      result = lookups.get(`${args.merchant}|${args.country}|${args.name}|${args.variant}`) ?? null;
    } else if (op === 'store:saveLookup') {
      lookups.set(`${args.merchant}|${args.country}|${args.name}|${args.variant}`, args);
    } else if (op === 'ledger:reserve') {
      const held = [...holds.values()].reduce((s, h) => s + h.held, 0);
      if (requests.length + held + args.requests > args.daily) {
        result = { ok: false, refused: { scope: 'day', resetAt: args.now + 86_400_000 } };
      } else {
        holds.set(args.holdId, { held: args.requests });
        result = { ok: true, holdId: args.holdId };
      }
    } else if (op === 'ledger:spend') {
      const h = holds.get(args.holdId);
      if (!h || h.held <= 0) {
        result = null;
      } else {
        h.held -= 1;
        const id = `req_${requests.length + 1}`;
        requests.push({ id, ...args, ok: null, ms: null });
        result = id;
      }
    } else if (op === 'ledger:finish') {
      const r = requests.find((x) => x.id === args.requestId);
      if (r) { r.ok = args.ok; r.ms = args.ms; }
    } else if (op === 'ledger:release') {
      holds.delete(args.holdId);
    } else if (op === 'ledger:totals') {
      const bucket = {
        from: 0, to: 1, requests: requests.length, answered: requests.filter((r) => r.ok === true).length,
        failed: 0, unanswered: 0, searches: 0, reads: 0, rendered: 0, ai: 0, forScans: 0, forLookups: 0,
      };
      result = { day: bucket, month: bucket, held: 0, hosts: [] };
    }
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

test('openConvexStore powers scans, domain cache sharing, reports, wins, and async budget holds', async (t) => {
  const clock = { now: Date.parse('2026-11-26T12:00:00Z') };
  const store = openConvexStore({
    siteUrl: 'https://mock.convex.site',
    secret: 'test-secret-123',
    request: createMockConvexRpc('test-secret-123'),
  });
  const oxylabs = fakeOxylabs(async ({ endpoint, query, url }) => {
    if (endpoint === 'search') return [{ title: 'Voucher codes', url: `https://${query.split(' ')[0]}/voucher-codes` }];
    const { pathname } = new URL(url);
    return page({ markdown: pathname === '/voucher-codes' ? '10% off - use code: RIDGE10' : 'Welcome', json: { coupons: [] } });
  });
  const { call } = await startApi(t, {
    store,
    clock,
    budget: createBudget({ ledger: store.ledger, daily: 50, monthly: 500 }),
    discover: createDiscovery({ key: 'fixture', location: 'GB', request: oxylabs.request, now: () => clock.now }),
  });

  // Live scan writes to Convex store and ledger.
  const scan = await call('coupons', 'pro-c', { merchant: 'ridge.com' });
  assert.equal(scan.status, 200);
  assert.deepEqual(scan.body.coupons.map((c) => c.code), ['RIDGE10']);
  assert.equal(oxylabs.sent.length, 3);

  // Sibling subdomain uk.ridge.com immediately hydrates from Convex domain cache without calling Oxylabs.
  const uk = await call('coupons', 'pro-d', { merchant: 'uk.ridge.com', cacheOnly: true });
  assert.equal(uk.status, 200);
  assert.equal(uk.body.source, 'cache');
  assert.deepEqual(uk.body.coupons.map((c) => c.code), ['RIDGE10']);
  assert.equal(oxylabs.sent.length, 3);

  // Reporting a working code with savings feeds recentWins.
  const rep = await call('reports', 'pro-c', {
    merchant: 'ridge.com', code: 'RIDGE10', worked: true, savedAmount: 18.5, savedCurrency: 'GBP',
  });
  assert.equal(rep.status, 200);
  assert.equal(rep.body.coupons[0].worked, 1);
  const wins = await store.recentWins(clock.now, 10);
  assert.equal(wins.length, 1);
  assert.equal(wins[0].code, 'RIDGE10');
  assert.equal(wins[0].savedAmount, 18.5);

  // Ledger recorded the 3 requests and released the hold.
  const totals = await store.ledger.totals(clock.now);
  assert.equal(totals.day.requests, 3);
  assert.equal(totals.held, 0);
});
