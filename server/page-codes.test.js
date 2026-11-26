import assert from 'node:assert/strict';
import test from 'node:test';
import { readPageCodes } from '../extension/page-codes.js';

const page = (innerText) => ({ body: { innerText } });
const codes = (innerText) => readPageCodes(page(innerText)).map(({ code }) => code);

test('codes a shop advertises in its own banner are read with their offer', () => {
  assert.deepEqual(readPageCodes(page(
    'Order by 1AM tonight for Next Day Delivery\n\nUP TO 30% OFF + EXTRA 5% OFF SELECTED - USE CODE: EXTRA | APP EXCLUSIVE - DOWNLOAD NOW\n\nSearch for a product',
  )), [{ code: 'EXTRA', offer: 'Up to 30% off + extra 5% off selected' }]);

  assert.deepEqual(readPageCodes(page('20% off £40 or 15% off £30\nCode:\nSAVE\nShop now\n\nRedeem instore')), [
    { code: 'SAVE', offer: '20% off £40 or 15% off £30' },
  ]);
});

test('a code with a button label glued onto it is still read', () => {
  assert.deepEqual(readPageCodes(page('20% off £40 or 15% off £30 Code:SAVECopiedShop now Redeem instore')), [
    { code: 'SAVE', offer: '20% off £40 or 15% off £30' },
  ]);
  assert.deepEqual(codes('Use code: SPRING25Copy code'), ['SPRING25']);
  assert.deepEqual(readPageCodes(page('20% off £40 or 15% off £30\n\n\nCode:\n\nSAVE\n\nShop now')), [
    { code: 'SAVE', offer: '20% off £40 or 15% off £30' },
  ]);
});

test('an invitation makes a lower-case word a code, shown in upper case', () => {
  assert.deepEqual(readPageCodes(page('Offers apply automatically.\n\nUse code:\n\nmore\n\nShop now')), [
    { code: 'MORE', offer: '' },
  ]);
  assert.deepEqual(codes('Get 10% off your first order with code welcome10 at checkout.'), ['WELCOME10']);
  assert.deepEqual(codes('Enter the promo code "SPRING-25" for 25% off. Use code SPRING-25 today.'), ['SPRING-25']);
});

test('ordinary uses of the word code are ignored', () => {
  for (const ordinary of [
    'Promo code\nApply',
    'PROMO CODE APPLY',
    'No code needed. Discount applied at checkout.',
    'Enter your postcode: SW1A 1AA',
    'Scan the QR code: ABC123 to download the app',
    'Gift card code: 9911AA',
    'Read our code of conduct and dress code policy.',
    'Enter code at checkout for free delivery',
    'Country code: GB',
  ]) assert.deepEqual(codes(ordinary), [], ordinary);
});

test('repeats are merged and the list is capped', () => {
  assert.deepEqual(codes('USE CODE: EXTRA\n\nuse code: extra\n\nUse code EXTRA'), ['EXTRA']);
  const many = Array.from({ length: 9 }, (_, index) => `Use code: DEAL${index}0`).join('\n\n');
  assert.equal(codes(many).length, 5);
  assert.deepEqual(readPageCodes(page('')), []);
  assert.deepEqual(readPageCodes({}), []);
});

test('a basket’s own promo form is never read as a code', () => {
  for (const form of [
    'Apply promo code\nSubtotal\n£42.00',
    'Enter code\nRedeem',
    'Enter discount code\nUpdate basket',
    'Promo code\nContinue to checkout',
    'Add a voucher code\n\nTotal £18.50',
  ]) assert.deepEqual(codes(form), [], form);
  // A colon still lets a real code sit on the line below its label.
  assert.deepEqual(codes('Use code:\nSPRING25\nSubtotal'), ['SPRING25']);
});

test('reference numbers that happen to be called codes are ignored', () => {
  for (const reference of [
    'Code: 10530943',
    'Product details\nModel code: WH1000XM5',
    'Postal code: M5V 2T6',
    'Stock code: AB12345',
    'Part code: KX-7781',
  ]) assert.deepEqual(codes(reference), [], reference);
  // An invitation still makes a numbers-only code a code.
  assert.deepEqual(codes('Use code 2026 for 20% off'), ['2026']);
});

test('the offer is read from the code’s own line before the line above', () => {
  assert.deepEqual(readPageCodes(page('Free delivery over £50\nUse code SAVE10 for 10% off your first order. T&Cs apply.')), [
    { code: 'SAVE10', offer: '10% off your first order' },
  ]);
  assert.deepEqual(readPageCodes(page('New here?\nEnter code HELLO15 at checkout to get 15% off')), [
    { code: 'HELLO15', offer: '15% off' },
  ]);
});

test('a page full of whitespace does not stall the reader', () => {
  const started = Date.now();
  assert.deepEqual(codes(`code${' '.repeat(80_000)}\n${'use code '.repeat(2_000)}${'\t'.repeat(40_000)}`), []);
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
});
