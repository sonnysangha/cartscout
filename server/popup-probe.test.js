import assert from 'node:assert/strict';
import test from 'node:test';
import { dockPlan } from '../extension/popup-probe.js';

test('dockPlan handles handed-off tabs and active shop pauses first', () => {
  const handed = dockPlan({ handed: true, codes: 3, probe: { secure: true, box: 'found' } });
  assert.equal(handed.mode, 'info');
  assert.equal(handed.action, 'none');
  assert.match(handed.info, /toolbar/);

  const paused = dockPlan({ pauseUntil: 5000, now: 1000, codes: 3, probe: { secure: true, box: 'found' } });
  assert.equal(paused.mode, 'info');
  assert.match(paused.info, /paused code tries/);

  // An expired pause lets the probe decide normally.
  const expired = dockPlan({ pauseUntil: 500, now: 1000, codes: 3, probe: { secure: true, box: 'found', mode: 'first' } });
  assert.equal(expired.mode, 'cta');
  assert.equal(expired.action, 'run');
});

test('dockPlan maps blockers and applied/empty states to calm info rows', () => {
  for (const [probe, pattern] of [
    [null, /Open your basket or checkout/],
    [{ secure: false, box: 'found' }, /HTTPS/],
    [{ secure: true, blocked: 'insecure' }, /HTTPS/],
    [{ secure: true, blocked: 'frame' }, /separate frame/],
    [{ secure: true, blocked: 'confirmation' }, /already placed/],
    [{ secure: true, blocked: 'login' }, /Sign in/],
    [{ secure: true, blocked: 'captcha' }, /security check/],
    [{ secure: true, applied: true, box: 'found' }, /already applied/],
    [{ secure: true, blocked: 'empty' }, /Add an item/],
  ]) {
    const plan = dockPlan({ probe, codes: 4 });
    assert.deepEqual([plan.mode, plan.action], ['info', 'none'], JSON.stringify(probe));
    assert.match(plan.info, pattern, JSON.stringify(probe));
  }
});

test('dockPlan offers Try codes when box is found, behind a reveal, or driven by a recipe endpoint', () => {
  for (const box of ['found', 'behind', 'recipe']) {
    const first = dockPlan({ probe: { secure: true, box, mode: 'first' }, codes: 1 });
    assert.deepEqual([first.mode, first.action, first.label], ['cta', 'run', 'Try 1 code at checkout']);
    assert.match(first.note, /first that works/);

    const best = dockPlan({ probe: { secure: true, box, mode: 'best' }, codes: 5 });
    assert.deepEqual([best.mode, best.action, best.label], ['cta', 'run', 'Try 5 codes at checkout']);
    assert.match(best.note, /biggest saving/);
  }
});

test('dockPlan offers Show Scout the code box on cart/checkout pages or when candidates exist', () => {
  for (const probe of [
    { secure: true, box: 'none', page: 'cart', candidates: 0 },
    { secure: true, box: 'none', page: 'checkout', candidates: 0 },
    { secure: true, box: 'none', page: 'other', candidates: 2 },
  ]) {
    const plan = dockPlan({ probe, codes: 3 });
    assert.deepEqual([plan.mode, plan.action, plan.label], ['cta', 'pick', 'Show Scout the code box']);
  }
});

test('dockPlan offers Open basket when a same-origin cart link was found, else checkout/basket info', () => {
  const goto = dockPlan({ probe: { secure: true, box: 'none', page: 'product', cart: 'https://shop.example/cart' }, codes: 3 });
  assert.deepEqual([goto.mode, goto.action, goto.cart], ['goto', 'goto', 'https://shop.example/cart']);
  assert.match(goto.label, /Open basket/);

  const checkoutHint = dockPlan({ probe: { secure: true, box: 'none', page: 'product', where: 'checkout' }, codes: 3 });
  assert.equal(checkoutHint.mode, 'info');
  assert.match(checkoutHint.info, /Open checkout/);

  const basketHint = dockPlan({ probe: { secure: true, box: 'none', page: 'product', where: 'cart' }, codes: 3 });
  assert.equal(basketHint.mode, 'info');
  assert.match(basketHint.info, /Open your basket or checkout/);
});
