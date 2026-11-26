import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { verifyToken } from '@clerk/backend';
import { createClerkAuthenticator } from './auth.js';
import { createCouponServer } from './index.js';
import { openStore } from './store.js';

const issuer = 'https://cartscout-test.clerk.accounts.dev';
const extension = 'chrome-extension://oiiahmlikdllbbbahedcpbojgohonhao';
const portal = 'http://localhost:8788';

test('Clerk verifies the session before CartScout grants a personal Pro entitlement', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwtKey = publicKey.export({ type: 'spki', format: 'pem' });
  const auth = createClerkAuthenticator({
    secretKey: 'sk_test_fixture',
    publishableKey: 'pk_test_' + Buffer.from(new URL(issuer).hostname + '$').toString('base64url'),
    allowedOrigins: [portal, extension].join(','),
    verify: (token, options) => verifyToken(token, { ...options, jwtKey }),
  });

  function session(overrides) {
    const timestamp = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'fixture', cat: 'cl_B7d4PD111AAA' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      azp: extension, exp: timestamp + 60, iat: timestamp, iss: issuer, nbf: timestamp,
      sid: 'sess_test', sub: 'user_test', v: 2, pla: 'u:pro', ...overrides,
    })).toString('base64url');
    const reply = header + '.' + payload;
    return reply + '.' + sign('RSA-SHA256', Buffer.from(reply), privateKey).toString('base64url');
  }

  assert.deepEqual(await auth(session()), { userId: 'user_test', plan: 'pro' });
  assert.deepEqual(await auth(session({ azp: portal, pla: 'u:free_user' })), { userId: 'user_test', plan: 'free' });
  assert.deepEqual(await auth(session({ pla: 'o:pro' })), { userId: 'user_test', plan: 'free' });
  assert.equal(await auth(session({ azp: 'https://foreign.example' })), null);
  assert.equal(await auth(session({ iss: 'https://foreign.clerk.accounts.dev' })), null);
  assert.equal(await auth(session({ sts: 'pending' })), null);
  assert.equal(await auth(session({ exp: Math.floor(Date.now() / 1000) - 60 })), null);
  const [header, body, signature] = session().split('.');
  assert.equal(await auth([header, body, (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1)].join('.')), null);
});

