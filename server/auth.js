import { verifyToken } from '@clerk/backend';

function issuerFromPublishableKey(key) {
  const encoded = key?.match(/^pk_(?:test|live)_([a-zA-Z0-9_-]+={0,2})$/)?.[1];
  const frontend = encoded && Buffer.from(encoded, 'base64url').toString('utf8');
  const domain = frontend?.match(/^([a-z0-9.-]+)\$$/i)?.[1];
  if (!domain) throw new Error('Set a valid CLERK_PUBLISHABLE_KEY on the coupon server.');
  return new URL(`https://${domain}`).origin;
}

// A forged token can name a signing key Clerk never issued, and each one would make the verifier ask Clerk for its
// key list. Tokens signed by a key not seen before are therefore rationed: a real key rotation needs one such
// lookup, a flood would need thousands.
const NEW_KEY_BURST = 5;
const NEW_KEY_EVERY = 5_000;
// Clerk finds the signing key before it checks anything else, so these refusals prove the key itself is real.
const REFUSED_WITH_A_REAL_KEY = new Set([
  'token-expired', 'token-not-active-yet', 'token-iat-in-the-future', 'token-invalid-authorized-parties', 'token-invalid-signature',
]);

function signingKeyId(token) {
  try {
    const header = JSON.parse(Buffer.from(token.slice(0, token.indexOf('.')), 'base64url').toString('utf8'));
    return typeof header?.kid === 'string' && header.kid.length <= 128 ? header.kid : null;
  } catch {
    return null;
  }
}

export function createClerkAuthenticator({
  publishableKey, secretKey, jwtKey, allowedOrigins, proPlan = 'pro', verify = verifyToken, now = Date.now,
}) {
  if (!secretKey) throw new Error('Set CLERK_SECRET_KEY on the coupon server.');
  const issuer = issuerFromPublishableKey(publishableKey);
  const authorizedParties = [...new Set((allowedOrigins ?? '').split(',').map((value) => value.trim()).filter(Boolean))];
  if (!authorizedParties.length) throw new Error('Set CLERK_ALLOWED_ORIGINS on the coupon server.');
  if (!/^[a-z0-9_-]+$/.test(proPlan)) throw new Error('Use a Clerk plan slug for CLERK_PRO_PLAN.');

  const seenKeys = new Set();
  let newKeyAllowance = NEW_KEY_BURST;
  let refilledAt = now();
  function mayLookUpNewKey() {
    const earned = Math.floor((now() - refilledAt) / NEW_KEY_EVERY);
    if (earned > 0) {
      newKeyAllowance = Math.min(NEW_KEY_BURST, newKeyAllowance + earned);
      refilledAt += earned * NEW_KEY_EVERY;
    }
    if (newKeyAllowance <= 0) return false;
    newKeyAllowance -= 1;
    return true;
  }

  return async function authenticate(token) {
    if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return null;
    const keyId = signingKeyId(token);
    if (!keyId) return null;
    // With CLERK_JWT_KEY set the token is checked without asking Clerk at all, so there is nothing to ration.
    const rationed = !jwtKey && !seenKeys.has(keyId);
    if (rationed && !mayLookUpNewKey()) return null;
    // A key that turned out to be real is remembered, and the allowance it used is handed back.
    const keyIsReal = () => {
      if (!rationed || seenKeys.has(keyId)) return;
      if (seenKeys.size >= 16) seenKeys.clear();
      seenKeys.add(keyId);
      newKeyAllowance = Math.min(NEW_KEY_BURST, newKeyAllowance + 1);
    };
    let claims;
    try {
      claims = await verify(token, { secretKey, authorizedParties, ...(jwtKey && { jwtKey }) });
    } catch (error) {
      if (REFUSED_WITH_A_REAL_KEY.has(error?.reason)) keyIsReal();
      return null;
    }
    keyIsReal();

    if (!claims || claims.iss !== issuer || claims.v !== 2 || (claims.sts && claims.sts !== 'active')
      || typeof claims.sid !== 'string' || !claims.sid.startsWith('sess_')
      || typeof claims.sub !== 'string' || !/^user_[\w-]+$/.test(claims.sub)) return null;
    const username = typeof claims.username === 'string' && claims.username.trim()
      ? claims.username.trim()
      : (typeof claims.first_name === 'string' && claims.first_name.trim() ? claims.first_name.trim() : undefined);
    return { userId: claims.sub, plan: claims.pla === `u:${proPlan}` ? 'pro' : 'free', ...(username && { username }) };
  };
}
