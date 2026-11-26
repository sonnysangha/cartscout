// Stateless page steps called one at a time by the service worker (or popup for `probe`).
// Each step resolves in < 13s, never throws, returns plain structured-cloneable data, and obeys D5 safety rules.

import { detectBlocker, isEmptyBasket } from './blockers.js';
import { clickElement, resolveDriver, takeMessageSnapshot } from './driver.js';
import { findCartLink, findCodeBox, isSafeCodeInput, pageKind } from './finder.js';
import { CONFIRM_MS, DRAW_WAIT_MS, LEAVE_GRACE_MS } from './limits.js';
import { sameCurrency } from './money.js';
import { platformHints } from './recipes.js';
import { isHidden } from './text.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const buttonUnavailable = (btn) => !btn || btn.disabled
  || btn.getAttribute?.('aria-disabled') === 'true'
  || btn.getAttribute?.('aria-busy') === 'true';

/** D5 rule 1: Framework-safe typing (native value setter + bubbling input & change). Never presses Enter. */
export function typeValue(field, value) {
  const win = field?.ownerDocument?.defaultView ?? globalThis;
  const proto = win.HTMLInputElement?.prototype ?? globalThis.HTMLInputElement?.prototype;
  const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
  if (setter) setter.call(field, value);
  else field.value = value;
  const Ev = win.Event ?? Event;
  field.dispatchEvent(new Ev('input', { bubbles: true }));
  field.dispatchEvent(new Ev('change', { bubbles: true }));
}

function driverSummary(driver) {
  return {
    kind: driver.kind,
    id: driver.id,
    via: driver.via,
    trust: driver.trust,
    mode: driver.mode,
    label: driver.label,
    reloads: driver.reloads,
    replace: !!driver.replace,
    afterWin: driver.afterWin !== false,
    cleanup: driver.cleanup ?? null,
    paceMs: driver.timings.paceMs,
  };
}

function compareTotals(before, after) {
  const beforeVal = before?.value ?? null;
  const afterVal = after?.value ?? null;
  const comparable = beforeVal !== null && afterVal !== null && sameCurrency(before, after);
  return {
    before: beforeVal,
    after: afterVal,
    comparable,
    fell: comparable && afterVal < beforeVal - 1e-6,
    rose: comparable && afterVal > beforeVal + 1e-6,
  };
}

function waitForQuiet(doc, driver, quietMs, capMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let quietSince = started;
    const root = doc.querySelector?.('main') ?? doc.body ?? doc;
    let observer;
    const MO = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    if (typeof MO === 'function' && root) {
      observer = new MO(() => { quietSince = Date.now(); });
      try {
        observer.observe(root, {
          childList: true,
          characterData: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['disabled', 'aria-disabled', 'aria-busy', 'hidden', 'class'],
        });
      } catch {
        observer = null;
      }
    }
    const timer = setInterval(() => {
      const now = Date.now();
      const field = driver.box();
      const btn = driver.applyControl();
      const ready = !!field && !!btn && !field.disabled && !field.readOnly
        && !driver.busy() && !(field.value && buttonUnavailable(btn));
      if ((ready && now - quietSince >= quietMs) || now - started >= capMs) {
        clearInterval(timer);
        observer?.disconnect();
        resolve();
      }
    }, 50);
  });
}

