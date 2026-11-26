import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createCouponServer } from './index.js';
import { openStore } from './store.js';

// A small API with a controllable clock and a discovery that can be held open, to stand in for a slow coupon site.
async function service(t, { discover } = {}) {
  const store = openStore(':memory:');
  const state = { now: Date.parse('2026-11-23T12:00:00Z'), scans: 0, lookups: 0, held: [] };
  const identities = {
    'free-a': { userId: 'user_alex', plan: 'free' },
    'free-b': { userId: 'user_bailey', plan: 'free' },
    'pro-c': { userId: 'user_casey', plan: 'pro' },
  };
  const server = createCouponServer({
    store, now: () => state.now, log: () => {},
    authenticate: async (token) => (Object.hasOwn(identities, token) ? identities[token] : null),
    discover: discover ?? (async (merchant) => {
      state.scans += 1;
      if (merchant.startsWith('slow')) await new Promise((resolve) => state.held.push(resolve));
      if (merchant.startsWith('down')) throw new Error('Fixture outage');
      return { complete: true, coupons: [{ code: 'SAVE10', offer: '', sources: [], expiresOn: null }] };
    }),
    findAlternatives: async () => {
      state.lookups += 1;
      return { offers: [], partial: false };
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    state.held.forEach((release) => release());
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });
  return {
    state,
    async call(route, token, body) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/${route}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + token, ...(body && { 'Content-Type': 'application/json' }) },
        ...(body && { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

test('a scan that comes back empty because coupon sites could not be read is not charged', async (t) => {
  const results = {
    'blocked.example.com': { complete: false, coupons: [] },
    'partial.example.com': { complete: false, coupons: [{ code: 'HALF', offer: '', sources: [], expiresOn: null }] },
    'none.example.com': { complete: true, coupons: [] },
  };
  const { call } = await service(t, { discover: async (merchant) => results[merchant] });

  const blocked = await call('coupons', 'free-a', { merchant: 'blocked.example.com' });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.partial, true);
  assert.deepEqual(blocked.body.coupons, []);
  assert.equal(blocked.body.account.scans.remaining, 5);

  // Something found, or a clean look that found nothing, is a scan like any other.
  assert.equal((await call('coupons', 'free-a', { merchant: 'partial.example.com' })).body.account.scans.remaining, 4);
  assert.equal((await call('coupons', 'free-a', { merchant: 'none.example.com' })).body.account.scans.remaining, 3);
});

test('one member cannot use up the scans everyone shares', async (t) => {
  const { call, state } = await service(t);

  // Six failed scans in a minute are refunded each time, and then the member is asked to wait.
  for (let index = 0; index < 6; index += 1) {
    assert.equal((await call('coupons', 'free-a', { merchant: `down${index}.example.com` })).status, 502);
  }
  const seventh = await call('coupons', 'free-a', { merchant: 'down7.example.com' });
  assert.equal(seventh.status, 429);
  assert.equal(seventh.body.code, 'slow_down');
  assert.equal(state.scans, 6);
  assert.equal((await call('account', 'free-a')).body.scans.remaining, 5);

  // Other members are served as usual, and the member's own share returns with the next minute.
  assert.equal((await call('coupons', 'pro-c', { merchant: 'shop.example.com' })).status, 200);
  assert.equal((await call('coupons', 'free-b', { merchant: 'shop.example.com' })).status, 200);
  state.now += 60_000;
  assert.equal((await call('coupons', 'free-a', { merchant: 'shop.example.com' })).status, 200);
});

test('a member runs two scans at a time, and a third waits its turn', async (t) => {
  const { call, state } = await service(t);
  const first = call('coupons', 'pro-c', { merchant: 'slow1.example.com' });
  const second = call('coupons', 'pro-c', { merchant: 'slow2.example.com' });
  while (state.held.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));

  const third = await call('coupons', 'pro-c', { merchant: 'slow3.example.com' });
  assert.equal(third.status, 429);
  assert.equal(third.body.code, 'slow_down');
  // Someone else is not held up by them.
  assert.equal((await call('coupons', 'free-a', { merchant: 'shop.example.com' })).status, 200);

  state.held.splice(0).forEach((release) => release());
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal((await call('coupons', 'pro-c', { merchant: 'shop.example.com' })).status, 200);
});

test('price checks have a per-member share too', async (t) => {
  const { call, state } = await service(t);
  const basket = (name) => ({ merchant: 'shop.example.com', country: 'GB', items: [{ name, variant: '', price: 10, currency: 'GBP', quantity: 1 }] });
  for (let index = 0; index < 12; index += 1) {
    assert.equal((await call('alternatives', 'free-a', basket(`Product number ${index}`))).status, 200);
  }
  const extra = await call('alternatives', 'free-a', basket('One product too many'));
  assert.equal(extra.status, 429);
  assert.equal(extra.body.code, 'slow_down');
  assert.equal(state.lookups, 12);

  // A repeat of something already checked is answered from memory and costs nothing.
  assert.equal((await call('alternatives', 'free-a', basket('Product number 3'))).status, 200);
  assert.equal((await call('alternatives', 'free-b', basket('Another member’s product'))).status, 200);
  assert.equal(state.lookups, 13);
});
