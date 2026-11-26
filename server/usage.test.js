// "npm run usage": the ledger against the budgets, then Oxylabs' own count of billable results by day. The
// statistics endpoint is stubbed here. No test asks Oxylabs anything.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { openStore } from './store.js';
import { fetchOxylabsDays, readStatsDays, STATS_URL, usageReport } from './usage.js';

const USAGE = fileURLToPath(new URL('../scripts/usage.js', import.meta.url));
const NOW = Date.parse('2026-11-26T15:30:00Z');
const KEY = 'fixture-key-that-must-never-be-printed';

// A source as the statistics endpoint lists it. The documentation shows these fields, as strings, for one source.
const source = (title, results) => ({
  results_count_all: String(results), results_count: '0', realtime_results_count: String(results), super_api_results_count: '0',
  render: '0', geo_location: '0', average_response_time: 6.1, request_traffic: '1200', response_traffic: '480000', title,
});
const byDay = {
  meta: { group_by: 'day', date_from: null, date_to: null, source: null },
  data: [
    { date: '2026-11-26', sources: [source('universal', 9), source('search', 5)] },
    { date: '2026-11-25', sources: [source('universal', 645), source('search', 233), source('universal_ai', 45)] },
  ],
};

// A database with a ledger: yesterday's requests, and today's eleven for scans and five for one price lookup.
function ledgerAt(path) {
  const store = openStore(path);
  const send = (time, operation, kind, { host = 'shop.example.com', ai = false, ok = true } = {}) => {
    const { ticket } = store.ledger.reserve({ operation, requests: 1, now: time, daily: 10_000, monthly: 100_000 });
    ticket.use({ kind, host, ai, at: time })(ok, 900);
    ticket.release();
  };
  for (let sent = 0; sent < 40; sent += 1) send(Date.parse('2026-11-25T20:00:00Z'), 'scan', 'read', { ai: true });
  send(NOW - 3_600_000, 'scan', 'search');
  for (let sent = 0; sent < 8; sent += 1) send(NOW - 3_600_000, 'scan', 'read', { ai: true, ok: sent !== 0 });
  for (let sent = 0; sent < 2; sent += 1) send(NOW - 3_600_000, 'scan', 'read_js', { host: 'slow.example.org' });
  send(NOW - 60_000, 'lookup', 'search');
  for (let sent = 0; sent < 4; sent += 1) send(NOW - 60_000, 'lookup', 'read', { host: `retailer${sent}.example.com`, ai: true });
  // A scan that is running right now holds four more.
  store.ledger.reserve({ operation: 'scan', requests: 4, now: NOW - 1_000, daily: 10_000, monthly: 100_000 });
  store.close();
}

test('the report shows the ledger against both budgets and Oxylabs’ own count, and where the balance is', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'cartscout-usage-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'api.sqlite');
  ledgerAt(path);
  const changed = statSync(path).mtimeMs;

  const asked = [];
  const report = await usageReport({
    databasePath: path, daily: 150, monthly: 2000, key: KEY, now: NOW,
    request: async (url, options) => {
      asked.push({ url, method: options.method ?? 'GET', authorization: options.headers.Authorization });
      return Response.json(byDay);
    },
  });
  // One free GET to the statistics endpoint, with the key as a Bearer token.
  assert.deepEqual(asked, [{ url: 'https://data.oxylabs.io/v1/stats?group_by=day', method: 'GET', authorization: `Bearer ${KEY}` }]);
  assert.equal(STATS_URL, 'https://data.oxylabs.io/v1/stats?group_by=day');
  assert.equal(report, [
    'CartScout: requests sent to Oxylabs, counted in UTC',
    '',
    'Today, 26 November 2026',
    '  16 of 150 requests used, 130 left. Starts again 27 November at 00:00 UTC.',
    '  4 more are held for scans or price lookups that are running now.',
    '  For scans 11, for price lookups 5.',
    '  Searches 2, page reads 12, pages read again with JavaScript 2.',
    '  With AI parsing 12. Failed 1.',
    '',
    'This month, November 2026',
    '  56 of 2,000 requests used, 1,940 left. Starts again 1 December at 00:00 UTC.',
    '  4 more are held for scans or price lookups that are running now.',
    '  For scans 51, for price lookups 5.',
    '  Searches 2, page reads 52, pages read again with JavaScript 2.',
    '  With AI parsing 52. Failed 1.',
    '  Asked for most this month: shop.example.com 50, slow.example.org 2, retailer0.example.com 1, retailer1.example.com 1, retailer2.example.com 1, retailer3.example.com 1.',
    '',
    'Oxylabs’ own count of billable results, by day',
    '  2026-11-25  923   universal 645, search 233, universal_ai 45',
    '  2026-11-26   14   universal 9, search 5',
    '',
    'The remaining balance is only shown at dashboard.oxylabs.io.',
  ].join('\n'));
  assert.equal(report.includes(KEY), false);
  // Looking changes nothing: the database is opened read-only.
  assert.equal(statSync(path).mtimeMs, changed);
});

