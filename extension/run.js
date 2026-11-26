// The generic checkout run engine (D1–D10).
// The service worker owns the loop one code at a time: it writes the code in flight to storage.session,
// calls the self-contained page bundle (`autotry.js`), classifies the evidence (`verdict.js`), survives
// same-origin reloads, runs best-saving mode where safe, and supports shopper-picked code boxes.
// Everything Chrome-specific is passed in, so the entire state machine runs under `node --test`.

import {
  AUTOTRY_FILE, bareHost, BEST_SOFT_MS, CALL_LIMIT_MS, DOCKS, LEAVE_GRACE_MS, MAX_LOADS,
  MAX_PAUSE_MS, MAX_UNCLEAR, MISSES_TO_FORGET, NO_REACTION, PANEL_FILE, PAUSE_MS, pauseKey,
  pickKey, POLL_MS, RECHECK_PAGE_MS, RELOAD_WAIT_MS, RUN_BUDGET_MS, RUN_LIMIT,
} from './autotry/limits.js';
import { formatMoney } from './autotry/money.js';
import { expiredPickKeys, makePickRecord, validatePickPart } from './autotry/pick.js';
import { classifyAnswer, reasonCopy } from './autotry/verdict.js';

export { AUTOTRY_FILE, CALL_LIMIT_MS, PANEL_FILE, POLL_MS, RECHECK_PAGE_MS, RUN_LIMIT };

const noop = () => {};
const tally = (value) => (Number.isInteger(value) && value > 0 ? value : 0);
const TIMED_OUT = new Error('timed out');

