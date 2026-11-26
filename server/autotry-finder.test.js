import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { detectBlocker, isEmptyBasket } from '../extension/autotry/blockers.js';
import { resolveDriver } from '../extension/autotry/driver.js';
import {
  findApplyControl, findCartLink, findCodeBox, findReveals, isPersonalForm, isSafeApplyControl, isSafeCodeInput, pageKind,
} from '../extension/autotry/finder.js';
import { describeElement, expiredPickKeys, makePickRecord, resolvePickPart, validatePickPart } from '../extension/autotry/pick.js';
import { matchRecipes, RECIPES, recipeTrust } from '../extension/autotry/recipes.js';
import { findGenericTotal, readRecipeTotal } from '../extension/autotry/totals.js';
import { classifyMessageText } from '../extension/autotry/vocab.js';

function makeDoc(html, url = 'https://shop.example/cart') {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, { url });
  return { dom, document: dom.window.document, loc: dom.window.location, win: dom.window };
}

test('all platform recipes are plain data with valid ids, platforms and provenance facts', () => {
  assert.ok(RECIPES.length >= 24, `expected at least 24 recipes, got ${RECIPES.length}`);
  const ids = new Set(RECIPES.map((r) => r.id));
  assert.equal(ids.size, RECIPES.length);
  for (const r of RECIPES) {
    assert.ok(r.id && r.platform && r.facts);
    assert.ok(['verified', 'recalled'].includes(recipeTrust(r, 'input')), r.id);
    // Plain data: no functions embedded inside recipe definitions.
    assert.equal(JSON.stringify(r).includes('function'), false, r.id);
  }
});

