// Universal basket & checkout item reader for "Other retailers" price comparison.
// Chrome serializes readPageBasket into the active tab's isolated world via executeScript({ func }),
// so everything it needs lives inside the function.

export function isBasketPath(pathname = '') {
  return /(?:^|\/)(?:cart|basket|my\.basket|bag|checkout|checkouts|warenkorb|kasse|panier|carrito|cesta|carrello|winkelwagen)(?:\/|$)/i.test(String(pathname));
}

export function readPageBasket(root = document, place = location) {
  const clean = (value, limit = 140) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '');
  const tag = (el) => String(el?.tagName ?? '').toUpperCase();
  const attr = (el, name) => String(el?.getAttribute?.(name) ?? '');
  const styleOf = root.defaultView?.getComputedStyle?.bind(root.defaultView) ?? globalThis.getComputedStyle;

  const isHidden = (el, stopAt) => {
    for (let node = el, depth = 0; node && node !== stopAt && depth < 8; node = node.parentElement, depth += 1) {
      if (node.hidden || attr(node, 'aria-hidden') === 'true') return true;
      const cls = attr(node, 'class');
      if (/\b(?:sr-only|visually-hidden|screen-reader(?:-text|-only)?|a-offscreen|offscreen)\b/i.test(cls)) return true;
      if (typeof styleOf === 'function') {
        try {
          const st = styleOf(node);
          if (st?.display === 'none' || st?.visibility === 'hidden') return true;
        } catch { /* ignore */ }
      }
    }
    return false;
  };

  const isStruck = (el, stopAt) => {
    for (let node = el; node && node !== stopAt; node = node.parentElement) {
      if (/^(?:S|DEL|STRIKE)$/.test(tag(node))) return true;
      if (typeof styleOf === 'function') {
        try {
          if (/line-through/.test(styleOf(node)?.textDecorationLine ?? '')) return true;
        } catch { /* ignore */ }
      }
    }
    return false;
  };

  const host = String(place?.hostname ?? '').toLowerCase();
  const defaultDollar = host.endsWith('.ca') ? 'CAD'
    : host.endsWith('.com.au') || host.endsWith('.au') ? 'AUD'
      : host.endsWith('.co.nz') || host.endsWith('.nz') ? 'NZD'
        : 'USD';

  const detectCurrency = (raw) => {
    if (/£|\bGBP\b/i.test(raw)) return 'GBP';
    if (/€|\bEUR\b/i.test(raw)) return 'EUR';
    if (/\bAED\b|د\.إ/i.test(raw)) return 'AED';
    if (/\bCAD\b|CA\$/i.test(raw)) return 'CAD';
    if (/\bAUD\b|AU\$/i.test(raw)) return 'AUD';
    if (/\bUSD\b|US\$|\$/i.test(raw)) return defaultDollar;
    return '';
  };

  const parsePrice = (raw) => {
    const text = clean(raw, 80);
    if (!text || /^[-−–]\s*[£$€]/.test(text) || /save\b|off\b|discount\b|free\b/i.test(text)) return null;
    const currency = detectCurrency(text);
    if (!currency) return null;
    const stripped = text.replace(/\b(?:GBP|USD|EUR|CAD|AUD|NZD|AED)\b/gi, '').replace(/[£$€\s\u00a0\u202f]/g, '');
    const match = /^(\d[\d.,]*)$/.exec(stripped);
    if (!match) return null;
    const digits = match[1].replace(/[.,]+$/, '');
    const decimal = digits.match(/[.,](\d{2})$/);
    const whole = (decimal ? digits.slice(0, decimal.index) : digits).replace(/[.,]/g, '');
    const value = Number((whole || '0') + (decimal ? `.${decimal[1]}` : ''));
    return Number.isFinite(value) && value > 0 ? { price: value, currency } : null;
  };

  const isPriceLike = (raw) => parsePrice(raw) !== null || /^[-−–]?\s*(?:GBP|USD|EUR|AED)?\s*[£$€]\s?\d/i.test(clean(raw, 60));

  const NON_PRODUCT = /^(?:free\s+returns?(?:\s+coverage)?|returns?\s+coverage|shipping\s+protection|package\s+protection|order\s+protection|route(?:\s+package)?|redo(?:\s+free)?|seel\b|delivery|shipping|standard\s+delivery|express\s+delivery|gift\s+(?:wrap|note|message|card|bag)|tip\b|subtotal|order\s+discount|discount|total\s+savings|estimated\s+total|estimated\s+tax|total\b|including\b.*\btax|tax\b|vat\b|free\s+gift|free\s+sample|sample\b|promo\s+code|coupon|product\s+image|description|quantity|price|cost\s+summary|order\s+summary|balance\s+due|amount\s+due|you\s+save)/i;

  const isNonProduct = (name) => {
    const t = clean(name, 140);
    if (t.length < 3 || /^\d+$/.test(t) || isPriceLike(t)) return true;
    return NON_PRODUCT.test(t) || /(?:returns?\s+coverage|shipping\s+protection|package\s+protection|order\s+protection|total\s+savings|in\s+taxes)/i.test(t);
  };

  const UPSELL = /recommend|upsell|cross[-_ ]?sell|carousel|browsing|recently[-_ ]?viewed|also[-_ ]?bought|you[-_ ]?may[-_ ]?like|inspired|trending|related/i;
  const inExcludedArea = (el) => {
    for (let node = el, depth = 0; node && depth < 12; node = node.parentElement, depth += 1) {
      if (/^(?:FOOTER|NAV)$/.test(tag(node))) return true;
      const sig = `${attr(node, 'id')} ${attr(node, 'class')} ${attr(node, 'aria-label')} ${attr(node, 'data-testid')}`;
      if (UPSELL.test(sig)) return true;
    }
    return false;
  };

  // Site brand name (for single-brand storefronts whose product titles start with "Men's ..." / "Women's ...").
  const siteBrand = (() => {
    const og = clean(root.querySelector('meta[property="og:site_name"]')?.getAttribute('content'), 40);
    if (og && og.length >= 2 && !/\s+-\s+/.test(og)) return og;
    const labels = host.replace(/^www\./, '').split('.').filter(Boolean);
    const suffixed = labels.length >= 3 && labels.at(-1).length === 2 && /^(?:co|com|org|net)$/.test(labels.at(-2));
    const core = labels.at(suffixed ? -3 : -2) ?? labels[0] ?? '';
    return core.length >= 3 ? core.charAt(0).toUpperCase() + core.slice(1) : '';
  })();

  const withBrand = (name) => {
    const t = clean(name, 140);
    if (!siteBrand || t.toLowerCase().includes(siteBrand.toLowerCase())) return t;
    if (/^(?:men['’]?s|women['’]?s|unisex|kids['’]?s?|youth)\b/i.test(t)) return clean(`${siteBrand} ${t}`, 140);
    return t;
  };

  const findRowPrices = (row) => {
    const found = [];
    const seen = new Set();
    for (const node of row.querySelectorAll('*')) {
      if (node.children.length > 2) continue;
      if (isHidden(node, row) || isStruck(node, row)) continue;
      const parsed = parsePrice(node.textContent);
      if (!parsed) continue;
      const key = `${parsed.currency}:${parsed.price}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(parsed);
    }
    return found;
  };

  const readQuantity = (row) => {
    const input = row.querySelector('input.quantity, input[name*="qty" i], input[name*="quantity" i], select[name*="qty" i], select[name*="quantity" i], input[type="number"]');
    if (input && /^[1-9]\d{0,2}$/.test(String(input.value ?? '').trim())) return Number(input.value);
    for (const node of row.querySelectorAll('[aria-label*="quantity" i], [data-testid*="quantity" i], [class*="quantity" i]')) {
      const m = /\b([1-9]\d?)\b/.exec(clean(node.textContent || attr(node, 'aria-label'), 40));
      if (m) return Number(m[1]);
    }
    return 1;
  };

  const resolveUnitPrice = (prices, qty) => {
    if (!prices.length) return null;
    if (prices.length === 1) {
      const [only] = prices;
      if (qty > 1) {
        // On checkouts (like Shopify) a single price on a multi-qty row is typically the line total.
        const split = Math.round((only.price * 100) / qty);
        if (split * qty === Math.round(only.price * 100)) return { price: split / 100, currency: only.currency };
      }
      return only;
    }
    const sorted = [...prices].sort((a, b) => a.price - b.price);
    if (qty > 1 && sorted.length === 2 && sorted[0].currency === sorted[1].currency
      && Math.round(sorted[1].price * 100) === Math.round(sorted[0].price * 100) * qty) {
      return sorted[0];
    }
    return sorted[0];
  };

  const items = [];
  const dedup = new Set();
  const pushItem = (rawName, rawVariant, unit) => {
    if (isNonProduct(rawName)) return;
    const name = withBrand(rawName);
    let variant = clean(rawVariant, 100);
    if (variant && (variant.toLowerCase() === name.toLowerCase() || isPriceLike(variant) || isNonProduct(variant))) variant = '';
    const key = `${name.toLowerCase()}|${variant.toLowerCase()}`;
    if (dedup.has(key)) return;
    dedup.add(key);
    items.push(unit ? { name, variant, price: unit.price, currency: unit.currency } : { name, variant });
  };

  // Strategy 1: Shopify Checkout Order Summary (modern ARIA table & legacy .product-table).
  // Prefer the explicit "Shopping cart" table and strictly skip "Cost summary" / totals tables.
  const cartTables = [...root.querySelectorAll('[role="table"][aria-label*="cart" i]')];
  const shopifyTables = cartTables.length
    ? cartTables
    : [...root.querySelectorAll('[role="table"][aria-label*="order" i], aside [role="table"], section[aria-label*="Order summary" i] [role="table"]')]
        .filter((table) => !/cost\s+summary|order\s+totals?|payment/i.test(attr(table, 'aria-label')));
  for (const table of shopifyTables) {
    if (inExcludedArea(table)) continue;
    for (const row of table.querySelectorAll('[role="row"]')) {
      if (row.querySelector('[role="columnheader"]')) continue;
      const cells = [...row.querySelectorAll('[role="cell"], [role="rowheader"]')];
      if (cells.length < 2) continue;
      const prices = findRowPrices(row);
      if (!prices.length) continue;
      // Extract clean text lines from non-price cells (excluding bare quantity badges).
      const texts = [];
      let qty = 1;
      for (const cell of cells) {
        const cellText = clean(cell.textContent, 200);
        if (!cellText || isPriceLike(cellText)) continue;
        if (/^(?:quantity\s*)?([1-9]\d?)$/i.test(cellText)) {
          qty = Number(cellText.replace(/\D/g, '')) || 1;
          continue;
        }
        const leaves = [...cell.querySelectorAll('p, span, div, a, h2, h3, h4')]
          .filter((n) => n.children.length === 0 && !isHidden(n, row))
          .map((n) => clean(n.textContent, 140))
          .filter(Boolean);
        const candidates = leaves.length ? leaves : [cellText];
        for (const line of candidates) {
          if (/^(?:quantity\s*)?([1-9]\d?)$/i.test(line)) {
            qty = Number(line.replace(/\D/g, '')) || 1;
            continue;
          }
          if (isPriceLike(line) || texts.includes(line)) continue;
          texts.push(line);
        }
      }
      if (!texts.length) continue;
      pushItem(texts[0], texts[1] ?? '', resolveUnitPrice(prices, qty));
    }
  }

  // Legacy Shopify checkout table.
  if (!items.length) {
    for (const row of root.querySelectorAll('table.product-table tr.product')) {
      const title = clean(row.querySelector('.product__description__name')?.textContent, 140);
      const variant = clean(row.querySelector('.product__description__variant')?.textContent, 100);
      const qtyText = clean(row.querySelector('.product-thumbnail__quantity')?.textContent, 10);
      const qty = /^[1-9]\d{0,2}$/.test(qtyText) ? Number(qtyText) : 1;
      const prices = findRowPrices(row);
      if (title) pushItem(title, variant, resolveUnitPrice(prices, qty));
    }
  }

  // Strategy 2: Amazon active cart.
  if (!items.length) {
    for (const row of root.querySelectorAll('#sc-active-cart .sc-list-item[data-asin]')) {
      const title = clean(row.querySelector('.sc-product-title, .a-truncate-full, .a-truncate-cut')?.textContent, 140);
      const prices = findRowPrices(row);
      const qty = readQuantity(row);
      if (title) pushItem(title, '', resolveUnitPrice(prices, qty));
    }
  }

  // Strategy 3: Generic cart / basket / checkout item rows.
  if (!items.length) {
    const rowSelectors = [
      'main basket-item',
      '[data-testid*="cart-item" i]',
      '[data-testid*="basket-item" i]',
      '[data-test*="cart-item" i]',
      '[data-e2e*="basket-item" i]',
      'tr.cart_item',
      '.cart-item',
      '.cart__item',
      '.basket-item',
      '.bag-item',
      '.line-item',
      '[class*="CartItem"]',
      '[class*="BasketItem"]',
      '[class*="LineItem"]',
    ].join(', ');
    const rows = [...root.querySelectorAll(rowSelectors)].filter((row) => !inExcludedArea(row) && !isHidden(row, root.body));
    // Keep only top-level item rows (skip nested elements that also match).
    const topRows = rows.filter((row) => !rows.some((other) => other !== row && other.contains(row)));
    for (const row of topRows) {
      const titleEl = row.querySelector('a[href*="/p/"], a[href*="/product"], a[href*="/products/"], h2, h3, h4, [class*="title" i], [class*="name" i]');
      const title = clean(titleEl?.textContent, 140);
      if (!title || isNonProduct(title)) continue;
      const variantEl = row.querySelector('[class*="variant" i], [class*="option" i], [class*="size" i], ul li');
      const variant = clean(variantEl?.textContent, 100);
      const qty = readQuantity(row);
      const prices = findRowPrices(row);
      pushItem(title, variant, resolveUnitPrice(prices, qty));
    }
  }

  return items.slice(0, 12);
}
