import { PORTAL_ORIGIN } from './config.js';

const SYNC_PROBLEM = 'The sign-in check didn’t answer. Try again, or close CartScout and open it again.';

/** The signed-in session's token, or null when signed out. Throws one friendly sentence, never Chrome's own error text. */
export async function getClerkToken({ fresh = false } = {}) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'cartscout:get-session', fresh });
  } catch {
    // "Could not establish connection. Receiving end does not exist." means the service worker is not answering.
    throw new Error(SYNC_PROBLEM);
  }
  if (!response) throw new Error(SYNC_PROBLEM);
  if (response.error) throw new Error(typeof response.error === 'string' ? response.error : SYNC_PROBLEM);
  return typeof response.token === 'string' && response.token ? response.token : null;
}

/** The user id inside a session token, read without trusting it for anything but picking a local cache. */
export function tokenUser(token) {
  try {
    const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof claims.sub === 'string' && claims.sub ? claims.sub : null;
  } catch {
    return null;
  }
}

export async function openAccountPortal(intent) {
  const page = new URL('/', PORTAL_ORIGIN);
  page.searchParams.set('intent', intent);
  await chrome.tabs.create({ url: page.href });
}
