import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { runMyproteinCoupons } from '../extension/myprotein.js';

function basket({
  existingCode = false, initialInput = '', enableOnInput = false, reuseRejection = false, noResponse = false,
} = {}) {
  let total = '£10.00';
  let applied = existingCode;
  let alert;
  let observeMutations;
  let testTime = 0;
  const submissions = [];
  class Field {
    get value() { return this.text; }
    set value(value) { this.text = value; }
    dispatchEvent(event) {
      if (enableOnInput && event.type === 'input') {
        // Store validation enables the submit button after the input event.
        setTimeout(() => { button.disabled = !this.value; }, 10);
      }
    }
  }
  const field = new Field();
  field.value = initialInput;
  const button = {
    disabled: enableOnInput,
    click() {
      submissions.push(field.value);
      if (noResponse) return;
      if (field.value === 'SAVE') {
        applied = true;
        total = '£9.50';
        field.value = '';
      } else if (!reuseRejection || !alert) {
        alert = { textContent: 'Invalid discount code or max redemptions reached' };
      } else {
        button.disabled = true;
        setTimeout(() => {
          button.disabled = false;
          observeMutations?.([{ type: 'attributes', target: button, attributeName: 'disabled', oldValue: '' }]);
        }, 10);
      }
    },
  };
  const values = {
    submissions, candidates: ['BAD', 'SAVE', 'LATER'],
    location: new URL('https://www.myprotein.com/basket/'),
    HTMLInputElement: Field, Event, setInterval, clearInterval, setTimeout,
    performance: noResponse ? { now: () => { testTime += 5000; return testTime; } } : performance,
    MutationObserver: class {
      constructor(callback) { observeMutations = callback; }
      observe() {}
      disconnect() { observeMutations = undefined; }
    },
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
  const run = (command = values.candidates, background = false) => {
    values.command = command;
    values.background = background;
    return runInNewContext(`(${runMyproteinCoupons.toString()})(command, background)`, values);
  };
  return { submissions, run, field };
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

test('checkout fills the code before waiting for Apply to enable', async () => {
  const checkout = basket({ enableOnInput: true });
  assert.equal((await checkout.run(['SAVE'])).state, 'saved');
  assert.deepEqual(checkout.submissions, ['SAVE']);
});

test('checkout advances after identical rejections when the second request completes', async () => {
  const checkout = basket({ reuseRejection: true });
  const result = await checkout.run(['BAD', 'NOPE', 'SAVE']);
  assert.equal(result.state, 'saved');
  assert.deepEqual([...result.rejected], ['BAD', 'NOPE']);
  assert.deepEqual(checkout.submissions, ['BAD', 'NOPE', 'SAVE']);
});

test('checkout clears its code on an unconfirmed response so it can be retried', async () => {
  const checkout = basket({ noResponse: true });
  assert.equal((await checkout.run(['BAD', 'SAVE'])).state, 'unknown');
  assert.equal(checkout.field.value, '');
  assert.deepEqual(checkout.submissions, ['BAD']);
  assert.equal((await checkout.run(['SAVE'])).state, 'unknown');
  assert.deepEqual(checkout.submissions, ['BAD', 'SAVE']);
});

test('a detached run can stop after the in-flight attempt', async () => {
  const checkout = basket();
  assert.equal((await checkout.run(undefined, true)).state, 'running');
  assert.equal((await checkout.run('stop')).stopRequested, true);
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.equal((await checkout.run(null)).state, 'stopped');
  assert.deepEqual(checkout.submissions, ['BAD']);
});
