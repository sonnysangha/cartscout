import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fakeOxylabs, HOUR, MINUTE, page, startApi } from './fixtures/kit.js';
import { createDiscovery } from './oxylabs.js';
import { openStore, reporterKey } from './store.js';

// Every shop has a voucher page of its own that shows one code, so a live scan is six requests: four searches, the
// home page and the voucher page. `broken` names shops whose voucher page cannot be read.
async function api(t, { store, broken = new Set() } = {}) {
  const clock = { now: Date.parse('2026-11-23T12:00:00Z') };
  const gate = { wait: null };
  const oxylabs = fakeOxylabs(async ({ endpoint, query, url }) => {
    if (gate.wait) await gate.wait;
    if (endpoint === 'search') return [{ title: 'Voucher codes', url: `https://${query.split(' ')[0]}/voucher-codes` }];
    const { hostname, pathname } = new URL(url);
    if (pathname !== '/voucher-codes') return page({ markdown: 'Welcome to the shop. New in this week.', json: { coupons: [] } });
    if (broken.has(hostname)) return new Response('', { status: 500 });
    return page({ markdown: '10% off everything - use code: SAVE10', json: { coupons: [] } });
  });
  const service = await startApi(t, {
    store, clock, discover: createDiscovery({ key: 'fixture', location: 'GB', request: oxylabs.request, now: () => clock.now }),
  });
  return { ...service, oxylabs, gate };
}
const shop = { merchant: 'shop.example.com' };
const when = (time) => new Date(time).toISOString();

test('a shop anyone scanned in the last 24 hours is answered from what the server already read', async (t) => {
  const { call, clock, oxylabs } = await api(t);
  const read = clock.now;
  const first = (await call('coupons', 'free-a', { ...shop, productUrl: 'https://shop.example.com/products/jacket' })).body;
  assert.deepEqual([first.source, first.reused, first.fetchedAt, first.account.scans.remaining], ['live', undefined, when(read), 4]);
  assert.equal(oxylabs.sent.length, 6);

  // Twenty-three hours later another Free member scans the same shop. Nothing is sent to Oxylabs. It still counts as
  // one of their scans, and the answer says when the pages were really read.
  clock.now = read + 23 * HOUR;
  const second = (await call('coupons', 'free-b', { ...shop, productUrl: 'https://shop.example.com/products/shoes' })).body;
  assert.deepEqual([second.source, second.reused, second.fetchedAt, second.refreshedAt], ['live', true, when(read), read]);
  assert.deepEqual(second.coupons.map(({ code, sources }) => [code, sources]), [['SAVE10', ['https://shop.example.com/voucher-codes']]]);
  assert.equal(second.account.scans.remaining, 4);
  // A Pro member opening the extension (`cacheOnly: true`) gets those shared findings immediately from cache.
  const proCached = (await call('coupons', 'pro-c', { ...shop, cacheOnly: true })).body;
  assert.deepEqual([proCached.source, proCached.reused, proCached.fetchedAt], ['cache', true, when(read)]);
  assert.deepEqual(proCached.coupons.map(({ code }) => code), ['SAVE10']);
  assert.equal(oxylabs.sent.length, 6);

  // What stays private is unchanged. A Free member's thumb is theirs alone; Pro members share theirs with each other.
  assert.equal((await call('reports', 'free-a', { ...shop, code: 'SAVE10', worked: true })).body.coupons[0].worked, 1);
  assert.equal((await call('reports', 'pro-c', { ...shop, code: 'SAVE10', worked: false })).body.coupons[0].failed, 1);
  const seenBy = async (member) => {
    const [coupon] = (await call('coupons', member, { ...shop, cacheOnly: true })).body.coupons;
    return [coupon.worked, coupon.failed];
  };
  assert.deepEqual(await seenBy('free-a'), [1, 0]);
  assert.deepEqual(await seenBy('free-b'), [0, 0]);
  assert.deepEqual(await seenBy('pro-d'), [0, 1]);
  assert.equal(oxylabs.sent.length, 6);
});

