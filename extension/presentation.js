// How other retailers' offers are drawn, and the few sums behind them.
// Nothing here compares prices unless it is a like-for-like comparison in one currency.

const matchLabels = {
  exact: 'Same product',
  different_variant: 'Different size or flavour',
  unconfirmed: 'Variant not confirmed',
};

/** The pill in a row's price column when there is no like-for-like difference to show there, and its tone. */
const matchBadges = { different_variant: 'Different size', unconfirmed: 'Unconfirmed' };
const badgeTones = { different_variant: 'variant', unconfirmed: 'unsure' };

/**
 * Money in British formatting with the plain local symbol: $8.80, £5.76, €3.10. Pass `{ exact: true }` when two
 * currencies share the screen, so a dollar says whose it is (US$8.80, CA$9.10). An unknown currency code from the
 * API never throws: the amount is shown with the code.
 */
export function money(value, currency, { exact = false } = {}) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '';
  try {
    const currencyDisplay = exact ? 'symbol' : 'narrowSymbol';
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency, currencyDisplay }).format(amount);
  } catch {
    return [amount.toFixed(2), typeof currency === 'string' ? currency.slice(0, 6) : ''].filter(Boolean).join(' ');
  }
}

const priced = (offer) => Number.isFinite(offer?.price) && offer.price > 0;

/** The price on the page, when it is fit to compare against: a real number, a known currency, not a "from" price. */
export function usablePrice(own) {
  return own && Number.isFinite(own.price) && own.price > 0 && !!own.currency && !own.from ? own : null;
}

/**
 * How an offer compares with the price on the page: `{ tone, text, amount }`, or null when the two cannot honestly
 * be compared (another currency, a "from" price, or anything but the same product).
 */
export function priceDifference(offer, own) {
  const here = usablePrice(own);
  if (!here || !priced(offer) || offer.match !== 'exact' || offer.currency !== here.currency) return null;
  const pence = Math.round(here.price * 100) - Math.round(offer.price * 100);
  if (pence === 0) return { tone: 'same', text: 'Same price', amount: 0 };
  const diff = money(Math.abs(pence) / 100, here.currency);
  const text = `${diff} ${pence > 0 ? 'cheaper' : 'more'}`;
  return { tone: pence > 0 ? 'less' : 'more', text, diff, amount: pence / 100 };
}

/**
 * When the shopper's price and every priced offer are in different currencies: `{ own, found }`, for example
 * `{ own: 'USD', found: 'GBP' }`. Nothing on screen can then be compared, so the shopper is told why instead of being
 * shown a silence. Otherwise null.
 */
export function currencyMismatch(offers = [], own) {
  const mine = typeof own?.currency === 'string' ? own.currency : '';
  const listed = (Array.isArray(offers) ? offers : [])
    .filter((offer) => priced(offer) && typeof offer.currency === 'string' && offer.currency);
  if (!mine || !listed.length || listed.some((offer) => offer.currency === mine)) return null;
  const counts = new Map();
  for (const { currency } of listed) counts.set(currency, (counts.get(currency) ?? 0) + 1);
  const [found] = [...counts].reduce((top, entry) => (entry[1] > top[1] ? entry : top));
  return { own: mine, found };
}

const pence = (price) => Math.round(price * 100);

/**
 * The offer worth pointing at: the cheapest one confirmed as the same product and listed in stock.
 * With a usable price for this page it must beat that price by at least a penny: the same price is not a better one.
 * Without one it is only the lowest of several, so a lone offer is never singled out.
 */
export function bestOffer(offers, own) {
  const here = usablePrice(own);
  const confirmed = offers.filter((offer) => offer.match === 'exact' && offer.availability === 'in_stock' && priced(offer));
  const [first] = confirmed;
  if (!first) return undefined;
  const cheapest = (list) => list.reduce((best, offer) => (pence(offer.price) < pence(best.price) ? offer : best));
  if (here) {
    const cheaper = confirmed.filter((offer) => offer.currency === here.currency && pence(offer.price) < pence(here.price));
    return cheaper.length ? cheapest(cheaper) : undefined;
  }
  // Prices in different currencies cannot be ranked against each other, and one price has nothing to be lowest of.
  if (confirmed.length < 2 || confirmed.some((offer) => offer.currency !== first.currency)) return undefined;
  const best = cheapest(confirmed);
  return confirmed.every((offer) => offer === best || pence(offer.price) > pence(best.price)) ? best : undefined;
}

