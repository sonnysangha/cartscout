// Background "Other retailers" price comparison engine owned by the service worker.
// Lets the shopper close the popup while Scout checks other retailers, keeps results in storage.session
// per tab, sends an in-page notice when done if the popup has closed, and runs cleanly under node --test.

import { PANEL_FILE } from './run.js';

export const COMPARE_PER_PRESS = 2;
const FETCH_TIMEOUT_MS = 75_000;
const HEARTBEAT_MS = 12_000;
const noop = () => {};
const bare = (host) => String(host ?? '').toLowerCase().replace(/^www\./, '');

export const compareKey = (tabId) => `compare:${tabId}`;

function countCheaper(found) {
  let count = 0;
  for (const item of found ?? []) {
    const own = item?.own;
    if (!own || !Number.isFinite(own.price) || own.price <= 0 || !own.currency) continue;
    const hit = (item.offers ?? []).some((offer) => (
      offer
      && offer.availability === 'in_stock'
      && offer.match === 'exact'
      && Number.isFinite(offer.price)
      && offer.price > 0
      && offer.currency === own.currency
      && offer.price < own.price - 0.005
    ));
    if (hit) count += 1;
  }
  return count;
}

function cleanItems(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .filter((item) => item && typeof item.name === 'string' && item.name.trim().length >= 3)
    .slice(0, 12)
    .map((item) => ({
      name: item.name.trim().slice(0, 140),
      variant: typeof item.variant === 'string' ? item.variant.trim().slice(0, 100) : '',
      own: item.own && Number.isFinite(item.own.price) && item.own.price > 0 && typeof item.own.currency === 'string'
        ? { price: item.own.price, currency: item.own.currency, ...(item.own.from ? { from: true } : {}) }
        : null,
    }));
}