test('regional and storefront subdomains share fresh scans on the same brand domain, while multi-tenant platforms stay isolated', async (t) => {
  const { call, oxylabs } = await api(t);
  const first = (await call('coupons', 'pro-c', { merchant: 'ridge.com' })).body;
  assert.deepEqual(first.coupons.map(({ code }) => code), ['SAVE10']);
  assert.equal(oxylabs.sent.length, 6);

  // Visiting uk.ridge.com immediately hydrates from ridge.com's cached scan without asking Oxylabs again.
  const uk = (await call('coupons', 'pro-d', { merchant: 'uk.ridge.com', cacheOnly: true })).body;
  assert.deepEqual([uk.source, uk.reused, uk.coupons.map(({ code }) => code)], ['cache', true, ['SAVE10']]);
  assert.equal(oxylabs.sent.length, 6);

  // Sibling store subdomains (uk.store.anker.com -> uk.anker.com) also share the cached brand scan.
  await call('coupons', 'pro-c', { merchant: 'uk.store.anker.com' });
  assert.equal(oxylabs.sent.length, 12);
  const anker = (await call('coupons', 'pro-d', { merchant: 'uk.anker.com', cacheOnly: true })).body;
  assert.deepEqual([anker.source, anker.reused, anker.coupons.map(({ code }) => code)], ['cache', true, ['SAVE10']]);
  assert.equal(oxylabs.sent.length, 12);

  // Multi-tenant storefront hosts like *.myshopify.com must never leak codes across unrelated shops.
  await call('coupons', 'pro-c', { merchant: 'alpha.myshopify.com' });
  assert.equal(oxylabs.sent.length, 18);
  const otherTenant = await call('coupons', 'pro-d', { merchant: 'beta.myshopify.com', cacheOnly: true });
  assert.equal(otherTenant.status, 409);
  assert.equal(otherTenant.body.code, 'scan_required');
});

test('a reused answer is fresh until the pages are 24 hours old, and then the shop is read again', async (t) => {
  const { call, clock, oxylabs } = await api(t);
  const read = clock.now;
  await call('coupons', 'pro-c', shop);
  clock.now = read + 23 * HOUR;
  const reused = (await call('coupons', 'free-a', shop)).body;
  assert.equal(reused.freshUntil, when(read + 24 * HOUR));

  clock.now = read + 24 * HOUR - MINUTE;
  assert.equal((await call('coupons', 'free-a', { ...shop, cacheOnly: true })).body.source, 'cache');
  // The lifetime is counted from the reading of the pages, not from the member's scan.
  clock.now = read + 24 * HOUR + MINUTE;
  const aged = (await call('coupons', 'free-a', { ...shop, cacheOnly: true })).body;
  assert.deepEqual([aged.source, aged.fetchedAt, aged.reused], ['stale', when(read), true]);
  assert.equal(oxylabs.sent.length, 6);

  const again = (await call('coupons', 'free-a', shop)).body;
  assert.deepEqual([again.source, again.reused, again.fetchedAt, again.account.scans.remaining], ['live', undefined, when(clock.now), 3]);
  assert.equal(oxylabs.sent.length, 12);
});

test('a scan that could not read every source is not passed on to other members', async (t) => {
  const { call, clock, oxylabs } = await api(t, { broken: new Set(['shop.example.com']) });
  const partial = (await call('coupons', 'pro-c', shop)).body;
  assert.deepEqual([partial.source, partial.partial, partial.coupons.length], ['live', true, 0]);
  assert.equal(oxylabs.sent.length, 6);

  clock.now += 5 * MINUTE;
  const other = (await call('coupons', 'free-a', shop)).body;
  assert.deepEqual([other.source, other.partial, other.reused], ['live', true, undefined]);
  assert.equal(oxylabs.sent.length, 12);
  // It found nothing because a source could not be read, so it is not charged either.
  assert.equal(other.account.scans.remaining, 5);
});

