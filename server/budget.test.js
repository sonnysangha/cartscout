import assert from 'node:assert/strict';
import test from 'node:test';
import { createAlternativeDiscovery } from './alternatives.js';
import { createBudget } from './budget.js';
import { fakeOxylabs, HOUR, page, startApi } from './fixtures/kit.js';
import { createDiscovery } from './oxylabs.js';
import { openStore } from './store.js';

const DAILY = 'Scout has done all of today’s live searching. Saved codes still open, and scanning is back tomorrow.';
const MONTHLY = 'Scout has done all of this month’s live searching. Saved codes still open, and scanning is back on 1 December.';
const DAILY_PRICES = 'Scout has done all of today’s live searching. Saved prices still open, and price checks are back tomorrow.';

// An API on a small budget, with an Oxylabs where every shop has a voucher page showing one code and every product
// is sold by four retailers. A scan is three requests here and holds six; a price lookup is five and holds five.
async function api(t, limits) {
  const clock = { now: Date.parse('2026-11-23T12:00:00Z') };
  const store = openStore(':memory:');
  const gate = { wait: null };
  const oxylabs = fakeOxylabs(async ({ endpoint, query, url }) => {
    if (gate.wait) await gate.wait;
    if (endpoint === 'search') {
      return query.startsWith('buy ')
        ? [1, 2, 3, 4].map((number) => ({ url: `https://retailer${number}.example.com/p/item` }))
        : [{ title: 'Voucher codes', url: `https://${query.split(' ')[0]}/voucher-codes` }];
    }
    if (url.includes('/p/')) {
      return page({ json: { offer: { title: 'Acme Widget', variant: '', match: 'exact', price: 9.5, currency: 'GBP', availability: 'in_stock', stockText: 'In stock' } } });
    }
    return page({ markdown: url.endsWith('/voucher-codes') ? '10% off everything - use code: SAVE10' : 'Welcome to the shop. New in this week.', json: { coupons: [] } });
  });
  const client = { key: 'fixture', request: oxylabs.request, now: () => clock.now };
  const service = await startApi(t, {
    store, clock, budget: createBudget({ ledger: store.ledger, ...limits }),
    discover: createDiscovery({ ...client, location: 'GB' }), findAlternatives: createAlternativeDiscovery(client),
  });
  return { ...service, oxylabs, gate };
}
const shop = (name) => ({ merchant: `${name}.example.com` });
const basket = (...names) => ({ merchant: 'shop.example.com', country: 'GB', items: names.map((name) => ({ name, variant: '' })) });

test('a scan the day’s budget cannot cover is refused with budget_reached, and a Free member keeps their weekly scan', async (t) => {
  const { call, clock, oxylabs } = await api(t, { daily: 8, monthly: 2000 });
  const first = await call('coupons', 'free-a', shop('one'));
  assert.equal(first.status, 200);
  assert.equal(first.body.account.scans.remaining, 4);
  assert.equal(oxylabs.sent.length, 3);

  // Three of eight are gone. A scan may need six, so the next one is not started at all.
  const refused = await call('coupons', 'free-a', shop('two'));
  assert.equal(refused.status, 429);
  assert.deepEqual(Object.keys(refused.body).sort(), ['account', 'code', 'error', 'message', 'resetAt']);
  assert.equal(refused.body.code, 'budget_reached');
  assert.equal(refused.body.message, DAILY);
  // The same envelope as slow_down: the sentence is under "error" too, where the popup already looks.
  assert.equal(refused.body.error, DAILY);
  assert.equal(refused.body.resetAt, '2026-11-24T00:00:00.000Z');
  assert.equal(oxylabs.sent.length, 3);
  assert.equal(refused.body.account.scans.remaining, 4);
  assert.equal((await call('account', 'free-a')).body.scans.remaining, 4);

  // Asking only for what is saved still answers as it always did.
  assert.equal((await call('coupons', 'free-a', { ...shop('one'), cacheOnly: true })).body.source, 'cache');
  assert.equal((await call('coupons', 'free-a', { ...shop('two'), cacheOnly: true })).body.code, 'scan_required');

  // At midnight UTC the day's budget is whole again.
  clock.now = Date.parse('2026-11-24T00:00:00Z');
  const next = await call('coupons', 'free-a', shop('two'));
  assert.equal(next.status, 200);
  assert.equal(next.body.source, 'live');
  assert.equal(next.body.account.scans.remaining, 3);
});

