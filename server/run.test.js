// Tests for the generic worker-owned run engine (extension/run.js) and panel logic (extension/panel/logic.js).

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseDock, dockScores, FAR_EDGE, landmark, LOST_AFTER, readCheckIn, RECHECK_MS, ROW_WEIGHT, stopCopy, SYNC_MS,
} from '../extension/panel/logic.js';
import {
  AUTOTRY_FILE, codesFrom, createReporter, createRunEngine, docProbe, pageCall, PANEL_FILE, panelMessages,
  planFrom, restOf, runKey, senderRole,
} from '../extension/run.js';

const coupons = (...codes) => codes.map((code) => ({ code, offer: '' }));
const money = (value, currency = 'GBP') => ({
  value,
  text: `${currency === 'EUR' ? '€' : '£'}${value.toFixed(2)}`,
  currency,
  format: { prefix: currency === 'EUR' ? '€' : '£', suffix: '', group: ',', decimal: '.', decimals: 2 },
});

const defaultDriver = (over = {}) => ({
  kind: 'recipe',
  id: 'thg-nutrition',
  via: 'dom',
  trust: 'verified',
  mode: 'first',
  label: 'Myprotein',
  reloads: 'never',
  replace: false,
  afterWin: false,
  cleanup: null,
  paceMs: 0,
  ...over,
});

function evSaved(before, after, over = {}) {
  return {
    reaction: true,
    navigating: false,
    total: { before, after, comparable: true, fell: after < before, rose: after > before },
    marker: { by: 'recipe', trust: 'verified', effect: 'applied' },
    error: null,
    pause: false,
    blocked: null,
    ...over,
  };
}

function evRejected(reason = 'invalid', { by = 'recipe', trust = 'verified' } = {}) {
  return {
    reaction: true,
    navigating: false,
    total: { before: 62, after: 62, comparable: true, fell: false, rose: false },
    marker: null,
    error: { by, trust, reason, text: 'Invalid code' },
    pause: false,
    blocked: null,
  };
}

function evUnclear({ reaction = false } = {}) {
  return {
    reaction,
    navigating: false,
    total: { before: 62, after: 62, comparable: true, fell: false, rose: false },
    marker: null,
    error: null,
    pause: false,
    blocked: null,
  };
}

/**
 * Stand-in for Chrome APIs + injected page bundle (`autotry.js` + `panel.js`).
 * `handlers` scripts `prepare`, `attempt`, `settle`, `remove`, `state`, `finalise`, `clear`.
 */
