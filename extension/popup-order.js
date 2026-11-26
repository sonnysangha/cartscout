// The order coupon tickets are shown in (which is also the order a checkout run tries them in), which codes count
// as confirmed by other members, which group headings each plan sees, which key copies which ticket, and how a
// long code is cut to fit a sentence.
// Pure: no DOM and no chrome.*, so the rules are covered by server/popup-order.test.js.

// Headings truthfully separate codes that worked on this shopper's basket / for them,
// codes advertised on the page, codes other members confirmed, and unconfirmed codes.
export const HEADINGS = {
  workedBasket: 'Worked on your basket',
  workedYou: 'Worked for you',
  page: 'On this page',
  confirmed: 'Worked for other members',
  rest: 'Not confirmed by other members',
  web: 'Found on the web',
};

export const tally = (value) => (Number.isInteger(value) && value > 0 ? value : 0);
export const sameCode = (one, other) => String(one).toUpperCase() === String(other).toUpperCase();

// "Worked for others" has to mean others: the shopper's own thumb is taken out before comparing.
export const othersUp = (coupon) => Math.max(0, tally(coupon.worked) - Number(coupon.myReport === 1));
export const othersDown = (coupon) => Math.max(0, tally(coupon.failed) - Number(coupon.myReport === 0));
/** More other members said it worked than said it didn't. */
export const leads = (coupon) => othersUp(coupon) > othersDown(coupon);

/** A code other members have confirmed. Only Pro sees shared reports, so on Free nothing is ever "working". */
export function isWorking(coupon, shared) {
  return Boolean(shared) && leads(coupon);
}

/**
 * Codes are printed, copied and tried in upper case: shops print them that way and do not mind the casing.
 * `reportCode` keeps the API's own spelling, which is what a thumb is filed under. The same code listed in two
 * casings is shown once, keeping the one with more thumbs.
 */
export function printable(list) {
  const seen = new Map();
  for (const coupon of Array.isArray(list) ? list : []) {
    if (typeof coupon?.code !== 'string' || !coupon.code) continue;
    const next = { ...coupon, code: coupon.code.toUpperCase(), reportCode: coupon.reportCode ?? coupon.code };
    const held = seen.get(next.code);
    if (!held || tally(next.worked) + tally(next.failed) > tally(held.worked) + tally(held.failed)) seen.set(next.code, next);
  }
  return [...seen.values()];
}

/**
 * Sort the server's list and the codes read from the shop's own page (`[{ code, offer }]`, codes in upper case)
 * into four groups:
 *   1. `worked`: codes that worked on this basket (in `run`) or that this shopper confirmed (`myReport === 1`),
 *      with the active run's best-saving winner first, then other run winners by highest saving, then net support.
 *   2. `onPage`: remaining codes the shop shows on its page.
 *   3. `confirmed`: remaining codes other members confirmed, ordered by net support then thumbs-up.
 *   4. `rest`: remaining codes not confirmed as working.
 * A page code the server also lists is one ticket, the server's, kept with `onPage` (or promoted to `worked` if it worked).
 */
