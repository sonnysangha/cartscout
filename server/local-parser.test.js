// OXYLABS_PAGE_PARSER=local: the server asks Oxylabs for the page alone and reads the codes and prices itself.
// The answers here are saved files in the response format Oxylabs documents (server/fixtures/oxylabs). None of this
// has been run against the live service, which is why the default stays "ai".
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAlternativeDiscovery } from './alternatives.js';
import { readConfig } from './config.js';
import { fakeOxylabs, fixture, page } from './fixtures/kit.js';
import { pageDocument, readProductPage } from './local-parser.js';
import { createDiscovery } from './oxylabs.js';

const SHOP = 'scoutfixtureshop.com';
const VOUCHERS = 'https://www.scoutfixtureshop.com/offers/voucher-codes/';
const COUPON_SITE = 'https://codes.example.org/scoutfixtureshop';
const DEALS = 'https://deals.example.net/today';
const savedPages = {
  [VOUCHERS]: 'scrape-markdown-shop-voucher-page',
  [COUPON_SITE]: 'scrape-markdown-coupon-site',
  [DEALS]: 'scrape-markdown-deals-page',
};

// The shop of the fixtures. `ownCodes` says whether its voucher page shows codes or an empty offers page.
function scan(parser, { ownCodes = true } = {}) {
  const oxylabs = fakeOxylabs(async ({ endpoint, url }) => {
    if (endpoint === 'search') return Response.json(fixture('search-coupons'));
    if (url === `https://${SHOP}/` || (url === VOUCHERS && !ownCodes)) {
      return page({ markdown: 'Welcome to Scout Fixture Shop. No offers are running right now.' });
    }
    return Response.json(fixture(savedPages[url]));
  });
  return { oxylabs, result: createDiscovery({ key: 'fixture', location: 'GB', parser, request: oxylabs.request })(SHOP) };
}

test('ai is the default page parser, and it asks Oxylabs for AI parsing with every page as before', async () => {
  assert.equal(readConfig({ OXYLABS_WEB_API_KEY: 'fixture' }).parser, 'ai');
  assert.equal(readConfig({ OXYLABS_WEB_API_KEY: 'fixture', OXYLABS_PAGE_PARSER: 'LOCAL' }).parser, 'local');
  assert.throws(() => readConfig({ OXYLABS_WEB_API_KEY: 'fixture', OXYLABS_PAGE_PARSER: 'regex' }), /Use ai or local for OXYLABS_PAGE_PARSER/);

  const { oxylabs, result } = scan(undefined);
  await result;
  const reads = oxylabs.sent.filter(({ endpoint }) => endpoint === 'scrape');
  assert.ok(reads.length >= 2);
  for (const read of reads) {
    assert.deepEqual(read.output, ['markdown', 'json']);
    assert.match(read.json.prompt, /scoutfixtureshop\.com/);
  }
});

test('with local parsing a scan asks for the page alone and reads both shop and coupon-site codes itself', async () => {
  const { oxylabs, result } = scan('local');
  assert.deepEqual(await result, { complete: true, coupons: [
    { code: 'HELLO15', offer: '15% off your first order', sources: [VOUCHERS], expiresOn: null },
    { code: 'FREEDEL30', offer: 'Free delivery over £30', sources: [VOUCHERS], expiresOn: null },
    { code: 'WEEKEND20', offer: '20% off everything this weekend', sources: [COUPON_SITE], expiresOn: null },
    { code: 'NEW10', offer: '10% off for new customers', sources: [COUPON_SITE], expiresOn: null },
    { code: 'SHIPFREE', offer: 'Scout Fixture Shop: free delivery', sources: [DEALS], expiresOn: null },
    { code: 'SALE5', offer: 'Extra 5% off sale lines', sources: [DEALS], expiresOn: null },
  ] });
  // Search, shop pages, and coupon sites — and not one of them asks for AI parsing. "Gift card code" and
  // "Order code: 10530943" on the page are not promotions and were not taken for codes.
  assert.deepEqual(oxylabs.sent.map(({ endpoint, url, output, json, location }) => ({ endpoint, url, output, json, location })), [
    ...Array.from({ length: 4 }, () => ({ endpoint: 'search', url: undefined, output: undefined, json: undefined, location: 'GB' })),
    { endpoint: 'scrape', url: `https://${SHOP}/`, output: ['markdown'], json: undefined, location: 'GB' },
    { endpoint: 'scrape', url: VOUCHERS, output: ['markdown'], json: undefined, location: 'GB' },
    { endpoint: 'scrape', url: COUPON_SITE, output: ['markdown'], json: undefined, location: 'GB' },
    { endpoint: 'scrape', url: DEALS, output: ['markdown'], json: undefined, location: 'GB' },
  ]);
});