function harness({
  url = 'https://www.myprotein.com/basket/',
  handlers = {},
  report = null,
  callLimit = 500,
  reloadWait = 200,
  pollMs = 5,
  runBudget = 60_000,
  bestSoft = 30_000,
  leaveGrace = 5,
} = {}) {
  const world = {
    stored: {},
    picksStored: {},
    pushed: [],
    pings: [],
    badges: [],
    injectedPanel: 0,
    injectedBundle: 0,
    calls: [],
    tab: { status: 'complete', url },
    doc: 'doc-1',
    ready: 'complete',
    panel: true,
    blocked: false,
    frozen: false,
    pong: [],
  };

  const scripting = {
    async executeScript({ files, func, args }) {
      if (world.blocked) throw new Error('Cannot access contents of the page.');
      if (files) {
        if (files[0] === PANEL_FILE) {
          world.injectedPanel += 1;
          world.panel = true;
          return [{}];
        }
        if (files[0] === AUTOTRY_FILE) {
          world.injectedBundle += 1;
          if (!world.doc) world.doc = `doc-${world.injectedBundle + 1}`;
          return [{}];
        }
        throw new Error(`Unexpected file: ${files[0]}`);
      }
      if (world.frozen) return new Promise(() => {});
      if (func === docProbe) {
        return [{ result: { doc: world.doc, ready: world.ready } }];
      }
      assert.equal(func, pageCall);
      const [command, payload] = args;
      world.calls.push({ command, payload });
      const handler = handlers[command];
      if (typeof handler === 'function') {
        const res = await handler(payload, world);
        return [{ result: res }];
      }
      if (command === 'prepare') {
        return [{ result: { ok: true, doc: world.doc, driver: defaultDriver(), total: money(62), revealed: false, removable: false } }];
      }
      if (command === 'clear') return [{ result: { doc: world.doc } }];
      if (command === 'finalise') return [{ result: { doc: world.doc, ok: true } }];
      if (command === 'remove') return [{ result: { doc: world.doc, ok: true, navigating: false } }];
      return [{ result: { doc: world.doc, evidence: evUnclear(), total: money(62), applied: [], removable: false } }];
    },
  };

  const tabs = {
    async sendMessage(tabId, message, options) {
      if (message.type === 'cartscout:ping') {
        world.pings.push(options);
        if (world.pong.length) world.pong.shift()(world);
        if (!world.panel) throw new Error('Receiving end does not exist.');
        return { ok: true };
      }
      if (!world.panel) throw new Error('Receiving end does not exist.');
      world.pushed.push(message.run);
    },
    async get() {
      if (!world.tab) throw new Error('No tab with id.');
      return world.tab;
    },
  };

  const makeStore = (bag) => ({
    async set(items) { Object.assign(bag, structuredClone(items)); },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete bag[k];
    },
    async get(key) {
      if (key == null) return structuredClone(bag);
      if (typeof key === 'string') return key in bag ? { [key]: structuredClone(bag[key]) } : {};
      return structuredClone(bag);
    },
  });

  const action = {
    async setBadgeText(info) { world.badges.push(info); },
    async setTitle() {},
  };

  let clock = 1000;
  const engine = createRunEngine({
    scripting,
    tabs,
    storage: makeStore(world.stored),
    picks: makeStore(world.picksStored),
    action,
    report,
    callLimit,
    reloadWait,
    pollMs,
    runBudget,
    bestSoft,
    leaveGrace,
    now: () => (clock += 5),
    wait: () => new Promise((resolve) => setImmediate(resolve)),
  });

  const settled = async (tabId = 7) => {
    for (let turn = 0; turn < 300; turn += 1) {
      const run = engine.get(tabId);
      if (!run || !['starting', 'trying'].includes(run.status)) return run;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`The run never finished (status=${engine.get(tabId)?.status}).`);
  };

  return { world, engine, settled, advanceClock: (ms) => { clock += ms; } };
}

test('planFrom deduplicates, uppercases, caps at 10 and computes provenFirst honestly', () => {
  const many = Array.from({ length: 14 }, (_, i) => `CODE${i}`);
  assert.deepEqual(codesFrom(coupons('SAVE', 'SAVE', 'no', 'has space', ...many)), ['SAVE', ...many.slice(0, 9)]);
  assert.deepEqual(codesFrom(null), []);

  const plan = planFrom([
    { code: 'more', worked: 12, failed: 2 },
    { code: 'MORE', worked: 1, failed: 0 },
    { code: 'Save-10', worked: 0, failed: 3 },
    'plain1',
  ]);
  assert.deepEqual(plan.codes, ['MORE', 'SAVE-10', 'PLAIN1']);
  assert.equal(plan.provenFirst, true);
  assert.equal(planFrom([{ code: 'MINE', worked: 1, failed: 0, myReport: 1 }]).provenFirst, false);
  assert.equal(planFrom([{ code: 'TIED', worked: 2, failed: 2 }]).provenFirst, false);
});

test('first-accepted mode works on any HTTPS host, records thumbs and reports confirmed saving', async () => {
  const sent = [];
  const { world, engine, settled } = harness({
    url: 'https://custom-boutique.co.uk/checkout',
    report: async (t) => { sent.push(t); },
    handlers: {
      prepare: () => ({ ok: true, doc: 'doc-1', driver: defaultDriver({ id: 'woo-classic', label: '', afterWin: true }), total: money(62), removable: true }),
      attempt: ({ code }) => (code === 'SAVE45'
        ? { doc: 'doc-1', code, evidence: evSaved(62, 49.6), total: money(49.6), applied: [{ code, effect: 'applied' }], removable: true }
        : { doc: 'doc-1', code, evidence: evRejected('expired'), total: money(62), applied: [], removable: false }),
    },
  });

  assert.deepEqual(await engine.start({ tabId: 7, coupons: [{ code: 'bad' }, { code: 'save45' }, { code: 'later' }] }), { ok: true });
  const run = await settled();
  assert.equal(run.status, 'saved');
  assert.equal(run.host, 'custom-boutique.co.uk');
  assert.equal(run.saving.text.amount, '£12.40');
  assert.deepEqual(run.rest, ['LATER']);
  assert.equal(world.injectedPanel, 1);
  assert.equal(world.injectedBundle, 1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [
    { host: 'custom-boutique.co.uk', merchant: 'custom-boutique.co.uk', code: 'bad', worked: false },
    { host: 'custom-boutique.co.uk', merchant: 'custom-boutique.co.uk', code: 'save45', worked: true, savedAmount: 12.4, savedCurrency: 'GBP' },
  ]);
});

