import assert from 'node:assert/strict';
import test from 'node:test';
import { readPageProduct } from '../extension/product.js';

// A page reduced to the few lookups the reader makes.
function page({ jsonLd = [], meta = {}, microdata = null, heading = '', controls = [], picked = [], prices = [], hostname = 'www.shop.example', pathname = '/', search = '' } = {}) {
  const element = (content, textContent = '') => ({
    textContent,
    value: '',
    getAttribute: (name) => (name === 'content' ? content : null),
  });
  const root = {
    defaultView: { getComputedStyle: (item) => item.style },
    querySelectorAll(selector) {
      if (selector === 'script[type="application/ld+json"]') {
        return jsonLd.map((data) => ({ textContent: typeof data === 'string' ? data : JSON.stringify(data) }));
      }
      if (selector.startsWith('button')) return controls.map((label) => element(null, label));
      if (selector.startsWith('input[type="radio"]:checked')) return picked.map((value) => ({ value }));
      if (selector.startsWith('span, p')) {
        return prices.map(({ text, size = 16, struck = false, attribute = 'class' }) => ({
          textContent: text,
          children: [],
          style: { fontSize: `${size}px`, textDecorationLine: struck ? 'line-through' : 'none' },
          getBoundingClientRect: () => ({ width: 60, top: 400 }),
          getAttributeNames: () => [attribute],
          getAttribute: () => '',
          closest: () => null,
        }));
      }
      return [];
    },
    querySelector(selector) {
      if (selector === 'h1') return heading ? element(null, heading) : null;
      if (selector === '[itemtype*="schema.org/Product"]') {
        return microdata && {
          querySelector: (inner) => {
            const name = inner.match(/itemprop="([^"]+)"/)[1];
            return Object.hasOwn(microdata, name) ? element(microdata[name]) : null;
          },
        };
      }
      const name = selector.match(/meta\[property="([^"]+)"\]/)?.[1];
      return name && Object.hasOwn(meta, name) ? element(meta[name]) : null;
    },
  };
  return [root, { hostname, pathname, search }];
}

test('the shop’s own product data wins, with brand, price and currency', () => {
  const found = readPageProduct(...page({
    jsonLd: [{ '@context': 'https://schema.org', '@graph': [
      { '@type': 'BreadcrumbList' },
      { '@type': ['Product'], name: 'WH-1000XM5 Wireless Headphones', brand: { '@type': 'Brand', name: 'Sony' },
        color: 'Black', offers: { '@type': 'Offer', price: '279.00', priceCurrency: 'gbp' } },
    ] }],
    meta: { 'og:title': 'Something else entirely', 'og:type': 'product' },
  }));
  assert.deepEqual(found, {
    name: 'Sony WH-1000XM5 Wireless Headphones', variant: 'Black', price: 279, currency: 'GBP', from: false, source: 'structured',
  });
});

test('aggregate offers, variant groups and broken JSON-LD are handled', () => {
  const aggregate = readPageProduct(...page({
    jsonLd: ['{not json', { '@type': 'Product', name: 'Impact Whey Protein', brand: 'Myprotein',
      offers: { '@type': 'AggregateOffer', lowPrice: 18.99, priceCurrency: 'GBP' } }],
  }));
  assert.equal(aggregate.name, 'Myprotein Impact Whey Protein');
  assert.deepEqual([aggregate.price, aggregate.from], [18.99, true]);

  const group = readPageProduct(...page({
    jsonLd: [{ '@type': 'ProductGroup', name: 'Trail Runner 4',
      hasVariant: [{ '@type': 'Product', offers: [{ price: '1.299,00', priceCurrency: 'EUR' }] }] }],
  }));
  assert.deepEqual([group.name, group.price, group.currency, group.from], ['Trail Runner 4', 1299, 'EUR', true]);
});

