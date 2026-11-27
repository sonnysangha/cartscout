import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createCouponServer } from './index.js';
import { createDiscovery } from './oxylabs.js';
import { openStore, reporterKey } from './store.js';

test('discovery scrapes independent sources and filters invalid or expired codes', async () => {
  const calls = [];
  const request = async (address, { body }) => {
    const input = JSON.parse(body);
    calls.push({ address, input });
    // The shop's own home page advertises no code here. Coupon sites are only read when that is so.
    const home = input.url === 'https://nike.com/';
    const results = address.endsWith('/search') ? [
      { title: 'Coupons', url: 'https://discounts.example.com/nike' },
      { title: 'Deals', url: 'https://www.discounts.example.com/duplicate' },
      { title: 'Vouchers', url: 'https://savings.example.org/nike' },
      { title: 'Discount', url: 'http://127.0.0.1/invalid' },
    ] : home ? [{ markdown: 'New season trainers and free delivery over £50.', json: { coupons: [] } }]
      : [{ markdown: 'Use code: SAVE10\n\nUse code: PAST40\n\nEST\nGet Code', json: { coupons: [
        { code: ' SAVE10 ', offer: '10% off' },
        { code: 'PAST40', expiresOn: '2000-01-01' },
        { code: '<script>' },
        { code: 'EST' },
      ] } }];
    return Response.json({ state: 'done', results });
  };
  const discover = createDiscovery({ key: 'fixture', location: 'GB', request });
  const result = await discover('nike.com');
  // Four searches, the shop's home page, and each independent coupon site once.
  assert.equal(calls.length, 7);
  assert.match(calls[0].input.query, /nike\.com coupon/);
  assert.equal(calls[0].input.location, 'GB');
  assert.match(calls[4].input.json.prompt, /nike\.com/);
  assert.deepEqual(calls.slice(4).map(({ input }) => input.url), [
    'https://nike.com/', 'https://discounts.example.com/nike', 'https://savings.example.org/nike',
  ]);
  assert.deepEqual(result, { complete: true, coupons: [{
    code: 'SAVE10', offer: '10% off', expiresOn: null,
    sources: ['https://discounts.example.com/nike', 'https://savings.example.org/nike'],
  }] });
});

test('shared cache, votes, vote changes, and persistence survive server restart', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'cartscout-test-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  let time = Date.now();
  let searches = 0;
  let outage = false;
  const discover = async () => {
    searches += 1;
    if (outage) throw new Error('Fixture outage');
    return { complete: true, coupons: [
      { code: 'TEST10', offer: 'Fixture offer', sources: [], expiresOn: null },
      { code: 'ABC10', offer: 'Fixture offer', sources: [], expiresOn: null },
    ] };
  };

  async function start() {
    const store = openStore(join(temp, 'shared.sqlite'));
    const server = createCouponServer({ allowAnonymous: true, discover, store, now: () => time, log: () => {} });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return {
      async call(route, reporter = 'a', fields = {}) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/${route}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + reporter.repeat(64) },
          body: JSON.stringify({ merchant: 'www.nike.com', ...fields }),
        });
        return { status: response.status, body: await response.json() };
      },
      async close() {
        await new Promise((resolve) => server.close(resolve));
        store.close();
      },
    };
  }

  const first = await start();
  try {
    const lookups = await Promise.all([first.call('coupons'), first.call('coupons', 'b')]);
    assert(lookups.every(({ status, body }) => status === 200 && body.coupons.length === 2));
    assert.equal(searches, 1);
    assert.equal((await first.call('coupons', 'b')).body.source, 'cache');
    assert.equal((await first.call('reports', 'b', { code: 'MADEUP', worked: true })).status, 404);
    assert.equal((await first.call('reports', 'a', { code: 'TEST10', worked: false })).status, 200);
    const changed = (await first.call('reports', 'a', { code: 'TEST10', worked: true })).body;
    assert.equal(changed.coupons[0].code, 'TEST10');
    assert.equal(changed.coupons[0].myReport, 1);
    assert.equal(changed.coupons[0].failed, 0);
    assert.equal(changed.coupons[0].worked, 1);
  } finally {
    await first.close();
  }

  const restarted = await start();
  try {
    const second = (await restarted.call('coupons', 'b')).body;
    assert.equal(second.source, 'cache');
    assert.equal(second.coupons[0].worked, 1);
    assert.equal(second.coupons[0].myReport, null);
    assert.equal(searches, 1);

    time += 25 * 3_600_000;
    outage = true;
    const stale = (await restarted.call('coupons', 'b')).body;
    assert.equal(stale.source, 'stale');
    assert.equal(stale.coupons[0].worked, 1);
  } finally {
    await restarted.close();
  }
});

test('standalone official code evidence survives an empty AI extraction', async () => {
  const discover = createDiscovery({ key: 'fixture', location: 'GB', request: async (url) => {
    const results = url.endsWith('/search') ? [] : [{
      markdown: 'Offers apply automatically.\n\nUse code:\n\nmore\n\n[Shop now](/shop)',
      json: { coupons: [] },
    }];
    return Response.json({ state: 'done', results });
  } });
  assert.deepEqual((await discover('myprotein.com')).coupons.map(({ code }) => code), ['MORE']);
});

