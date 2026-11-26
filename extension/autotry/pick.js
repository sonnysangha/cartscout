// Shopper-picked box support (D2): describe a picked element with stable selectors,
// validate PickParts in the worker, resolve stored picks safely on revisit, and prune old picks.

import { isSafeApplyControl, isSafeCodeInput, labelOf } from './finder.js';
import { bareHost, PICK_KEEP_DAYS, PICK_MAX } from './limits.js';
import { attr, cssEscape, isHidden, textOf } from './text.js';

const GENERATED = /^:r[\w]+:$|\d{4,}|[0-9a-f]{8,}|^(?:mui|ember|react-select|radix|headlessui|downshift|rc|el|ui-id|__next|input|field|textfield)[-_:]?\w*\d|[:.]|(?:[-_][0-9a-z]{1,3}){4,}/i;
const stable = (value) => !!value && value.length <= 40 && (value.match(/\d/g) ?? []).length <= 3 && !GENERATED.test(value);
const quote = (value) => `"${String(value).replace(/["\\]/g, '\\$&')}"`;

/** Build up to 3 stable CSS selectors + fingerprint for a shopper-clicked element. */
export function describeElement(element, { kind = 'input' } = {}) {
  if (!element || element.nodeType !== 1) return null;
  if (kind === 'input' && !isSafeCodeInput(element)) return null;
  if (kind === 'apply' && !isSafeApplyControl(element, null)) return null;

  const doc = element.ownerDocument;
  const tag = element.tagName.toLowerCase();
  const unique = (selector) => {
    try {
      const hits = doc.querySelectorAll(selector);
      return hits.length === 1 && hits[0] === element;
    } catch {
      return false;
    }
  };
  const selectors = [];
  const offer = (selector) => {
    if (selectors.length < 3 && selector.length <= 200 && unique(selector) && !/@|\d{6,}/.test(selector)) {
      selectors.push(selector);
    }
  };

  const id = attr(element, 'id');
  if (stable(id)) offer(`#${cssEscape(id)}`);
  const name = attr(element, 'name');
  if (stable(name)) offer(`${tag}[name=${quote(name)}]`);
  for (const hook of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-hook', 'data-e2e', 'data-test-id', 'data-automation-id']) {
    const val = attr(element, hook);
    if (stable(val.replace(/[.:]/g, ''))) offer(`${tag}[${hook}=${quote(val)}]`);
  }
  const formControl = attr(element, 'formcontrolname');
  if (formControl && stable(formControl)) offer(`${tag}[formcontrolname=${quote(formControl)}]`);
  const aria = attr(element, 'aria-label');
  if (aria && aria.length <= 80) offer(`${tag}[aria-label=${quote(aria)}]`);
  const placeholder = attr(element, 'placeholder');
  if (placeholder && placeholder.length <= 80) offer(`${tag}[placeholder=${quote(placeholder)}]`);

  if (selectors.length < 2) {
    const steps = [];
    let node = element;
    for (let depth = 0; node && depth < 5 && node !== doc.body; depth += 1, node = node.parentElement) {
      const anchorId = node !== element && stable(attr(node, 'id')) ? `#${cssEscape(attr(node, 'id'))}` : '';
      const hookVal = node !== element ? attr(node, 'data-testid') : '';
      const anchorHook = hookVal && stable(hookVal.replace(/[.:]/g, '')) ? `[data-testid=${quote(hookVal)}]` : '';
      if (anchorId || anchorHook) {
        offer(`${anchorId || anchorHook} ${steps.join(' > ')}`.trim());
        break;
      }
      const twins = node.parentElement
        ? [...node.parentElement.children].filter((child) => child.tagName === node.tagName)
        : [node];
      steps.unshift(`${node.tagName.toLowerCase()}${twins.length > 1 ? `:nth-of-type(${twins.indexOf(node) + 1})` : ''}`);
    }
    if (!selectors.length && steps.length) offer(steps.join(' > '));
  }

  if (!selectors.length) return null;
  const print = {
    tag,
    ...(kind === 'input' ? {
      type: attr(element, 'type').toLowerCase() || 'text',
      name: name.slice(0, 120),
      id: id.slice(0, 120),
      placeholder: placeholder.slice(0, 120),
      label: labelOf(element).slice(0, 120),
    } : {
      text: textOf(element, 120),
      id: id.slice(0, 120),
    }),
  };
  return { selectors, print };
}

/** Resolve a stored PickPart back to one safe visible element (or null). */
export function resolvePickPart(doc, part, { kind = 'input', field = null } = {}) {
  if (!part || !Array.isArray(part.selectors)) return null;
  for (const selector of part.selectors) {
    let matches;
    try { matches = [...doc.querySelectorAll(selector)]; } catch { continue; }
    const visible = matches.filter((el) => !isHidden(el));
    const el = matches.length === 1 ? matches[0] : (visible.length === 1 ? visible[0] : null);
    if (!el) continue;
    if (part.print?.tag && el.tagName.toLowerCase() !== part.print.tag) continue;
    if (kind === 'input' && !isSafeCodeInput(el)) continue;
    if (kind === 'apply' && !isSafeApplyControl(el, field)) continue;
    return el;
  }
  return null;
}

/** Worker-side validation of a PickPart received from the panel message. */
export function validatePickPart(part) {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return null;
  if (!Array.isArray(part.selectors) || !part.selectors.length || part.selectors.length > 3) return null;
  const selectors = [];
  for (const s of part.selectors) {
    if (typeof s !== 'string' || !s.trim() || s.length > 200 || /[\u0000-\u001f\u007f]/.test(s)) return null;
    selectors.push(s.trim());
  }
  const print = {};
  if (part.print && typeof part.print === 'object' && !Array.isArray(part.print)) {
    for (const [k, v] of Object.entries(part.print)) {
      if (typeof v === 'string') print[k] = v.slice(0, 120);
    }
  }
  if (!print.tag) return null;
  return { selectors, print };
}

/** Build a clean stored pick record for `chrome.storage.local` under `box:<bare host>`. */
export function makePickRecord({ host, path = '', input, apply = null, reveal = null, now = Date.now() }) {
  return {
    v: 1,
    host: bareHost(host),
    at: now,
    usedAt: now,
    path: String(path).slice(0, 200),
    misses: 0,
    silent: 0,
    input,
    apply,
    reveal,
  };
}

/** Return keys to delete so stored picks respect PICK_KEEP_DAYS (180d) and PICK_MAX (200). */
export function expiredPickKeys(allLocal, now = Date.now()) {
  const cutoff = now - PICK_KEEP_DAYS * 86_400_000;
  const entries = [];
  const drop = [];
  for (const [key, rec] of Object.entries(allLocal ?? {})) {
    if (!key.startsWith('box:')) continue;
    const usedAt = Number(rec?.usedAt ?? rec?.at ?? 0);
    if (!rec || rec.v !== 1 || usedAt < cutoff) {
      drop.push(key);
    } else {
      entries.push([key, usedAt]);
    }
  }
  if (entries.length > PICK_MAX) {
    entries.sort((a, b) => b[1] - a[1]);
    for (const [key] of entries.slice(PICK_MAX)) drop.push(key);
  }
  return drop;
}