async function service(t) {
  const store = openStore(':memory:');
  const start = { now: Date.parse('2026-11-23T12:00:00Z'), scans: 0, comparisons: 0 };
  const identities = {
    'free-a': { userId: 'user_alex', plan: 'free' },
    'free-b': { userId: 'user_bailey', plan: 'free' },
    'pro-a': { userId: 'user_alex', plan: 'pro' },
    'pro-c': { userId: 'user_casey', plan: 'pro' },
  };
  const server = createCouponServer({
    store, now: () => start.now,
    authenticate: async (token) => Object.hasOwn(identities, token) ? identities[token] : null,
    discover: async (merchant) => {
      const n = ++start.scans;
      if (merchant === 'unavailable.example.com') throw new Error('Fixture outage');
      return { complete: true, coupons: [{ code: 'CODE' + n, offer: '', sources: [], expiresOn: null }] };
    },
    findAlternatives: async () => {
      start.comparisons++;
      return { offers: [], partial: false };
    },
    log: () => {},
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });

  return {
    start,
    async call(route, token, body) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/${route}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          ...(token && { Authorization: 'Bearer ' + token }),
          ...(body && { 'Content-Type': 'application/json' }),
        },
        ...(body && { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

const site = { merchant: 'shop.example.com' };

test('Free cache and reports are private, and upgrading exposes the Pro shared cache', async (t) => {
  const { call, start } = await service(t);
  assert.equal((await call('account')).status, 401);
  assert.equal((await call('coupons', 'a'.repeat(64), site)).status, 401);
  const pro = (await call('coupons', 'pro-c', site)).body;
  assert.equal(pro.coupons[0].code, 'CODE1');
  assert.equal(pro.reused, undefined);

  const needsScan = await call('coupons', 'free-a', { ...site, cacheOnly: true });
  assert.equal(needsScan.status, 409);
  assert.equal(needsScan.body.code, 'scan_required');
  assert.equal(needsScan.body.account.scans.remaining, 5);
  assert.equal(start.scans, 1);
  assert.equal((await call('reports', 'free-a', { ...site, code: 'CODE1', worked: true })).status, 404);

  // The server read this shop a moment ago for another member. A Free member's scan is answered from those pages:
  // nothing is read again, it still uses one of their scans, and the answer says when the pages were read.
  const free = (await call('coupons', 'free-a', site)).body;
  assert.equal(free.coupons[0].code, 'CODE1');
  assert.equal(free.source, 'live');
  assert.equal(free.reused, true);
  assert.equal(free.fetchedAt, new Date(start.now).toISOString());
  assert.equal(free.account.scans.remaining, 4);
  assert.equal(start.scans, 1);
  // The codes are public pages. The list and its thumbs are still each Free member's own.
  assert.equal((await call('reports', 'free-a', { ...site, code: 'CODE1', worked: true })).body.coupons[0].worked, 1);
  assert.equal((await call('reports', 'free-b', { ...site, code: 'CODE1', worked: true })).status, 404);
  const repeat = (await call('coupons', 'free-a', { ...site, cacheOnly: true })).body;
  assert.equal(repeat.source, 'cache');
  assert.equal(repeat.reused, true);
  assert.equal(repeat.account.scans.remaining, 4);
  const different = (await call('coupons', 'free-b', site)).body;
  assert.equal(different.coupons[0].code, 'CODE1');
  assert.equal(different.coupons[0].worked, 0);
  assert.equal(different.account.scans.remaining, 4);
  const afterUpgrade = (await call('coupons', 'pro-a', site)).body;
  assert.equal(afterUpgrade.source, 'cache');
  assert.deepEqual(afterUpgrade.account, { userId: 'user_alex', plan: 'pro', scans: null });
  assert.equal(afterUpgrade.coupons[0].code, 'CODE1');
  // Thumbs are shared between Pro members only: the one Alex gave as a Free member is not in the Pro count.
  assert.equal(afterUpgrade.coupons[0].worked, 0);
  assert.equal(start.scans, 1);
});

test('Free quota is race resistant, per account, and resets Monday UTC', async (t) => {
  const { call, start } = await service(t);
  const accepted = await Promise.all(Array.from({ length: 6 }, (_, n) =>
    call('coupons', 'free-a', { merchant: `shop${n}.example.com` })));
  assert.equal(accepted.filter((reply) => reply.status === 200).length, 5);
  const blocked = accepted.find((reply) => reply.status === 429);
  assert.equal(blocked.body.code, 'scan_limit');
  assert.equal(blocked.body.account.scans.remaining, 0);
  assert.equal(blocked.body.account.scans.resetsAt, '2026-11-30T00:00:00.000Z');
  assert.equal(start.scans, 5);
  assert.equal((await call('account', 'free-b')).body.scans.remaining, 5);

  start.now = Date.parse('2026-11-30T00:00:00Z');
  assert.equal((await call('account', 'free-a')).body.scans.remaining, 5);
  assert.equal((await call('coupons', 'free-a', site)).body.account.scans.remaining, 4);
});

test('failed Free scans release their quota, and a price lookup is shared because prices are public', async (t) => {
  const { call, start } = await service(t);
  assert.equal((await call('coupons', 'free-a', { merchant: 'unavailable.example.com' })).status, 502);
  assert.equal((await call('account', 'free-a')).body.scans.remaining, 5);

  // One lookup answers every member, Free or Pro, who asks about the same product at the same shop.
  const basket = { ...site, country: 'GB', items: [{ name: 'Test Product' }] };
  for (const token of ['free-a', 'free-a', 'free-b', 'pro-a', 'pro-c']) {
    assert.equal((await call('alternatives', token, basket)).status, 200);
  }
  assert.equal(start.comparisons, 1);
  assert.equal((await call('account', 'free-a')).body.scans.remaining, 5);
});

test('a Free saved scan that has aged out is still shown, and scanning again stays a choice', async (t) => {
  const { call, start } = await service(t);
  const first = (await call('coupons', 'free-a', site)).body;
  assert.equal(first.source, 'live');
  assert.equal(first.account.scans.remaining, 4);

  start.now += 25 * 60 * 60_000;
  const saved = await call('coupons', 'free-a', { ...site, cacheOnly: true });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.source, 'stale');
  assert.equal(saved.body.coupons[0].code, 'CODE1');
  assert.equal(saved.body.account.scans.remaining, 4);
  assert.equal(start.scans, 1);

  const rescanned = (await call('coupons', 'free-a', site)).body;
  assert.equal(rescanned.source, 'live');
  assert.equal(rescanned.account.scans.remaining, 3);
  assert.equal(start.scans, 2);
});
