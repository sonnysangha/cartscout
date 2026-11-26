// The pinned bar at the bottom of the coupon list: one compact box, the same height on every shop.
// Supports any shop via probe results (try codes, show Scout the code box, open basket, info),
// multi-currency savings, long codes (middleCut with full code in title/status), and carry-on after origin moves.

import { formatMoney } from './autotry/money.js';
import { countUp, drawSwipe, rollText } from './motion.js';
import { middleCut } from './popup-order.js';

export const RUN_ACTIVE = ['starting', 'trying'];
const upper = (code) => String(code).toUpperCase();
const MAX_CODE_SHOWN = 18;

function opened(message) {
  const [first, ...rest] = message.split(/(?<=[.!?])\s+/);
  return [first.replace(/\.$/, ''), rest.join(' ')];
}

function outcomeCopy(run) {
  const tried = run.results?.length ?? 0;
  const full = run.code ? upper(run.code) : 'A code';
  const shown = full.length > MAX_CODE_SHOWN ? middleCut(full, MAX_CODE_SHOWN) : full;
  switch (run.status) {
    case 'pick':
      return [
        run.title || 'Click the code box on the page',
        run.message || 'Watch the page: click the box where a discount code goes.',
        run.title && run.message ? `${run.title}. ${run.message}` : 'Click the code box on the page.',
      ];
    case 'applied':
      return [
        `${shown} is on your basket`,
        'Check the total before you pay.',
        `${full} is on your basket. Check the total before you pay.`,
      ];
    case 'none': {
      const body = run.message || `The shop turned down ${tried === 1 ? 'the code' : `all ${tried} codes`} for this basket.`;
      return ['No code worked this time', body, `No code worked this time. ${body}`];
    }
    case 'stopped': {
      const [first, rest] = opened(run.message || `Stopped after ${tried} of ${run.total} codes.`);
      const body = rest || 'Scout tried nothing further.';
      return [first, body, `${first}. ${body}`];
    }
    default: {
      const raw = run.message || 'Scout couldn’t finish. Check your basket, then try again.';
      const shortMsg = run.code && full.length > MAX_CODE_SHOWN ? raw.replaceAll(full, shown) : raw;
      const [first, rest] = opened(shortMsg);
      return [first, rest, raw];
    }
  }
}

