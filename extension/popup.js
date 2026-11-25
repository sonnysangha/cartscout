import { createRetailerOffer } from './presentation.js';
import { getClerkToken, openAccountPortal } from './account.js';
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
let accountReady = false;
let account;
let lastCacheOnly;
let checkoutCodes = [];
let checkoutResult;
let checkoutPoll;
let scanExhausted = false;
let copiedCouponKey;
const copiedCodes = new Set();

const accountAction = element('account-action');
const accountRefresh = element('account-refresh');
const scanButton = element('scan-store');

function renderAccount(next) {
  account = next;
  const pro = account?.plan === 'pro';
  // The stylesheet lays the account out per state: a sign-in card, or a quiet plan line.
  document.body.dataset.account = !account ? 'signedout' : pro ? 'pro' : 'free';
  element('account-plan').textContent = account ? (pro ? 'Pro' : 'Free') : '';
  element('account-detail').textContent = !account ? 'Not signed in'
    : pro ? 'Unlimited store scans'
    : `${account.scans?.remaining ?? 0} of ${account.scans?.limit ?? 5} weekly scans left`;
  // One salient call to action per state: signing in, or upgrading once scans run out.
  const salient = !account || (!pro && scanExhausted);
  accountAction.textContent = !account ? 'Sign in' : pro ? 'Manage plan' : salient ? 'Upgrade to Pro' : 'Upgrade';
  accountAction.className = salient ? 'primary' : 'quiet';
  accountAction.hidden = false;
  accountRefresh.hidden = !accountReady;
}

async function api(route, fields, { sessionToken } = {}) {
  const token = sessionToken ?? await getClerkToken();
  if (!token) throw new Error('Sign in to use CartScout.');
  let response;
  try {
    const isAccount = route === '/v1/account';
    response = await fetch(new URL(route, API_ORIGIN), {
      method: isAccount ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: isAccount ? undefined : JSON.stringify({ merchant, ...fields }),
      signal: AbortSignal.timeout(75_000),
    });
  } catch {
    throw new Error('Couldn’t reach CartScout. Try again shortly.');
  }
  const data = await response.json();
  if (data.account) renderAccount(data.account);
  if (response.status === 401) {
    clearShoppingData();
    renderAccount(null);
  }
  if (!response.ok) throw Object.assign(new Error(data.error ?? 'CartScout request failed.'), {
    code: data.code, status: response.status,
  });
  return data;
}

function renderTrialResults() {
  for (const row of list.children) {
    const result = row.querySelector('.trial-result');
    const code = row.dataset.code;
    const applied = ['saved', 'accepted'].includes(checkoutResult?.state) && checkoutResult.code === code;
    const rejected = checkoutResult?.rejected?.includes(code);
    result.textContent = applied ? 'Applied to this basket' : rejected ? 'Rejected for this basket' : '';
    result.hidden = !applied && !rejected;
    row.dataset.trialState = applied ? 'applied' : rejected ? 'rejected' : '';
  }
}