test('two members scanning the same shop at the same moment share one read', async (t) => {
  const { call, gate, oxylabs } = await api(t);
  let open;
  gate.wait = new Promise((resolve) => { open = resolve; });
  const first = call('coupons', 'free-a', shop);
  while (oxylabs.sent.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const second = call('coupons', 'free-b', shop);
  await new Promise((resolve) => setTimeout(resolve, 20));
  gate.wait = null;
  open();

  for (const answer of await Promise.all([first, second])) {
    assert.equal(answer.status, 200);
    assert.deepEqual([answer.body.source, answer.body.reused, answer.body.account.scans.remaining], ['live', undefined, 4]);
    assert.deepEqual(answer.body.coupons.map(({ code }) => code), ['SAVE10']);
  }
  assert.equal(oxylabs.sent.length, 6);
});

test('a database from before this change is brought forward, so shops scanned earlier are not paid for again', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'cartscout-reuse-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'earlier.sqlite');
  const scanned = Date.parse('2026-11-23T02:00:00Z');
  const older = Date.parse('2026-11-22T20:00:00Z');
  const privately = (member, host) => `private:${reporterKey(`clerk:${member}`)}:${host}`;

  // The tables as they were: no record per shop, and each Free member's scan under their own key.
  const before = new DatabaseSync(path);
  before.exec(`
    CREATE TABLE searches (merchant TEXT PRIMARY KEY, refreshed_at INTEGER NOT NULL, retry_at INTEGER NOT NULL,
      partial INTEGER NOT NULL, discovery_version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE coupons (merchant TEXT NOT NULL, code TEXT NOT NULL, offer TEXT NOT NULL, sources TEXT NOT NULL,
      expires_on TEXT, seen_at INTEGER NOT NULL, discovery_version INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (merchant, code));
  `);
  const addScan = before.prepare('INSERT INTO searches VALUES (?, ?, ?, ?, 2)');
  const addCode = before.prepare('INSERT INTO coupons VALUES (?, ?, ?, ?, NULL, ?, 2)');
  addScan.run(privately('user_bailey', 'shop.example.com'), older, older + 24 * HOUR, 0);
  addCode.run(privately('user_bailey', 'shop.example.com'), 'OLDER5', '5% off', '[]', older);
  addScan.run(privately('user_alex', 'shop.example.com'), scanned, scanned + 24 * HOUR, 0);
  addCode.run(privately('user_alex', 'shop.example.com'), 'EARLIER10', '10% off', '["https://shop.example.com/offers"]', scanned);
  // A code this member's list has kept from a scan before that one. It was not part of the latest read.
  addCode.run(privately('user_alex', 'shop.example.com'), 'KEPT', 'From last week', '[]', scanned - 48 * HOUR);
  addScan.run('other.example.com', older, older + 10 * MINUTE, 1);
  before.close();

  const store = openStore(path);
  assert.deepEqual(store.shopScan('shop.example.com'), {
    result: { complete: true, coupons: [{ code: 'EARLIER10', offer: '10% off', sources: ['https://shop.example.com/offers'], expiresOn: null }] },
    fetchedAt: scanned, seeded: false,
  });
  assert.deepEqual(store.shopScan('other.example.com'), { result: { complete: false, coupons: [] }, fetchedAt: older, seeded: false });

  const { call, oxylabs } = await api(t, { store });
  const answer = (await call('coupons', 'pro-c', shop)).body;
  assert.deepEqual([answer.source, answer.reused, answer.fetchedAt], ['live', true, when(scanned)]);
  assert.deepEqual(answer.coupons.map(({ code }) => code), ['EARLIER10']);
  assert.equal(oxylabs.sent.length, 0);
  // The member whose scan it was still has their own list, untouched.
  const own = (await call('coupons', 'free-a', { ...shop, cacheOnly: true })).body;
  assert.deepEqual([own.source, own.reused, own.coupons.map(({ code }) => code).sort()], ['cache', undefined, ['EARLIER10', 'KEPT']]);
});

