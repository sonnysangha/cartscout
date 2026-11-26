// THG nutrition (Myprotein UK) conformance tests against the generic auto-try engine (D1–D7).
// Exercises createPageSteps + classifyAnswer inside jsdom so every Myprotein basket scenario stays verified.

import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createPageSteps } from '../extension/autotry/steps.js';
import { classifyAnswer } from '../extension/autotry/verdict.js';
import { LOST_AFTER, RECHECK_MS, stopPageRun, SYNC_MS } from '../extension/panel/logic.js';
import { POLL_MS } from '../extension/run.js';

function myproteinBasket({
  existingCode = false,
  initialInput = '',
  enableOnInput = false,
  reuseRejection = false,
  noResponse = false,
  answers = {},
  redrawMs = 0,
  promoBox = true,
  subtotalShown = true,
  items = 1,
  emptyText = false,
  notices = [],
} = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <main>
      <section id="items">
        ${emptyText ? '<p>Your basket is empty. Start shopping.</p>' : '<h1>Your Shopping Basket</h1>'}
        ${Array.from({ length: items }, () => '<basket-item>Impact Whey</basket-item>').join('')}
      </section>
      <section id="promo-area">
        ${promoBox ? `<input id="promo-code-input" type="text"><button id="promo-code-add" type="button">Use code</button>` : ''}
        ${existingCode ? '<button id="promo-code-remove" type="button">Remove</button>' : ''}
        <div id="promo-error-message"></div>
      </section>
      ${notices.map((t) => `<div role="alert">${t}</div>`).join('')}
      <aside id="summary">
        ${subtotalShown ? '<p><span>Basket subtotal:</span><span id="subtotal">£10.00</span></p>' : ''}
      </aside>
    </main>
  </body></html>`, { url: 'https://www.myprotein.com/basket/' });

  const doc = dom.window.document;
  const loc = dom.window.location;
  const submissions = [];
  const promoArea = doc.getElementById('promo-area');

  function bindControls() {
    const input = doc.getElementById('promo-code-input');
    const btn = doc.getElementById('promo-code-add');
    if (!input || !btn) return;
    if (enableOnInput) {
      btn.disabled = !input.value;
      input.addEventListener('input', () => {
        setTimeout(() => { btn.disabled = !input.value; }, 10);
      });
    }
    btn.addEventListener('click', () => {
      const code = input.value;
      submissions.push(code);
      const answer = answers[code];
      if (noResponse || answer === 'silence') return;
      if (answer === 'late') {
        setTimeout(() => {
          const rem = doc.createElement('button');
          rem.id = 'promo-code-remove';
          rem.textContent = 'Remove';
          promoArea.appendChild(rem);
          const sub = doc.getElementById('subtotal');
          if (sub) sub.textContent = '£9.50';
        }, 60);
        return;
      }
      if (typeof answer === 'string') {
        doc.getElementById('promo-error-message').textContent = answer;
        if (redrawMs) triggerRedraw();
      } else if (code === 'SAVE') {
        const rem = doc.createElement('button');
        rem.id = 'promo-code-remove';
        rem.textContent = 'Remove';
        promoArea.appendChild(rem);
        const sub = doc.getElementById('subtotal');
        if (sub) sub.textContent = '£9.50';
        input.value = '';
      } else if (code === 'ACCEPT_ONLY') {
        const rem = doc.createElement('button');
        rem.id = 'promo-code-remove';
        rem.textContent = 'Remove';
        promoArea.appendChild(rem);
        input.value = '';
      } else if (!reuseRejection || !doc.getElementById('promo-error-message').textContent) {
        doc.getElementById('promo-error-message').textContent = 'Invalid discount code or max redemptions reached';
        if (redrawMs) triggerRedraw();
      } else {
        btn.disabled = true;
        setTimeout(() => { btn.disabled = false; }, 15);
      }
    });
  }

  function triggerRedraw() {
    const input = doc.getElementById('promo-code-input');
    const btn = doc.getElementById('promo-code-add');
    if (!input || !btn) return;
    const saved = input.value;
    input.remove();
    btn.remove();
    setTimeout(() => {
      const nextInput = doc.createElement('input');
      nextInput.id = 'promo-code-input';
      nextInput.type = 'text';
      nextInput.value = saved;
      const nextBtn = doc.createElement('button');
      nextBtn.id = 'promo-code-add';
      nextBtn.type = 'button';
      nextBtn.textContent = 'Use code';
      promoArea.prepend(nextBtn);
      promoArea.prepend(nextInput);
      bindControls();
    }, redrawMs);
  }

  const field = doc.getElementById('promo-code-input');
  if (field && initialInput) field.value = initialInput;
  bindControls();

  const steps = createPageSteps({ doc, loc, docId: 'mp-doc' });
  return { doc, loc, steps, submissions };
}

test('Myprotein basket keeps the first code that reduces the subtotal', async () => {
  const mp = myproteinBasket();
  const prep = await mp.steps.prepare();
  assert.equal(prep.ok, true);
  assert.equal(prep.driver.id, 'thg-nutrition');
  assert.equal(prep.driver.label, 'Myprotein');
  assert.equal(prep.total.value, 10);

  const r1 = await mp.steps.attempt({ code: 'BAD', n: 1, driver: prep.driver, baseline: prep.total });
  assert.deepEqual(classifyAnswer(r1.evidence, prep.driver), {
    verdict: 'rejected', outcome: 'rejected', message: 'Not valid, or all used up', vote: false,
  });

  const r2 = await mp.steps.attempt({ code: 'SAVE', n: 2, driver: prep.driver, baseline: prep.total, previous: { code: 'BAD', rejected: true } });
  assert.deepEqual(classifyAnswer(r2.evidence, prep.driver), {
    verdict: 'saved', outcome: 'applied', message: '', vote: true,
  });
  assert.equal(r2.total.value, 9.5);
  assert.deepEqual(mp.submissions, ['BAD', 'SAVE']);
});

test('Myprotein basket preserves an existing applied code and shopper input', async () => {
  for (const [options, expectedReason] of [
    [{ existingCode: true }, 'applied'],
    [{ initialInput: 'MANUAL' }, 'occupied'],
  ]) {
    const mp = myproteinBasket(options);
    const prep = await mp.steps.prepare();
    assert.deepEqual([prep.ok, prep.reason], [false, expectedReason]);
    assert.deepEqual(mp.submissions, []);
  }
});

test('Myprotein basket fills the code before waiting for Apply to enable', async () => {
  const mp = myproteinBasket({ enableOnInput: true });
  const prep = await mp.steps.prepare();
  assert.equal(prep.ok, true);
  const res = await mp.steps.attempt({ code: 'SAVE', n: 1, driver: prep.driver, baseline: prep.total });
  assert.equal(classifyAnswer(res.evidence, prep.driver).verdict, 'saved');
  assert.deepEqual(mp.submissions, ['SAVE']);
});

test('Myprotein basket advances after identical rejections when Apply cycles disabled', async () => {
  const mp = myproteinBasket({ reuseRejection: true });
  const prep = await mp.steps.prepare();
  const r1 = await mp.steps.attempt({ code: 'BAD', n: 1, driver: prep.driver, baseline: prep.total });
  assert.equal(classifyAnswer(r1.evidence, prep.driver).verdict, 'rejected');

  const r2 = await mp.steps.attempt({ code: 'NOPE', n: 2, driver: prep.driver, baseline: prep.total, previous: { code: 'BAD', rejected: true } });
  assert.equal(classifyAnswer(r2.evidence, prep.driver).verdict, 'rejected');

  const r3 = await mp.steps.attempt({ code: 'SAVE', n: 3, driver: prep.driver, baseline: prep.total, previous: { code: 'NOPE', rejected: true } });
  assert.equal(classifyAnswer(r3.evidence, prep.driver).verdict, 'saved');
  assert.deepEqual(mp.submissions, ['BAD', 'NOPE', 'SAVE']);
});

test('Myprotein basket waits for redraw before typing the next code', async () => {
  const mp = myproteinBasket({ redrawMs: 120 });
  const prep = await mp.steps.prepare();
  const r1 = await mp.steps.attempt({ code: 'BAD', n: 1, driver: prep.driver, baseline: prep.total });
  assert.equal(classifyAnswer(r1.evidence, prep.driver).verdict, 'rejected');

  const r2 = await mp.steps.attempt({ code: 'SAVE', n: 2, driver: prep.driver, baseline: prep.total, previous: { code: 'BAD', rejected: true } });
  assert.equal(classifyAnswer(r2.evidence, prep.driver).verdict, 'saved');
  assert.deepEqual(mp.submissions, ['BAD', 'SAVE']);
});

test('Myprotein basket detects pause/throttle wording both in promo box and in page alerts', async () => {
  for (const text of [
    'Too many discount codes tried. Please wait before trying again.',
    'Something went wrong. Please try again later.',
    'Please complete the security check to continue.',
    'Sorry, we couldn’t apply your code right now.',
  ]) {
    const mp = myproteinBasket({ answers: { BBB: text } });
    const prep = await mp.steps.prepare();
    const res = await mp.steps.attempt({ code: 'BBB', n: 1, driver: prep.driver, baseline: prep.total });
    assert.equal(classifyAnswer(res.evidence, prep.driver).verdict, 'pause', text);
    mp.steps.clear();
    assert.equal(mp.doc.getElementById('promo-code-input').value, '');
  }

  const elsewhere = myproteinBasket({ answers: { AAA: 'silence' }, notices: ['Please complete the security check'] });
  const prep = await elsewhere.steps.prepare();
  const res = await elsewhere.steps.attempt({ code: 'AAA', n: 1, driver: prep.driver, baseline: prep.total });
  assert.equal(classifyAnswer(res.evidence, prep.driver).verdict, 'pause');
});

test('Myprotein basket classifies refusal reasons and thumbs faithfully', async () => {
  const wording = {
    AAA: ['Sorry, this code couldn’t be applied', 'The shop turned it down', false],
    BBB: ['This code cannot be applied to your order', 'The shop turned it down', false],
    CCC: ['Code not valid', 'Not a valid code', false],
    DDD: ['Invalid discount code or max redemptions reached', 'Not valid, or all used up', false],
    EEE: ['This code has expired', 'Expired', false],
    FFF: ['This code has already been used', 'Already used', undefined],
    GGG: ['Code not applicable to items in your basket', 'Doesn’t apply to this basket', undefined],
    HHH: ['You are not eligible for this offer', 'Doesn’t apply to this basket', undefined],
    JJJ: ['A better offer already applied to your basket', 'A better offer is already on this basket', undefined],
  };
  const mp = myproteinBasket({ answers: Object.fromEntries(Object.entries(wording).map(([code, [text]]) => [code, text])) });
  const prep = await mp.steps.prepare();
  let previous = null;
  let index = 0;
  for (const [code, [, expectedMessage, expectedVote]] of Object.entries(wording)) {
    index += 1;
    const res = await mp.steps.attempt({ code, n: index, driver: prep.driver, baseline: prep.total, previous });
    const verdict = classifyAnswer(res.evidence, prep.driver);
    assert.equal(verdict.verdict, 'rejected', code);
    assert.equal(verdict.message, expectedMessage, code);
    assert.equal(verdict.vote, expectedVote, code);
    previous = { code, rejected: true };
  }
});

test('missing promo box, unreadable subtotal, empty basket and existing code map to honest prepare reasons', async () => {
  for (const [options, expected] of [
    [{ promoBox: false }, 'noBox'],
    [{ subtotalShown: false }, 'noTotal'],
    [{ promoBox: false, subtotalShown: false }, 'noBox'],
    [{ promoBox: false, subtotalShown: false, items: 0 }, 'empty'],
    [{ promoBox: false, emptyText: true }, 'empty'],
    [{ promoBox: false, existingCode: true }, 'applied'],
  ]) {
    const mp = myproteinBasket(options);
    const prep = await mp.steps.prepare();
    assert.deepEqual([prep.ok, prep.reason], [false, expected], JSON.stringify(options));
  }
});

test('panel check-in constants and legacy stopPageRun stay consistent', () => {
  assert.ok(POLL_MS > 0);
  assert.ok(SYNC_MS + (LOST_AFTER - 1) * RECHECK_MS <= 6000);
  assert.equal(stopPageRun({}), false);
  const scope = { cartScoutCouponTrial: { state: 'running', stopRequested: false } };
  assert.equal(stopPageRun(scope), true);
  assert.equal(scope.cartScoutCouponTrial.stopRequested, true);
});
