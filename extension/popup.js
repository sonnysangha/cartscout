import './popup-fit.js';
import { getClerkToken, openAccountPortal, tokenUser } from './account.js';
import { API_ORIGIN } from './config.js';
import { mountScout, setMood } from './scout.js';
import { celebrate, prefersReducedMotion, sparkle } from './confetti.js';
import { beat, dealIn, drawSwipe, stickOn } from './motion.js';
import {
  arrange, groupsFor, middleCut, printable, sameCode,
} from './popup-order.js';
import { createSkeletons, createTicket } from './popup-ticket.js';
import { RUN_ACTIVE, createDock } from './popup-run.js';
import { dockPlan } from './popup-probe.js';
import { createCompare } from './popup-compare.js';
import { isBasketPath } from './basket.js';
import { readPageCodes } from './page-codes.js';
import { HANDOVER_KEY, handedHost, handedView } from './handover.js';
import { AUTOTRY_FILE, pauseKey, pickKey, RUN_LIMIT } from './autotry/limits.js';
import { pageCall } from './run.js';

const element = (id) => document.getElementById(id);
const status = element('status');
const notice = element('notice');
const list = element('coupons');
const main = element('main');
const mark = mountScout(element('mark'), { mood: 'search' });
const accountAction = element('account-action');
const accountUpgrade = element('account-upgrade');
const accountRefresh = element('account-refresh');
const helpButton = element('how-it-works');
const welcome = element('welcome');
const welcomeStatus = element('welcome-status');
const tabs = { coupons: element('show-coupons'), alternatives: element('show-alternatives') };
const views = { coupons: element('coupon-view'), alternatives: element('alternatives') };
const couponTemplate = element('coupon');
const couponSkeleton = element('coupon-skeleton');

const SCAN_STEPS = ['Searching popular search engines for codes', 'Checking coupon sites', 'Reading the small print'];
const WAIT_NOTE = 'Safe to close — codes will be here when you return.';
const WATCH_NOTE = 'Scout will also let you know on the page.';
const PORTAL_MEMORY_MS = 15 * 60_000;
const PRO_PITCH = 'Pro unlocks unlimited weekly scans, live working codes & savings from other Pro members, and shared thumbs on every code.';
const FOLLOW_EVERY_MS = 2500;
const FOLLOW_LIMIT_MS = 100_000;
const PAUSE_MEMORY_MS = 15 * 60_000;

const pinnedTab = Number(new URLSearchParams(location.search).get('tab')) || null;
const session = chrome.storage?.session;
const local = chrome.storage?.local;

let merchant;
let page = { tabId: null, host: '', origin: '', shop: false, merchant: undefined, basket: false, myproteinBasket: false, probe: null, pauseUntil: 0, handed: false };
let accountReady = false;
let account;
let coupons = [];
let tickets = [];
let pageCodes = [];
let listedAt = 0;
let pageCodesReady = Promise.resolve();
let probeReady = Promise.resolve();
let pageCount = 0;
let confirmedCount = 0;
let unseenScan = false;
let shown = null;
let shownLayout = '';
let view = 'coupons';
let run = null;
let leaving = false;
let opening = false;
let loading = null;
let refreshing = false;
let painted = false;
let portalPending = false;
let copiedCouponKey;
let reflected;
let summary = '';
let noticeTimer;
let compare;
let paused = null;
const copiedCodes = new Set();

class Quiet extends Error {
  quiet = true;
}

function say(text, { lasting = true, code = '' } = {}) {
  if (lasting) summary = text;
  const full = text;
  status.title = full;
  if (code && code.length > 18) {
    status.textContent = full.replaceAll(code, middleCut(code, 18));
  } else {
    status.textContent = full;
  }
}

function notify(text) {
  clearTimeout(noticeTimer);
  notice.textContent = text;
  notice.dataset.show = 'true';
  noticeTimer = setTimeout(() => { notice.dataset.show = 'false'; }, 5200);
}

const look = (mood) => setMood(mark, mood);
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function lostFocus() {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected || !!active.closest('[hidden], [inert]');
}

function isBudgetPaused() {
  if (!paused) return false;
  if (paused.until && Date.now() >= paused.until) {
    paused = null;
    return false;
  }
  return true;
}

function setBudgetPaused(error) {
  const parsed = error?.resetAt ? Date.parse(error.resetAt) : NaN;
  paused = {
    message: error?.message || 'Scout has done all of today’s live searching. Saved codes still open, and scanning is back tomorrow.',
    until: Number.isFinite(parsed) && parsed > Date.now() ? parsed : Date.now() + PAUSE_MEMORY_MS,
  };
}

function createScene(root) {
  const scout = mountScout(root.querySelector('.scene-scout'), { mood: 'idle' });
  const title = root.querySelector('.scene-title');
  const text = root.querySelector('.scene-text');
  const steps = root.querySelector('.scene-steps');
  const button = root.querySelector('.scene-button');
  const foot = root.querySelector('.scene-foot');
  const peek = root.querySelector('.scene-peek');
  let action;
  let stepTimer;
  button.addEventListener('click', () => action?.());

  function cycle(lines) {
    let index = 0;
    steps.textContent = lines[0];
    stepTimer = setInterval(() => {
      index = (index + 1) % lines.length;
      if (prefersReducedMotion()) {
        steps.textContent = lines[index];
        return;
      }
      const out = steps.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
      out.finished.then(() => {
        steps.textContent = lines[index];
        steps.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220 });
        out.cancel();
      }, () => {});
    }, 2600);
  }

  return {
    get showing() { return !root.hidden; },
    show({ mood = 'idle', headline, body = '', lines, action: next, note = '', skeleton }) {
      clearInterval(stepTimer);
      const arriving = root.hidden;
      const held = root.contains(document.activeElement) || list.contains(document.activeElement);
      root.hidden = false;
      setMood(scout, mood);
      title.textContent = headline;
      text.textContent = body;
      steps.textContent = '';
      if (lines) cycle(lines);
      action = next?.run;
      button.hidden = !next;
      button.textContent = next?.label ?? '';
      foot.textContent = note;
      peek.replaceChildren(...(skeleton ?? []));
      if (skeleton) dealIn(peek.children, { gap: 220, delay: 300 });
      if (held && lostFocus()) (next ? button : title).focus({ preventScroll: true });
      if (arriving && !prefersReducedMotion()) {
        root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
        stickOn(scout, { duration: 420, tilt: -4 });
      }
    },
    note(nextText) {
      if (root.hidden || foot.textContent === nextText) return;
      foot.textContent = nextText;
      if (!prefersReducedMotion()) foot.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
    },
    hide() {
      clearInterval(stepTimer);
      peek.replaceChildren();
      root.hidden = true;
    },
  };
}

const couponScene = createScene(element('coupon-scene'));

// ---- Account and header -------------------------------------------------------------------