function within(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(reject, ms, TIMED_OUT); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

export const runKey = (tabId) => `run:${tabId}`;
export const isActive = (run) => run?.status === 'starting' || run?.status === 'trying';

/**
 * Serialisable page-side dispatcher (no imports). Calls one step on the injected `autotry.js` bundle.
 */
export function pageCall(command, payload) {
  const api = globalThis.__cartScoutAutoTry;
  if (!api || typeof api[command] !== 'function') return { gone: true };
  return api[command](payload);
}

/** Serialisable page-side document probe (no imports) to distinguish old vs new documents across reloads. */
export function docProbe() {
  return {
    doc: globalThis.__cartScoutAutoTry?.doc ?? null,
    ready: typeof document !== 'undefined' ? document.readyState : 'complete',
  };
}

/**
 * What a run will try, in the order it was given: up to RUN_LIMIT deduplicated codes.
 * Codes are typed in upper case; `proof` keeps each one's thumbs and the casing the API listed it in.
 */
export function planFrom(coupons) {
  const proof = {};
  let provenFirst = false;
  for (const coupon of Array.isArray(coupons) ? coupons : []) {
    const listed = typeof coupon === 'string' ? coupon : coupon?.code;
    if (typeof listed !== 'string' || !/^[a-z0-9_-]{3,40}$/i.test(listed)) continue;
    const code = listed.toUpperCase();
    if (Object.hasOwn(proof, code)) continue;
    if (Object.keys(proof).length === RUN_LIMIT) break;
    const worked = tally(coupon?.worked);
    const failed = tally(coupon?.failed);
    proof[code] = { listed, worked, failed };
    provenFirst ||= Math.max(0, worked - Number(coupon?.myReport === 1)) > Math.max(0, failed - Number(coupon?.myReport === 0));
  }
  return { codes: Object.keys(proof), proof, provenFirst };
}

export const codesFrom = (coupons) => planFrom(coupons).codes;

/** Codes from this run that never reached the code box, in original order. */
export function restOf(run) {
  const tried = new Set((run.results ?? []).map(({ code }) => code));
  if (run.code) tried.add(run.code);
  return Object.keys(run.proof ?? {}).filter((code) => !tried.has(code));
}

function countOf(count) {
  return count === 1 ? '1 code' : `${count} codes`;
}

function noneMessage(tried, results) {
  const refused = results.filter(({ outcome }) => outcome === 'rejected').length;
  const unclear = results.filter(({ outcome }) => outcome === 'error').length;
  if (unclear) return `${refused} turned down, ${unclear} unclear. Your basket hasn’t changed.`;
  if (tried === 1) return 'Scout tried the code and the shop turned it down. Your basket hasn’t changed.';
  return `Scout tried ${tried === 2 ? 'both codes' : `all ${tried}`} and the shop turned each one down. Your basket hasn’t changed.`;
}

function buildSaving(code, beforeMoney, afterVal) {
  const before = beforeMoney.value;
  const amount = Math.max(0, Number((before - afterVal).toFixed(4)));
  const fmt = beforeMoney.format ?? null;
  const currency = beforeMoney.currency ?? '';
  return {
    code,
    amount,
    before,
    after: afterVal,
    currency,
    format: fmt,
    text: {
      amount: formatMoney(amount, fmt, currency),
      before: beforeMoney.text || formatMoney(before, fmt, currency),
      after: formatMoney(afterVal, fmt, currency),
    },
  };
}

/**
 * Who sent a runtime message: the popup (`/popup.html`), the in-page panel (frame 0 of a tab), or nobody.
 */
export function senderRole(sender, { id, origin }) {
  if (!sender || sender.id !== id || typeof sender.url !== 'string') return null;
  let url;
  try { url = new URL(sender.url); } catch { return null; }
  if (`${url.protocol}//${url.host}` === origin) return url.pathname === '/popup.html' ? 'popup' : null;
  return Number.isInteger(sender.tab?.id) && sender.frameId === 0 ? 'panel' : null;
}

/**
 * Turns each strong-evidence answer from a shop into a thumb on the API: POST /v1/reports.
 */
export function createReporter({ fetch, apiOrigin, token }) {
  async function post(bearer, body) {
    return fetch(new URL('/v1/reports', apiOrigin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  }
  return async function report({ host, merchant, code, worked, savedAmount, savedCurrency }) {
    try {
      const body = {
        merchant: merchant || bareHost(host),
        code,
        worked,
        ...(worked && Number.isFinite(savedAmount) && savedAmount > 0 ? { savedAmount } : {}),
        ...(worked && typeof savedCurrency === 'string' && /^[A-Za-z]{3}$/.test(savedCurrency) ? { savedCurrency: savedCurrency.toUpperCase() } : {}),
      };
      let bearer = await token(false);
      if (!bearer) return false;
      let response = await post(bearer, body);
      if (response.status === 401) {
        bearer = await token(true);
        if (!bearer) return false;
        response = await post(bearer, body);
      }
      return response.ok;
    } catch {
      return false;
    }
  };
}

export function createRunEngine({
  scripting, tabs, storage, picks = null, action = null, report = null,
  callLimit = CALL_LIMIT_MS,
  reloadWait = RELOAD_WAIT_MS,
  pollMs = POLL_MS,
  runBudget = RUN_BUDGET_MS,
  bestSoft = BEST_SOFT_MS,
  leaveGrace = LEAVE_GRACE_MS,
  now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const runs = new Map();
  const loops = new Set();
  const reported = new Set();
  const loadingTabs = new Map();

  async function injectPanel(tabId) {
    await scripting.executeScript({ target: { tabId }, files: [PANEL_FILE] });
  }

  async function injectBundle(tabId) {
    await scripting.executeScript({ target: { tabId }, files: [AUTOTRY_FILE] });
  }

  async function push(run, { reattach = true } = {}) {
    if (run.panelDismissed) return;
    const message = { type: 'cartscout:run-state', run };
    try {
      await tabs.sendMessage(run.tabId, message);
    } catch {
      if (!reattach) return;
      try {
        await injectPanel(run.tabId);
        await tabs.sendMessage(run.tabId, message);
      } catch {
        // Tab closed or out of reach; loop detects on next step.
      }
    }
  }

  async function publish(run, options) {
    await storage.set({ [runKey(run.tabId)]: run }).catch(noop);
    await push(run, options);
  }

  function sendThumbs(run) {
    if (!report) return;
    for (const { code, vote, saved } of run.results) {
      const key = `${run.tabId}:${run.startedAt}:${code}`;
      if (typeof vote !== 'boolean' || reported.has(key)) continue;
      reported.add(key);
      void Promise.resolve()
        .then(() => report({
          host: run.host,
          merchant: run.merchant,
          code: run.proof?.[code]?.listed ?? code,
          worked: vote,
          ...(vote && Number.isFinite(saved) && saved > 0 ? { savedAmount: saved, savedCurrency: run.money?.currency } : {}),
        }))
        .catch(noop);
    }
  }

  async function update(tabId, change, options) {
    const current = runs.get(tabId);
    if (!current) return undefined;
    const next = change(current);
    if (JSON.stringify(next) === JSON.stringify(current)) return current;
    runs.set(tabId, next);
    sendThumbs(next);
    await publish(next, options);
    return next;
  }

  async function forget(tabId, { closePanel = false } = {}) {
    runs.delete(tabId);
    loadingTabs.delete(tabId);
    await storage.remove(runKey(tabId)).catch(noop);
    if (closePanel) await tabs.sendMessage(tabId, { type: 'cartscout:run-state', run: null }).catch(noop);
  }

  async function readPick(host) {
    if (!picks) return null;
    const key = pickKey(host);
    const stored = await picks.get(key).catch(() => ({}));
    return stored?.[key] ?? null;
  }

  async function savePick(host, record) {
    if (!picks) return;
    const key = pickKey(host);
    await picks.set({ [key]: record }).catch(noop);
    const all = await picks.get(null).catch(() => ({}));
    const drop = expiredPickKeys(all, now());
    if (drop.length) await picks.remove(drop).catch(noop);
  }

  async function markPickUsed(host, succeeded) {
    if (!picks) return;
    const existing = await readPick(host);
    if (!existing) return;
    const key = pickKey(host);
    if (succeeded) {
      await picks.set({ [key]: { ...existing, usedAt: now(), misses: 0 } }).catch(noop);
    } else {
      const misses = (existing.misses ?? 0) + 1;
      if (misses >= MISSES_TO_FORGET) await picks.remove(key).catch(noop);
      else await picks.set({ [key]: { ...existing, misses } }).catch(noop);
    }
  }

  async function writePause(host, ms = PAUSE_MS, by = 'wording') {
    const duration = Math.min(MAX_PAUSE_MS, Math.max(60_000, Number(ms) || PAUSE_MS));
    await storage.set({ [pauseKey(host)]: { until: now() + duration, by } }).catch(noop);
  }

  async function readPause(host) {
    const key = pauseKey(host);
    const stored = await storage.get(key).catch(() => ({}));
    return stored?.[key]?.until ?? 0;
  }

  async function callPage(tabId, command, payload) {
    const [res] = await within(
      scripting.executeScript({ target: { tabId }, func: pageCall, args: [command, payload] }),
      callLimit,
    );
    return res?.result;
  }

  async function readDoc(tabId) {
    const [res] = await within(
      scripting.executeScript({ target: { tabId }, func: docProbe, args: [] }),
      callLimit,
    );
    return res?.result;
  }

  /**
   * Wait for a document to be reachable after a reload or worker restart (D4).
   * Uses per-document `doc` token (never `tab.status` alone) to distinguish old vs new documents.
   */
  async function reach(tabId, started) {
    const deadline = now() + reloadWait;
    while (now() < deadline) {
      const run = runs.get(tabId);
      if (!run || run.startedAt !== started) return { kind: 'aborted' };

      const tab = await tabs.get(tabId).catch(() => null);
      if (!tab) return { kind: 'closed' };

      let tabUrl = null;
      try { tabUrl = tab.url ? new URL(tab.url) : null; } catch { tabUrl = null; }
      if (!tabUrl || tabUrl.origin !== run.origin) {
        return { kind: 'moved' };
      }

      try {
        const here = await readDoc(tabId);
        if (here?.doc && here.doc === run.doc) {
          const flightAge = run.flight ? now() - run.flight.at : 0;
          if (flightAge >= leaveGrace && tab.status === 'complete') {
            return { kind: 'same', doc: here.doc };
          }
        } else if (here && here.doc === null && here.ready !== 'loading') {
          await injectBundle(tabId);
          const fresh = await readDoc(tabId);
          const loads = (run.loads ?? 0) + 1;
          if (loads > MAX_LOADS) return { kind: 'reloads' };
          await update(tabId, (cur) => ({ ...cur, loads, doc: fresh?.doc ?? '' }));
          return { kind: 'new', doc: fresh?.doc ?? '' };
        } else if (here?.doc && here.doc !== run.doc) {
          const loads = (run.loads ?? 0) + 1;
          if (loads > MAX_LOADS) return { kind: 'reloads' };
          await update(tabId, (cur) => ({ ...cur, loads, doc: here.doc }));
          return { kind: 'new', doc: here.doc };
        }
      } catch {
        // Between documents; keep polling.
      }
      await wait(pollMs);
    }
    return { kind: 'lost' };
  }

  async function finishError(tabId, reason, { code = '', twice = false, keepRest = false, reattach = true } = {}) {
    const current = runs.get(tabId);
    if (!current) return null;
    const copy = reasonCopy(reason, { driver: current.driver, code, twice });
    let results = current.results;
    if (reason === 'moved' && current.flight?.code && !results.some((r) => r.code === current.flight.code)) {
      results = [...results, { code: current.flight.code, outcome: 'error', message: 'No clear answer from the shop' }];
    }
    const rest = keepRest ? restOf({ ...current, results, code: current.flight?.code || code || current.code }) : [];
    const next = await update(tabId, (cur) => ({
      ...cur,
      status: 'error',
      phase: 'done',
      flight: null,
      results,
      title: copy.title,
      message: copy.message,
      reason,
      rest,
      finishedAt: now(),
    }), { reattach });
    if (reason === 'moved' && action) {
      void action.setBadgeText?.({ tabId, text: '!' })?.catch?.(noop);
      void action.setTitle?.({ tabId, title: copy.message })?.catch?.(noop);
    }
    return next;
  }

  /** Execute one step against the page; transparently handles reload continuation via reach + settle. */
  async function runStep(tabId, started, command, payload) {
    const run = runs.get(tabId);
    let reply;
    try {
      reply = await callPage(tabId, command, payload);
    } catch (error) {
      if (error === TIMED_OUT) return { fatal: 'lost' };
      reply = null;
    }

    const wentAway = reply == null || reply.gone === true || (run.doc && reply.doc && reply.doc !== run.doc);
    if (!wentAway) return { reply };

    const reached = await reach(tabId, started);
    if (reached.kind === 'closed') return { fatal: 'closed' };
    if (reached.kind === 'aborted') return { fatal: 'aborted' };
    if (reached.kind === 'moved') return { fatal: 'moved' };
    if (reached.kind === 'reloads') return { fatal: 'reloads' };
    if (reached.kind === 'lost') return { fatal: 'lost' };

    const cur = runs.get(tabId);
    if (!cur || cur.startedAt !== started) return { fatal: 'aborted' };
    if (command === 'remove') {
      const st = await callPage(tabId, 'state', { driver: cur.driver, pick: payload.pick }).catch(() => null);
      return { reply: { doc: cur.doc, ok: !st?.applied?.some((c) => c.effect === 'applied'), navigating: false, settledState: st } };
    }
    const settled = await callPage(tabId, 'settle', {
      code: payload.code,
      step: cur.flight?.step ?? 'apply',
      driver: cur.driver,
      baseline: cur.money,
      pick: payload.pick,
    }).catch(() => null);
    if (!settled || settled.gone) return { fatal: 'lost' };
    return { reply: settled };
  }

  async function finishBest(tabId, started, pick) {
    let run = runs.get(tabId);
    if (!run || run.startedAt !== started) return;

    const winner = run.best;
    if (run.driver?.via === 'endpoint') {
      await update(tabId, (cur) => ({ ...cur, phase: 'finalise', flight: { code: winner?.code ?? '', n: cur.index, step: 'final', at: now() } }));
      await callPage(tabId, 'finalise', { code: winner?.code ?? '', driver: run.driver, pick }).catch(noop);
    } else if (winner && run.applied !== winner.code) {
      // Remove whatever else is currently applied, then re-apply the best code.
      if (run.applied && !run.driver?.replace) {
        await update(tabId, (cur) => ({ ...cur, phase: 'remove', flight: { code: cur.applied, n: cur.index, step: 'remove', at: now() } }));
        await runStep(tabId, started, 'remove', { code: run.applied, driver: run.driver, pick });
        await update(tabId, (cur) => ({ ...cur, applied: null }));
      }
      await update(tabId, (cur) => ({
        ...cur,
        status: 'trying',
        phase: 'restore',
        code: winner.code,
        title: 'Putting the best code back',
        flight: { code: winner.code, n: cur.index, step: 'restore', at: now() },
      }));
      const res = await runStep(tabId, started, 'attempt', {
        code: winner.code, n: 1, driver: run.driver, baseline: run.money, previous: null, pick,
      });
      if (res.fatal === 'closed') { await forget(tabId); return; }
      if (res.fatal) { await finishError(tabId, res.fatal, { code: winner.code, keepRest: res.fatal === 'moved' }); return; }
      const verdict = classifyAnswer(res.reply?.evidence, run.driver);
      if (verdict.verdict !== 'saved' && verdict.verdict !== 'applied') {
        await finishError(tabId, 'restore', { code: winner.code });
        return;
      }
      await update(tabId, (cur) => ({ ...cur, applied: winner.code }));
    } else if (run.driver?.cleanup) {
      await callPage(tabId, 'finalise', { code: winner?.code ?? '', driver: run.driver, pick }).catch(noop);
    } else if (!winner && !run.applied) {
      await callPage(tabId, 'clear', {}).catch(noop);
    }

    run = runs.get(tabId);
    if (!run || run.startedAt !== started) return;

    if (winner && run.money) {
      const otherWins = run.results.filter((r) => r.outcome === 'applied' && r.code !== winner.code).length;
      const saving = { ...buildSaving(winner.code, run.money, winner.after), beat: otherWins };
      const results = run.results.map((r) => {
        if (r.outcome !== 'applied') return r;
        if (r.code === winner.code) {
          return {
            ...r,
            kept: true,
            message: otherWins > 0 ? 'Best saving · Applied to this basket' : 'Applied to this basket',
          };
        }
        const lesserText = Number.isFinite(r.saved) && r.saved > 0
          ? `Worked, saved ${formatMoney(r.saved, run.money.format, run.money.currency)} (less)`
          : 'Worked, but saved less';
        return { ...r, kept: false, message: lesserText };
      });
      const beatNote = otherWins > 0 ? ` It beat ${otherWins === 1 ? '1 other code' : `${otherWins} other codes`} that worked.` : '';
      await update(tabId, (cur) => ({
        ...cur,
        status: 'saved',
        phase: 'done',
        code: winner.code,
        applied: winner.code,
        flight: null,
        results,
        saving,
        title: '',
        reason: '',
        rest: [],
        message: `${winner.code} took ${saving.text.amount} off your basket.${beatNote}`,
        finishedAt: now(),
      }));
      return;
    }

    if (run.applied) {
      await update(tabId, (cur) => ({
        ...cur,
        status: 'applied',
        phase: 'done',
        code: cur.applied,
        flight: null,
        title: '',
        reason: '',
        rest: [],
        message: `${cur.applied} is on your basket. Check the total before you pay.`,
        finishedAt: now(),
      }));
      return;
    }

    // Nothing worked.
    const rejectedCount = run.results.filter((r) => r.outcome === 'rejected').length;
    if (!rejectedCount && run.results.length) {
      await finishError(tabId, 'unclear', { code: run.code, twice: run.results.length >= 2, keepRest: true });
      return;
    }
    await update(tabId, (cur) => ({
      ...cur,
      status: 'none',
      phase: 'done',
      code: '',
      flight: null,
      title: '',
      reason: '',
      rest: [],
      message: noneMessage(cur.index, cur.results),
      finishedAt: now(),
    }));
  }

  /** Main worker-owned loop for one run. */
  async function drive(tabId) {
    const initial = runs.get(tabId);
    if (!initial || !isActive(initial)) return;
    const started = initial.startedAt;
    const loopId = `${tabId}:${started}`;
    if (loops.has(loopId)) return;
    loops.add(loopId);

    const mine = () => {
      const cur = runs.get(tabId);
      return !!cur && cur.startedAt === started && isActive(cur);
    };

    try {
      let pick = await readPick(initial.host);

      // Recovery after a service worker restart while a code was in flight.
      if (initial.flight && initial.phase !== 'prepare') {
        const reached = await reach(tabId, started);
        if (reached.kind === 'closed') { await forget(tabId); return; }
        if (reached.kind === 'aborted') return;
        if (['moved', 'reloads', 'lost'].includes(reached.kind)) {
          await finishError(tabId, reached.kind, { code: initial.flight.code, keepRest: true });
          return;
        }
        const cur = runs.get(tabId);
        const settled = await callPage(tabId, 'settle', {
          code: cur.flight.code, step: cur.flight.step, driver: cur.driver, baseline: cur.money, pick,
        }).catch(() => null);
        if (settled && !settled.gone && !settled.skipped && cur.flight.step === 'apply') {
          const v = classifyAnswer(settled.evidence, cur.driver);
          if (v.verdict === 'saved' || v.verdict === 'applied' || v.verdict === 'rejected' || v.verdict === 'unclear') {
            const code = cur.flight.code;
            const entry = { code, outcome: v.outcome, message: v.message, ...(typeof v.vote === 'boolean' && { vote: v.vote }) };
            await update(tabId, (c) => ({ ...c, flight: null, phase: 'attempt', results: [...c.results, entry] }));
            if (v.verdict === 'saved' && cur.mode === 'first' && cur.money && settled.total) {
              const saving = buildSaving(code, cur.money, settled.total.value);
              await update(tabId, (c) => ({
                ...c, status: 'saved', phase: 'done', code, applied: code, saving,
                message: `${code} took ${saving.text.amount} off your basket.`, finishedAt: now(),
              }));
              return;
            }
            if (v.verdict === 'applied' && cur.mode === 'first') {
              await update(tabId, (c) => ({
                ...c, status: 'applied', phase: 'done', code, applied: code,
                message: `${code} is on your basket. Check the total before you pay.`, finishedAt: now(),
              }));
              return;
            }
          }
        } else {
          await update(tabId, (c) => ({ ...c, flight: null, phase: 'attempt' }));
        }
      }

      // Phase: prepare
      if (runs.get(tabId)?.phase === 'prepare') {
        try {
          await injectBundle(tabId);
        } catch {
          await finishError(tabId, 'lost');
          return;
        }
        if (!mine()) return;
        const cur = runs.get(tabId);
        const prep = await callPage(tabId, 'prepare', { pick, standing: cur.standing ?? null }).catch(() => null);
        if (!mine()) return;
        if (!prep || prep.gone) {
          await finishError(tabId, 'lost');
          return;
        }
        if (!prep.ok) {
          if (pick && ['noBox', 'ambiguous', 'noApply'].includes(prep.reason)) {
            await markPickUsed(cur.host, false);
          }
          if (prep.reason === 'noBox' || prep.reason === 'ambiguous') {
            await update(tabId, (c) => ({
              ...c,
              status: 'pick',
              phase: 'pick',
              doc: prep.doc ?? c.doc,
              pick: { phase: 'offer', why: prep.reason, candidates: prep.candidates ?? 0 },
              title: 'Scout can’t find the code box',
              message: 'Scout can’t find the code box on this page. Show Scout where discount codes go and it will carry on.',
              reason: prep.reason,
            }));
            return;
          }
          if (prep.reason === 'noApply') {
            await update(tabId, (c) => ({
              ...c,
              status: 'pick',
              phase: 'pick',
              doc: prep.doc ?? c.doc,
              pick: { phase: 'apply', why: 'noApply', candidates: prep.candidates ?? 0 },
              title: 'Now click the button that applies it',
              message: 'Scout couldn’t tell which button goes with that box. Click the button that applies a code.',
              reason: 'noApply',
            }));
            return;
          }
          await finishError(tabId, prep.reason);
          return;
        }

        if (prep.driver.kind === 'pick') await markPickUsed(cur.host, true);
        await update(tabId, (c) => ({
          ...c,
          phase: 'attempt',
          driver: prep.driver,
          mode: prep.driver.mode,
          money: prep.total ?? null,
          basketBefore: prep.total ? Math.round(prep.total.value * 100) : null,
          doc: prep.doc,
          pick: null,
          reason: '',
          title: '',
        }));
      }

      // Phase: attempt loop
      let unclearStreak = 0;
      let silentStreak = 0;
      let previous = null;

      while (mine()) {
        const cur = runs.get(tabId);
        if (cur.stopRequested) {
          if (cur.mode === 'best' && cur.best) {
            await finishBest(tabId, started, pick);
            return;
          }
          await callPage(tabId, 'clear', {}).catch(noop);
          const unchanged = !cur.applied;
          const rest = unchanged ? restOf({ ...cur, code: '' }) : [];
          await update(tabId, (c) => ({
            ...c,
            status: 'stopped',
            phase: 'done',
            code: '',
            flight: null,
            stopRequested: true,
            rest,
            message: c.index
              ? `Stopped after ${countOf(c.index)}. ${unchanged ? 'Your basket hasn’t changed.' : 'Check your basket before you pay.'}`
              : 'Stopped before any code was tried. Your basket hasn’t changed.',
            finishedAt: now(),
          }));
          return;
        }

        if (now() - cur.startedAt >= runBudget) {
          if (cur.mode === 'best' && cur.best) {
            await finishBest(tabId, started, pick);
            return;
          }
          await finishError(tabId, 'time', { keepRest: !cur.applied });
          return;
        }

        const triedSet = new Set(cur.results.map((r) => r.code));
        const remaining = Object.keys(cur.proof).filter((code) => !triedSet.has(code));

        if (!remaining.length || (cur.mode === 'best' && cur.best && now() - cur.startedAt >= bestSoft)) {
          await finishBest(tabId, started, pick);
          return;
        }

        const code = remaining[0];
        const nextIndex = cur.index + 1;

        // Best mode: remove currently applied code before trying the next one.
        if (cur.mode === 'best' && cur.applied && !cur.driver?.replace && cur.driver?.via !== 'endpoint') {
          await update(tabId, (c) => ({
            ...c,
            phase: 'remove',
            flight: { code: c.applied, n: c.index, step: 'remove', at: now() },
          }));
          const remRes = await runStep(tabId, started, 'remove', { code: cur.applied, driver: cur.driver, pick });
          if (remRes.fatal === 'closed') { await forget(tabId); return; }
          if (remRes.fatal) { await finishError(tabId, remRes.fatal, { code: cur.applied, keepRest: remRes.fatal === 'moved' }); return; }
          if (!remRes.reply?.ok) {
            // Cannot safely remove the working code: stop and keep what's on the basket!
            await finishBest(tabId, started, pick);
            return;
          }
          await update(tabId, (c) => ({ ...c, applied: null, flight: null }));
        }

        if (cur.index > 0 && (cur.driver?.paceMs ?? 0) > 0) {
          await wait(cur.driver.paceMs);
          if (!mine()) return;
        }

        // Write code-in-flight to storage BEFORE asking the page to click (D4).
        await update(tabId, (c) => ({
          ...c,
          status: 'trying',
          phase: 'attempt',
          index: nextIndex,
          code,
          flight: { code, n: nextIndex, step: 'apply', at: now() },
        }));

        const stepRes = await runStep(tabId, started, 'attempt', {
          code, n: nextIndex, driver: runs.get(tabId).driver, baseline: runs.get(tabId).money, previous, pick,
        });
        if (!mine()) return;

        if (stepRes.fatal === 'closed') { await forget(tabId); return; }
        if (stepRes.fatal === 'aborted') return;
        if (stepRes.fatal) {
          await finishError(tabId, stepRes.fatal, { code, keepRest: stepRes.fatal !== 'lost' || !runs.get(tabId).applied, reattach: stepRes.fatal !== 'moved' });
          return;
        }

        const answer = stepRes.reply;
        if (answer.skipped) {
          if (answer.skipped === 'late' && answer.late?.code) {
            const lateCode = answer.late.code;
            const latest = runs.get(tabId);
            const results = latest.results.filter((r) => r.code !== lateCode);
            const lateVerdict = classifyAnswer(answer.evidence, latest.driver);
            const entry = { code: lateCode, outcome: 'applied', message: '', ...(typeof lateVerdict.vote === 'boolean' && { vote: lateVerdict.vote }) };
            if (lateVerdict.verdict === 'saved' && latest.money && answer.total) {
              const saving = buildSaving(lateCode, latest.money, answer.total.value);
              await update(tabId, (c) => ({
                ...c, status: 'saved', phase: 'done', code: lateCode, applied: lateCode, flight: null,
                results: [...results, entry], saving,
                message: `${lateCode} took ${saving.text.amount} off your basket.`, finishedAt: now(),
              }));
            } else {
              await update(tabId, (c) => ({
                ...c, status: 'applied', phase: 'done', code: lateCode, applied: lateCode, flight: null,
                results: [...results, entry],
                message: `${lateCode} is on your basket. Check the total before you pay.`, finishedAt: now(),
              }));
            }
            return;
          }
          if (answer.skipped === 'lost') {
            await finishError(tabId, 'left', { code, reattach: false });
            return;
          }
          await finishError(tabId, answer.skipped === 'occupied' ? 'occupied' : 'changed', {
            code, keepRest: !answer.applied?.length,
          });
          return;
        }

        const latest = runs.get(tabId);
        const verdict = classifyAnswer(answer.evidence, latest.driver);

        if (verdict.verdict === 'blocked') {
          await finishError(tabId, verdict.reason, { code });
          return;
        }
        if (verdict.verdict === 'pause') {
          await writePause(latest.host, answer.retryAfter ?? PAUSE_MS, answer.retryAfter ? 'http' : 'wording');
          await callPage(tabId, 'clear', {}).catch(noop);
          await finishError(tabId, 'paused', { code });
          return;
        }
        if (verdict.verdict === 'rose') {
          await finishError(tabId, 'rose', { code });
          return;
        }

        if (verdict.verdict === 'saved') {
          unclearStreak = 0;
          silentStreak = 0;
          const afterVal = answer.evidence.total.after;
          const savedAmount = Number((latest.money.value - afterVal).toFixed(4));
          const entry = {
            code,
            outcome: 'applied',
            message: '',
            ...(typeof verdict.vote === 'boolean' && { vote: verdict.vote }),
            saved: savedAmount,
          };
          if (latest.mode === 'first') {
            const saving = buildSaving(code, latest.money, afterVal);
            const canTryRest = answer.removable && !!latest.money && latest.driver?.afterWin !== false;
            const nextResults = [...latest.results, entry];
            const rest = canTryRest ? restOf({ ...latest, results: nextResults, code }) : [];
            await update(tabId, (c) => ({
              ...c,
              status: 'saved',
              phase: 'done',
              code,
              applied: code,
              flight: null,
              results: nextResults,
              saving,
              best: { code, after: afterVal, saved: savedAmount },
              rest,
              message: `${code} took ${saving.text.amount} off your basket.`,
              finishedAt: now(),
            }));
            return;
          }
          // Best mode: record saving and continue trying the remaining codes.
          const isBetter = !latest.best || savedAmount > latest.best.saved;
          await update(tabId, (c) => ({
            ...c,
            flight: null,
            applied: code,
            best: isBetter ? { code, after: afterVal, saved: savedAmount } : c.best,
            results: [...c.results, entry],
          }));
          previous = { code, rejected: false, unclear: false };
          continue;
        }

        if (verdict.verdict === 'applied') {
          unclearStreak = 0;
          silentStreak = 0;
          const entry = {
            code,
            outcome: 'applied',
            message: '',
            ...(typeof verdict.vote === 'boolean' && { vote: verdict.vote }),
          };
          if (latest.mode === 'first') {
            await update(tabId, (c) => ({
              ...c,
              status: 'applied',
              phase: 'done',
              code,
              applied: code,
              flight: null,
              results: [...c.results, entry],
              rest: [],
              message: `${code} is on your basket. Check the total before you pay.`,
              finishedAt: now(),
            }));
            return;
          }
          await update(tabId, (c) => ({
            ...c,
            flight: null,
            applied: code,
            results: [...c.results, entry],
          }));
          previous = { code, rejected: false, unclear: false };
          continue;
        }

        if (verdict.verdict === 'rejected') {
          unclearStreak = 0;
          silentStreak = 0;
          const entry = {
            code,
            outcome: 'rejected',
            message: verdict.message,
            ...(typeof verdict.vote === 'boolean' && { vote: verdict.vote }),
          };
          await update(tabId, (c) => ({ ...c, flight: null, results: [...c.results, entry] }));
          previous = { code, rejected: true, unclear: false };
          continue;
        }

        // Unclear answer.
        unclearStreak += 1;
        if (answer.evidence?.reaction === false) silentStreak += 1;
        else silentStreak = 0;
        const entry = { code, outcome: 'error', message: verdict.message };
        await update(tabId, (c) => ({ ...c, flight: null, results: [...c.results, entry] }));
        previous = { code, rejected: false, unclear: true };

        if (silentStreak >= NO_REACTION && latest.results.length + 1 === silentStreak) {
          await callPage(tabId, 'clear', {}).catch(noop);
          await finishError(tabId, 'silent', { code, keepRest: true });
          return;
        }
        if (unclearStreak >= MAX_UNCLEAR) {
          await callPage(tabId, 'clear', {}).catch(noop);
          await finishError(tabId, 'unclear', { code, twice: true, keepRest: !latest.applied });
          return;
        }
      }
    } catch {
      if (runs.get(tabId)?.startedAt === started && isActive(runs.get(tabId))) {
        await finishError(tabId, 'lost');
      }
    } finally {
      loops.delete(loopId);
    }
  }

  /** Start a run on any HTTPS tab (host & origin always read from Chrome's tab, never trusted from message). */
  async function start({ tabId, coupons, merchant: givenMerchant, pick: startInPick = false } = {}, { proven = true, standing = null } = {}) {
    if (!Number.isInteger(tabId)) return { error: 'CartScout couldn’t find that tab.' };
    const plan = planFrom(coupons);
    const { codes, proof } = plan;
    const provenFirst = proven && plan.provenFirst;
    if (!codes.length) return { error: 'There are no codes to try on this basket yet.' };
    if (isActive(runs.get(tabId))) return { error: 'Scout is already trying codes on this tab.' };

    const tab = await tabs.get(tabId).catch(() => null);
    let url = null;
    try { url = tab?.url ? new URL(tab.url) : null; } catch { url = null; }
    if (!url || url.protocol !== 'https:') {
      return { error: 'Scout only tries codes on secure HTTPS checkout pages.' };
    }
    const host = url.hostname;
    const origin = url.origin;
    const bare = bareHost(host);
    const cleanGiven = typeof givenMerchant === 'string' ? bareHost(givenMerchant) : '';
    const merchant = cleanGiven && (bare === cleanGiven || bare.endsWith(`.${cleanGiven}`)) ? cleanGiven : bare;

    const pauseUntil = await readPause(host);
    if (pauseUntil > now()) {
      return { error: 'This shop has paused code tries for now. Try again in a few minutes.' };
    }

    const previous = runs.get(tabId);
    let startedAt = now();
    if (previous && startedAt <= previous.startedAt) startedAt = previous.startedAt + 1;

    const run = {
      v: 2,
      tabId,
      host,
      origin,
      merchant,
      status: startInPick ? 'pick' : 'starting',
      phase: startInPick ? 'pick' : 'prepare',
      mode: 'first',
      driver: null,
      total: codes.length,
      index: 0,
      code: '',
      stopRequested: false,
      results: [],
      saving: null,
      best: null,
      applied: null,
      standing: standing ?? null,
      flight: null,
      pick: startInPick ? { phase: 'armed', why: 'asked', candidates: 0 } : null,
      message: startInPick ? 'Click the box on this page where a discount code goes.' : '',
      title: startInPick ? 'Click the code box' : '',
      reason: '',
      rest: [],
      startedAt,
      finishedAt: null,
      loads: 0,
      doc: '',
      dock: '',
      money: null,
      proof,
      provenFirst,
    };

    runs.set(tabId, run);
    try {
      await injectPanel(tabId);
      if (startInPick) await injectBundle(tabId);
    } catch {
      if (previous) runs.set(tabId, previous);
      else runs.delete(tabId);
      return { error: 'CartScout can’t reach this tab, so reload your basket and try again.' };
    }
    if (action) {
      void action.setBadgeText?.({ tabId, text: '' })?.catch?.(noop);
    }
    await publish(run);
    if (!startInPick) void drive(tabId);
    return { ok: true };
  }

  /** "Try the rest" (panel) or "Carry on" (popup after cross-origin move). */
  async function resume(tabId) {
    const run = runs.get(tabId);
    if (isActive(run)) return { error: 'Scout is already trying codes on this tab.' };
    const rest = run && ['stopped', 'error', 'saved'].includes(run.status) && Array.isArray(run.rest) ? run.rest : [];
    const coupons = rest
      .filter((code) => Object.hasOwn(run.proof ?? {}, code))
      .map((code) => ({ code: run.proof[code].listed, worked: run.proof[code].worked, failed: run.proof[code].failed }));
    if (!coupons.length) return { error: 'There are no codes left to try on this basket.' };
    const standing = run.status === 'saved' && run.best
      ? { code: run.best.code, saved: run.best.saved, before: run.money?.value ?? null }
      : null;
    return start({ tabId, coupons, merchant: run.merchant }, { proven: run.provenFirst === true, standing });
  }

  async function stop(tabId) {
    const cur = runs.get(tabId);
    if (!cur) return { ok: true };
    if (cur.status === 'pick') return pickCancel(tabId);
    if (!isActive(cur)) return { ok: true };
    await update(tabId, (c) => ({ ...c, stopRequested: true }));
    void drive(tabId);
    return { ok: true };
  }

  async function clear(tabId) {
    const run = runs.get(tabId);
    if (run && !isActive(run)) await forget(tabId, { closePanel: true });
    return { ok: true };
  }

  async function dismiss(tabId) {
    const run = runs.get(tabId);
    if (run?.status === 'pick') {
      await pickCancel(tabId);
      await update(tabId, (c) => ({ ...c, panelDismissed: true }));
      return { ok: true };
    }
    if (isActive(run) && !run.stopRequested) return stop(tabId);
    await update(tabId, (c) => ({ ...c, panelDismissed: true }));
    return { ok: true };
  }

  async function sync(tabId) {
    if (isActive(runs.get(tabId))) void drive(tabId);
    return { ok: true, run: runs.get(tabId) ?? null };
  }

  // ---- Pick flow handlers (D2) --------------------------------------------------------------

  async function pickStart(tabId) {
    const run = runs.get(tabId);
    if (!run || run.status !== 'pick') return { error: 'Not waiting for a box.' };
    await injectBundle(tabId).catch(noop);
    await update(tabId, (c) => ({
      ...c,
      pick: { ...c.pick, phase: 'armed' },
      title: 'Click the code box',
      message: 'Click the box on this page where a discount code goes.',
    }));
    return { ok: true };
  }

  async function pickMade(tabId, payload = {}) {
    const run = runs.get(tabId);
    if (!run || run.status !== 'pick') return { error: 'Not waiting for a box.' };
    const input = validatePickPart(payload.input);
    if (!input) return { error: 'That didn’t look like a valid code box. Try clicking inside the discount input.' };
    const reveal = payload.reveal ? validatePickPart(payload.reveal) : null;
    const tab = await tabs.get(tabId).catch(() => null);
    let path = '';
    try { path = tab?.url ? new URL(tab.url).pathname : ''; } catch { path = ''; }
    const existing = await readPick(run.host);
    const record = makePickRecord({
      host: run.host,
      path,
      input,
      apply: existing?.apply ?? null,
      reveal: reveal ?? existing?.reveal ?? null,
      now: now(),
    });
    await savePick(run.host, record);
    await update(tabId, (c) => ({
      ...c,
      status: 'starting',
      phase: 'prepare',
      pick: null,
      title: '',
      message: '',
      reason: '',
    }));
    void drive(tabId);
    return { ok: true };
  }

  async function pickApply(tabId, payload = {}) {
    const run = runs.get(tabId);
    if (!run || run.status !== 'pick') return { error: 'Not waiting for a button.' };
    const apply = validatePickPart(payload.apply);
    if (!apply) return { error: 'That didn’t look like a safe apply button. Try clicking the Apply button beside the box.' };
    const existing = await readPick(run.host);
    if (!existing) return { error: 'Show Scout the code box first.' };
    await savePick(run.host, { ...existing, apply, usedAt: now(), misses: 0 });
    await update(tabId, (c) => ({
      ...c,
      status: 'starting',
      phase: 'prepare',
      pick: null,
      title: '',
      message: '',
      reason: '',
    }));
    void drive(tabId);
    return { ok: true };
  }

  async function pickCancel(tabId) {
    const run = runs.get(tabId);
    if (!run || run.status !== 'pick') return { ok: true };
    await update(tabId, (c) => ({
      ...c,
      status: 'stopped',
      phase: 'done',
      pick: null,
      title: 'Scout has stopped',
      message: 'Stopped before any code was tried. Your basket hasn’t changed.',
      rest: restOf(c),
      finishedAt: now(),
    }));
    return { ok: true };
  }

  async function pickForget(tabId) {
    const run = runs.get(tabId);
    if (!run) return { ok: true };
    if (picks) await picks.remove(pickKey(run.host)).catch(noop);
    if (run.status === 'pick') {
      await update(tabId, (c) => ({
        ...c,
        pick: { ...c.pick, phase: 'armed', why: 'asked' },
        title: 'Click the code box',
        message: 'Click the box on this page where a discount code goes.',
      }));
    }
    return { ok: true };
  }

  async function setDock(tabId, payload = {}) {
    const dock = payload?.dock;
    if (!DOCKS.includes(dock)) return { ok: false };
    const run = runs.get(tabId);
    if (!run || run.dock === dock) return { ok: true };
    runs.set(tabId, { ...run, dock });
    await storage.set({ [runKey(tabId)]: runs.get(tabId) }).catch(noop);
    return { ok: true };
  }

  async function recover() {
    const stored = await storage.get(null).catch(() => ({}));
    for (const [key, run] of Object.entries(stored ?? {})) {
      if (!key.startsWith('run:') || !Number.isInteger(run?.tabId) || runs.has(run.tabId)) continue;
      runs.set(run.tabId, run);
      if (isActive(run)) void drive(run.tabId);
    }
  }

  function tabRemoved(tabId) {
    return runs.has(tabId) ? forget(tabId) : Promise.resolve();
  }

  async function pageStands(tabId, host) {
    try {
      const reply = await tabs.sendMessage(tabId, { type: 'cartscout:ping' }, { frameId: 0 });
      if (reply?.ok !== true) return false;
      const url = new URL((await tabs.get(tabId)).url);
      return url.protocol === 'https:' && bareHost(url.hostname) === bareHost(host);
    } catch {
      return false;
    }
  }

  async function tabUpdated(tabId, changeInfo) {
    const run = runs.get(tabId);
    if (!run || isActive(run) || run.status === 'pick') return 'none';
    const status = changeInfo?.status;
    const awaited = loadingTabs.get(tabId) === run.startedAt;
    if (status !== 'loading' && !(status === 'complete' && awaited)) return 'kept';
    const same = () => runs.get(tabId)?.startedAt === run.startedAt;
    let stands = await pageStands(tabId, run.host);
    if (stands && status === 'loading') {
      loadingTabs.set(tabId, run.startedAt);
      await wait(RECHECK_PAGE_MS);
      if (same()) stands = await pageStands(tabId, run.host);
    }
    if (!same()) return runs.has(tabId) ? 'kept' : 'forgotten';
    if (stands) {
      if (status === 'complete') loadingTabs.delete(tabId);
      return 'kept';
    }
    await forget(tabId);
    return 'forgotten';
  }

  function showing(tabId) {
    const run = runs.get(tabId);
    return !!run && !run.panelDismissed;
  }

  return {
    start, stop, resume, clear, dismiss, sync, recover, tabRemoved, tabUpdated, showing,
    pickStart, pickMade, pickApply, pickCancel, pickForget, setDock,
    get: (tabId) => runs.get(tabId),
  };
}

/**
 * What the in-page panel may ask for. Always uses `tabId` from Chrome's sender, never from the message.
 */
export function panelMessages(engine) {
  return {
    'cartscout:run-stop': (tabId) => engine.stop(tabId),
    'cartscout:run-dismiss': (tabId) => engine.dismiss(tabId),
    'cartscout:run-sync': (tabId) => engine.sync(tabId),
    'cartscout:run-rest': (tabId) => engine.resume(tabId),
    'cartscout:pick-start': (tabId) => engine.pickStart(tabId),
    'cartscout:pick-made': (tabId, _sender, message) => engine.pickMade(tabId, message),
    'cartscout:pick-apply': (tabId, _sender, message) => engine.pickApply(tabId, message),
    'cartscout:pick-cancel': (tabId) => engine.pickCancel(tabId),
    'cartscout:pick-forget': (tabId) => engine.pickForget(tabId),
    'cartscout:panel-dock': (tabId, _sender, message) => engine.setDock(tabId, message),
  };
}