test('microdata and Open Graph are read when there is no JSON-LD', () => {
  const micro = readPageProduct(...page({ microdata: { name: ' Cast Iron  Skillet 26cm ', price: '34,5', priceCurrency: 'EUR' } }));
  assert.deepEqual([micro.name, micro.price, micro.currency], ['Cast Iron Skillet 26cm', 34.5, 'EUR']);

  const graph = readPageProduct(...page({
    hostname: 'www.currys.co.uk',
    meta: { 'og:title': 'LG OLED55C4 55" Smart TV | Currys', 'product:price:amount': '1,299.00', 'product:price:currency': 'GBP' },
  }));
  assert.deepEqual(graph, { name: 'LG OLED55C4 55" Smart TV', variant: '', price: 1299, currency: 'GBP', from: false, source: 'page' });
});

test('a heading only counts as a product when the page offers a way to buy', () => {
  const buyable = readPageProduct(...page({ heading: 'Merino Crew Jumper', controls: ['Size guide', 'Add to bag'] }));
  assert.deepEqual(buyable, { name: 'Merino Crew Jumper', variant: '', price: null, currency: '', from: false, source: 'heading' });
  assert.equal(readPageProduct(...page({ heading: 'Our story', controls: ['Subscribe'] })), null);
  assert.equal(readPageProduct(...page({ meta: { 'og:title': 'Welcome to the shop', 'og:type': 'website' } })), null);
});

test('the size on screen gives an exact price when the shop lists every variant', () => {
  const variant = (sku, name, price) => ({ '@type': 'Product', sku, name, offers: [{ '@type': 'Offer', price, priceCurrency: 'GBP' }] });
  const jsonLd = [{ '@type': 'ProductGroup', name: 'CeraVe Moisturising Cream', hasVariant: [
    variant('11798690', 'CeraVe Moisturising Cream 340g', 10.85),
    variant('11798691', 'CeraVe Moisturising Cream 454g', 12.25),
    variant('11798692', 'CeraVe Moisturising Cream 177ml', 8.4),
  ] }];
  const read = (options) => {
    const { name, price, from } = readPageProduct(...page({ jsonLd, hostname: 'www.lookfantastic.com', ...options }));
    return [name, price, from];
  };

  assert.deepEqual(read({ pathname: '/p/cerave-moisturising-cream/11798691/' }), ['CeraVe Moisturising Cream 454g', 12.25, false]);
  assert.deepEqual(read({ pathname: '/p/cerave-moisturising-cream/11798691/', picked: ['11798692'] }),
    ['CeraVe Moisturising Cream 177ml', 8.4, false]);
  assert.deepEqual(read({ pathname: '/p/cerave-moisturising-cream/11798691/', search: '?variation=11798690' }),
    ['CeraVe Moisturising Cream 340g', 10.85, false]);
  // With no size named anywhere, the lowest of the sizes is where prices start.
  assert.deepEqual(read({ pathname: '/p/cerave-moisturising-cream/' }), ['CeraVe Moisturising Cream', 8.4, true]);
});

test('a range price gives way to the one price the page shows largest', () => {
  const jsonLd = [{ '@type': 'Product', name: 'Impact Whey Protein Powder', brand: 'Myprotein',
    offers: { '@type': 'AggregateOffer', lowPrice: 5, highPrice: 119.99, priceCurrency: 'GBP' } }];
  const read = (prices) => {
    const { price, currency, from } = readPageProduct(...page({ jsonLd, prices }));
    return [price, currency, from];
  };

  assert.deepEqual(read([
    { text: '£34.99', size: 14, struck: true, attribute: 'data-was-price' },
    { text: '£28.99', size: 20, attribute: 'data-pdp-v3-summary-price' },
    { text: '£3.49', size: 20 },
  ]), [28.99, 'GBP', false]);
  // Two different prices at the same size, a price under the range, or another currency: stay with "from".
  assert.deepEqual(read([{ text: '£28.99', size: 20, attribute: 'data-price' }, { text: '£51.76', size: 20, attribute: 'data-price' }]), [5, 'GBP', true]);
  assert.deepEqual(read([{ text: '£1.99', size: 28, attribute: 'data-price' }]), [5, 'GBP', true]);
  assert.deepEqual(read([{ text: '€28.99', size: 28, attribute: 'data-price' }]), [5, 'GBP', true]);
  assert.deepEqual(read([]), [5, 'GBP', true]);
});