function renderAccount(next) {
  account = next;
  const pro = account?.plan === 'pro';
  const remaining = account?.scans?.remaining ?? 0;
  const limit = account?.scans?.limit ?? 5;
  document.body.dataset.account = !account ? 'signedout' : pro ? 'pro' : 'free';
  accountAction.dataset.plan = !account ? 'unknown' : pro ? 'pro' : 'free';
  accountAction.hidden = !account;
  accountAction.title = pro ? 'Manage your Pro plan' : PRO_PITCH;
  element('account-plan').textContent = account ? (pro ? 'Pro' : 'Free') : '';

  const detail = !account ? 'Not signed in'
    : pro ? '∞ Unlimited'
    : remaining === 0 ? '0 scans left'
    : `${remaining}/${limit} scans`;
  const detailFull = !account ? 'Not signed in'
    : pro ? 'Unlimited scans · Click Pro to manage plan'
    : `${remaining} of ${limit} free scans left this week`;
  const detailEl = element('account-detail');
  detailEl.textContent = detail;
  detailEl.title = detailFull;
  detailEl.dataset.tone = !pro && account && remaining === 0 ? 'out' : '';

  accountUpgrade.hidden = !account || pro;
  accountUpgrade.title = PRO_PITCH;
  showWelcome(accountReady && !account);
}

function showWelcome(show) {
  if (welcome.hidden !== show) return;
  welcome.hidden = !show;
  for (const part of document.querySelectorAll('body > :is(header, nav, .stage-body)')) part.inert = show;
  if (!show) return;
  mountScout(element('welcome-scout'), { mood: 'wave' });
  if (prefersReducedMotion()) return;
  welcome.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
  stickOn(element('welcome-scout'), { delay: 60 });
  drawSwipe(welcome.querySelector('.swipe'), { delay: 420 });
  dealIn(welcome.querySelectorAll('.benefits li'), { delay: 260, gap: 80 });
}

// ---- Session memory -----------------------------------------------------------------------

const LAST_ACCOUNT_KEY = 'lastAccount';
const seenKey = (userId) => `seen:${userId}:${merchant}`;

function rememberAccount(next) {
  if (!session) return;
  if (next && typeof next.userId === 'string') {
    void session.set({ [LAST_ACCOUNT_KEY]: next }).catch(() => {});
  } else {
    void session.remove(LAST_ACCOUNT_KEY).catch(() => {});
  }
}

function remember() {
  if (!session || !account?.userId || !merchant || !shown) return;
  const listed = tickets.map((ticket) => ticket.coupon).filter((coupon) => !coupon.pageOnly)
    .map(({ onPage, pageOnly, ...coupon }) => coupon);
  const data = {
    source: shown.source,
    refreshedAt: shown.refreshedAt,
    freshUntil: shown.freshUntil,
    partial: shown.partial,
    coupons: listed,
  };
  void session.set({ [seenKey(account.userId)]: { data, account, at: Date.now() } }).catch(() => {});
}

async function paintInstantCache() {
  if (!session) return false;
  const stored = await session.get(LAST_ACCOUNT_KEY).catch(() => undefined);
  const savedAccount = stored?.[LAST_ACCOUNT_KEY];
  if (!savedAccount || typeof savedAccount.userId !== 'string') return false;
  renderAccount(savedAccount);
  if (!merchant) return false;
  return paintRemembered(savedAccount.userId);
}

async function paintRemembered(userId) {
  if (!session || !userId || !merchant) return false;
  const key = seenKey(userId);
  const seen = (await session.get(key).catch(() => undefined))?.[key];
  if (!seen || seen.account?.userId !== userId || !Array.isArray(seen.data?.coupons)) return false;
  renderAccount(seen.account);
  await restoreCopied(userId);
  renderCoupons({ ...seen.data, source: seen.data.source === 'live' ? 'cache' : seen.data.source }, { at: seen.at });
  painted = true;
  return true;
}

async function forgetEverything() {
  if (!session) return;
  try {
    const all = await session.get(null);
    const mine = Object.keys(all ?? {}).filter((key) => /^(?:seen|copiedCoupons|scanning):/.test(key) || key === LAST_ACCOUNT_KEY);
    if (mine.length) await session.remove(mine);
  } catch {
    // Nothing to forget.
  }
}

async function restoreCopied(userId) {
  const key = `copiedCoupons:${userId}:${merchant}`;
  if (copiedCouponKey === key || !merchant) return;
  copiedCouponKey = key;
  const stored = await session?.get(key).catch(() => undefined);
  if (copiedCouponKey === key && Array.isArray(stored?.[key])) {
    for (const code of stored[key]) copiedCodes.add(code);
  }
}

// ---- Talking to CartScout -----------------------------------------------------------------

function signedOut() {
  clearShoppingData();
  void forgetEverything();
  renderAccount(null);
}

async function api(route, fields, { sessionToken, signal, retried = false } = {}) {
  const token = sessionToken ?? await getClerkToken();
  if (!token) {
    accountReady = true;
    signedOut();
    throw new Quiet('Signed out.');
  }
  let response;
  try {
    const isAccount = route === '/v1/account';
    response = await fetch(new URL(route, API_ORIGIN), {
      method: isAccount ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: isAccount ? undefined : JSON.stringify({ merchant, ...fields }),
      signal: AbortSignal.any([AbortSignal.timeout(75_000), ...(signal ? [signal] : [])]),
    });
  } catch {
    if (signal?.aborted) throw new Quiet('Replaced by a newer request.');
    throw Object.assign(new Error('Check your connection, then try again.'), { code: 'unreachable' });
  }
  let data = {};
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
  } catch {
    if (signal?.aborted) throw new Quiet('Replaced by a newer request.');
  }
  if (data.account && typeof data.account.userId === 'string') renderAccount(data.account);
  if (response.status === 401) {
    // A cached 60s Clerk JWT can expire right before the request lands: refresh once before showing signed-out.
    if (!retried) {
      const freshToken = await getClerkToken({ fresh: true }).catch(() => null);
      if (freshToken && freshToken !== token) {
        return api(route, fields, { sessionToken: freshToken, signal, retried: true });
      }
    }
    accountReady = true;
    signedOut();
    throw new Quiet('Signed out.');
  }
  if (!response.ok) {
    const msg = typeof data.message === 'string' && data.message
      ? data.message
      : (typeof data.error === 'string' && data.error ? data.error : 'CartScout couldn’t finish that. Try again in a moment.');
    throw Object.assign(new Error(msg), { code: data.code, status: response.status, resetAt: data.resetAt });
  }
  return data;
}

// ---- Coupons ------------------------------------------------------------------------------

function resetText(resetsAt) {
  const date = resetsAt ? new Date(resetsAt) : null;
  if (!date || Number.isNaN(date.getTime())) return 'on Monday at 00:00 UTC';
  return `on ${new Intl.DateTimeFormat('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit' }).format(date)
    .replace(/,? (?=\d)/, ' at ')}`;
}

function agoText(time) {
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000));
  if (!Number.isFinite(minutes)) return 'earlier';
  if (minutes < 2) return 'a moment ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

const scanNow = () => loadCoupons({ cacheOnly: false, scan: true });
const rescanNow = () => loadCoupons({ cacheOnly: false, scan: true, force: true });
const codesText = (count) => (count === 1 ? '1 code' : `${count} codes`);
const PAGE_ONLY = { source: 'none', coupons: [], partial: false, refreshedAt: null };