test('recipes match major storefront markups and resolve input, apply and total', () => {
  const fixtures = [
    {
      name: 'THG Myprotein',
      url: 'https://www.myprotein.com/basket/',
      id: 'thg-nutrition',
      trust: 'verified',
      html: `<main>
        <basket-item>Whey</basket-item>
        <div><input id="promo-code-input" type="text"><button id="promo-code-add" type="button">Apply</button></div>
        <p><span>Basket subtotal:</span><span>£62.00</span></p>
      </main>`,
      expectedTotal: 62,
    },
    {
      name: 'Shopify Horizon Cart',
      url: 'https://brand.myshopify.com/cart',
      id: 'shopify-horizon-cart',
      trust: 'verified',
      html: `<cart-discount-component>
        <form><input id="cart-discount" name="discount" type="text"><button class="cart-discount__button" type="submit">Apply</button></form>
      </cart-discount-component>
      <div class="cart-totals__total-value" data-testid="cart-total-value">$85.00</div>`,
      expectedTotal: 85,
    },
    {
      name: 'Shopify Checkout',
      url: 'https://shop.example/checkouts/cn/abc123',
      id: 'shopify-checkout',
      trust: 'verified',
      html: `<meta name="serialized-checkoutLayout" content="1">
      <section>
        <form><input name="reductions" type="text" placeholder="Discount code"><button type="submit" data-event-name="apply_discount">Apply</button></form>
        <div role="row"><div role="cell"><abbr>USD</abbr><strong>$120.50</strong></div></div>
      </section>`,
      expectedTotal: 120.5,
    },
    {
      name: 'WooCommerce Classic',
      url: 'https://woo.example/cart/',
      id: 'woo-classic-cart',
      trust: 'verified',
      html: `<form class="woocommerce-cart-form">
        <div class="coupon">
          <input id="coupon_code" name="coupon_code" type="text">
          <button type="submit" name="apply_coupon">Apply coupon</button>
        </div>
      </form>
      <div class="cart_totals"><table><tr class="order-total"><td><span class="woocommerce-Price-amount">£45.00</span></td></tr></table></div>`,
      expectedTotal: 45,
    },
    {
      name: 'WooCommerce Blocks',
      url: 'https://woo.example/checkout/',
      id: 'woo-blocks',
      trust: 'verified',
      html: `<div class="wp-block-woocommerce-checkout">
        <div class="wc-block-components-totals-coupon">
          <div class="wc-block-components-totals-coupon__form">
            <input id="wc-block-components-totals-coupon__input-0" type="text">
            <button class="wc-block-components-totals-coupon__button" type="submit">Apply</button>
          </div>
        </div>
        <div class="wc-block-components-totals-footer-item"><span class="wc-block-components-totals-item__value">€79,90</span></div>
      </div>`,
      expectedTotal: 79.9,
    },
    {
      name: 'Magento Luma',
      url: 'https://m2.example/checkout/cart/',
      id: 'magento-luma-cart',
      trust: 'verified',
      bodyAttr: 'data-container="body"',
      html: `<form id="discount-coupon-form">
        <input id="coupon_code" name="coupon_code" type="text">
        <button class="action apply primary" type="button">Apply Discount</button>
      </form>
      <div id="cart-totals"><table><tr class="grand totals"><td class="amount"><span class="price">$199.00</span></td></tr></table></div>`,
      expectedTotal: 199,
    },
    {
      name: 'PrestaShop Classic',
      url: 'https://ps.example/cart',
      id: 'prestashop',
      trust: 'verified',
      html: `<script>var prestashop = {};</script>
      <div class="cart-voucher">
        <div id="promo-code">
          <form data-link-action="add-voucher"><input name="discount_name" type="text"><button type="submit">Add</button></form>
        </div>
      </div>
      <div class="cart-summary-totals"><div class="cart-total"><span class="value">59,50 €</span></div></div>`,
      expectedTotal: 59.5,
    },
    {
      name: 'Shopware 6',
      url: 'https://sw.example/checkout/cart',
      id: 'shopware-cart',
      trust: 'verified',
      html: `<form action="/checkout/promotion/add">
        <input id="addPromotionOffcanvasCartInput" name="code" type="text">
        <button id="addPromotionOffcanvasCart" type="submit">Einlösen</button>
      </form>
      <dd class="checkout-aside-summary-value checkout-aside-summary-total">129,00 €</dd>`,
      expectedTotal: 129,
    },
    {
      name: 'SFCC SFRA',
      url: 'https://sfra.example/cart',
      id: 'sfra-cart',
      trust: 'verified',
      html: `<form class="promo-code-form">
        <input id="couponCode" class="coupon-code-field" name="couponCode" type="text">
        <button class="promo-code-btn" type="submit">Submit</button>
      </form>
      <p class="grand-total">$210.00</p>`,
      expectedTotal: 210,
    },
    {
      name: 'SAP Spartacus',
      url: 'https://sap.example/cart',
      id: 'spartacus-cart',
      trust: 'verified',
      html: `<cx-cart-coupon>
        <form><input class="input-coupon-code" type="text"><button class="apply-coupon-button" type="submit">Apply</button></form>
      </cx-cart-coupon>
      <cx-order-summary><div class="cx-summary-total"><div class="cx-summary-amount">$310.00</div></div></cx-order-summary>`,
      expectedTotal: 310,
    },
  ];

  for (const fx of fixtures) {
    const dom = new JSDOM(`<!doctype html><html><head></head><body ${fx.bodyAttr ?? ''}>${fx.html}</body></html>`, { url: fx.url });
    const document = dom.window.document;
    const loc = dom.window.location;
    const matches = matchRecipes(document, loc);
    assert.ok(matches.length > 0, `no recipe matched ${fx.name}`);
    assert.equal(matches[0].id, fx.id, `${fx.name} matched ${matches[0].id} instead of ${fx.id}`);
    assert.equal(recipeTrust(matches[0], 'input'), fx.trust, fx.name);

    const driver = resolveDriver(document, loc);
    assert.equal(driver.kind, 'recipe', fx.name);
    assert.equal(driver.id, fx.id, fx.name);
    assert.ok(driver.box(), `${fx.name} missing input`);
    assert.ok(driver.applyControl(), `${fx.name} missing apply`);

    const total = readRecipeTotal(document, matches[0].total) ?? findGenericTotal(document).pick;
    assert.ok(total, `${fx.name} missing total`);
    assert.equal(total.money.value, fx.expectedTotal, fx.name);
  }
});

