import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { createCouponServer } from './index.js';
import { createDiscovery } from './oxylabs.js';
import { openStore } from './store.js';

test('discovery scrapes independent sources and filters invalid or expired codes', async () => {
  const calls = [];
  const request = async (address, { body }) => {
    const input = JSON.parse(body);
    calls.push({ address, input });
    const results = address.endsWith('/search') ? [
      { title: 'Coupons', url: 'https://discounts.example.com/nike' },
      { title: 'Deals', url: 'https://www.discounts.example.com/duplicate' },
      { title: 'Vouchers', url: 'https://savings.example.org/nike' },
      { title: 'Discount', url: 'http://127.0.0.1/invalid' },
    ] : [{ json: { coupons: [
      { code: ' SAVE10 ', offer: '10% off' },
      { code: 'PAST40', expiresOn: '2000-01-01' },
      { code: '<script>' },
    ] } }];
    return Response.json({ state: 'done', results });
  };
  const discover = createDiscovery({ key: 'fixture', location: 'GB', request });
  const result = await discover('nike.com');
  assert.equal(calls.length, 3);
  assert.match(calls[0].input.query, /nike\.com coupon/);
  assert.equal(calls[0].input.location, 'GB');
  assert.match(calls[1].input.json.prompt, /nike\.com/);
  assert.deepEqual(result, { complete: true, coupons: [{
    code: 'SAVE10', offer: '10% off', expiresOn: null,
    sources: ['https://discounts.example.com/nike', 'https://savings.example.org/nike'],
  }] });
});

test('shared cache, votes, vote changes, and persistence survive server restart', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'cartscout-test-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  let time = Date.now();
  let searches = 0;
  let outage = false;
  const discover = async () => {
    searches += 1;
    if (outage) throw new Error('Fixture outage');
    return { complete: true, coupons: [
      { code: 'TEST10', offer: 'Fixture offer', sources: [], expiresOn: null },
      { code: 'ABC10', offer: 'Fixture offer', sources: [], expiresOn: null },
    ] };
  };

  async function start() {
    const store = openStore(join(temp, 'shared.sqlite'));
    const server = createCouponServer({ discover, store, now: () => time, log: () => {} });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return {
      async call(route, reporter = 'a', fields = {}) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/${route}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + reporter.repeat(64) },
          body: JSON.stringify({ merchant: 'www.nike.com', ...fields }),
        });
        return { status: response.status, body: await response.json() };
      },
      async close() {
        await new Promise((resolve) => server.close(resolve));
        store.close();
      },
    };
  }

  const first = await start();
  try {
    const lookups = await Promise.all([first.call('coupons'), first.call('coupons', 'b')]);
    assert(lookups.every(({ status, body }) => status === 200 && body.coupons.length === 2));
    assert.equal(searches, 1);
    assert.equal((await first.call('coupons', 'b')).body.source, 'cache');
    assert.equal((await first.call('reports', 'b', { code: 'MADEUP', worked: true })).status, 404);
    assert.equal((await first.call('reports', 'a', { code: 'TEST10', worked: false })).status, 200);
    const changed = (await first.call('reports', 'a', { code: 'TEST10', worked: true })).body;
    assert.equal(changed.coupons[0].code, 'TEST10');
    assert.equal(changed.coupons[0].myReport, 1);
    assert.equal(changed.coupons[0].failed, 0);
    assert.equal(changed.coupons[0].worked, 1);
  } finally {
    await first.close();
  }

  const restarted = await start();
  try {
    const second = (await restarted.call('coupons', 'b')).body;
    assert.equal(second.source, 'cache');
    assert.equal(second.coupons[0].worked, 1);
    assert.equal(second.coupons[0].myReport, null);
    assert.equal(searches, 1);

    time += 25 * 3_600_000;
    outage = true;
    const stale = (await restarted.call('coupons', 'b')).body;
    assert.equal(stale.source, 'stale');
    assert.equal(stale.coupons[0].worked, 1);
  } finally {
    await restarted.close();
  }
});
