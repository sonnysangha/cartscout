import { createClerkClient } from '@clerk/chrome-extension/client';
import { API_ORIGIN, CLERK_PUBLISHABLE_KEY, CLERK_SYNC_ORIGIN } from './config.js';
import { createReporter, createRunEngine, panelMessages as runMessages, senderRole } from './run.js';
import { createScanWatcher } from './scan-watch.js';
import { createCompareEngine } from './compare-worker.js';
import { HANDOVER_KEY, popupHandover } from './handover.js';

let clerkClient;
let clientLoading;
let tokenInFlight;
const TOKEN_CACHE_KEY = 'clerkTokenCache';

function tokenValid(jwt) {
  if (typeof jwt !== 'string') return false;
  try {
    const part = jwt.split('.')[1];
    if (!part) return false;
    const claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return Number.isFinite(claims.exp) && claims.exp * 1000 > Date.now() + 15_000;
  } catch {
    return false;
  }
}

async function loadFreshClerkClient() {
  if (clientLoading) return clientLoading;
  const pending = createClerkClient({
    publishableKey: CLERK_PUBLISHABLE_KEY,
    syncHost: CLERK_SYNC_ORIGIN,
    background: true,
  });
  clientLoading = pending;
  clerkClient = pending;
  try {
    return await pending;
  } catch (error) {
    if (clerkClient === pending) clerkClient = undefined;
    throw error;
  } finally {
    if (clientLoading === pending) clientLoading = undefined;
  }
}

async function readClerkJwt(clerk, skipCache) {
  const active = clerk?.session ?? clerk?.client?.activeSessions?.[0] ?? null;
  if (!active) return null;
  const jwt = await active.getToken({ skipCache });
  return typeof jwt === 'string' && jwt ? jwt : null;
}

async function fetchSessionToken(fresh) {
  if (!fresh) {
    // Fast path: reuse a warm, unexpired JWT across popup opens & service-worker wakes (~1ms).
    const cached = (await chrome.storage.session?.get(TOKEN_CACHE_KEY).catch(() => undefined))?.[TOKEN_CACHE_KEY];
    if (tokenValid(cached)) return cached;
  }
  // Cache missed or fresh requested: ask Clerk with skipCache so we never get back a nearly-expired JWT.
  let clerk = fresh || !clerkClient ? await loadFreshClerkClient() : await clerkClient;
  let jwt = await readClerkJwt(clerk, true);
  // Never declare the shopper signed out from a stale or unhydrated client: force one clean re-sync from syncHost.
  if (!jwt) {
    clerkClient = undefined;
    clerk = await loadFreshClerkClient();
    jwt = await readClerkJwt(clerk, true);
  }
  if (jwt) void chrome.storage.session?.set({ [TOKEN_CACHE_KEY]: jwt }).catch(() => {});
  else void chrome.storage.session?.remove(TOKEN_CACHE_KEY).catch(() => {});
  return jwt;
}

async function sessionToken(fresh) {
  if (!CLERK_PUBLISHABLE_KEY) throw new Error('Build CartScout with a Clerk publishable key.');
  // Coalesce concurrent requests so parallel popup/worker calls never race on Clerk's singleton client.
  if (!fresh && tokenInFlight) return tokenInFlight;
  const pending = fetchSessionToken(fresh);
  tokenInFlight = pending;
  try {
    return await pending;
  } finally {
    if (tokenInFlight === pending) tokenInFlight = undefined;
  }
}

const fetchFromWorker = (...request) => fetch(...request);
const token = (fresh = false) => sessionToken(fresh === true);

// Every strong-evidence answer a shop gives during a run becomes a thumb on that code, with the shopper's own session.
const engine = createRunEngine({
  scripting: chrome.scripting,
  tabs: chrome.tabs,
  storage: chrome.storage.session,
  picks: chrome.storage.local,
  action: chrome.action,
  report: createReporter({ fetch: fetchFromWorker, apiOrigin: API_ORIGIN, token }),
});

// The popup counts as open as the toolbar popup or as popup.html in a tab of its own.
async function popupOpen() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['POPUP', 'TAB'] });
    return contexts.some(({ contextType, documentUrl }) => contextType === 'POPUP'
      || (!!documentUrl && new URL(documentUrl).pathname === '/popup.html'));
  } catch {
    return false;
  }
}