test('10-language heuristic finder locates promo code boxes and apply buttons without a recipe', () => {
  const langs = [
    ['EN', 'Promo code', 'Apply'],
    ['DE', 'Gutscheincode', 'Einlösen'],
    ['FR', 'Code promo', 'Appliquer'],
    ['ES', 'Código promocional', 'Aplicar'],
    ['IT', 'Codice sconto', 'Applica'],
    ['NL', 'Kortingscode', 'Toepassen'],
    ['PT', 'Cupom de desconto', 'Aplicar'],
    ['SV', 'Rabattkod', 'Använd'],
    ['DA', 'Rabatkode', 'Anvend'],
    ['PL', 'Kod rabatowy', 'Zastosuj'],
  ];

  for (const [lang, label, btn] of langs) {
    const { document, loc } = makeDoc(`
      <main>
        <div class="summary">
          <label for="c">${label}</label>
          <input id="c" type="text" placeholder="${label}">
          <button type="button">${btn}</button>
        </div>
        <div class="summary-total"><span>Total</span><span>€42,00</span></div>
      </main>
    `, 'https://custom-shop.example/checkout');

    const found = findCodeBox(document, loc);
    assert.equal(found.verdict, 'found', `${lang}: expected found, got ${found.verdict}`);
    assert.equal(found.chosen.field.id, 'c', lang);
    assert.ok(found.chosen.apply, `${lang}: missing apply button`);
  }
});

test('safety traps: rejects gift card + PIN, order/pay button, search/email/postcode/card inputs, and personal forms', () => {
  // 1. Gift card with PIN sibling is rejected by heuristic finder
  const gift = makeDoc(`
    <form>
      <label for="gc">Gift card code</label>
      <input id="gc" name="gift_card" type="text">
      <input id="pin" name="gift_pin" placeholder="PIN" type="text">
      <button type="submit">Apply</button>
    </form>
  `);
  assert.equal(findCodeBox(gift.document, gift.loc).verdict, 'none');

  // 2. Danger submit button ("Place order" next to promo box)
  const danger = makeDoc(`
    <form>
      <label for="promo">Promo code</label>
      <input id="promo" name="promo_code" type="text">
      <button id="pay" type="submit">Place order</button>
    </form>
  `);
  const payBtn = danger.document.getElementById('pay');
  const promoInput = danger.document.getElementById('promo');
  assert.equal(isSafeApplyControl(payBtn, promoInput), false);
  assert.equal(findApplyControl(promoInput, danger.document.querySelector('form')).best, null);

  // 3. Search, email, postcode, credit card, password fields are rejected by isSafeCodeInput
  const traps = makeDoc(`
    <form>
      <input id="s" type="search" placeholder="Search promo deals">
      <input id="e" type="email" name="email" placeholder="Email for discount code">
      <input id="p" type="text" name="postcode" autocomplete="postal-code" placeholder="Postal code">
      <input id="cc" type="text" autocomplete="cc-number" placeholder="Card number">
      <input id="pw" type="password" name="passcode">
    </form>
  `);
  for (const id of ['s', 'e', 'p', 'cc', 'pw']) {
    assert.equal(isSafeCodeInput(traps.document.getElementById(id)), false, id);
  }

  // 4. Personal-data checkout form shares a <form> with billing/shipping fields
  const personal = makeDoc(`
    <form id="checkout-form">
      <input name="email" type="email">
      <input name="address1" autocomplete="street-address">
      <input name="postcode" autocomplete="postal-code">
      <input id="coupon" name="coupon_code" type="text">
      <button type="submit">Continue</button>
    </form>
  `);
  assert.equal(isPersonalForm(personal.document.getElementById('checkout-form')), true);
});

