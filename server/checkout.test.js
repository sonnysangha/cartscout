import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { runMyproteinCoupons } from '../extension/myprotein.js';

function basket({ existingCode = false, initialInput = '' } = {}) {
  let total = '£10.00';
  let applied = existingCode;
  let alert;
  const submissions = [];
  class Field {
    get value() { return this.text; }
    set value(value) { this.text = value; }
    dispatchEvent() {}
  }
  const field = new Field();
  field.value = initialInput;
  const button = {
    click() {
      submissions.push(field.value);
      if (field.value === 'SAVE') {
        applied = true;
        total = '£9.50';
        field.value = '';
      } else {
        alert = { textContent: 'Invalid discount code or max redemptions reached' };
      }
    },
  };
  const values = {
    submissions, candidates: ['BAD', 'SAVE', 'LATER'],
    location: new URL('https://www.myprotein.com/basket/'),
    HTMLInputElement: Field, Event, setInterval, clearInterval, setTimeout, performance,
    MutationObserver: class { observe() {} disconnect() {} },
    document: {
      body: {},
      getElementById(id) {
        return {
          'promo-code-input': field, 'promo-code-add': button,
          'promo-code-remove': applied ? {} : null, 'promo-error-message': alert,
        }[id];
      },
      querySelectorAll: () => [{
        childElementCount: 0, textContent: 'Basket subtotal:',
        nextElementSibling: { textContent: total },
      }],
    },
  };
  return { submissions, run: () => runInNewContext(`(${runMyproteinCoupons.toString()})(candidates)`, values) };
}

test('checkout keeps the first code that reduces the subtotal', async () => {
  const checkout = basket();
  const { state, code, before, after, attempted } = await checkout.run();
  assert.deepEqual(checkout.submissions, ['BAD', 'SAVE']);
  assert.deepEqual({ state, code, before, after, attempted }, {
    state: 'saved', code: 'SAVE', before: 1000, after: 950, attempted: 2,
  });
});

test('checkout preserves an existing code and shopper input', async () => {
  for (const [options, state] of [
    [{ existingCode: true }, 'alreadyApplied'],
    [{ initialInput: 'MANUAL' }, 'inputOccupied'],
  ]) {
    const checkout = basket(options);
    assert.equal((await checkout.run()).state, state);
    assert.deepEqual(checkout.submissions, []);
  }
});
