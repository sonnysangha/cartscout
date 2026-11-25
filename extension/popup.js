import { API_ORIGIN } from './config.js';
import { readMyproteinBasket, runMyproteinCoupons } from './myprotein.js';
import { basketLimit, markets, suggestMarket } from './markets.js';

const element = (id) => document.getElementById(id);
const status = element('status');
const list = element('coupons');
const retry = element('retry');
const checkout = element('checkout');
const tryCodes = element('try-codes');
const stopCodes = element('stop-codes');
const progress = element('checkout-progress');
const checkoutStatus = element('checkout-status');
const checkoutSavings = element('checkout-savings');
const marketInput = element('market');
const findAlternatives = element('find-alternatives');
const alternativesStatus = element('alternatives-status');
const offerResults = element('alternative-results');
const moreAlternatives = element('more-alternatives');
let alternativeSearch;
const pounds = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });

let merchant;
let basketTab;
let token;
let checkoutCodes = [];
let checkoutResult;
let checkoutPoll;

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

function externalLink(url, label) {
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = label;
  return link;
}

function renderTrialResults() {
  for (const row of list.children) {
    const result = row.querySelector('.trial-result');
    const code = row.dataset.code;
    const applied = ['saved', 'accepted'].includes(checkoutResult?.state) && checkoutResult.code === code;
    const rejected = checkoutResult?.rejected?.includes(code);
    result.textContent = applied ? 'Applied to this basket' : rejected ? 'Rejected for this basket' : '';
    result.hidden = !applied && !rejected;
  }
}

function renderCoupons(data, savedReport) {
  checkoutCodes = data.coupons.map(({ code }) => code);
  const count = checkoutCodes.length;
  const label = count === 1 ? '1 candidate code' : `${count} candidate codes`;
  const context = data.source === 'stale' ? 'Showing previously discovered codes.'
    : data.partial ? 'Some coupon sources couldn’t be checked.' : '';
  status.textContent = [savedReport ? 'Report saved.' : '', count ? label : 'No public codes found.', context]
    .filter(Boolean).join(' ');
  element('coupon-summary').hidden = count === 0;
  element('freshness').textContent = data.source === 'cache' ? 'Shared cache' : data.source === 'stale' ? 'Earlier results' : 'Checked just now';
  const empty = element('coupon-empty');
  empty.hidden = count !== 0;
  empty.textContent = 'CartScout looks for full codes published by the shop or a coupon source.';
  checkout.hidden = !basketTab || (!count && !checkoutResult);
  if (checkoutResult?.state !== 'running') tryCodes.disabled = !count;
  list.replaceChildren();

  for (const coupon of data.coupons) {
    const row = element('coupon').content.firstElementChild.cloneNode(true);
    row.dataset.code = coupon.code;
    row.querySelector('.code').textContent = coupon.code;
    row.querySelector('.offer').textContent = coupon.offer;
    row.querySelector('.counts').textContent = coupon.worked || coupon.failed
      ? `${coupon.worked} worked · ${coupon.failed} failed` : 'No recent reports';
    const sources = row.querySelector('.sources');
    for (const url of coupon.sources) {
      sources.append(externalLink(url, new URL(url).hostname.replace(/^www\./, '')));
    }

    const copy = row.querySelector('.copy');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(coupon.code);
        copy.textContent = 'Copied';
      } catch {
        status.textContent = 'Couldn’t copy. You can select the code above.';
      }
    });

    for (const [selector, worked] of [['.worked', true], ['.failed', false]]) {
      const button = row.querySelector(selector);
      button.setAttribute('aria-pressed', String(coupon.myReport === Number(worked)));
      button.addEventListener('click', async () => {
        const votes = list.querySelectorAll('.votes button');
        votes.forEach((vote) => { vote.disabled = true; });
        try {
          renderCoupons(await api('/v1/reports', { code: coupon.code, worked }), true);
          const refreshed = [...list.children].find((item) => item.dataset.code === coupon.code);
          refreshed?.querySelector(selector)?.focus();
        } catch (error) {
          status.textContent = error.message;
          votes.forEach((vote) => { vote.disabled = false; });
        }
      });
    }
    list.append(row);
  }
  renderTrialResults();
}