export function createCompareEngine({
  fetch, apiOrigin, token, storage, tabs, scripting,
  popupOpen = async () => false,
  runShowing = () => false,
  now = Date.now,
  heartbeatMs = HEARTBEAT_MS,
}) {
  const states = new Map();
  const active = new Map();

  async function persist(state) {
    states.set(state.tabId, state);
    await storage.set({ [compareKey(state.tabId)]: state }).catch(noop);
  }

  async function forget(tabId) {
    states.delete(tabId);
    active.delete(tabId);
    await storage.remove(compareKey(tabId)).catch(noop);
  }

  async function callAlternatives(merchant, country, items, cacheOnly = false) {
    const path = cacheOnly ? '/v1/alternatives/cached' : '/v1/alternatives';
    const request = async (bearer) => fetch(new URL(path, apiOrigin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        merchant,
        country,
        items: items.map(({ name, variant }) => ({ name, variant })),
      }),
      signal: AbortSignal.timeout(cacheOnly ? 8_000 : FETCH_TIMEOUT_MS),
    });

    let bearer = await token(false);
    if (!bearer) throw Object.assign(new Error('Sign in to compare prices.'), { code: 'signed_out', status: 401 });
    let response = await request(bearer);
    if (response.status === 401) {
      bearer = await token(true);
      if (!bearer) throw Object.assign(new Error('Sign in to compare prices.'), { code: 'signed_out', status: 401 });
      response = await request(bearer);
    }
    let data = {};
    try {
      const parsed = await response.json();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
    } catch {
      // Non-JSON error body.
    }
    if (!response.ok) {
      const msg = typeof data.message === 'string' && data.message
        ? data.message
        : (typeof data.error === 'string' && data.error ? data.error : 'CartScout couldn’t finish that. Try again in a moment.');
      throw Object.assign(new Error(msg), { code: data.code ?? '', status: response.status, resetAt: data.resetAt });
    }
    if (!Array.isArray(data.results)) {
      throw new Error('CartScout sent an answer Scout couldn’t read. Try again.');
    }
    return data.results;
  }

  async function notifyPage(state) {
    if (state.seen || await popupOpen().catch(() => false)) return;
    if (runShowing(state.tabId)) return;
    try {
      const tab = await tabs.get(state.tabId);
      if (!tab?.url || bare(new URL(tab.url).hostname) !== bare(state.host)) return;
      if (state.url && state.url !== tab.url) return;
      if (states.get(state.tabId)?.startedAt !== state.startedAt || states.get(state.tabId)?.seen) return;
      await scripting.executeScript({ target: { tabId: state.tabId }, files: [PANEL_FILE] });
      const offersCount = state.found.reduce((sum, item) => sum + (item.offers?.length ?? 0), 0);
      const cheaper = countCheaper(state.found);
      await tabs.sendMessage(state.tabId, {
        type: 'cartscout:notice',
        notice: {
          kind: 'compare',
          host: bare(state.host),
          count: offersCount,
          cheaper,
        },
      });
    } catch {
      // Tab navigated, closed, or cannot be scripted.
    }
  }

  async function executeBatch(tabId, runId) {
    const startState = states.get(tabId);
    if (!startState || active.get(tabId) !== runId) return;

    const batch = startState.items.slice(startState.checked, startState.checked + COMPARE_PER_PRESS);
    if (!batch.length) {
      await persist({ ...startState, status: 'done', error: null, finishedAt: now() });
      return;
    }

    // Keep the MV3 service worker awake during a slow retailer scrape by touching session storage periodically.
    const beat = heartbeatMs > 0 ? setInterval(() => {
      const cur = states.get(tabId);
      if (!cur || active.get(tabId) !== runId) return;
      void storage.set({ [compareKey(tabId)]: { ...cur, checkedAt: now() } }).catch(noop);
    }, heartbeatMs) : null;

    try {
      const results = await callAlternatives(startState.merchant, startState.country, batch);
      if (active.get(tabId) !== runId) return;
      const cur = states.get(tabId);
      if (!cur || cur.startedAt !== startState.startedAt) return;

      const resolved = results.map((result, index) => ({
        ...batch[index],
        ...result,
        offers: Array.isArray(result?.offers) ? result.offers : [],
        own: batch[index]?.own ?? null,
      }));
      const next = {
        ...cur,
        status: 'done',
        checked: cur.checked + resolved.length,
        found: [...cur.found, ...resolved],
        error: null,
        finishedAt: now(),
      };
      active.delete(tabId);
      await persist(next);
      await notifyPage(next);
    } catch (error) {
      if (active.get(tabId) !== runId) return;
      const cur = states.get(tabId);
      if (!cur || cur.startedAt !== startState.startedAt) return;
      const next = {
        ...cur,
        status: cur.found.length ? 'done' : 'error',
        error: {
          message: error?.message || 'Check your connection, then try again.',
          code: error?.code ?? '',
          resetAt: error?.resetAt ?? null,
        },
        finishedAt: now(),
      };
      active.delete(tabId);
      await persist(next);
    } finally {
      if (beat) clearInterval(beat);
    }
  }

  async function start({ tabId, host, merchant, country, basket = false, query = '', items, url } = {}) {
    if (!Number.isInteger(tabId)) return { error: 'CartScout couldn’t find that tab.' };
    if (typeof merchant !== 'string' || !merchant) return { error: 'Open a shop first, then compare prices.' };
    if (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country)) return { error: 'Choose a country first.' };
    const clean = cleanItems(items);
    if (!clean.length) return { error: 'There are no products to compare.' };

    const startedAt = now();
    const runId = `${startedAt}:${Math.random().toString(36).slice(2, 7)}`;
    const state = {
      v: 1,
      tabId,
      host: typeof host === 'string' && host ? host : merchant,
      merchant,
      ...(url && { url }),
      country,
      basket: basket === true,
      query: typeof query === 'string' ? query.slice(0, 140) : '',
      status: 'running',
      items: clean,
      checked: 0,
      found: [],
      error: null,
      startedAt,
      checkedAt: startedAt,
      finishedAt: null,
      seen: false,
    };
    active.set(tabId, runId);
    await persist(state);
    void executeBatch(tabId, runId);
    return { ok: true, state };
  }

  async function more({ tabId } = {}) {
    if (!Number.isInteger(tabId)) return { error: 'CartScout couldn’t find that tab.' };
    const cur = states.get(tabId);
    if (!cur) return { error: 'No basket comparison in progress.' };
    if (cur.status === 'running') return { ok: true, state: cur };
    if (cur.checked >= cur.items.length) return { error: 'Every basket product has already been checked.' };

    const runId = `${now()}:${Math.random().toString(36).slice(2, 7)}`;
    const next = {
      ...cur,
      status: 'running',
      error: null,
      checkedAt: now(),
      finishedAt: null,
      seen: false,
    };
    active.set(tabId, runId);
    await persist(next);
    void executeBatch(tabId, runId);
    return { ok: true, state: next };
  }

  async function seen({ tabId } = {}) {
    const cur = states.get(tabId);
    if (!cur || cur.seen) return { ok: true };
    await persist({ ...cur, seen: true });
    return { ok: true };
  }

  async function clear({ tabId } = {}) {
    if (Number.isInteger(tabId)) await forget(tabId);
    return { ok: true };
  }

  async function recover() {
    const stored = await storage.get(null).catch(() => ({}));
    for (const [key, saved] of Object.entries(stored ?? {})) {
      if (!key.startsWith('compare:') || !Number.isInteger(saved?.tabId) || states.has(saved.tabId)) continue;
      states.set(saved.tabId, saved);
      // If the service worker was suspended mid-fetch, resume the batch cleanly (server SQLite caches completed lookups!).
      if (saved.status === 'running') {
        const runId = `${now()}:recover`;
        active.set(saved.tabId, runId);
        void executeBatch(saved.tabId, runId);
      }
    }
  }

  function tabRemoved(tabId) {
    return states.has(tabId) ? forget(tabId) : Promise.resolve();
  }

  return {
    start,
    cached: (merchant, country, item) => callAlternatives(merchant, country, [item], true),
    more,
    seen,
    clear,
    recover,
    tabRemoved,
    get: (tabId) => states.get(tabId) ?? null,
  };
}