// A small real tree for the options reader, which walks elements rather than asking for fixed selectors.
function h(tagName, attributes = {}, ...content) {
  const node = {
    nodeType: 1, tagName: tagName.toUpperCase(), parentElement: null, attributes, childNodes: [],
    checked: 'checked' in attributes, disabled: 'disabled' in attributes, value: attributes.value ?? '',
    getAttribute: (name) => (name in attributes ? String(attributes[name]) : null),
    get children() { return node.childNodes.filter((child) => child.nodeType === 1); },
    get textContent() { return node.childNodes.map((child) => child.textContent).join(''); },
    get nextElementSibling() {
      const siblings = node.parentElement?.children ?? [];
      return siblings[siblings.indexOf(node) + 1] ?? null;
    },
    get selectedOptions() { return node.children.filter((child) => 'selected' in child.attributes); },
    querySelectorAll: (selector) => (selector === '*' ? node.children.flatMap((child) => [child, ...child.querySelectorAll('*')]) : []),
    getBoundingClientRect: () => ({ width: 'hidden' in attributes ? 0 : 120, top: 300 }),
  };
  for (const child of content.flat()) {
    const item = typeof child === 'string' ? { nodeType: 3, textContent: child } : child;
    if (item.nodeType === 1) item.parentElement = node;
    node.childNodes.push(item);
  }
  return node;
}

function shopPage(...content) {
  const body = h('body', {}, h('main', {}, h('h1', {}, 'Impact Whey Protein'), ...content.flat(), h('button', {}, 'Add to basket')));
  const all = body.querySelectorAll('*');
  const root = {
    querySelectorAll(selector) {
      if (selector === '*') return all;
      if (selector.startsWith('script')) return all.filter((node) => node.tagName === 'SCRIPT');
      if (selector.startsWith('button')) return all.filter((node) => node.tagName === 'BUTTON');
      return [];
    },
    querySelector: (selector) => (selector === 'h1' ? all.find((node) => node.tagName === 'H1') : null),
    getElementById: (id) => all.find((node) => node.getAttribute('id') === id) ?? null,
  };
  return [root, { hostname: 'www.shop.example', pathname: '/p/impact-whey', search: '' }];
}
const jsonLd = (data) => h('script', { type: 'application/ld+json' }, JSON.stringify(data));
const variantOf = (...content) => readPageProduct(...shopPage(...content))?.variant;

