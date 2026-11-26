// Recent Pro wins API tests: confirmed savings recording, strict server-side Pro gating, and zero leaks on Free.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createCouponServer } from './index.js';
import { openStore } from './store.js';

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);

async function startRig() {
  const store = openStore(':memory:');
  const users = {
    'pro-token': { userId: 'user_pro', plan: 'pro', username: 'olivia' },
    'free-token': { userId: 'user_free', plan: 'free', username: 'freeuser' },
  };
  const app = createCouponServer({
    store,
    now: () => NOW,
    authenticate: async (token) => users[token] ?? null,
    discover: async (merchant) => {
      if (merchant === 'allbirds.co.uk') {
        return { complete: true, coupons: [{ code: 'WELCOME10', offer: '10% off first order', sources: ['https://allbirds.co.uk'], expiresOn: null }] };
      }
      if (merchant === 'myprotein.com') {
        return {
          complete: true,
          coupons: [
            { code: 'MYPCHECKOUT', offer: 'Extra 13% off', sources: ['https://groupon.co.uk'], expiresOn: null },
            { code: 'BADCODE', offer: 'Old code', sources: ['https://groupon.co.uk'], expiresOn: null },
          ],
        };
      }
      return { complete: true, coupons: [] };
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const { port } = app.address();
  const base = `http://127.0.0.1:${port}`;
  const req = async (method, path, token, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        Origin: 'http://localhost:8788',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, headers: res.headers, json: await res.json() };
  };
  return {
    req,
    close: () => new Promise((resolve) => app.close(() => { store.close(); resolve(); })),
  };
}

test('GET /v1/wins returns recent working codes with savings for Pro and NEVER leaks real data to Free', async () => {
  const rig = await startRig();
  try {
    // Pro scans two shops and reports working codes with savings + one failed code.
    await rig.req('POST', '/v1/coupons', 'pro-token', { merchant: 'allbirds.co.uk', cacheOnly: false });
    await rig.req('POST', '/v1/coupons', 'pro-token', { merchant: 'myprotein.com', cacheOnly: false });
    await rig.req('POST', '/v1/reports', 'pro-token', {
      merchant: 'allbirds.co.uk', code: 'WELCOME10', worked: true, savedAmount: 14.19, savedCurrency: 'GBP',
    });
    await rig.req('POST', '/v1/reports', 'pro-token', {
      merchant: 'myprotein.com', code: 'MYPCHECKOUT', worked: true, savedAmount: 3.77, savedCurrency: 'GBP',
    });
    await rig.req('POST', '/v1/reports', 'pro-token', {
      merchant: 'myprotein.com', code: 'BADCODE', worked: false,
    });

    // Free scans and votes privately (must never leak into shared Pro wins).
    await rig.req('POST', '/v1/coupons', 'free-token', { merchant: 'allbirds.co.uk', cacheOnly: false });
    await rig.req('POST', '/v1/reports', 'free-token', {
      merchant: 'allbirds.co.uk', code: 'WELCOME10', worked: true, savedAmount: 99.99, savedCurrency: 'GBP',
    });

    // Pro gets both winning codes with confirmed savings, excluding BADCODE and Free's private report.
    const proRes = await rig.req('GET', '/v1/wins', 'pro-token');
    assert.equal(proRes.status, 200);
    assert.equal(proRes.headers.get('access-control-allow-origin'), 'http://localhost:8788');
    assert.equal(proRes.json.locked, false);
    assert.equal(proRes.json.wins.length, 2);
    const byCode = Object.fromEntries(proRes.json.wins.map((w) => [w.code, w]));
    assert.equal(byCode.WELCOME10.merchant, 'allbirds.co.uk');
    assert.equal(byCode.WELCOME10.savedAmount, 14.19);
    assert.equal(byCode.WELCOME10.savedCurrency, 'GBP');
    assert.equal(byCode.WELCOME10.memberName, '@olivia');
    assert.equal(byCode.MYPCHECKOUT.merchant, 'myprotein.com');
    assert.equal(byCode.MYPCHECKOUT.savedAmount, 3.77);
    assert.equal(byCode.MYPCHECKOUT.memberName, '@olivia');
    assert.equal(byCode.BADCODE, undefined);

    // Free receives ONLY locked: true + count, with ZERO real codes, merchants, usernames, or savings.
    const freeRes = await rig.req('GET', '/v1/wins', 'free-token');
    assert.equal(freeRes.status, 200);
    assert.deepEqual(freeRes.json, { locked: true, count: 2, wins: [] });
    const rawFree = JSON.stringify(freeRes.json);
    assert.equal(rawFree.includes('WELCOME10'), false);
    assert.equal(rawFree.includes('MYPCHECKOUT'), false);
    assert.equal(rawFree.includes('allbirds'), false);
    assert.equal(rawFree.includes('olivia'), false);
    assert.equal(rawFree.includes('14.19'), false);
  } finally {
    await rig.close();
  }
});