test('when the month’s budget is used up the sentence names the day it comes back', async (t) => {
  const { call, clock, oxylabs } = await api(t, { daily: 150, monthly: 8 });
  assert.equal((await call('coupons', 'pro-c', shop('one'))).status, 200);
  clock.now += 24 * HOUR;
  const refused = await call('coupons', 'pro-c', shop('two'));
  assert.equal(refused.status, 429);
  assert.equal(refused.body.code, 'budget_reached');
  assert.equal(refused.body.message, MONTHLY);
  assert.equal(refused.body.resetAt, '2026-12-01T00:00:00.000Z');
  assert.equal(oxylabs.sent.length, 3);
});

test('with the budget used up, a saved result is served with its age in place of a refusal', async (t) => {
  const { call, clock, oxylabs } = await api(t, { daily: 150, monthly: 8 });
  const read = clock.now;
  assert.equal((await call('coupons', 'pro-c', shop('one'))).body.source, 'live');

  // A day and an hour later the saved scan has aged out, and the month's budget cannot cover another.
  clock.now += 25 * HOUR;
  const own = await call('coupons', 'pro-c', shop('one'));
  assert.equal(own.status, 200);
  assert.equal(own.body.source, 'stale');
  assert.equal(own.body.fetchedAt, new Date(read).toISOString());
  assert.deepEqual(own.body.coupons.map(({ code }) => code), ['SAVE10']);

  // A Free member who never scanned this shop gets what the server last read about it, marked as an earlier read.
  // It is not a scan, so it does not use one of theirs.
  const other = await call('coupons', 'free-a', shop('one'));
  assert.equal(other.status, 200);
  assert.equal(other.body.source, 'stale');
  assert.equal(other.body.reused, true);
  assert.equal(other.body.fetchedAt, new Date(read).toISOString());
  assert.deepEqual(other.body.coupons.map(({ code }) => code), ['SAVE10']);
  assert.equal(other.body.account.scans.remaining, 5);

  // Nothing is saved for a shop nobody has scanned, so there the answer is the refusal.
  assert.equal((await call('coupons', 'free-a', shop('three'))).body.code, 'budget_reached');
  assert.equal(oxylabs.sent.length, 3);
});

test('a price lookup the budget cannot cover is refused the same way, or answered from a saved lookup', async (t) => {
  const { call, clock, oxylabs } = await api(t, { daily: 8, monthly: 2000 });
  const read = clock.now;
  const first = await call('alternatives', 'free-a', basket('Acme Widget'));
  assert.equal(first.status, 200);
  assert.equal(first.body.results[0].offers.length, 4);
  assert.equal(oxylabs.sent.length, 5);

  // Five of eight are gone, and a lookup holds five.
  const refused = await call('alternatives', 'free-a', basket('Acme Gadget'));
  assert.equal(refused.status, 429);
  assert.equal(refused.body.code, 'budget_reached');
  assert.equal(refused.body.message, DAILY_PRICES);
  assert.equal(refused.body.error, DAILY_PRICES);
  assert.equal(refused.body.resetAt, '2026-11-24T00:00:00.000Z');

  // Seven hours on, the saved lookup is past its six hours. It is still served, and says so, because Scout cannot look again.
  clock.now += 7 * HOUR;
  const saved = await call('alternatives', 'free-b', basket('Acme Widget', 'Acme Gadget'));
  assert.equal(saved.status, 200);
  assert.deepEqual(
    saved.body.results.map(({ name, offers, stale, fetchedAt, code }) => [name, offers.length, stale, fetchedAt, code]),
    [
      ['Acme Widget', 4, true, new Date(read).toISOString(), undefined],
      ['Acme Gadget', 0, undefined, undefined, 'budget_reached'],
    ],
  );
  assert.equal(saved.body.results[1].error, DAILY_PRICES);
  assert.equal(oxylabs.sent.length, 5);
});

test('requests held by a scan that is still running count, so two scans cannot overrun the budget between them', async (t) => {
  const { call, gate, oxylabs } = await api(t, { daily: 9, monthly: 2000 });
  let open;
  gate.wait = new Promise((resolve) => { open = resolve; });
  const running = call('coupons', 'pro-c', shop('one'));
  while (oxylabs.sent.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));

  // One request has left. The running scan still holds five more, so a second scan (six) does not fit in nine.
  const refused = await call('coupons', 'pro-d', shop('two'));
  assert.equal(refused.status, 429);
  assert.equal(refused.body.code, 'budget_reached');

  gate.wait = null;
  open();
  assert.equal((await running).status, 200);
  // The first scan used three and handed three back: now the second fits exactly.
  assert.equal((await call('coupons', 'pro-d', shop('two'))).status, 200);
  assert.equal(oxylabs.sent.length, 6);
  assert.equal((await call('coupons', 'pro-d', shop('three'))).body.code, 'budget_reached');
});