test('a code in the shop’s own banner is found, and a blocked home page does not make the scan partial', async () => {
  const pages = {
    'https://lookfantastic.com/': [{
      markdown: 'Order by 1AM for Next Day Delivery\n\nUP TO 30% OFF + EXTRA 5% OFF SELECTED - USE CODE: EXTRA | APP EXCLUSIVE\n\n[Black Friday](/c/black-friday/)',
      json: { coupons: [] },
    }],
    'https://codes.example.org/lookfantastic': [{ markdown: 'Get Code\n\nReveal code', json: { coupons: [] } }],
  };
  const service = (blocked) => createDiscovery({ key: 'fixture', location: 'GB', request: async (address, { body }) => {
    const { url } = JSON.parse(body);
    if (address.endsWith('/search')) {
      return Response.json({ state: 'done', results: [{ title: 'Lookfantastic discount codes', url: 'https://codes.example.org/lookfantastic' }] });
    }
    if (blocked && url === 'https://lookfantastic.com/') return new Response('', { status: 613 });
    return Response.json({ state: 'done', results: pages[url] });
  } });

  assert.deepEqual(await service(false)('lookfantastic.com'), { complete: true, coupons: [{
    code: 'EXTRA', offer: 'Up to 30% off + extra 5% off selected', sources: ['https://lookfantastic.com/'], expiresOn: null,
  }] });
  assert.deepEqual(await service(true)('lookfantastic.com'), { complete: true, coupons: [] });
});

test('older cached coupons are rediscovered without deleting their reports', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'cartscout-migration-'));
  const path = join(temp, 'previous.sqlite');
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const merchant = 'myprotein.com';
  const time = Date.now();
  const reporter = reporterKey('fixture-report');
  const coupon = { code: 'MORE', offer: '', sources: [], expiresOn: null };

  const previous = openStore(path);
  previous.save(merchant, { coupons: [coupon], complete: true }, time);
  assert.equal(previous.report(merchant, coupon.code, reporter, true, time), true);
  previous.close();
  const legacy = new DatabaseSync(path);
  legacy.exec('ALTER TABLE searches DROP COLUMN discovery_version; ALTER TABLE coupons DROP COLUMN discovery_version;');
  legacy.close();

  const current = openStore(path);
  try {
    assert.equal(current.get(merchant), undefined);
    assert.deepEqual(current.listing(merchant, reporter, time), []);
    current.save(merchant, { coupons: [coupon], complete: true }, time + 1);
    assert.equal(current.listing(merchant, reporter, time + 1)[0].worked, 1);
  } finally {
    current.close();
  }
});

test('a shop page that is blank without JavaScript is read again rendered', async () => {
  const scrapes = [];
  const discover = createDiscovery({ key: 'fixture', location: 'GB', request: async (address, { body }) => {
    const input = JSON.parse(body);
    if (address.endsWith('/search')) return Response.json({ state: 'done', results: [] });
    scrapes.push(input.run_js === true);
    const markdown = input.run_js
      ? `${'Vitamins and supplements. '.repeat(12)}\n\n20% off £40 or 15% off £30 Code:SAVECopiedShop now Redeem instore`
      : '';
    return Response.json({ state: 'done', results: [{ markdown, json: { coupons: [] } }] });
  } });

  assert.deepEqual(await discover('hollandandbarrett.com'), { complete: true, coupons: [{
    code: 'SAVE', offer: '20% off £40 or 15% off £30', sources: ['https://hollandandbarrett.com/'], expiresOn: null,
  }] });
  assert.deepEqual(scrapes, [false, true]);
});

test('hasPublicCode accepts real coupon-site wording ("Enter CODE at checkout", tables) and prefers open-code sites over reveal walls', async () => {
  const scraped = [];
  const discover = createDiscovery({ key: 'fixture', location: 'GB', request: async (address, { body }) => {
    const input = JSON.parse(body);
    if (address.endsWith('/search')) {
      return Response.json({ state: 'done', results: [
        { title: 'Shop Discount Codes - Wowcher', url: 'https://www.wowcher.co.uk/discountcodes/shop.example.com' },
        { title: 'Shop Voucher Codes - Telegraph', url: 'https://www.telegraph.co.uk/vouchercodes/shop' },
        { title: 'Shop Promo Codes', url: 'https://www.couponsolver.com/promo-codes/shop.example.com' },
        { title: 'Shop Coupons', url: 'https://wethrift.com/shop-example' },
        { title: 'Shop Deals', url: 'https://www.groupon.co.uk/discount-codes/shop' },
      ] });
    }
    scraped.push(input.url);
    if (input.url.includes('couponsolver')) {
      return Response.json({ state: 'done', results: [{
        markdown: '#### How to use it\n\nEnter HB25 at checkout to get 25% off sitewide.\n\n| `EXTRA15` | 15% off |\n\nEST\nGet Code',
        json: { coupons: [
          { code: 'HB25', offer: '25% off sitewide' },
          { code: 'EXTRA15', offer: '15% off' },
          { code: 'EST', offer: 'Masked preview' },
        ] },
      }] });
    }
    return Response.json({ state: 'done', results: [{ markdown: 'Welcome to the shop. Free delivery on orders over £50.', json: { coupons: [] } }] });
  } });

  const found = await discover('shop.example.com');
  // Open-code sites (couponsolver, wethrift) and mixed (groupon) are chosen ahead of wowcher/telegraph reveal walls.
  assert.deepEqual(scraped, [
    'https://shop.example.com/',
    'https://www.couponsolver.com/promo-codes/shop.example.com',
    'https://wethrift.com/shop-example',
    'https://www.groupon.co.uk/discount-codes/shop',
    'https://www.wowcher.co.uk/discountcodes/shop.example.com',
    'https://www.telegraph.co.uk/vouchercodes/shop',
  ]);
  assert.deepEqual(found.coupons.map((c) => c.code), ['HB25', 'EXTRA15']);
});
