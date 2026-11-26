// Multi-language heuristic finder for promo code inputs, reveal controls, apply controls, and cart links.
// Enforces D5 safety rules on every candidate field and button.

import { attr, cssEscape, ident, isHidden, norm, queryAllDeep, textOf } from './text.js';
import { findGenericTotal } from './totals.js';
import {
  APPLY, ATTR_NOUN, BARE_CODE, CART_ONLY_PATH, CART_PATH, CHECKOUT_PATH, DANGER, DISCOUNT,
  EXACT_NAMES, FIELD_KIND, GIFT, GIFT_ATTR, NOUN, OTHER_LABEL, PIN, REVEAL, SECTION, TWO_FACED,
} from './vocab.js';

export const ACCEPT = 60;
export const MARGIN = 15;
export const LISTED = 25;

const TEXT_TYPES = new Set(['', 'text']);

export const ownAttrs = (element) => ident([attr(element, 'id'), attr(element, 'name'), attr(element, 'autocomplete')].join(' '));

export function dataAttrs(element) {
  if (!element?.attributes) return '';
  return ident(
    [...element.attributes]
      .filter(({ name }) => /^(?:class|data-(?:test\w*|qa|cy|hook|e2e|automation-id|role|link-action))$/.test(name))
      .map(({ value }) => value)
      .join(' '),
  );
}

export const shownAttrs = (element) => norm([attr(element, 'placeholder'), attr(element, 'aria-label'), attr(element, 'title')].join(' | '));

export function labelOf(field) {
  const parts = [];
  for (const label of field.labels ?? []) parts.push(textOf(label));
  const doc = field.ownerDocument;
  for (const id of attr(field, 'aria-labelledby').split(/\s+/).filter(Boolean)) {
    const el = doc?.getElementById?.(id);
    if (el) parts.push(textOf(el));
  }
  if (!parts.length && attr(field, 'id') && doc?.querySelectorAll) {
    try {
      for (const lbl of doc.querySelectorAll(`label[for="${cssEscape(attr(field, 'id'))}"]`)) {
        parts.push(textOf(lbl));
      }
    } catch {
      // Ignore escape errors.
    }
  }
  return parts.filter(Boolean).join(' | ');
}

/**
 * D5 rule 1: Hard safety check binding EVERY driver (recipes, picks, heuristics).
 * Never types into password, email, payment card, postcode, search, quantity, or hidden/honeypot fields.
 */
export function isSafeCodeInput(field, { allowDisabled = false } = {}) {
  if (!field || field.tagName !== 'INPUT') return false;
  const type = attr(field, 'type').toLowerCase();
  if (!TEXT_TYPES.has(type)) return false;
  if (!allowDisabled && (field.disabled || field.readOnly)) return false;
  if (attr(field, 'aria-hidden') === 'true' || field.hasAttribute?.('data-autofill-honeypot')) return false;
  const self = ownAttrs(field);
  const name = attr(field, 'name').toLowerCase();
  if (FIELD_KIND.test(self) || EXACT_NAMES.has(name)) return false;
  const autocomplete = attr(field, 'autocomplete').toLowerCase();
  if (/\b(?:cc-|email|tel|street|address|postal|current-password|new-password|one-time-code|username)\b/.test(autocomplete)) return false;
  const inputmode = attr(field, 'inputmode').toLowerCase();
  if (/^(?:numeric|decimal|tel|email|search|url)$/.test(inputmode)) return false;
  const maxLength = Number(attr(field, 'maxlength')) || 0;
  if (maxLength && maxLength < 4) return false;
  if (field.closest?.('[role="search"], form[role="search"]')) return false;
  return true;
}

export function eligibleInputs(root) {
  return queryAllDeep(root, 'input').filter((field) => TEXT_TYPES.has(attr(field, 'type').toLowerCase())
    && attr(field, 'aria-hidden') !== 'true' && !field.hasAttribute?.('data-autofill-honeypot'));
}

