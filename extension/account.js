import { PORTAL_ORIGIN } from './config.js';

export async function getClerkToken({ fresh = false } = {}) {
  const response = await chrome.runtime.sendMessage({ type: 'cartscout:get-session', fresh });
  if (!response) throw new Error('Couldn’t connect to CartScout sign-in.');
  if (response.error) throw new Error(response.error);
  return response.token ?? null;
}

export async function openAccountPortal(intent) {
  const page = new URL('/', PORTAL_ORIGIN);
  page.searchParams.set('intent', intent);
  await chrome.tabs.create({ url: page.href });
}
