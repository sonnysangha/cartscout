// OXYLABS_MODE: live, replay and off, and OXYLABS_RECORD. Replay and off never call Oxylabs and need no key.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createAlternativeDiscovery } from './alternatives.js';
import { readConfig } from './config.js';
import { fakeOxylabs, HOUR, page, startApi } from './fixtures/kit.js';
import { createFromEnv, describeOxylabs } from './index.js';
import { createDiscovery, createOxylabsClient, localTicket } from './oxylabs.js';
import { createRecorder } from './recorder.js';
import { openReplayFolder } from './replay.js';
import { openStore } from './store.js';

const SERVER = fileURLToPath(new URL('./index.js', import.meta.url));
const REPLAY_FOLDER = fileURLToPath(new URL('./replay', import.meta.url));
const when = (time) => new Date(time).toISOString();
const temporary = (t, name) => {
  const folder = mkdtempSync(join(tmpdir(), `cartscout-${name}-`));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
};

// A live API first, to save scans and lookups the way a real day would. Each scan of shop.example.com finds the
// code of the moment, so two scans a day apart are told apart.
async function liveDay(t, store, clock) {
  const state = { code: 'FIRST10' };
  const oxylabs = fakeOxylabs(async ({ endpoint, query, url }) => {
    if (endpoint === 'search') return query.startsWith('buy ') ? [{ url: 'https://retailer1.example.com/p/item' }] : [];
    if (url.includes('/p/')) {
      return page({ json: { offer: { title: 'Acme Widget', variant: '', match: 'exact', price: 9.5, currency: 'GBP', availability: 'in_stock', stockText: 'In stock' } } });
    }
    return page({ markdown: `10% off everything - use code: ${state.code}`, json: { coupons: [] } });
  });
  const client = { key: 'fixture', request: oxylabs.request, now: () => clock.now };
  const api = await startApi(t, { store, clock, discover: createDiscovery(client), findAlternatives: createAlternativeDiscovery(client) });
  return { ...api, oxylabs, state };
}
const shop = { merchant: 'shop.example.com' };
const widget = { merchant: 'shop.example.com', country: 'GB', items: [{ name: 'Acme Widget', variant: '' }] };

test('the settings have safe defaults, and a wrong value stops the server with a plain sentence', () => {
  const config = readConfig({ OXYLABS_WEB_API_KEY: ' fixture-key ' });
  assert.deepEqual(
    [config.mode, config.key, config.parser, config.daily, config.monthly, config.record, config.replayFolder, config.recordFolder],
    ['live', 'fixture-key', 'ai', 150, 2000, false, REPLAY_FOLDER, join('data', 'oxylabs-recordings')],
  );
  const set = readConfig({
    OXYLABS_WEB_API_KEY: 'fixture-key', OXYLABS_MODE: 'LIVE', OXYLABS_DAILY_REQUESTS: '40', OXYLABS_MONTHLY_REQUESTS: '0',
    OXYLABS_RECORD: '1', DATABASE_PATH: '/tmp/rig/api.sqlite', OXYLABS_REPLAY_DIR: '/tmp/rig/replay',
  });
  assert.deepEqual([set.daily, set.monthly, set.record, set.recordFolder, set.replayFolder], [40, 0, true, '/tmp/rig/oxylabs-recordings', '/tmp/rig/replay']);

  assert.throws(() => readConfig({}), /Set OXYLABS_WEB_API_KEY on the coupon server, or start it with OXYLABS_MODE=replay or OXYLABS_MODE=off\./);
  assert.throws(() => readConfig({ OXYLABS_MODE: 'record' }), /Use live, replay or off for OXYLABS_MODE\./);
  assert.throws(() => readConfig({ OXYLABS_MODE: 'off', OXYLABS_DAILY_REQUESTS: 'plenty' }), /Use a whole number for OXYLABS_DAILY_REQUESTS\./);
  assert.throws(() => readConfig({ OXYLABS_MODE: 'off', OXYLABS_MONTHLY_REQUESTS: '-5' }), /Use a whole number for OXYLABS_MONTHLY_REQUESTS\./);
  assert.throws(() => readConfig({ OXYLABS_MODE: 'off', OXYLABS_LOCATION: 'Britain' }), /Use a two-letter OXYLABS_LOCATION\./);
});

