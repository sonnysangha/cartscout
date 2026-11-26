import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAnswer, reasonCopy, shopLabel } from '../extension/autotry/verdict.js';

test('D7: confirmed total drop always classifies as saved with vote=true', () => {
  const verdict = classifyAnswer({
    total: { comparable: true, before: 62, after: 49.6, fell: true, rose: false },
  });
  assert.deepEqual(verdict, { verdict: 'saved', outcome: 'applied', message: '', vote: true });
});

test('D7: applied markers vote=true ONLY when trust=verified and by=recipe|endpoint', () => {
  const verifiedRecipe = classifyAnswer({ marker: { effect: 'applied', by: 'recipe', trust: 'verified' } });
  assert.deepEqual(verifiedRecipe, { verdict: 'applied', outcome: 'applied', message: '', vote: true });

  const verifiedEndpoint = classifyAnswer({ marker: { effect: 'applied', by: 'endpoint', trust: 'verified' } });
  assert.deepEqual(verifiedEndpoint, { verdict: 'applied', outcome: 'applied', message: '', vote: true });

  // Recalled recipe or generic heuristic marker: accepted, NEVER votes.
  for (const marker of [
    { effect: 'applied', by: 'recipe', trust: 'recalled' },
    { effect: 'applied', by: 'generic', trust: 'recalled' },
    { effect: 'applied', by: 'generic', trust: 'verified' },
  ]) {
    const v = classifyAnswer({ marker });
    assert.deepEqual(v, { verdict: 'applied', outcome: 'applied', message: '' }, JSON.stringify(marker));
    assert.equal(v.vote, undefined);
  }
});

test('D7: parked / no-effect markers classify as basket refusal with NO vote', () => {
  const v = classifyAnswer({ marker: { effect: 'none', by: 'recipe', trust: 'verified' } });
  assert.deepEqual(v, { verdict: 'rejected', outcome: 'rejected', message: 'Doesn’t apply to this basket' });
  assert.equal(v.vote, undefined);
});

test('D7: code-intrinsic and plain refusals automatically vote=false; basket/account refusals stay neutral', () => {
  for (const [reason, expectedMsg] of [
    ['expired', 'Expired'],
    ['usedUp', 'Not valid, or all used up'],
    ['invalid', 'Not a valid code'],
    ['generic', 'The shop turned it down'],
  ]) {
    for (const source of [
      { by: 'recipe', trust: 'verified' },
      { by: 'recipe', trust: 'recalled' },
      { by: 'wording', trust: 'verified' },
      { by: 'wording', trust: 'recalled' },
    ]) {
      const res = classifyAnswer({ error: { reason, ...source } });
      assert.deepEqual(res, { verdict: 'rejected', outcome: 'rejected', message: expectedMsg, vote: false }, `${reason}/${source.by}/${source.trust}`);
    }
  }

  // Missing reason defaults to generic refusal and automatically votes down.
  assert.deepEqual(
    classifyAnswer({ error: { by: 'wording', trust: 'recalled' } }),
    { verdict: 'rejected', outcome: 'rejected', message: 'The shop turned it down', vote: false },
  );

  // Basket/account-specific reasons NEVER vote down, even from verified recipes.
  for (const [reason, expectedMsg] of [
    ['basket', 'Doesn’t apply to this basket'],
    ['shopper', 'Already used'],
    ['better', 'A better offer is already on this basket'],
    ['combine', 'Can’t be combined with another offer'],
  ]) {
    const v = classifyAnswer({ error: { reason, by: 'recipe', trust: 'verified' } });
    assert.deepEqual(v, { verdict: 'rejected', outcome: 'rejected', message: expectedMsg }, reason);
    assert.equal(v.vote, undefined);
  }
});

test('D7: blockers, pauses, unexpected total rises and unclear evidence classify honestly', () => {
  assert.deepEqual(classifyAnswer({ blocked: 'captcha' }), { verdict: 'blocked', reason: 'captcha' });
  assert.deepEqual(classifyAnswer({ pause: true }), { verdict: 'pause', reason: 'paused' });
  assert.deepEqual(
    classifyAnswer({ total: { comparable: true, before: 50, after: 60, fell: false, rose: true } }),
    { verdict: 'rose', reason: 'rose' },
  );
  // If total rose AND there is an explicit refusal error, error wins (not rose).
  assert.equal(
    classifyAnswer({
      total: { comparable: true, before: 50, after: 60, fell: false, rose: true },
      error: { reason: 'invalid', by: 'wording', trust: 'recalled' },
    }).verdict,
    'rejected',
  );
  assert.deepEqual(classifyAnswer(null), { verdict: 'unclear', outcome: 'error', message: 'No clear answer from the shop' });
  assert.deepEqual(classifyAnswer({}), { verdict: 'unclear', outcome: 'error', message: 'No clear answer from the shop' });
});

test('reasonCopy uses driver label when known and falls back to "The shop"', () => {
  assert.equal(shopLabel({ label: 'Myprotein' }), 'Myprotein');
  assert.equal(shopLabel(null), 'The shop');
  assert.match(reasonCopy('paused', { driver: { label: 'Myprotein' } }).message, /^Myprotein has paused/);
  assert.match(reasonCopy('paused', {}).message, /^The shop has paused/);
  assert.match(reasonCopy('unclear', { driver: { label: 'Myprotein' }, twice: true }).message, /twice in a row/);
  assert.match(reasonCopy('unclear', { code: 'SAVE10' }).message, /on SAVE10/);
  assert.match(reasonCopy('restore', { code: 'BEST20' }).message, /Copy BEST20/);
  assert.match(reasonCopy('moved').message, /another address/);
  assert.match(reasonCopy('unsafeForm').message, /payment or personal details/);
});
