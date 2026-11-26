import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { budgetMessage, createBudget } from './budget.js';
import { fakeOxylabs, page } from './fixtures/kit.js';
import { createOxylabsClient } from './oxylabs.js';
import { openStore } from './store.js';

const at = (time) => Date.parse(time);

// One request through a one-request hold, for tests that only need rows in the ledger.
function send(ledger, time, operation = 'scan') {
  const { ticket } = ledger.reserve({ operation, requests: 1, now: time, daily: 1_000, monthly: 10_000 });
  ticket.use({ kind: 'read', host: 'shop.example.com', at: time })(true, 10);
  ticket.release();
}

test('every request sent to Oxylabs is written to the ledger: when, for what, which kind, which host and how it ended', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'cartscout-ledger-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = openStore(join(folder, 'ledger.sqlite'));
  t.after(() => store.close());
  const start = at('2026-11-26T10:00:00Z');
  let time = start;
  const oxylabs = fakeOxylabs(async ({ endpoint, url }) => {
    time += 1_500;
    if (endpoint === 'search') return [];
    if (url.includes('blocked')) return new Response('', { status: 500 });
    return page({ markdown: 'Nothing on offer today.' });
  });
  const call = createOxylabsClient({ key: 'fixture-key', request: oxylabs.request, now: () => time });
  const { ticket } = store.ledger.reserve({ operation: 'scan', requests: 6, now: time, daily: 150, monthly: 2000 });

  await call('search', { query: 'shop.example.com coupon codes', max_results: 10 }, 'GB', { ticket, shop: 'shop.example.com' });
  await call('scrape', { url: 'https://www.shop.example.com/offers', output: ['markdown', 'json'], json: { prompt: 'codes' } }, 'GB', { ticket });
  await call('scrape', { url: 'https://shop.example.com/', output: ['markdown'], run_js: true }, 'GB', { ticket });
  await assert.rejects(call('scrape', { url: 'https://blocked.example.org/codes', output: ['markdown'] }, 'GB', { ticket }), /HTTP 500/);
  ticket.release();

  const reader = new DatabaseSync(join(folder, 'ledger.sqlite'), { readOnly: true });
  const rows = reader.prepare('SELECT at, operation, kind, host, ai, ok, ms FROM oxylabs_requests ORDER BY id').all();
  reader.close();
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    // A search has no address of its own, so it is filed under the shop it was made for.
    { at: start, operation: 'scan', kind: 'search', host: 'shop.example.com', ai: 0, ok: 1, ms: 1_500 },
    { at: start + 1_500, operation: 'scan', kind: 'read', host: 'shop.example.com', ai: 1, ok: 1, ms: 1_500 },
    { at: start + 3_000, operation: 'scan', kind: 'read_js', host: 'shop.example.com', ai: 0, ok: 1, ms: 1_500 },
    { at: start + 4_500, operation: 'scan', kind: 'read', host: 'blocked.example.org', ai: 0, ok: 0, ms: 1_500 },
  ]);

  const { day, month, held, hosts } = store.ledger.totals(time);
  for (const period of [day, month]) {
    assert.deepEqual(
      [period.requests, period.answered, period.failed, period.unanswered, period.searches, period.reads, period.rendered, period.ai, period.forScans, period.forLookups],
      [4, 3, 1, 0, 1, 2, 1, 1, 4, 0],
    );
  }
  assert.equal(held, 0);
  assert.deepEqual(hosts.map((row) => ({ ...row })), [{ host: 'shop.example.com', requests: 3 }, { host: 'blocked.example.org', requests: 1 }]);
  // The key goes in the header of every request and nowhere else.
  assert.ok(oxylabs.sent.every((request) => request.authorization === 'Bearer fixture-key'));
});

test('totals are kept for the UTC day and the UTC month, because Oxylabs bills by the UTC day', (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  send(store.ledger, at('2026-10-31T23:59:59Z'));
  send(store.ledger, at('2026-11-01T00:00:00Z'));
  // Already the 26th in Dubai, still the 25th in UTC.
  send(store.ledger, at('2026-11-25T23:59:59Z'));
  send(store.ledger, at('2026-11-26T00:00:00Z'));
  send(store.ledger, at('2026-11-26T18:30:00Z'), 'lookup');

  const { day, month } = store.ledger.totals(at('2026-11-26T20:00:00Z'));
  assert.deepEqual([day.requests, day.forScans, day.forLookups], [2, 1, 1]);
  assert.deepEqual([day.from, day.to], [at('2026-11-26T00:00:00Z'), at('2026-11-27T00:00:00Z')]);
  assert.equal(month.requests, 4);
  assert.deepEqual([month.from, month.to], [at('2026-11-01T00:00:00Z'), at('2026-12-01T00:00:00Z')]);

  // The next UTC day starts from nothing; December starts a new month.
  assert.equal(store.ledger.totals(at('2026-11-27T00:00:01Z')).day.requests, 0);
  assert.equal(store.ledger.totals(at('2026-12-01T00:00:01Z')).month.requests, 0);
  assert.equal(store.ledger.totals(at('2026-12-31T23:59:59Z')).month.to, at('2027-01-01T00:00:00Z'));
});

