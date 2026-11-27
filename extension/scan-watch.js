// The scan watcher. A scan is started by the popup and finished by the server even if the popup closes.
// The service worker follows it with short cache-only lookups and, when the popup is no longer there to show
// the result, puts the number of codes on the toolbar badge and a small notice on the shop's page.
// Everything Chrome-specific is passed in, so it runs under node --test.

import { PANEL_FILE } from './run.js';

export const WATCH_EVERY_MS = 3000;
export const WATCH_LIMIT_MS = 120_000;
// Chrome ends a service worker whose fetch goes unanswered for 30 seconds; no lookup is ever held that long.
const LOOKUP_TIMEOUT_MS = 10_000;

export const scanKey = (tabId) => `scan:${tabId}`;

const noop = () => {};
const bare = (host) => String(host).toLowerCase().replace(/^www\./, '');
const validHost = (host) => typeof host === 'string' && /^(?=.{4,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host);

export function createScanWatcher({
  fetch, apiOrigin, token, storage, tabs, scripting, action,
  popupOpen = async () => false,
  runShowing = () => false,
  now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const watches = new Map();

  async function forget(watch) {
    if (watches.get(watch.tabId) !== watch) return;
    watches.delete(watch.tabId);
    await storage.remove(scanKey(watch.tabId)).catch(noop);
  }

  /** One cache-only lookup: the number of codes when the scan has finished, 'running' while it has not, else 'over'. */
  async function look(host) {
    try {
      const bearer = await token();
      if (!bearer) return 'over';
      const response = await fetch(new URL('/v1/coupons', apiOrigin), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ merchant: host, cacheOnly: true }),
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
      const data = await response.json().catch(() => null);
      if (response.status === 200 && Array.isArray(data?.coupons)) return data.coupons.length;
      return response.status === 409 && data?.code === 'scan_in_progress' ? 'running' : 'over';
    } catch {
      return 'over';
    }
  }

  // The popup shows its own result. Only when it has gone, without showing this one, does the page get told.
  async function tell(watch, count) {
    const { tabId, host } = watch;
    // The watch is kept until the page has been told, so a result the popup shows in the meantime calls this off.
    const wanted = () => watches.get(tabId) === watch;
    if (await popupOpen().catch(() => false)) return;
    try {
      const tab = await tabs.get(tabId);
      // The count belongs to the shop that was scanned. A tab that has moved on, or whose address cannot be read,
      // gets neither the badge nor the notice.
      if (!wanted() || !tab.url || bare(new URL(tab.url).hostname) !== bare(host)) return;
      if (count > 0) await action.setBadgeText({ tabId, text: String(count) }).catch(noop);
      if (runShowing(tabId)) return;
      await scripting.executeScript({ target: { tabId }, files: [PANEL_FILE] });
      if (!wanted()) return;
      await tabs.sendMessage(tabId, { type: 'cartscout:notice', notice: { host: bare(host), count } });
    } catch { /* The tab has gone, left the shop or cannot be scripted. */ }
  }

  async function follow(watch) {
    while (watches.get(watch.tabId) === watch) {
      await wait(WATCH_EVERY_MS);
      if (watches.get(watch.tabId) !== watch) return;
      if (now() - watch.startedAt > WATCH_LIMIT_MS) break;
      // Touching storage on every tick keeps the service worker from being put to sleep mid-watch.
      await storage.set({ [scanKey(watch.tabId)]: { tabId: watch.tabId, host: watch.host, startedAt: watch.startedAt, checkedAt: now() } }).catch(noop);
      const found = await look(watch.host);
      if (watches.get(watch.tabId) !== watch) return;
      if (found === 'running') continue;
      if (found !== 'over') await tell(watch, found);
      break;
    }
    await forget(watch);
  }

  /** Follow the scan the popup has just started for this tab. A second watch for the tab replaces the first. */
  async function watch({ tabId, host } = {}, startedAt = now()) {
    if (!Number.isInteger(tabId) || !validHost(host)) return { error: 'CartScout couldn’t follow that scan.' };
    const next = { tabId, host, startedAt };
    watches.set(tabId, next);
    await storage.set({ [scanKey(tabId)]: { tabId, host, startedAt, checkedAt: startedAt } }).catch(noop);
    void follow(next);
    return { ok: true };
  }

  /** Pick watches back up after the service worker restarts without restarting the timer. */
  async function recover() {
    const stored = await storage.get(null).catch(() => ({}));
    for (const [key, saved] of Object.entries(stored ?? {})) {
      if (!key.startsWith('scan:') || watches.has(saved?.tabId)) continue;
      if (!Number.isInteger(saved?.tabId) || !validHost(saved.host) || !Number.isFinite(saved.startedAt)
        || now() - saved.startedAt > WATCH_LIMIT_MS) {
        await storage.remove(key).catch(noop);
        continue;
      }
      await watch(saved, saved.startedAt);
    }
  }

  function tabRemoved(tabId) {
    const current = watches.get(tabId);
    return current ? forget(current) : Promise.resolve();
  }

  /** The popup has shown this tab's result itself, so there is nothing left to tell the page. */
  async function seen(tabId) {
    if (!Number.isInteger(tabId)) return { error: 'CartScout couldn’t follow that scan.' };
    await tabRemoved(tabId);
    return { ok: true };
  }

  return { watch, seen, recover, tabRemoved, watching: (tabId) => watches.has(tabId) };
}
