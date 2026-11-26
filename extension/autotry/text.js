// Pure text normalization, safe CSS escaping, visibility checks, and shadow-DOM traversal.
// Uses no eval, no new Function, no innerText, and falls back when CSS.escape or checkVisibility are absent (jsdom).

const FOLD = { ø: 'o', æ: 'ae', ł: 'l', ß: 'ss', đ: 'd', œ: 'oe', ı: 'i', å: 'a' };

/** Fold accents, ligatures, invisible bidi marks, and whitespace to a lowercase searchable string. */
export function norm(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[øæłßđœıå]/g, (letter) => FOLD[letter] ?? letter)
    .replace(/[\u200e\u200f\u00ad]/g, '')
    .replace(/[\u00a0\u202f\u2009]/g, ' ')
    .replace(/[’‘`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Read camelCase / snake_case / kebab-case identity attributes as words. */
export function ident(value) {
  return norm(
    String(value ?? '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[^A-Za-z0-9\u00c0-\u024f]+/g, ' '),
  );
}

/** CSS identifier escape that works in browsers and in jsdom without global CSS.escape. */
export function cssEscape(value) {
  const str = String(value ?? '');
  if (typeof globalThis.CSS?.escape === 'function') return globalThis.CSS.escape(str);
  let out = '';
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    if (code === 0) {
      out += '\ufffd';
    } else if ((code >= 0x0001 && code <= 0x001f) || code === 0x007f || (i === 0 && code >= 0x0030 && code <= 0x0039)
      || (i === 1 && code >= 0x0030 && code <= 0x0039 && str.charCodeAt(0) === 0x002d)) {
      out += `\\${code.toString(16)} `;
    } else if (i === 0 && str.length === 1 && code === 0x002d) {
      out += '\\-';
    } else if (code >= 0x0080 || code === 0x002d || code === 0x005f
      || (code >= 0x0030 && code <= 0x0039) || (code >= 0x0041 && code <= 0x005a) || (code >= 0x0061 && code <= 0x007a)) {
      out += str[i];
    } else {
      out += `\\${str[i]}`;
    }
  }
  return out;
}

export const attr = (element, name) => (element?.getAttribute ? element.getAttribute(name) ?? '' : '');

export const textOf = (element, limit = 160) => norm(element?.textContent ?? '').slice(0, limit);

export const rawTextOf = (element, limit = 160) => String(element?.textContent ?? '')
  .replace(/[\u200e\u200f\u00ad]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, limit);

/** Check markup hints for hidden elements (works both in Chrome and jsdom). */
export function hiddenByMarkup(element) {
  for (let node = element; node && node.nodeType === 1; node = node.parentElement ?? node.getRootNode?.()?.host ?? null) {
    if (node.hidden) return true;
    const style = attr(node, 'style');
    if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?(?:\s*;|\s*$))/i.test(style)) return true;
    if (node.tagName === 'DETAILS' && !node.open && !node.querySelector(':scope > summary')?.contains(element)) return true;
    const cls = attr(node, 'class');
    if (/\b(?:collapse|d-none|hidden|sr-only|visually-hidden)\b/.test(cls) && !/\b(?:show|in|lg:flex|md:flex|sm:block|md:block|lg:block)\b/.test(cls)) {
      // Allow responsive classes like `hidden lg:flex` only if checkVisibility isn't available to prove it's hidden.
      if (!/\b(?:sm|md|lg|xl):(?:flex|block|grid|inline)\b/.test(cls)) return true;
    }
  }
  return false;
}

/** True when an element is hidden from the shopper. */
export function isHidden(element) {
  if (!element || !element.isConnected) return true;
  if (typeof element.checkVisibility === 'function') {
    try {
      if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return true;
    } catch {
      // Fallback below.
    }
  }
  return hiddenByMarkup(element);
}

/** Safely read an open or closed shadow root when available. */
export function shadowOf(element) {
  try {
    if (typeof globalThis.chrome?.dom?.openOrClosedShadowRoot === 'function') {
      return globalThis.chrome.dom.openOrClosedShadowRoot(element);
    }
  } catch {
    // Not in an extension world or element has none.
  }
  return element?.shadowRoot ?? null;
}

/** Collect document plus accessible shadow roots (bounded to avoid huge custom-element trees stalling). */
export function collectRoots(root, maxRoots = 24) {
  const roots = [root];
  const seen = new Set([root]);
  for (let i = 0; i < roots.length && roots.length < maxRoots; i += 1) {
    const current = roots[i];
    if (!current?.querySelectorAll) continue;
    let scanned = 0;
    for (const node of current.querySelectorAll('*')) {
      scanned += 1;
      if (scanned > 3000) break;
      const sr = shadowOf(node);
      if (sr && !seen.has(sr)) {
        seen.add(sr);
        roots.push(sr);
        if (roots.length >= maxRoots) break;
      }
    }
  }
  return roots;
}

/** Query across document and accessible shadow roots, ignoring invalid selectors safely. */
export function queryAllDeep(root, selector) {
  const out = [];
  for (const scope of collectRoots(root)) {
    try {
      for (const el of scope.querySelectorAll(selector)) out.push(el);
    } catch {
      // Invalid selector for this engine: ignore.
    }
  }
  return out;
}

/** First element matching selector across document and accessible shadow roots. */
export function queryDeep(root, selector) {
  for (const scope of collectRoots(root)) {
    try {
      const hit = scope.querySelector(selector);
      if (hit) return hit;
    } catch {
      // Ignore invalid selector.
    }
  }
  return null;
}
