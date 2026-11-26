// Myprotein UK basket reader for "Other retailers" whole-basket price comparison.
// Checkout auto-try now lives in extension/autotry/ (with THG nutrition as one recipe among many).
// Chrome serializes this function into the active tab's isolated world.

export function readMyproteinBasket() {
  if (location.protocol !== 'https:' || !['www.myprotein.com', 'myprotein.com'].includes(location.hostname)
    || !/^\/basket\/?$/.test(location.pathname)) return [];

  const pence = (pounds, pennies) => Number(pounds.replaceAll(',', '')) * 100 + Number(pennies);
  // The prices a row shows, in pence, lowest first: every element whose whole text is one price.
  // A crossed-out "was" price is not one of them.
  function shown(row) {
    const prices = new Set();
    for (const cell of row.querySelectorAll('*')) {
      const written = /^£\s?(\d[\d,]*)\.(\d{2})$/.exec((cell.textContent ?? '').trim());
      if (!written) continue;
      let crossed = false;
      for (let node = cell; node && node !== row && !crossed; node = node.parentElement) {
        crossed = /^(?:S|DEL|STRIKE)$/.test(node.tagName ?? '') || (typeof getComputedStyle === 'function'
          && /line-through/.test(getComputedStyle(node).textDecorationLine ?? ''));
      }
      if (!crossed) prices.add(pence(written[1], written[2]));
    }
    return [...prices].sort((low, high) => low - high);
  }

  // `unit` is the price of one, in pence, and only when the page leaves no doubt about it: a line of one that shows a
  // single price, or a line of several that shows both the price of one and its total. Anything else stays unknown,
  // because a line total passed off as the price of one would make every other retailer look cheaper than it is.
  const lines = [];
  let plain = true;
  let hasOtherRow = false;
  for (const row of document.querySelectorAll('main basket-item')) {
    const link = [...row.querySelectorAll('a[href^="/p/"]')].find((anchor) => anchor.textContent.trim());
    if (!link || !row.querySelector('[data-e2e="basket-remove_item_button"]')) {
      plain = false;
      hasOtherRow = true;
      continue;
    }
    const name = link.textContent.trim();
    const specs = link?.parentElement.nextElementSibling;
    const variant = specs?.tagName === 'UL'
      ? [...specs.querySelectorAll('li')].map((spec) => spec.textContent.trim().replace(/\s*-\s*\d+\s*servings?$/i, ''))
        .filter(Boolean).join(', ').slice(0, 100)
      : '';
    const branded = (/^myprotein\b/i.test(name) ? name : `Myprotein ${name}`).slice(0, 140);
    const prices = shown(row);
    const typed = row.querySelector('.quantity')?.value;
    const count = /^[1-9]\d{0,2}$/.test(typed ?? '') ? Number(typed) : 0;
    let unit = null;
    if (count === 1 && prices.length === 1) [unit] = prices;
    else if (count > 1 && prices.length === 2 && prices[1] === prices[0] * count) [unit] = prices;
    if (!count || prices.length !== 1) plain = false;
    lines.push({ key: JSON.stringify([branded, variant]), name: branded, variant, count, price: prices[0], prices, unit });
  }

  let subtotal = null;
  if (!hasOtherRow) {
    for (const label of document.querySelectorAll('main span, main p')) {
      if (label.childElementCount || label.textContent?.trim() !== 'Basket subtotal:') continue;
      const money = label.nextElementSibling?.textContent.match(/£\s*([\d,]+)\.(\d{2})/);
      if (money) {
        subtotal = pence(money[1], money[2]);
        break;
      }
    }
  }

  // A line of several that shows one price: is it the price of one, or the line's total? When every row is such a
  // plain line, the basket subtotal says which, because only one of the two sums can match it.
  if (plain && lines.some(({ count }) => count > 1) && subtotal !== null) {
    const each = lines.reduce((sum, { count, price }) => sum + count * price, 0);
    const totals = lines.reduce((sum, { price }) => sum + price, 0);
    for (const line of lines) {
      if (line.count === 1) continue;
      if (subtotal === each) line.unit = line.price;
      else if (subtotal === totals && line.price % line.count === 0) line.unit = line.price / line.count;
    }
  }

  // A single-product basket with a real basket subtotal settles the unit price even when the row shows two prices
  // (e.g. RRP/subscription or an applied promo code reducing the subtotal).
  if (!hasOtherRow && lines.length === 1 && subtotal > 0) {
    const [only] = lines;
    if (only.count === 1 && only.prices.length > 0) {
      if (!only.unit && (only.prices.includes(subtotal) || subtotal < only.prices[only.prices.length - 1])) {
        only.unit = subtotal;
      } else if (only.unit && subtotal < only.unit) {
        only.unit = subtotal;
      }
    } else if (only.count > 1 && !only.unit && subtotal % only.count === 0) {
      const perUnit = subtotal / only.count;
      if (only.prices.includes(subtotal) || only.prices.includes(perUnit)) only.unit = perUnit;
    }
  }

  const items = new Map();
  for (const { key, name, variant, unit } of lines) {
    const clash = items.has(key) && items.get(key).unit !== unit;
    items.set(key, { name, variant, unit: clash ? null : unit });
  }
  return [...items.values()].map(({ name, variant, unit }) => (unit > 0
    ? { name, variant, price: unit / 100, currency: 'GBP' } : { name, variant }));
}
