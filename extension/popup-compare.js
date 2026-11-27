// "Other retailers": the price of a product at other shops.
// Runs asynchronously in the service worker (compare-worker.js) and mirrors state from chrome.storage.session,
// so the shopper can close the popup while Scout checks other retailers and see the results when they come back.

import { compareKey, COMPARE_PER_PRESS } from './compare-worker.js';
import { createOfferGroup, currencyMismatch, money, priceDifference, usablePrice } from './presentation.js';
import { readPageBasket } from './basket.js';
import { readMyproteinBasket } from './myprotein.js';
import { readPageProduct } from './product.js';
import { marketFor, markets } from './markets.js';
import { mountScout, setMood } from './scout.js';
import { prefersReducedMotion } from './confetti.js';
import { dealIn, drawSwipe, stickOn } from './motion.js';
import { createSkeletons } from './popup-ticket.js';
import { alertPermission, canEnablePriceAlerts, priceAlertSite } from './price-alerts.js';

const SHORT = { GB: 'UK', AE: 'UAE' };
const MIN_QUERY = 3;
const PER_PRESS = COMPARE_PER_PRESS;
const CHOICE = 'compareCountry';
const clean = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
const plural = (count, one, many) => (count === 1 ? `1 ${one}` : `${count} ${many}`);