test('best-saving mode tries every code, removes each winner safely and restores the biggest saving', async () => {
  const removed = [];
  const appliedHistory = [];
  const { engine, settled } = harness({
    url: 'https://woo-shop.example/cart/',
    handlers: {
      prepare: () => ({
        ok: true,
        doc: 'doc-1',
        driver: defaultDriver({ id: 'woo-classic', mode: 'best', label: '' }),
        total: money(100),
        removable: true,
      }),
      attempt: ({ code }) => {
        appliedHistory.push(code);
        if (code === 'TEN') return { doc: 'doc-1', code, evidence: evSaved(100, 90), total: money(90), applied: [{ code, effect: 'applied' }], removable: true };
        if (code === 'TWENTY') return { doc: 'doc-1', code, evidence: evSaved(100, 80), total: money(80), applied: [{ code, effect: 'applied' }], removable: true };
        if (code === 'FIVE') return { doc: 'doc-1', code, evidence: evSaved(100, 95), total: money(95), applied: [{ code, effect: 'applied' }], removable: true };
        return { doc: 'doc-1', code, evidence: evRejected('invalid'), total: money(100), applied: [], removable: false };
      },
      remove: ({ code }) => {
        removed.push(code);
        return { doc: 'doc-1', ok: true, navigating: false };
      },
    },
  });

  await engine.start({ tabId: 7, coupons: coupons('TEN', 'TWENTY', 'BAD', 'FIVE') });
  const run = await settled();
  assert.equal(run.status, 'saved');
  assert.equal(run.code, 'TWENTY');
  assert.equal(run.saving.text.amount, '£20.00');
  assert.match(run.message, /beat 2 other codes/);
  // TEN removed before TWENTY, TWENTY removed before BAD, FIVE removed before restoring TWENTY.
  assert.deepEqual(removed, ['TEN', 'TWENTY', 'FIVE']);
  assert.equal(appliedHistory.at(-1), 'TWENTY');
});

test('same-origin form reload mid-attempt re-injects autotry.js, calls settle, and continues cleanly', async () => {
  let attemptCount = 0;
  const { world, engine, settled } = harness({
    url: 'https://presta.example/cart',
    handlers: {
      prepare: () => ({
        ok: true,
        doc: 'doc-1',
        driver: defaultDriver({ id: 'prestashop-classic', reloads: 'always', label: '' }),
        total: money(80, 'EUR'),
      }),
      attempt: ({ code }, w) => {
        attemptCount += 1;
        // Simulate page reload dropping the script result (executeScript resolves null).
        w.doc = null;
        w.panel = false;
        return null;
      },
      settle: ({ code }, w) => {
        if (code === 'FIRST') {
          return { doc: w.doc, code, evidence: evRejected('expired'), total: money(80, 'EUR'), applied: [], removable: false };
        }
        return { doc: w.doc, code, evidence: evSaved(80, 64), total: money(64, 'EUR'), applied: [{ code, effect: 'applied' }], removable: true };
      },
    },
  });

  await engine.start({ tabId: 7, coupons: coupons('FIRST', 'SECOND') });
  const run = await settled();
  assert.equal(run.status, 'saved');
  assert.equal(run.code, 'SECOND');
  assert.equal(run.saving.text.amount, '€16.00');
  assert.equal(attemptCount, 2);
  assert.equal(run.loads, 2);
  assert.ok(world.injectedBundle >= 3);
});

test('cross-origin move mid-run ends with reason=moved, sets badge !, and preserves rest for Carry on', async () => {
  const { world, engine, settled } = harness({
    url: 'https://shop.example/cart',
    handlers: {
      attempt: (_payload, w) => {
        w.tab = { status: 'complete', url: 'https://checkout.shop.example/step-1' };
        w.doc = null;
        return null;
      },
    },
  });

  await engine.start({ tabId: 7, coupons: coupons('AAA', 'BBB', 'CCC') });
  const run = await settled();
  assert.equal(run.status, 'error');
  assert.equal(run.reason, 'moved');
  assert.deepEqual(run.rest, ['BBB', 'CCC']);
  assert.equal(world.badges.at(-1)?.text, '!');
});