test('with local parsing a coupon site’s codes only count where the page is plainly about this shop', async () => {
  const { oxylabs, result } = scan('local', { ownCodes: false });
  const found = await result;
  assert.equal(found.complete, true);
  assert.deepEqual(found.coupons.map(({ code, offer, sources }) => [code, offer, sources]), [
    // The coupon site's page is about this shop (its address says so): its labelled codes count. The masked
    // "Get Code" and "Reveal code" entries print no full code, so there is nothing to read.
    ['WEEKEND20', '20% off everything this weekend', [COUPON_SITE]],
    ['NEW10', '10% off for new customers', [COUPON_SITE]],
    // The deals page is about every shop. A code counts when this shop is named on its line or in its heading,
    // and the codes for Another Store, Third Shop and Fourth Shop are left out.
    ['SHIPFREE', 'Scout Fixture Shop: free delivery', [DEALS]],
    ['SALE5', 'Extra 5% off sale lines', [DEALS]],
  ]);
  assert.equal(oxylabs.sent.length, 8);
  assert.ok(oxylabs.sent.every(({ json }) => json === undefined));
});

// One retailer page in the documented /v1/scrape shape, with the product data a shop publishes in its markup.
const RETAILER = 'https://retailer-one.example.com/p/scout-fixture-whey-vanilla-1kg';
const productPage = (product, { url = RETAILER, head = '' } = {}) => [{
  html: `<!doctype html><html><head>${head}${product ? `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', ...product })}</script>` : ''}</head><body><h1>Page</h1></body></html>`,
  markdown: null, screenshot: null, json: null,
  metadata: { page: 1, run_js: false, url, statuses: { http_request: { code: 200, tag: 'HTTP_OK' } } },
}];
const whey = (name, offers, more = {}) => ({ '@type': 'Product', name, brand: { '@type': 'Brand', name: 'Scout Fixture' }, offers, ...more });
const priced = (price, more = {}) => ({ '@type': 'Offer', price, priceCurrency: 'GBP', availability: 'https://schema.org/InStock', ...more });
const wanted = { name: 'Scout Fixture Whey Protein Powder', variant: 'Vanilla, 1kg' };

// A lookup where each of the search's retailers answers with the page given for it.
async function lookup(pages, item = wanted) {
  const urls = Object.keys(pages);
  const oxylabs = fakeOxylabs(async ({ endpoint, url }) => (endpoint === 'search' ? urls.map((address) => ({ url: address })) : pages[url]));
  const find = createAlternativeDiscovery({ key: 'fixture', parser: 'local', request: oxylabs.request });
  return { oxylabs, result: await find('scoutfixtureshop.com', 'GB', item) };
}

test('with local parsing a price lookup asks for the markup and reads the product the retailer published', async () => {
  const { oxylabs, result } = await lookup({ [RETAILER]: Response.json(fixture('scrape-html-product')) });
  assert.deepEqual(result.offers, [{
    title: 'Scout Fixture Whey Protein Powder Vanilla 1kg', variant: '', match: 'exact', retailer: 'retailer-one.example.com',
    url: RETAILER, price: 24.99, currency: 'GBP', stockText: 'In stock', availability: 'in_stock',
  }]);
  assert.equal(result.partial, false);
  const [, read] = oxylabs.sent;
  assert.deepEqual([read.endpoint, read.url, read.output, read.json, read.location], ['scrape', RETAILER, ['html'], undefined, 'GB']);
});

test('local parsing only calls a listing the same product when its wording settles it', async () => {
  const at = (name) => `https://${name}.example.com/p/whey`;
  const { result } = await lookup({
    [at('same')]: productPage(whey('Whey Protein Powder Vanilla 1000g', priced('26.00'))),
    [at('bigger')]: productPage(whey('Whey Protein Powder Vanilla 2.5kg', priced('49.00'))),
    [at('unsized')]: productPage(whey('Whey Protein Powder', priced('23.00'))),
    [at('unstocked')]: productPage(whey('Whey Protein Powder Vanilla 1kg', priced('25.00', { availability: 'https://schema.org/PreOrder' }))),
  });
  assert.deepEqual(result.offers.map(({ retailer, match, price, availability }) => [retailer, match, price, availability]), [
    ['same.example.com', 'exact', 26, 'in_stock'],
    // Same size and flavour, but the page does not say it is in stock.
    ['unstocked.example.com', 'exact', 25, 'unknown'],
    ['unsized.example.com', 'unconfirmed', 23, 'in_stock'],
    ['bigger.example.com', 'different_variant', 49, 'in_stock'],
  ]);
});