function withText(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function label(tone, text) {
  const element = document.createElement('span');
  element.className = `offer-label ${tone}`.trim();
  element.append(withText('span', '', text));
  return element;
}

function arrow() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'retailer-arrow');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M4 2.5h5.5V8M9.5 2.5 2.5 9.5');
  svg.append(path);
  return svg;
}

function safeLink(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

/**
 * How much a row deserves the shopper's eye, read from the like-for-like difference and the match:
 * `deal` (same product, cheaper), `even` (same product, same price or nothing to compare with), `pricier`
 * (same product, dearer), `variant` (another size or flavour) or `unsure` (match not confirmed).
 */
export function offerWorth(offer, difference) {
  if (difference?.tone === 'less') return 'deal';
  if (difference?.tone === 'more') return 'pricier';
  if (difference?.tone === 'same' || offer?.match === 'exact') return 'even';
  return offer?.match === 'different_variant' ? 'variant' : 'unsure';
}

/**
 * One retailer row, two lines and always the same height. Line one: retailer and price. Line two: a quiet line
 * saying what the listing is, and under the price one pill with the difference from the shopper's price, or the
 * reason there is none (another size, unconfirmed, another currency). The row's colour says whether it is worth a
 * look (`data-worth`, see offerWorth); a listing in another currency recedes (`data-currency="other"`).
 * `sticker` is the words on the yellow sticker for the best offer; `exact` spells out currency symbols (US$).
 */
export function createRetailerOffer(offer, { own, sticker = '', exact = false } = {}) {
  const row = document.createElement('li');
  row.className = 'retailer-offer';

  const href = safeLink(offer.url);
  const link = document.createElement(href ? 'a' : 'span');
  link.className = 'retailer-link';
  if (href) {
    link.href = href;
    link.target = '_blank';
    link.rel = 'noreferrer';
  }

  const retailer = typeof offer.retailer === 'string' && offer.retailer ? offer.retailer : 'Another retailer';
  const head = document.createElement('span');
  head.className = 'retailer-head';
  head.append(withText('span', 'retailer-name', retailer));
  if (href) head.append(arrow(), withText('span', 'visually-hidden', '(opens in a new tab)'));
  if (sticker) head.append(withText('span', 'sticker', sticker));

  const priceLabel = document.createElement('span');
  priceLabel.className = 'retailer-price';
  priceLabel.append(withText('span', sticker ? 'swipe' : '', money(offer.price, offer.currency, { exact }) || 'Price not shown'));
  link.append(head, priceLabel);

  const here = usablePrice(own);
  const elsewhere = !!here && priced(offer) && typeof offer.currency === 'string' && !!offer.currency
    && offer.currency !== here.currency;
  const difference = priceDifference(offer, own);
  row.dataset.worth = offerWorth(offer, difference);
  if (elsewhere) row.dataset.currency = 'other';

  // The price column's second line: the like-for-like difference when there is one, else why there is none.
  const notLike = offer.match !== 'exact';
  const badge = difference ? { tone: difference.tone, text: difference.text }
    : elsewhere ? { tone: 'other', text: `In ${offer.currency}` }
      : notLike ? { tone: badgeTones[offer.match] ?? 'unsure', text: matchBadges[offer.match] ?? matchBadges.unconfirmed }
        : { tone: '', text: '' };
  const gap = withText('p', `offer-difference ${badge.tone}`.trim(), badge.text);
  if (elsewhere) gap.title = `Listed in ${offer.currency}; your price is in ${here.currency}`;

  // The quiet line: at most one short label, then the listing's own title. A confirmed match is said by the row's
  // colour, so its only label is the stock, and only when the retailer states it. Any other match is named by the
  // pill under the price, so the label here is just the size or flavour the retailer lists.
  const match = matchLabels[offer.match] ?? matchLabels.unconfirmed;
  const detail = offer.variant ? `${match}: ${offer.variant}` : match;
  const details = document.createElement('p');
  details.className = 'offer-details';
  if (notLike) {
    if (offer.variant) {
      const listed = label('', offer.variant);
      listed.title = detail;
      details.append(listed);
    }
  } else if (offer.availability === 'in_stock') {
    details.append(label('positive', 'In stock'));
  }
  details.append(withText('span', 'retailer-title', offer.title ?? ''));
  details.title = [notLike ? detail : match, offer.title].filter(Boolean).join(' · ');
  row.append(link, details, gap);
  return row;
}

/** The one short line under a product's strip, when anything needs saying: `{ tone, text }` or null. */
function groupNote({ offers, partial, error, mismatch, here, where }) {
  if (error) return { tone: 'error', text: 'Scout couldn’t check this one. Compare again in a moment.' };
  if (!offers.length) {
    return { tone: '', text: where ? `No ${where} listings found.` : 'No priced offers found at other retailers in this country.' };
  }
  if (mismatch) return { tone: 'currency', text: `Listed in ${mismatch.found}, your price is in ${mismatch.own}.` };
  if (partial) return { tone: '', text: 'Some retailers couldn’t be checked.' };
  if (here && !offers.some((offer) => offer.match === 'exact')) return { tone: '', text: 'No exact match: sizes or flavours differ.' };
  return null;
}

/**
 * A product with its retailer rows. It opens on one strip: the product on the left and the shopper's own price on
 * the right, in the same column as every retailer price below it. `own` is the price on this page or in the basket,
 * `where` (for example "UK") names the country searched, and `label` names the shopper's price.
 */
export function createOfferGroup({ name, variant, offers = [], partial, error }, { own, where = '', label: ownLabel = 'Your price' } = {}) {
  const group = document.createElement('section');
  group.className = 'offer-group';
  const here = usablePrice(own);
  const mismatch = currencyMismatch(offers, own);
  // Two currencies on one product: every dollar says whose it is.
  const currencies = new Set([own?.currency, ...offers.filter(priced).map((offer) => offer.currency)].filter(Boolean));
  const exact = currencies.size > 1;

  const head = document.createElement('header');
  head.className = 'offer-head';
  const titles = document.createElement('div');
  titles.className = 'offer-titles';
  const heading = withText('h3', '', name);
  heading.title = name;
  const meta = withText('p', 'variant', variant || (own ? 'As shown on this page' : 'Any size or flavour'));
  meta.title = meta.textContent;
  titles.append(heading, meta);
  head.append(titles);
  const shown = own && Number.isFinite(own.price) && own.price > 0 && own.currency ? money(own.price, own.currency, { exact }) : '';
  if (shown) {
    const yours = document.createElement('p');
    yours.className = 'your-price';
    yours.append(withText('span', 'your-label', ownLabel), withText('span', 'here-price', own.from ? `from ${shown}` : shown));
    head.append(yours);
  }
  group.append(head);
  if (mismatch) group.dataset.state = 'currency';

  const note = groupNote({ offers, partial, error, mismatch, here, where });
  if (note) {
    const line = withText('p', 'group-note', note.text);
    if (note.tone) line.dataset.tone = note.tone;
    group.append(line);
  }

  const best = bestOffer(offers, own);
  const bestDiff = best && here ? priceDifference(best, here) : null;
  const bestSticker = bestDiff?.tone === 'less'
    ? `Save ${bestDiff.diff}`
    : (here ? 'Best price' : 'Lowest match');
  const rows = document.createElement('ul');
  for (const offer of offers) {
    rows.append(createRetailerOffer(offer, {
      own, exact, sticker: offer === best ? bestSticker : '',
    }));
  }
  group.append(rows);
  return { group, best, offers, mismatch };
}