export function createCompare({ root, page, send, session, look, skeleton, signedIn, savingButton, openAlternatives }) {
  const find = (selector) => root.querySelector(selector);
  const form = find('#compare-form');
  const query = find('#compare-query');
  const market = find('#market');
  const marketFace = find('#market-face');
  const submit = find('#find-alternatives');
  const message = find('#compare-message');
  const pageName = find('.page-name');
  const pagePrice = find('.page-price');
  const pageLabel = find('.page-label');
  const verdict = find('#verdict');
  const verdictAction = find('#verdict-action');
  const verdictScout = mountScout(find('#verdict-scout'), { mood: 'idle' });
  const results = find('#alternative-results');
  const moreRow = find('#more-row');
  const more = find('#more-alternatives');
  const moreStatus = find('#more-status');
  const alertSettings = find('#price-alerts');
  const alertToggle = find('#toggle-price-alerts');
  const alertStatus = find('#price-alert-status');
  const view = form.closest('.view') ?? root;
  // With results on screen each product carries the shopper's own price, so the page line steps aside (popup.css).
  const showResults = (on) => {
    if (on) view.dataset.phase = 'results';
    else delete view.dataset.phase;
  };
  const groupOptions = (item, country) => ({ own: item.own, where: SHORT[country] ?? country });

  const shop = page.shop && !!page.merchant;
  let product = null;
  let basketItems = [];
  let state = null;
  let renderedKey = '';
  let busy = false;
  let ready = false;
  let chosen = false;
  let action;
  let cachedSaving = null;
  let savingTimer;
  let preparation = 0;
  let edited = false;

  function setMarket(code) {
    if (!Object.hasOwn(markets, code) || market.value === code) return;
    market.value = code;
    marketFace.textContent = SHORT[code] ?? code;
  }
  const guessMarket = (currency) => marketFor({
    currency, host: page.host, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, languages: navigator.languages,
  });

  verdictAction.addEventListener('click', () => action?.());

  function tell(text, tone = '') {
    message.textContent = text;
    message.title = text;
    message.dataset.tone = tone;
  }

  function setVerdict({ mood = 'idle', title, text = '', next, tone = '' }) {
    setMood(verdictScout, mood);
    if (tone) verdict.dataset.tone = tone;
    else delete verdict.dataset.tone;
    const held = verdict.contains(document.activeElement);
    const copy = verdict.querySelector('.verdict-copy');
    const fresh = copy.cloneNode(true);
    const heading = fresh.querySelector('h2');
    const line = fresh.querySelector('p');
    heading.textContent = title;
    heading.title = title;
    line.textContent = text;
    line.title = text;
    copy.replaceWith(fresh);
    action = next?.run;
    verdictAction.hidden = !next;
    verdictAction.textContent = next?.label ?? '';
    if (held && (!next || document.activeElement === document.body)) (next ? verdictAction : heading).focus({ preventScroll: true });
    if (!prefersReducedMotion()) fresh.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
  }

  function setBusy(next) {
    busy = next;
    root.toggleAttribute('aria-busy', next);
    submit.setAttribute('aria-disabled', String(next));
    submit.querySelector('.swap').dataset.show = next ? '2' : '1';
    market.disabled = next;
  }

  const marketName = (code = market.value) => markets[code]?.[0] ?? 'this country';
  const isBasketPage = () => page.basket || page.probe?.pageKind === 'cart' || page.probe?.pageKind === 'checkout' || basketItems.length > 0;
  const basketMode = () => isBasketPage() && !clean(query.value);

  function showPage() {
    const hasBasket = isBasketPage();
    const singleBasket = basketItems.length === 1 ? basketItems[0] : null;
    const none = !shop ? 'This tab isn’t a shop page'
      : page.handed ? 'Click the CartScout icon to read this page'
        : hasBasket ? 'No items detected in your basket'
          : 'Scout didn’t spot a product here';
    pageLabel.hidden = !(basketItems.length || product);
    pageLabel.textContent = basketItems.length ? 'In your basket' : 'On this page';
    if (singleBasket) {
      pageName.textContent = singleBasket.name;
      pageName.title = [singleBasket.name, singleBasket.variant].filter(Boolean).join(' · ');
      pageName.classList.remove('quiet-text');
      const price = Number.isFinite(singleBasket.price) && singleBasket.currency ? money(singleBasket.price, singleBasket.currency) : '';
      pagePrice.textContent = price ? `${price} here` : '';
    } else if (basketItems.length > 1) {
      pageName.textContent = `${basketItems.length} basket items`;
      pageName.title = basketItems.map((item) => item.name).join(', ');
      pageName.classList.remove('quiet-text');
      pagePrice.textContent = '';
    } else {
      pageName.textContent = product?.name ?? none;
      pageName.title = pageName.textContent;
      pageName.classList.toggle('quiet-text', !product);
      const price = product && Number.isFinite(product.price) && product.currency ? money(product.price, product.currency) : '';
      pagePrice.textContent = price ? `${product.from ? 'from ' : ''}${price} here` : '';
    }
    query.placeholder = basketItems.length
      ? `Your basket (${plural(basketItems.length, 'item', 'items')})`
      : hasBasket ? 'Your basket' : 'e.g. Sony WH-1000XM5';
  }

  function intro() {
    showPage();
    tell(shop ? `Before delivery · ${marketName()}` : '');
    if (!shop) {
      setVerdict({
        title: 'Open a shop page',
        text: 'Visit a product or shop to compare prices.',
      });
    } else if (basketItems.length === 1) {
      setVerdict({
        title: 'Compare your basket',
        text: '1 item ready — click Compare prices, or type another product.',
      });
    } else if (basketItems.length > 1 || isBasketPage()) {
      setVerdict({
        title: 'Compare your basket',
        text: basketItems.length > 1
          ? `${basketItems.length} items spotted — checks 2 at a time, or type any product.`
          : 'Checks 2 items at a time, or type any product.',
      });
    } else if (product) {
      setVerdict({
        title: 'Cheaper elsewhere?',
        text: 'Checks this product at other retailers.',
      });
    } else {
      setVerdict({
        title: 'Compare any product',
        text: 'Type a product name to check other retailers.',
      });
    }
  }

  function clearResults({ remote = false } = {}) {
    state = null;
    renderedKey = '';
    results.replaceChildren();
    showResults(false);
    moreRow.hidden = true;
    moreStatus.textContent = '';
    delete moreStatus.dataset.tone;
    if (remote && page.tabId) void send({ type: 'cartscout:compare-clear' });
  }

  function clearSaving() {
    clearTimeout(savingTimer);
    cachedSaving = null;
    savingButton.hidden = true;
    if (state?.cached) applyState(null);
  }

  function showCachedComparison() {
    if (!cachedSaving || busy) return;
    const { country, result } = cachedSaving;
    query.value = result.name;
    applyState({
      cached: true, merchant: page.merchant, country, status: 'done', seen: true,
      checked: 1, found: [result], startedAt: result.fetchedAt,
    });
  }

  savingButton.addEventListener('click', () => {
    showCachedComparison();
    openAlternatives();
  });

  const site = shop && priceAlertSite(page.origin);
  const alertsAvailable = canEnablePriceAlerts(site, chrome.runtime.getManifest().host_permissions);
  let alertsEnabled = false;
  async function readAlertSetting() {
    alertsEnabled = await chrome.permissions.contains(alertPermission(site.origin));
    alertToggle.textContent = alertsEnabled ? 'Disable price alerts on this shop' : 'Enable price alerts on this shop';
    alertSettings.hidden = !signedIn();
  }

  alertToggle.addEventListener('click', async () => {
    if (!alertsAvailable) return;
    alertToggle.disabled = true;
    try {
      const permission = alertPermission(site.origin);
      if (alertsEnabled) await chrome.permissions.remove(permission);
      else await chrome.permissions.request(permission);
      await readAlertSetting();
      alertStatus.textContent = alertsEnabled
        ? 'Price alerts are on for this shop.'
        : 'Show a notice when Scout has a cached lower price.';
    } catch {
      alertStatus.textContent = 'Couldn’t change price alerts. Try again.';
    } finally {
      alertToggle.disabled = false;
    }
  });

  function ownPrice(name) {
    return product && product.name.toLowerCase() === name.toLowerCase() ? product : null;
  }

  function verdictFor(result, own) {
    const { offers = [], partial, error } = result;
    const retry = { label: 'Try again', run: () => run(true) };
    if (error) {
      return { mood: 'oops', title: 'Couldn’t check this one', text: 'The retailers didn’t answer. Give it a moment, then try again.', next: retry };
    }
    if (!offers.length) {
      return {
        mood: 'shrug',
        title: partial ? 'Nothing found this time' : 'No other retailers found',
        text: partial ? 'Some retailers didn’t answer. Compare again in a moment.' : 'Try a shorter product name, or another country.',
        next: partial ? retry : { label: 'Edit search', run: () => { query.focus(); query.select(); } },
      };
    }
    const here = usablePrice(own);
    const best = result.best;
    if (here && best) {
      const difference = priceDifference(best, here);
      return {
        mood: 'happy',
        title: `Save ${difference.diff} at ${best.retailer}`,
        text: `${money(best.price, best.currency)} vs ${money(here.price, here.currency)} here · in stock, before delivery.`,
      };
    }
    if (here) {
      const alike = offers
        .map((offer) => ({ offer, diff: priceDifference(offer, here) }))
        .filter(({ diff }) => !!diff);
      if (alike.some(({ diff }) => diff.tone === 'less')) {
        const lowest = alike.reduce((min, item) => (item.offer.price < min.offer.price ? item : min));
        return {
          mood: 'idle',
          title: `${lowest.diff.text} at ${lowest.offer.retailer}`,
          text: 'Stock isn’t confirmed — check the listing before switching.',
        };
      }
      if (alike.length) {
        const closest = alike.reduce((min, item) => (item.offer.price < min.offer.price ? item : min));
        if (closest.diff.tone === 'more') {
          return {
            mood: 'happy',
            title: `Cheaper here by ${closest.diff.diff}`,
            text: `Next lowest is ${money(closest.offer.price, closest.offer.currency)} at ${closest.offer.retailer}.`,
          };
        }
        return {
          mood: 'happy',
          title: 'Same as lowest price found',
          text: `Matched at ${closest.offer.retailer} (${money(closest.offer.price, closest.offer.currency)}).`,
        };
      }
      return { mood: 'idle', title: 'No exact match to compare', text: 'Listings are a different size, flavour, or currency.' };
    }
    return {
      mood: 'idle',
      title: `Found ${plural(offers.length, 'listing', 'listings')}`,
      text: own?.from ? 'This page shows a “from” price — compare with your size.'
        : 'Compare these against the price on this page.',
    };
  }

  function basketVerdict(all, checked, total) {
    const fallbackTitle = `Checked ${checked} of ${plural(total, 'basket item', 'basket items')}`;
    if (!all.some(({ offers }) => offers.length)) {
      return { mood: 'shrug', title: fallbackTitle, text: 'No priced offers found at other retailers.' };
    }
    const wins = all
      .filter(({ best, own }) => best && usablePrice(own))
      .map(({ best, own }) => ({ best, own, diff: priceDifference(best, own) }))
      .filter(({ diff }) => diff?.tone === 'less');
    if (wins.length === 1) {
      const [{ best, own, diff }] = wins;
      return {
        mood: 'happy',
        title: `Save ${diff.diff} at ${best.retailer}`,
        text: `${money(best.price, best.currency)} vs ${money(own.price, own.currency)} in your basket · before delivery.`,
      };
    }
    if (wins.length > 1) {
      const currency = wins[0].own.currency;
      const sameCurrency = wins.every(({ own }) => own.currency === currency);
      const totalSaved = wins.reduce((sum, { diff }) => sum + diff.amount, 0);
      return {
        mood: 'happy',
        title: sameCurrency ? `Save ${money(totalSaved, currency)} across ${wins.length} items` : `${wins.length} items cheaper elsewhere`,
        text: 'Same products, in stock. Check delivery before switching.',
      };
    }
    const alike = all.flatMap(({ offers, own }) => {
      const here = usablePrice(own);
      if (!here) return [];
      return offers.map((offer) => ({ offer, here, diff: priceDifference(offer, here) })).filter(({ diff }) => !!diff);
    });
    if (alike.some(({ diff }) => diff.tone === 'less')) {
      const lowest = alike.reduce((min, item) => (item.offer.price < min.offer.price ? item : min));
      return {
        mood: 'idle',
        title: `${lowest.diff.text} at ${lowest.offer.retailer}`,
        text: 'Stock isn’t confirmed — check the listing first.',
      };
    }
    if (alike.length) {
      const closest = alike.reduce((min, item) => (item.diff.amount > min.diff.amount ? item : min));
      if (closest.diff.tone === 'more') {
        return {
          mood: 'happy',
          title: `Cheaper here by ${closest.diff.diff}`,
          text: `Lowest other retailer is ${money(closest.offer.price, closest.offer.currency)} at ${closest.offer.retailer}.`,
        };
      }
      return { mood: 'happy', title: 'Best price is in your basket', text: 'No other retailer beat your basket price.' };
    }
    if (all.some(({ best }) => best)) {
      return { mood: 'happy', title: fallbackTitle, text: 'Lowest in-stock match is marked below.' };
    }
    return { mood: 'idle', title: fallbackTitle, text: 'No exact matches to compare: check sizes below.' };
  }

  /**
   * When the shopper's prices and every listing found are in different currencies, the one honest verdict: say so
   * plainly, and offer the country that prices in the shopper's currency, one click away.
   */
  function currencyVerdict(found) {
    const gaps = found.map(({ offers = [], own }) => currencyMismatch(offers, own)).filter(Boolean);
    if (!gaps.length) return null;
    const comparable = found.some(({ offers = [], own }) => !!own?.currency && offers.some((offer) => offer.currency === own.currency));
    if (comparable) return null;
    const [{ own, found: listed }] = gaps;
    const target = guessMarket(own);
    const fits = target !== market.value && markets[target]?.[1] === own;
    return {
      mood: 'shrug',
      tone: 'switch',
      title: `Your price is in ${own}, results are in ${listed}`,
      text: fits ? `Switch to ${markets[target][0]} to compare like for like.` : `Pick a country that prices in ${own} to compare like for like.`,
      next: fits ? { label: `Switch to ${SHORT[target] ?? target}`, run: () => switchMarket(target) } : undefined,
    };
  }

  /** Switch the country and compare again at once: the same items Scout just checked, now in the right currency. */
  async function switchMarket(code) {
    if (busy || !signedIn() || !Object.hasOwn(markets, code)) return;
    setMarket(code);
    chosen = true;
    void chrome.storage.local.set({ [CHOICE]: code }).catch(() => {});
    if (Array.isArray(state?.items) && state.items.length) {
      await start({ country: code, basket: !!state.basket, query: state.basket ? '' : (state.query ?? ''), items: state.items });
      return;
    }
    await run(true);
  }

  function renderGroups(found, { appendSkeleton = false, country = market.value } = {}) {
    const decorated = found.map((item) => ({ ...item }));
    const groups = decorated.map((result) => {
      const made = createOfferGroup(result, groupOptions(result, country));
      result.best = made.best;
      return made.group;
    });
    const nodes = appendSkeleton ? [...groups, ...createSkeletons(skeleton, 1)] : groups;
    results.replaceChildren(...nodes);
    if (groups.length) {
      dealIn(groups, { gap: 70 });
      for (const group of groups) {
        const sticker = group.querySelector('.sticker');
        if (!sticker) continue;
        stickOn(sticker, { delay: 320 });
        drawSwipe(group.querySelector('.swipe'), { delay: 380 });
      }
    }
    return decorated;
  }

  function applyState(next) {
    if (!next || (page.merchant && next.merchant !== page.merchant)
      || (next.url && page.url && next.url !== page.url)) {
      if (state) {
        clearResults();
        setBusy(false);
        intro();
      }
      return;
    }
    state = next;
    if (next.country && !next.cached) setMarket(next.country);
    const country = next.country ?? market.value;
    if (next.basket && Array.isArray(next.items) && !clean(query.value)) {
      query.placeholder = `Your basket (${plural(next.items.length, 'item', 'items')})`;
    }
    if (!next.basket && next.query && !clean(query.value)) query.value = next.query;
    const where = marketName(next.country);
    const key = JSON.stringify([next.startedAt, next.status, next.checked, next.found.length, next.error?.message ?? '']);

    if (next.status === 'running') {
      setBusy(true);
      look('search');
      moreRow.hidden = true;
      moreStatus.textContent = '';
      showResults(next.found.length > 0);
      if (key !== renderedKey) {
        renderedKey = key;
        renderGroups(next.found, { appendSkeleton: true, country });
      }
      if (!next.found.length) {
        tell(`Searching in ${where}…`);
        setVerdict({
          mood: 'search',
          title: 'Checking other retailers',
          text: 'Safe to close — prices will be here when you return.',
        });
      } else {
        const left = Math.min(PER_PRESS, next.items.length - next.checked);
        tell(left === 1 ? 'Checking the last item…' : `Checking next ${left} items…`);
        setVerdict({
          mood: 'search',
          title: `Checked ${next.checked} of ${plural(next.items.length, 'item', 'items')}`,
          text: 'Safe to close while Scout checks the rest.',
        });
      }
      return;
    }

    setBusy(false);
    if (!next.seen) void send({ type: 'cartscout:compare-seen' });

    if (next.status === 'error' || (!next.found.length && next.error)) {
      renderedKey = key;
      results.replaceChildren();
      showResults(false);
      moreRow.hidden = true;
      const err = next.error ?? { message: 'Couldn’t check retailers. Try again.' };
      const paused = err.code === 'budget_reached' || err.code === 'live_off';
      look(paused ? 'idle' : 'oops');
      tell('');
      setVerdict(paused ? { mood: 'idle', title: 'Price checks are paused for now', text: err.message } : {
        mood: 'oops',
        title: 'Couldn’t check retailers',
        text: err.message,
        next: { label: 'Try again', run: () => run(true) },
      });
      return;
    }

    const decorated = key !== renderedKey ? renderGroups(next.found, { country }) : next.found.map((item) => {
      const made = createOfferGroup(item, groupOptions(item, country));
      return { ...item, best: made.best };
    });
    renderedKey = key;
    showResults(decorated.length > 0);

    const some = decorated.some(({ offers }) => offers.length);
    const patchy = decorated.some(({ partial, error }) => partial || error);
    look(some ? 'happy' : 'shrug');
    // Each product now carries the shopper's price and the picker shows the country, so the status line stays
    // empty (and collapses) unless something went wrong.

    if (next.basket) {
      const left = next.items.length - next.checked;
      if (next.error) {
        const paused = next.error.code === 'budget_reached' || next.error.code === 'live_off';
        moreRow.hidden = left <= 0;
        moreStatus.textContent = next.error.message;
        moreStatus.title = next.error.message;
        moreStatus.dataset.tone = paused ? '' : 'error';
        tell('');
      } else {
        moreRow.hidden = left <= 0;
        moreStatus.textContent = next.checked > PER_PRESS && left > 0 ? `${plural(left, 'product', 'products')} still to check.` : '';
        delete moreStatus.dataset.tone;
        tell(patchy ? 'Some retailers didn’t answer. Compare again to retry.' : '');
      }
      setVerdict(currencyVerdict(decorated) ?? basketVerdict(decorated, next.checked, next.items.length));
    } else if (decorated[0]) {
      moreRow.hidden = true;
      tell(next.cached ? `From a recent comparison in ${where} · before delivery`
        : decorated[0].partial && decorated[0].offers.length ? 'Some retailers didn’t answer. Compare again to retry.' : '');
      setVerdict(currencyVerdict(decorated) ?? verdictFor(decorated[0], decorated[0].own));
    }
  }

  async function readFromPage(func) {
    try {
      const [injection] = await chrome.scripting.executeScript({ target: { tabId: page.tabId }, func });
      return injection?.result ?? null;
    } catch {
      throw new Error('Scout couldn’t read this page. Reload it, then try again.');
    }
  }

  async function readBasketLines() {
    const reader = page.myproteinBasket ? readMyproteinBasket : readPageBasket;
    const lines = await readFromPage(reader);
    return Array.isArray(lines) ? lines : [];
  }

  async function run(startNew) {
    if (busy || !signedIn()) return;
    if (!shop) {
      tell('Scout needs a shop page. Open a shop, then compare prices.', 'error');
      return;
    }
    if (!startNew) {
      if (!state) return;
      setBusy(true);
      const reply = await send({ type: 'cartscout:compare-more' });
      if (reply?.ok && reply.state) {
        applyState(reply.state);
      } else {
        setBusy(false);
        moreStatus.textContent = reply?.error || 'Couldn’t check more products. Try again.';
        moreStatus.dataset.tone = 'error';
      }
      return;
    }

    const typed = clean(query.value);
    if (!basketMode() && typed.length < MIN_QUERY) {
      query.setAttribute('aria-invalid', 'true');
      tell(typed ? 'Type at least 3 characters of the product name.' : 'Type the product you want to compare.', 'error');
      query.focus();
      return;
    }
    query.removeAttribute('aria-invalid');

    const country = market.value;
    let items;
    const isBasket = basketMode();
    if (isBasket) {
      setBusy(true);
      try {
        const lines = await readBasketLines();
        basketItems = lines;
        showPage();
        if (!lines.length) {
          setBusy(false);
          clearResults({ remote: true });
          look('shrug');
          tell('');
          setVerdict({
            mood: 'shrug',
            title: 'Your basket looks empty',
            text: 'Add a product to your basket, or type one above.',
            next: { label: 'Type one', run: () => query.focus() },
          });
          return;
        }
        items = lines.map(({ name, variant, price, currency }) => ({
          name, variant, own: usablePrice({ price, currency }),
        }));
      } catch (error) {
        setBusy(false);
        look('oops');
        tell('');
        setVerdict({
          mood: 'oops',
          title: 'Couldn’t read your basket',
          text: error.message,
          next: { label: 'Try again', run: () => run(true) },
        });
        return;
      }
    } else {
      const own = ownPrice(typed);
      items = [{ name: typed.slice(0, 140), variant: own?.variant ?? '', own }];
    }

    await start({ country, basket: isBasket, query: isBasket ? '' : typed.slice(0, 140), items });
  }

  /** Hands one comparison to the service worker and shows whatever it answers. */
  async function start({ country, basket, query: typed, items }) {
    setBusy(true);
    const reply = await send({
      type: 'cartscout:compare-start',
      host: page.host,
      merchant: page.merchant,
      country,
      basket,
      query: typed,
      items,
    });
    if (reply?.ok && reply.state) {
      applyState(reply.state);
    } else {
      setBusy(false);
      look('oops');
      tell('');
      setVerdict({
        mood: 'oops',
        title: 'Couldn’t check retailers',
        text: reply?.error || 'CartScout couldn’t start the comparison. Try again.',
        next: { label: 'Try again', run: () => run(true) },
      });
    }
  }

  async function watchCompare() {
    if (!page.tabId || !session) return;
    const key = compareKey(page.tabId);
    const onChange = (changes) => {
      if (Object.hasOwn(changes, key)) applyState(changes[key].newValue ?? null);
    };
    if (session.onChanged) session.onChanged.addListener(onChange);
    else chrome.storage.onChanged.addListener((changes, area) => area === 'session' && onChange(changes));
    const stored = await session.get(key).catch(() => undefined);
    if (stored?.[key]) applyState(stored[key]);
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void run(true);
  });
  more.addEventListener('click', () => { if (state) void run(false); });
  query.addEventListener('input', () => {
    edited = true;
    if (!query.hasAttribute('aria-invalid')) return;
    query.removeAttribute('aria-invalid');
    tell(`Before delivery · ${marketName()}`);
  });
  market.addEventListener('change', () => {
    edited = true;
    marketFace.textContent = SHORT[market.value] ?? market.value;
    chosen = true;
    void chrome.storage.local.set({ [CHOICE]: market.value }).catch(() => {});
    if (state?.cached) applyState(null);
    if (!busy && !state) tell(shop ? `Before delivery · ${marketName()}` : '');
  });

  for (const [code, [name]] of Object.entries(markets)) market.add(new Option(name, code));
  market.value = page.basket ? 'GB' : guessMarket();
  marketFace.textContent = SHORT[market.value] ?? market.value;
  query.placeholder = page.basket ? 'Your basket' : 'e.g. Sony WH-1000XM5';
  intro();
  void watchCompare();

  return {
    async prepare() {
      if (ready) return;
      ready = true;
      const check = ++preparation;
      const stored = await chrome.storage.local.get(CHOICE).catch(() => ({}));
      if (Object.hasOwn(markets, stored?.[CHOICE]) && !busy && !state) {
        chosen = true;
        setMarket(stored[CHOICE]);
      }
      if (shop && page.tabId) {
        if (isBasketPage()) {
          const lines = await readBasketLines().catch(() => []);
          basketItems = lines;
          const firstCurrency = lines.find((item) => item?.currency)?.currency;
          if (firstCurrency && !chosen && !busy && !state) setMarket(guessMarket(firstCurrency));
        } else {
          const found = await readFromPage(readPageProduct).catch(() => null);
          if (found && typeof found.name === 'string' && clean(found.name).length >= MIN_QUERY) {
            product = { ...found, name: clean(found.name) };
            if (!clean(query.value) && !state) query.value = product.name;
            if (!chosen && !busy && !state) setMarket(guessMarket(product.currency));
          }
        }
      }
      if (preparation !== check) return;
      showPage();
      if (!state && !busy) intro();
      if (!site || !signedIn()) return;
      if (alertsAvailable) void readAlertSetting().catch(() => {});
      if (!product) return;
      const reply = await send({ type: 'cartscout:compare-cached', merchant: page.merchant, product });
      const saving = reply?.saving;
      if (preparation !== check || !signedIn() || !saving) return;
      const remaining = Date.parse(saving.result.freshUntil) - Date.now();
      if (!(remaining > 0)) return;
      cachedSaving = saving;
      savingButton.querySelector('strong').textContent = saving.title;
      savingButton.querySelector('span').textContent = saving.detail;
      savingButton.hidden = false;
      savingTimer = setTimeout(clearSaving, remaining);
      if (!state && !busy && !edited && saving.country === market.value && clean(query.value) === product.name) {
        showCachedComparison();
      }
    },
    moved() {
      clearSaving();
      if (product && clean(query.value).toLowerCase() === product.name.toLowerCase()) query.value = '';
      product = undefined;
      edited = false;
      basketItems = [];
      clearResults({ remote: true });
      ready = false;
      if (page.myproteinBasket && !chosen) setMarket('GB');
      void this.prepare();
    },
    reset() {
      preparation++;
      clearSaving();
      alertSettings.hidden = true;
      clearResults({ remote: true });
      basketItems = [];
      edited = false;
      ready = false;
      intro();
    },
  };
}
