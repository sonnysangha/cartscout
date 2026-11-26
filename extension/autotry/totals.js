// Order total reader: recipe-specific total selectors + generic multi-language total finder.

import { formatMoney, moneyFromMinor, parseMoney } from './money.js';
import { attr, isHidden, norm, queryAllDeep, rawTextOf } from './text.js';
import { MONEY_HINT, NOT_THE_TOTAL, SUBTOTAL, TAX, TOTAL, WITH_TAX } from './vocab.js';

function readJsonPath(obj, dotted) {
  let cur = obj;
  for (const part of String(dotted ?? '').split('.')) {
    if (cur == null) return undefined;
    if (part.endsWith('[]')) {
      const key = part.slice(0, -2);
      const arr = key ? cur[key] : cur;
      if (!Array.isArray(arr)) return undefined;
      cur = arr;
    } else if (Array.isArray(cur)) {
      cur = cur.map((item) => item?.[part]).filter((v) => v !== undefined);
    } else {
      cur = cur[part];
    }
  }
  return cur;
}

/** Read a total described by a recipe's `total` spec. Returns `{ money, leaf }` or `null`. */
export function readRecipeTotal(doc, spec, scope = doc) {
  if (!spec) return null;
  const kind = spec.kind || 'total';
  const allowHidden = !!spec.hidden;

  // JSON embedded in an element attribute (e.g. Magento Hyva `section.cart-form[data-checkout-config]`).
  if (spec.json?.from === 'attr') {
    const node = doc.querySelector(spec.json.at);
    const raw = node ? attr(node, spec.json.attr) : '';
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const val = Number(readJsonPath(parsed, spec.json.total));
        if (Number.isFinite(val) && val > 0) {
          const currency = spec.json.currency ? String(readJsonPath(parsed, spec.json.currency) ?? '') : '';
          const format = { prefix: currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '', suffix: '', group: ',', decimal: '.', decimals: 2 };
          return {
            money: { value: val, text: formatMoney(val, format, currency), kind, label: 'Total', currency, format },
            leaf: node,
          };
        }
      } catch {
        // Malformed JSON attribute; fall through.
      }
    }
  }

  // Shopify checkout Cost summary table: row whose cell holds <abbr> followed by <strong>.
  if (spec.special === 'shopify-checkout-total') {
    for (const row of queryAllDeep(doc, '[role="row"]')) {
      if (!allowHidden && isHidden(row)) continue;
      const cell = row.querySelector('[role="cell"]');
      if (!cell) continue;
      const abbr = cell.querySelector('abbr');
      const strong = cell.querySelector('strong');
      if (!abbr || !strong) continue;
      const raw = rawTextOf(strong, 36);
      const parsed = parseMoney(raw);
      if (parsed) {
        const iso = rawTextOf(abbr, 6).toUpperCase();
        const currency = /^[A-Z]{3}$/.test(iso) ? iso : parsed.currency;
        return {
          money: { value: parsed.value, text: raw, kind, label: 'Total', currency, format: parsed.format },
          leaf: strong,
        };
      }
    }
    return null;
  }

  // OpenCart table: last row of a totals table whose first cell starts with "Total" (or last row).
  if (spec.special === 'opencart-total') {
    const tables = spec.at ? queryAllDeep(doc, spec.at.join(', ')) : [];
    for (const table of tables) {
      if (!allowHidden && isHidden(table)) continue;
      const rows = [...table.querySelectorAll('tr')];
      const match = [...rows].reverse().find((r) => /^\s*total\b/i.test(rawTextOf(r.cells?.[0] ?? r.querySelector('td, th'), 40)))
        ?? rows.at(-1);
      if (!match) continue;
      const cell = match.cells?.[match.cells.length - 1] ?? match.querySelector('td:last-child');
      const raw = rawTextOf(cell, 36);
      const parsed = parseMoney(raw);
      if (parsed) {
        return { money: { value: parsed.value, text: raw, kind, label: 'Total', currency: parsed.currency, format: parsed.format }, leaf: cell };
      }
    }
    return null;
  }

  // Label-sibling matching (THG Myprotein "Basket subtotal:", Lookfantastic "SUBTOTAL", SF Headless).
  if (Array.isArray(spec.label) && spec.label.length) {
    const wanted = spec.label.map((l) => norm(l));
    const root = spec.inScope && scope ? scope : (doc.querySelector('main') ?? doc);
    for (const node of root.querySelectorAll('span, p, dt, th, div, strong, b')) {
      if (node.childElementCount > 1) continue;
      if (!allowHidden && isHidden(node)) continue;
      const label = norm(node.textContent ?? '');
      if (!wanted.includes(label)) continue;
      const sibling = node.nextElementSibling;
      const raw = rawTextOf(sibling, 36);
      const parsed = parseMoney(raw);
      if (parsed) {
        return {
          money: { value: parsed.value, text: raw, kind, label: rawTextOf(node, 40), currency: parsed.currency, format: parsed.format },
          leaf: sibling,
        };
      }
    }
  }

  // Direct CSS selectors.
  if (Array.isArray(spec.at)) {
    for (const sel of spec.at) {
      for (const el of queryAllDeep(scope ?? doc, sel)) {
        if (!allowHidden && isHidden(el)) continue;
        const raw = rawTextOf(el, 36);
        const parsed = parseMoney(raw);
        if (parsed) {
          return {
            money: { value: parsed.value, text: raw, kind, label: kind === 'subtotal' ? 'Subtotal' : 'Total', currency: parsed.currency, format: parsed.format },
            leaf: el,
          };
        }
      }
    }
  }
  return null;
}

