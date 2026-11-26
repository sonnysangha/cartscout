// Reads a retailer's product page on the server, from the page markup Oxylabs returns when it is asked for
// output: ["html"], so the price does not have to be bought from Oxylabs' AI parsing.
//
// The reading itself is done by the extension's own product reader (extension/product.js), the same code that reads a
// product page in the shopper's browser. That reader expects a document. This file gives it just enough of one: the
// few kinds of element a product's published data lives in, found in the markup without building a whole page.
//
// It has been written to Oxylabs' documented response format and tested against saved pages. It has not been run
// against live pages yet, which is why OXYLABS_PAGE_PARSER defaults to "ai".
import { readPageProduct } from '../extension/product.js';

// More markup than this is not a product page worth reading, and the limit keeps one huge page from stalling the server.
const MAX_MARKUP = 3_000_000;

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', pound: '£', euro: '€' };

function decode(text) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, name) => {
    if (name[0] !== '#') return NAMED[name.toLowerCase()] ?? whole;
    const point = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
  });
}

function attributesOf(source) {
  const found = new Map();
  for (const [, name, double, single, bare] of source.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    if (!found.has(name.toLowerCase())) found.set(name.toLowerCase(), decode(double ?? single ?? bare ?? ''));
  }
  return found;
}

// An element as far as the product reader looks at one.
function element(tagName, attributes, textContent = '') {
  return {
    tagName: tagName.toUpperCase(),
    textContent,
    value: attributes.get('value') ?? '',
    checked: attributes.has('checked') || attributes.has('selected'),
    children: [],
    childNodes: [],
    parentElement: null,
    getAttribute: (name) => attributes.get(name.toLowerCase()) ?? null,
    getAttributeNames: () => [...attributes.keys()],
    closest: () => null,
    contains: () => false,
  };
}

function matches(node, selector) {
  const tag = /^[a-z][a-z0-9]*/i.exec(selector)?.[0];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const [, name, contains, value] of selector.matchAll(/\[([\w:-]+)(?:(\*)?="([^"]*)")?\]/g)) {
    const actual = node.getAttribute(name);
    if (actual === null || (value !== undefined && (contains ? !actual.includes(value) : actual !== value))) return false;
  }
  return !selector.includes(':checked') || node.checked;
}

/**
 * A stand-in for `document`, holding only what a product's published data lives in: JSON-LD scripts, meta tags, the
 * page heading, and the option or radio button that is selected. Anything else the reader asks for comes back empty,
 * so it never guesses from layout it cannot see.
 */
export function pageDocument(html) {
  const markup = String(html ?? '').slice(0, MAX_MARKUP);
  const nodes = [];
  for (const [, attributes, body] of markup.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const given = attributesOf(attributes);
    if (/ld\+json/i.test(given.get('type') ?? '')) nodes.push(element('script', given, body));
  }
  for (const [, attributes] of markup.matchAll(/<meta\b([^>]*)>/gi)) nodes.push(element('meta', attributesOf(attributes)));
  for (const [, body] of markup.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/gi)) {
    nodes.push(element('h1', new Map(), decode(body.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()));
  }
  for (const [, tag, attributes] of markup.matchAll(/<(option|input)\b([^>]*)>/gi)) {
    const given = attributesOf(attributes);
    if (tag.toLowerCase() === 'option' || given.get('type') === 'radio') nodes.push(element(tag, given));
  }
  const all = (selector) => (selector.trim() === '*' ? []
    : nodes.filter((node) => selector.split(',').some((part) => matches(node, part.trim()))));
  return { querySelectorAll: all, querySelector: (selector) => all(selector)[0] ?? null };
}

// The retailer's own statement about stock and condition, from the same JSON-LD the price comes from.
function publishedState(root) {
  const offers = [];
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 8 || offers.length > 400) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value.availability === 'string' || typeof value.itemCondition === 'string') offers.push(value);
    for (const key of ['@graph', 'mainEntity', 'offers', 'hasVariant']) visit(value[key], depth + 1);
  };
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      visit(JSON.parse(script.textContent));
    } catch {
      // Malformed data says nothing either way.
    }
  }
  const stock = offers.map((offer) => String(offer.availability ?? '').replace(/^.*[/#]/, '').toLowerCase()).filter(Boolean);
  if (!stock.length) {
    // Shops without JSON-LD often say it in a meta tag instead: "instock", "in stock", "oos".
    const meta = ['product:availability', 'og:availability']
      .map((name) => root.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute('content'))
      .find(Boolean);
    if (meta) stock.push(meta.toLowerCase().replace(/[^a-z]/g, '').replace(/^oos$/, 'outofstock'));
  }
  const inStock = (state) => /^(?:instock|instoreonly|onlineonly|limitedavailability)$/.test(state);
  const gone = (state) => /^(?:outofstock|soldout|discontinued)$/.test(state);
  return {
    // Several offers are several sizes or sellers. Only when they all agree is the answer true of the one on screen.
    availability: stock.length && stock.every(inStock) ? 'in_stock' : stock.length && stock.every(gone) ? 'out_of_stock' : 'unknown',
    used: offers.some((offer) => /used|refurbished|damaged/i.test(String(offer.itemCondition ?? ''))),
  };
}

/**
 * The product a retailer page is selling, read from the data the retailer published in its markup:
 * { name, variant, price, currency, from, source, availability, used }, or null when the page names no product.
 * `address` is where the page was fetched from, after redirects.
 */
export function readProductPage(html, address) {
  let place;
  try {
    place = new URL(address);
  } catch {
    return null;
  }
  const root = pageDocument(html);
  const product = readPageProduct(root, place);
  // The heading alone carries no price, and it is the reader's last resort. A listing needs published data.
  if (!product || product.source === 'heading') return null;
  return { ...product, ...publishedState(root) };
}
