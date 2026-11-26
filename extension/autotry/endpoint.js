// Shopify Cart Ajax API driver (POST {root}cart/update.js with {"discount": CODE}).
// Works on every Shopify storefront theme (including Dawn, which has no cart code box).

import { moneyFromMinor } from './money.js';
import { attr } from './text.js';

/** Derive locale-aware Shopify cart root from `form[action$="/cart"]`, defaulting to `/`. */
export function shopifyRoot(doc) {
  const form = doc.querySelector?.('form[action$="/cart"]');
  const action = form ? attr(form, 'action').trim() : '';
  if (action && action.startsWith('/') && action.endsWith('/cart')) {
    const prefix = action.slice(0, -'cart'.length);
    return prefix.startsWith('/') ? prefix : '/';
  }
  return '/';
}

function parseCartJson(data) {
  if (!data || typeof data !== 'object') return null;
  const currency = typeof data.currency === 'string' ? data.currency : '';
  const total = Number.isFinite(data.total_price)
    ? moneyFromMinor(data.total_price, currency, 2, 'total', 'Total')
    : null;
  const itemCount = Number.isFinite(data.item_count) ? data.item_count : null;
  const codes = Array.isArray(data.discount_codes)
    ? data.discount_codes.map((entry) => ({
      code: String(entry?.code ?? '').trim().toUpperCase(),
      applicable: entry?.applicable === true,
    })).filter((entry) => entry.code)
    : [];
  const applied = codes.map((c) => ({
    code: c.code,
    by: 'endpoint',
    effect: c.applicable ? 'applied' : 'none',
    removable: true,
  }));
  return { total, itemCount, codes, applied };
}

function parseRetryAfter(header) {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) && date > Date.now() ? date - Date.now() : null;
}

export function createShopifyEndpoint(doc, fetcher = globalThis.fetch) {
  const root = shopifyRoot(doc);

  async function readCart() {
    if (typeof fetcher !== 'function') return null;
    try {
      const res = await fetcher(`${root}cart.js`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return null;
      return parseCartJson(await res.json());
    } catch {
      return null;
    }
  }

  async function writeDiscount(code) {
    if (typeof fetcher !== 'function') return { status: 0, error: true };
    try {
      const res = await fetcher(`${root}cart/update.js`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ discount: code }),
      });
      if (res.status === 429) {
        return { status: 429, pause: true, retryAfter: parseRetryAfter(res.headers?.get?.('retry-after')) };
      }
      if (!res.ok) return { status: res.status, error: true };
      const parsed = parseCartJson(await res.json());
      if (!parsed) return { status: res.status, error: true };
      return { status: res.status, ...parsed };
    } catch {
      return { status: 0, error: true };
    }
  }

  return { root, readCart, writeDiscount };
}
