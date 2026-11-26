import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { lastDayStillRunning, openStore } from './store.js';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const coupon = (code, expiresOn = null) => ({ code, offer: '', sources: [], expiresOn });

test('codes saved in lower case before 1.1 are folded into the upper-case code, thumbs included', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'cartscout-store-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'old.sqlite');

  // An older database: "more" was saved as the shop wrote it, and three members rated it.
  openStore(path).close();
  const old = new DatabaseSync(path);
  // The columns are named because the tables have gained columns since ("seeded", "reused"), which older rows lack.
  const addCoupon = old.prepare(`
    INSERT INTO coupons (merchant, code, offer, sources, expires_on, seen_at, discovery_version) VALUES (?, ?, ?, ?, ?, ?, 2)
  `);
  const addReport = old.prepare('INSERT INTO reports (merchant, code, reporter, worked, reported_at) VALUES (?, ?, ?, ?, ?)');
  old.prepare('INSERT INTO searches (merchant, refreshed_at, retry_at, partial, discovery_version) VALUES (?, ?, ?, 0, 2)')
    .run('shop.example.com', NOW, NOW + 86_400_000);
  addCoupon.run('shop.example.com', 'more', 'Older offer', '[]', null, NOW - 86_400_000);
  addCoupon.run('shop.example.com', 'MORE', 'Newer offer', '[]', null, NOW);
  addCoupon.run('shop.example.com', 'Welcome5', '5% off', '[]', null, NOW);
  addReport.run('shop.example.com', 'more', 'alex', 1, NOW - 3_000);
  addReport.run('shop.example.com', 'more', 'bailey', 1, NOW - 2_000);
  // Casey rated both spellings; the later answer is the one that counts.
  addReport.run('shop.example.com', 'more', 'casey', 1, NOW - 5_000);
  addReport.run('shop.example.com', 'MORE', 'casey', 0, NOW - 1_000);
  addReport.run('shop.example.com', 'Welcome5', 'alex', 0, NOW - 1_000);
  old.close();

  const store = openStore(path);
  t.after(() => store.close());
  const listing = store.listing('shop.example.com', 'casey', NOW);
  assert.deepEqual(listing.map(({ code, offer, worked, failed, myReport }) => ({ code, offer, worked, failed, myReport })), [
    { code: 'MORE', offer: 'Newer offer', worked: 2, failed: 1, myReport: 0 },
    { code: 'WELCOME5', offer: '5% off', worked: 0, failed: 1, myReport: null },
  ]);

  // From here on there is one spelling: a rating or a rescan in any case lands on the same code.
  assert.equal(store.report('shop.example.com', 'more', 'casey', true, NOW), true);
  store.save('shop.example.com', { complete: true, coupons: [coupon('welcome5')] }, NOW);
  const after = store.listing('shop.example.com', 'casey', NOW);
  assert.deepEqual(after.map(({ code, worked, failed }) => [code, worked, failed]), [['MORE', 3, 0], ['WELCOME5', 0, 1]]);
});

test('a code runs until its last day is over for every shopper, not until midnight in London', (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  store.save('shop.example.com', { complete: true, coupons: [coupon('TODAY', '2026-11-25'), coupon('OPEN')] }, NOW);
  const codesAt = (time) => store.listing('shop.example.com', 'alex', time).map(({ code }) => code).sort();

  // 00:30 UTC on the 26th is still the afternoon of the 25th in Los Angeles.
  const earlyNextDay = Date.parse('2026-11-26T00:30:00Z');
  assert.deepEqual(codesAt(earlyNextDay), ['OPEN', 'TODAY']);
  assert.equal(store.report('shop.example.com', 'TODAY', 'alex', true, earlyNextDay), true);

  const noonNextDay = Date.parse('2026-11-26T12:00:00Z');
  assert.deepEqual(codesAt(noonNextDay), ['OPEN']);
  assert.equal(store.report('shop.example.com', 'TODAY', 'alex', true, noonNextDay), false);
  assert.equal(lastDayStillRunning(noonNextDay), '2026-11-26');
});