export function arrange(list, pageCodes = [], run = null) {
  const server = printable(list);
  const listed = new Map(server.map((coupon) => [coupon.code, coupon]));
  const pageMerged = pageCodes.map(({ code, offer }) => (listed.has(code)
    ? { ...listed.get(code), offer: listed.get(code).offer || offer, onPage: true }
    : { code, reportCode: code, offer, worked: 0, failed: 0, onPage: true, pageOnly: true }));
  const here = new Set(pageMerged.map((coupon) => coupon.code));
  const pool = [...pageMerged, ...server.filter((coupon) => !here.has(coupon.code))];

  const results = new Map((run?.results ?? []).map((result) => [String(result?.code ?? '').toUpperCase(), result]));
  const landed = ['saved', 'applied'].includes(run?.status);
  const winnerCode = landed && run?.code ? String(run.code).toUpperCase() : '';
  const savingOf = (coupon) => {
    const res = results.get(coupon.code);
    if (winnerCode && coupon.code === winnerCode && Number.isFinite(run?.saving?.amount)) {
      return run.saving.amount;
    }
    return Number.isFinite(res?.saved) ? res.saved : 0;
  };
  const workedInRun = (coupon) => (
    (Boolean(winnerCode) && coupon.code === winnerCode)
    || results.get(coupon.code)?.outcome === 'applied'
  );
  const rejectedInRun = (coupon) => {
    const outcome = results.get(coupon.code)?.outcome;
    return outcome === 'rejected' || outcome === 'error';
  };
  const workedForMe = (coupon) => workedInRun(coupon) || (!rejectedInRun(coupon) && coupon.myReport === 1);

  const worked = pool.filter(workedForMe)
    .map((coupon, index) => ({
      coupon,
      index,
      winner: Number(Boolean(winnerCode) && coupon.code === winnerCode),
      inRun: Number(workedInRun(coupon)),
      saved: savingOf(coupon),
      net: tally(coupon.worked) - tally(coupon.failed),
      up: tally(coupon.worked),
    }))
    .sort((a, b) => (
      b.winner - a.winner
      || b.inRun - a.inRun
      || b.saved - a.saved
      || b.net - a.net
      || b.up - a.up
      || a.index - b.index
    ))
    .map(({ coupon }) => coupon);

  const workedCodes = new Set(worked.map((coupon) => coupon.code));
  const onPage = pageMerged.filter((coupon) => !workedCodes.has(coupon.code));
  const others = server.filter((coupon) => !here.has(coupon.code) && !workedCodes.has(coupon.code));
  const confirmed = others.filter(leads)
    .map((coupon, index) => ({ coupon, index, net: othersUp(coupon) - othersDown(coupon), up: othersUp(coupon) }))
    .sort((a, b) => b.net - a.net || b.up - a.up || a.index - b.index)
    .map(({ coupon }) => coupon);
  const rest = others.filter((coupon) => !leads(coupon));
  const workedFromRun = worked.some(workedInRun);
  return { worked, workedFromRun, onPage, confirmed, rest, listed: server.length };
}

/**
 * The groups in display order, each `[title, coupons]`; an empty title means no heading, an empty group no rows.
 */
export function groupsFor({ worked = [], workedFromRun = false, onPage, confirmed, rest }, pro) {
  const hasWorked = worked.length > 0;
  const hasPage = onPage.length > 0;
  const workedTitle = hasWorked ? (workedFromRun ? HEADINGS.workedBasket : HEADINGS.workedYou) : '';
  if (!pro) {
    const web = [...confirmed, ...rest];
    const split = hasWorked || hasPage;
    return [
      [workedTitle, worked],
      [hasPage ? HEADINGS.page : '', onPage],
      [split && web.length ? HEADINGS.web : '', web],
    ];
  }
  const hasConfirmed = confirmed.length > 0;
  const hasRest = rest.length > 0;
  const hasAboveRest = hasWorked || hasPage || hasConfirmed;
  return [
    [workedTitle, worked],
    [hasPage ? HEADINGS.page : '', onPage],
    [hasConfirmed ? HEADINGS.confirmed : '', confirmed],
    [hasAboveRest && hasRest ? HEADINGS.rest : '', rest],
  ];
}

/** The headings a shopper actually sees, top to bottom. */
export function shownTitles(groups) {
  return groups.filter(([title, group]) => title && group.length).map(([title]) => title);
}

// ---- Keyboard shortcuts (WCAG 2.1.4) ---------------------------------------------------------

export const SHORTCUTS_KEY = 'copyShortcuts';

/** What the stored flag means: the shortcuts are on unless they were explicitly switched off. */
export const shortcutsOn = (stored) => stored !== false;

/**
 * The place (1 to 9) a key press asks for, or 0 when it is not a shortcut.
 */
export function shortcutPlace(event, on = true) {
  if (!on || !event || event.defaultPrevented || event.repeat || event.isComposing) return 0;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return 0;
  const key = typeof event.key === 'string' ? event.key : '';
  if (key.toLowerCase() === 'c') return 1;
  return /^[1-9]$/.test(key) ? Number(key) : 0;
}

/**
 * What the ticket in this place (counted from 0) says about its own shortcut.
 */
export function shortcutHints(index, on = true) {
  if (!on || !Number.isInteger(index) || index < 0 || index > 8) return { keys: '', title: '' };
  return index === 0
    ? { keys: 'C 1', title: 'Shortcut: press C to copy this code, or 1 to 9 to copy the ticket in that place' }
    : { keys: String(index + 1), title: '' };
}

// ---- Long codes ------------------------------------------------------------------------------

/**
 * A code cut in the middle to `limit` characters, the ellipsis included.
 */
export function middleCut(code, limit) {
  const whole = String(code);
  const room = Math.max(5, Math.floor(Number(limit)) || 0);
  if (whole.length <= room) return whole;
  const head = Math.ceil((room - 1) / 2);
  return `${whole.slice(0, head)}…${whole.slice(whole.length - (room - 1 - head))}`;
}