test('the options selected on screen become the variant, flavour before size', () => {
  // A dropdown button showing its choice, a label that prints the amount, and the list behind it.
  const dropdown = (label, summary, choice, extra) => h('div', {},
    h('h2', {}, `${label}:`, ...(summary ? [h('span', {}, summary)] : [])),
    h('div', {},
      h('button', { 'aria-haspopup': 'dialog' }, h('span', { 'aria-hidden': 'true' }, 'thumb'), h('span', {}, choice), h('span', {}, extra)),
      h('div', { role: 'dialog', hidden: '' }, h('ul', { role: 'listbox', 'aria-label': label },
        h('li', {}, h('button', { role: 'option', 'aria-selected': 'false' }, h('span', {}, 'Another'))),
        h('li', {}, h('button', { role: 'option', 'aria-selected': 'true' }, h('span', {}, choice), h('span', { hidden: '' }, 'Out of stock')))))));
  assert.equal(variantOf(dropdown('Amount', '30 SERVINGS / 900G', '30 Servings', '£0.97/serving'), dropdown('Flavour', '', 'Vanilla', 'Best Sellers')),
    'Vanilla, 30 servings / 900g');

  const radio = (id, label, checked) => [h('input', { type: 'radio', id, ...(checked ? { checked: '' } : {}) }), h('label', { for: id }, label)];
  assert.equal(variantOf(
    h('fieldset', {}, h('legend', {}, 'Size'), radio('s1', '250 ml'), radio('s2', '500 ml (selected) £12.50', true)),
    h('div', { role: 'radiogroup', 'aria-label': 'Select colour' },
      h('button', { 'aria-checked': 'false' }, 'Navy'), h('button', { 'aria-checked': 'true', 'aria-label': 'ignored' }, 'BLACK')),
  ), 'Black, 500 ml');

  assert.equal(variantOf(
    h('label', { for: 'pack' }, 'Pack size'),
    h('select', { id: 'pack' }, h('option', { value: '' }, 'Choose'), h('option', { value: '60', selected: '' }, '60 capsules')),
    h('h4', {}, 'Strength'),
    h('div', {}, h('a', { class: 'Options-module_pill__3PhDl' }, h('p', {}, '10mg'), h('p', {}, '£0.06/tablet')),
      h('a', { class: 'Options-module_pill__3PhDl Options-module_active__tY95l' }, h('p', {}, '25mg'), h('p', {}, '£0.02/tablet'))),
  ), '25mg, 60 capsules');

  assert.equal(variantOf(h('p', {}, 'Flavour: Vanilla'), h('p', {}, h('b', {}, 'Amount:'), ' 1kg (40 servings)')), 'Vanilla, 1kg (40 servings)');
  assert.equal(variantOf(h('div', {}, h('span', {}, 'Colour:'), h('span', {}, 'Forest Green'))), 'Forest Green');
  assert.equal(variantOf(h('p', {}, 'Quantity: 2'), h('p', {}, 'Size guide'), h('p', {}, 'Scent: Sea Salt')), 'Sea Salt');
});

test('an unclear selection gives no variant at all', () => {
  const group = (label, ...choices) => h('div', { role: 'group', 'aria-label': label },
    choices.map(([text, pressed]) => h('button', { 'aria-pressed': String(pressed) }, text)));
  // Two products on one page, each with its own flavour chosen.
  assert.equal(variantOf(group('Flavour', ['Vanilla', true], ['Chocolate', false]), group('Flavour', ['Vanilla', false], ['Chocolate', true])), '');
  // Two choices lit in one group, and an option the shopper has not chosen yet next to one that is known.
  assert.equal(variantOf(group('Size', ['S', true], ['M', true])), '');
  assert.equal(variantOf(h('p', {}, 'Flavour: Vanilla'), group('Size', ['1kg', false], ['2.5kg', false])), '');
  assert.equal(variantOf(h('label', { for: 'size' }, 'Size'), h('select', { id: 'size' }, h('option', { value: '', selected: '' }, 'Select a size'), h('option', { value: 'm' }, 'Medium'))), '');
  assert.equal(variantOf(h('h3', {}, 'Size'), h('div', {}, h('button', { class: 'pill not-selected' }, '1kg'), h('button', { class: 'pill inactive' }, '2kg'))), '');
  assert.equal(variantOf(h('p', {}, `Colour: ${'very '.repeat(12)}long`)), '');

  // Sizes and flavours named by other parts of the page are not this product's.
  for (const wrapper of [
    (inner) => h('section', { class: 'product-recommendations' }, inner), (inner) => h('div', { id: 'mini-basket' }, inner),
    (inner) => h('div', { 'aria-label': 'Customer reviews' }, inner), (inner) => h('footer', {}, inner),
    (inner) => h('aside', { class: 'filters' }, inner), (inner) => h('table', {}, inner), (inner) => h('nav', {}, inner),
  ]) assert.equal(variantOf(wrapper(h('p', {}, 'Flavour: Chocolate'))), '');
  const [root, place] = shopPage();
  const stray = h('div', {}, h('p', {}, 'Size: 2.5kg'));
  const withStray = { ...root, querySelectorAll: (selector) => [...root.querySelectorAll(selector), ...(selector === '*' ? [stray, ...stray.querySelectorAll('*')] : [])] };
  assert.equal(readPageProduct(withStray, place).variant, '');
});

