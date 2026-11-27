import assert from 'node:assert/strict';
import test from 'node:test';
import { PANEL_FILE } from '../extension/run.js';
import { createScanWatcher, scanKey, WATCH_EVERY_MS, WATCH_LIMIT_MS } from '../extension/scan-watch.js';

const inProgress = { status: 409, body: { code: 'scan_in_progress' } };
const found = (count) => ({ status: 200, body: { coupons: Array.from({ length: count }, (_, index) => ({ code: `CODE${index}` })) } });

// A stand-in for Chrome and the API. `answers` is what each cache-only lookup returns, in order; time only moves
// when the watcher waits, so the 100 second limit is exercised without waiting for it.
function harness({ answers = [], popupOpen = false, tab = { url: 'https://www.myprotein.com/basket/' }, runShowing = false, session = 'token' } = {}) {
  const world = { clock: 0, lookups: [], stored: {}, touches: 0, badges: [], injected: [], notices: [], answers: [...answers], tab, popupOpen, blocked: false };
  const watcher = createScanWatcher({
    apiOrigin: 'http://localhost:8787',
    token: async () => session,
    async fetch(url, options) {
      world.lookups.push({ at: world.clock, url: String(url), auth: options.headers.Authorization, body: JSON.parse(options.body) });
      const next = world.answers.length > 1 ? world.answers.shift() : world.answers[0];
      if (next instanceof Error) throw next;
      return { status: next.status, json: async () => next.body };
    },
    storage: {
      async set(items) { world.touches += 1; Object.assign(world.stored, structuredClone(items)); },
      async remove(key) { delete world.stored[key]; },
      async get() { return structuredClone(world.stored); },
    },
    tabs: {
      async get() {
        if (!world.tab) throw new Error('No tab with id.');
        return world.tab;
      },
      async sendMessage(tabId, message) { world.notices.push({ tabId, ...message }); },
    },
    scripting: {
      async executeScript({ target, files }) {
        if (world.blocked) throw new Error('Cannot access contents of the page.');
        assert.deepEqual(files, [PANEL_FILE]);
        world.injected.push(target.tabId);
      },
    },
    action: { async setBadgeText(badge) { world.badges.push(badge); } },
    popupOpen: async () => world.popupOpen,
    runShowing: () => runShowing,
    now: () => world.clock,
    wait: async (ms) => { world.clock += ms; },
  });
  const done = async (tabId = 7) => {
    for (let turn = 0; turn < 2000 && watcher.watching(tabId); turn += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(watcher.watching(tabId), false, 'the watch never ended');
  };
  return { world, watcher, done };
}

test('a watch ends when the scan finishes, and tells the page when the popup has gone', async () => {
  const { world, watcher, done } = harness({ answers: [inProgress, inProgress, found(3)] });
  assert.deepEqual(await watcher.watch({ tabId: 7, host: 'www.myprotein.com' }), { ok: true });
  await done();
  assert.equal(world.lookups.length, 3);
  assert.deepEqual(world.lookups.map(({ at }) => at), [WATCH_EVERY_MS, WATCH_EVERY_MS * 2, WATCH_EVERY_MS * 3]);
  assert.deepEqual(world.lookups[0], {
    at: WATCH_EVERY_MS, url: 'http://localhost:8787/v1/coupons', auth: 'Bearer token', body: { merchant: 'www.myprotein.com', cacheOnly: true },
  });
  // Storage is touched on every tick, which is what keeps the service worker awake.
  assert.ok(world.touches >= 4);
  assert.deepEqual(world.badges, [{ tabId: 7, text: '3' }]);
  assert.deepEqual(world.injected, [7]);
  assert.deepEqual(world.notices, [{ tabId: 7, type: 'cartscout:notice', notice: { host: 'myprotein.com', count: 3 } }]);
  assert.equal(world.stored[scanKey(7)], undefined);
});

test('no codes means a notice and no badge', async () => {
  const { world, watcher, done } = harness({ answers: [found(0)] });
  await watcher.watch({ tabId: 7, host: 'myprotein.com' });
  await done();
  assert.deepEqual(world.badges, []);
  assert.deepEqual(world.notices.map(({ notice }) => notice), [{ host: 'myprotein.com', count: 0 }]);
});

test('a watch ends quietly when the scan failed, the session ended or the API is out of reach', async () => {
  for (const answer of [
    { status: 409, body: { code: 'scan_required' } },
    { status: 401, body: { code: 'sign_in_required' } },
    { status: 500, body: { error: 'Coupon service error.' } },
    new Error('offline'),
    { status: 200, body: { nothing: true } },
  ]) {
    const { world, watcher, done } = harness({ answers: [inProgress, answer] });
    await watcher.watch({ tabId: 7, host: 'www.myprotein.com' });
    await done();
    assert.equal(world.lookups.length, 2);
    assert.deepEqual([world.badges, world.injected, world.notices], [[], [], []]);
    assert.equal(world.stored[scanKey(7)], undefined);
  }
  const signedOut = harness({ answers: [found(2)], session: null });
  await signedOut.watcher.watch({ tabId: 7, host: 'www.myprotein.com' });
  await signedOut.done();
  assert.deepEqual([signedOut.world.lookups, signedOut.world.notices], [[], []]);
});

test('a watch gives up after 100 seconds', async () => {
  const { world, watcher, done } = harness({ answers: [inProgress] });
  await watcher.watch({ tabId: 7, host: 'www.myprotein.com' });
  await done();
  assert.ok(world.lookups.length > 0 && world.lookups.length <= Math.floor(WATCH_LIMIT_MS / WATCH_EVERY_MS));
  assert.ok(world.lookups.at(-1).at <= WATCH_LIMIT_MS);
  assert.deepEqual([world.badges, world.notices], [[], []]);
  assert.equal(world.stored[scanKey(7)], undefined);
});

test('nothing is shown on the page while the popup is open: it shows the result itself', async () => {
  const { world, watcher, done } = harness({ answers: [inProgress, found(4)], popupOpen: true });
  await watcher.watch({ tabId: 7, host: 'www.myprotein.com' });
  await done();
  assert.equal(world.lookups.length, 2);
  assert.deepEqual([world.badges, world.injected, world.notices], [[], [], []]);
});

test('nothing is shown, badge included, when the tab has left the shop or will not say where it is', async () => {
  for (const tab of [{ url: 'https://www.example.com/' }, {}, { url: 'not an address' }, null]) {
    const left = harness({ answers: [found(2)], tab });
    await left.watcher.watch({ tabId: 7, host: 'www.myprotein.com' });
    await left.done();
    assert.deepEqual([left.world.badges, left.world.injected, left.world.notices], [[], [], []], JSON.stringify(tab));
  }
});

test('the notice is skipped when the page cannot be scripted or a run panel is showing; the badge still counts', async () => {
  const blocked = harness({ answers: [found(2)] });
  blocked.world.blocked = true;
  await blocked.watcher.watch({ tabId: 7, host: 'www.myprotein.com' });
  await blocked.done();
  assert.deepEqual([blocked.world.badges, blocked.world.notices], [[{ tabId: 7, text: '2' }], []]);

  const running = harness({ answers: [found(2)], runShowing: true });
  await running.watcher.watch({ tabId: 7, host: 'www.myprotein.com' });
  await running.done();
  assert.deepEqual([running.world.badges.length, running.world.injected, running.world.notices], [1, [], []]);
});

test('a result the popup has already shown is not announced on the page', async () => {
  // The popup shows the codes and is closed before the watcher's next tick.
  const { world, watcher, done } = harness({ answers: [inProgress, found(3)] });
  await watcher.watch({ tabId: 7, host: 'www.myprotein.com' });
  assert.deepEqual(await watcher.seen(7), { ok: true });
  assert.equal(watcher.watching(7), false);
  assert.equal(world.stored[scanKey(7)], undefined);
  await done();
  for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([world.badges, world.injected, world.notices], [[], [], []]);
  assert.ok(world.lookups.length <= 1, 'the watch stops looking');

  // Seen while the watcher is already on its way to the page: still nothing is shown.
  const late = harness({ answers: [found(3)] });
  const get = late.world.tab;
  Object.defineProperty(late.world, 'tab', { get: () => { void late.watcher.seen(7); return get; } });
  await late.watcher.watch({ tabId: 7, host: 'www.myprotein.com' });
  await late.done();
  for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([late.world.badges, late.world.injected, late.world.notices], [[], [], []]);

  // Another tab's watch is left alone, and a tab id that is not one is refused.
  const other = harness({ answers: [inProgress, found(1)] });
  await other.watcher.watch({ tabId: 7, host: 'www.myprotein.com' });
  assert.deepEqual(await other.watcher.seen(8), { ok: true });
  assert.match((await other.watcher.seen('7')).error, /couldn’t follow/);
  assert.equal(other.watcher.watching(7), true);
  await other.done();
  assert.equal(other.world.notices.length, 1);
});

test('a watch is refused for a bad tab or host, replaced by a newer one, and dropped with its tab', async () => {
  const { world, watcher, done } = harness({ answers: [inProgress, inProgress, found(1)] });
  assert.match((await watcher.watch({ tabId: '7', host: 'www.myprotein.com' })).error, /couldn’t follow/);
  assert.match((await watcher.watch({ tabId: 7, host: 'not a host' })).error, /couldn’t follow/);
  await watcher.watch({ tabId: 7, host: 'www.myprotein.com' });
  await watcher.watch({ tabId: 7, host: 'www.lookfantastic.com' });
  await done();
  // The first watch may have looked once before it was replaced; after that only the newer one looks.
  const hosts = world.lookups.map(({ body }) => body.merchant);
  assert.ok(hosts.lastIndexOf('www.myprotein.com') <= 0, hosts.join(' '));
  assert.equal(hosts.at(-1), 'www.lookfantastic.com');
  assert.equal(world.notices.length, 0, 'the tab is on another shop');

  const gone = harness({ answers: [inProgress] });
  await gone.watcher.watch({ tabId: 7, host: 'www.myprotein.com' });
  await gone.watcher.tabRemoved(7);
  assert.equal(gone.watcher.watching(7), false);
  assert.equal(gone.world.stored[scanKey(7)], undefined);
});

test('a restarted service worker picks a watch back up and keeps its original limit', async () => {
  const { world, watcher, done } = harness({ answers: [inProgress] });
  world.clock = WATCH_LIMIT_MS - 10_000;
  world.stored[scanKey(7)] = { tabId: 7, host: 'www.myprotein.com', startedAt: 0, checkedAt: world.clock - WATCH_EVERY_MS };
  world.stored[scanKey(8)] = { tabId: 8, host: 'www.myprotein.com', startedAt: -200_000, checkedAt: -150_000 };
  world.stored['run:9'] = { tabId: 9 };
  await watcher.recover();
  assert.equal(watcher.watching(7), true);
  assert.equal(watcher.watching(8), false);
  assert.equal(world.stored[scanKey(8)], undefined);
  await done();
  assert.ok(world.lookups.length >= 1 && world.lookups.length <= 4, `${world.lookups.length} lookups in the last ten seconds`);
  assert.ok(world.stored['run:9']);
});
