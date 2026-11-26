// "npm run seed:scan -- <shop> CODE[=offer text] ...": codes for a shop without a scan, for rigs and local development.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { HOUR, startApi } from './fixtures/kit.js';
import { openStore } from './store.js';

const SEED = fileURLToPath(new URL('../scripts/seed-scan.js', import.meta.url));

function workspace(t) {
  const folder = mkdtempSync(join(tmpdir(), 'cartscout-seed-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  // The tool runs with this environment only, in a folder of its own, so it cannot find a real .env or database.
  const seed = (args, env = {}) => spawnSync(process.execPath, [SEED, ...args], { cwd: folder, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  return { folder, seed };
}

test('seeded codes go into the database marked as seeded, and a scan of that shop is answered from them', async (t) => {
  const { folder, seed } = workspace(t);
  const path = join(folder, 'rig.sqlite');
  const run = seed(['--db', path, 'www.Shop.Example.com', 'save10=10% off   everything', 'FREEDEL']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), `Seeded 2 codes for shop.example.com in ${path}: SAVE10, FREEDEL. Marked as seeded.`);

  const raw = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual({ ...raw.prepare('SELECT merchant, complete, seeded FROM shop_scans').get() }, { merchant: 'shop.example.com', complete: 1, seeded: 1 });
  assert.deepEqual({ ...raw.prepare('SELECT merchant, partial, seeded, reused FROM searches').get() }, { merchant: 'shop.example.com', partial: 0, seeded: 1, reused: 0 });
  assert.deepEqual(raw.prepare('SELECT code, offer, sources, seeded FROM coupons ORDER BY code').all().map((row) => ({ ...row })), [
    { code: 'FREEDEL', offer: '', sources: '[]', seeded: 1 },
    { code: 'SAVE10', offer: '10% off everything', sources: '[]', seeded: 1 },
  ]);
  assert.equal(raw.prepare('SELECT COUNT(*) AS sent FROM oxylabs_requests').get().sent, 0);
  raw.close();

  // The API on that database, with an Oxylabs that would find something else if it were ever asked.
  const scans = [];
  const clock = { now: Date.now() + HOUR };
  const { call } = await startApi(t, {
    store: openStore(path), clock,
    discover: async (merchant) => {
      scans.push(merchant);
      return { complete: true, coupons: [{ code: 'FOUND5', offer: 'Really found', sources: ['https://shop.example.com/'], expiresOn: null }] };
    },
  });
  const shop = { merchant: 'shop.example.com' };
  // A Pro member sees the seeded codes at once. A Free member's scan is answered from them and counts as a scan.
  const pro = (await call('coupons', 'pro-c', { ...shop, cacheOnly: true })).body;
  assert.deepEqual([pro.source, pro.seeded, pro.coupons.map(({ code }) => code).sort()], ['cache', true, ['FREEDEL', 'SAVE10']]);
  const free = (await call('coupons', 'free-a', shop)).body;
  assert.deepEqual([free.source, free.reused, free.seeded, free.account.scans.remaining], ['live', true, true, 4]);
  assert.deepEqual(free.coupons.map(({ code, offer, seeded }) => [code, offer, seeded]).sort(), [['FREEDEL', '', true], ['SAVE10', '10% off everything', true]]);
  assert.deepEqual(scans, []);

  // A day later the seed has aged out like any scan. The real scan that follows is not marked as seeded, and the
  // seeded codes still on the list keep their mark, so they are never mistaken for codes Scout found.
  clock.now += 25 * HOUR;
  const real = (await call('coupons', 'pro-c', shop)).body;
  assert.deepEqual(scans, ['shop.example.com']);
  assert.deepEqual([real.source, real.seeded, real.reused], ['live', undefined, undefined]);
  assert.deepEqual(real.coupons.map(({ code, seeded }) => [code, seeded]).sort(), [['FOUND5', undefined], ['FREEDEL', true], ['SAVE10', true]]);
});

test('the seed tool writes to the database the server would open', (t) => {
  const { folder, seed } = workspace(t);
  // Nothing is said: the default path, under the folder it runs in.
  assert.match(seed(['one.example.com', 'ONE1']).stdout, /in data\/cartscout\.sqlite: ONE1\. Marked as seeded\.$/m);
  assert.ok(existsSync(join(folder, 'data', 'cartscout.sqlite')));

  // A .env beside it names another database. Only that line is used; the key on the line above is of no interest.
  writeFileSync(join(folder, '.env'), 'OXYLABS_WEB_API_KEY=never-used-by-this-tool\nDATABASE_PATH=from-file.sqlite\n');
  const fromFile = seed(['two.example.com', 'TWO2']);
  assert.match(fromFile.stdout, /in from-file\.sqlite: TWO2\./);
  assert.equal(`${fromFile.stdout}${fromFile.stderr}`.includes('never-used-by-this-tool'), false);

  // DATABASE_PATH in the environment comes before the file, and --db before both.
  assert.match(seed(['three.example.com', 'THREE3'], { DATABASE_PATH: 'from-environment.sqlite' }).stdout, /in from-environment\.sqlite: THREE3\./);
  assert.match(seed(['--db', 'chosen.sqlite', 'four.example.com', 'FOUR4'], { DATABASE_PATH: 'from-environment.sqlite' }).stdout, /in chosen\.sqlite: FOUR4\./);

  // No codes at all seeds a scan that found nothing, for the "no codes" screens.
  const none = seed(['--db', 'chosen.sqlite', 'empty.example.com']);
  assert.equal(none.stdout.trim(), 'Seeded a scan with no codes for empty.example.com in chosen.sqlite. Marked as seeded.');
  const store = openStore(join(folder, 'chosen.sqlite'));
  assert.deepEqual(store.shopScan('empty.example.com').result, { coupons: [], complete: true });
  assert.equal(store.shopScan('four.example.com').seeded, true);
  store.close();
});

test('the seed tool refuses what it cannot seed and says how to call it', (t) => {
  const { folder, seed } = workspace(t);
  const refusals = [
    [[], /Name the shop to seed\./],
    [['localhost', 'CODE1'], /"localhost" is not a public shop address\. Give its hostname, like myprotein\.com\./],
    [['127.0.0.1', 'CODE1'], /is not a public shop address/],
    [['shop.example.com', 'ok10', 'a!'], /"a!" is not a coupon code\. A code is 3 to 40 letters, digits, hyphens or underscores\./],
    [['shop.example.com', '--force', 'CODE1'], /Unknown option --force\./],
    [['shop.example.com', 'CODE1', '--db'], /Name a database file after --db\./],
  ];
  for (const [args, complaint] of refusals) {
    const run = seed(args);
    assert.equal(run.status, 1, args.join(' '));
    assert.match(run.stderr, complaint);
    assert.match(run.stderr, /Usage: npm run seed:scan -- \[--db <database file>\] <shop> CODE\[=offer text\] \.\.\./);
  }
  // A refused call writes nothing, not even an empty database.
  assert.equal(existsSync(join(folder, 'data')), false);
});
