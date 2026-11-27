import assert from 'node:assert/strict';
import test from 'node:test';
import { findCachedSaving } from '../extension/price-alerts.js';

const product = { name: 'Garmin Forerunner 265 46mm', variant: 'Black', price: 259.99, currency: 'GBP' };
const offer = { retailer: 'sigmasports.com', price: 233, currency: 'GBP', availability: 'in_stock', match: 'exact' };
const now = () => Date.parse('2026-11-27T08:00:00Z');
const freshUntil = '2026-11-27T08:30:00Z';

test('a cached UK match uses the live page price and identifies the country and retailer', async () => {
  const saving = await findCachedSaving(async (merchant, market, item) => {
    assert.equal(merchant, 'johnlewis.com');
    assert.equal(market, 'GB');
    assert.deepEqual(item, { name: product.name, variant: 'Black' });
    return [{ offers: [offer], freshUntil }];
  }, 'johnlewis.com', product, now);
  assert.equal(saving.title, '£26.99 cheaper in the United Kingdom');
  assert.equal(saving.detail, '£233.00 at sigmasports.com · before delivery');
  assert.equal(saving.result.own.price, 259.99);
});

test('automatic savings require a fresh, like-for-like in-stock offer below the current price', async () => {
  for (const listing of [
    { ...offer, availability: 'out_of_stock' },
    { ...offer, match: 'different_variant' },
    { ...offer, currency: 'USD' },
    { ...offer, price: 259.99 },
  ]) {
    const lookup = async () => [{ offers: [listing], freshUntil }];
    assert.equal(await findCachedSaving(lookup, 'johnlewis.com', product, now), null);
  }
  const expired = async () => [{ offers: [offer], freshUntil: '2026-11-27T08:00:00Z' }];
  assert.equal(await findCachedSaving(expired, 'johnlewis.com', product, now), null);
  const mustNotLookup = () => assert.fail('A starting price cannot be compared');
  assert.equal(await findCachedSaving(mustNotLookup, 'johnlewis.com', { ...product, from: true }, now), null);
});

test('automatic savings can select an eligible cached offer in another same-currency market', async () => {
  const checked = [];
  const saving = await findCachedSaving(async (_merchant, market) => {
    checked.push(market);
    if (market === 'IE') throw new Error('Cache request failed');
    const price = market === 'FR' ? 210 : 240;
    return [{ offers: [{ ...offer, currency: 'EUR', price }], freshUntil }];
  }, 'example.de', { ...product, currency: 'EUR' }, now);
  assert.deepEqual(checked, ['DE', 'FR', 'IE', 'NL']);
  assert.equal(saving.country, 'FR');
  assert.match(saving.title, /cheaper in France/);
});