export function candidateControls(root) {
  return [...root.querySelectorAll('button, input[type="submit"], input[type="button"], input[type="image"], [role="button"], a[href^="#"], a:not([href])')];
}

export const labelOfControl = (control) => norm([
  control.value && control.tagName === 'INPUT' ? control.value : '',
  control.textContent,
  attr(control, 'aria-label'),
  attr(control, 'title'),
].join(' ')).slice(0, 80);

export const namesOfControl = (control) => ident(
  `${attr(control, 'id')} ${attr(control, 'name')} ${attr(control, 'class')} ${attr(control, 'data-test')} ${attr(control, 'data-testid')} ${attr(control, 'data-hook')} ${attr(control, 'data-event-name')}`,
);

/** D5: true when a form holds payment, password, email, phone, or address fields. */
export function isPersonalForm(form) {
  if (!form?.querySelectorAll) return false;
  return [...form.querySelectorAll('input, select, textarea')].some((field) => {
    const type = attr(field, 'type').toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'checkbox', 'radio'].includes(type)) return false;
    return /^(?:email|password|tel)$/.test(type)
      || /\b(?:cc-|email|tel|street|address|postal|name|username|password)/.test(attr(field, 'autocomplete').toLowerCase())
      || /\b(?:card ?number|cardnumber|cvv|cvc|e ?mail|password|address\d?|postcode|zip|phone|firstname|lastname|first name|last name)\b/.test(ownAttrs(field));
  });
}

/** D5 rule 2: Check that an apply control is safe to press. */
export function isSafeApplyControl(control, field, { fromRecipe = false } = {}) {
  if (!control || control === field || control.contains?.(field)) return false;
  const label = labelOfControl(control);
  const names = namesOfControl(control);
  const says = APPLY.test(label) && !/\b(?:to|au|al|in|i|do) (?:cart|basket|bag|panier|carrito|carrello|winkelwagen|carrinho|varukorg|kurv|koszyka)\b/.test(label);
  const named = ATTR_NOUN.test(names) || /\bapply\b/.test(names);
  const dangerous = DANGER.test(label) || /\b(?:checkout|pay|payment|order|remove|delete|cancel|close|search|update|estimate)\b/.test(names);
  if (dangerous && !(says && named)) return false;
  const type = attr(control, 'type').toLowerCase() || (control.tagName === 'BUTTON' ? 'submit' : '');
  const submits = type === 'submit' && control.form && control.form === field?.form;
  if (!fromRecipe && submits && isPersonalForm(control.form)) return false;
  return true;
}

/** Surroundings of a candidate input: nearby container, heading text, and attribute names. */
export function surroundings(field) {
  const names = [];
  let near = '';
  let box = null;
  let node = field.parentElement;
  for (let depth = 0; node && depth < 5 && !/^(?:BODY|HTML|MAIN)$/.test(node.tagName); depth += 1, node = node.parentElement) {
    const fields = eligibleInputs(node).length;
    if (fields > 2 && !box) break;
    names.push(ident(`${attr(node, 'id')} ${attr(node, 'class')} ${attr(node, 'data-hook')} ${attr(node, 'data-testid')} ${attr(node, 'data-test')} ${attr(node, 'data-link-action')} ${node.tagName.includes('-') ? node.tagName : ''}`));
    const buttons = candidateControls(node);
    if (!box && buttons.length) box = node;
    if (!near) {
      const heading = node.querySelector('legend, h1, h2, h3, h4, h5, h6, summary, .title');
      const text = heading && !heading.contains(field) ? textOf(heading, 120) : '';
      if (text) near = text;
    }
    if (fields > 1) break;
  }
  return { names: names.join(' '), near, box };
}

