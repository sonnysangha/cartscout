import assert from 'node:assert/strict';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import { readMyproteinBasket } from '../extension/myprotein.js';
import { suggestMarket } from '../extension/markets.js';
import test from 'node:test';
import { createCouponServer } from './index.js';
import { createAlternativeDiscovery } from './alternatives.js';
import { openStore } from './store.js';

test('retailer results use the requested country and distinguish variant and availability', async () => {
  const calls = [];
  const find = createAlternativeDiscovery({ key: 'test', request: async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (url.endsWith('/search')) return Response.json({ state: 'done', results: [
      { url: 'https://us.myprotein.com/product/123' },
      { url: 'https://store.example.com/item/123' },
      { url: 'https://eu.example.org/item/123' },
      { url: 'https://sold.example.net/item/123' },
    ] });
    const offer = {
      title: 'Myprotein Impact Creatine', variant: '150g', match: 'different_variant', price: 12,
      currency: body.url.includes('example.org') ? 'EUR' : 'USD',
      availability: body.url.includes('example.net') ? 'out_of_stock' : 'in_stock',
    };
    return Response.json({ state: 'done', results: [{ json: { offer } }] });
  } });
  const result = await find('myprotein.com', 'US', { name: 'Myprotein Impact Creatine', variant: '500g' });
  assert.equal(calls.length, 4);
  assert(calls.every((call) => call.location === 'US'));
  assert.match(calls[0].query, /United States/);
  assert.deepEqual(result.offers.map(({ retailer, match, availability }) => ({ retailer, match, availability })), [
    { retailer: 'store.example.com', match: 'different_variant', availability: 'unknown' },
  ]);
});

test('basket results are cached separately per country', async (t) => {
  const store = openStore(':memory:');
  const countries = [];
  const server = createCouponServer({ allowAnonymous: true,
    store, findAlternatives: async (_merchant, country) => {
      countries.push(country);
      return { offers: [], partial: false };
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });
  async function lookup(country) {
    return fetch(`http://127.0.0.1:${server.address().port}/v1/alternatives`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + 'a'.repeat(64) },
      body: JSON.stringify({ merchant: 'myprotein.com', country, items: [{ name: 'Myprotein Impact Creatine' }] }),
    });
  }
  assert.equal((await lookup('XX')).status, 400);
  for (const country of ['GB', 'US', 'GB']) assert.equal((await (await lookup(country)).json()).country, country);
  assert.deepEqual(countries, ['GB', 'US']);
});

test('basket reader skips image links and extracts the named product and variant', () => {
  const row = {
    querySelector: () => ({}),
    querySelectorAll: () => [
      { textContent: '' },
      { textContent: 'Impact Creatine', parentElement: { nextElementSibling: {
        tagName: 'UL', querySelectorAll: () => ['Unflavoured', '500g - 147servings'].map((textContent) => ({ textContent })),
      } } },
    ],
  };
  const basket = runInNewContext(`JSON.stringify((${readMyproteinBasket.toString()})())`, {
    location: new URL('https://www.myprotein.com/basket/'),
    document: { querySelectorAll: () => [row, row] },
  });
  assert.deepEqual(JSON.parse(basket), [{ name: 'Myprotein Impact Creatine', variant: 'Unflavoured, 500g' }]);
  assert.equal(suggestMarket('Asia/Dubai', ['en-US']), 'AE');
  assert.equal(suggestMarket('UTC', ['en-CA']), 'CA');
});
