import assert from 'node:assert/strict';
import test from 'node:test';
import { fakeOxylabs, HOUR, MINUTE, page, startApi } from './fixtures/kit.js';
import { createDiscovery } from './oxylabs.js';
import { FAILED_SCAN_WAIT, LOOKUP_LIFETIME, SCAN_LIFETIME } from './store.js';

// Shops that answer differently: codes.example.com shows a code, nocodes.example.com shows none, and the voucher
// page of patchy.example.com cannot be read. `down` holds shops whose search fails, which fails the whole scan.
async function api(t) {
  const clock = { now: Date.parse('2026-11-23T12:00:00Z') };
  const down = new Set();
  const oxylabs = fakeOxylabs(async ({ endpoint, query, url }) => {
    if (endpoint === 'search') {
      const shop = query.split(' ')[0];
      if (down.has(shop)) return new Response('', { status: 500 });
      return [{ title: 'Voucher codes', url: `https://${shop}/voucher-codes` }];
    }
    const { hostname, pathname } = new URL(url);
    if (pathname !== '/voucher-codes') return page({ markdown: 'Welcome to the shop. New in this week.', json: { coupons: [] } });
    if (hostname === 'patchy.example.com') return new Response('', { status: 500 });
    return page({
      markdown: hostname === 'codes.example.com' ? '10% off everything - use code: SAVE10' : 'No offers are running right now. Check back soon.',
      json: { coupons: [] },
    });
  });
  const service = await startApi(t, {
    clock, discover: createDiscovery({ key: 'fixture', location: 'GB', request: oxylabs.request, now: () => clock.now }),
  });
  return { ...service, oxylabs, down };
}
const when = (time) => new Date(time).toISOString();

test('the lifetimes are a day for a complete scan, an hour for a partial one, ten minutes after a failure', () => {
  assert.deepEqual(SCAN_LIFETIME, { complete: 24 * HOUR, partial: 60 * MINUTE });
  assert.equal(FAILED_SCAN_WAIT, 10 * MINUTE);
  assert.deepEqual(LOOKUP_LIFETIME, { complete: 6 * HOUR, partial: 30 * MINUTE });
});

test('a complete scan stays fresh for 24 hours, whether it found a code or not', async (t) => {
  const { call, clock, oxylabs } = await api(t);
  const read = clock.now;
  for (const merchant of ['codes.example.com', 'nocodes.example.com']) {
    const first = (await call('coupons', 'pro-c', { merchant })).body;
    assert.deepEqual([first.source, first.partial, first.freshUntil], ['live', false, when(read + 24 * HOUR)]);
  }
  assert.equal(oxylabs.sent.length, 12);

  // A Pro popup asks for a fresh list every time it opens. For a whole day the saved one is the answer, also for the
  // shop with no codes, which used to be scanned again after two hours.
  clock.now = read + 24 * HOUR - MINUTE;
  for (const merchant of ['codes.example.com', 'nocodes.example.com']) {
    assert.equal((await call('coupons', 'pro-c', { merchant })).body.source, 'cache');
  }
  assert.equal(oxylabs.sent.length, 12);

  clock.now = read + 24 * HOUR + MINUTE;
  assert.equal((await call('coupons', 'pro-c', { merchant: 'nocodes.example.com' })).body.source, 'live');
  assert.equal(oxylabs.sent.length, 18);
});

test('a partial scan stays fresh for 60 minutes', async (t) => {
  const { call, clock, oxylabs } = await api(t);
  const read = clock.now;
  const first = (await call('coupons', 'pro-c', { merchant: 'patchy.example.com' })).body;
  assert.deepEqual([first.source, first.partial, first.freshUntil], ['live', true, when(read + 60 * MINUTE)]);
  assert.equal(oxylabs.sent.length, 6);

  // It used to be scanned again after ten minutes.
  clock.now = read + 59 * MINUTE;
  assert.deepEqual((({ source, partial }) => [source, partial])((await call('coupons', 'pro-c', { merchant: 'patchy.example.com' })).body), ['cache', true]);
  assert.equal(oxylabs.sent.length, 6);

  clock.now = read + 61 * MINUTE;
  assert.equal((await call('coupons', 'pro-c', { merchant: 'patchy.example.com' })).body.source, 'live');
  assert.equal(oxylabs.sent.length, 12);
});

test('a failed scan leaves a ten-minute mark, and the next tries are answered from the mark, not by Oxylabs', async (t) => {
  const { call, clock, oxylabs, down } = await api(t);
  const failed = clock.now;
  down.add('down.example.com');
  const first = await call('coupons', 'free-a', { merchant: 'down.example.com' });
  assert.equal(first.status, 502);
  assert.equal(oxylabs.sent.length, 1);

  // A minute later the same member tries again, and so does someone else. Nothing is sent for either of them.
  clock.now = failed + MINUTE;
  for (const member of ['free-a', 'pro-c']) {
    const marked = await call('coupons', member, { merchant: 'down.example.com' });
    assert.equal(marked.status, 502);
    assert.equal(marked.body.code, 'scan_failed');
    assert.equal(marked.body.error, 'Scout couldn’t read this shop’s coupon pages a moment ago. Try again in about 9 minutes.');
    assert.equal(marked.body.retryAt, when(failed + 10 * MINUTE));
  }
  assert.equal(oxylabs.sent.length, 1);
  // Neither the failure nor the tries answered from the mark used one of the Free member's scans.
  assert.equal((await call('account', 'free-a')).body.scans.remaining, 5);
  // Other shops are scanned as usual.
  assert.equal((await call('coupons', 'free-a', { merchant: 'codes.example.com' })).status, 200);

  clock.now = failed + 10 * MINUTE - 1_000;
  assert.match((await call('coupons', 'pro-c', { merchant: 'down.example.com' })).body.error, /Try again in about a minute\.$/);

  // After ten minutes the shop is tried again. It works this time, and the mark is gone.
  clock.now = failed + 10 * MINUTE + 1_000;
  down.clear();
  const sent = oxylabs.sent.length;
  const retried = await call('coupons', 'pro-c', { merchant: 'down.example.com' });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.source, 'live');
  assert.equal(oxylabs.sent.length, sent + 6);
});

test('after a failed scan, a saved list is shown in place of the error', async (t) => {
  const { call, clock, oxylabs, down } = await api(t);
  const read = clock.now;
  assert.equal((await call('coupons', 'pro-c', { merchant: 'codes.example.com' })).body.source, 'live');

  // A day later the shop cannot be searched. The Pro list is shown as it was, and so is the mark's answer after it.
  clock.now = read + 25 * HOUR;
  down.add('codes.example.com');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const answer = await call('coupons', 'pro-c', { merchant: 'codes.example.com' });
    assert.equal(answer.status, 200);
    assert.deepEqual([answer.body.source, answer.body.fetchedAt, answer.body.coupons[0].code], ['stale', when(read), 'SAVE10']);
  }
  // Six for the first scan, one for the failed search, none for the try answered from the mark.
  assert.equal(oxylabs.sent.length, 7);
});