test('local parsing leaves out listings it cannot stand behind, and a page that cannot be read makes the answer partial', async () => {
  const at = (name) => `https://${name}.example.com/p/whey`;
  const first = await lookup({
    [at('euros')]: productPage(whey('Whey Protein Powder Vanilla 1kg', priced('27.00', { priceCurrency: 'EUR' }))),
    [at('soldout')]: productPage(whey('Whey Protein Powder Vanilla 1kg', priced('19.00', { availability: 'https://schema.org/OutOfStock' }))),
    [at('range')]: productPage(whey('Whey Protein Powder Vanilla 1kg', { '@type': 'AggregateOffer', lowPrice: '15.00', highPrice: '60.00', priceCurrency: 'GBP' })),
    [at('used')]: productPage(whey('Whey Protein Powder Vanilla 1kg', priced('9.00', { itemCondition: 'https://schema.org/UsedCondition' }))),
  });
  // Each page was read, and none is a listing: the wrong currency, sold out, a price range, a used item.
  assert.deepEqual([first.result.offers, first.result.partial], [[], false]);
  assert.equal(first.oxylabs.sent.length, 5);

  const second = await lookup({
    [at('other')]: productPage({ '@type': 'Product', name: 'Bamboo Toothbrush Soft Pack of 4', offers: priced('4.00') }),
    [at('category')]: productPage(null),
    [at('meta')]: productPage(null, { head: '<meta property="og:type" content="product"><meta property="og:title" content="Scout Fixture Whey Protein Powder Vanilla 1kg"><meta property="product:price:amount" content="24.50"><meta property="product:price:currency" content="GBP"><meta property="product:availability" content="in stock">' }),
    // The 500 Oxylabs documents for a scrape that failed after its retries.
    [at('blocked')]: Response.json(fixture('scrape-faulted'), { status: 500 }),
  });
  // Another product and a category page are read and give nothing. The page that only has meta tags is a listing.
  assert.deepEqual(second.result.offers.map(({ retailer, match, price, availability }) => [retailer, match, price, availability]), [
    ['meta.example.com', 'exact', 24.5, 'in_stock'],
  ]);
  assert.equal(second.result.partial, true);
  assert.deepEqual(second.result.pages.map(({ retailer, read }) => [retailer, read]), [
    ['other.example.com', true], ['category.example.com', true], ['meta.example.com', true], ['blocked.example.com', false],
  ]);
});

test('with no size or flavour asked for, local parsing needs the same words and the same model number', async () => {
  const headphones = { name: 'Acme Headphones WH-1000XM5', variant: '' };
  const at = (name) => `https://${name}.example.com/p/headphones`;
  const listing = (name) => productPage({ '@type': 'Product', name, offers: priced('249.00') });
  const { result } = await lookup({
    [at('same')]: listing('Acme WH1000XM5 Headphones'),
    [at('bundle')]: listing('Acme WH-1000XM5 Headphones with Travel Case'),
    [at('older')]: listing('Acme WH-1000XM4 Headphones'),
  }, headphones);
  assert.deepEqual(result.offers.map(({ retailer, match }) => [retailer, match]), [
    ['same.example.com', 'exact'],
    // An extra in the title could be a bundle: not confirmed. Another model number is another product: left out.
    ['bundle.example.com', 'unconfirmed'],
  ]);
});

test('the page stand-in holds a product’s published data and nothing it would have to guess from layout', () => {
  const root = pageDocument(`
    <html><head>
      <META PROPERTY='og:title' CONTENT='Tea &amp; Biscuits &#8211; 250g'>
      <meta name=description content=plain>
      <script type="application/ld+json">{"@type":"Product","name":"Tea"}</script>
      <script>window.price = "<h1>not a heading</h1>";</script>
    </head><body>
      <h1 class="title">Tea <span>&amp;</span> Biscuits</h1>
      <select><option value="100">100g</option><option value="250" selected>250g</option></select>
      <input type="radio" name="grind" value="whole" checked><input type="radio" name="grind" value="fine">
      <input type="text" value="typed">
      <div class="price">£4.50</div>
    </body></html>`);
  assert.equal(root.querySelector('meta[property="og:title"], meta[name="og:title"]').getAttribute('content'), 'Tea & Biscuits – 250g');
  assert.equal(root.querySelector('meta[name="description"]').getAttribute('content'), 'plain');
  assert.equal(root.querySelector('meta[property="og:price:amount"]'), null);
  assert.deepEqual(root.querySelectorAll('script[type="application/ld+json"]').map((script) => JSON.parse(script.textContent).name), ['Tea']);
  assert.deepEqual(root.querySelectorAll('input[type="radio"]:checked, option:checked').map((control) => control.value), ['250', 'whole']);
  // Layout it cannot see is never invented: no price from a styled element, no options from a widget, no buttons.
  assert.deepEqual(root.querySelectorAll('*'), []);
  assert.deepEqual(root.querySelectorAll('span, p, div, strong, b, ins'), []);
  assert.deepEqual(root.querySelectorAll('button, [role="button"], input[type="submit"]'), []);
  assert.equal(root.querySelector('[itemtype*="schema.org/Product"]'), null);

  assert.equal(readProductPage('<html><body><h1>Just a heading</h1><button>Add to basket</button></body></html>', RETAILER), null);
  assert.equal(readProductPage('<html></html>', 'not an address'), null);
  assert.deepEqual(readProductPage(fixture('scrape-html-product').results[0].html, RETAILER), {
    name: 'Scout Fixture Whey Protein Powder Vanilla 1kg', variant: '', price: 24.99, currency: 'GBP', from: false,
    source: 'structured', availability: 'in_stock', used: false,
  });
});