async function readOwnCodes() {
  if (!page.tabId || !merchant) return;
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: page.tabId }, func: readPageCodes });
    const found = Array.isArray(injection?.result) ? injection.result : [];
    pageCodes = found
      .filter((entry) => typeof entry?.code === 'string' && /^[A-Z0-9_-]{3,20}$/.test(entry.code))
      .slice(0, 5)
      .map((entry) => ({ code: entry.code, offer: typeof entry.offer === 'string' ? entry.offer.slice(0, 120) : '' }));
  } catch {
    pageCodes = [];
  }
}

/** Read-only probe of the active tab for auto-try (D9 / I6: never clicks or mutates the page). */
async function probePage() {
  if (!page.tabId || page.handed || !page.origin?.startsWith('https://')) {
    page.probe = null;
    return;
  }
  try {
    const key = pickKey(page.host);
    const [pickStored, pauseStored] = await Promise.all([
      local?.get(key).catch(() => ({})),
      session?.get(pauseKey(page.host)).catch(() => ({})),
    ]);
    page.pauseUntil = pauseStored?.[pauseKey(page.host)]?.until ?? 0;
    const pick = pickStored?.[key] ?? null;
    await chrome.scripting.executeScript({ target: { tabId: page.tabId }, files: [AUTOTRY_FILE] });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: page.tabId },
      func: pageCall,
      args: ['probe', { pick }],
    });
    page.probe = res?.result?.v === 1 ? res.result : null;
  } catch {
    page.probe = null;
  }
  syncDock();
}

let shownWinner;