test('pick flow transitions offer -> armed -> pickMade -> saved and saves remembered pick', async () => {
  let prepareCalls = 0;
  const { world, engine, settled } = harness({
    url: 'https://unusual-shop.example/checkout',
    handlers: {
      prepare: ({ pick }) => {
        prepareCalls += 1;
        if (!pick) return { ok: false, doc: 'doc-1', reason: 'noBox', candidates: 1 };
        return {
          ok: true,
          doc: 'doc-1',
          driver: defaultDriver({ kind: 'pick', id: 'pick', trust: 'none', label: '' }),
          total: money(50),
        };
      },
      attempt: ({ code }) => ({ doc: 'doc-1', code, evidence: evSaved(50, 45), total: money(45), applied: [], removable: false }),
    },
  });

  await engine.start({ tabId: 7, coupons: coupons('SAVE5') });
  // Wait for prepare to land in pick offer state.
  for (let i = 0; i < 40 && engine.get(7)?.status !== 'pick'; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(engine.get(7).status, 'pick');
  assert.equal(engine.get(7).pick.phase, 'offer');

  assert.deepEqual(await engine.pickStart(7), { ok: true });
  assert.equal(engine.get(7).pick.phase, 'armed');

  // Invalid PickPart is refused.
  const bad = await engine.pickMade(7, { input: { selectors: [] } });
  assert.match(bad.error, /valid code box/);

  // Valid PickPart is persisted under box:<host> and resumes the run.
  const good = await engine.pickMade(7, { input: { selectors: ['#voucher'], print: { tag: 'input' } } });
  assert.deepEqual(good, { ok: true });
  const run = await settled();
  assert.equal(run.status, 'saved');
  assert.equal(run.saving.text.amount, '£5.00');
  assert.equal(prepareCalls, 2);
  assert.ok(world.picksStored['box:unusual-shop.example']);
});

test('pause verdict records per-host pause and refuses immediate restart on that host', async () => {
  const { engine, settled } = harness({
    url: 'https://strict-shop.example/cart',
    handlers: {
      attempt: ({ code }) => ({
        doc: 'doc-1',
        code,
        evidence: { reaction: true, navigating: false, total: { comparable: false }, marker: null, error: null, pause: true, blocked: null },
        total: money(62),
        applied: [],
        removable: false,
      }),
    },
  });

  await engine.start({ tabId: 7, coupons: coupons('AAA', 'BBB') });
  const run = await settled();
  assert.equal(run.status, 'error');
  assert.equal(run.reason, 'paused');

  const again = await engine.start({ tabId: 7, coupons: coupons('BBB') });
  assert.match(again.error, /paused code tries/);
});

test('refuses bad tabId, insecure http URL, empty codes, unreachable tab, or active run', async () => {
  const { world, engine } = harness({ url: 'https://shop.example/cart' });
  assert.match((await engine.start({ tabId: '7', coupons: coupons('AAA') })).error, /find that tab/);
  assert.match((await engine.start({ tabId: 7, coupons: coupons('!!') })).error, /no codes/);

  world.tab = { status: 'complete', url: 'http://shop.example/cart' };
  assert.match((await engine.start({ tabId: 7, coupons: coupons('AAA') })).error, /HTTPS/);

  world.tab = { status: 'complete', url: 'https://shop.example/cart' };
  world.blocked = true;
  assert.match((await engine.start({ tabId: 7, coupons: coupons('AAA') })).error, /can’t reach/);
  assert.equal(engine.get(7), undefined);
});

test('stop, dismiss, clear, resume ("Try the rest"), and setDock behave cleanly', async () => {
  let step = 0;
  const { world, engine, settled } = harness({
    handlers: {
      attempt: async ({ code }) => {
        step += 1;
        await new Promise((r) => setImmediate(r));
        return { doc: 'doc-1', code, evidence: evRejected('expired'), total: money(62), applied: [], removable: false };
      },
    },
  });

  await engine.start({ tabId: 7, coupons: coupons('AAA', 'BBB', 'CCC') });
  assert.deepEqual(await engine.setDock(7, { dock: 'bottom-left' }), { ok: true });
  assert.equal(engine.get(7).dock, 'bottom-left');
  assert.deepEqual(await engine.stop(7), { ok: true });
  const stopped = await settled();
  assert.equal(stopped.status, 'stopped');
  assert.ok(stopped.rest.length >= 1);

  // Resume tries the remaining codes.
  assert.deepEqual(await engine.resume(7), { ok: true });
  const finished = await settled();
  assert.equal(finished.status, 'none');
  assert.equal(step, 3);

  await engine.clear(7);
  assert.equal(engine.get(7), undefined);
  assert.equal(world.pushed.at(-1), null);
});

test('worker recovery settles an in-flight code and continues with remaining codes', async () => {
  const stored = {
    v: 2, tabId: 7, host: 'www.shop.example', origin: 'https://www.shop.example', merchant: 'shop.example',
    status: 'trying', phase: 'attempt', mode: 'first', driver: defaultDriver({ label: '' }),
    total: 2, index: 1, code: 'AAA', stopRequested: false, results: [], saving: null, best: null, applied: null,
    flight: { code: 'AAA', n: 1, step: 'apply', at: 900 }, pick: null, message: '', title: '', reason: '', rest: [],
    startedAt: 500, finishedAt: null, loads: 0, doc: 'doc-1', dock: '', money: money(62),
    proof: { AAA: { listed: 'AAA', worked: 0, failed: 0 }, BBB: { listed: 'BBB', worked: 0, failed: 0 } },
    provenFirst: false,
  };
  const { world, engine, settled } = harness({
    url: 'https://www.shop.example/cart',
    handlers: {
      settle: ({ code }) => ({ doc: 'doc-1', code, evidence: evRejected('expired'), total: money(62), applied: [], removable: false }),
      attempt: ({ code }) => ({ doc: 'doc-1', code, evidence: evSaved(62, 50), total: money(50), applied: [{ code, effect: 'applied' }], removable: false }),
    },
  });
  world.stored[runKey(7)] = stored;
  await engine.recover();
  const run = await settled();
  assert.equal(run.status, 'saved');
  assert.equal(run.code, 'BBB');
  assert.equal(run.saving.text.amount, '£12.00');
});

test('tabUpdated keeps finished runs across in-page updates and drops them when the page leaves', async () => {
  const { world, engine, settled } = harness({
    handlers: {
      attempt: ({ code }) => ({ doc: 'doc-1', code, evidence: evRejected('expired'), total: money(62), applied: [], removable: false }),
    },
  });
  await engine.start({ tabId: 7, coupons: coupons('AAA') });
  await settled();
  assert.equal(await engine.tabUpdated(7, { title: 'Cart' }), 'kept');
  assert.equal(await engine.tabUpdated(7, { status: 'loading' }), 'kept');

  world.panel = false;
  assert.equal(await engine.tabUpdated(7, { status: 'loading' }), 'forgotten');
  assert.equal(engine.get(7), undefined);
});

test('createReporter posts thumbs with session refresh and never throws', async () => {
  const calls = [];
  const answers = [];
  const fetch = async (url, options) => {
    calls.push({ url: String(url), method: options.method, auth: options.headers.Authorization, body: JSON.parse(options.body) });
    const next = answers.shift() ?? { status: 200 };
    if (next instanceof Error) throw next;
    return { status: next.status, ok: next.status >= 200 && next.status < 300 };
  };
  const report = createReporter({ fetch, apiOrigin: 'http://localhost:8787', token: async (fresh) => (fresh ? 'new' : 'old') });
  assert.equal(await report({ host: 'www.myprotein.com', code: 'more', worked: true }), true);
  assert.deepEqual(calls[0].body, { merchant: 'myprotein.com', code: 'more', worked: true });

  answers.push({ status: 401 }, { status: 200 });
  assert.equal(await report({ host: 'myprotein.com', code: 'more', worked: false }), true);
  assert.equal(calls.at(-1).auth, 'Bearer new');

  answers.push(new Error('offline'));
  assert.equal(await report({ host: 'myprotein.com', code: 'more', worked: false }), false);
});

test('senderRole, restOf and panelMessages enforce strict origin and tabId boundaries', () => {
  const me = { id: 'abc', origin: 'chrome-extension://abc' };
  assert.equal(senderRole({ id: 'abc', url: 'chrome-extension://abc/popup.html' }, me), 'popup');
  assert.equal(senderRole({ id: 'abc', url: 'https://shop.example/cart', tab: { id: 7 }, frameId: 0 }, me), 'panel');
  assert.equal(senderRole({ id: 'abc', url: 'https://shop.example/cart', tab: { id: 7 }, frameId: 2 }, me), null);
  assert.equal(senderRole({ id: 'other', url: 'chrome-extension://abc/popup.html' }, me), null);

  const { proof } = planFrom(coupons('aaa', 'BBB', 'ccc'));
  assert.deepEqual(restOf({ proof, results: [{ code: 'AAA' }], code: 'BBB' }), ['CCC']);

  const asked = [];
  const fake = Object.fromEntries(
    ['stop', 'dismiss', 'sync', 'resume', 'pickStart', 'pickMade', 'pickApply', 'pickCancel', 'pickForget', 'setDock']
      .map((name) => [name, (...args) => { asked.push([name, ...args]); return { ok: true }; }]),
  );
  const msgs = panelMessages(fake);
  assert.equal(Object.hasOwn(msgs, 'cartscout:run-start'), false);
  assert.equal(Object.hasOwn(msgs, 'cartscout:run-clear'), false);
  msgs['cartscout:run-rest'](7, null, { tabId: 99 });
  msgs['cartscout:panel-dock'](7, null, { dock: 'top-left' });
  assert.deepEqual(asked, [['resume', 7], ['setDock', 7, { dock: 'top-left' }]]);
});

// ---- Panel logic (extension/panel/logic.js)

const box = (left, top, width, height, weight) => landmark({ left, top, right: left + width, bottom: top + height }, weight);

test('panel dock scoring respects landmarks, ROW_WEIGHT, FAR_EDGE, settled stickiness and stopCopy', () => {
  const viewport = { width: 1280, height: 800 };
  const size = { width: 360, height: 368 };
  assert.equal(chooseDock({ landmarks: [], viewport, size }), 'top-right');
  const summary = [box(940, 150, 300, 44), box(940, 240, 300, 24), box(940, 300, 300, 50)];
  assert.equal(chooseDock({ landmarks: summary, viewport, size }), 'bottom-right');
  assert.equal(chooseDock({ landmarks: [...summary, box(940, 600, 300, 50), box(940, 1200, 300, 50)], viewport, size }), 'bottom-left');

  // Off-screen landmark below the fold weights the near (bottom) edge more than the far (top) edge via FAR_EDGE.
  const narrow = { viewport: { width: 390, height: 700 }, size: { width: 358, height: 368 } };
  const below = [box(16, 900, 358, 44)];
  const [topRight, bottomRight] = dockScores({ landmarks: below, ...narrow });
  assert.equal(topRight.total, bottomRight.total * FAR_EDGE);
  assert.equal(chooseDock({ landmarks: below, ...narrow }), 'top-right');

  // ROW_WEIGHT keeps settled panels from hopping while scrolling past item prices.
  const rowsUnder = [box(310, 380, 60, 24, ROW_WEIGHT), box(310, 430, 60, 24, ROW_WEIGHT)];
  assert.equal(chooseDock({ landmarks: rowsUnder, ...narrow, keep: 'bottom-right', settled: true }), 'bottom-right');

  // stopCopy wording.
  assert.match(stopCopy(false).note, /then stopping/);
  assert.match(stopCopy(true).note, /Press Esc again/);

  // readCheckIn state check.
  const current = { startedAt: 5, index: 2, results: [{ code: 'AAA' }] };
  assert.equal(readCheckIn(current, { ok: true, run: null }), 'lost');
  assert.equal(readCheckIn(current, { ok: true, run: { startedAt: 5, index: 2, results: [{ code: 'AAA' }], status: 'trying' } }), 'draw');
  assert.equal(readCheckIn(current, { ok: true, run: { startedAt: 5, index: 1, results: [], status: 'trying' } }), 'stale');
  assert.equal(LOST_AFTER, 2);
  assert.ok(SYNC_MS + (LOST_AFTER - 1) * RECHECK_MS <= 6000);
});
