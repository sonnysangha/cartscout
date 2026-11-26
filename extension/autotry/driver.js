// Driver resolution (D1) and uniform Driver interface across recipes, shopper picks, and heuristic finder.

import { isEmptyBasket } from './blockers.js';
import { createShopifyEndpoint } from './endpoint.js';
import {
  findApplyControl, findCodeBox, findReveals, isSafeApplyControl, isSafeCodeInput,
  labelOfControl, surroundings,
} from './finder.js';
import {
  ANSWER_MS, BUTTON_MS, capMs, HOLD_MS, LATE_TOTAL_MS, PACE_MS, QUIET_MS, REVEAL_MS, SETTLE_CAP_MS,
} from './limits.js';
import { resolvePickPart } from './pick.js';
import { BEST_MODE, matchRecipes, recipeById, recipeLabel, recipeTrust } from './recipes.js';
import { attr, cssEscape, isHidden, norm, queryAllDeep, rawTextOf } from './text.js';
import { findGenericTotal, readRecipeTotal, readStateEndpoint } from './totals.js';
import { classifyMessageText, PAUSE_WORDS, REMOVE_WORD } from './vocab.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fillCodeSelector(template, code) {
  const variants = [...new Set([code, String(code).toUpperCase(), String(code).toLowerCase()])];
  return variants.map((v) => template.replaceAll('{code}', cssEscape(v)));
}

function visibleRect(el) {
  if (!el || isHidden(el) || typeof el.getBoundingClientRect !== 'function') return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

function clickElement(el, press = 'full') {
  if (!el) return;
  const win = el.ownerDocument?.defaultView ?? globalThis;
  if (press !== 'click' && typeof el.dispatchEvent === 'function') {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      try {
        const Ev = type.startsWith('pointer') && typeof win.PointerEvent === 'function'
          ? win.PointerEvent
          : (typeof win.MouseEvent === 'function' ? win.MouseEvent : win.Event);
        el.dispatchEvent(new Ev(type, { bubbles: true, cancelable: true, view: win }));
      } catch {
        const Fallback = win.Event ?? Event;
        el.dispatchEvent(new Fallback(type, { bubbles: true, cancelable: true }));
      }
    }
  }
  if (typeof el.click === 'function') el.click();
}

/** Find a generic applied-code row (D7/I2: a compact row holding the code + a remove button, or locked input holding code). */
function findGenericApplied(doc, box, code) {
  const out = [];
  const wanted = code ? String(code).trim().toUpperCase() : '';
  if (box && box.disabled && box.value?.trim()) {
    const val = box.value.trim().toUpperCase();
    if (!wanted || val === wanted) {
      out.push({ code: val, by: 'generic', effect: 'applied', removable: false });
    }
  }
  if (!wanted) return out;
  for (const el of queryAllDeep(doc, 'li, tr, div, span, p')) {
    if (isHidden(el) || el.contains?.(box)) continue;
    const text = rawTextOf(el, 220);
    if (!text || text.length > 200 || !text.toUpperCase().includes(wanted)) continue;
    // Smallest container: skip if a child already matches with remove control.
    const removeBtn = findOwnRemoveInRow(el);
    if (!removeBtn) continue;
    if (el.querySelector?.('input[type="number"], input[name*="qty" i], input[name*="quantity" i], a[href*="/p/"], a[href*="/product"]')) continue;
    const childHas = [...(el.children ?? [])].some((c) => rawTextOf(c, 220).toUpperCase().includes(wanted) && findOwnRemoveInRow(c));
    if (childHas) continue;
    out.push({ code: wanted, by: 'generic', effect: 'applied', removable: true, removeEl: removeBtn });
    break;
  }
  return out;
}

function findOwnRemoveInRow(row) {
  const buttons = [...row.querySelectorAll('button, a, [role="button"], svg')].filter((b) => !isHidden(b));
  const matches = buttons.filter((b) => {
    const lbl = labelOfControl(b);
    const cls = `${attr(b, 'class')} ${attr(b, 'aria-label')} ${attr(b, 'title')}`.toLowerCase();
    return REMOVE_WORD.test(lbl) || /\b(?:remove|delete|close|clear)\b/.test(cls) || /^[×x✕✖]$/.test(rawTextOf(b, 4));
  });
  return matches.length === 1 ? matches[0] : null;
}