test('rescanning within the cache window excludes recently hit websites, expands to new sites, and merges codes', async (t) => {
  const clock = { now: Date.parse('2026-11-27T12:00:00Z') };
  let rescan = false;
  const queries = [];
  const scraped = [];
  const oxylabs = fakeOxylabs(async ({ endpoint, query, url }) => {
    if (endpoint === 'search') {
      queries.push(query);
      if (rescan) {
        return [
          // Even if Google somehow returned a subdomain of an excluded host, it must be skipped.
          { title: 'John Lewis Voucher Codes', url: 'https://m.hotukdeals.com/vouchers/johnlewis.com' },
          { title: 'John Lewis Promo Codes', url: 'https://www.wethrift.com/john-lewis' },
          { title: 'John Lewis Discount Codes', url: 'https://simplycodes.com/store/johnlewis.com' },
          { title: 'John Lewis Voucher Codes', url: 'https://www.moneysavingexpert.com/deals/john-lewis/' },
          { title: 'John Lewis Coupon Codes', url: 'https://www.couponbirds.com/codes/johnlewis.com' },
          { title: 'John Lewis Promo Codes', url: 'https://www.coupert.com/coupons/john-lewis' },
        ];
      }
      return [
        { title: 'Charlotte Tilbury at John Lewis', url: 'https://www.hotukdeals.com/deals/charlotte-tilbury-at-john-lewis-123' },
      ];
    }
    scraped.push(url);
    if (url.includes('hotukdeals.com')) {
      return page({
        markdown: 'Use code: TILBURYDEC80 for 1 free gift when you spend £80 on Charlotte Tilbury at John Lewis.',
        json: { coupons: [{ code: 'TILBURYDEC80', offer: '1 free gift on Charlotte Tilbury' }] },
      });
    }
    if (url.includes('wethrift.com')) {
      return page({
        markdown: 'Enter JL15OFF at checkout to get 15% off John Lewis homeware.',
        json: { coupons: [{ code: 'JL15OFF', offer: '15% off John Lewis homeware' }] },
      });
    }
    if (url.includes('coupert.com')) {
      return page({
        markdown: 'Use code: JLTECH10 for £10 off John Lewis tech.',
        json: { coupons: [{ code: 'JLTECH10', offer: '£10 off John Lewis tech' }] },
      });
    }
    return page({ markdown: 'John Lewis offers and delivery info.', json: { coupons: [] } });
  });

  const { call, store } = await startApi(t, {
    clock,
    discover: createDiscovery({ key: 'fixture', location: 'GB', request: oxylabs.request, now: () => clock.now }),
  });

  // 1. Initial scan hits johnlewis.com + hotukdeals.com (only Charlotte Tilbury code found).
  const first = (await call('coupons', 'pro-c', { merchant: 'johnlewis.com' })).body;
  assert.deepEqual(first.coupons.map((c) => c.code), ['TILBURYDEC80']);
  assert.equal(queries.length, 4);
  assert.ok(!queries[0].includes('-site:'));

  // 2. Two hours later (still in the 24h cache window), user clicks "Search for more codes" (force: true).
  clock.now += 2 * HOUR;
  scraped.length = 0;
  rescan = true;
  const expanded = (await call('coupons', 'pro-c', { merchant: 'johnlewis.com', force: true })).body;
  assert.equal(queries.length, 8);
  assert.ok(queries[4].includes('-site:hotukdeals.com'), `expected -site:hotukdeals.com in query: ${queries[4]}`);
  // Skipped johnlewis.com home page and hotukdeals.com, checking the five eligible new publishers returned by Oxylabs.
  assert.deepEqual(scraped, [
    'https://www.wethrift.com/john-lewis',
    'https://simplycodes.com/store/johnlewis.com',
    'https://www.moneysavingexpert.com/deals/john-lewis/',
    'https://www.couponbirds.com/codes/johnlewis.com',
    'https://www.coupert.com/coupons/john-lewis',
  ]);
  // Newly discovered general John Lewis codes are merged alongside the earlier cached code.
  assert.deepEqual(expanded.coupons.map((c) => c.code).sort(), ['JL15OFF', 'JLTECH10', 'TILBURYDEC80']);
  // Accumulated visited hosts include both the first and second waves for any future expansion.
  const savedScan = store.shopScan('johnlewis.com');
  assert.ok(savedScan.visitedHosts.includes('hotukdeals.com'));
  assert.ok(savedScan.visitedHosts.includes('wethrift.com'));
  assert.ok(savedScan.visitedHosts.includes('coupert.com'));
});