export function createPageSteps({ doc = globalThis.document, loc = globalThis.location, docId, fetcher = globalThis.fetch } = {}) {
  let writtenField = null;
  let writtenCode = '';
  let lastAttempt = null;

  /** Read-only probe called when the popup opens (I6: never clicks, types, or opens anything). */
  async function probe({ pick = null } = {}) {
    try {
      const secure = !loc?.protocol || loc.protocol === 'https:';
      const finder = findCodeBox(doc, loc);
      const hints = platformHints(doc, loc);
      const driver = secure ? resolveDriver(doc, loc, { pick, fetcher }) : null;
      let box = 'none';
      let applied = false;
      let blocked = detectBlocker(doc, loc, { hasMainBox: !!driver && driver.via === 'dom' });

      if (driver?.via === 'endpoint') {
        const state = await driver.readEndpointState();
        if (state) {
          box = 'recipe';
          applied = state.applied.some((c) => c.effect === 'applied');
          if (state.itemCount === 0) blocked = 'empty';
        } else {
          // Endpoint did not answer JSON; fall back to DOM probe.
          const fallback = finder.verdict === 'found' ? 'found' : finder.verdict === 'behind' ? 'behind' : 'none';
          box = fallback;
        }
      } else if (driver) {
        box = driver.box() ? 'found' : (driver.hiddenBox() ? 'behind' : 'none');
        applied = driver.applied().some((c) => c.effect === 'applied');
        if (!blocked && driver.empty()) blocked = 'empty';
      }

      const cart = hints.cart ?? findCartLink(doc, loc);
      return {
        v: 1,
        doc: docId,
        secure,
        box,
        driver: driver && box !== 'none' ? { kind: driver.kind, id: driver.id, via: driver.via } : null,
        mode: driver && box !== 'none' ? driver.mode : null,
        page: finder.page,
        cart: finder.page === 'other' ? cart : null,
        where: box === 'none' ? (hints.where ?? null) : null,
        blocked,
        applied,
        candidates: finder.candidates,
      };
    } catch (error) {
      return { v: 1, doc: docId, secure: false, box: 'none', driver: null, mode: null, page: 'other', cart: null, where: null, blocked: null, applied: false, candidates: 0, failed: error?.message ?? 'probe failed' };
    }
  }

  /** Pre-flight check + reveal hidden code box before trying the first code. */
  async function prepare({ pick = null, driver: pinned = null, standing = null } = {}) {
    try {
      const secure = !loc?.protocol || loc.protocol === 'https:';
      if (!secure) return { ok: false, doc: docId, reason: 'insecure' };

      const finder = findCodeBox(doc, loc);
      let driver = resolveDriver(doc, loc, { pick, pinnedDriver: pinned, fetcher });

      if (!driver) {
        const blocker = detectBlocker(doc, loc, { hasMainBox: false });
        if (blocker) return { ok: false, doc: docId, reason: blocker };
        if (isEmptyBasket(doc)) return { ok: false, doc: docId, reason: 'empty' };
        if (finder.verdict === 'unsafeForm') return { ok: false, doc: docId, reason: 'unsafeForm' };
        if (finder.verdict === 'no-button') return { ok: false, doc: docId, reason: 'noApply', candidates: finder.candidates };
        if (finder.verdict === 'ambiguous') return { ok: false, doc: docId, reason: 'ambiguous', candidates: finder.candidates };
        return { ok: false, doc: docId, reason: 'noBox', candidates: finder.candidates };
      }

      // Endpoint driver (Shopify /cart.js).
      if (driver.via === 'endpoint') {
        const state = await driver.readEndpointState();
        if (!state) {
          // Endpoint unavailable: fall back to DOM if possible.
          driver = resolveDriver(doc, loc, { pick, pinnedDriver: { kind: 'heuristic' }, fetcher });
          if (!driver) return { ok: false, doc: docId, reason: 'noBox', candidates: finder.candidates };
        } else {
          if (state.itemCount === 0) return { ok: false, doc: docId, reason: 'empty' };
          const active = state.applied.filter((c) => c.effect === 'applied');
          if (active.length && (!standing || !active.every((c) => c.code === standing.code))) {
            return { ok: false, doc: docId, reason: 'applied' };
          }
          return {
            ok: true,
            doc: docId,
            driver: driverSummary(driver),
            total: state.total,
            revealed: false,
            removable: true,
          };
        }
      }

      const blocker = detectBlocker(doc, loc, { hasMainBox: true });
      if (blocker) return { ok: false, doc: docId, reason: blocker };

      // Check existing applied code before revealing or typing.
      const existing = driver.applied().filter((c) => c.effect === 'applied');
      if (existing.length) {
        if (standing?.code) {
          const rem = driver.ownRemove(standing.code);
          if (!rem) return { ok: false, doc: docId, reason: 'applied' };
          clickElement(rem, 'click');
          const confirm = driver.confirmRemove?.();
          if (confirm) clickElement(confirm, 'click');
          await pause(300);
        } else {
          return { ok: false, doc: docId, reason: 'applied' };
        }
      }

      // Reveal hidden box if needed.
      let revealed = false;
      if (!driver.box() && driver.hiddenBox()) {
        const res = await driver.reveal();
        revealed = res === 'opened';
      }

      const field = driver.box();
      const applyBtn = driver.applyControl();
      const total = driver.total();

      if (!field || !applyBtn) {
        if (driver.empty()) return { ok: false, doc: docId, reason: 'empty' };
        if (field && !applyBtn) return { ok: false, doc: docId, reason: 'noApply', candidates: finder.candidates };
        return { ok: false, doc: docId, reason: 'noBox', candidates: finder.candidates };
      }

      if (driver.strictTotal && !total) {
        if (driver.empty()) return { ok: false, doc: docId, reason: 'empty' };
        return { ok: false, doc: docId, reason: 'noTotal' };
      }

      if (field.value.trim()) {
        return { ok: false, doc: docId, reason: 'occupied' };
      }

      return {
        ok: true,
        doc: docId,
        driver: driverSummary(driver),
        total,
        revealed,
        removable: !!driver.recipe?.remove,
      };
    } catch (error) {
      return { ok: false, doc: docId, reason: 'noBox', failed: error?.message ?? 'prepare failed' };
    }
  }

  /** Try ONE code on the page and return structured Evidence. */
  async function attempt({ code, n = 1, driver: pinned, baseline = null, previous = null, pick = null } = {}) {
    const started = Date.now();
    try {
      const driver = resolveDriver(doc, loc, { pick, pinnedDriver: pinned, fetcher });
      if (!driver) return { doc: docId, code, ms: Date.now() - started, skipped: 'lost', evidence: null, total: null, applied: [], removable: false };

      // Endpoint attempt (Shopify /cart/update.js).
      if (driver.via === 'endpoint') {
        const res = await driver.request(code);
        if (res.pause) {
          return {
            doc: docId, code, ms: Date.now() - started,
            evidence: { reaction: true, navigating: false, total: compareTotals(baseline, null), marker: null, error: null, pause: true, blocked: null },
            total: null, applied: [], removable: true, retryAfter: res.retryAfter ?? null,
          };
        }
        if (res.error) {
          return {
            doc: docId, code, ms: Date.now() - started,
            evidence: { reaction: false, navigating: false, total: compareTotals(baseline, null), marker: null, error: null, pause: false, blocked: null },
            total: null, applied: [], removable: true,
          };
        }
        const entry = res.applied.find((c) => c.code === code.toUpperCase());
        const totalCmp = compareTotals(baseline, res.total);
        const appliedOk = entry?.effect === 'applied';
        const answer = {
          doc: docId,
          code,
          ms: Date.now() - started,
          evidence: {
            reaction: true,
            navigating: false,
            total: totalCmp,
            marker: appliedOk ? { by: 'endpoint', trust: 'verified', effect: 'applied' } : null,
            error: !appliedOk ? { by: 'endpoint', trust: 'verified', reason: 'invalid', text: 'Code not applicable' } : null,
            pause: false,
            blocked: null,
          },
          total: res.total,
          applied: res.applied,
          removable: true,
        };
        lastAttempt = { code, answer };
        return answer;
      }

      // DOM attempt: wait for quiet after previous code if needed.
      if (n > 1) {
        await waitForQuiet(doc, driver, driver.timings.quietMs, driver.timings.settleCapMs);
      }

      const preBlocker = detectBlocker(doc, loc, { hasMainBox: true });
      if (preBlocker) {
        return {
          doc: docId, code, ms: Date.now() - started,
          evidence: { reaction: false, navigating: false, total: compareTotals(baseline, driver.total()), marker: null, error: null, pause: false, blocked: preBlocker },
          total: driver.total(), applied: driver.applied(), removable: false,
        };
      }

      // Check if an earlier unclear code landed late!
      const alreadyOn = driver.applied(previous?.code ?? '').filter((c) => c.effect === 'applied');
      if (previous?.unclear && alreadyOn.length) {
        const afterTotal = driver.total();
        return {
          doc: docId,
          code,
          ms: Date.now() - started,
          skipped: 'late',
          late: { code: previous.code },
          evidence: {
            reaction: true,
            navigating: false,
            total: compareTotals(baseline, afterTotal),
            marker: { by: alreadyOn[0].by, trust: alreadyOn[0].trust ?? 'none', effect: 'applied' },
            error: null,
            pause: false,
            blocked: null,
          },
          total: afterTotal,
          applied: alreadyOn,
          removable: alreadyOn.some((c) => c.removable),
        };
      }

      // Re-open box if the shop collapsed it after the previous attempt.
      if (!driver.box() && driver.hiddenBox()) await driver.reveal();

      const field = driver.box();
      if (!field || !isSafeCodeInput(field)) {
        return { doc: docId, code, ms: Date.now() - started, skipped: 'lost', evidence: null, total: driver.total(), applied: driver.applied(), removable: false };
      }
      const curTotal = driver.total();
      if (alreadyOn.length || (baseline && curTotal && sameCurrency(baseline, curTotal) && Math.abs(curTotal.value - baseline.value) > 1e-6)) {
        return { doc: docId, code, ms: Date.now() - started, skipped: 'changed', evidence: null, total: curTotal, applied: alreadyOn, removable: false };
      }
      if (field.value.trim() && field.value !== writtenCode) {
        return { doc: docId, code, ms: Date.now() - started, skipped: 'occupied', evidence: null, total: curTotal, applied: [], removable: false };
      }

      writtenField = field;
      writtenCode = code;
      typeValue(field, code);

      // Wait for apply button to enable.
      const btnDeadline = Date.now() + driver.timings.buttonMs;
      let btn = driver.applyControl();
      while (btn && buttonUnavailable(btn) && Date.now() < btnDeadline) {
        await pause(25);
        btn = driver.applyControl();
      }
      if (!btn || buttonUnavailable(btn) || driver.box() !== field || field.value !== code) {
        return { doc: docId, code, ms: Date.now() - started, skipped: 'changed', evidence: null, total: driver.total(), applied: driver.applied(), removable: false };
      }

      const snap = takeMessageSnapshot(doc, driver);
      const beforeApply = baseline ?? curTotal;

      // Observe DOM mutations / button busy cycle so repeated identical refusal messages still register!
      let mutated = false;
      let buttonCycled = false;
      let observer;
      const MO = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
      if (typeof MO === 'function' && doc.body) {
        observer = new MO((records) => {
          mutated = true;
          for (const rec of records) {
            if (rec.target === btn && (
              (rec.attributeName === 'disabled' && rec.oldValue !== null)
              || (['aria-disabled', 'aria-busy'].includes(rec.attributeName) && rec.oldValue === 'true')
            )) {
              buttonCycled = true;
            }
          }
        });
        try {
          observer.observe(doc.body, {
            childList: true,
            characterData: true,
            subtree: true,
            attributeOldValue: true,
            attributeFilter: ['disabled', 'aria-disabled', 'aria-busy', 'class', 'hidden'],
          });
        } catch {
          observer = null;
        }
      }

      clickElement(btn, driver.press);

      const waitLimit = driver.reloads === 'always' ? LEAVE_GRACE_MS : driver.timings.answerMs;
      const deadline = Date.now() + waitLimit;
      let foundMarker = null;
      let foundError = null;
      let foundPause = false;
      let foundBlocked = null;
      let sawBusy = false;

      try {
        while (Date.now() < deadline) {
          await pause(100);
          if (driver.busy() || buttonUnavailable(btn)) sawBusy = true;

          const blk = detectBlocker(doc, loc, { hasMainBox: true });
          if (blk) { foundBlocked = blk; break; }

          const appliedList = driver.applied(code);
          const appliedHit = appliedList.find((c) => c.effect === 'applied');
          if (appliedHit) {
            foundMarker = { by: appliedHit.by, trust: appliedHit.trust ?? 'none', effect: 'applied' };
            break;
          }
          const noEffectHit = appliedList.find((c) => c.effect === 'none');
          if (noEffectHit) {
            foundMarker = { by: noEffectHit.by, trust: noEffectHit.trust ?? 'none', effect: 'none' };
            break;
          }

          const nowTotal = driver.total();
          const cmp = compareTotals(beforeApply, nowTotal);
          if (cmp.fell) break;

          const allowSame = (!!previous?.rejected && (buttonCycled || (sawBusy && !driver.busy() && !buttonUnavailable(btn))));
          const msg = driver.message(snap, { allowUnchanged: allowSame });
          if (msg) {
            if (msg.kind === 'pause') { foundPause = true; break; }
            if (msg.kind === 'none-effect') {
              foundMarker = { by: msg.by, trust: msg.trust, effect: 'none' };
              break;
            }
            if (msg.kind === 'error') {
              foundError = { by: msg.by, trust: msg.trust, reason: msg.reason, text: msg.text };
              driver.dismissError?.();
              break;
            }
          }
        }
      } finally {
        observer?.disconnect();
      }

      // If applied marker appeared before subtotal updated, confirm for up to CONFIRM_MS (THG & async shops).
      let afterTotal = driver.total();
      let totalCmp = compareTotals(beforeApply, afterTotal);
      if (foundMarker?.effect === 'applied' && !totalCmp.fell && beforeApply) {
        const confirmEnd = Date.now() + CONFIRM_MS;
        while (Date.now() < confirmEnd) {
          await pause(100);
          afterTotal = driver.total();
          totalCmp = compareTotals(beforeApply, afterTotal);
          if (totalCmp.fell) break;
        }
      }

      // Hold check: ensure a lower total stays lower for HOLD_MS (avoids transient flicker).
      if (totalCmp.fell && driver.timings.holdMs > 0) {
        await pause(driver.timings.holdMs);
        afterTotal = driver.total();
        totalCmp = compareTotals(beforeApply, afterTotal);
      }

      // Late total check after wording-only refusal on non-THG shops.
      if (foundError && !totalCmp.fell && driver.timings.lateTotalMs > 0 && foundError.by === 'wording') {
        await pause(Math.min(driver.timings.lateTotalMs, 400));
        afterTotal = driver.total();
        totalCmp = compareTotals(beforeApply, afterTotal);
      }

      const appliedList = driver.applied(code);
      const removable = appliedList.some((c) => c.removable) || !!driver.ownRemove(code);
      const reaction = mutated || sawBusy || buttonCycled || !!foundMarker || !!foundError || foundPause || totalCmp.fell || totalCmp.rose;

      const answer = {
        doc: docId,
        code,
        ms: Date.now() - started,
        evidence: {
          reaction,
          navigating: false,
          total: totalCmp,
          marker: foundMarker,
          error: foundError,
          pause: foundPause,
          blocked: foundBlocked,
        },
        total: afterTotal,
        applied: appliedList.map(({ removeEl, ...rest }) => rest),
        removable,
      };
      lastAttempt = { code, answer };
      return answer;
    } catch (error) {
      return {
        doc: docId,
        code,
        ms: Date.now() - started,
        failed: error?.message ?? 'attempt failed',
        evidence: { reaction: false, navigating: false, total: compareTotals(baseline, null), marker: null, error: null, pause: false, blocked: null },
        total: null,
        applied: [],
        removable: false,
      };
    }
  }

  /** Called after a page reload (or worker restart) to classify the code in flight on the loaded page. */
  async function settle({ code, step = 'apply', driver: pinned, baseline = null, pick = null } = {}) {
    const started = Date.now();
    try {
      // Same document after a worker restart: return the attempt we already recorded.
      if (lastAttempt && lastAttempt.code === code && step === 'apply') {
        return lastAttempt.answer;
      }

      const deadline = Date.now() + DRAW_WAIT_MS;
      let driver = null;
      let foundMarker = null;
      let foundError = null;
      let foundPause = false;
      let foundBlocked = null;
      let afterTotal = null;

      while (Date.now() < deadline) {
        driver = resolveDriver(doc, loc, { pick, pinnedDriver: pinned, fetcher });
        const blk = detectBlocker(doc, loc, { hasMainBox: !!driver });
        if (blk) { foundBlocked = blk; break; }
        if (driver) {
          if (!driver.box() && driver.hiddenBox()) await driver.reveal();
          const appliedList = driver.applied(code);
          const appliedHit = appliedList.find((c) => c.effect === 'applied');
          const noEffectHit = appliedList.find((c) => c.effect === 'none');
          const msg = driver.message(null, { allowUnchanged: true });
          afterTotal = driver.total();

          if (appliedHit) foundMarker = { by: appliedHit.by, trust: appliedHit.trust ?? 'none', effect: 'applied' };
          else if (noEffectHit) foundMarker = { by: noEffectHit.by, trust: noEffectHit.trust ?? 'none', effect: 'none' };

          if (msg?.kind === 'pause') foundPause = true;
          else if (msg?.kind === 'none-effect' && !foundMarker) foundMarker = { by: msg.by, trust: msg.trust, effect: 'none' };
          else if (msg?.kind === 'error') foundError = { by: msg.by, trust: msg.trust, reason: msg.reason, text: msg.text };

          const totalReady = !baseline || afterTotal !== null;
          if ((foundMarker || foundError || foundPause || driver.box()) && totalReady) {
            await pause(250);
            afterTotal = driver.total();
            break;
          }
        }
        await pause(150);
      }

      if (!driver && !foundBlocked) {
        return { doc: docId, code, ms: Date.now() - started, skipped: 'lost', evidence: null, total: null, applied: [], removable: false };
      }

      const totalCmp = compareTotals(baseline, afterTotal);
      const appliedList = driver ? driver.applied(code) : [];
      const removable = appliedList.some((c) => c.removable) || !!(driver && driver.ownRemove(code));
      const reaction = !!foundMarker || !!foundError || foundPause || totalCmp.fell || totalCmp.rose;

      return {
        doc: docId,
        code,
        ms: Date.now() - started,
        evidence: {
          reaction,
          navigating: false,
          total: totalCmp,
          marker: foundMarker,
          error: foundError,
          pause: foundPause,
          blocked: foundBlocked,
        },
        total: afterTotal,
        applied: appliedList.map(({ removeEl, ...rest }) => rest),
        removable,
      };
    } catch (error) {
      return {
        doc: docId, code, ms: Date.now() - started, failed: error?.message ?? 'settle failed',
        evidence: { reaction: false, navigating: false, total: compareTotals(baseline, null), marker: null, error: null, pause: false, blocked: null },
        total: null, applied: [], removable: false,
      };
    }
  }

  /** Safely remove a code Scout applied (D5 rule 5: only via ownRemove). */
  async function remove({ code, driver: pinned, pick = null } = {}) {
    try {
      const driver = resolveDriver(doc, loc, { pick, pinnedDriver: pinned, fetcher });
      if (!driver) return { doc: docId, ok: false, navigating: false, reason: 'notFound' };
      if (driver.via === 'endpoint') {
        const res = await driver.request('');
        return { doc: docId, ok: !res.error && !res.pause, navigating: false };
      }
      const btn = driver.ownRemove(code);
      if (!btn) return { doc: docId, ok: false, navigating: false, reason: 'notOwn' };
      const navigates = !!driver.recipe?.remove?.navigates;
      clickElement(btn, 'click');
      if (driver.recipe?.remove?.confirm) {
        await pause(120);
        const confirmBtn = driver.confirmRemove?.();
        if (confirmBtn) clickElement(confirmBtn, 'click');
      }
      if (navigates) {
        await pause(400);
        return { doc: docId, ok: true, navigating: true };
      }
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        await pause(100);
        if (!driver.busy() && !driver.applied(code).some((c) => c.effect === 'applied') && (driver.box() || driver.hiddenBox())) {
          return { doc: docId, ok: true, navigating: false };
        }
      }
      return { doc: docId, ok: !driver.applied(code).some((c) => c.effect === 'applied'), navigating: false, reason: 'failed' };
    } catch {
      return { doc: docId, ok: false, navigating: false, reason: 'failed' };
    }
  }

  /** Snapshot current page state (total, applied, box, blockers). */
  async function state({ driver: pinned, pick = null } = {}) {
    try {
      const driver = resolveDriver(doc, loc, { pick, pinnedDriver: pinned, fetcher });
      if (!driver) return { doc: docId, box: false, total: null, applied: [], blocked: detectBlocker(doc, loc), empty: false };
      if (driver.via === 'endpoint') {
        const ep = await driver.readEndpointState();
        return {
          doc: docId,
          box: true,
          total: ep?.total ?? null,
          applied: ep?.applied ?? [],
          blocked: null,
          empty: ep?.itemCount === 0,
        };
      }
      const external = await driver.readState?.();
      return {
        doc: docId,
        box: !!(driver.box() || driver.hiddenBox()),
        total: external?.money ?? driver.total(),
        applied: driver.applied().map(({ removeEl, ...rest }) => rest),
        blocked: detectBlocker(doc, loc, { hasMainBox: true }),
        empty: driver.empty(),
      };
    } catch {
      return { doc: docId, box: false, total: null, applied: [], blocked: null, empty: false };
    }
  }

  /** Finalise an endpoint run (write winning code or clear) or run recipe cleanup (SFRA / WooCommerce blocks). */
  async function finalise({ code = '', driver: pinned, pick = null } = {}) {
    try {
      const driver = resolveDriver(doc, loc, { pick, pinnedDriver: pinned, fetcher });
      if (!driver) return { doc: docId, ok: false, total: null, applied: [], reloading: false };
      if (driver.via === 'endpoint') {
        const res = await driver.request(code);
        const reloading = !!code && pageKind(doc, loc) === 'cart';
        if (reloading && typeof loc?.reload === 'function') {
          setTimeout(() => { try { loc.reload(); } catch { /* ignore */ } }, 120);
        }
        return { doc: docId, ok: !res.error && !res.pause, total: res.total ?? null, applied: res.applied ?? [], reloading };
      }
      if (driver.cleanup === 'clear-box') clear();
      if (driver.cleanup === 'remove-unapplied') {
        for (const item of driver.applied()) {
          if (item.effect === 'none' && item.code) await remove({ code: item.code, driver: pinned, pick });
        }
      }
      return { doc: docId, ok: true, total: driver.total(), applied: driver.applied().map(({ removeEl, ...r }) => r), reloading: false };
    } catch {
      return { doc: docId, ok: false, total: null, applied: [], reloading: false };
    }
  }

  /** Clear the box ONLY if it still holds what Scout typed and no code is applied. */
  function clear() {
    try {
      if (writtenField && writtenField.isConnected && writtenField.value === writtenCode && !writtenField.disabled) {
        typeValue(writtenField, '');
      }
    } catch {
      // Ignore cleanup errors.
    }
    return { doc: docId };
  }

  /** Visible viewport rectangles of the active driver's landmarks for panel placement. */
  function landmarks() {
    try {
      const driver = resolveDriver(doc, loc, { fetcher });
      return driver ? driver.landmarks() : [];
    } catch {
      return [];
    }
  }

  return { probe, prepare, attempt, settle, remove, state, finalise, clear, landmarks };
}