/** Find the safest apply control belonging to `field`'s container or form. */
export function findApplyControl(field, box) {
  const form = field.form;
  const pool = new Set(box ? candidateControls(box) : []);
  if (form && eligibleInputs(form).length <= 2) {
    for (const control of candidateControls(form)) pool.add(control);
  }
  if (form?.id && field.ownerDocument?.querySelectorAll) {
    try {
      for (const control of field.ownerDocument.querySelectorAll(`button[form="${cssEscape(form.id)}"]`)) pool.add(control);
    } catch {
      // Ignore escape issues.
    }
  }
  const ranked = [];
  for (const control of pool) {
    if (control === field || control.contains?.(field)) continue;
    const label = labelOfControl(control);
    const names = namesOfControl(control);
    const dangerous = DANGER.test(label) || /\b(?:checkout|pay|payment|order|remove|delete|cancel|close|search|update|estimate)\b/.test(names);
    const says = APPLY.test(label) && !/\b(?:to|au|al|in|i|do) (?:cart|basket|bag|panier|carrito|carrello|winkelwagen|carrinho|varukorg|kurv|koszyka)\b/.test(label);
    const named = ATTR_NOUN.test(names) || /\bapply\b/.test(names);
    if (dangerous && !(says && named)) {
      ranked.push({ control, label, score: -100, why: 'danger' });
      continue;
    }
    if (GIFT.test(label) && !NOUN.test(label)) {
      ranked.push({ control, label, score: -100, why: 'gift' });
      continue;
    }
    let score = 0;
    if (says) score += 50;
    if (named) score += 25;
    const type = attr(control, 'type').toLowerCase() || (control.tagName === 'BUTTON' ? 'submit' : '');
    const submits = type === 'submit' && control.form && control.form === form;
    if (submits) score += 10;
    if (!label && !says) score += pool.size === 1 || submits ? 20 : 0;
    if (typeof field.compareDocumentPosition === 'function' && (field.compareDocumentPosition(control) & 4)) score += 5;
    const unsafeForm = submits && isPersonalForm(control.form);
    ranked.push({ control, label, score: unsafeForm ? -100 : score, why: unsafeForm ? 'unsafeForm' : '' });
  }
  ranked.sort((a, b) => b.score - a.score);
  const best = ranked[0];
  return {
    best: best && best.score >= 20 ? best : null,
    unsafeForm: !best || best.score < 20 ? ranked.some((r) => r.why === 'unsafeForm') : false,
    ranked,
  };
}

/** Classify whether this page looks like a cart, checkout, or other shop page. */
export function pageKind(doc, loc = globalThis.location) {
  let path = '';
  try { path = norm(decodeURIComponent(loc?.pathname ?? '')).replace(/[^a-z]+/g, ' '); } catch { path = norm(loc?.pathname ?? ''); }
  const bodyClass = attr(doc.body, 'class');
  const bodyId = attr(doc.body, 'id');
  if (CHECKOUT_PATH.test(path) || /\b(?:woocommerce-checkout|checkout-index-index|page-order)\b/.test(bodyClass) || bodyId === 'checkout') {
    return 'checkout';
  }
  if (CART_ONLY_PATH.test(path) || /\b(?:woocommerce-cart|checkout-cart-index|is-act-cartpage|page-cart)\b/.test(bodyClass) || bodyId === 'cart') {
    return 'cart';
  }
  return 'other';
}

export function isCheckoutish(doc, loc = globalThis.location) {
  return pageKind(doc, loc) !== 'other';
}