test('hidden reveal toggles, cart links and pageKind detection work accurately', () => {
  const hidden = makeDoc(`
    <main>
      <button id="toggle" type="button">Have a promo code?</button>
      <div hidden><input id="promo" name="promo_code" type="text"></div>
    </main>
  `, 'https://shop.example/cart');
  assert.equal(findReveals(hidden.document).length, 1);
  assert.equal(findCodeBox(hidden.document, hidden.loc).verdict, 'behind');

  const product = makeDoc(`
    <header><a href="/shopping-bag">View bag (2)</a></header>
    <main><button>Add to bag</button></main>
  `, 'https://shop.example/products/hoodie');
  assert.equal(pageKind(product.document, product.loc), 'other');
  assert.equal(findCartLink(product.document, product.loc), '/shopping-bag');
});

test('blockers detect captcha, login walls, order confirmations, cross-origin iframes and empty baskets', () => {
  const cap = makeDoc('<div class="g-recaptcha" data-sitekey="abc"></div><iframe src="https://challenges.cloudflare.com/turnstile"></iframe>');
  assert.equal(detectBlocker(cap.document, cap.loc), 'captcha');

  const login = makeDoc('<form><input type="email" name="email"><input type="password" name="password"><button>Sign in</button></form>', 'https://shop.example/login');
  assert.equal(detectBlocker(login.document, login.loc), 'login');

  const thanks = makeDoc('<main><h1>Thank you for your order</h1><p>Order number #12345</p></main>', 'https://shop.example/checkout/thank-you');
  assert.equal(detectBlocker(thanks.document, thanks.loc), 'confirmation');

  const frame = makeDoc('<main><iframe src="https://payments.thirdparty.example/checkout"></iframe></main>', 'https://shop.example/checkout');
  assert.equal(detectBlocker(frame.document, frame.loc), 'frame');

  const empty = makeDoc('<main><h1>Your shopping cart is empty</h1></main>', 'https://shop.example/cart');
  assert.equal(isEmptyBasket(empty.document), true);
});

test('multilingual refusal & pause wording classifier covers all 10 languages', () => {
  assert.deepEqual(classifyMessageText('This code has expired'), { kind: 'error', reason: 'expired' });
  assert.deepEqual(classifyMessageText('Dieser Gutscheincode ist abgelaufen'), { kind: 'error', reason: 'expired' });
  assert.deepEqual(classifyMessageText('Code promo invalide'), { kind: 'error', reason: 'invalid' });
  assert.deepEqual(classifyMessageText('Minimum spend of £50 required'), { kind: 'error', reason: 'basket' });
  assert.deepEqual(classifyMessageText('Cannot be combined with other offers'), { kind: 'error', reason: 'combine' });
  assert.deepEqual(classifyMessageText('A better offer is already applied'), { kind: 'error', reason: 'better' });
  assert.deepEqual(classifyMessageText('Too many attempts, please wait'), { kind: 'pause' });
});

test('pick selectors describe, resolve, validate and expire remembered shopper picks cleanly', () => {
  const { document } = makeDoc(`
    <main>
      <div class="promo-area">
        <label for="voucher">Voucher code</label>
        <input id="voucher" data-testid="voucher-input" name="voucher" type="text">
        <button data-testid="voucher-apply" type="button">Apply</button>
      </div>
    </main>
  `);
  const input = document.getElementById('voucher');
  const part = describeElement(input, { kind: 'input' });
  assert.ok(validatePickPart(part));
  assert.equal(resolvePickPart(document, part, { kind: 'input' }), input);

  // Reject invalid parts (no print.tag or empty selectors).
  assert.equal(validatePickPart({ selectors: ['input'] }), null);
  assert.equal(validatePickPart({ selectors: [], print: { tag: 'input' } }), null);

  const rec = makePickRecord({ host: 'www.shop.example', path: '/cart', input: part, now: 1000 });
  assert.equal(rec.host, 'shop.example');
  const now = 1000 + 200 * 24 * 60 * 60 * 1000;
  const stale = expiredPickKeys({
    'box:fresh.example': { v: 1, usedAt: now - 1000 },
    'box:old.example': { v: 1, usedAt: 1 },
    'other:key': { v: 1, usedAt: 1 },
  }, now);
  assert.deepEqual(stale, ['box:old.example']);
});