test('structured data keeps the last word on the variant it names', () => {
  const chosen = [h('p', {}, 'Flavour: Chocolate Smooth'), h('p', {}, 'Amount: 30 SERVINGS / 900G')];
  const read = (data) => {
    const { name, variant, source } = readPageProduct(...shopPage(jsonLd(data), chosen));
    return [name, variant, source];
  };
  const offers = { '@type': 'Offer', price: 28.99, priceCurrency: 'GBP' };
  assert.deepEqual(read({ '@type': 'Product', name: 'Impact Whey Protein', color: 'Unflavoured', size: '1kg', offers }),
    ['Impact Whey Protein', 'Unflavoured, 1kg', 'structured']);
  assert.deepEqual(read({ '@type': 'Product', name: 'Impact Whey Protein', offers }),
    ['Impact Whey Protein', 'Chocolate Smooth, 30 servings / 900g', 'structured']);
  // The variant's own name already says the flavour, and may say the size too: only what is missing is added.
  assert.deepEqual(read({ '@type': 'Product', name: 'Impact Whey Protein Chocolate Smooth', offers }),
    ['Impact Whey Protein Chocolate Smooth', '30 servings / 900g', 'structured']);
  assert.deepEqual(read({ '@type': 'Product', name: 'Impact Whey Protein 900g - 30servings Chocolate Smooth', offers }),
    ['Impact Whey Protein 900g - 30servings Chocolate Smooth', '', 'structured']);
  // No structured data at all: the heading names the product and the page says which one.
  assert.deepEqual(readPageProduct(...shopPage(chosen)), {
    name: 'Impact Whey Protein', variant: 'Chocolate Smooth, 30 servings / 900g', price: null, currency: '', from: false, source: 'heading',
  });
});

test('an address that fits every size names the colourway, not a size', () => {
  const size = (label, price = 129.99) => ({
    '@type': 'Product', mpn: 'CN8490-002', name: 'Air Runner Shoes', color: 'Black/White', size: label,
    offers: [{ '@type': 'Offer', price, priceCurrency: 'GBP' }],
  });
  const group = (variants) => [{ '@type': 'ProductGroup', name: 'Air Runner Shoes', brand: { name: 'Stride' }, hasVariant: variants }];
  const read = (variants, options = {}) => readPageProduct(...page({
    jsonLd: group(variants), hostname: 'www.stride.example', pathname: '/t/air-runner-shoes/CN8490-002', ...options,
  }));

  // No size is chosen on the page: the first variant's "Size 6" must not be reported as the shopper's.
  assert.deepEqual(read([size('Size 6'), size('Size 7'), size('Size 8')]), {
    name: 'Stride Air Runner Shoes', variant: 'Black/White', price: 129.99, currency: 'GBP', from: false, source: 'structured',
  });
  // When those sizes cost different amounts, the lowest is only a starting price.
  const mixed = read([size('Size 6', 119.99), size('Size 7', 129.99)]);
  assert.deepEqual([mixed.variant, mixed.price, mixed.from], ['Black/White', 119.99, true]);
  // A size the shopper did pick is still exact.
  const variants = [{ ...size('Size 6'), sku: 'SKU-6000' }, { ...size('Size 7', 134.99), sku: 'SKU-7000' }];
  const picked = read(variants, { picked: ['SKU-7000'] });
  assert.deepEqual([picked.variant, picked.price, picked.from], ['Black/White, Size 7', 134.99, false]);
});

