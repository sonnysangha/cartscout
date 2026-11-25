import { API_ORIGIN } from './config.js';
import { runMyproteinCoupons } from './myprotein.js';

const status = document.querySelector('#status');
const list = document.querySelector('#coupons');
const retry = document.querySelector('#retry');
const template = document.querySelector('#coupon');
const checkout = document.querySelector('#checkout');
const tryCodes = document.querySelector('#try-codes');
const checkoutStatus = document.querySelector('#checkout-status');
const pounds = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
let basketTab;
let checkoutCodes = [];
let merchant;
let token;

async function installationToken() {
  return navigator.locks.request('cartscout-installation', async () => {
    const { installToken } = await chrome.storage.local.get('installToken');
    if (installToken) return installToken;
    const generated = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, '0')).join('');
    await chrome.storage.local.set({ installToken: generated });
    return generated;
  });
}

async function api(route, fields) {
  let response;
  try {
    response = await fetch(new URL(route, API_ORIGIN), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ merchant, ...fields }),
      signal: AbortSignal.timeout(75_000),
    });
  } catch {
    throw new Error('Couldn’t reach CartScout. Try again shortly.');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'CartScout request failed.');
  return data;
}

function render(data, savedReport) {
  const label = data.coupons.length === 1 ? '1 candidate code' : `${data.coupons.length} candidate codes`;
  const context = data.source === 'stale' ? 'Refresh unavailable. Showing previously found codes.'
    : data.partial ? 'Some coupon sources could not be checked.' : '';
  status.textContent = [
    savedReport ? 'Report saved.' : '',
    data.coupons.length ? label : 'No codes found for this shop.',
    context,
  ].filter(Boolean).join(' ');
  checkoutCodes = data.coupons.map(({ code }) => code);
  checkout.hidden = !basketTab || !checkoutCodes.length;
  list.replaceChildren();
  for (const coupon of data.coupons) {
    const row = template.content.firstElementChild.cloneNode(true);
    row.querySelector('.code').textContent = coupon.code;
    row.querySelector('.offer').textContent = coupon.offer;
    row.querySelector('.counts').textContent = coupon.worked || coupon.failed
      ? `${coupon.worked} worked · ${coupon.failed} failed` : 'No recent reports';
    const source = row.querySelector('.source');
    if (coupon.sources[0]) source.href = coupon.sources[0];
    else source.hidden = true;

    const copy = row.querySelector('.copy');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(coupon.code);
        copy.textContent = 'Copied';
      } catch {
        status.textContent = 'Couldn’t copy. You can select the code above.';
      }
    });

    const votes = [row.querySelector('.worked'), row.querySelector('.failed')];
    votes.forEach((button, index) => {
      const worked = index === 0;
      button.setAttribute('aria-pressed', String(coupon.myReport === Number(worked)));
      button.addEventListener('click', async () => {
        const allVotes = list.querySelectorAll('.votes button');
        allVotes.forEach((vote) => { vote.disabled = true; });
        try {
          render(await api('/v1/reports', { code: coupon.code, worked }), true);
          const refreshedRow = Array.from(list.children).find((item) => item.querySelector('.code').textContent === coupon.code);
          refreshedRow?.querySelector(worked ? '.worked' : '.failed')?.focus();
        } catch (error) {
          status.textContent = error.message;
          allVotes.forEach((vote) => { vote.disabled = false; });
        }
      });
    });
    list.append(row);
  }
}

async function loadCoupons() {
  retry.hidden = true;
  status.textContent = 'Looking for coupon codes…';
  try {
    render(await api('/v1/coupons'));
  } catch (error) {
    status.textContent = error.message;
    retry.hidden = false;
  }
}

async function checkoutTrial(codes) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: basketTab }, func: runMyproteinCoupons, args: [codes],
  });
  return injection?.result;
}

async function showCheckout(result) {
  tryCodes.disabled = result?.state === 'running';
  const messages = {
    idle: '',
    running: `Trying checkout codes… ${result?.attempted ?? 0} of ${result?.total ?? 0}`,
    saved: `${result?.code} applied. Basket subtotal fell from ${pounds.format(result?.before / 100)} to ${pounds.format(result?.after / 100)}.`,
    noMatch: `Myprotein rejected all ${result?.attempted} attempted codes for this basket.`,
    accepted: `Myprotein accepted ${result?.code}. CartScout couldn’t confirm a lower subtotal.`,
    alreadyApplied: 'Your basket already has a promo code applied.',
    inputOccupied: 'Clear the discount field before trying codes.',
    unavailable: 'Open a Myprotein UK basket with an item and a discount field.',
    unsupported: 'Open your Myprotein UK basket to try codes.',
    changed: 'The basket changed. Check it before trying again.',
    unknown: `Myprotein’s response to ${result?.code || 'the code'} was unclear. Check your basket before trying again.`,
  };
  checkoutStatus.textContent = messages[result?.state] ?? messages.unavailable;
  if (result?.state === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await showCheckout(await checkoutTrial(null));
  }
}

async function refreshCheckout(codes) {
  try {
    await showCheckout(await checkoutTrial(codes));
  } catch {
    tryCodes.disabled = false;
    checkoutStatus.textContent = 'Couldn’t read the basket. Reopen CartScout and try again.';
  }
}

tryCodes.addEventListener('click', async () => {
  tryCodes.disabled = true;
  checkoutStatus.textContent = 'Trying checkout codes…';
  await refreshCheckout(checkoutCodes);
});

retry.addEventListener('click', loadCoupons);

try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ? new URL(tab.url) : null;
  if (!url || !['https:', 'http:'].includes(url.protocol)) {
    status.textContent = 'Open a shop in the current tab to find coupon codes.';
  } else {
    merchant = url.hostname.replace(/^www\./, '');
    document.querySelector('#merchant').textContent = merchant;
    if (tab.id && merchant === 'myprotein.com' && url.protocol === 'https:' && /^\/basket\/?$/.test(url.pathname)) {
      basketTab = tab.id;
    }
    token = await installationToken();
    await loadCoupons();
    if (basketTab && checkoutCodes.length) await refreshCheckout(null);
  }
} catch {
  status.textContent = 'Couldn’t read the current shop. Reopen CartScout to retry.';
}
