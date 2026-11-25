import { createClerkClient } from '@clerk/chrome-extension/client';
import { CLERK_PUBLISHABLE_KEY, CLERK_SYNC_ORIGIN } from './config.js';

let clerkClient;

async function sessionToken(fresh) {
  if (!CLERK_PUBLISHABLE_KEY) throw new Error('Build CartScout with a Clerk publishable key.');
  if (fresh || !clerkClient) {
    const pending = createClerkClient({
      publishableKey: CLERK_PUBLISHABLE_KEY,
      syncHost: CLERK_SYNC_ORIGIN,
      background: true,
    });
    clerkClient = pending;
    try {
      await pending;
    } catch (error) {
      if (clerkClient === pending) clerkClient = undefined;
      throw error;
    }
  }
  const clerk = await clerkClient;
  return await clerk.session?.getToken({ skipCache: fresh }) ?? null;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'cartscout:get-session' || sender.id !== chrome.runtime.id
    || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  void (async () => {
    try {
      respond({ token: await sessionToken(message.fresh === true) });
    } catch {
      respond({ error: 'Couldn’t sync Clerk sign-in. Open your CartScout account and try again.' });
    }
  })();
  return true;
});
