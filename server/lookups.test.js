import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAlternativeDiscovery } from './alternatives.js';
import { createBudget } from './budget.js';
import { fakeOxylabs, HOUR, MINUTE, page, startApi } from './fixtures/kit.js';
import { openStore } from './store.js';

const RETAILERS = [1, 2, 3, 4].map((number) => `https://retailer${number}.example.com/p/item`);
const offer = (price) => page({ json: { offer: { title: 'Acme Widget', variant: 'Blue, 1kg', match: 'exact', price, currency: 'GBP', availability: 'in_stock', stockText: 'In stock' } } });

// Every product is listed by the same four retailers. `failing` names the retailer pages that cannot be read right now.
async function api(t, { store = openStore(':memory:'), clock = { now: Date.parse('2026-11-23T08:00:00Z') }, daily = 150 } = {}) {
  const failing = new Set();
  const gate = { wait: null };
  const oxylabs = fakeOxylabs(async ({ endpoint, url }) => {
    if (gate.wait) await gate.wait;
    if (endpoint === 'search') return RETAILERS.map((address) => ({ url: address }));
    if (failing.has(url)) return new Response('', { status: 500 });
    return offer(10 + RETAILERS.indexOf(url));
  });
  const service = await startApi(t, {
    store, clock, budget: createBudget({ ledger: store.ledger, daily, monthly: 2000 }),
    findAlternatives: createAlternativeDiscovery({ key: 'fixture', request: oxylabs.request, now: () => clock.now }),
  });
  return { ...service, oxylabs, failing, gate };
}
const widget = { name: 'Acme Widget', variant: 'Blue, 1kg' };
const ask = (item = widget, merchant = 'shop.example.com', country = 'GB') => ({ merchant, country, items: [item] });
const when = (time) => new Date(time).toISOString();
const sentAs = (sent) => sent.map(({ endpoint, url }) => (endpoint === 'search' ? 'search' : url));

test('a price lookup is saved in the database and shared by everyone asking about the same product', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'cartscout-lookups-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'lookups.sqlite');
  const clock = { now: Date.parse('2026-11-23T08:00:00Z') };
  const first = await api(t, { store: openStore(path), clock });

  const answer = await first.call('alternatives', 'free-a', ask());
  assert.equal(answer.status, 200);
  const [result] = answer.body.results;
  assert.deepEqual([result.name, result.variant, result.partial, result.fetchedAt, result.stale], ['Acme Widget', 'Blue, 1kg', false, when(clock.now), undefined]);
  assert.deepEqual(result.offers.map(({ retailer, price }) => [retailer, price]), [
    ['retailer1.example.com', 10], ['retailer2.example.com', 11], ['retailer3.example.com', 12], ['retailer4.example.com', 13],
  ]);
  // How each retailer page went is kept for retries. It is not part of the answer.
  assert.equal(Object.hasOwn(result, 'pages'), false);
  assert.equal(first.oxylabs.sent.length, 5);

  // Another Free member, a Pro member, and the same product written in capitals: all answered from the saved lookup.
  clock.now += HOUR;
  for (const [member, item] of [['free-b', widget], ['pro-c', widget], ['free-b', { name: 'ACME WIDGET', variant: 'blue, 1KG' }]]) {
    const again = (await first.call('alternatives', member, ask(item))).body.results[0];
    assert.deepEqual([again.offers.length, again.fetchedAt], [4, when(clock.now - HOUR)]);
  }
  assert.equal(first.oxylabs.sent.length, 5);

  // Another variant, another product, another country and another shop are each a lookup of their own.
  await first.call('alternatives', 'free-a', ask({ name: 'Acme Widget', variant: 'Red, 1kg' }));
  await first.call('alternatives', 'free-a', ask({ name: 'Acme Gadget', variant: 'Blue, 1kg' }));
  await first.call('alternatives', 'free-a', ask(widget, 'shop.example.com', 'US'));
  await first.call('alternatives', 'free-a', ask(widget, 'other.example.com'));
  assert.equal(first.oxylabs.sent.length, 25);

  // It is in SQLite, so a restart does not forget it.
  await first.close();
  first.store.close();
  const second = await api(t, { store: openStore(path), clock });
  const afterRestart = (await second.call('alternatives', 'pro-d', ask())).body.results[0];
  assert.deepEqual([afterRestart.offers.length, afterRestart.fetchedAt], [4, when(clock.now - HOUR)]);
  assert.equal(second.oxylabs.sent.length, 0);
});

test('a complete lookup answers for six hours', async (t) => {
  const { call, clock, oxylabs } = await api(t);
  const read = clock.now;
  await call('alternatives', 'free-a', ask());
  clock.now = read + 6 * HOUR - MINUTE;
  await call('alternatives', 'free-b', ask());
  assert.equal(oxylabs.sent.length, 5);

  clock.now = read + 6 * HOUR + MINUTE;
  const fresh = (await call('alternatives', 'free-b', ask())).body.results[0];
  assert.equal(fresh.fetchedAt, when(clock.now));
  assert.equal(oxylabs.sent.length, 10);
});

