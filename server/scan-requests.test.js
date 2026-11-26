import assert from 'node:assert/strict';
import test from 'node:test';
import { createAlternativeDiscovery, LOOKUP_CEILING } from './alternatives.js';
import { fakeOxylabs, page, startApi } from './fixtures/kit.js';
import { createDiscovery, localTicket, SCAN_CEILING } from './oxylabs.js';

// A shop with a voucher page of its own, and more coupon sites in the search results than a scan may read.
const HOME = 'https://shop.example.com/';
const VOUCHERS = 'https://www.shop.example.com/voucher-codes';
const SITES = ['one', 'two', 'three', 'four', 'five'].map((name) => `https://${name}.example.org/shop-discount-codes`);
const search = [
  { title: 'Shop voucher codes', url: VOUCHERS },
  ...SITES.map((url) => ({ title: 'Shop discount codes', url })),
];
const coded = (code) => page({ markdown: `10% off everything - use code: ${code}`, json: { coupons: [{ code, offer: '10% off everything' }] } });
const plain = page({ markdown: 'New in this week. Free returns on every order.', json: { coupons: [] } });
const blank = page({ markdown: '', json: { coupons: [] } });

// A scan of shop.example.com where each page answers as the test says. Pages not named answer with a plain page.
function scan(pages, options = {}) {
  const oxylabs = fakeOxylabs(async ({ endpoint, url, run_js: rendered }) => {
    if (endpoint === 'search') return options.search ?? search;
    const answer = pages[rendered ? `${url} rendered` : url] ?? plain;
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const discover = createDiscovery({ key: 'fixture', location: 'GB', request: oxylabs.request });
  return { oxylabs, result: discover('shop.example.com', options.ticket && { ticket: options.ticket }) };
}
const kinds = (sent) => sent.map(({ endpoint, url, run_js: rendered }) => (endpoint === 'search' ? 'search' : `${rendered ? 'render ' : ''}${url}`));

test('a scan reads both the shop’s own pages and coupon sites from Google search, up to six requests', async () => {
  const { oxylabs, result } = scan({ [VOUCHERS]: coded('SAVE10'), [SITES[1]]: coded('SITE15') });
  assert.deepEqual(await result, {
    complete: true,
    coupons: [
      { code: 'SAVE10', offer: '10% off everything', sources: [VOUCHERS], expiresOn: null },
      { code: 'SITE15', offer: '10% off everything', sources: [SITES[1]], expiresOn: null },
    ],
  });
  // One Google search, two shop pages, and three distinct coupon sites: always capped at SCAN_CEILING (6).
  assert.deepEqual(kinds(oxylabs.sent), ['search', HOME, VOUCHERS, SITES[0], SITES[1], SITES[2]]);
  assert.equal(oxylabs.sent.length, SCAN_CEILING);
});

test('coupon sites are read when the shop’s own pages gave no code, and never past six requests', async () => {
  const { oxylabs, result } = scan({ [SITES[1]]: coded('SITE15') });
  assert.deepEqual((await result).coupons.map(({ code, sources }) => [code, sources]), [['SITE15', [SITES[1]]]]);
  assert.deepEqual(kinds(oxylabs.sent), ['search', HOME, VOUCHERS, SITES[0], SITES[1], SITES[2]]);
  assert.equal(oxylabs.sent.length, SCAN_CEILING);
});

test('a code that has already ended is filtered out while live coupon-site codes are kept', async () => {
  const ended = page({ markdown: 'Summer sale: 20% off everything. Use code: SUMMER', json: { coupons: [{ code: 'SUMMER', expiresOn: '2020-08-31' }] } });
  const { oxylabs, result } = scan({ [VOUCHERS]: ended, [SITES[1]]: coded('STILLON') });
  assert.deepEqual((await result).coupons.map(({ code }) => code), ['STILLON']);
  assert.deepEqual(kinds(oxylabs.sent), ['search', HOME, VOUCHERS, SITES[0], SITES[1], SITES[2]]);
});

test('at most one page is read again with JavaScript, and the scan still stops at six requests', async () => {
  const promo = 'https://shop.example.com/offers';
  const { oxylabs, result } = scan(
    { [HOME]: blank, [VOUCHERS]: blank, [promo]: blank, [`${VOUCHERS} rendered`]: plain },
    { search: [{ title: 'Shop voucher codes', url: VOUCHERS }, { title: 'Shop offers', url: promo }, ...search.slice(1)] },
  );
  assert.deepEqual(await result, { complete: true, coupons: [] });
  // Two shop pages came back blank; one (the voucher page) is rendered, leaving two slots for coupon sites.
  assert.deepEqual(kinds(oxylabs.sent), ['search', HOME, VOUCHERS, `render ${VOUCHERS}`, SITES[0], SITES[1]]);
  assert.equal(oxylabs.sent.filter((request) => request.run_js).length, 1);
  assert.equal(oxylabs.sent.length, SCAN_CEILING);
});

test('a blank page is not rendered when another of the shop’s pages already showed a code', async () => {
  const { oxylabs, result } = scan({ [HOME]: blank, [VOUCHERS]: coded('SAVE10') });
  assert.deepEqual((await result).coupons.map(({ code }) => code), ['SAVE10']);
  assert.equal(oxylabs.sent.filter((request) => request.run_js).length, 0);
  assert.deepEqual(kinds(oxylabs.sent), ['search', HOME, VOUCHERS, SITES[0], SITES[1], SITES[2]]);
});

test('a scan cannot send more than it reserved, whatever the search lists', async () => {
  // Only three requests are reserved: the search and the shop's two pages use them, and the coupon sites the scan
  // would go on to read are refused before anything is sent.
  const { oxylabs, result } = scan({}, { ticket: localTicket('scan', 3) });
  assert.deepEqual(await result, { complete: false, coupons: [] });
  assert.deepEqual(kinds(oxylabs.sent), ['search', HOME, VOUCHERS]);
});

test('a price lookup is one search and at most four retailer pages', async () => {
  const retailers = Array.from({ length: 8 }, (_, index) => `https://retailer${index + 1}.example.com/p/widget`);
  const oxylabs = fakeOxylabs(async ({ endpoint }) => (endpoint === 'search'
    ? retailers.map((url) => ({ url }))
    : page({ json: { offer: { title: 'Acme Widget', variant: '', match: 'exact', price: 9.5, currency: 'GBP', availability: 'in_stock', stockText: 'In stock' } } })));
  const find = createAlternativeDiscovery({ key: 'fixture', request: oxylabs.request });
  const result = await find('shop.example.com', 'GB', { name: 'Acme Widget', variant: '' });

  assert.equal(LOOKUP_CEILING, 5);
  assert.deepEqual(kinds(oxylabs.sent), ['search', ...retailers.slice(0, 4)]);
  assert.equal(result.offers.length, 4);
  assert.equal(result.partial, false);
});

test('through the API, a scan puts up to six requests in the ledger and hands back any unused hold', async (t) => {
  const oxylabs = fakeOxylabs(async ({ endpoint, url }) => (endpoint === 'search' ? search : url === VOUCHERS ? coded('SAVE10') : plain));
  const clock = { now: Date.parse('2026-11-23T12:00:00Z') };
  const { call, store } = await startApi(t, {
    clock, discover: createDiscovery({ key: 'fixture', location: 'GB', request: oxylabs.request, now: () => clock.now }),
  });

  const answer = await call('coupons', 'pro-c', { merchant: 'shop.example.com' });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.coupons.map(({ code }) => code), ['SAVE10']);
  const { day, held } = store.ledger.totals(clock.now);
  assert.deepEqual([day.requests, day.searches, day.reads, day.rendered, day.forScans, held], [6, 1, 5, 0, 6, 0]);
});
