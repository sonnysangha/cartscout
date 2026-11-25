import { API_ORIGIN } from './config.js';
import { readMyproteinBasket, runMyproteinCoupons } from './myprotein.js';
import { basketLimit, markets, suggestMarket } from './markets.js';

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

const alternatives = document.querySelector('#alternatives');
const marketsInput = document.querySelector('#market');
const findAlternatives = document.querySelector('#find-alternatives');
const alternativesStatus = document.querySelector('#alternatives-status');
const offerResults = document.querySelector('#alternative-results');

async function showMarketPicker() {
  const { shoppingCountry } = await chrome.storage.local.get('shoppingCountry');
  const suggested = suggestMarket(Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.languages);
  for (const [code, [label]] of Object.entries(markets)) marketsInput.add(new Option(label, code));
  marketsInput.value = Object.hasOwn(markets, shoppingCountry) ? shoppingCountry : suggested;
  alternatives.hidden = false;
}

function renderOffers(results) {
  const matchLabel = { exact: 'Exact variant', different_variant: 'Different variant', unconfirmed: 'Variant unconfirmed' };
  for (const { name, variant, offers, partial, error } of results) {
    const group = document.createElement('section');
    const heading = document.createElement('h2');
    heading.textContent = [name, variant].filter(Boolean).join(' · ');
    group.append(heading);
    if (!offers.length || partial || error) {
      const note = document.createElement('p');
      note.textContent = error ?? (!offers.length
        ? 'No priced retailer offers found in this market.'
        : 'Some retailer pages could not be checked.');
      group.append(note);
    }
    const rows = document.createElement('ul');
    for (const offer of offers) {
      const row = document.createElement('li');
      const link = document.createElement('a');
      link.href = offer.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      const price = new Intl.NumberFormat(navigator.language, {
        style: 'currency', currency: offer.currency, currencyDisplay: 'code',
      }).format(offer.price);
      link.textContent = `${offer.retailer} · ${price}`;
      const detail = document.createElement('p');
      detail.textContent = [
        matchLabel[offer.match], offer.variant, offer.availability === 'in_stock'
          ? 'Listed in stock' : 'Stock unconfirmed',
      ].filter(Boolean).join(' · ');
      row.append(link, detail);
      rows.append(row);
    }
    group.append(rows);
    offerResults.append(group);
  }
}

findAlternatives.addEventListener('click', async () => {
  offerResults.replaceChildren();
  findAlternatives.disabled = true;
  marketsInput.disabled = true;
  const country = marketsInput.value;
  const [market] = markets[country];
  alternativesStatus.textContent = `Checking retailers in ${market}…`;
  try {
    await chrome.storage.local.set({ shoppingCountry: country });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: basketTab }, func: readMyproteinBasket,
    });
    const items = injection?.result ?? [];
    if (!items.length) {
      alternativesStatus.textContent = 'Add a product to your Myprotein basket to compare retailers.';
      return;
    }
    const { results } = await api('/v1/alternatives', { country, items: items.slice(0, basketLimit) });
    alternativesStatus.textContent = [
      `${market} · ${results.length} of ${items.length} basket products checked.`,
      'Check delivery to your address on the retailer’s site.',
    ].join(' ');
    renderOffers(results);
  } catch (error) {
    alternativesStatus.textContent = error.message;
  } finally {
    findAlternatives.disabled = false;
    marketsInput.disabled = false;
  }
});

marketsInput.addEventListener('change', () => {
  offerResults.replaceChildren();
  alternativesStatus.textContent = '';
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
    if (basketTab) await showMarketPicker();
    await loadCoupons();
    if (basketTab && checkoutCodes.length) await refreshCheckout(null);
  }
} catch {
  status.textContent = 'Couldn’t read the current shop. Reopen CartScout to retry.';
}