test('prices written in odd ways are read as one amount or not at all', () => {
  const priceOf = (price, extra = {}) => readPageProduct(...page({
    jsonLd: [{ '@type': 'Product', name: 'Steel Water Bottle', offers: { '@type': 'Offer', price, priceCurrency: 'GBP', ...extra } }],
  })).price;
  assert.equal(priceOf('34.9900'), 34.99);
  assert.equal(priceOf('1,299.00'), 1299);
  assert.equal(priceOf('1.299,00'), 1299);
  assert.equal(priceOf('1 299,00'), 1299);
  assert.equal(priceOf('£12.5'), 12.5);
  // A range or two prices in one field is not one price.
  assert.equal(priceOf('9.99-19.99'), null);
  assert.equal(priceOf('£49.99 £39.99'), null);
  assert.equal(priceOf('2 for £10'), null);
});

test('one offer per size is a starting price, not the price on screen', () => {
  const found = readPageProduct(...page({
    jsonLd: [{ '@type': 'Product', name: 'Linen Shirt', offers: [
      { '@type': 'Offer', price: '25.00', priceCurrency: 'GBP', sku: 'S' },
      { '@type': 'Offer', price: '45.00', priceCurrency: 'GBP', sku: 'XL' },
    ] }],
    search: '?variant=XL',
  }));
  assert.deepEqual([found.price, found.from], [25, true]);
  // The same price on every offer is simply the price.
  const flat = readPageProduct(...page({
    jsonLd: [{ '@type': 'Product', name: 'Linen Shirt', offers: [
      { '@type': 'Offer', price: '25.00', priceCurrency: 'GBP' }, { '@type': 'Offer', price: 25, priceCurrency: 'GBP' },
    ] }],
  }));
  assert.deepEqual([flat.price, flat.from], [25, false]);
});

test('only the shop’s own name is taken off the end of a title', () => {
  const named = (title, hostname) => readPageProduct(...page({
    hostname, meta: { 'og:title': title, 'og:type': 'product', 'product:price:amount': '39.00', 'product:price:currency': 'GBP' },
  })).name;
  assert.equal(named('Linen Shirt - Rust', 'us.loom.example'), 'Linen Shirt - Rust');
  assert.equal(named('Linen Shirt - Rust', 'uk.gymshark.com'), 'Linen Shirt - Rust');
  assert.equal(named('Training Shorts | Gymshark', 'uk.gymshark.com'), 'Training Shorts');
  assert.equal(named('Kettle 1.7L - Amazon.co.uk', 'www.amazon.co.uk'), 'Kettle 1.7L');
  assert.equal(named('Impact Whey Protein | Myprotein UK', 'www.myprotein.com'), 'Impact Whey Protein');
});

test('a page of quick-add buttons is a listing, not a product', () => {
  const listing = page({ heading: 'Protein Powders', controls: ['Add to basket', 'Add to basket', 'Add to basket', 'Add to basket', 'Add to basket'] });
  assert.equal(readPageProduct(...listing), null);
  const product = page({ heading: 'Impact Whey Protein', controls: ['Add to basket', 'Add to basket'] });
  assert.equal(readPageProduct(...product).name, 'Impact Whey Protein');
});

test('offscreen accessibility shortcut headings (e.g. Amazon) and basket pages are skipped cleanly', async () => {
  const { JSDOM } = await import('jsdom');
  const amazon = new JSDOM(`<!doctype html><html><body>
    <h1 class="a-offscreen">Product summary presents key product information Keyboard shortcut shift + ALT + opt + D</h1>
    <h1 id="title"><span id="productTitle">Sony WH-1000XM5 Wireless Noise Cancelling Headphones</span></h1>
    <button type="button">Add to Basket</button>
  </body></html>`, { url: 'https://www.amazon.co.uk/dp/B09Y2MYL5C' });
  const found = readPageProduct(amazon.window.document, amazon.window.location);
  assert.equal(found?.name, 'Sony WH-1000XM5 Wireless Noise Cancelling Headphones');

  const basket = new JSDOM(`<!doctype html><html><body>
    <h1>Your Shopping Basket</h1>
    <button type="button">Add to Basket</button>
  </body></html>`, { url: 'https://www.shop.example/basket' });
  assert.equal(readPageProduct(basket.window.document, basket.window.location), null);
});