/** Snapshot of visible messages & answer zone before clicking apply. */
export function takeMessageSnapshot(doc, driver) {
  const zone = driver.answerZone?.();
  const texts = new Set();
  const collect = (root) => {
    if (!root) return;
    for (const el of root.querySelectorAll?.('[role="alert"], [role="status"], [aria-live], .error, .alert, .message, [class*="error" i]') ?? []) {
      if (isHidden(el)) continue;
      const t = rawTextOf(el, 160);
      if (t) texts.add(t);
    }
  };
  collect(zone);
  collect(doc);
  const recipeTexts = new Set();
  for (const el of driver.recipeErrorNodes?.() ?? []) {
    if (!isHidden(el)) {
      const t = rawTextOf(el, 160);
      if (t) recipeTexts.add(t);
    }
  }
  return {
    zoneText: zone ? rawTextOf(zone, 600) : '',
    texts,
    recipeTexts,
    recipeNodes: new Set(driver.recipeErrorNodes?.() ?? []),
  };
}

/** Create a recipe-backed Driver (DOM or Shopify endpoint). */
function createRecipeDriver(recipe, doc, loc, fetcher) {
  const host = loc?.hostname ?? '';
  const mode = BEST_MODE && recipe.best ? 'best' : 'first';
  const via = recipe.endpoint ? 'endpoint' : 'dom';
  const errorTrust = recipeTrust(recipe, 'error');
  const appliedTrust = recipeTrust(recipe, 'applied');
  const trust = errorTrust === 'verified' && appliedTrust === 'verified' ? 'verified'
    : (errorTrust === 'recalled' || appliedTrust === 'recalled' ? 'recalled' : 'none');

  const meta = {
    kind: 'recipe',
    id: recipe.id,
    via,
    trust,
    mode,
    label: recipeLabel(recipe, host),
    reloads: recipe.reloads || 'never',
    replace: !!recipe.replace,
    strictTotal: !!recipe.strictTotal,
    afterWin: recipe.afterWin !== false,
    cleanup: recipe.cleanup ?? null,
    timings: {
      answerMs: capMs(recipe.answerMs, ANSWER_MS),
      settleCapMs: capMs(recipe.settleCapMs, SETTLE_CAP_MS),
      buttonMs: capMs(recipe.buttonMs, BUTTON_MS),
      paceMs: capMs(recipe.paceMs, via === 'endpoint' ? 500 : PACE_MS),
      holdMs: capMs(recipe.holdMs, HOLD_MS),
      lateTotalMs: capMs(recipe.lateTotalMs, LATE_TOTAL_MS),
      quietMs: capMs(recipe.quietMs, QUIET_MS),
    },
  };

  if (recipe.endpoint?.kind === 'shopify-cart') {
    const api = createShopifyEndpoint(doc, fetcher);
    return {
      ...meta,
      recipe,
      endpoint: api,
      box: () => null,
      hiddenBox: () => false,
      reveal: async () => 'open',
      applyControl: () => null,
      busy: () => false,
      total: () => findGenericTotal(doc).pick?.money ?? null,
      applied: () => [],
      message: () => null,
      ownRemove: () => null,
      empty: () => false,
      landmarks: () => {
        const out = [];
        const t = findGenericTotal(doc).pick;
        const r = visibleRect(t?.leaf);
        if (r) out.push({ kind: 'total', ...r });
        return out;
      },
      async request(code) {
        return api.writeDiscount(code);
      },
      async readEndpointState() {
        return api.readCart();
      },
    };
  }

  const getScope = () => {
    if (!recipe.scope) return doc;
    const hits = queryAllDeep(doc, recipe.scope);
    return hits.find((el) => !isHidden(el)) ?? hits[0] ?? doc;
  };

  const resolveInput = ({ allowHidden = false, allowDisabled = false } = {}) => {
    const scope = getScope();
    for (const sel of recipe.input ?? []) {
      const hits = queryAllDeep(scope, sel).filter((el) => isSafeCodeInput(el, { allowDisabled }));
      if (!hits.length) continue;
      const visible = hits.filter((el) => !isHidden(el));
      if (visible.length >= 1) return visible[0];
      if (allowHidden) return hits[0];
    }
    return null;
  };

  const resolveApply = (field) => {
    const scope = getScope();
    for (const sel of recipe.apply ?? []) {
      const hits = queryAllDeep(scope, sel);
      const visible = hits.filter((el) => !isHidden(el));
      const candidate = visible[0] ?? hits[0];
      if (candidate && isSafeApplyControl(candidate, field, { fromRecipe: true })) return candidate;
    }
    return field ? findApplyControl(field, surroundings(field).box).best?.control ?? null : null;
  };

  const answerZone = () => {
    const field = resolveInput({ allowHidden: true, allowDisabled: true });
    if (recipe.zone && field?.closest) return field.closest(recipe.zone) ?? getScope();
    return getScope();
  };

  const recipeErrorNodes = () => {
    const zone = answerZone();
    const noise = new Set();
    for (const sel of recipe.error?.noise ?? []) {
      for (const el of queryAllDeep(zone, sel)) noise.add(el);
    }
    const nodes = [];
    for (const sel of recipe.error?.at ?? []) {
      for (const el of queryAllDeep(zone, sel)) {
        if (!noise.has(el)) nodes.push(el);
      }
    }
    return nodes;
  };

  return {
    ...meta,
    recipe,
    answerZone,
    recipeErrorNodes,
    box: () => resolveInput({ allowHidden: false }),
    anyBox: () => resolveInput({ allowHidden: true, allowDisabled: true }),
    hiddenBox() {
      if (resolveInput({ allowHidden: false })) return false;
      if (resolveInput({ allowHidden: true })) return true;
      for (const step of recipe.reveal ?? []) {
        if (step.open && doc.querySelector(step.open)) return true;
        if (step.click && queryAllDeep(doc, step.click).some((el) => !isHidden(el))) return true;
        if (step.find === 'reveal' && findReveals(doc, getScope()).length) return true;
      }
      return false;
    },
    async reveal() {
      if (resolveInput({ allowHidden: false })) return 'open';
      let acted = 0;
      for (const step of recipe.reveal ?? []) {
        if (acted >= 2) break;
        if (step.open) {
          const el = doc.querySelector(step.open);
          if (el && !el.open) { el.open = true; acted += 1; }
        } else if (step.click) {
          const el = queryAllDeep(doc, step.click).find((n) => !isHidden(n));
          if (el) { clickElement(el, 'click'); acted += 1; }
        } else if (step.find === 'reveal') {
          const found = findReveals(doc, getScope())[0];
          if (found) { clickElement(found.control, 'click'); acted += 1; }
        }
        const deadline = Date.now() + REVEAL_MS;
        while (Date.now() < deadline) {
          if (resolveInput({ allowHidden: false })) return 'opened';
          await pause(60);
        }
      }
      return resolveInput({ allowHidden: false }) ? 'opened' : 'failed';
    },
    applyControl() {
      const field = resolveInput({ allowHidden: false });
      return resolveApply(field);
    },
    press: recipe.press || 'full',
    busy() {
      for (const sel of recipe.busy ?? []) {
        const hits = queryAllDeep(doc, sel);
        if (hits.some((el) => !isHidden(el))) return true;
      }
      return false;
    },
    total() {
      const fromRecipe = readRecipeTotal(doc, recipe.total, getScope());
      if (fromRecipe?.money) return fromRecipe.money;
      if (recipe.strictTotal) return null;
      return findGenericTotal(doc).pick?.money ?? null;
    },
    totalLeaf() {
      const fromRecipe = readRecipeTotal(doc, recipe.total, getScope());
      if (fromRecipe?.leaf) return fromRecipe.leaf;
      if (recipe.strictTotal) return null;
      return findGenericTotal(doc).pick?.leaf ?? null;
    },
    applied(code = '') {
      const out = [];
      const seen = new Set();
      const scope = getScope();
      const checkNoEffect = () => {
        for (const sel of recipe.noEffect?.at ?? []) {
          const hit = queryAllDeep(scope, sel).find((el) => !isHidden(el));
          if (hit) return true;
        }
        return false;
      };
      for (const rawSel of recipe.applied?.at ?? []) {
        const selectors = rawSel.includes('{code}')
          ? (code ? fillCodeSelector(rawSel, code) : [])
          : [rawSel];
        for (const sel of selectors) {
          for (const el of queryAllDeep(doc, sel)) {
            if (isHidden(el)) continue;
            if (recipe.applied.matchCodeInRow && code) {
              const row = el.closest?.('li, tr, div[role="group"], .coupon-price-adjustment, [data-testid="applied-coupons"]') ?? el;
              if (!rawTextOf(row, 220).toUpperCase().includes(code.toUpperCase())) continue;
            }
            let foundCode = null;
            if (recipe.applied.code === 'value') foundCode = String(el.value ?? '').trim().toUpperCase() || null;
            else if (recipe.applied.code === 'text') foundCode = rawTextOf(el, 80).toUpperCase() || null;
            else if (recipe.applied.code?.startsWith('attr:')) {
              foundCode = attr(el, recipe.applied.code.slice(5)).trim().toUpperCase() || null;
            }
            const key = `${foundCode ?? ''}:${sel}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
              code: foundCode || (code ? code.toUpperCase() : null),
              by: 'recipe',
              trust: appliedTrust,
              effect: 'applied',
              removable: !!recipe.remove,
            });
          }
        }
      }
      if (!out.length && checkNoEffect()) {
        out.push({ code: code ? code.toUpperCase() : null, by: 'recipe', trust: appliedTrust, effect: 'none', removable: !!recipe.remove });
      }
      return out;
    },
    message(since, { allowUnchanged = false } = {}) {
      // Check recipe noEffect nodes first (e.g. SFRA "Not Applied", Shopware info flashbag).
      for (const sel of recipe.noEffect?.at ?? []) {
        for (const el of queryAllDeep(answerZone(), sel)) {
          if (isHidden(el)) continue;
          const text = rawTextOf(el, 160);
          if (text && (allowUnchanged || !since?.texts?.has(text))) {
            return { kind: 'none-effect', by: 'recipe', trust: appliedTrust, text };
          }
        }
      }
      // Check recipe error nodes.
      for (const el of recipeErrorNodes()) {
        if (isHidden(el)) continue;
        const text = rawTextOf(el, 160);
        if (!text) continue;
        const isNew = allowUnchanged || !since?.recipeTexts?.has(text) || !since?.recipeNodes?.has(el);
        if (!isNew) continue;
        if (recipe.noEffectText?.some((phrase) => norm(text).includes(norm(phrase)))) {
          return { kind: 'none-effect', by: 'recipe', trust: errorTrust, text };
        }
        const classified = classifyMessageText(text);
        if (classified?.kind === 'pause') {
          return { kind: 'pause', by: 'recipe', trust: errorTrust, text };
        }
        return {
          kind: 'error',
          by: 'recipe',
          trust: errorTrust,
          reason: classified?.reason ?? 'generic',
          text,
        };
      }
      // Check page-wide alerts for rate-limit/pause dialogs (never suppressed by pre-click snapshot).
      for (const el of queryAllDeep(doc, '[role="alert"], [role="alertdialog"], dialog[open]')) {
        if (isHidden(el)) continue;
        const text = rawTextOf(el, 160);
        if (text && PAUSE_WORDS.test(norm(text))) {
          return { kind: 'pause', by: 'wording', trust: 'none', text };
        }
      }
      return null;
    },
    dismissError() {
      if (!recipe.error?.dismiss) return;
      const btn = queryAllDeep(doc, recipe.error.dismiss).find((el) => !isHidden(el));
      if (btn) clickElement(btn, 'click');
    },
    ownRemove(code) {
      if (!recipe.remove?.at) return null;
      const selectors = recipe.remove.at.includes('{code}')
        ? fillCodeSelector(recipe.remove.at, code)
        : [recipe.remove.at];
      for (const sel of selectors) {
        const hits = queryAllDeep(doc, sel).filter((el) => !isHidden(el));
        for (const el of hits) {
          if (recipe.remove.matchCodeInRow && code) {
            const row = el.closest?.('li, tr, div[role="group"], .cx-coupon-apply, .coupon-price-adjustment') ?? el.parentElement;
            if (!row || !rawTextOf(row, 220).toUpperCase().includes(code.toUpperCase())) continue;
          }
          return el;
        }
      }
      return null;
    },
    confirmRemove() {
      if (!recipe.remove?.confirm) return null;
      return queryAllDeep(doc, recipe.remove.confirm).find((el) => !isHidden(el)) ?? null;
    },
    empty() {
      return isEmptyBasket(doc, recipe, { hasBox: !!resolveInput({ allowHidden: true }), hasTotal: !!this.total() });
    },
    async readState() {
      return recipe.state ? readStateEndpoint(recipe.state, fetcher) : null;
    },
    landmarks() {
      const out = [];
      const add = (kind, el) => {
        const r = visibleRect(el);
        if (r) out.push({ kind, ...r });
      };
      const field = resolveInput({ allowHidden: false });
      add('box', field);
      add('apply', resolveApply(field));
      add('total', this.totalLeaf());
      for (const el of recipeErrorNodes()) add('message', el);
      return out;
    },
  };
}

/** Create a Pick-backed or Heuristic-backed generic DOM driver (first-accepted mode, never auto-thumbs on wording). */
function createGenericDriver({ kind, id, doc, loc, pick, finderResult }) {
  const meta = {
    kind,
    id,
    via: 'dom',
    trust: 'none',
    mode: 'first',
    label: '',
    reloads: 'maybe',
    replace: false,
    strictTotal: false,
    afterWin: true,
    cleanup: null,
    timings: {
      answerMs: ANSWER_MS,
      settleCapMs: SETTLE_CAP_MS,
      buttonMs: BUTTON_MS,
      paceMs: PACE_MS,
      holdMs: HOLD_MS,
      lateTotalMs: LATE_TOTAL_MS,
      quietMs: QUIET_MS,
    },
  };

  const resolveInput = ({ allowHidden = false } = {}) => {
    if (kind === 'pick') {
      const el = resolvePickPart(doc, pick?.input, { kind: 'input' });
      if (el && (allowHidden || !isHidden(el))) return el;
      return null;
    }
    const fresh = findCodeBox(doc, loc);
    const chosen = fresh.chosen?.field;
    if (chosen && isSafeCodeInput(chosen) && (allowHidden || !isHidden(chosen))) return chosen;
    return null;
  };

  const resolveApply = (field) => {
    if (!field) return null;
    if (kind === 'pick' && pick?.apply) {
      const el = resolvePickPart(doc, pick.apply, { kind: 'apply', field });
      if (el && !isHidden(el)) return el;
    }
    const { box } = surroundings(field);
    return findApplyControl(field, box).best?.control ?? null;
  };

  const answerZone = () => {
    const field = resolveInput({ allowHidden: true });
    if (!field) return doc.body;
    let node = field.parentElement;
    for (let i = 0; i < 3 && node?.parentElement && node.parentElement !== doc.body; i += 1) {
      node = node.parentElement;
    }
    return node ?? doc.body;
  };

  return {
    ...meta,
    press: 'full',
    answerZone,
    recipeErrorNodes: () => [],
    box: () => resolveInput({ allowHidden: false }),
    anyBox: () => resolveInput({ allowHidden: true }),
    hiddenBox() {
      if (resolveInput({ allowHidden: false })) return false;
      if (kind === 'pick' && pick?.reveal && resolvePickPart(doc, pick.reveal, { kind: 'reveal' })) return true;
      if (resolveInput({ allowHidden: true })) return true;
      return findReveals(doc).length > 0;
    },
    async reveal() {
      if (resolveInput({ allowHidden: false })) return 'open';
      let acted = 0;
      if (kind === 'pick' && pick?.reveal) {
        const btn = resolvePickPart(doc, pick.reveal, { kind: 'reveal' });
        if (btn) {
          if (btn.tagName === 'DETAILS') btn.open = true;
          else clickElement(btn, 'click');
          acted += 1;
        }
      }
      if (!acted) {
        for (const candidate of findReveals(doc).slice(0, 2)) {
          if (candidate.control.tagName === 'SUMMARY' && candidate.control.parentElement?.tagName === 'DETAILS') {
            candidate.control.parentElement.open = true;
          } else {
            clickElement(candidate.control, 'click');
          }
          acted += 1;
          const deadline = Date.now() + REVEAL_MS;
          while (Date.now() < deadline) {
            if (resolveInput({ allowHidden: false })) return 'opened';
            await pause(60);
          }
          if (acted >= 2) break;
        }
      } else {
        const deadline = Date.now() + REVEAL_MS;
        while (Date.now() < deadline) {
          if (resolveInput({ allowHidden: false })) return 'opened';
          await pause(60);
        }
      }
      return resolveInput({ allowHidden: false }) ? 'opened' : 'failed';
    },
    applyControl() {
      const field = resolveInput({ allowHidden: false });
      return resolveApply(field);
    },
    busy() {
      const field = resolveInput({ allowHidden: false });
      const btn = resolveApply(field);
      return btn?.getAttribute?.('aria-busy') === 'true' || field?.getAttribute?.('aria-busy') === 'true';
    },
    total: () => findGenericTotal(doc).pick?.money ?? null,
    totalLeaf: () => findGenericTotal(doc).pick?.leaf ?? null,
    applied(code = '') {
      const field = resolveInput({ allowHidden: true });
      return findGenericApplied(doc, field, code);
    },
    message(since, { allowUnchanged = false } = {}) {
      const zone = answerZone();
      const candidates = [
        ...(zone?.querySelectorAll?.('[role="alert"], [role="status"], [aria-live], p, span, div, li') ?? []),
        ...queryAllDeep(doc, '[role="alert"], [role="alertdialog"], dialog[open]'),
      ];
      for (const el of candidates) {
        if (isHidden(el) || el.childElementCount > 2) continue;
        const text = rawTextOf(el, 160);
        if (!text || text.length < 4) continue;
        if (!allowUnchanged && since?.texts?.has(text)) continue;
        if (!allowUnchanged && since?.zoneText && since.zoneText.includes(text) && zone?.contains?.(el)) continue;
        const classified = classifyMessageText(text);
        if (classified?.kind === 'pause') return { kind: 'pause', by: 'wording', trust: 'none', text };
        if (classified?.kind === 'error') return { kind: 'error', by: 'wording', trust: 'none', reason: classified.reason, text };
      }
      return null;
    },
    ownRemove(code) {
      const field = resolveInput({ allowHidden: true });
      const hits = findGenericApplied(doc, field, code);
      return hits.find((h) => h.removeEl)?.removeEl ?? null;
    },
    empty: () => isEmptyBasket(doc, null, { hasBox: !!resolveInput({ allowHidden: true }), hasTotal: !!findGenericTotal(doc).pick }),
    landmarks() {
      const out = [];
      const add = (k, el) => { const r = visibleRect(el); if (r) out.push({ kind: k, ...r }); };
      const field = resolveInput({ allowHidden: false });
      add('box', field);
      add('apply', resolveApply(field));
      add('total', findGenericTotal(doc).pick?.leaf);
      return out;
    },
    finderResult,
  };
}

/**
 * Resolve the active Driver for this page in D1 priority order:
 * 1) Recipe (if `pinnedDriverId` given, resolve that recipe directly)
 * 2) Shopper's remembered pick (`pick`)
 * 3) Multi-language heuristic finder
 */
export function resolveDriver(doc, loc, { pick = null, pinnedDriver = null, fetcher = globalThis.fetch } = {}) {
  // If worker pinned a specific driver during this run, honour that exact driver.
  if (pinnedDriver?.kind === 'recipe' && pinnedDriver.id) {
    const recipe = recipeById(pinnedDriver.id);
    if (recipe) return createRecipeDriver(recipe, doc, loc, fetcher);
    return null;
  }
  if (pinnedDriver?.kind === 'pick' && pick) {
    return createGenericDriver({ kind: 'pick', id: 'pick', doc, loc, pick });
  }
  if (pinnedDriver?.kind === 'heuristic') {
    const res = findCodeBox(doc, loc);
    if (['found', 'behind'].includes(res.verdict)) {
      return createGenericDriver({ kind: 'heuristic', id: 'heuristic', doc, loc, finderResult: res });
    }
    return null;
  }

  // 1. Recipes in priority order.
  for (const recipe of matchRecipes(doc, loc)) {
    const drv = createRecipeDriver(recipe, doc, loc, fetcher);
    if (drv.via === 'endpoint') return drv;
    if (drv.box() || drv.hiddenBox() || drv.applied().length || drv.empty()) return drv;
  }

  // 2. Shopper's remembered pick for this shop.
  if (pick?.input) {
    const pickDriver = createGenericDriver({ kind: 'pick', id: 'pick', doc, loc, pick });
    if (pickDriver.box() || pickDriver.hiddenBox()) return pickDriver;
  }

  // 3. Heuristic finder.
  const found = findCodeBox(doc, loc);
  if (['found', 'behind'].includes(found.verdict)) {
    return createGenericDriver({ kind: 'heuristic', id: 'heuristic', doc, loc, finderResult: found });
  }
  return null;
}

export { clickElement };
