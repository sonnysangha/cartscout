import assert from 'node:assert/strict';
import test from 'node:test';
import { createAlternativeDiscovery, LOOKUP_CEILING } from './alternatives.js';
import { fakeOxylabs, page, startApi } from './fixtures/kit.js';
import { createDiscovery, localTicket, SCAN_CEILING } from './oxylabs.js';

// A shop with a voucher page of its own and five external coupon sources.
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

test('a scan reads both the shop’s own pages and coupon sites from Google search', async () => {
  const { oxylabs, result } = scan({ [VOUCHERS]: coded('SAVE10'), [SITES[1]]: coded('SITE15') });
  assert.deepEqual(await result, {
    complete: true,
    coupons: [
      { code: 'SAVE10', offer: '10% off everything', sources: [VOUCHERS], expiresOn: null },
      { code: 'SITE15', offer: '10% off everything', sources: [SITES[1]], expiresOn: null },
    ],
  });
  assert.deepEqual(kinds(oxylabs.sent), ['search', HOME, VOUCHERS, ...SITES]);
});

test('coupon sites are read when the shop’s own pages gave no code', async () => {
  const { oxylabs, result } = scan({ [SITES[1]]: coded('SITE15') });
  assert.deepEqual((await result).coupons.map(({ code, sources }) => [code, sources]), [['SITE15', [SITES[1]]]]);
  assert.deepEqual(kinds(oxylabs.sent), ['search', HOME, VOUCHERS, ...SITES]);
});

test('a code that has already ended is filtered out while live coupon-site codes are kept', async () => {
  const ended = page({ markdown: 'Summer sale: 20% off everything. Use code: SUMMER', json: { coupons: [{ code: 'SUMMER', expiresOn: '2020-08-31' }] } });
  const { oxylabs, result } = scan({ [VOUCHERS]: ended, [SITES[1]]: coded('STILLON') });
  assert.deepEqual((await result).coupons.map(({ code }) => code), ['STILLON']);
  assert.deepEqual(kinds(oxylabs.sent), ['search', HOME, VOUCHERS, ...SITES]);
});

test('a scan reads up to 20 external sites and renders at most one merchant page', async () => {
  const sites = Array.from({ length: 21 }, (_, index) => `https://coupon${index + 1}.example.org/shop-discount-codes`);
  const { oxylabs, result } = scan(
    { [HOME]: blank, [VOUCHERS]: blank, [`${VOUCHERS} rendered`]: plain, [sites[19]]: coded('SITE20') },
    { search: [search[0], ...sites.map((url) => ({ title: 'Shop discount codes', url }))] },
  );
  assert.deepEqual((await result).coupons.map(({ code }) => code), ['SITE20']);
  assert.deepEqual(kinds(oxylabs.sent), ['search', HOME, VOUCHERS, `render ${VOUCHERS}`, ...sites.slice(0, 20)]);
  assert.equal(oxylabs.sent.filter((request) => request.run_js).length, 1);
  assert.equal(oxylabs.sent.length, SCAN_CEILING);
});

test('a blank page is not rendered when another of the shop’s pages already showed a code', async () => {
  const { oxylabs, result } = scan({ [HOME]: blank, [VOUCHERS]: coded('SAVE10') });
  assert.deepEqual((await result).coupons.map(({ code }) => code), ['SAVE10']);
  assert.equal(oxylabs.sent.filter((request) => request.run_js).length, 0);
  assert.deepEqual(kinds(oxylabs.sent), ['search', HOME, VOUCHERS, ...SITES]);
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

test('through the API, a scan logs actual requests and hands back any unused hold', async (t) => {
  const oxylabs = fakeOxylabs(async ({ endpoint, url }) => (endpoint === 'search' ? search : url === VOUCHERS ? coded('SAVE10') : plain));
  const clock = { now: Date.parse('2026-11-23T12:00:00Z') };
  const { call, store } = await startApi(t, {
    clock, discover: createDiscovery({ key: 'fixture', location: 'GB', request: oxylabs.request, now: () => clock.now }),
  });

  const answer = await call('coupons', 'pro-c', { merchant: 'shop.example.com' });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.coupons.map(({ code }) => code), ['SAVE10']);
  const { day, held } = store.ledger.totals(clock.now);
  assert.deepEqual([day.requests, day.searches, day.reads, day.rendered, day.forScans, held], [8, 1, 7, 0, 8, 0]);
});

test('search requests up to 20 results and prefers general merchant voucher hubs over narrow single-brand deal threads', async () => {
  const oxylabs = fakeOxylabs(async ({ endpoint, url }) => {
    if (endpoint === 'search') {
      return [
        // Narrow single-brand deal thread appears FIRST on hotukdeals.com:
        { title: 'Charlotte Tilbury free gifts at John Lewis', url: 'https://www.hotukdeals.com/deals/charlotte-tilbury-free-gifts-at-john-lewis-4481234' },
        // General merchant voucher hub appears LATER on hotukdeals.com:
        { title: 'John Lewis Voucher Codes & Discount Codes', url: 'https://www.hotukdeals.com/vouchers/johnlewis.com' },
        // General open-code merchant hubs:
        { title: 'John Lewis Promo Codes', url: 'https://www.wethrift.com/john-lewis' },
        { title: 'John Lewis Discount Codes', url: 'https://simplycodes.com/store/johnlewis.com' },
        { title: 'John Lewis Voucher Codes', url: 'https://www.moneysavingexpert.com/deals/john-lewis/' },
        // Narrow deal post on another host:
        { title: 'Dyson deal at John Lewis', url: 'https://dealsforum.example.org/deals/dyson-john-lewis-999' },
      ];
    }
    if (url.includes('wethrift')) return coded('JL10OFF');
    if (url.includes('/vouchers/johnlewis.com')) return coded('JLHOME15');
    return plain;
  });

  const discover = createDiscovery({ key: 'fixture', location: 'GB', request: oxylabs.request });
  const result = await discover('johnlewis.com');

  assert.equal(oxylabs.sent[0].endpoint, 'search');
  assert.equal(oxylabs.sent[0].max_results, 20);
  // The general voucher hub takes the HotUKDeals slot. The distinct narrow deal is ranked last.
  assert.deepEqual(kinds(oxylabs.sent), [
    'search',
    'https://johnlewis.com/',
    'https://www.wethrift.com/john-lewis',
    'https://simplycodes.com/store/johnlewis.com',
    'https://www.moneysavingexpert.com/deals/john-lewis/',
    'https://www.hotukdeals.com/vouchers/johnlewis.com',
    'https://dealsforum.example.org/deals/dyson-john-lewis-999',
  ]);
  assert.deepEqual(result.coupons.map((c) => c.code), ['JL10OFF', 'JLHOME15']);
});