test('automatic comparisons share fresh offers across members and never spend on a miss or expiry', async (t) => {
  const { call, clock, oxylabs, failing } = await api(t);
  const read = clock.now;
  const peek = (body = ask()) => call('alternatives/cached', 'free-b', body);

  assert.deepEqual((await peek()).body, { country: 'GB', results: [] });
  assert.equal(oxylabs.sent.length, 0);

  failing.add(RETAILERS[3]);
  await call('alternatives', 'pro-c', ask());
  const [cached] = (await peek()).body.results;
  assert.equal(cached.offers.length, 3);
  assert.equal(cached.fetchedAt, when(read));
  assert.equal(cached.freshUntil, when(read + 30 * MINUTE));
  assert.deepEqual((await peek(ask({ ...widget, variant: 'Red, 1kg' }))).body.results, []);
  assert.deepEqual((await peek(ask(widget, 'shop.example.com', 'US'))).body.results, []);

  clock.now = read + 30 * MINUTE;
  assert.deepEqual((await peek()).body.results, []);
  assert.equal(oxylabs.sent.length, 5);
});

test('a partial lookup answers for 30 minutes, and a retry only asks for the retailer pages that failed', async (t) => {
  // Seven requests a day: the lookup's five, and exactly the two a retry needs. A whole second lookup would not fit.
  const { call, clock, oxylabs, failing } = await api(t, { daily: 7 });
  const read = clock.now;
  failing.add(RETAILERS[2]).add(RETAILERS[3]);
  const first = (await call('alternatives', 'free-a', ask())).body.results[0];
  assert.deepEqual([first.partial, first.offers.map(({ retailer }) => retailer)], [true, ['retailer1.example.com', 'retailer2.example.com']]);
  assert.deepEqual(sentAs(oxylabs.sent), ['search', ...RETAILERS]);

  // Inside its half hour the partial answer is the answer, for whoever asks.
  clock.now = read + 29 * MINUTE;
  const kept = (await call('alternatives', 'pro-c', ask())).body.results[0];
  assert.deepEqual([kept.partial, kept.offers.length, kept.stale], [true, 2, undefined]);
  assert.equal(oxylabs.sent.length, 5);

  // After it, the retry does not search again and does not read the two pages that already answered.
  clock.now = read + 31 * MINUTE;
  failing.delete(RETAILERS[2]);
  const retried = (await call('alternatives', 'free-b', ask())).body.results[0];
  assert.deepEqual(sentAs(oxylabs.sent.slice(5)), [RETAILERS[2], RETAILERS[3]]);
  assert.deepEqual([retried.partial, retried.offers.map(({ retailer }) => retailer)], [true, ['retailer1.example.com', 'retailer2.example.com', 'retailer3.example.com']]);
  // The oldest price in the answer is still from the first look, and the answer says so.
  assert.equal(retried.fetchedAt, when(read));

  // The fourth retailer has failed twice. It is not asked a third time: the answer stands as it is, at no cost.
  clock.now = read + 2 * HOUR;
  failing.clear();
  const settled = (await call('alternatives', 'free-a', ask())).body.results[0];
  assert.deepEqual([settled.partial, settled.offers.length, settled.stale], [true, 3, undefined]);
  assert.equal(oxylabs.sent.length, 7);
});

test('when every retailer page fails, the search is still not repeated', async (t) => {
  const { call, clock, oxylabs, failing } = await api(t);
  for (const address of RETAILERS) failing.add(address);
  const first = await call('alternatives', 'free-a', ask());
  // A lookup that read nothing is an answer the popup already knows: nothing found, some retailers did not answer.
  assert.equal(first.status, 200);
  assert.deepEqual([first.body.results[0].offers, first.body.results[0].partial], [[], true]);
  assert.equal(oxylabs.sent.length, 5);

  clock.now += 31 * MINUTE;
  failing.clear();
  const retried = (await call('alternatives', 'free-a', ask())).body.results[0];
  assert.deepEqual(sentAs(oxylabs.sent.slice(5)), RETAILERS);
  assert.deepEqual([retried.partial, retried.offers.length], [false, 4]);
});

test('after six hours a partial lookup starts over with a new search', async (t) => {
  const { call, clock, oxylabs, failing } = await api(t);
  failing.add(RETAILERS[3]);
  await call('alternatives', 'free-a', ask());
  clock.now += 6 * HOUR + MINUTE;
  failing.clear();
  const fresh = (await call('alternatives', 'free-a', ask())).body.results[0];
  assert.deepEqual(sentAs(oxylabs.sent.slice(5)), ['search', ...RETAILERS]);
  assert.deepEqual([fresh.partial, fresh.offers.length, fresh.fetchedAt], [false, 4, when(clock.now)]);
});

test('two members asking about the same product at the same moment share one lookup', async (t) => {
  const { call, gate, oxylabs } = await api(t);
  let open;
  gate.wait = new Promise((resolve) => { open = resolve; });
  const first = call('alternatives', 'free-a', ask());
  while (oxylabs.sent.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const second = call('alternatives', 'pro-c', ask());
  await new Promise((resolve) => setTimeout(resolve, 20));
  gate.wait = null;
  open();
  for (const answer of await Promise.all([first, second])) assert.equal(answer.body.results[0].offers.length, 4);
  assert.equal(oxylabs.sent.length, 5);
});