/**
 * Generic multi-language order total finder (no recipe needed).
 * Returns `{ pick: { money, leaf, kind, label, text, withTax } | null, found }`.
 */
export function findGenericTotal(doc) {
  const found = [];
  const leaves = queryAllDeep(doc, 'span, strong, b, td, dd, p, div, bdi, ins, li').slice(0, 6000);
  for (const leaf of leaves) {
    if (found.length >= 40) break;
    if (isHidden(leaf)) continue;
    const raw = rawTextOf(leaf, 36);
    const text = norm(raw);
    if (!text || text.length > 28 || !MONEY_HINT.test(text) || leaf.closest?.('s, del, strike, [aria-hidden="true"]')) continue;
    if ([...(leaf.children ?? [])].some((child) => {
      const childText = norm(child.textContent ?? '');
      return MONEY_HINT.test(childText) && childText.length >= text.length - 2;
    })) continue;

    let label = '';
    for (let node = leaf, depth = 0; node && depth < 4 && !label; node = node.parentElement, depth += 1) {
      let previous = node.previousElementSibling;
      while (previous && !norm(previous.textContent ?? '')) previous = previous.previousElementSibling;
      const beside = previous ? norm(previous.textContent ?? '') : '';
      if (beside && beside.length <= 60 && !MONEY_HINT.test(beside)) {
        label = beside;
      } else if (node.parentElement) {
        const row = norm(node.parentElement.textContent ?? '');
        const rest = row.replace(text, ' ').trim();
        if (rest && rest.length <= 60 && !MONEY_HINT.test(rest)) label = rest;
      }
    }
    if (!label) continue;
    const named = SUBTOTAL.test(label) ? 'subtotal' : TOTAL.test(label) ? 'total' : 'other';
    const kind = NOT_THE_TOTAL.test(label) || (TAX.test(label) && named === 'other') ? 'other' : named;
    if (kind === 'other') continue;
    if (leaf.closest?.('header, nav, [role="banner"], [role="navigation"]')) continue;

    const parsed = parseMoney(raw);
    if (!parsed) continue;
    found.push({
      kind,
      label: label.slice(0, 40),
      text: raw,
      leaf,
      withTax: WITH_TAX.test(label),
      money: {
        value: parsed.value,
        text: raw,
        kind,
        label: label.slice(0, 40),
        currency: parsed.currency,
        format: parsed.format,
      },
    });
  }
  const grand = found.filter(({ kind }) => kind === 'total');
  const pick = grand.filter(({ withTax }) => withTax).at(-1)
    ?? grand.at(-1)
    ?? found.filter(({ kind }) => kind === 'subtotal').at(-1)
    ?? null;
  return { pick, found };
}

/** Read a same-origin JSON state endpoint (e.g. WooCommerce Store API `/wp-json/wc/store/v1/cart`). */
export async function readStateEndpoint(spec, fetcher = globalThis.fetch) {
  if (!spec || spec.from !== 'fetch' || !spec.url || typeof fetcher !== 'function') return null;
  try {
    const res = await fetcher(spec.url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const rawTotal = Number(readJsonPath(data, spec.total));
    const minor = typeof spec.minor === 'number' ? spec.minor : Number(readJsonPath(data, spec.minor) ?? 2);
    const currency = String(readJsonPath(data, spec.currency) ?? '');
    const codesRaw = spec.codes ? readJsonPath(data, spec.codes) : [];
    const codes = Array.isArray(codesRaw)
      ? codesRaw.map((c) => String(c ?? '').trim().toUpperCase()).filter(Boolean)
      : (typeof codesRaw === 'string' && codesRaw.trim() ? [codesRaw.trim().toUpperCase()] : []);
    const money = Number.isFinite(rawTotal) && rawTotal >= 0
      ? moneyFromMinor(rawTotal, currency, Number.isInteger(minor) ? minor : 2, 'total', 'Total')
      : null;
    return { money, codes };
  } catch {
    return null;
  }
}