const watcher = createScanWatcher({
  fetch: fetchFromWorker, apiOrigin: API_ORIGIN, token, storage: chrome.storage.session,
  tabs: chrome.tabs, scripting: chrome.scripting, action: chrome.action,
  popupOpen, runShowing: (tabId) => engine.showing(tabId),
});

const compare = createCompareEngine({
  fetch: fetchFromWorker, apiOrigin: API_ORIGIN, token, storage: chrome.storage.session,
  tabs: chrome.tabs, scripting: chrome.scripting,
  popupOpen, runShowing: (tabId) => engine.showing(tabId),
});

// Runs, scan watches and retailer comparisons live in storage.session, so a restarted worker picks them back up.
const recovered = Promise.all([engine.recover(), watcher.recover(), compare.recover()]);

const extension = { id: chrome.runtime.id, origin: chrome.runtime.getURL('').replace(/\/$/, '') };

async function openPopup(tabId, sender, message) {
  try {
    if (typeof chrome.action.openPopup !== 'function') return { ok: false };
    const tab = await chrome.tabs.get(tabId);
    const note = popupHandover(tabId, sender?.url, Date.now(), message?.view);
    if (note) await chrome.storage.session.set({ [HANDOVER_KEY]: note });
    await chrome.action.openPopup({ windowId: tab.windowId });
    return { ok: true };
  } catch {
    void chrome.storage.session.remove(HANDOVER_KEY).catch(() => {});
    return { ok: false };
  }
}

// From the popup: the toolbar popup, or popup.html?tab=<id> opened as a page for tests and recordings.
const popupMessages = {
  'cartscout:get-session': async (message) => {
    try {
      return { token: await sessionToken(message.fresh === true) };
    } catch {
      return { error: 'Couldn’t check your sign-in. Open your CartScout account and try again.' };
    }
  },
  'cartscout:run-start': ({ tabId, coupons, merchant, pick }) => engine.start({ tabId, coupons, merchant, pick: pick === true }),
  'cartscout:run-rest': ({ tabId }) => engine.resume(tabId),
  'cartscout:run-stop': ({ tabId }) => engine.stop(tabId),
  'cartscout:run-clear': ({ tabId }) => engine.clear(tabId),
  'cartscout:scan-watch': ({ tabId, host }) => watcher.watch({ tabId, host }),
  'cartscout:scan-seen': ({ tabId }) => watcher.seen(tabId),
  'cartscout:compare-start': (message) => compare.start(message),
  'cartscout:compare-more': ({ tabId }) => compare.more({ tabId }),
  'cartscout:compare-clear': ({ tabId }) => compare.clear({ tabId }),
  'cartscout:compare-seen': ({ tabId }) => compare.seen({ tabId }),
};

// From the in-page panel. It only ever speaks for the tab it is in: the tab id comes from Chrome, never from the message.
const panelMessages = {
  ...runMessages(engine),
  'cartscout:open-popup': (tabId, sender, message) => openPopup(tabId, sender, message),
};

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const type = message?.type;
  const role = senderRole(sender, extension);
  let answer;
  if (role === 'popup' && Object.hasOwn(popupMessages, type)) answer = () => popupMessages[type](message);
  else if (role === 'panel' && Object.hasOwn(panelMessages, type)) answer = () => panelMessages[type](sender.tab.id, sender, message);
  else return false;
  void (async () => {
    try {
      await recovered;
      respond(await answer());
    } catch {
      respond({ error: 'CartScout hit a problem, so please try again.' });
    }
  })();
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void recovered.then(() => Promise.all([engine.tabRemoved(tabId), watcher.tabRemoved(tabId), compare.tabRemoved(tabId)]));
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  void recovered.then(async () => {
    const run = await engine.tabUpdated(tabId, changeInfo);
    if (run === 'forgotten' || (run === 'none' && changeInfo.status === 'loading')) await chrome.action.setBadgeText({ tabId, text: '' });
  }).catch(() => {});
});

// The badge wears the brand: ink with sticker-yellow numerals.
void chrome.action.setBadgeBackgroundColor({ color: '#1f1b16' }).catch(() => {});
void chrome.action.setBadgeTextColor({ color: '#ffd23f' }).catch(() => {});
