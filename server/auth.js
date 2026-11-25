import { verifyToken } from '@clerk/backend';

function issuerFromPublishableKey(key) {
  const encoded = key?.match(/^pk_(?:test|live)_([a-zA-Z0-9_-]+={0,2})$/)?.[1];
  const frontend = encoded && Buffer.from(encoded, 'base64url').toString('utf8');
  const domain = frontend?.match(/^([a-z0-9.-]+)\$$/i)?.[1];
  if (!domain) throw new Error('Set a valid CLERK_PUBLISHABLE_KEY on the coupon server.');
  return new URL(`https://${domain}`).origin;
}

export function createClerkAuthenticator({
  publishableKey, secretKey, allowedOrigins, proPlan = 'pro', verify = verifyToken,
}) {
  if (!secretKey) throw new Error('Set CLERK_SECRET_KEY on the coupon server.');
  const issuer = issuerFromPublishableKey(publishableKey);
  const authorizedParties = [...new Set((allowedOrigins ?? '').split(',').map((value) => value.trim()).filter(Boolean))];
  if (!authorizedParties.length) throw new Error('Set CLERK_ALLOWED_ORIGINS on the coupon server.');
  if (!/^[a-z0-9_-]+$/.test(proPlan)) throw new Error('Use a Clerk plan slug for CLERK_PRO_PLAN.');

  return async function authenticate(token) {
    if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return null;
    let claims;
    try {
      claims = await verify(token, { secretKey, authorizedParties });
    } catch {
      return null;
    }

    if (!claims || claims.iss !== issuer || claims.v !== 2 || (claims.sts && claims.sts !== 'active')
      || typeof claims.sid !== 'string' || !claims.sid.startsWith('sess_')
      || typeof claims.sub !== 'string' || !/^user_[\w-]+$/.test(claims.sub)) return null;
    return { userId: claims.sub, plan: claims.pla === `u:${proPlan}` ? 'pro' : 'free' };
  };
}