/** Score a single candidate input field. */
export function scoreField(field, context) {
  const reasons = [];
  const add = (points, why) => { reasons.push(`${points > 0 ? '+' : ''}${points} ${why}`); return points; };
  if (!isSafeCodeInput(field, { allowDisabled: true })) {
    return { score: -100, reasons: ['ruled out by safety check'], apply: null, unsafeForm: false, box: null, hidden: isHidden(field) };
  }

  const self = ownAttrs(field);
  const data = dataAttrs(field);
  const display = shownAttrs(field);
  const label = labelOf(field);
  const { names, near, box } = surroundings(field);
  const form = field.form;
  const formNames = form
    ? ident(`${attr(form, 'id')} ${attr(form, 'class')} ${attr(form, 'name')} ${attr(form, 'data-testid')} ${attr(form, 'data-link-action')} ${attr(form, 'action').split('?')[0].split('/').slice(-3).join(' ')}`)
    : '';

  const strip = (text) => text.replace(OTHER_LABEL, ' ');
  const other = [display, label].some((text) => { OTHER_LABEL.lastIndex = 0; return OTHER_LABEL.test(text); });
  const texts = strip(`${display} | ${label}`);
  const giftText = GIFT.test(`${display} | ${label}`) || GIFT_ATTR.test(`${self} ${data}`);
  const nounInText = NOUN.test(texts);
  const twoFacedOnly = !nounInText && TWO_FACED.test(texts);
  const nounInOwn = ATTR_NOUN.test(self);
  const nounInData = ATTR_NOUN.test(data);
  let score = 0;

  const naming = [
    nounInOwn && !(giftText && !nounInText && /\b(?:vouchers?|gutschein\w*|kupon\w*|waardebon\w*)\b/.test(self)) ? 'its own name' : '',
    NOUN.test(strip(display)) ? 'its placeholder or aria-label' : '',
    NOUN.test(strip(label)) ? 'its label' : '',
  ].filter(Boolean);
  if (naming.length) score += add(40 + 10 * (naming.length - 1), `names a discount code in ${naming.join(', ')}`);
  else if (twoFacedOnly && !giftText) score += add(30, 'a word that can mean a discount code or a gift voucher');
  else if (DISCOUNT.test(texts)) score += add(25, 'says "discount" without "code"');
  else if (BARE_CODE.test(texts) || BARE_CODE.test(self)) score += add(10, 'only says "code"');
  if (nounInData && !nounInOwn) score += add(15, 'class or test hook names a discount code');
  if (ATTR_NOUN.test(names) || NOUN.test(names)) score += add(20, 'a container around it is named for discount codes');
  if (near && NOUN.test(strip(near)) && !NOUN.test(strip(label))) score += add(15, `heading beside it: "${near.slice(0, 40)}"`);
  if (formNames && (ATTR_NOUN.test(formNames) || NOUN.test(formNames))) score += add(15, 'its form is named for discount codes');

  const apply = findApplyControl(field, box);
  if (apply.best) score += add(apply.best.label && APPLY.test(apply.best.label) ? 15 : 5, `apply control beside it: "${apply.best.label || '(no words)'}"`);
  else if (apply.ranked.some(({ why }) => why === 'danger')) score += add(-15, 'the only button beside it is not for applying a code');

  if (context.total?.leaf && box) {
    let around = box;
    for (let depth = 0; around && depth < 4; depth += 1, around = around.parentElement) {
      if (around.contains?.(context.total.leaf)) {
        score += add(10, 'sits with the order total');
        break;
      }
    }
  }
  if (context.checkoutish) score += add(5, 'the page is a basket or checkout');

  if (giftText && !nounInText) score += add(-45, 'named for gift cards only');
  if (other && !nounInText) score += add(-40, 'its label names another kind of field');
  else if (other && !nounInOwn) score += add(-25, 'its label names a discount code and another kind of field');
  if (SECTION.test(self) && !naming.length) score += add(-30, `its name places it elsewhere: "${self.match(SECTION)[0]}"`);
  if (box && eligibleInputs(box).some((sibling) => sibling !== field && PIN.test(`${shownAttrs(sibling)} ${ownAttrs(sibling)} ${labelOf(sibling)}`))) {
    score += add(-25, 'a PIN field sits beside it');
  }
  if (field.closest?.('header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]')) {
    score += add(-30, 'in the page header, navigation or footer');
  }

  return { score, reasons, apply: apply.best, unsafeForm: apply.unsafeForm, box, hidden: isHidden(field) };
}