test('in replay and off modes the key is not even read, and nothing is recorded', () => {
  for (const mode of ['replay', 'off']) {
    const config = readConfig({ OXYLABS_MODE: mode, OXYLABS_WEB_API_KEY: 'a-key-left-in-the-environment', OXYLABS_RECORD: '1' });
    assert.deepEqual([config.mode, config.key, config.record], [mode, undefined, false]);
  }
});

test('the server starts without OXYLABS_WEB_API_KEY in replay and off modes, and says which mode it is in', async (t) => {
  const folder = temporary(t, 'modes');
  for (const mode of ['replay', 'off']) {
    const { server, store, budget, config } = createFromEnv({
      OXYLABS_MODE: mode, CARTSCOUT_ALLOW_ANONYMOUS: '1', DATABASE_PATH: join(folder, `${mode}.sqlite`),
    }, { log: () => {} });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const health = await fetch(`http://127.0.0.1:${server.address().port}/health`);
      assert.deepEqual(await health.json(), { ok: true });
      assert.match(describeOxylabs(config, budget), mode === 'replay'
        ? /^Oxylabs: replay\. No request is sent\. Scans and price lookups are answered from the database and .*replay\.$/
        : /^Oxylabs: off\. No request is sent\. Saved results still open\.$/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      store.close();
    }
  }
  assert.throws(() => createFromEnv({ CARTSCOUT_ALLOW_ANONYMOUS: '1', DATABASE_PATH: join(folder, 'live.sqlite') }), /Set OXYLABS_WEB_API_KEY/);
});

