import assert from 'node:assert/strict';
import test from 'node:test';
import { compareKey, createCompareEngine } from '../extension/compare-worker.js';
import { PANEL_FILE } from '../extension/run.js';

function harness({
  popupOpen = false,
  runShowing = false,
  fetchImpl,
  tab = { url: 'https://www.myprotein.com/basket/' },
} = {}) {
  const stored = {};
  const injected = [];
  const notices = [];
  const requests = [];

  const storage = {
    async set(items) { Object.assign(stored, structuredClone(items)); },
    async remove(key) { delete stored[key]; },
    async get(key) {
      if (key == null) return structuredClone(stored);
      return key in stored ? { [key]: structuredClone(stored[key]) } : {};
    },
  };
  const tabs = {
    async get() { return tab; },
    async sendMessage(tabId, message) { notices.push({ tabId, message }); },
  };
  const scripting = {
    async executeScript({ target, files }) { injected.push({ tabId: target.tabId, files }); return [{}]; },
  };
  const fetch = fetchImpl ?? (async (url, opts) => {
    const body = JSON.parse(opts.body);
    requests.push({ url: String(url), body });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          results: body.items.map((item) => ({
            offers: [{ retailer: 'OtherShop', price: 24.99, currency: 'GBP', availability: 'in_stock', match: 'exact' }],
            partial: false,
          })),
        };
      },
    };
  });

  let clock = 1000;
  const engine = createCompareEngine({
    fetch,
    apiOrigin: 'http://localhost:8787',
    token: async () => 'tok',
    storage,
    tabs,
    scripting,
    popupOpen: async () => popupOpen,
    runShowing: () => runShowing,
    now: () => (clock += 10),
    heartbeatMs: 0,
  });

  const settled = async (tabId = 7) => {
    for (let i = 0; i < 60; i += 1) {
      const s = engine.get(tabId);
      if (s && s.status !== 'running') return s;
      await new Promise((r) => setImmediate(r));
    }
    throw new Error('Compare never finished');
  };

  return { engine, stored, injected, notices, requests, settled };
}

test('async compare runs in the background, persists to storage.session, and notifies the page when popup is closed', async () => {
  const { engine, stored, injected, notices, requests, settled } = harness({ popupOpen: false });
  const started = await engine.start({
    tabId: 7,
    host: 'www.myprotein.com',
    merchant: 'myprotein.com',
    country: 'GB',
    basket: true,
    items: [
      { name: 'Myprotein Impact Whey', variant: 'Vanilla, 1kg', own: { price: 29.99, currency: 'GBP' } },
      { name: 'Myprotein Creatine', variant: '250g', own: { price: 14.99, currency: 'GBP' } },
      { name: 'Myprotein Oats', variant: '2.5kg', own: { price: 12.99, currency: 'GBP' } },
    ],
  });
  assert.equal(started.ok, true);
  assert.equal(started.state.status, 'running');

  const done = await settled(7);
  assert.equal(done.status, 'done');
  assert.equal(done.checked, 2);
  assert.equal(done.found.length, 2);
  assert.equal(requests.length, 1);
  assert.equal(stored[compareKey(7)].checked, 2);
  assert.deepEqual(injected, [{ tabId: 7, files: [PANEL_FILE] }]);
  assert.deepEqual(notices[0].message, {
    type: 'cartscout:notice',
    notice: { kind: 'compare', host: 'myprotein.com', count: 2, cheaper: 1 },
  });

  // Checking the next batch appends to existing results cleanly.
  const next = await engine.more({ tabId: 7 });
  assert.equal(next.ok, true);
  const done2 = await settled(7);
  assert.equal(done2.checked, 3);
  assert.equal(done2.found.length, 3);
  assert.equal(requests.length, 2);
});

test('async compare skips the page notice while the popup is open and handles server errors cleanly', async () => {
  const open = harness({ popupOpen: true });
  await open.engine.start({
    tabId: 7,
    host: 'www.myprotein.com',
    merchant: 'myprotein.com',
    country: 'GB',
    items: [{ name: 'Myprotein Impact Whey', variant: '1kg' }],
  });
  await open.settled(7);
  assert.deepEqual(open.notices, []);

  const failing = harness({
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      async json() { return { code: 'budget_reached', error: 'Daily budget reached.' }; },
    }),
  });
  await failing.engine.start({
    tabId: 7,
    host: 'www.myprotein.com',
    merchant: 'myprotein.com',
    country: 'GB',
    items: [{ name: 'Myprotein Impact Whey', variant: '1kg' }],
  });
  const err = await failing.settled(7);
  assert.equal(err.status, 'error');
  assert.equal(err.error.code, 'budget_reached');
});
