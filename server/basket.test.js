// Universal basket & checkout reader tests: Shopify checkout (e.g. Allbirds), Amazon cart, and generic carts.

import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { isBasketPath, readPageBasket } from '../extension/basket.js';

function runBasket(html, url = 'https://www.allbirds.co.uk/checkouts/cn/abc123/en-gb') {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url });
  return readPageBasket(dom.window.document, dom.window.location);
}

test('isBasketPath matches international cart, basket and checkout paths', () => {
  for (const path of ['/cart', '/basket/', '/my.basket', '/checkouts/cn/xyz', '/checkout', '/bag', '/panier', '/warenkorb']) {
    assert.equal(isBasketPath(path), true, path);
  }
  for (const path of ['/products/runner', '/p/creatine/123', '/', '/collections/mens']) {
    assert.equal(isBasketPath(path), false, path);
  }
});

test('reads Shopify checkout order summary, prepends single-brand prefix, and skips Free Returns Coverage', () => {
  const items = runBasket(`
    <aside aria-label="Order summary">
      <div role="table" aria-label="Shopping cart">
        <div role="rowgroup">
          <div role="row">
            <div role="columnheader">Product image</div>
            <div role="columnheader">Description</div>
            <div role="columnheader">Quantity</div>
            <div role="columnheader">Price</div>
          </div>
        </div>
        <div role="rowgroup">
          <div role="row">
            <div role="cell"><span>1</span></div>
            <div role="cell">
              <p>Men’s Runner Chelsea Protect - Natural Black (Natural Black Sole)</p>
              <p>UK 8</p>
            </div>
            <div role="cell"><span>£140.00</span></div>
          </div>
          <div role="row">
            <div role="cell"><span>1</span></div>
            <div role="cell">
              <p>Free Returns Coverage</p>
              <p>R6S7F</p>
            </div>
            <div role="cell"><span>£1.98</span></div>
          </div>
        </div>
      </div>
      <div>Subtotal · 2 items <span>£141.98</span></div>
      <div>Order discount <span>- £14.19</span></div>
      <div>Total <span>GBP £127.79</span></div>
    </aside>
  `);
  assert.deepEqual(items, [{
    name: 'Allbirds Men’s Runner Chelsea Protect - Natural Black (Natural Black Sole)',
    variant: 'UK 8',
    price: 140,
    currency: 'GBP',
  }]);
});

test('reads generic basket items and skips upsells/recommendations', () => {
  const items = runBasket(`
    <main>
      <div class="basket-item">
        <a href="/p/vit-c">Holland &amp; Barrett Vitamin C 1000mg 240 Tablets</a>
        <span class="variant">240 Tablets</span>
        <input class="quantity" value="1">
        <s>£15.49</s>
        <span>£7.74</span>
      </div>
      <section class="recommendations">
        <div class="basket-item">
          <a href="/p/upsell">Recommended Upsell Item</a>
          <span>£9.99</span>
        </div>
      </section>
    </main>
  `, 'https://www.hollandandbarrett.com/basket');
  assert.deepEqual(items, [{
    name: 'Holland & Barrett Vitamin C 1000mg 240 Tablets',
    variant: '240 Tablets',
    price: 7.74,
    currency: 'GBP',
  }]);
});

test('reads Amazon active cart items', () => {
  const items = runBasket(`
    <div id="sc-active-cart">
      <div class="sc-list-item" data-asin="B09XS7JWHH">
        <span class="sc-product-title">Sony WH-1000XM5 Wireless Headphones</span>
        <span class="sc-product-price">£249.00</span>
      </div>
    </div>
  `, 'https://www.amazon.co.uk/gp/cart/view.html');
  assert.deepEqual(items, [{
    name: 'Sony WH-1000XM5 Wireless Headphones',
    variant: '',
    price: 249,
    currency: 'GBP',
  }]);
});