test('without a key, or when asked to stay local, Oxylabs is not asked and the report says why', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'cartscout-usage-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  // No server has ever run here. The report is all zeros, and no database appears because someone looked.
  const path = join(folder, 'never-started.sqlite');
  const never = async () => assert.fail('Oxylabs must not be asked.');

  const noKey = await usageReport({ databasePath: path, daily: 150, monthly: 2000, key: undefined, now: NOW, request: never });
  assert.match(noKey, /Today, 26 November 2026\n {2}0 of 150 requests used, 150 left\. Starts again 27 November at 00:00 UTC\.\n\nThis month/);
  assert.match(noKey, /Oxylabs’ own count of billable results, by day\n {2}Not asked: OXYLABS_WEB_API_KEY is not set\.\n/);
  assert.match(noKey, /\nThe remaining balance is only shown at dashboard\.oxylabs\.io\.$/);
  const local = await usageReport({ databasePath: path, daily: 150, monthly: 2000, key: KEY, now: NOW, remote: false, request: never });
  assert.match(local, /Not asked: this run was asked to stay local\./);
  assert.equal(existsSync(path), false);
});

test('when Oxylabs cannot answer, the report still shows the ledger and says what went wrong', async () => {
  const report = (request) => usageReport({ databasePath: ':memory:', daily: 150, monthly: 2000, key: KEY, now: NOW, request });
  assert.match(await report(async () => new Response('', { status: 401 })), /Not available: Oxylabs answered HTTP 401\./);
  assert.match(await report(async () => { throw new TypeError('fetch failed'); }), /Not available: Oxylabs could not be reached \(network error\)\./);
  assert.match(await report(async () => new Response('<html>', { status: 200 })), /Not available: Oxylabs answered with something that is not JSON\./);
  const unknown = await report(async () => Response.json({ data: { sources: [source('universal', 7)] } }));
  assert.match(unknown, /Not available: Oxylabs answered in a form this command does not know yet\. It began: \{"data":\{"sources"/);
  assert.match(await report(async () => Response.json({ meta: {}, data: [] })), /Oxylabs has counted no results for this key\./);
  for (const text of [unknown]) assert.equal(text.includes(KEY), false);
});

test('Oxylabs’ answer is read as a list of days or as an object keyed by day', async () => {
  const expected = [
    { day: '2026-11-25', results: 923, sources: [{ title: 'universal', results: 645 }, { title: 'search', results: 233 }, { title: 'universal_ai', results: 45 }] },
    { day: '2026-11-26', results: 14, sources: [{ title: 'universal', results: 9 }, { title: 'search', results: 5 }] },
  ];
  assert.deepEqual(readStatsDays(byDay), expected);
  const keyed = { data: Object.fromEntries(byDay.data.map(({ date, sources }) => [date, { sources }])) };
  assert.deepEqual(readStatsDays(keyed), expected);
  assert.deepEqual(readStatsDays({ data: Object.fromEntries(byDay.data.map(({ date, sources }) => [`${date} 00:00:00`, sources])) }), expected);
  // The ungrouped answer the documentation shows has no days in it, and anything else is not guessed at.
  assert.equal(readStatsDays({ data: { sources: [source('universal', 7)] } }), null);
  assert.equal(readStatsDays({ data: [{ target: 'shop.example.com', sources: [] }] }), null);
  assert.equal(readStatsDays({}), null);

  // More than two weeks of days: the last fourteen are shown, and the report says so.
  const month = { data: Array.from({ length: 20 }, (_, index) => ({ date: `2026-11-${String(index + 1).padStart(2, '0')}`, sources: [source('universal', index + 1)] })) };
  const { days } = await fetchOxylabsDays({ key: KEY, request: async () => Response.json(month) });
  assert.equal(days.length, 20);
  const report = await usageReport({ databasePath: ':memory:', daily: 150, monthly: 2000, key: KEY, now: NOW, request: async () => Response.json(month) });
  assert.match(report, /The last 14 of 20 days\.\n {2}2026-11-07 {3}7 {3}universal 7\n/);
  assert.equal(report.includes('2026-11-06'), false);
});

test('the command prints the ledger from DATABASE_PATH and stays local when asked', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'cartscout-usage-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  // The child gets exactly this environment: no key, so it could not ask Oxylabs even without --local.
  const run = (args, env = {}) => spawnSync(process.execPath, [USAGE, ...args], {
    cwd: folder, env: { PATH: process.env.PATH, DATABASE_PATH: join(folder, 'api.sqlite'), ...env }, encoding: 'utf8',
  });
  const local = run(['--local'], { OXYLABS_DAILY_REQUESTS: '40', OXYLABS_MONTHLY_REQUESTS: '900' });
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /0 of 40 requests used, 40 left\./);
  assert.match(local.stdout, /0 of 900 requests used, 900 left\./);
  assert.match(local.stdout, /Not asked: this run was asked to stay local\./);
  assert.match(local.stdout, /The remaining balance is only shown at dashboard\.oxylabs\.io\.\n$/);

  assert.match(run([]).stdout, /Not asked: OXYLABS_WEB_API_KEY is not set\./);
  const wrong = run(['--local'], { OXYLABS_DAILY_REQUESTS: 'lots' });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /Use a whole number for OXYLABS_DAILY_REQUESTS\./);
});