test('an operation holds its worst case before it starts, and is refused when the budget cannot cover it', (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const budget = createBudget({ ledger: store.ledger, daily: 10, monthly: 100 });
  const now = at('2026-11-26T10:00:00Z');

  const scan = budget.reserve('scan', 6, now);
  assert.ok(scan.ticket);
  // Six are held although nothing has been sent yet: a second scan does not fit, a four-request retry does.
  assert.deepEqual(budget.reserve('scan', 6, now).refused, { scope: 'day', resetAt: at('2026-11-27T00:00:00Z') });
  const retry = budget.reserve('lookup', 4, now);
  assert.ok(retry.ticket);
  assert.deepEqual(budget.status(now).day, { limit: 10, used: 0, held: 10, left: 0, resetAt: at('2026-11-27T00:00:00Z') });

  // The scan sent three of its six. Handing the rest back makes room again.
  for (let sent = 0; sent < 3; sent += 1) scan.ticket.use({ kind: 'read', host: 'shop.example.com', at: now })(true, 5);
  assert.deepEqual(budget.status(now).day, { limit: 10, used: 3, held: 7, left: 0, resetAt: at('2026-11-27T00:00:00Z') });
  scan.ticket.release();
  retry.ticket.release();
  assert.deepEqual(budget.status(now).day, { limit: 10, used: 3, held: 0, left: 7, resetAt: at('2026-11-27T00:00:00Z') });

  const second = budget.reserve('scan', 6, now);
  assert.ok(second.ticket);
  for (let sent = 0; sent < 6; sent += 1) second.ticket.use({ kind: 'read', host: 'shop.example.com', at: now })(true, 5);
  second.ticket.release();
  // Nine of ten are gone. Not even a full lookup fits, and nothing is sent to find that out.
  assert.equal(budget.reserve('lookup', 5, now).refused.scope, 'day');
  assert.equal(budget.status(now).day.used, 9);

  // Tomorrow, in UTC, the day's budget is whole again.
  assert.ok(budget.reserve('scan', 6, at('2026-11-27T00:00:00Z')).ticket);
});

test('a hold that is never handed back stops counting after five minutes', (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const budget = createBudget({ ledger: store.ledger, daily: 10, monthly: 100 });
  const now = at('2026-11-26T10:00:00Z');
  const abandoned = budget.reserve('scan', 6, now).ticket;

  assert.ok(budget.reserve('scan', 6, now + 4 * 60_000).refused);
  assert.ok(budget.reserve('scan', 6, now + 5 * 60_000 + 1).ticket);
  // And a hold that has run out can no longer send anything.
  assert.throws(() => abandoned.use({ kind: 'read', host: 'shop.example.com', at: now + 5 * 60_000 + 1 }), /used every request it reserved/);
});

test('the month is checked before the day, so nobody is told "tomorrow" when the month is used up', (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const budget = createBudget({ ledger: store.ledger, daily: 4, monthly: 6 });
  for (const day of ['2026-11-24', '2026-11-25']) {
    for (let sent = 0; sent < 2; sent += 1) send(store.ledger, at(`${day}T09:00:00Z`));
  }
  const now = at('2026-11-26T09:00:00Z');
  // Four of six gone this month, none today: three requests fit neither budget, and the month is the one named.
  assert.deepEqual(budget.reserve('lookup', 3, now).refused, { scope: 'month', resetAt: at('2026-12-01T00:00:00Z') });
  assert.ok(budget.reserve('lookup', 2, now).ticket);
  assert.ok(budget.reserve('scan', 6, at('2026-12-01T00:00:00Z')).refused, 'six requests never fit a day of four');
  assert.equal(budget.reserve('scan', 6, at('2026-12-01T00:00:00Z')).refused.scope, 'day');
});

test('nothing can be sent without a ticket, or beyond what the ticket reserved', async (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const now = at('2026-11-26T10:00:00Z');
  const oxylabs = fakeOxylabs(async () => page({ markdown: 'A page.' }));
  const call = createOxylabsClient({ key: 'fixture-key', request: oxylabs.request, now: () => now });

  await assert.rejects(call('scrape', { url: 'https://shop.example.com/', output: ['markdown'] }, 'GB'), /needs a ticket/);
  const { ticket } = store.ledger.reserve({ operation: 'lookup', requests: 2, now, daily: 150, monthly: 2000 });
  await call('scrape', { url: 'https://one.example.com/p/1', output: ['markdown'] }, 'GB', { ticket });
  await call('scrape', { url: 'https://two.example.com/p/1', output: ['markdown'] }, 'GB', { ticket });
  await assert.rejects(call('scrape', { url: 'https://three.example.com/p/1', output: ['markdown'] }, 'GB', { ticket }), /used every request it reserved/);

  // The refused request never left, and the ledger holds exactly the two that did.
  assert.deepEqual(oxylabs.sent.map(({ url }) => url), ['https://one.example.com/p/1', 'https://two.example.com/p/1']);
  assert.equal(store.ledger.totals(now).day.requests, 2);
});

test('the sentence a member reads says what still opens and when live searching is back', () => {
  const tomorrow = { scope: 'day', resetAt: at('2026-11-27T00:00:00Z') };
  const december = { scope: 'month', resetAt: at('2026-12-01T00:00:00Z') };
  assert.equal(budgetMessage('scan', tomorrow), 'Scout has done all of today’s live searching. Saved codes still open, and scanning is back tomorrow.');
  assert.equal(budgetMessage('scan', december), 'Scout has done all of this month’s live searching. Saved codes still open, and scanning is back on 1 December.');
  assert.equal(budgetMessage('lookup', tomorrow), 'Scout has done all of today’s live searching. Saved prices still open, and price checks are back tomorrow.');
  assert.equal(budgetMessage('lookup', december), 'Scout has done all of this month’s live searching. Saved prices still open, and price checks are back on 1 December.');
});
