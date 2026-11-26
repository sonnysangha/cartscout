import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createCouponServer } from './index.js';
import { openStore } from './store.js';

// A server whose scan stays in flight until the test lets it finish.
async function slowScanService(t) {
  const store = openStore(':memory:');
  const scan = { started: 0, finish: null };
  const identities = {
    'free-a': { userId: 'user_alex', plan: 'free' },
    'free-b': { userId: 'user_bailey', plan: 'free' },
  };
  const server = createCouponServer({
    store,
    now: () => Date.parse('2026-11-23T12:00:00Z'),
    authenticate: async (token) => (Object.hasOwn(identities, token) ? identities[token] : null),
    discover: () => new Promise((resolve) => {
      scan.started += 1;
      scan.finish = () => resolve({ complete: true, coupons: [{ code: 'SLOW10', offer: '', sources: [], expiresOn: null }] });
    }),
    log: () => {},
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });
  const call = async (token, body, signal) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/coupons`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ merchant: 'shop.example.com', ...body }),
      signal,
    });
    return { status: response.status, body: await response.json() };
  };
  const scanStarted = async () => {
    while (!scan.finish) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  return { call, scan, scanStarted };
}

test('a reopened popup learns a scan is still running and joins it without paying twice', async (t) => {
  const { call, scan, scanStarted } = await slowScanService(t);
  const first = call('free-a', {});
  await scanStarted();

  const reopened = await call('free-a', { cacheOnly: true });
  assert.equal(reopened.status, 409);
  assert.equal(reopened.body.code, 'scan_in_progress');
  assert.equal(reopened.body.account.scans.remaining, 4);
  assert.equal((await call('free-b', { cacheOnly: true })).body.code, 'scan_required');

  const joined = call('free-a', {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(scan.started, 1);
  scan.finish();

  for (const answer of await Promise.all([first, joined])) {
    assert.equal(answer.status, 200);
    assert.equal(answer.body.source, 'live');
    assert.equal(answer.body.coupons[0].code, 'SLOW10');
    assert.equal(answer.body.account.scans.remaining, 4);
  }
  assert.equal((await call('free-a', { cacheOnly: true })).body.source, 'cache');
});

test('a scan finishes and is saved even when the popup that started it has closed', async (t) => {
  const { call, scan, scanStarted } = await slowScanService(t);
  const popup = new AbortController();
  const abandoned = call('free-a', {}, popup.signal).catch((error) => error.name);
  await scanStarted();
  popup.abort();
  assert.equal(await abandoned, 'AbortError');

  scan.finish();
  let saved;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    saved = await call('free-a', { cacheOnly: true });
    if (saved.status === 200) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(saved.status, 200);
  assert.equal(saved.body.source, 'cache');
  assert.equal(saved.body.coupons[0].code, 'SLOW10');
  assert.equal(saved.body.account.scans.remaining, 4);
  assert.equal(scan.started, 1);
});
