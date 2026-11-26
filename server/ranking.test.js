import assert from 'node:assert/strict';
import test from 'node:test';
import { openStore } from './store.js';

const NOW = Date.UTC(2026, 10, 25, 12);
const coupon = (code) => ({ code, offer: '', sources: [], expiresOn: null });

test('codes are ranked by net votes, then by how often they worked', () => {
  const store = openStore(':memory:');
  store.save('shop.example', { coupons: ['AAA', 'BBB', 'CCC', 'DDD'].map(coupon), complete: true }, NOW);
  const vote = (code, reporter, worked) => store.report('shop.example', code, reporter, worked, NOW);
  for (const reporter of ['r1', 'r2', 'r3']) vote('AAA', reporter, true);
  vote('AAA', 'r4', false);
  vote('BBB', 'r1', true);
  vote('DDD', 'r1', false);
  vote('DDD', 'r2', false);

  const listed = store.listing('shop.example', 'r1', NOW);
  assert.deepEqual(listed.map(({ code }) => code), ['AAA', 'BBB', 'CCC', 'DDD']);
  assert.deepEqual(listed.map(({ worked, failed }) => [worked, failed]), [[3, 1], [1, 0], [0, 0], [0, 2]]);
  store.close();
});

test('a code voted down does not outrank codes nobody has tried', () => {
  const store = openStore(':memory:');
  store.save('shop.example', { coupons: ['FIRST', 'SECOND'].map(coupon), complete: true }, NOW);
  store.report('shop.example', 'SECOND', 'r1', false, NOW);
  assert.deepEqual(store.listing('shop.example', 'r1', NOW).map(({ code }) => code), ['FIRST', 'SECOND']);
  store.close();
});
