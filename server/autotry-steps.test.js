import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createPageSteps } from '../extension/autotry/steps.js';
import { classifyAnswer } from '../extension/autotry/verdict.js';

function createDom(html, url = 'https://shop.example/cart') {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, { url });
  return { dom, doc: dom.window.document, loc: dom.window.location, win: dom.window };
}

test('createPageSteps: probe, prepare, refusal and confirmed saving on a generic storefront', async () => {
  const { doc, loc } = createDom(`
    <main>
      <div class="promo-box">
        <label for="promo">Promo code</label>
        <input id="promo" name="promo_code" type="text">
        <button id="apply" type="button">Apply</button>
        <div id="msg" role="alert"></div>
      </div>
      <div class="order-summary">
        <span>Total</span>
        <strong id="total">£50.00</strong>
      </div>
    </main>
  `, 'https://generic-shop.example/checkout');

  const input = doc.getElementById('promo');
  const btn = doc.getElementById('apply');
  const msg = doc.getElementById('msg');
  const totalEl = doc.getElementById('total');
  const submitted = [];

  btn.addEventListener('click', () => {
    const code = input.value;
    submitted.push(code);
    if (code === 'SAVE10') {
      msg.textContent = '';
      totalEl.textContent = '£40.00';
    } else {
      msg.textContent = 'Invalid promo code';
    }
  });

  const steps = createPageSteps({ doc, loc, docId: 'doc-1' });
  const probed = await steps.probe();
  assert.equal(probed.secure, true);
  assert.equal(probed.box, 'found');
  assert.equal(probed.driver.kind, 'heuristic');

  const prep = await steps.prepare();
  assert.equal(prep.ok, true);
  assert.equal(prep.total.value, 50);

  const bad = await steps.attempt({ code: 'BAD', n: 1, driver: prep.driver, baseline: prep.total });
  const badVerdict = classifyAnswer(bad.evidence, prep.driver);
  assert.equal(badVerdict.verdict, 'rejected');
  // Plain / invalid refusal automatically files a thumbs-down.
  assert.equal(badVerdict.vote, false);

  const win = await steps.attempt({ code: 'SAVE10', n: 2, driver: prep.driver, baseline: prep.total, previous: { code: 'BAD', rejected: true } });
  const winVerdict = classifyAnswer(win.evidence, prep.driver);
  assert.equal(winVerdict.verdict, 'saved');
  assert.equal(winVerdict.vote, true);
  assert.equal(win.total.value, 40);
  assert.deepEqual(submitted, ['BAD', 'SAVE10']);
});

test('createPageSteps: reveals a hidden promo box before typing', async () => {
  const { doc, loc } = createDom(`
    <main>
      <button id="reveal" type="button" aria-expanded="false">Have a promo code?</button>
      <div id="wrap" hidden>
        <input id="promo" name="promo_code" type="text" placeholder="Promo code">
        <button id="apply" type="button">Apply</button>
      </div>
      <div><span>Total</span><strong id="total">€80,00</strong></div>
    </main>
  `, 'https://hidden-box.example/cart');

  doc.getElementById('reveal').addEventListener('click', () => {
    doc.getElementById('wrap').hidden = false;
    doc.getElementById('reveal').setAttribute('aria-expanded', 'true');
  });
  doc.getElementById('apply').addEventListener('click', () => {
    if (doc.getElementById('promo').value === 'OPEN10') {
      doc.getElementById('total').textContent = '€72,00';
    }
  });

  const steps = createPageSteps({ doc, loc, docId: 'doc-reveal' });
  const probed = await steps.probe();
  assert.equal(probed.box, 'behind');

  const prep = await steps.prepare();
  assert.equal(prep.ok, true);
  assert.equal(prep.revealed, true);

  const res = await steps.attempt({ code: 'OPEN10', n: 1, driver: prep.driver, baseline: prep.total });
  assert.equal(classifyAnswer(res.evidence, prep.driver).verdict, 'saved');
  assert.equal(res.total.value, 72);
});