test('started as its own process with no key, the API answers in replay mode and refuses to start live', async (t) => {
  const folder = temporary(t, 'process');
  // The child gets exactly this environment, so no key from the machine can reach it.
  const environment = (extra) => ({ PATH: process.env.PATH, CARTSCOUT_ALLOW_ANONYMOUS: '1', PORT: '0', DATABASE_PATH: join(folder, 'api.sqlite'), ...extra });

  const replay = spawn(process.execPath, [SERVER], { env: environment({ OXYLABS_MODE: 'replay' }), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => replay.kill());
  let output = '';
  replay.stdout.on('data', (chunk) => { output += chunk; });
  while (!/Oxylabs: replay\./.test(output)) {
    if (replay.exitCode !== null) assert.fail(`The API stopped: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const port = /listening on 127\.0\.0\.1:(\d+)/.exec(output)[1];
  const answer = await fetch(`http://127.0.0.1:${port}/v1/alternatives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${'a'.repeat(64)}` },
    body: JSON.stringify({ merchant: 'myprotein.com', country: 'GB', items: [{ name: 'Myprotein Impact Whey Protein Powder', variant: 'Vanilla, 30 servings / 900g' }] }),
  });
  assert.equal(answer.status, 200);
  assert.deepEqual((await answer.json()).results[0].offers.map(({ price }) => price), [33.14, 31.99, 35.47]);
  replay.kill();
  await once(replay, 'exit');

  const live = spawn(process.execPath, [SERVER], { env: environment({}), stdio: ['ignore', 'pipe', 'pipe'] });
  let complaint = '';
  live.stderr.on('data', (chunk) => { complaint += chunk; });
  const [code] = await once(live, 'exit');
  assert.notEqual(code, 0);
  assert.match(complaint, /Set OXYLABS_WEB_API_KEY on the coupon server, or start it with OXYLABS_MODE=replay or OXYLABS_MODE=off\./);
});

test('replay answers a scan from the most recent saved scan of that shop by anyone, whatever its age', async (t) => {
  const folder = temporary(t, 'replay');
  const path = join(folder, 'api.sqlite');
  const clock = { now: Date.parse('2026-11-20T09:00:00Z') };
  const day = await liveDay(t, openStore(path), clock);
  await day.call('coupons', 'free-a', shop);
  // A day and a bit later a different member scans the same shop live, and finds a different code.
  clock.now += 25 * HOUR;
  day.state.code = 'SECOND20';
  const latest = clock.now;
  assert.deepEqual((await day.call('coupons', 'free-b', shop)).body.coupons.map(({ code }) => code), ['SECOND20']);
  await day.close();
  day.store.close();

  // Five days on, in replay. There is no Oxylabs to call: any attempt would fail the test.
  clock.now += 5 * 24 * HOUR;
  const asked = [];
  const refuse = async (...given) => {
    asked.push(given);
    throw new Error('Replay must never look anything up.');
  };
  const { call } = await startApi(t, {
    store: openStore(path), clock, mode: 'replay', replay: openReplayFolder(join(folder, 'no-files-here')),
    discover: refuse, findAlternatives: refuse,
  });

  const pro = await call('coupons', 'pro-c', shop);
  assert.equal(pro.status, 200);
  assert.deepEqual([pro.body.source, pro.body.reused, pro.body.fetchedAt], ['live', true, when(latest)]);
  assert.deepEqual(pro.body.coupons.map(({ code }) => code), ['SECOND20']);
  // Replay treats it as a scan made now: it is saved, fresh for its lifetime, and a Free scan counts as usual.
  assert.equal((await call('coupons', 'pro-d', shop)).body.source, 'cache');
  const free = await call('coupons', 'free-a', shop);
  assert.deepEqual([free.body.source, free.body.reused, free.body.fetchedAt, free.body.account.scans.remaining], ['live', true, when(latest), 4]);
  assert.equal((await call('coupons', 'free-a', { ...shop, cacheOnly: true })).body.source, 'cache');

  // A shop nobody saved takes the same path as a shop that could not be read, and costs a Free member nothing.
  const missing = await call('coupons', 'free-a', { merchant: 'never-scanned.example.com' });
  assert.equal(missing.status, 502);
  assert.equal(missing.body.error, 'Coupon search is temporarily unavailable. Try again shortly.');
  assert.equal((await call('account', 'free-a')).body.scans.remaining, 4);
  assert.deepEqual(asked, []);
});

test('replay answers from the files in the replay folder when the database has nothing', async (t) => {
  const folder = temporary(t, 'replay-files');
  writeFileSync(join(folder, 'scan-filed.json'), JSON.stringify({
    merchant: 'www.Filed.example.com',
    fetchedAt: '2026-11-01T10:00:00.000Z',
    coupons: [
      { code: 'filed15', offer: '  15% off   everything ', sources: ['https://filed.example.com/offers', 'javascript:alert(1)'], expiresOn: null },
      { code: 'not a code', offer: 'dropped' },
    ],
  }));
  writeFileSync(join(folder, 'scan-partial.json'), JSON.stringify({ merchant: 'patchy.example.com', partial: true, coupons: [] }));
  writeFileSync(join(folder, 'lookup-for-one-shop.json'), JSON.stringify({
    merchant: 'shop.example.com', country: 'GB', fetchedAt: '2026-11-02T10:00:00.000Z',
    results: [{ name: 'Acme Widget', variant: 'Blue', partial: false, offers: [
      { title: 'Acme Widget Blue', variant: 'Blue', match: 'exact', url: 'https://www.retailer1.example.com/p/widget', price: 8.75, currency: 'GBP', stockText: 'In stock', availability: 'in_stock' },
      { title: 'No address', match: 'exact', price: 1, currency: 'GBP' },
    ] }],
  }));
  writeFileSync(join(folder, 'broken.json'), '{ this is not json');
  const complaints = [];
  const { call } = await startApi(t, {
    mode: 'replay', replay: openReplayFolder(folder, { log: (...words) => complaints.push(words.join(' ')) }),
  });

  const filed = (await call('coupons', 'pro-c', { merchant: 'filed.example.com' })).body;
  assert.deepEqual([filed.source, filed.reused, filed.fetchedAt, filed.partial], ['live', true, '2026-11-01T10:00:00.000Z', false]);
  // What a file says is checked like anything else that comes from outside.
  assert.deepEqual(filed.coupons.map(({ code, offer, sources }) => [code, offer, sources]), [['FILED15', '15% off everything', ['https://filed.example.com/offers']]]);
  assert.equal((await call('coupons', 'pro-c', { merchant: 'patchy.example.com' })).body.partial, true);

  const ask = (merchant, name, variant = 'Blue') => call('alternatives', 'free-a', { merchant, country: 'GB', items: [{ name, variant }] });
  const lookup = (await ask('shop.example.com', 'acme  widget')).body.results[0];
  assert.deepEqual([lookup.partial, lookup.fetchedAt], [false, '2026-11-02T10:00:00.000Z']);
  assert.deepEqual(lookup.offers, [{
    title: 'Acme Widget Blue', variant: 'Blue', match: 'exact', retailer: 'retailer1.example.com',
    url: 'https://www.retailer1.example.com/p/widget', price: 8.75, currency: 'GBP', stockText: 'In stock', availability: 'in_stock',
  }]);
  // That file names its shop, so it does not answer for another one. A product nobody saved "could not be checked".
  assert.equal((await ask('other.example.com', 'Acme Widget')).status, 502);
  const mixed = await call('alternatives', 'free-a', {
    merchant: 'shop.example.com', country: 'GB', items: [{ name: 'Acme Widget', variant: 'Blue' }, { name: 'Acme Gadget', variant: '' }],
  });
  assert.equal(mixed.status, 200);
  assert.deepEqual(mixed.body.results.map(({ offers, error }) => [offers.length, error]), [[1, undefined], [0, 'This item could not be checked.']]);
  assert.ok(complaints.some((line) => line.includes('broken.json')));
});

test('the replay folder that ships with the server holds a real saved lookup', async (t) => {
  const { call } = await startApi(t, { mode: 'replay', replay: openReplayFolder(REPLAY_FOLDER) });
  const answer = await call('alternatives', 'free-a', {
    merchant: 'myprotein.com', country: 'GB',
    items: [{ name: 'Myprotein Impact Whey Protein Powder', variant: 'Vanilla, 30 servings / 900g' }],
  });
  assert.equal(answer.status, 200);
  const [result] = answer.body.results;
  assert.equal(result.partial, true);
  assert.deepEqual(result.offers.map(({ retailer, price, match, availability }) => [retailer, price, match, availability]), [
    ['amazon.co.uk', 33.14, 'exact', 'in_stock'],
    ['proteindeals.co.uk', 31.99, 'exact', 'unknown'],
    ['ypc.co.uk', 35.47, 'exact', 'unknown'],
  ]);
});

test('replay answers a price lookup from the database however old it is', async (t) => {
  const folder = temporary(t, 'replay-lookup');
  const path = join(folder, 'api.sqlite');
  const clock = { now: Date.parse('2026-11-20T09:00:00Z') };
  const day = await liveDay(t, openStore(path), clock);
  const read = clock.now;
  assert.equal((await day.call('alternatives', 'free-a', widget)).body.results[0].offers.length, 1);
  await day.close();
  day.store.close();

  clock.now += 9 * 24 * HOUR;
  const { call } = await startApi(t, { store: openStore(path), clock, mode: 'replay', replay: openReplayFolder(join(folder, 'none')) });
  const [result] = (await call('alternatives', 'pro-c', widget)).body.results;
  assert.deepEqual([result.offers.map(({ price }) => price), result.fetchedAt], [[9.5], when(read)]);
});

test('off refuses live work with one clear sentence, and saved results still open', async (t) => {
  const folder = temporary(t, 'off');
  const path = join(folder, 'api.sqlite');
  const clock = { now: Date.parse('2026-11-20T09:00:00Z') };
  const day = await liveDay(t, openStore(path), clock);
  await day.call('coupons', 'pro-c', shop);
  await day.call('alternatives', 'pro-c', widget);
  await day.close();
  day.store.close();

  clock.now += HOUR;
  const { call } = await startApi(t, { store: openStore(path), clock, mode: 'off' });
  const OFF = 'Live searching is switched off on this CartScout server.';

  // What is saved still opens: the Pro list, the lookup, and a Free member's scan of a shop read an hour ago.
  assert.equal((await call('coupons', 'pro-d', shop)).body.source, 'cache');
  assert.equal((await call('alternatives', 'free-a', widget)).body.results[0].offers.length, 1);
  const reused = (await call('coupons', 'free-a', shop)).body;
  assert.deepEqual([reused.source, reused.reused, reused.account.scans.remaining], ['live', true, 4]);

  const scan = await call('coupons', 'free-a', { merchant: 'unread.example.com' });
  assert.equal(scan.status, 503);
  assert.deepEqual([scan.body.error, scan.body.code], [OFF, 'live_off']);
  assert.equal(scan.body.account.scans.remaining, 4);
  const lookup = await call('alternatives', 'free-a', { ...widget, items: [{ name: 'Acme Gadget', variant: '' }] });
  assert.equal(lookup.status, 503);
  assert.deepEqual([lookup.body.error, lookup.body.code], [OFF, 'live_off']);

  // Past its lifetime a saved result is still the answer, marked as old, because nothing newer can be fetched.
  clock.now += 3 * 24 * HOUR;
  assert.equal((await call('coupons', 'pro-d', shop)).body.source, 'stale');
  assert.equal((await call('alternatives', 'free-a', widget)).body.results[0].stale, true);
});

test('with recording on, each raw Oxylabs answer is saved as a file, capped in size and in number, without the key', async (t) => {
  const folder = join(temporary(t, 'record'), 'answers');
  const complaints = [];
  const record = createRecorder(folder, { maxBody: 400, maxFiles: 3, log: (...words) => complaints.push(words.join(' ')) });
  const long = 'x'.repeat(2_000);
  const oxylabs = fakeOxylabs(async ({ endpoint, url }) => {
    if (endpoint === 'search') return [{ title: 'Shop', url: 'https://shop.example.com/offers' }];
    if (url.includes('big')) return page({ markdown: long });
    if (url.includes('down')) return new Response('upstream failed', { status: 500 });
    return page({ markdown: 'Use code: SAVE10' });
  });
  const now = Date.parse('2026-11-26T10:00:00Z');
  const call = createOxylabsClient({ key: 'secret-fixture-key', request: oxylabs.request, record, now: () => now });
  const ticket = localTicket('scan', 6);
  await call('search', { query: 'shop.example.com coupon codes', max_results: 10 }, 'GB', { ticket, shop: 'shop.example.com' });
  await call('scrape', { url: 'https://shop.example.com/big', output: ['markdown'] }, 'GB', { ticket });
  await assert.rejects(call('scrape', { url: 'https://shop.example.com/down', output: ['markdown'] }, 'GB', { ticket }));
  await call('scrape', { url: 'https://shop.example.com/offers', output: ['markdown'] }, 'GB', { ticket });

  const files = readdirSync(folder).sort();
  assert.deepEqual(files.map((name) => name.replace(/^2026-11-26T10-00-00-000Z-/, '')), [
    '0001-search-search.json', '0002-scrape-shop.example.com.json', '0003-scrape-shop.example.com.json',
  ]);
  const [search, big, down] = files.map((name) => JSON.parse(readFileSync(join(folder, name), 'utf8')));
  // A whole answer is kept as the JSON it was, ready to be used as a fixture, with the request that asked for it.
  assert.deepEqual(search.request, { query: 'shop.example.com coupon codes', max_results: 10, location: 'GB' });
  assert.deepEqual([search.endpoint, search.status, search.truncated, search.body.state, search.body.results[0].url],
    ['search', 200, false, 'done', 'https://shop.example.com/offers']);
  // An answer over the cap is cut and marked, so it cannot pass for a whole page.
  assert.deepEqual([big.truncated, typeof big.body, big.body.length, big.characters > 2_000], [true, 'string', 400, true]);
  assert.deepEqual([down.status, down.body], [500, 'upstream failed']);
  // The fourth answer came after the folder was full: recording stopped, and said so once.
  assert.equal(complaints.length, 1);
  assert.match(complaints[0], /Oxylabs recording has stopped/);
  for (const name of files) assert.equal(readFileSync(join(folder, name), 'utf8').includes('secret-fixture-key'), false);
});