function applyTrialResults() {
  const results = new Map((run?.results ?? []).map((result) => [String(result.code).toUpperCase(), result]));
  const landed = ['saved', 'applied'].includes(run?.status);
  const settled = Number.isFinite(run?.finishedAt) && listedAt > run.finishedAt;
  let winner;
  for (const ticket of tickets) {
    const result = results.get(ticket.code.toUpperCase());
    const won = landed && sameCode(run.code, ticket.code);
    if (won) winner = ticket;
    if (won) {
      ticket.setTrial({
        outcome: 'applied',
        kept: true,
        message: result?.message || (run.saving?.beat > 0 ? 'Best saving · Applied to this basket' : 'Applied to this basket'),
        ...(typeof result?.vote === 'boolean' && { vote: result.vote }),
      }, { settled });
    } else if (result) {
      ticket.setTrial({
        ...result,
        kept: result.outcome === 'applied' ? false : result.kept,
      }, { settled });
    } else {
      ticket.setTrial(null, { settled });
    }
  }
  const key = winner ? `${run.startedAt}:${winner.code}` : undefined;
  if (key && key !== shownWinner && view === 'coupons') {
    main.scrollTo({ top: Math.max(0, winner.row.offsetTop - 2), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }
  shownWinner = key;
}

async function copyCode(code) {
  await navigator.clipboard.writeText(code);
  copiedCodes.add(code);
  if (copiedCouponKey) {
    void session?.set({ [copiedCouponKey]: [...copiedCodes].slice(-24) }).catch(() => {});
  }
}

async function voteOn(coupon, worked) {
  const key = coupon.reportCode ?? coupon.code;
  const data = await api('/v1/reports', { code: key, worked });
  const all = Array.isArray(data.coupons) ? data.coupons.filter((entry) => typeof entry?.code === 'string') : [];
  const fresh = all.find((entry) => entry.code === key) ?? all.find((entry) => sameCode(entry.code, key));
  const counted = fresh
    ? { worked: fresh.worked, failed: fresh.failed, myReport: fresh.myReport }
    : { myReport: Number(worked) };
  element('report-status').textContent = `Saved: ${coupon.code} ${worked ? 'worked' : 'didn’t work'} for you.`;
  if (shown && all.length) {
    shown = { ...shown, coupons: all };
    setTimeout(() => {
      if (shown) renderCoupons(shown, { at: listedAt });
      remember();
    }, 350);
  } else {
    setTimeout(remember);
  }
  return counted;
}

function showNoCodes(data) {
  const pro = account?.plan === 'pro';
  const remaining = account?.scans?.remaining ?? 0;
  const freshUntil = data.freshUntil ? Date.parse(data.freshUntil) : NaN;
  const fallbackFor = data.partial ? 60 * 60_000 : 24 * 60 * 60_000;
  const nextScan = Number.isFinite(freshUntil) ? freshUntil : (data.refreshedAt ? data.refreshedAt + fallbackFor : 0);
  const outOfScans = !pro && remaining <= 0;
  const canScan = !isBudgetPaused() && (data.source === 'stale' || nextScan <= Date.now()) && (pro || remaining > 0);
  const later = isBudgetPaused() ? paused.message
    : outOfScans ? `Free scans reset ${resetText(account?.scans?.resetsAt)}.`
    : nextScan > Date.now() && data.source !== 'stale'
      ? `Next scan after ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(nextScan)}.`
      : canScan && !pro ? 'Uses 1 free scan.' : '';
  couponScene.show({
    mood: 'shrug',
    headline: `No codes for ${merchant}`,
    body: data.partial
      ? 'Some coupon sites couldn’t be read.'
      : outOfScans
        ? 'Out of free scans this week. Upgrade to Pro for unlimited scans.'
        : 'No public checkout codes found.',
    action: outOfScans ? { label: 'Upgrade to Pro', run: () => openPortal('billing') }
      : canScan ? { label: 'Scan again', run: scanNow }
      : { label: 'Compare prices', run: () => switchView('alternatives') },
    note: later,
  });
}

function subhead(text) {
  const row = document.createElement('li');
  row.className = 'subhead';
  row.textContent = text;
  return row;
}

function staleNote(data) {
  const row = document.createElement('li');
  row.className = 'list-note';
  const text = document.createElement('span');
  const pro = account?.plan === 'pro';
  const age = Number.isFinite(data.refreshedAt) ? `Saved ${agoText(data.refreshedAt)}` : 'Saved earlier';
  if (isBudgetPaused()) {
    text.textContent = paused.message;
    text.title = paused.message;
    row.append(text);
    return row;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'quiet';
  if (pro) {
    text.textContent = age;
    button.textContent = 'Scan again';
    button.addEventListener('click', scanNow);
    row.append(text, button);
    return row;
  }
  const remaining = account?.scans?.remaining ?? 0;
  if (!remaining) {
    text.textContent = 'Out of free scans this week';
    text.title = `${age}. Your ${account?.scans?.limit ?? 5} free scans reset ${resetText(account?.scans?.resetsAt)}.`;
    button.textContent = 'Upgrade to Pro';
    button.addEventListener('click', () => openPortal('billing'));
    row.append(text, button);
    return row;
  }
  text.textContent = age;
  button.textContent = 'Scan again';
  button.title = `Uses 1 of your ${remaining} ${remaining === 1 ? 'scan' : 'scans'} left this week`;
  button.addEventListener('click', scanNow);
  row.append(text, button);
  return row;
}

function tailRows({ kind, retry, message }, data, shownCount) {
  const row = document.createElement('li');
  row.className = 'list-tail';
  row.dataset.kind = kind;
  const line = (text, className = '') => {
    const part = document.createElement('p');
    part.className = className;
    part.textContent = text;
    return part;
  };
  const button = (label, className, action) => {
    const part = document.createElement('button');
    part.type = 'button';
    part.className = className;
    part.textContent = label;
    part.addEventListener('click', action);
    return part;
  };
  const pro = account?.plan === 'pro';
  const remaining = account?.scans?.remaining ?? 0;
  if (kind === 'scan') {
    row.append(button('Search for more codes', 'secondary', scanNow));
    if (!pro) row.append(line(`${remaining} of ${account?.scans?.limit ?? 5} free scans left`));
    return [row];
  }
  if (kind === 'scanning') {
    row.setAttribute('role', 'status');
    row.append(
      line('Scout is digging for codes on the web…', 'lead'),
      line('Safe to close — codes will be here when you return.'),
    );
    return [row, ...createSkeletons(couponSkeleton, 2)];
  }
  if (kind === 'paused') {
    row.append(line(message || paused?.message || 'Live searching is paused for now.'));
    return [row];
  }
  if (kind === 'out') {
    row.append(
      line(`Out of free scans · resets ${resetText(account?.scans?.resetsAt)}`),
      button('Upgrade to Pro', 'quiet', () => openPortal('billing')),
    );
    return [row];
  }
  if (kind === 'error') {
    row.append(line('Couldn’t check coupon sites just now.'));
    if (retry) row.append(button('Try again', 'quiet', retry));
    return [row];
  }
  if (!data.coupons.length) row.append(line('Nothing more on coupon sites.'));
  else if (data.partial) row.append(line('Some coupon sites couldn’t be read.'));

  if (!pro && remaining <= 0 && !isBudgetPaused()) {
    row.append(
      line(`Out of free scans · resets ${resetText(account?.scans?.resetsAt)}`),
      button('Upgrade to Pro', 'quiet', () => openPortal('billing')),
    );
  } else if (data.source !== 'stale' && !isBudgetPaused()) {
    row.append(button('Search for more codes', 'quiet', rescanNow));
  }
  if (shownCount <= 2) row.append(button('Compare prices', 'quiet', () => switchView('alternatives')));
  return [row];
}

function setBadge(count) {
  if (!page.tabId) return;
  try {
    void chrome.action?.setBadgeText?.({ tabId: page.tabId, text: count > 0 ? String(count) : '' })?.catch?.(() => {});
  } catch {
    // Badge is optional.
  }
}

function renderCoupons(data, { fresh = false, tail = { kind: 'end' }, at = Date.now() } = {}) {
  listedAt = Number.isFinite(at) ? at : 0;
  const pro = account?.plan === 'pro';
  const stale = data.source === 'stale';
  const answered = data.source !== 'none';
  const arranged = arrange(data.coupons, pageCodes, run);
  const { worked, onPage, confirmed, rest, listed } = arranged;
  if (stale && !listed) {
    showCouponError({ code: 'scan_required' });
    return;
  }

  const order = [...worked, ...onPage, ...confirmed, ...rest];
  const count = order.length;
  shown = answered ? data : null;
  coupons = order;
  pageCount = onPage.length;
  confirmedCount = worked.length + (pro ? confirmed.length : 0);
  const found = count === 1 ? '1 possible code' : `${count} possible codes`;
  const freshness = stale ? (pro ? 'earlier results' : 'from your saved scan')
    : data.source === 'cache' ? (pro ? 'from earlier scans' : 'from your saved scan') : 'checked just now';
  if (!answered) say(`${codesText(count)} shown on this page`);
  else {
    say([count ? `${found} · ${freshness}` : 'No public codes found', data.partial ? '· some sites unread' : '']
      .filter(Boolean).join(' '));
    setBadge(count);
  }

  if (!count) {
    list.replaceChildren();
    tickets = [];
    shownLayout = '';
    syncDock();
    look('shrug');
    showNoCodes(data);
    return;
  }

  const groups = groupsFor(arranged, pro);
  const layout = JSON.stringify([
    account?.userId, pro, stale, tail.kind, isBudgetPaused(), account?.scans?.remaining, data.partial, !!data.coupons.length,
    groups.map(([title, group]) => [title, group.map((coupon) => [coupon.code, !!coupon.pageOnly])]),
  ]);

  if (layout === shownLayout && tickets.length === count) {
    tickets.forEach((ticket, index) => ticket.update(coupons[index]));
  } else {
    const held = list.contains(document.activeElement);
    tickets = coupons.map((coupon, index) => createTicket(couponTemplate, coupon, index, {
      shared: pro,
      wasCopied: copiedCodes.has(coupon.code),
      shortcuts: false,
      copy: copyCode,
      vote: voteOn,
      onProblem: notify,
      onWorked: (origin) => {
        look('happy');
        void sparkle({ origin });
      },
    }));
    const rowOf = new Map(tickets.map((ticket) => [ticket.code, ticket.row]));
    const rows = [];
    for (const [title, group] of groups) {
      if (!group.length) continue;
      if (title) rows.push(subhead(title));
      rows.push(...group.map((coupon) => rowOf.get(coupon.code)));
    }
    if (stale) rows.unshift(staleNote(data));
    rows.push(...tailRows(tail, data, count));
    list.replaceChildren(...rows);
    shownLayout = layout;
    if (fresh) dealIn(list.children);
    if (held && lostFocus()) tickets[0].focus();
  }

  const fromScene = couponScene.showing && element('coupon-scene').contains(document.activeElement);
  couponScene.hide();
  if (fromScene || (main.contains(document.activeElement) && lostFocus())) tickets[0].focus();
  applyTrialResults();
  syncDock();
  if (fresh) {
    look('happy');
    void sparkle({ origin: mark });
  } else {
    look('idle');
  }
  reflectRun(true);
  reflectVotes();
}

function emptyList() {
  list.replaceChildren();
  tickets = [];
  coupons = [];
  pageCount = 0;
  confirmedCount = 0;
  shown = null;
  shownLayout = '';
  syncDock();
}

function showCouponError(error, retry) {
  const withPage = pageCodes.length > 0;
  const pro = account?.plan === 'pro';

  if (error.code === 'budget_reached' || error.code === 'live_off') {
    setBudgetPaused(error);
    if (shown && tickets.length) {
      // Keep saved codes already on screen; calmly show the server's pause sentence.
      notify(paused.message);
      renderCoupons(shown);
      return;
    }
    if (withPage) {
      renderCoupons(PAGE_ONLY, { tail: { kind: 'paused', message: paused.message } });
      return;
    }
    emptyList();
    look('idle');
    say('Live searching is paused');
    couponScene.show({
      mood: 'idle',
      headline: error.code === 'live_off' ? 'Live searching is switched off' : 'Live searching is paused for now',
      body: paused.message,
    });
    return;
  }

  if (error.code === 'scan_required' || error.code === 'scan_limit') {
    const remaining = account?.scans?.remaining ?? 0;
    if (!pro && (error.code === 'scan_limit' || !remaining)) {
      if (withPage) {
        renderCoupons(PAGE_ONLY, { tail: { kind: 'out' } });
        return;
      }
      emptyList();
      look('shrug');
      say('No scans left this week');
      couponScene.show({
        mood: 'shrug',
        headline: 'Out of free scans',
        body: `Free scans reset ${resetText(account?.scans?.resetsAt)}. Upgrade to Pro for unlimited scans.`,
        action: { label: 'Upgrade to Pro', run: () => openPortal('billing') },
        note: 'Saved shops still open.',
      });
      return;
    }
    if (isBudgetPaused()) {
      if (withPage) {
        renderCoupons(PAGE_ONLY, { tail: { kind: 'paused', message: paused.message } });
        return;
      }
      emptyList();
      look('idle');
      say('Live searching is paused');
      couponScene.show({ mood: 'idle', headline: 'Live searching is paused for now', body: paused.message });
      return;
    }
    if (withPage) {
      renderCoupons(PAGE_ONLY, { tail: { kind: 'scan' } });
      return;
    }
    emptyList();
    look('idle');
    say('Ready to scan');
    couponScene.show({
      mood: 'wave',
      headline: `Scan ${merchant}?`,
      body: pro
        ? 'Checks the shop and coupon sites for public codes.'
        : `Uses 1 of ${remaining} free ${remaining === 1 ? 'scan' : 'scans'} left this week.`,
      action: { label: 'Scan this shop', run: scanNow },
      note: '',
    });
    return;
  }

  const permanent = error.status === 400 || error.status === 404;
  if (withPage) {
    renderCoupons(PAGE_ONLY, { tail: { kind: 'error', retry: permanent ? undefined : retry } });
    return;
  }
  emptyList();
  look('oops');
  if (error.code === 'unreachable') {
    say('Can’t reach CartScout');
    couponScene.show({
      mood: 'oops',
      headline: 'Scout can’t reach CartScout',
      body: error.message,
      action: { label: 'Try again', run: retry },
    });
    return;
  }
  say('Something went wrong');
  couponScene.show({
    mood: 'oops',
    headline: 'Scout couldn’t check this shop',
    body: permanent ? 'CartScout can’t look for codes on this address. Try it from the shop’s own website.' : error.message,
    action: permanent ? undefined : { label: 'Try again', run: retry },
  });
}

function createScanConveyor() {
  const stage = document.createElement('li');
  stage.className = 'conveyor';
  stage.setAttribute('aria-hidden', 'true');
  // Alternating outcomes: tear-off (filtered out), keep (makes it through), tear-off, keep.
  const sequence = [
    { kind: 'tear', delay: '0s', w1: '52%', w2: '78%' },
    { kind: 'keep', delay: '-1.15s', w1: '62%', w2: '68%' },
    { kind: 'tear', delay: '-2.3s', w1: '46%', w2: '84%' },
    { kind: 'keep', delay: '-3.45s', w1: '58%', w2: '72%' },
  ];
  for (const item of sequence) {
    const ticket = document.createElement('div');
    ticket.className = `conveyor-ticket is-${item.kind}`;
    ticket.style.setProperty('--delay', item.delay);

    const body = document.createElement('div');
    body.className = 'ct-body';
    const codeBone = document.createElement('span');
    codeBone.className = 'ct-bar ct-code';
    codeBone.style.inlineSize = item.w1;
    const offerBone = document.createElement('span');
    offerBone.className = 'ct-bar ct-offer';
    offerBone.style.inlineSize = item.w2;
    body.append(codeBone, offerBone);

    const stub = document.createElement('div');
    stub.className = 'ct-stub';
    if (item.kind === 'keep') {
      stub.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18"><path d="m4.5 10.5 3.6 3.6L15.5 6.5"/></svg>';
    } else {
      stub.innerHTML = '<svg viewBox="0 0 20 20" width="16" height="16"><path d="m6 6 8 8m0-8-8 8"/></svg>';
    }

    ticket.append(body, stub);
    stage.append(ticket);
  }
  return [stage];
}

function showScanning() {
  if (pageCodes.length) {
    renderCoupons(PAGE_ONLY, { tail: { kind: 'scanning' } });
  } else {
    emptyList();
    couponScene.show({
      mood: 'search',
      headline: 'Scout is digging for codes on the web',
      lines: SCAN_STEPS,
      body: WAIT_NOTE,
      skeleton: createScanConveyor(),
    });
  }
  look('search');
  say('Digging for codes on the web…');
}

const scanningKey = () => (account?.userId && merchant ? `scanning:${account.userId}:${merchant}` : null);

async function restoreUnseenScan() {
  const key = scanningKey();
  if (!key || !session) return;
  const stored = await session.get(key).catch(() => undefined);
  unseenScan = Number.isFinite(stored?.[key]) && Date.now() - stored[key] < 6 * 60 * 60_000;
}

function scanSeen() {
  const key = scanningKey();
  unseenScan = false;
  if (page.tabId) void send({ type: 'cartscout:scan-seen' });
  if (key) void session?.remove(key).catch(() => {});
}

async function followScan(mine) {
  const key = scanningKey();
  unseenScan = true;
  if (key) void session?.set({ [key]: Date.now() }).catch(() => {});
  if (!page.tabId) return;
  const answer = await send({ type: 'cartscout:scan-watch', host: page.host });
  if (answer?.ok === true && loading === mine) couponScene.note(WATCH_NOTE);
}

/** Follow an already-running scan by polling stored-only (`cacheOnly: true`), so it can never start a second paid scan. */
async function followInProgress(mine) {
  showScanning();
  void followScan(mine);
  const deadline = Date.now() + FOLLOW_LIMIT_MS;
  while (loading === mine && Date.now() < deadline) {
    await wait(FOLLOW_EVERY_MS);
    if (loading !== mine) return;
    try {
      const data = await api('/v1/coupons', { cacheOnly: true }, { signal: mine.controller.signal });
      if (loading !== mine) return;
      if (Array.isArray(data.coupons)) {
        renderCoupons(data, { fresh: true });
        if (data.source !== 'stale') scanSeen();
        remember();
        return;
      }
    } catch (error) {
      if (loading !== mine || error.quiet || !account) return;
      if (error.code === 'scan_in_progress') continue;
      if (error.code === 'scan_required') scanSeen();
      showCouponError(error, () => loadCoupons({ cacheOnly: true }));
      return;
    }
  }
  if (loading === mine) {
    showCouponError(new Error('This scan is taking longer than usual. Reopen CartScout in a moment.'), () => loadCoupons({ cacheOnly: true }));
  }
}

/**
 * Ask for this shop's codes. Defaults to stored-only (`cacheOnly = true`) on every plan,
 * so opening or refreshing the popup NEVER spends Oxylabs requests without an explicit click.
 */
async function loadCoupons({ cacheOnly = true, scan = false, force = false, quiet = false, joined = false } = {}) {
  loading?.controller.abort();
  const controller = new AbortController();
  const mine = { controller, scan };
  loading = mine;
  const searched = scan;
  views.coupons.setAttribute('aria-busy', 'true');
  if (scan) {
    showScanning();
    void followScan(mine);
  } else if (!quiet) {
    const held = main.contains(document.activeElement) && views.coupons.contains(document.activeElement);
    couponScene.hide();
    emptyList();
    list.replaceChildren(...createSkeletons(couponSkeleton, 3));
    look('search');
    say(`Checking ${merchant}…`);
    if (held && lostFocus()) tabs.coupons.focus({ preventScroll: true });
  }
  try {
    const [data] = await Promise.all([
      api('/v1/coupons', { cacheOnly, ...(force && { force: true }) }, { signal: controller.signal }),
      pageCodesReady,
    ]);
    if (loading !== mine) return;
    if (!Array.isArray(data.coupons)) throw new Error('CartScout sent an answer Scout couldn’t read. Try again in a moment.');
    const settled = data.source !== 'stale';
    renderCoupons(data, { fresh: (searched && data.source === 'live') || joined || (unseenScan && settled) });
    if (settled) scanSeen();
    remember();
  } catch (error) {
    if (loading !== mine || error.quiet || !account) return;
    await pageCodesReady;
    if (loading !== mine) return;
    if (error.code === 'scan_in_progress') {
      await followInProgress(mine);
      return;
    }
    if (error.code === 'scan_required') scanSeen();
    if (quiet && !['scan_required', 'scan_limit', 'budget_reached', 'live_off'].includes(error.code)) {
      say(summary);
      notify('Couldn’t refresh just now. This is what Scout had a moment ago.');
      return;
    }
    showCouponError(error, () => loadCoupons({ cacheOnly, scan, force }));
  } finally {
    if (loading === mine) {
      loading = null;
      views.coupons.removeAttribute('aria-busy');
    }
  }
}

// ---- Checkout run -------------------------------------------------------------------------

const runKey = () => `run:${page.tabId}`;

async function send(message) {
  try {
    return await chrome.runtime.sendMessage({ ...message, tabId: page.tabId });
  } catch {
    return undefined;
  }
}

const dock = createDock(element('dock'), {
  onStart: () => startRun({ pick: false }),
  onPick: () => startRun({ pick: true }),
  onCarryOn: carryOn,
  onOpenBasket: openBasket,
  onStop: () => {
    if (!run || run.stopRequested) return;
    applyRun({ ...run, stopRequested: true });
    void send({ type: 'cartscout:run-stop' });
  },
  onClear: () => {
    const localRun = run?.local;
    applyRun(null);
    if (!localRun) void send({ type: 'cartscout:run-clear' });
  },
});

function currentDockPlan() {
  const codes = Math.min(coupons.length, RUN_LIMIT);
  return dockPlan({
    probe: page.probe,
    codes,
    handed: page.handed,
    pauseUntil: page.pauseUntil,
  });
}

function syncDock() {
  const visible = !!account && view === 'coupons' && (!!run || leaving || coupons.length > 0);
  const codes = Math.min(coupons.length, RUN_LIMIT);
  const plan = currentDockPlan();
  dock.render({
    visible,
    run,
    leaving,
    opening,
    codes,
    onPage: Math.min(pageCount, codes),
    confirmed: Math.min(confirmedCount, Math.max(0, codes - pageCount)),
    plan,
  });
}

const celebrated = new Set();

async function once(key) {
  if (celebrated.has(key)) return false;
  celebrated.add(key);
  const stored = await session?.get(key).catch(() => undefined);
  if (stored?.[key]) return false;
  void session?.set({ [key]: true }).catch(() => {});
  return true;
}

async function celebrateOnce(saved) {
  if (await once(`celebrated:${page.tabId}:${saved.startedAt}`)) void celebrate({ origin: element('run-headline') });
}

const reflectedVotes = new Set();
let countsTimer;

async function refreshCounts() {
  try {
    const data = await api('/v1/coupons', { cacheOnly: true });
    if (Array.isArray(data.coupons) && shown) {
      shown = { ...shown, coupons: data.coupons };
      renderCoupons(shown, { at: Date.now() });
      remember();
      return;
    }
    const fresh = new Map(printable(data.coupons).map((coupon) => [coupon.code, coupon]));
    for (const ticket of tickets) {
      const next = fresh.get(ticket.code);
      if (next) ticket.update({ worked: next.worked, failed: next.failed, myReport: next.myReport });
    }
    remember();
  } catch {
    // Counts catch up next open.
  }
}

function reflectVotes() {
  if (!run || run.local || !tickets.length || !account) return;
  if ((run.merchant ?? (run.host ?? '').replace(/^www\./, '')) !== merchant) return;
  let due = false;
  for (const result of run.results ?? []) {
    if (typeof result.vote !== 'boolean') continue;
    const key = `${run.startedAt}:${result.code}`;
    const ticket = tickets.find(({ code }) => sameCode(code, result.code));
    if (!ticket || ticket.coupon.myReport === Number(result.vote) || reflectedVotes.has(key)) continue;
    reflectedVotes.add(key);
    due = true;
  }
  if (!due) return;
  clearTimeout(countsTimer);
  countsTimer = setTimeout(refreshCounts, 700);
}

function reflectRun(again = false) {
  if (!account || !run) return;
  const key = `${run.status}:${run.startedAt}`;
  if (RUN_ACTIVE.includes(run.status)) {
    look('work');
    const place = run.index && run.total ? `Trying code ${run.index} of ${run.total}` : '';
    const trying = run.code ? String(run.code).toUpperCase() : '';
    say(
      place ? [place, trying].filter(Boolean).join(' · ') : trying ? `Trying ${trying} at checkout…` : 'Getting ready to try codes…',
      { lasting: false, code: trying },
    );
  } else if (run.status === 'pick') {
    look('wave');
    say('Click the code box on the page', { lasting: false });
  } else if (again || key !== reflected) {
    if (run.status === 'saved') {
      look('party');
      const winCode = String(run.saving?.code ?? run.code).toUpperCase();
      const beat = Number.isInteger(run.saving?.beat) && run.saving.beat > 0 ? run.saving.beat : 0;
      say(beat > 0 ? `Best saving: ${winCode} (${beat + 1} worked)` : `Saved with ${winCode}`, { lasting: false, code: winCode });
      void celebrateOnce(run);
    } else {
      look(run.status === 'applied' ? 'happy' : run.status === 'error' ? 'oops' : 'shrug');
      if (summary) say(summary);
    }
  }
  reflected = key;
}

function applyRun(next) {
  const cleared = run && !next;
  run = next ?? null;
  if (shown && (!run || !RUN_ACTIVE.includes(run.status))) {
    renderCoupons(shown, { at: listedAt });
  } else {
    applyTrialResults();
    syncDock();
    reflectRun();
    reflectVotes();
  }
  if (cleared && account) {
    look('idle');
    if (summary) say(summary);
  }
}

async function startRun({ pick = false } = {}) {
  if (leaving || !coupons.length || (run && RUN_ACTIVE.includes(run.status))) return;
  const listed = coupons.map(({ reportCode, pageOnly, ...coupon }) => ({ ...coupon, code: reportCode ?? coupon.code }));
  const response = await send({ type: 'cartscout:run-start', coupons: listed, merchant, pick });
  if (!response?.ok) {
    applyRun({
      local: true, status: 'error', results: [], total: 0,
      message: typeof response?.error === 'string' && response.error
        ? response.error : 'Scout couldn’t reach your basket. Reload the page, then try again.',
    });
    return;
  }
  if (run?.local) run = null;
  leaving = true;
  look('work');
  say(pick ? 'Click the code box on the page…' : 'Heading to your basket…', { lasting: false });
  syncDock();
  await beat(900);
  if (!pinnedTab) window.close();
  leaving = false;
  syncDock();
}

async function carryOn() {
  if (leaving || !run?.rest?.length) return;
  const response = await send({ type: 'cartscout:run-rest' });
  if (!response?.ok) {
    notify(typeof response?.error === 'string' ? response.error : 'Scout couldn’t carry on. Try again.');
    return;
  }
  leaving = true;
  look('work');
  say('Heading to your basket…', { lasting: false });
  syncDock();
  await beat(900);
  if (!pinnedTab) window.close();
  leaving = false;
  syncDock();
}

/** Navigate to the shop's same-origin basket path reported by the probe, then re-probe. */
async function openBasket() {
  const plan = currentDockPlan();
  if (opening || !page.tabId || !plan.cart || !page.origin) return;
  let targetUrl;
  try { targetUrl = new URL(plan.cart, page.origin).href; } catch { return; }
  opening = true;
  syncDock();
  let arrived = false;
  try {
    await chrome.tabs.update(page.tabId, { url: targetUrl });
    for (let tries = 0; tries < 40 && !arrived; tries += 1) {
      await wait(300);
      const tab = await chrome.tabs.get(page.tabId);
      arrived = tab?.status === 'complete' && !!tab.url;
    }
  } catch {
    arrived = false;
  }
  opening = false;
  if (arrived) {
    const tab = await chrome.tabs.get(page.tabId).catch(() => null);
    if (tab?.url) {
      page.url = tab.url;
      page.myproteinBasket = isMyproteinBasket(tab.url);
      page.basket = page.myproteinBasket || isBasketUrl(tab.url);
      compare?.moved();
    }
    await probePage();
    element('basket-marker').hidden = !(page.probe && ['found', 'behind', 'recipe'].includes(page.probe.box));
  } else {
    notify('Open your basket on this shop, then click CartScout to try these codes.');
  }
  syncDock();
}

async function watchRun() {
  if (!page.tabId || !session) return;
  const onChange = (changes) => {
    if (Object.hasOwn(changes, runKey())) applyRun(changes[runKey()].newValue);
  };
  if (session.onChanged) session.onChanged.addListener(onChange);
  else chrome.storage.onChanged.addListener((changes, area) => area === 'session' && onChange(changes));
  const stored = await session.get(runKey()).catch(() => undefined);
  if (stored?.[runKey()]) applyRun(stored[runKey()]);
}

// ---- Views --------------------------------------------------------------------------------

function switchView(next) {
  if (next === view) return;
  const held = views[view].contains(document.activeElement);
  view = next;
  for (const [name, tab] of Object.entries(tabs)) {
    tab.setAttribute('aria-selected', String(name === next));
    tab.tabIndex = name === next ? 0 : -1;
    views[name].hidden = name !== next;
  }
  main.scrollTop = 0;
  syncDock();
  if (held) tabs[next].focus({ preventScroll: true });
  if (!prefersReducedMotion()) {
    views[next].animate(
      [{ opacity: 0.4, translate: `${next === 'alternatives' ? 12 : -12}px 0` }, { opacity: 1, translate: '0 0' }],
      { duration: 180, easing: 'cubic-bezier(.2, .8, .2, 1)' },
    );
  }
}

for (const [name, tab] of Object.entries(tabs)) {
  tab.addEventListener('click', () => switchView(name));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const other = name === 'coupons' ? 'alternatives' : 'coupons';
    switchView(other);
    tabs[other].focus();
  });
}

// ---- Sign-in and start-up -----------------------------------------------------------------

function clearShoppingData() {
  loading?.controller.abort();
  loading = null;
  painted = false;
  copiedCouponKey = undefined;
  copiedCodes.clear();
  couponScene.hide();
  emptyList();
  compare?.reset();
  switchView('coupons');
}

function showNotAShop() {
  look('idle');
  emptyList();
  if (page.gone) {
    look('shrug');
    say('That tab has closed');
    couponScene.show({
      mood: 'shrug',
      headline: 'That tab has closed',
      body: 'Open CartScout from the toolbar on the shop you’re on.',
    });
    return;
  }
  if (page.shop) {
    say('Not a public shop');
    couponScene.show({
      headline: 'Scout only works on public shops',
      body: `${page.host} is a private or local address, so there are no public codes to look for.`,
    });
    return;
  }
  say('No shop on this tab');
  couponScene.show({
    headline: 'Open a shop and Scout will look for codes',
    body: 'This tab isn’t a shop Scout can read. Head to a shop, then open CartScout again.',
  });
}

async function openPortal(intent) {
  void session?.set({ portalVisit: { intent, at: Date.now() } }).catch(() => {});
  try {
    await openAccountPortal(intent);
    portalPending = true;
    const next = intent === 'signin'
      ? 'Sign in on the page that opened, then press “I’ve signed in” here.'
      : 'When you’re done on the account page, press Refresh above.';
    welcomeStatus.textContent = intent === 'signin' ? next : '';
    welcomeStatus.dataset.tone = '';
    if (intent !== 'signin') notify(next);
  } catch {
    void session?.remove('portalVisit').catch(() => {});
    const message = 'Couldn’t open your CartScout account. Try again.';
    notify(message);
    welcomeStatus.textContent = message;
    welcomeStatus.dataset.tone = 'error';
  }
}

async function afterPortal(previous) {
  const visit = (await session?.get('portalVisit').catch(() => undefined))?.portalVisit;
  const recent = visit && Date.now() - visit.at < PORTAL_MEMORY_MS;
  if (!account) {
    if (recent || portalPending) {
      welcomeStatus.textContent = 'Not signed in yet. Finish on the account page, then press “I’ve signed in”.';
      welcomeStatus.dataset.tone = '';
    }
    return;
  }
  if (previous && previous.plan !== account.plan) {
    notify(account.plan === 'pro'
      ? 'You’re on Pro: no weekly scan limit, and other Pro members’ thumbs on each code.'
      : 'You’re on the Free plan now: 5 shop scans a week.');
  } else if (recent && visit.intent === 'billing' && account.plan !== 'pro') {
    notify('Upgraded? Press Refresh above once your payment has gone through.');
  }
  portalPending = false;
  if (visit) void session?.remove('portalVisit').catch(() => {});
}

function showAccountProblem(error, kind) {
  if (account) {
    notify(kind === 'reach' ? 'Scout can’t reach CartScout right now. Check your connection.' : error.message);
    return;
  }
  look('oops');
  say(kind === 'reach' ? 'Can’t reach CartScout' : 'Couldn’t check sign-in');
  element('account-detail').textContent = kind === 'reach' ? 'Not connected' : 'Couldn’t check sign-in';
  list.replaceChildren();
  couponScene.show({
    mood: 'oops',
    headline: kind === 'reach' ? 'Scout can’t reach CartScout' : 'Scout couldn’t check your sign-in',
    body: kind === 'reach' && error.code !== 'unreachable'
      ? 'CartScout didn’t answer properly. Give it a moment, then try again.' : error.message,
    action: { label: 'Try again', run: refreshAccount },
  });
}

async function refreshAccount({ fresh = false } = {}) {
  if (refreshing) return;
  refreshing = true;
  accountRefresh.setAttribute('aria-disabled', 'true');
  document.body.dataset.busy = '';
  const previous = account;
  try {
    const visit = (await session?.get('portalVisit').catch(() => undefined))?.portalVisit;
    const needFresh = fresh || portalPending || (visit && Date.now() - visit.at < PORTAL_MEMORY_MS);
    let token;
    try {
      token = await getClerkToken({ fresh: needFresh });
    } catch (error) {
      showAccountProblem(error, 'sync');
      return;
    }
    accountReady = true;
    if (!token) {
      signedOut();
      await afterPortal(previous);
      return;
    }

    const tokenUid = tokenUser(token);
    if (!painted && tokenUid) await paintRemembered(tokenUid);

    const fetchAccount = async (tok) => {
      const res = await api('/v1/account', undefined, { sessionToken: tok });
      if (typeof res.userId !== 'string') throw new Error('CartScout sent an answer Scout couldn’t read.');
      return res;
    };

    // Start coupons lookup in parallel with /v1/account when we already know this shop,
    // avoiding a serial 2-round-trip waterfall on every popup open.
    const couponsEarly = merchant && !loading
      ? loadCoupons({ cacheOnly: true, quiet: painted || tickets.length > 0 })
      : null;

    let current;
    try {
      current = await fetchAccount(token);
    } catch (error) {
      if (!needFresh && error?.status === 401) {
        try {
          token = await getClerkToken({ fresh: true });
          if (!token) {
            signedOut();
            await afterPortal(previous);
            return;
          }
          current = await fetchAccount(token);
        } catch (retryError) {
          if (!retryError.quiet) showAccountProblem(retryError, 'reach');
          return;
        }
      } else {
        if (!error.quiet) showAccountProblem(error, 'reach');
        return;
      }
    }

    const known = account ?? previous;
    const changedAccount = known && (known.userId !== current.userId || known.plan !== current.plan);
    if (changedAccount) {
      clearShoppingData();
      void forgetEverything();
    }
    renderAccount(current);
    rememberAccount(current);
    welcomeStatus.textContent = '';
    syncDock();
    void afterPortal(known);
    if (!merchant) {
      showNotAShop();
      return;
    }
    void Promise.all([restoreCopied(current.userId), restoreUnseenScan()]);
    void probeReady.then(() => {
      element('basket-marker').hidden = !(page.probe && ['found', 'behind', 'recipe'].includes(page.probe.box));
      syncDock();
    });
    void compare?.prepare();
    if (changedAccount || !couponsEarly) {
      if (!loading) void loadCoupons({ cacheOnly: true, quiet: painted || tickets.length > 0 });
    }
  } finally {
    refreshing = false;
    accountRefresh.removeAttribute('aria-disabled');
    delete document.body.dataset.busy;
  }
}

accountAction.addEventListener('click', () => openPortal(account ? 'billing' : 'signin'));
accountUpgrade.addEventListener('click', () => openPortal('billing'));
helpButton.addEventListener('click', async () => {
  try {
    await openAccountPortal('home');
  } catch {
    notify('Couldn’t open the CartScout guide. Try again.');
  }
});
element('sign-in').addEventListener('click', () => openPortal('signin'));
element('welcome-refresh').addEventListener('click', () => refreshAccount({ fresh: true }));
accountRefresh.addEventListener('click', () => refreshAccount({ fresh: true }));
window.addEventListener('focus', () => {
  if (portalPending) void refreshAccount({ fresh: true });
});

/** Myprotein UK basket has its own dedicated reader; all other cart/checkout pages use the universal basket reader. */
function isMyproteinBasket(href) {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && ['www.myprotein.com', 'myprotein.com'].includes(url.hostname) && /^\/basket\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function isBasketUrl(href) {
  try {
    const url = new URL(href);
    return ['https:', 'http:'].includes(url.protocol) && isBasketPath(url.pathname);
  } catch {
    return false;
  }
}

function isPublicHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host.length <= 253
    && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
    && !/\.(?:local|localhost|internal|invalid|test|example|onion|lan)$/.test(host);
}

async function currentTab() {
  if (pinnedTab) return chrome.tabs.get(pinnedTab);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function start() {
  let tab;
  try {
    tab = await currentTab();
  } catch {
    tab = undefined;
  }
  if (pinnedTab && !tab) page = { ...page, gone: true };
  let url = null;
  try {
    url = tab?.url ? new URL(tab.url) : null;
  } catch {
    url = null;
  }
  let handed = false;
  let initialView = '';
  const note = Number.isInteger(tab?.id) && !pinnedTab
    ? (await session?.get(HANDOVER_KEY).catch(() => undefined))?.[HANDOVER_KEY]
    : null;
  if (note && Number.isInteger(tab?.id)) {
    initialView = handedView(note, tab.id, Date.now());
    if (!url) {
      const host = handedHost(note, tab.id, Date.now());
      if (host) {
        url = new URL(`https://${host}/`);
        handed = true;
      }
    }
  }
  void session?.remove(HANDOVER_KEY).catch(() => {});
  if (url && ['https:', 'http:'].includes(url.protocol)) {
    const bare = url.hostname.replace(/^www\./, '');
    merchant = isPublicHost(url.hostname) ? bare : undefined;
    element('merchant').textContent = bare;
    element('merchant').title = bare;
    if (merchant) say(`Checking ${merchant}…`);
    const mpBasket = !handed && !!tab.id && isMyproteinBasket(url.href);
    page = {
      tabId: tab.id ?? null,
      host: url.hostname,
      origin: url.origin,
      url: tab.url,
      shop: true,
      merchant,
      myproteinBasket: mpBasket,
      basket: !handed && !!tab.id && (mpBasket || isBasketUrl(url.href)),
      probe: null,
      pauseUntil: 0,
      handed,
    };
  }
  pageCodesReady = Promise.race([readOwnCodes(), wait(700)]);
  probeReady = Promise.race([probePage(), wait(900)]);
  compare = createCompare({
    root: views.alternatives,
    page,
    send,
    session,
    look,
    skeleton: element('offer-skeleton'),
    signedIn: () => !!account,
    savingButton: element('cached-saving'),
    openAlternatives: () => switchView('alternatives'),
  });
  if (initialView === 'alternatives') switchView('alternatives');

  // Paint remembered account + shop coupons immediately (~2ms) before hitting the network;
  // only show skeletons when there is no cached view for this shop yet.
  const hadCache = await paintInstantCache();
  if (!hadCache && merchant) list.replaceChildren(...createSkeletons(couponSkeleton, 3));

  await Promise.all([refreshAccount(), watchRun()]);
}

start().catch(() => {
  look('oops');
  say('Something went wrong');
  list.replaceChildren();
  couponScene.show({
    mood: 'oops',
    headline: 'CartScout couldn’t start',
    body: 'Close this window and open CartScout again.',
    action: { label: 'Try again', run: () => location.reload() },
  });
});