function renderCoupons(data) {
  checkoutCodes = data.coupons.map(({ code }) => code);
  const count = checkoutCodes.length;
  const label = count === 1 ? '1 possible code' : `${count} possible codes`;
  const freshness = data.source === 'cache' ? (account?.plan === 'pro' ? 'found in previous scans' : 'from your saved scan')
    : data.source === 'stale' ? 'earlier results' : 'checked just now';
  const context = data.partial ? 'Some coupon sources couldn’t be checked.' : '';
  status.textContent = [count ? `${label} · ${freshness}.` : 'No public codes found.', context]
    .filter(Boolean).join(' ');
  if (scanExhausted) {
    scanExhausted = false;
    renderAccount(account);
  }
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
    const offer = row.querySelector('.offer');
    offer.id = `coupon-offer-${list.children.length}`;
    offer.textContent = coupon.offer;
    row.querySelector('.votes').setAttribute('aria-label', `Did ${coupon.code} work?`);
    const reported = coupon.myReport === 0 || coupon.myReport === 1;
    if (reported) row.querySelector('.votes-label').textContent = 'Report saved';
    const ticketArea = row.querySelector('.coupon-main');
    const reportPanel = row.querySelector('.report-panel');
    const revealReport = () => {
      ticketArea.dataset.reportReady = '';
      reportPanel.inert = false;
    };
    if (copiedCodes.has(coupon.code) || reported) revealReport();

    const copy = row.querySelector('.coupon-ticket');
    const feedback = row.querySelector('.copy-feedback');
    let copyTimeout;
    copy.setAttribute('aria-label', `Copy ${coupon.code}`);
    if (offer.textContent) copy.setAttribute('aria-describedby', offer.id);
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(coupon.code);
      } catch {
        status.textContent = 'Couldn’t copy. Try again.';
        return;
      }
      if (!row.isConnected) return;
      copiedCodes.add(coupon.code);
      if (copiedCouponKey) {
        void chrome.storage.session?.set({ [copiedCouponKey]: [...copiedCodes].slice(-24) }).catch(() => {});
      }
      revealReport();
      copy.setAttribute('data-copied', '');
      feedback.textContent = `Copied ${coupon.code}. You can now report whether it worked.`;
      clearTimeout(copyTimeout);
      copyTimeout = setTimeout(() => {
        copy.removeAttribute('data-copied');
        feedback.textContent = '';
      }, 1600);
    });

    for (const [selector, worked] of [['.worked', true], ['.failed', false]]) {
      const button = row.querySelector(selector);
      button.setAttribute('aria-pressed', String(coupon.myReport === Number(worked)));
      button.addEventListener('click', async () => {
        const votes = list.querySelectorAll('.votes button');
        votes.forEach((vote) => { vote.disabled = true; });
        try {
          renderCoupons(await api('/v1/reports', { code: coupon.code, worked }));
          element('report-status').textContent = `Report saved for ${coupon.code}. You answered ${worked ? 'yes' : 'no'}.`;
          const refreshed = [...list.children].find((item) => item.dataset.code === coupon.code);
          refreshed?.querySelector(selector)?.focus({ preventScroll: true });
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

async function loadCoupons(cacheOnly = account?.plan === 'free') {
  lastCacheOnly = cacheOnly;
  retry.hidden = scanButton.hidden = true;
  status.textContent = cacheOnly ? 'Checking your saved codes…' : 'Looking for coupon codes…';
  const view = element('coupon-view');
  view.setAttribute('aria-busy', 'true');
  try {
    renderCoupons(await api('/v1/coupons', { cacheOnly }));
  } catch (error) {
    const empty = element('coupon-empty');
    if (error.code === 'scan_required' || error.code === 'scan_limit') {
      const exhausted = error.code === 'scan_limit' || !account?.scans?.remaining;
      status.textContent = exhausted ? 'Weekly scan limit reached' : 'Ready to scan this store';
      empty.textContent = exhausted
        ? 'Your saved scans are still available. Upgrade for unlimited store scans and codes CartScout has already found.'
        : 'Scanning uses one weekly scan. Results are saved privately to your account.';
      empty.hidden = false;
      scanButton.hidden = exhausted;
      scanExhausted = exhausted;
      renderAccount(account);
    } else {
      status.textContent = error.message;
      retry.hidden = false;
    }
  } finally {
    view.removeAttribute('aria-busy');
  }
}

scanButton.addEventListener('click', () => loadCoupons(false));

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
    element('saved-amount').textContent = pounds.format((result.before - result.after) / 100);
    element('saved-code').textContent = result.code;
    element('saved-before').textContent = pounds.format(result.before / 100);
    element('saved-after').textContent = pounds.format(result.after / 100);
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
retry.addEventListener('click', () => loadCoupons(lastCacheOnly));

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
  if (!marketInput.options.length) {
    for (const [code, [label]] of Object.entries(markets)) marketInput.add(new Option(label, code));
  }
  marketInput.value = Object.hasOwn(markets, shoppingCountry) ? shoppingCountry : suggested;
  element('views').hidden = element('basket-marker').hidden = false;
  await refreshCheckout();
}

function renderOffers(results) {
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
    for (const offer of offers) rows.append(createRetailerOffer(offer));
    group.append(rows);
    offerResults.append(group);
  }
}

async function checkAlternativeBatch(startNewSearch) {
  findAlternatives.disabled = marketInput.disabled = moreAlternatives.disabled = true;
  const country = marketInput.value;
  const [market] = markets[country];
  alternativesStatus.textContent = `Checking retailers in ${market}…`;
  element('alternatives').setAttribute('aria-busy', 'true');
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
    element('alternatives').removeAttribute('aria-busy');
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

function clearShoppingData() {
  clearTimeout(checkoutPoll);
  copiedCouponKey = undefined;
  copiedCodes.clear();
  checkoutResult = undefined;
  checkoutCodes = [];
  checkout.hidden = true;
  list.replaceChildren();
  scanButton.hidden = retry.hidden = true;
  element('coupon-empty').hidden = true;
  scanExhausted = false;
  element('views').hidden = element('basket-marker').hidden = true;
  alternativeSearch = undefined;
  offerResults.replaceChildren();
  alternativesStatus.textContent = '';
  moreAlternatives.hidden = true;
  switchView(false);
}

async function refreshAccount() {
  accountRefresh.disabled = accountAction.disabled = true;
  accountRefresh.hidden = false;
  try {
    const token = await getClerkToken({ fresh: true });
    accountReady = true;
    if (!token) {
      clearShoppingData();
      renderAccount(null);
      status.textContent = 'Sign in to search for savings.';
      return;
    }

    const previous = account;
    const current = await api('/v1/account', undefined, { sessionToken: token });
    if (previous && (previous.userId !== current.userId || previous.plan !== current.plan)) {
      clearShoppingData();
    }
    renderAccount(current);
    if (merchant) {
      const key = `copiedCoupons:${current.userId}:${merchant}`;
      if (copiedCouponKey !== key) {
        copiedCouponKey = key;
        const stored = await chrome.storage.session?.get(key).catch(() => undefined);
        if (copiedCouponKey === key && Array.isArray(stored?.[key])) {
          for (const code of stored[key]) copiedCodes.add(code);
        }
      }
      await Promise.all([
        loadCoupons(),
        basketTab && element('views').hidden ? activateBasketTools() : undefined,
      ]);
    } else {
      status.textContent = 'Open a store to find coupon codes.';
    }
  } catch (error) {
    status.textContent = error.message;
    if (!account) renderAccount(null);
  } finally {
    accountRefresh.disabled = accountAction.disabled = false;
  }
}

accountAction.addEventListener('click', async () => {
  try {
    await openAccountPortal(account ? 'billing' : 'signin');
  } catch {
    status.textContent = 'Couldn’t open your CartScout account.';
  }
});
accountRefresh.addEventListener('click', refreshAccount);

try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ? new URL(tab.url) : null;
  if (url && ['https:', 'http:'].includes(url.protocol)) {
    merchant = url.hostname.replace(/^www\./, '');
    element('merchant').textContent = merchant;
    if (tab.id && merchant === 'myprotein.com' && url.protocol === 'https:' && /^\/basket\/?$/.test(url.pathname)) {
      basketTab = tab.id;
    }
  }
  await refreshAccount();
} catch (error) {
  status.textContent = error.message || 'Couldn’t start CartScout.';
  accountAction.hidden = false;
  accountAction.textContent = 'Open account';
}
