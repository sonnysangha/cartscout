// The note the service worker leaves for a popup it opens from the page notice ("Show codes"), and how the popup
// reads it. Normally the tab still carries the access the shopper's last click on the toolbar gave, and the popup
// reads the address itself. When Chrome has let that access go, this note is how the popup still learns which shop
// the notice was for. Pure: covered by server/handover.test.js.

export const HANDOVER_KEY = 'popupHandover';
export const HANDOVER_MS = 15_000;

const publicHost = (host) => typeof host === 'string' && host.length <= 253
  && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host);

/** What to leave: the tab, and the host of the page whose notice was pressed. Null when that page is not a public site. */
export function popupHandover(tabId, senderUrl, now, view) {
  if (!Number.isInteger(tabId)) return null;
  let url;
  try {
    url = new URL(senderUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!['https:', 'http:'].includes(url.protocol) || !publicHost(host)) return null;
  return view === 'alternatives' ? { tabId, host, at: now, view } : { tabId, host, at: now };
}

/** The host a popup may take from a note: only for its own tab, and only in the moments after it was left. */
export function handedHost(note, tabId, now) {
  if (!note || typeof note !== 'object' || !Number.isInteger(tabId) || note.tabId !== tabId) return '';
  if (!Number.isFinite(note.at) || now - note.at > HANDOVER_MS || now - note.at < -1000) return '';
  return publicHost(note.host) ? note.host : '';
}

/** Optional target tab view left by a page notice (e.g. 'alternatives' from "Show prices"). */
export function handedView(note, tabId, now) {
  if (!handedHost(note, tabId, now)) return '';
  return note.view === 'alternatives' ? 'alternatives' : '';
}