export function createDock(root, { onStart, onPick, onCarryOn, onStop, onClear, onOpenBasket }) {
  const find = (selector) => root.querySelector(selector);
  const tryButton = find('#try-codes');
  const tryNote = find('#try-note');
  const openButton = find('#open-basket');
  const infoNote = find('.dock-info .dock-note');
  const stopButton = find('#stop-codes');
  const againButton = find('#run-again');
  const count = find('#run-count');
  const code = find('#run-code');
  const bar = find('#run-progress');
  const headline = find('#run-headline');
  const detail = find('#run-detail');
  const status = find('#dock-status');
  let shownCode;
  let shownOutcome;
  let ctaAction = 'run';
  let outcomeAction = 'again';

  tryButton.addEventListener('click', () => (ctaAction === 'pick' ? onPick?.() : onStart?.()));
  openButton.addEventListener('click', onOpenBasket);
  againButton.addEventListener('click', () => (outcomeAction === 'carry' ? onCarryOn?.() : onStart?.()));
  stopButton.addEventListener('click', onStop);
  find('#run-done').addEventListener('click', onClear);
  find('#run-dismiss').addEventListener('click', onClear);

  const faces = [...root.querySelectorAll('.dock-face')];

  function face(name) {
    if (root.dataset.dock === name) return;
    const held = root.contains(document.activeElement);
    root.dataset.dock = name;
    root.inert = name === 'off' || name === 'info';
    for (const part of faces) part.inert = !part.classList.contains(`dock-${name}`);
    document.body.dataset.dock = name === 'off' ? 'off' : 'on';
    if (held && !root.inert) {
      const next = [...root.querySelectorAll(`.dock-${name} button:not([disabled], [aria-disabled="true"])`)]
        .find((button) => button.getClientRects().length);
      if (!next) root.tabIndex = -1;
      (next ?? root).focus({ preventScroll: true });
    }
  }

  function renderTrying(run) {
    const tried = run.results?.length ?? 0;
    count.textContent = run.phase === 'restore'
      ? 'Putting the best code back'
      : run.status === 'starting' || !run.index ? 'Getting ready' : `Trying code ${run.index} of ${run.total}`;
    if (run.code && run.code !== shownCode) {
      shownCode = run.code;
      const full = upper(run.code);
      const display = full.length > MAX_CODE_SHOWN ? middleCut(full, MAX_CODE_SHOWN) : full;
      code.title = full;
      void rollText(code, display);
    } else if (!run.code) {
      shownCode = undefined;
      code.textContent = ' ';
      code.removeAttribute('title');
    }
    bar.style.setProperty('--progress', String(run.total ? Math.min(1, Math.max(tried, (run.index ?? 1) - 0.5) / run.total) : 0));
    bar.setAttribute('aria-valuemax', String(run.total || 1));
    bar.setAttribute('aria-valuenow', String(tried));
    stopButton.setAttribute('aria-disabled', String(!!run.stopRequested));
    stopButton.querySelector('.swap').dataset.show = run.stopRequested ? '2' : '1';
  }

  function renderOutcome(run) {
    const key = `${run.status}:${run.startedAt ?? ''}:${run.message ?? ''}:${run.reason ?? ''}`;
    root.dataset.outcome = run.status === 'pick' ? 'applied' : run.status;
    outcomeAction = run.reason === 'moved' && run.rest?.length ? 'carry' : 'again';
    againButton.textContent = outcomeAction === 'carry' ? 'Carry on' : 'Try again';
    if (key === shownOutcome) return;
    shownOutcome = key;
    if (run.status === 'saved' && run.saving) {
      const { saving } = run;
      const amount = document.createElement('span');
      amount.className = 'swipe';
      const fmt = (value) => formatMoney(value, saving.format, saving.currency || '');
      const final = saving.text?.amount ?? fmt(saving.amount);
      const fullCode = upper(saving.code ?? run.code);
      const shown = fullCode.length > MAX_CODE_SHOWN ? middleCut(fullCode, MAX_CODE_SHOWN) : fullCode;
      const afterText = saving.text?.after ?? fmt(saving.after);
      const beat = Number.isInteger(saving.beat) && saving.beat > 0 ? saving.beat : 0;
      headline.replaceChildren('You saved ', amount);
      detail.textContent = beat > 0
        ? `best: ${shown} (${beat + 1} worked), now ${afterText}`
        : `with ${shown}, now ${afterText}`;
      const fullSaid = beat > 0
        ? `You saved ${final} with ${fullCode}, the best of ${beat + 1} working codes, now ${afterText}.`
        : `You saved ${final} with ${fullCode}, now ${afterText}.`;
      root.querySelector('.dock-outcome .dock-copy').title = fullSaid;
      status.textContent = fullSaid;
      void countUp(amount, { to: saving.amount, format: fmt }).then(() => { amount.textContent = final; });
      drawSwipe(amount, { delay: 200 });
      return;
    }
    const [title, text, fullSaid] = outcomeCopy(run);
    const lead = /[.!?]$/.test(title) ? title : `${title}.`;
    headline.textContent = `${lead} `;
    detail.textContent = text;
    root.querySelector('.dock-outcome .dock-copy').title = fullSaid;
    status.textContent = fullSaid;
  }

  return {
    render({ visible, run, codes, onPage = 0, confirmed = 0, plan = null, leaving, opening = false }) {
      const mode = plan?.mode ?? 'info';
      ctaAction = plan?.action ?? 'run';
      tryButton.textContent = plan?.label || (codes === 1 ? 'Try 1 code at checkout' : `Try ${codes} codes at checkout`);
      tryButton.setAttribute('aria-disabled', String(!codes));
      const baseNote = plan?.note || 'Tries each code and keeps the first that works.';
      tryNote.textContent = baseNote;
      tryButton.title = baseNote;
      if (plan?.info) infoNote.textContent = plan.info;
      openButton.setAttribute('aria-disabled', String(opening));
      openButton.querySelector('.swap').dataset.show = opening ? '2' : '1';
      if (!visible) return face('off');
      if (leaving) return face('leaving');
      if (run && RUN_ACTIVE.includes(run.status)) {
        renderTrying(run);
        return face('trying');
      }
      if (run) {
        renderOutcome(run);
        return face('outcome');
      }
      shownCode = shownOutcome = undefined;
      return face(codes ? mode : 'off');
    },
  };
}