async function loadCoupons() {
  retry.hidden = true;
  status.textContent = 'Looking for coupon codes…';
  try {
    renderCoupons(await api('/v1/coupons'));
  } catch (error) {
    status.textContent = error.message;
    retry.hidden = false;
  }
}

function renderCheckout(result) {
  if (!result || result.state === 'idle') return;
  checkoutResult = result;
  checkout.hidden = false;
  const running = result.state === 'running';
  tryCodes.disabled = running || !checkoutCodes.length;
  tryCodes.hidden = ['saved', 'accepted', 'alreadyApplied'].includes(result.state);
  progress.hidden = !running;
  stopCodes.hidden = !running;
  stopCodes.disabled = !!result.stopRequested;
  if (running) {
    progress.max = result.total;
    progress.value = result.attempted;
  }
  checkoutSavings.hidden = result.state !== 'saved';
  if (result.state === 'saved') {
    checkoutSavings.textContent = `Saved ${pounds.format((result.before - result.after) / 100)}`;
  }
  const messages = {
    running: result.stopRequested ? 'Finishing the current attempt…'
      : `Trying code ${result.attempted} of ${result.total}${result.code ? ` · ${result.code}` : ''}`,
    saved: `${result.code} applied · ${pounds.format(result.before / 100)} → ${pounds.format(result.after / 100)}`,
    noMatch: `Myprotein rejected all ${result.attempted} attempted codes for this basket.`,
    accepted: `Myprotein accepted ${result.code}. A lower subtotal couldn’t be confirmed.`,
    alreadyApplied: 'Your basket already has a promo code applied.',
    inputOccupied: 'Clear the discount field before trying codes.',
    unavailable: 'Add an item to your Myprotein basket to try codes.',
    unsupported: 'Open your Myprotein UK basket to try codes.',
    changed: 'The basket changed. Check it before trying again.',
    stopped: 'Stopped after the current attempt.',
    unknown: `Myprotein’s response to ${result.code || 'the code'} was unclear. Check your basket before trying again.`,
  };
  checkoutStatus.textContent = messages[result.state] ?? '';
  renderTrialResults();
}

async function refreshCheckout(command = null) {
  clearTimeout(checkoutPoll);
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: basketTab }, func: runMyproteinCoupons, args: [command, true],
    });
    renderCheckout(injection?.result);
    if (injection?.result?.state === 'running') checkoutPoll = setTimeout(refreshCheckout, 300);
  } catch {
    tryCodes.disabled = !checkoutCodes.length;
    stopCodes.hidden = progress.hidden = true;
    checkoutStatus.textContent = 'Couldn’t read the basket. Reopen CartScout and try again.';
  }
}

tryCodes.addEventListener('click', async () => {
  tryCodes.disabled = true;
  checkoutStatus.textContent = 'Preparing to try codes…';
  await refreshCheckout(checkoutCodes);
});
stopCodes.addEventListener('click', async () => {
  stopCodes.disabled = true;
  await refreshCheckout('stop');
});
retry.addEventListener('click', loadCoupons);

function switchView(showAlternatives) {
  element('show-coupons').setAttribute('aria-pressed', String(!showAlternatives));
  element('show-alternatives').setAttribute('aria-pressed', String(showAlternatives));
  element('coupon-view').hidden = showAlternatives;
  element('alternatives').hidden = !showAlternatives;
}

element('show-coupons').addEventListener('click', () => switchView(false));
element('show-alternatives').addEventListener('click', () => switchView(true));

async function activateBasketTools() {
  const { shoppingCountry } = await chrome.storage.local.get('shoppingCountry');
  const suggested = suggestMarket(Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.languages);
  for (const [code, [label]] of Object.entries(markets)) marketInput.add(new Option(label, code));
  marketInput.value = Object.hasOwn(markets, shoppingCountry) ? shoppingCountry : suggested;
  element('views').hidden = element('basket-marker').hidden = false;
  await refreshCheckout();
}

