// The basket reader's price: what one of each basket line costs, and when the page leaves that in doubt.
// The reader is injected into the shop's page, so it is run here the same way: as text, against a document made by hand.

import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { readMyproteinBasket } from '../extension/myprotein.js';

const selectors = {
  '*': () => true,
  li: (node) => node.tagName === 'LI',
  'a[href^="/p/"]': (node) => node.tagName === 'A' && String(node.attrs.href ?? '').startsWith('/p/'),
  '[data-e2e="basket-remove_item_button"]': (node) => node.attrs['data-e2e'] === 'basket-remove_item_button',
  '.quantity': (node) => String(node.attrs.class ?? '').split(' ').includes('quantity'),
  'main basket-item': (node) => node.tagName === 'BASKET-ITEM',
  'main span, main p': (node) => node.tagName === 'SPAN' || node.tagName === 'P',
};

/** A just-enough element: a tag, attributes, and either words or child elements. */
function el(tag, attrs = {}, ...content) {
  const node = {
    tagName: tag.toUpperCase(), attrs, value: attrs.value, children: [], parentElement: null,
    get textContent() { return this.words ?? this.children.map((child) => child.textContent).join(''); },
    get childElementCount() { return this.children.length; },
    get nextElementSibling() {
      const siblings = this.parentElement?.children ?? [];
      return siblings[siblings.indexOf(this) + 1] ?? null;
    },
    within() { return this.children.flatMap((child) => [child, ...child.within()]); },
    querySelectorAll(selector) {
      assert(Object.hasOwn(selectors, selector), `the reader asked for ${selector}, which this document cannot answer`);
      return this.within().filter(selectors[selector]);
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
  };
  for (const part of content) {
    if (typeof part === 'string') node.words = part;
    else {
      part.parentElement = node;
      node.children.push(part);
    }
  }
  return node;
}

const price = (words, attrs) => el('span', attrs, words);

/** One basket row as the shop draws it: an image link, the named link over its options, prices, a quantity, a remove button. */
function line({ name = 'Impact Whey Protein', options = ['Vanilla', '1kg'], quantity = '1', cells = [] } = {}) {
  return el('basket-item', {},
    el('a', { href: '/p/impact-whey/' }),
    el('div', {}, el('h3', {}, el('a', { href: '/p/impact-whey/' }, name)), el('ul', {}, ...options.map((option) => el('li', {}, option)))),
    ...cells,
    ...(quantity === null ? [] : [el('input', { class: 'quantity', value: quantity })]),
    el('button', { 'data-e2e': 'basket-remove_item_button' }, 'Remove'));
}

function read(rows, subtotal = '£0.00', globals = {}) {
  const main = el('main', {}, el('section', {}, ...rows),
    el('aside', {}, el('p', {}, el('span', {}, 'Basket subtotal:'), el('span', {}, subtotal))));
  return JSON.parse(runInNewContext(`JSON.stringify((${readMyproteinBasket.toString()})())`, {
    location: new URL('https://www.myprotein.com/basket/'), document: main, ...globals,
  }));
}

const whey = { name: 'Myprotein Impact Whey Protein', variant: 'Vanilla, 1kg' };

test('a line of one that shows a single price is priced, in pounds', () => {
  assert.deepEqual(read([line({ cells: [price('£34.99')] })]), [{ ...whey, price: 34.99, currency: 'GBP' }]);
  // The same price printed twice (the price and the line total) is still one price.
  assert.deepEqual(read([line({ cells: [price('£1,034.99'), el('div', {}, price('£1,034.99'))] })]),
    [{ ...whey, price: 1034.99, currency: 'GBP' }]);
  // A price built from pieces reads as the whole its wrapper shows.
  assert.deepEqual(read([line({ cells: [el('div', {}, price('£'), price('34'), price('.99'))] })]),
    [{ ...whey, price: 34.99, currency: 'GBP' }]);
});

test('a crossed-out "was" price is never the price', () => {
  const tagged = line({ cells: [el('s', {}, price('£44.99')), price('£34.99')] });
  assert.deepEqual(read([tagged]), [{ ...whey, price: 34.99, currency: 'GBP' }]);
  // Crossed out by a style instead of a tag: the page's own computed style says so.
  const styled = line({ cells: [el('div', { class: 'line-through' }, price('£44.99')), price('£34.99')] });
  const getComputedStyle = (node) => ({ textDecorationLine: node.attrs.class === 'line-through' ? 'line-through' : 'none' });
  assert.deepEqual(read([styled], '£34.99', { getComputedStyle }), [{ ...whey, price: 34.99, currency: 'GBP' }]);
  // With nothing saying it is crossed out there are two prices, and Scout will not guess between them.
  assert.deepEqual(read([styled]), [whey]);
});

test('a line of several is priced only when the page says what one costs', () => {
  // The price of one and the line total, side by side.
  assert.deepEqual(read([line({ quantity: '3', cells: [price('£10.00'), price('£30.00')] })]),
    [{ ...whey, price: 10, currency: 'GBP' }]);
  // Two prices that are not one and its total: a subscription offer, say.
  assert.deepEqual(read([line({ quantity: '3', cells: [price('£10.00'), price('£27.00')] })]), [whey]);

  const oats = { name: 'Myprotein Instant Oats', variant: '2.5kg' };
  const rows = () => [
    line({ quantity: '2', cells: [price('£20.00')] }),
    line({ name: 'Instant Oats', options: ['2.5kg'], cells: [price('£9.00')] }),
  ];
  // One price on a line of two. The subtotal says it is the price of one...
  assert.deepEqual(read(rows(), '£49.00'), [{ ...whey, price: 20, currency: 'GBP' }, { ...oats, price: 9, currency: 'GBP' }]);
  // ...or the line's total...
  assert.deepEqual(read(rows(), '£29.00'), [{ ...whey, price: 10, currency: 'GBP' }, { ...oats, price: 9, currency: 'GBP' }]);
  // ...or, with a code already applied, neither: that line stays unpriced and the line of one keeps its price.
  assert.deepEqual(read(rows(), '£41.65'), [whey, { ...oats, price: 9, currency: 'GBP' }]);
  // A total that does not split into whole pennies is not a price of one.
  assert.deepEqual(read([line({ quantity: '3', cells: [price('£10.00')] })], '£10.00'), [whey]);
});

test('a line the page leaves in doubt carries no price at all', () => {
  // No quantity to read, a quantity that is not a count, a free gift, and a second live price on the row.
  assert.deepEqual(read([line({ quantity: null, cells: [price('£34.99')] })]), [whey]);
  assert.deepEqual(read([line({ quantity: '', cells: [price('£34.99')] })]), [whey]);
  assert.deepEqual(read([line({ quantity: '0', cells: [price('£34.99')] })]), [whey]);
  assert.deepEqual(read([line({ cells: [price('£0.00')] })]), [whey]);
  assert.deepEqual(read([line({ cells: [price('£34.99'), price('£29.99')] })]), [whey]);
  assert.deepEqual(read([line({ cells: [price('Save £5.00'), price('34.99')] })]), [whey]);
  // The same product on two rows: one price when they agree, none when they do not.
  assert.deepEqual(read([line({ cells: [price('£34.99')] }), line({ cells: [price('£34.99')] })]),
    [{ ...whey, price: 34.99, currency: 'GBP' }]);
  assert.deepEqual(read([line({ cells: [price('£34.99')] }), line({ cells: [price('£27.99')] })]), [whey]);
});

test('a row that is not a product line keeps the subtotal from settling anything', () => {
  const gift = el('basket-item', {}, el('span', {}, 'Free gift'), price('£0.00'));
  assert.deepEqual(read([line({ quantity: '2', cells: [price('£20.00')] }), gift], '£40.00'), [whey]);
});

test('a single-item basket uses the basket subtotal when two prices or a coupon discount appear', () => {
  // Two uncrossed prices on the row (e.g. RRP + sale), settled by the real basket subtotal.
  assert.deepEqual(read([line({ cells: [price('£16.99'), price('£9.99')] })], '£9.99'),
    [{ ...whey, price: 9.99, currency: 'GBP' }]);
  // A promo code reduced Basket subtotal below the sticker price: compare against the real discounted total.
  assert.deepEqual(read([line({ cells: [price('£10.00')] })], '£8.50'),
    [{ ...whey, price: 8.5, currency: 'GBP' }]);
});
