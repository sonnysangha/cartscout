// Stop signs (D5): captcha challenges, login walls, order confirmations, cross-origin frames, empty baskets.

import { attr, isHidden, norm, queryAllDeep } from './text.js';
import { CONFIRMATION_WORDS, EMPTY_BASKET_WORDS } from './vocab.js';

const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha/api2/bframe"]',
  'iframe[src*="hcaptcha.com"][src*="challenge"]',
  'iframe[src*="challenges.cloudflare.com"]',
  '.g-recaptcha[data-sitekey]',
  '.h-captcha',
  '.cf-turnstile',
  '#px-captcha',
  '#captcha-container',
];

const PAYMENT_FRAME_HINTS = /\b(?:checkout|cart|promo|coupon|discount|voucher|klarna|shopify|shop\.app|stripe|adyen|paypal|braintree|bigcommerce)\b/i;

function hasLayout(doc) {
  const rootRect = doc?.documentElement?.getBoundingClientRect?.();
  const bodyRect = doc?.body?.getBoundingClientRect?.();
  return (rootRect?.width ?? 0) > 0 || (bodyRect?.width ?? 0) > 0;
}

/** Detect visible blockers that must stop or prevent a run. */
export function detectBlocker(doc, loc = globalThis.location, { hasMainBox = false } = {}) {
  if (loc?.protocol && loc.protocol !== 'https:') return 'insecure';
  const layout = hasLayout(doc);

  // 1. Visible captcha / bot challenge (ignore hidden invisible-reCAPTCHA badges).
  for (const sel of CAPTCHA_SELECTORS) {
    for (const el of queryAllDeep(doc, sel)) {
      if (isHidden(el)) continue;
      if (layout) {
        const rect = el.getBoundingClientRect?.();
        if (rect && rect.width === 0 && rect.height === 0) continue;
      }
      // Ignore small corner invisible-v2 badges.
      if (el.tagName === 'IFRAME' && /recaptcha/.test(attr(el, 'src')) && !/bframe/.test(attr(el, 'src'))) continue;
      return 'captcha';
    }
  }

  // 2. Order confirmation page.
  const path = norm(loc?.pathname ?? '');
  if (/\b(?:thank[-_ ]?you|order[-_ ]?confirm|order[-_ ]?received|order[-_ ]?complete)\b/.test(path)) {
    return 'confirmation';
  }
  const heading = [...doc.querySelectorAll('h1, h2')].map((h) => norm(h.textContent ?? '')).join(' ');
  if (CONFIRMATION_WORDS.test(heading)) return 'confirmation';

  // 3. Login wall (visible password input on a page with no code box).
  if (!hasMainBox) {
    const pw = [...doc.querySelectorAll('input[type="password"]')].find((el) => !isHidden(el));
    if (pw && /\b(?:login|log-in|signin|sign-in|account\/login|auth)\b/.test(path)) return 'login';
  }

  // 4. Cross-origin iframe that looks like a checkout/cart container when no main-frame box exists.
  if (!hasMainBox && loc?.origin) {
    for (const frame of doc.querySelectorAll('iframe[src]')) {
      if (isHidden(frame)) continue;
      let url;
      try { url = new URL(attr(frame, 'src'), loc.href); } catch { continue; }
      if (url.origin === loc.origin) continue;
      const hint = `${url.href} ${attr(frame, 'title')} ${attr(frame, 'name')} ${attr(frame, 'id')}`;
      if (PAYMENT_FRAME_HINTS.test(hint)) {
        const rect = frame.getBoundingClientRect?.();
        if (!layout || !rect || (rect.width >= 200 && rect.height >= 120)) return 'frame';
      }
    }
  }

  return null;
}

/** True when the basket is clearly empty. */
export function isEmptyBasket(doc, recipe, { hasBox = false, hasTotal = false } = {}) {
  if (recipe?.empty) {
    if (recipe.empty.at?.some((sel) => {
      const el = doc.querySelector(sel);
      return el && !isHidden(el);
    })) return true;
    const root = doc.querySelector('main') ?? doc.body;
    const bodyText = norm(root?.textContent ?? '');
    if (recipe.empty.text?.some((phrase) => bodyText.includes(norm(phrase)))) return true;
    if (recipe.empty.none?.length && !hasTotal && !hasBox) {
      const anyPresent = recipe.empty.none.some((sel) => !!doc.querySelector(sel));
      if (!anyPresent) return true;
    }
    return false;
  }
  if (hasBox || hasTotal) return false;
  const root = doc.querySelector('main') ?? doc.body;
  const text = norm(root?.textContent ?? '');
  return EMPTY_BASKET_WORDS.test(text);
}
