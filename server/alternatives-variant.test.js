import assert from 'node:assert/strict';
import test from 'node:test';
import { createAlternativeDiscovery, sameVariant } from './alternatives.js';

const whey = (variant) => ({ name: 'Myprotein Impact Whey Protein Powder', variant });
const listing = (variant, title = 'Myprotein Impact Whey Protein') => ({ title, variant });

test('one size written differently is the same size', () => {
  for (const written of ['1kg', '1 kg', '1000g', '1000 g', '1.0 KG', '2.2lb']) {
    assert.equal(sameVariant(whey('Vanilla, 1kg'), listing(`Vanilla ${written}`)), 'same', written);
  }
  assert.equal(sameVariant(whey('Vanilla, 1kg (40 servings)'), listing('Vanilla, 40 servings')), 'same');
  assert.equal(sameVariant(whey('Vanilla, 30 servings / 900g'), listing('900g Vanilla')), 'same');
  assert.equal(sameVariant({ name: 'CeraVe Hydrating Cleanser', variant: '250 ml' }, { title: 'CeraVe Hydrating Cleanser 250ml', variant: '250ml' }), 'same');
  assert.equal(sameVariant({ name: 'CeraVe Hydrating Cleanser', variant: '250ml' }, { title: 'CeraVe Hydrating Cleanser', variant: '0.25 L' }), 'same');
});

test('a flavour is the same whatever order its words come in', () => {
  assert.equal(sameVariant(whey('Chocolate Smooth, 1kg'), listing('Smooth Chocolate 1 kg')), 'same');
  assert.equal(sameVariant(whey('Chocolate Smooth, 1kg'), listing('Smooth Chocolate Flavour, 1000g')), 'same');
  assert.equal(sameVariant(whey('Chocolate Smooth, 1kg'), listing('', 'Myprotein Impact Whey Protein Powder Chocolate Smooth 1kg')), 'same');
});

test('a different size or flavour never passes as the same', () => {
  for (const other of ['Vanilla 2.5kg', 'Vanilla 900g', 'Vanilla 1.1kg', 'Vanilla 100g', 'Chocolate 1kg', 'Vanilla, 33 servings / 1kg']) {
    assert.equal(sameVariant(whey('Vanilla, 1kg (40 servings)'), listing(other)), 'different', other);
  }
  assert.equal(sameVariant(whey('Chocolate Smooth, 1kg'), listing('Chocolate Brownie 1kg')), 'different');
  assert.equal(sameVariant({ name: 'CeraVe Hydrating Cleanser', variant: '250ml' }, { title: 'CeraVe Hydrating Cleanser', variant: '236ml' }), 'different');
  assert.equal(sameVariant({ name: 'CeraVe Hydrating Cleanser', variant: '250ml' }, { title: 'CeraVe Hydrating Cleanser 473ml', variant: '' }), 'different');
});

test('wording that cannot settle it leaves the verdict alone', () => {
  // Size or flavour unstated, a size in another measure, a fuller flavour name, or a title naming another product line.
  assert.equal(sameVariant(whey('Vanilla, 1kg'), listing('Vanilla')), 'unknown');
  assert.equal(sameVariant(whey('Vanilla, 1kg'), listing('1kg')), 'unknown');
  assert.equal(sameVariant(whey('Vanilla, 1kg'), listing('Vanilla, 40 servings')), 'unknown');
  assert.equal(sameVariant(whey('Vanilla, 1kg'), listing('Vanilla Creme 1kg')), 'unknown');
  assert.equal(sameVariant(whey('Vanilla, 1kg'), listing('Vanilla 1kg', 'Myprotein Impact Whey Isolate')), 'unknown');
  assert.equal(sameVariant(whey('Vanilla, 1kg'), listing('Vanilla 1kg', 'Protein shake')), 'unknown');
  assert.equal(sameVariant(whey(''), listing('Vanilla 1kg')), 'unknown');
});

test('the lookup searches for the exact variant and settles each listing on its wording', async () => {
  const queries = [];
  const read = [];
  const pages = {
    'https://same.example.com/p/1': { title: 'Myprotein Impact Whey Protein', variant: 'Vanilla 0.9kg', match: 'different_variant', price: 26 },
    'https://bigger.example.com/p/1': { title: 'Myprotein Impact Whey Protein', variant: 'Vanilla 2.5kg', match: 'exact', price: 20 },
    'https://vague.example.com/p/1': { title: 'Myprotein Impact Whey Protein', variant: '', match: 'unconfirmed', price: 24 },
    'https://isolate.example.com/p/1': { title: 'Myprotein Impact Whey Isolate', variant: 'Vanilla 900g', match: 'different_variant', price: 22 },
    'https://trusted.example.com/p/1': { title: 'MP Impact Whey', variant: 'Vanilla', match: 'exact', price: 27 },
  };
  const finder = (listed) => createAlternativeDiscovery({ key: 'test', request: async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/search')) {
      queries.push(body.query);
      return Response.json({ state: 'done', results: listed.map((page) => ({ url: page })) });
    }
    read.push(body.url);
    const offer = { ...pages[body.url], currency: 'GBP', availability: 'in_stock', stockText: 'In stock' };
    return Response.json({ state: 'done', results: [{ json: { offer } }] });
  } });
  const listed = Object.keys(pages);
  const result = await finder(listed)('myprotein.com', 'GB', whey('Vanilla, 30 servings / 900g'));
  assert.deepEqual(queries, ['buy Myprotein Impact Whey Protein Powder Vanilla 30 servings 900g United Kingdom online retailer']);
  // One search and four retailer pages for a product: the fifth retailer the search listed is never asked for.
  assert.deepEqual(read, listed.slice(0, 4));
  assert.deepEqual(result.offers.map(({ retailer, match, price }) => [retailer, match, price]), [
    ['same.example.com', 'exact', 26],
    ['bigger.example.com', 'different_variant', 20],
    ['isolate.example.com', 'different_variant', 22],
    ['vague.example.com', 'unconfirmed', 24],
  ]);

  // Listed on its own, the fifth shows the last rule: a verdict the wording cannot settle stays as the reader gave it.
  const alone = await finder(['https://trusted.example.com/p/1'])('myprotein.com', 'GB', whey('Vanilla, 30 servings / 900g'));
  assert.deepEqual(alone.offers.map(({ retailer, match, price }) => [retailer, match, price]), [['trusted.example.com', 'exact', 27]]);
});