/** Find safe controls that open a collapsed promo code box (never navigating links, never DANGER). */
export function findReveals(doc, scope = doc) {
  const out = [];
  const root = scope ?? doc;
  for (const control of queryAllDeep(root, 'summary, button, [role="button"], a, [aria-expanded], [data-toggle], [data-bs-toggle], p, span, label, div')) {
    if (out.length >= 12) break;
    if (isHidden(control) || (control.children?.length ?? 0) > 3) continue;
    const text = norm(control.textContent ?? '');
    if (!text || text.length > 60 || !REVEAL.test(text) || DANGER.test(text)) continue;
    const href = attr(control, 'href');
    const link = control.tagName === 'A' && href && !href.startsWith('#') && !/^javascript:/i.test(href);
    const toggles = control.tagName === 'SUMMARY'
      || control.hasAttribute?.('aria-expanded')
      || control.hasAttribute?.('aria-controls')
      || control.hasAttribute?.('data-toggle')
      || control.hasAttribute?.('data-bs-toggle')
      || control.hasAttribute?.('data-bs-target')
      || [...(control.attributes ?? [])].some(({ name }) => /^data-.*(?:trigger|toggle)/.test(name));
    const pressable = control.tagName === 'BUTTON' || attr(control, 'role') === 'button' || (control.tagName === 'A' && !link);
    if (link && !toggles) continue;
    if (!toggles && !pressable) continue;
    if (out.some(({ control: seen }) => seen.contains?.(control) || control.contains?.(seen))) continue;
    if (control.querySelector?.('input, select, textarea')) continue;
    const owner = control.form ?? control.closest?.('form');
    if (owner && eligibleInputs(owner).length && /^(?:BUTTON|INPUT)$/.test(control.tagName)) continue;
    out.push({ control, text, toggles, tag: control.tagName.toLowerCase() });
  }
  return out;
}

/** Run the heuristic finder across the document. */
export function findCodeBox(doc, loc = globalThis.location) {
  const total = findGenericTotal(doc).pick;
  const kind = pageKind(doc, loc);
  const context = { total, checkoutish: kind !== 'other' };
  const scored = eligibleInputs(doc)
    .map((field) => ({ field, ...scoreField(field, context) }))
    .filter(({ score }) => score > -100)
    .sort((a, b) => b.score - a.score);

  const judge = (list) => {
    const [first, second] = list;
    if (!first || first.score < LISTED) return 'none';
    if (first.unsafeForm) return 'unsafeForm';
    if (first.score < ACCEPT) return 'unsure';
    if (second && second.score >= ACCEPT && first.score - second.score < MARGIN) return 'ambiguous';
    if (first.apply) return 'found';
    return first.unsafeForm ? 'unsafeForm' : 'no-button';
  };

  const onShow = scored.filter((entry) => !entry.hidden);
  const tucked = scored.filter((entry) => entry.hidden);
  let verdict = judge(onShow);
  let chosen = onShow[0] ?? null;

  if (verdict === 'none' || verdict === 'unsure') {
    const behind = judge(tucked);
    if (behind === 'found' || behind === 'no-button' || behind === 'ambiguous' || behind === 'unsafeForm') {
      verdict = behind === 'found' ? 'behind' : behind;
      chosen = tucked[0];
    }
  }

  const reveals = findReveals(doc);
  if ((verdict === 'none' || verdict === 'unsure') && reveals.length) {
    verdict = 'behind';
    chosen = null;
  }

  return {
    verdict,
    chosen: ['found', 'behind', 'no-button', 'unsafeForm'].includes(verdict) ? chosen : null,
    scored,
    candidates: scored.filter((s) => s.score >= LISTED).length,
    total,
    page: kind,
    reveals,
  };
}

/** Find a same-origin cart/basket link on a storefront page so the popup can offer "Open my basket". */
export function findCartLink(doc, loc = globalThis.location) {
  if (!loc?.origin) return null;
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = attr(a, 'href').trim();
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) continue;
    let url;
    try { url = new URL(href, loc.href); } catch { continue; }
    if (url.origin !== loc.origin) continue;
    const path = norm(url.pathname).replace(/[^a-z]+/g, ' ');
    if (CART_PATH.test(path) && !/\b(?:add|remove|delete|login|signin)\b/.test(path)) {
      return `${url.pathname}${url.search}`;
    }
  }
  return null;
}