test('createPageSteps: Shopify cart endpoint (/cart.js + /cart/update.js), 429 pause and finalise', async () => {
  const { doc, loc } = createDom(`
    <meta name="shopify-digital-wallet" content="/1/digital_wallets/dialog">
    <main><div class="shopify-section">Shopify cart</div></main>
  `, 'https://brand.myshopify.com/cart');

  const calls = [];
  let rateLimitNext = false;
  const fetcher = async (url, opts = {}) => {
    const path = String(url);
    calls.push({ path, method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (rateLimitNext) {
      rateLimitNext = false;
      return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '120' }), json: async () => ({}) };
    }
    if (path.endsWith('/cart.js')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ item_count: 2, total_price: 10000, currency: 'GBP', discount_codes: [] }),
      };
    }
    const discount = JSON.parse(opts.body).discount;
    if (discount === 'WELCOME15') {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          item_count: 2,
          total_price: 8500,
          currency: 'GBP',
          discount_codes: [{ code: 'WELCOME15', applicable: true }],
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        item_count: 2,
        total_price: 10000,
        currency: 'GBP',
        discount_codes: discount ? [{ code: discount, applicable: false }] : [],
      }),
    };
  };

  const steps = createPageSteps({ doc, loc, docId: 'doc-shop', fetcher });
  const probed = await steps.probe();
  assert.equal(probed.box, 'recipe');
  assert.equal(probed.driver.id, 'shopify-cart-api');
  assert.equal(probed.mode, 'best');

  const prep = await steps.prepare();
  assert.equal(prep.ok, true);
  assert.equal(prep.total.value, 100);

  const bad = await steps.attempt({ code: 'NOPE', n: 1, driver: prep.driver, baseline: prep.total });
  assert.deepEqual(classifyAnswer(bad.evidence, prep.driver), {
    verdict: 'rejected', outcome: 'rejected', message: 'Not a valid code', vote: false,
  });

  const good = await steps.attempt({ code: 'WELCOME15', n: 2, driver: prep.driver, baseline: prep.total });
  assert.equal(classifyAnswer(good.evidence, prep.driver).verdict, 'saved');
  assert.equal(good.total.value, 85);

  rateLimitNext = true;
  const paused = await steps.attempt({ code: 'MORE', n: 3, driver: prep.driver, baseline: prep.total });
  assert.equal(classifyAnswer(paused.evidence, prep.driver).verdict, 'pause');
  assert.equal(paused.retryAfter, 120_000);

  const fin = await steps.finalise({ code: 'WELCOME15', driver: prep.driver });
  assert.equal(fin.ok, true);
  assert.equal(calls.at(-1).body.discount, 'WELCOME15');
});

test('createPageSteps: settle classifies a freshly reloaded document after form submission', async () => {
  const { doc, loc } = createDom(`
    <form class="woocommerce-cart-form">
      <div class="coupon">
        <input id="coupon_code" name="coupon_code" type="text">
        <button type="submit" name="apply_coupon">Apply coupon</button>
      </div>
    </form>
    <div class="cart_totals">
      <table>
        <tr class="cart-discount coupon-save20"><td>Coupon: SAVE20 <a class="woocommerce-remove-coupon" data-coupon="save20" href="#">[Remove]</a></td></tr>
        <tr class="order-total"><td><span class="woocommerce-Price-amount">£40.00</span></td></tr>
      </table>
    </div>
  `, 'https://woo.example/cart/');

  const steps = createPageSteps({ doc, loc, docId: 'doc-after-reload' });
  const settled = await steps.settle({
    code: 'SAVE20',
    driver: { kind: 'recipe', id: 'woo-classic-cart', via: 'dom' },
    baseline: { value: 50, currency: 'GBP', format: { prefix: '£', suffix: '', group: ',', decimal: '.', decimals: 2 } },
  });
  assert.equal(classifyAnswer(settled.evidence).verdict, 'saved');
  assert.equal(settled.total.value, 40);
  assert.equal(settled.removable, true);
});

test('createPageSteps: remove supports two-step SFRA confirmation modal and refuses personal forms on prepare', async () => {
  // 1. SFRA two-step remove
  const sfra = createDom(`
    <form class="promo-code-form">
      <input id="couponCode" class="coupon-code-field" name="couponCode" type="text">
      <button class="promo-code-btn" type="submit">Submit</button>
    </form>
    <div class="coupons-and-promos">
      <div class="coupon-price-adjustment coupon-uuid-1">
        <span class="coupon-code-name">SAVE10</span>
        <span class="coupon-applied">Applied</span>
        <button class="remove-coupon" data-code="SAVE10" type="button">Remove</button>
      </div>
    </div>
    <div id="removeCouponModal" hidden>
      <button class="delete-coupon-confirmation-btn" type="button">Yes</button>
    </div>
    <p class="grand-total">$90.00</p>
  `, 'https://sfra.example/cart');

  sfra.doc.querySelector('.remove-coupon').addEventListener('click', () => {
    sfra.doc.getElementById('removeCouponModal').hidden = false;
  });
  sfra.doc.querySelector('.delete-coupon-confirmation-btn').addEventListener('click', () => {
    sfra.doc.querySelector('.coupon-price-adjustment').remove();
    sfra.doc.getElementById('removeCouponModal').hidden = true;
  });

  const steps = createPageSteps({ doc: sfra.doc, loc: sfra.loc, docId: 'doc-sfra' });
  const rem = await steps.remove({ code: 'SAVE10', driver: { kind: 'recipe', id: 'sfra-cart', via: 'dom' } });
  assert.equal(rem.ok, true);
  assert.equal(sfra.doc.querySelector('.coupon-price-adjustment'), null);

  // 2. Personal checkout form is refused safely on prepare
  const personal = createDom(`
    <form id="checkout">
      <input name="email" type="email">
      <input name="address1" autocomplete="street-address">
      <input id="promo" name="promo_code" type="text" placeholder="Promo code">
      <button type="submit">Apply</button>
    </form>
  `, 'https://risky.example/checkout');
  const pSteps = createPageSteps({ doc: personal.doc, loc: personal.loc, docId: 'doc-risky' });
  const prep = await pSteps.prepare();
  assert.deepEqual([prep.ok, prep.reason], [false, 'unsafeForm']);
});
