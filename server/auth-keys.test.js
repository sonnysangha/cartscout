import assert from 'node:assert/strict';
import test from 'node:test';
import { createClerkAuthenticator } from './auth.js';

const issuer = 'https://cartscout-test.clerk.accounts.dev';
const origin = 'chrome-extension://oiiahmlikdllbbbahedcpbojgohonhao';
const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = (kid, name = 'x') => `${part({ alg: 'RS256', typ: 'JWT', ...(kid && { kid }) })}.${part({ name })}.c2ln`;
const refused = (reason) => Object.assign(new Error(reason), { reason });

// Stands in for Clerk: it knows one signing key, "real", and has to look up any other key it is shown.
function fixture(options = {}) {
  const clock = { now: 1_000_000 };
  const seen = { lookups: 0, calls: 0, options: null };
  const authenticate = createClerkAuthenticator({
    secretKey: 'sk_test_fixture',
    publishableKey: 'pk_test_' + Buffer.from(new URL(issuer).hostname + '$').toString('base64url'),
    allowedOrigins: origin,
    now: () => clock.now,
    verify: async (value, given) => {
      seen.calls += 1;
      seen.options = given;
      const { kid } = JSON.parse(Buffer.from(value.split('.')[0], 'base64url'));
      const { name } = JSON.parse(Buffer.from(value.split('.')[1], 'base64url'));
      if (kid !== 'real') {
        seen.lookups += 1;
        throw refused('jwk-kid-mismatch');
      }
      if (name === 'expired') throw refused('token-expired');
      return { iss: issuer, v: 2, sid: 'sess_1', sub: 'user_1', pla: 'u:free_user' };
    },
    ...options,
  });
  return { authenticate, clock, seen };
}

test('a flood of made-up signing keys reaches Clerk only a handful of times', async () => {
  const { authenticate, clock, seen } = fixture();
  assert.deepEqual(await authenticate(token('real')), { userId: 'user_1', plan: 'free' });

  const flood = await Promise.all(Array.from({ length: 50 }, (_, index) => authenticate(token(`forged-${index}`))));
  assert.ok(flood.every((identity) => identity === null));
  assert.equal(seen.lookups, 5);

  // Members signed by the key already known are not held up by the flood.
  assert.deepEqual(await authenticate(token('real')), { userId: 'user_1', plan: 'free' });
  assert.equal(await authenticate(token('forged-again')), null);
  assert.equal(seen.lookups, 5);

  // The allowance comes back slowly: one new key every five seconds.
  clock.now += 5_000;
  await authenticate(token('forged-later'));
  await authenticate(token('forged-later-2'));
  assert.equal(seen.lookups, 6);
});

test('a real key is recognised even when its first tokens are refused, so the ration never locks members out', async () => {
  const { authenticate, seen } = fixture();
  for (let index = 0; index < 12; index += 1) assert.equal(await authenticate(token('real', 'expired')), null);
  assert.deepEqual(await authenticate(token('real')), { userId: 'user_1', plan: 'free' });
  assert.equal(seen.calls, 13);

  // Handing the allowance back means a later rotation to a new key still gets its lookups.
  await Promise.all(Array.from({ length: 5 }, (_, index) => authenticate(token(`other-${index}`))));
  assert.equal(seen.lookups, 5);
});

test('a token that names no signing key is refused without asking Clerk', async () => {
  const { authenticate, seen } = fixture();
  assert.equal(await authenticate(token(null)), null);
  assert.equal(await authenticate('not.a.token'), null);
  assert.equal(seen.calls, 0);
});

test('with a local verification key nothing is rationed, because Clerk is never asked', async () => {
  const { authenticate, seen } = fixture({ jwtKey: 'PEM' });
  await Promise.all(Array.from({ length: 20 }, (_, index) => authenticate(token(`forged-${index}`))));
  assert.equal(seen.calls, 20);
  assert.equal(seen.options.jwtKey, 'PEM');
  assert.deepEqual(await authenticate(token('real')), { userId: 'user_1', plan: 'free' });
});