function renderOffers(results) {
  const matchLabel = { exact: 'Exact variant', different_variant: 'Different variant', unconfirmed: 'Variant unconfirmed' };
  for (const { name, variant, offers, partial, error } of results) {
    const group = document.createElement('section');
    const heading = document.createElement('h2');
    heading.textContent = name;
    group.append(heading);
    if (variant) {
      const requested = document.createElement('p');
      requested.className = 'variant';
      requested.textContent = variant;
      group.append(requested);
    }
    if (!offers.length || partial || error) {
      const note = document.createElement('p');
      note.className = 'empty';
      note.textContent = error ?? (!offers.length
        ? 'No priced retailer offers found in this market.'
        : 'Some retailer pages couldn’t be checked.');
      group.append(note);
    }
    const rows = document.createElement('ul');
    for (const offer of offers) {
      const row = document.createElement('li');
      const price = new Intl.NumberFormat(navigator.language, {
        style: 'currency', currency: offer.currency, currencyDisplay: 'code',
      }).format(offer.price);
      const title = document.createElement('p');
      title.textContent = offer.title;
      const detail = document.createElement('p');
      detail.className = 'offer-details';
      detail.textContent = [
        matchLabel[offer.match], offer.variant,
        offer.availability === 'in_stock' ? 'Listed in stock' : 'Stock unconfirmed',
      ].filter(Boolean).join(' · ');
      row.append(externalLink(offer.url, `${offer.retailer} · ${price}`), title, detail);
      rows.append(row);
    }
    group.append(rows);
    offerResults.append(group);
  }
}

async function checkAlternativeBatch(startNewSearch) {
  findAlternatives.disabled = marketInput.disabled = moreAlternatives.disabled = true;
  const country = marketInput.value;
  const [market] = markets[country];
  alternativesStatus.textContent = `Checking retailers in ${market}…`;
  try {
    if (startNewSearch) {
      offerResults.replaceChildren();
      moreAlternatives.hidden = true;
      alternativeSearch = undefined;
      await chrome.storage.local.set({ shoppingCountry: country });
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: basketTab }, func: readMyproteinBasket,
      });
      const items = injection?.result ?? [];
      if (!items.length) {
        alternativesStatus.textContent = 'Add a product to your Myprotein basket to compare retailers.';
        return;
      }
      alternativeSearch = { country, items, checked: 0 };
    }

    const search = alternativeSearch;
    const items = search.items.slice(search.checked, search.checked + basketLimit);
    const { results } = await api('/v1/alternatives', { country: search.country, items });
    search.checked += results.length;
    alternativesStatus.textContent = `${market} · ${search.checked} of ${search.items.length} basket products checked. Check delivery with the retailer.`;
    renderOffers(results);
    moreAlternatives.hidden = search.checked >= search.items.length;
  } catch (error) {
    alternativesStatus.textContent = error.message;
  } finally {
    findAlternatives.disabled = marketInput.disabled = moreAlternatives.disabled = false;
  }
}

findAlternatives.addEventListener('click', () => checkAlternativeBatch(true));
moreAlternatives.addEventListener('click', () => checkAlternativeBatch(false));
marketInput.addEventListener('change', () => {
  alternativeSearch = undefined;
  moreAlternatives.hidden = true;
  offerResults.replaceChildren();
  alternativesStatus.textContent = '';
});

try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ? new URL(tab.url) : null;
  if (!url || !['https:', 'http:'].includes(url.protocol)) {
    status.textContent = 'Open a shop in the current tab to find coupon codes.';
  } else {
    merchant = url.hostname.replace(/^www\./, '');
    element('merchant').textContent = merchant;
    if (tab.id && merchant === 'myprotein.com' && url.protocol === 'https:' && /^\/basket\/?$/.test(url.pathname)) {
      basketTab = tab.id;
    }
    token = await installationToken();
    await Promise.all([loadCoupons(), basketTab ? activateBasketTools() : undefined]);
  }
} catch {
  status.textContent = 'Couldn’t read the current shop. Reopen CartScout to retry.';
}
