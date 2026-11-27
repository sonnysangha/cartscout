// The in-page panel: Scout tries codes on any shop's page, supports "Show Scout the code box" pick mode,
// keeps its corner across page reloads, and celebrates real savings in the shop's own currency.

import brandCss from '../brand.css';
import scoutCss from '../scout.css';
import panelCss from './panel.css';
import nunitoBytes from '../fonts/nunito-latin-wght-normal.woff2';
import monoBytes from '../fonts/jetbrains-mono-latin-wght-normal.woff2';
import { formatMoney } from '../autotry/money.js';
import { mountScout, setMood } from '../scout.js';
import { celebrate, prefersReducedMotion, sparkle, stopConfetti } from '../confetti.js';
import { countUp, rollText, stickOn } from '../motion.js';
import {
  chooseDock, DOCKS, INSET, landmark, LOST_AFTER, readCheckIn, RECHECK_MS, stopCopy, stopPageRun, SYNC_MS,
} from './logic.js';
import { createPicker } from './pick.js';

const HOST_TAG = 'cartscout-panel';
const SVG_NS = 'http://www.w3.org/2000/svg';
const EXIT_MS = 240;
const HIDDEN_MS = EXIT_MS + 40;
const NOTICE_MS = 10_000;
const PANEL_WIDTH = 360;
const RELOADED = 'CartScout was reloaded. Check your basket, then open CartScout again.';
const NO_RESTART = 'Scout couldn’t start again. Open CartScout and try from there.';
const THUMB = [
  'M6.2 17H4.3A1.3 1.3 0 0 1 3 15.7v-5.4A1.3 1.3 0 0 1 4.3 9h1.9Z',
  'M6.2 9.4 9.3 3.3a2 2 0 0 1 2.3 2.4l-.6 2.8h4.2a1.7 1.7 0 0 1 1.65 2.13l-1.25 4.9A2 2 0 0 1 13.66 17H6.2',
];

const isActive = (run) => run.status === 'starting' || run.status === 'trying';
const viewFor = (run) => (run.status === 'trying' ? 'trying' : run.status === 'saved' ? 'saved' : 'note');
const countOf = (count) => (count === 1 ? '1 code' : `${count} codes`);
const bareHost = (host) => String(host).toLowerCase().replace(/^www\./, '');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(className, shapes, viewBox = '0 0 24 24') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [name, attributes] of shapes) {
    const shape = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value);
    svg.append(shape);
  }
  return svg;
}

function thumb(down) {
  return icon('thumb-icon', THUMB.map((d) => ['path', down ? { d, transform: 'rotate(180 10 10)' } : { d }]), '0 0 20 20');
}

let fonts;
function loadFonts() {
  fonts ??= Promise.all([
    ['CartScout Nunito', nunitoBytes, '200 1000'],
    ['CartScout Mono', monoBytes, '100 800'],
  ].map(async ([family, bytes, weight]) => {
    const face = new FontFace(family, bytes, { weight, style: 'normal', display: 'block' });
    document.fonts.add(face);
    await face.load();
  })).catch(() => {});
  return fonts;
}

// ---- Generic shop landmarks (works on ANY shop via `__cartScoutAutoTry.landmarks()`) -------

function shopLandmarks() {
  const visible = ({ left, top, right, bottom }) => right > left && bottom > top;
  const marks = [];
  const bundleMarks = globalThis.__cartScoutAutoTry?.landmarks?.();
  if (Array.isArray(bundleMarks)) {
    for (const rect of bundleMarks) {
      if (visible(rect)) marks.push(landmark(rect, 1));
    }
  }
  const anchor = bundleMarks?.find((m) => m.kind === 'total');
  for (const control of document.querySelectorAll('a, button, [role="button"]')) {
    const label = `${control.getAttribute('aria-label') ?? ''} ${control.textContent.length < 80 ? control.textContent : ''}`;
    if (!/\b(?:checkout|pay|kasse|payer|pagar|betalen|betala|betal|zaplac)\b/i.test(label)) continue;
    const rect = control.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 20) continue;
    if (anchor && Math.abs((rect.top + rect.bottom) / 2 - (anchor.top + anchor.bottom) / 2) > 480) continue;
    marks.push(landmark(rect, 1));
  }
  return marks;
}

function noteCopy(run) {
  switch (run.status) {
    case 'starting':
      if (run.stopRequested) return { mood: 'work', title: 'Stopping', body: 'Scout will stop before trying a code.' };
      return {
        mood: 'work',
        title: 'Getting your basket ready',
        body: run.provenFirst && run.total > 1
          ? `Scout has ${countOf(run.total)} to try, starting with the ones that worked for others.`
          : `Scout has ${countOf(run.total)} to try.`,
      };
    case 'pick':
      return {
        mood: 'wave',
        title: run.title || (run.pick?.phase === 'apply' ? 'Now click the button that applies it'
          : run.pick?.phase === 'armed' ? 'Click the code box' : 'Scout can’t find the code box'),
        body: run.message || 'Click the box on this page where a discount code goes.',
      };
    case 'applied':
      return { mood: 'happy', title: `${run.code} is on your basket`, body: 'Check the total before you pay.' };
    case 'none':
      return { mood: 'shrug', title: 'No working codes today', body: run.message || 'The shop turned each code down. Your basket hasn’t changed.' };
    case 'stopped':
      return { mood: 'idle', title: run.title || 'Scout has stopped', body: run.message || 'No more codes will be tried.' };
    default:
      return { mood: 'oops', title: run.title || 'That didn’t go to plan', body: run.message || 'Check your basket before trying again.' };
  }
}

export function createPanel({ send = () => {} } = {}) {
  const host = document.createElement(HOST_TAG);
  const root = host.attachShadow({ mode: 'closed' });
  const style = el('style');
  style.textContent = `${brandCss.replace(/@font-face\s*{[^}]*}/g, '')}\n${scoutCss}\n${panelCss}`;

  const panel = el('section', 'panel');
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'CartScout');
  panel.dataset.status = 'starting';
  panel.dataset.kind = 'run';
  panel.dataset.dock = DOCKS[0];

  const close = el('button', 'close');
  close.type = 'button';
  close.append(icon('close-icon', [['path', { d: 'M6.5 6.5l11 11M17.5 6.5l-11 11' }]]));
  const bar = el('div', 'bar');
  bar.append(el('span', 'brand', 'CartScout'), close);

  // Trying view
  const tryScout = mountScout(el('span'), { mood: 'work' });
  const tryTitle = el('h2', 'title');
  const tryNote = el('p', 'note');
  const leadText = el('div', 'lead-text');
  leadText.append(tryTitle, tryNote);
  const lead = el('div', 'lead');
  lead.append(tryScout, leadText);
  const stubMark = icon('stub-mark', [
    ['circle', { cx: 7.5, cy: 7.5, r: 3.2 }],
    ['circle', { cx: 16.5, cy: 16.5, r: 3.2 }],
    ['path', { d: 'M18 6 6 18' }],
  ]);
  const stub = el('span', 'stub');
  stub.append(stubMark);
  const code = el('span', 'code');
  const thumbsUp = el('span', 'count');
  const thumbsDown = el('span', 'count');
  const up = el('span', 'thumb up');
  up.append(thumb(false), thumbsUp);
  const down = el('span', 'thumb down');
  down.append(thumb(true), thumbsDown);
  const thumbs = el('span', 'thumbs');
  thumbs.setAttribute('role', 'img');
  thumbs.append(up, down);
  const ticket = el('div', 'ticket');
  ticket.append(stub, code, thumbs);
  const pips = el('ol', 'pips');
  pips.setAttribute('role', 'progressbar');
  pips.setAttribute('aria-label', 'Codes tried');
  pips.setAttribute('aria-valuemin', '0');
  const stop = el('button', 'secondary', 'Stop after this code');
  stop.type = 'button';
  const tryView = el('div', 'view view-trying');
  tryView.append(lead, ticket, pips, stop);

  // Saved view
  const winScout = mountScout(el('span'), { mood: 'party', sticker: true });
  const amount = el('span', 'amount');
  const winTitle = el('h2', 'win-title');
  winTitle.append(el('span', 'win-label', 'You saved'), amount);
  const winMark = el('span', 'win-mark');
  winMark.append(winScout);
  const win = el('div', 'win');
  win.append(winMark, winTitle);
  const receiptCode = el('span', 'receipt-code');
  const receiptBefore = el('s', 'receipt-was');
  const receiptAfter = el('strong', 'receipt-now');
  const receipt = el('dl', 'receipt');
  for (const [label, value, row] of [['Code', receiptCode, 'row-code'], ['Was', receiptBefore, ''], ['Now', receiptAfter, '']]) {
    const line = el('div', `receipt-row ${row}`.trim());
    const detail = el('dd');
    detail.append(value);
    line.append(el('dt', '', label), detail);
    receipt.append(line);
  }
  const savedDone = el('button', 'primary', 'Done');
  savedDone.type = 'button';
  const savedView = el('div', 'view view-saved');
  savedView.append(win, receipt, savedDone);

  // Note view (starting, pick, applied, none, stopped, error)
  const noteScout = mountScout(el('span'), { mood: 'work' });
  const noteTitle = el('h2', 'title');
  const noteBody = el('p', 'body');
  const noteDone = el('button', 'primary', 'Done');
  noteDone.type = 'button';
  const tryRest = el('button', 'secondary', 'Try the rest');
  tryRest.type = 'button';
  const noteActions = el('div', 'actions');
  noteActions.append(tryRest, noteDone);
  const noteView = el('div', 'view view-note');
  noteView.append(noteScout, noteTitle, noteBody, noteActions);

  // Scan notice view
  const noticeScout = mountScout(el('span'), { mood: 'happy' });
  const noticeTitle = el('h2', 'notice-title');
  const noticeDetail = el('p', 'notice-detail');
  noticeDetail.hidden = true;
  const noticeCopy = el('div', 'notice-copy');
  noticeCopy.append(noticeTitle, noticeDetail);
  const noticeLead = el('div', 'notice-lead');
  noticeLead.append(noticeScout, noticeCopy);
  const showCodes = el('button', 'primary', 'Show codes');
  showCodes.type = 'button';
  const noticeHint = el('p', 'notice-hint', 'Click the CartScout icon to see them.');
  const noticeAction = el('div', 'notice-action');
  noticeAction.append(showCodes, noticeHint);
  const noticeView = el('div', 'view view-notice');
  noticeView.append(noticeLead, noticeAction);

  const views = { trying: tryView, saved: savedView, note: noteView, notice: noticeView };
  const stage = el('div', 'stage');
  stage.append(noteView, tryView, savedView, noticeView);
  for (const view of Object.values(views)) view.inert = true;
  const live = el('p', 'visually-hidden');
  live.setAttribute('aria-live', 'polite');
  const confetti = el('div', 'confetti');
  confetti.setAttribute('aria-hidden', 'true');
  const sheetClip = el('span', 'sheet-clip');
  sheetClip.append(el('span', 'sheet'));
  panel.append(sheetClip, bar, stage, live);
  root.append(style, panel, confetti);

  const fresh = () => ({ startedAt: null, view: '', code: '', pips: 0, status: '', pickPhase: '' });
  let current = null;
  let notice = null;
  let lastPriceAlert = '';
  let shown = fresh();
  let closing;
  let syncing;
  let sulking;
  let noticeTimer;
  let looking;
  let rechecking;
  let lost = 0;
  let docked = false;
  let restAsked = null;
  let swapping = null;
  let noticeGoneAt = 0;
  let stopAsked = null;
  let closeWhenStopped = null;
  let closedRun = null;

  function ask(type, payload) {
    try {
      return Promise.resolve(send(type, payload));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  const picker = createPicker({
    host,
    onPicked(kind, part) {
      const type = kind === 'apply' ? 'cartscout:pick-apply' : 'cartscout:pick-made';
      const payload = kind === 'apply' ? { apply: part } : { input: part };
      ask(type, payload).then((reply) => {
        if (reply?.error && current?.status === 'pick') {
          noteBody.textContent = reply.error;
          say(reply.error);
          picker.start(kind);
        }
      }, () => {});
    },
    onRejected(msg) {
      if (current?.status === 'pick') {
        noteBody.textContent = msg;
        say(msg);
      }
    },
  });

  function unheard() {
    lost += 1;
    if (!current || !isActive(current)) return;
    clearTimeout(rechecking);
    if (lost < LOST_AFTER) {
      rechecking = setTimeout(checkIn, RECHECK_MS);
      return;
    }
    stopPageRun();
    render({ ...current, status: 'error', code: '', finishedAt: Date.now(), message: RELOADED });
  }

  function showView(name) {
    if (shown.view === name) return;
    shown.view = name;
    for (const [key, view] of Object.entries(views)) {
      view.toggleAttribute('data-active', key === name);
      view.inert = key !== name;
    }
  }

  function place({ keep = false } = {}) {
    if (current?.dock && DOCKS.includes(current.dock) && !docked) {
      panel.dataset.dock = current.dock;
      docked = true;
      return true;
    }
    const viewport = {
      width: document.documentElement.clientWidth || innerWidth,
      height: document.documentElement.clientHeight || innerHeight,
    };
    const box = panel.getBoundingClientRect();
    const size = {
      width: Math.min(PANEL_WIDTH, viewport.width - INSET * 2),
      height: Math.min(box.height || 368, viewport.height - INSET * 2),
    };
    let marks = [];
    try { marks = shopLandmarks(); } catch { /* Keep default corner. */ }
    const dock = chooseDock({ landmarks: marks, viewport, size, keep: keep ? panel.dataset.dock : '', settled: keep && docked });
    if (dock !== panel.dataset.dock) move(dock);
    const found = marks.some(({ weight }) => weight >= 1);
    docked ||= found;
    if (current && dock && current.dock !== dock) {
      ask('cartscout:panel-dock', { dock }).catch(() => {});
    }
    return found;
  }

  function move(dock) {
    if (!panel.hasAttribute('data-open') || prefersReducedMotion()) {
      panel.dataset.dock = dock;
      return;
    }
    panel.removeAttribute('data-open');
    clearTimeout(closing);
    closing = setTimeout(() => {
      panel.dataset.dock = dock;
      requestAnimationFrame(() => { if (current || notice) panel.setAttribute('data-open', ''); });
    }, HIDDEN_MS);
  }

  function lookForLandmarks(found) {
    clearInterval(looking);
    if (found) return;
    let looks = 0;
    looking = setInterval(() => {
      looks += 1;
      if (!host.isConnected || looks >= 8 || place({ keep: true })) clearInterval(looking);
    }, 500);
  }

  let resizing;
  addEventListener('resize', () => {
    if (!host.isConnected) return;
    clearTimeout(resizing);
    resizing = setTimeout(() => { if (host.isConnected && (current || notice)) place({ keep: true }); }, 200);
  });

  function renderTrying(run) {
    const index = Math.max(1, run.index);
    const total = Math.max(1, run.total, index);
    tryTitle.textContent = run.phase === 'restore'
      ? (run.title || 'Putting the best code back')
      : `Trying code ${index} of ${total}`;
    const last = run.results.at(-1);
    const stopText = stopCopy(closeWhenStopped === run.startedAt).note;
    tryNote.textContent = run.stopRequested ? stopText
      : last?.outcome === 'rejected' ? `${last.code} wasn’t accepted`
        : last?.outcome === 'applied' ? `${last.code} worked. Checking for a bigger saving…`
          : last ? `No clear answer on ${last.code}`
            : run.provenFirst ? 'Trying the codes that worked for others first.' : 'Scout types each code in for you.';

    if (shown.pips !== total) {
      shown.pips = total;
      pips.replaceChildren(...Array.from({ length: total }, () => el('li', 'pip')));
    }
    [...pips.children].forEach((pip, position) => {
      const state = run.results[position]?.outcome ?? (position === index - 1 ? 'current' : 'pending');
      if (pip.dataset.state !== state) pip.dataset.state = state;
    });
    pips.setAttribute('aria-valuemax', String(total));
    pips.setAttribute('aria-valuenow', String(Math.min(total, run.results.length)));
    pips.setAttribute('aria-valuetext', `${Math.min(total, run.results.length)} of ${countOf(total)} tried`);

    if (run.code && run.code !== shown.code) {
      shown.code = run.code;
      code.dataset.length = run.code.length > 20 ? 'xl' : run.code.length > 14 ? 'l' : run.code.length > 10 ? 'm' : 's';
      void rollText(code, run.code);
      stickOn(stubMark, { duration: 380, tilt: -14 });
      const { worked = 0, failed = 0 } = run.proof?.[run.code] ?? {};
      thumbsUp.textContent = String(worked);
      thumbsDown.textContent = String(failed);
      thumbs.toggleAttribute('data-off', !worked && !failed);
      thumbs.dataset.lead = worked > failed ? 'up' : '';
      thumbs.setAttribute('aria-label', `${worked} thumbs up, ${failed} thumbs down`);
    }
    stop.textContent = run.stopRequested ? 'Stopping…' : 'Stop after this code';
    stop.setAttribute('aria-disabled', String(!!run.stopRequested));
  }

  function renderSaved(run, firstTime) {
    const { saving } = run;
    receiptCode.textContent = saving.code;
    receipt.toggleAttribute('data-long', saving.code.length > 20);
    receiptBefore.textContent = saving.text.before;
    receiptAfter.textContent = saving.text.after;
    amount.dataset.length = saving.text.amount.length >= 8 ? 'l' : '';
    if (!firstTime) {
      amount.textContent = saving.text.amount;
      return;
    }
    const fmt = (value) => formatMoney(value, saving.format, saving.currency || '');
    amount.textContent = fmt(0);
    setMood(winScout, 'party');
    stickOn(winMark, { delay: 80 });
    void countUp(amount, { to: saving.amount, format: fmt }).then(() => {
      amount.textContent = saving.text.amount;
      if (current?.startedAt === run.startedAt && current.status === 'saved') void celebrate({ host: confetti, origin: amount });
    });
  }

  function renderNote(run, firstTime) {
    const copy = noteCopy(run);
    noteTitle.textContent = copy.title;
    noteBody.textContent = copy.body;

    if (run.status === 'pick') {
      const phase = run.pick?.phase ?? 'offer';
      noteDone.textContent = 'Cancel';
      noteDone.toggleAttribute('data-off', false);
      noteDone.inert = false;
      const showPickBtn = phase === 'offer';
      tryRest.textContent = 'Show Scout the box';
      tryRest.toggleAttribute('data-off', !showPickBtn);
      tryRest.setAttribute('aria-disabled', 'false');
      if (phase === 'armed') picker.start('input');
      else if (phase === 'apply') picker.start('apply');
      else picker.stop();
    } else {
      picker.stop();
      noteDone.textContent = 'Done';
      noteDone.toggleAttribute('data-off', run.status === 'starting');
      noteDone.inert = run.status === 'starting';
      const rest = (run.status === 'stopped' || run.status === 'error') && Array.isArray(run.rest) && run.rest.length > 0;
      if (!rest && root.activeElement === tryRest) close.focus();
      tryRest.textContent = 'Try the rest';
      tryRest.toggleAttribute('data-off', !rest);
      tryRest.setAttribute('aria-disabled', String(restAsked === run.startedAt));
    }

    if (!firstTime) return;
    setMood(noteScout, copy.mood);
    clearTimeout(sulking);
    if (copy.mood === 'oops') {
      sulking = setTimeout(() => {
        if (current?.startedAt === run.startedAt && current.status === run.status) setMood(noteScout, 'shrug');
      }, 1450);
    }
    if (shown.view === 'note' && !prefersReducedMotion()) {
      for (const node of [noteTitle, noteBody]) {
        node.animate([{ opacity: 0, translate: '0 6px' }, { opacity: 1, translate: '0 0' }], { duration: 240, easing: 'cubic-bezier(.2, .8, .2, 1)' });
      }
    }
    if (run.status === 'applied') void sparkle({ host: confetti, origin: noteScout });
  }

  function say(text) {
    if (live.textContent !== text) live.textContent = text;
  }

  function announce(run) {
    const last = run.results.at(-1);
    say(run.status === 'trying' && run.stopRequested ? stopCopy(closeWhenStopped === run.startedAt).live
      : run.status === 'trying'
        ? `${last?.outcome === 'rejected' ? `${last.code} wasn’t accepted. ` : ''}Trying code ${Math.max(1, run.index)} of ${Math.max(1, run.total, run.index)}.`
        : run.status === 'saved' ? `You saved ${run.saving.text.amount} with ${run.saving.code}.`
          : `${noteCopy(run).title}. ${noteCopy(run).body}`);
  }

  function open() {
    clearTimeout(closing);
    const attached = !host.isConnected;
    if (attached) document.documentElement.insertBefore(host, document.body);
    if (panel.hasAttribute('data-open')) return attached;
    lookForLandmarks(place({ keep: !attached }));
    void loadFonts().then(() => requestAnimationFrame(() => {
      if (current || notice) panel.setAttribute('data-open', '');
    }));
    return attached;
  }

  function shut() {
    picker.stop();
    current = null;
    notice = null;
    swapping = null;
    lost = 0;
    docked = false;
    restAsked = null;
    clearInterval(syncing);
    clearInterval(looking);
    clearTimeout(rechecking);
    clearTimeout(sulking);
    clearTimeout(noticeTimer);
    syncing = undefined;
    if (!host.isConnected) return;
    noticeGoneAt = panel.dataset.kind === 'notice' && panel.hasAttribute('data-open') && !prefersReducedMotion() ? performance.now() + HIDDEN_MS : 0;
    panel.removeAttribute('data-open');
    clearTimeout(closing);
    closing = setTimeout(() => {
      stopConfetti(confetti);
      host.remove();
      shown = fresh();
      live.textContent = '';
      for (const view of Object.values(views)) {
        view.removeAttribute('data-active');
        view.inert = true;
      }
    }, prefersReducedMotion() ? 0 : EXIT_MS);
  }

  function checkIn() {
    ask('cartscout:run-sync').then((reply) => {
      if (!current || !isActive(current)) return;
      const verdict = readCheckIn(current, reply);
      if (verdict === 'lost') {
        unheard();
        return;
      }
      lost = 0;
      if (verdict === 'draw') render(reply.run);
    }, unheard);
  }

  function render(run) {
    if (!run) {
      shut();
      return;
    }
    if (run.startedAt === closedRun) return;
    if (closeWhenStopped === run.startedAt && ['stopped', 'none', 'error'].includes(run.status)) {
      closedRun = run.startedAt;
      ask('cartscout:run-dismiss').catch(() => {});
      shut();
      return;
    }
    if (stopAsked === run.startedAt && isActive(run) && !run.stopRequested) run = { ...run, stopRequested: true };
    if (notice) {
      const leaving = !!notice && panel.hasAttribute('data-open') && !prefersReducedMotion();
      notice = null;
      clearTimeout(noticeTimer);
      if (leaving) {
        panel.removeAttribute('data-open');
        noticeGoneAt = performance.now() + HIDDEN_MS;
      }
    }
    if (performance.now() < noticeGoneAt) {
      if (!swapping) {
        clearTimeout(closing);
        closing = setTimeout(() => {
          const next = swapping;
          swapping = null;
          noticeGoneAt = 0;
          if (next) render(next);
        }, noticeGoneAt - performance.now());
      }
      swapping = run;
      return;
    }
    if (run.startedAt !== shown.startedAt) {
      shown = { ...shown, startedAt: run.startedAt, code: '', pips: 0, status: '', pickPhase: '' };
      code.textContent = '';
      lost = 0;
      stopConfetti(confetti);
    }
    const firstTime = shown.status !== run.status || (run.status === 'pick' && shown.pickPhase !== (run.pick?.phase ?? ''));
    current = run;
    panel.dataset.kind = 'run';
    panel.dataset.status = run.status;
    close.setAttribute('aria-label', isActive(run) && !run.stopRequested ? 'Stop trying codes and close CartScout' : 'Close CartScout');
    const view = viewFor(run);
    if (view === 'trying') {
      picker.stop();
      renderTrying(run);
    } else if (view === 'saved') {
      picker.stop();
      renderSaved(run, firstTime);
    } else {
      renderNote(run, firstTime);
    }
    if (view !== 'trying') setMood(tryScout, 'idle');
    else if (firstTime) setMood(tryScout, 'work');
    showView(view);
    shown.status = run.status;
    shown.pickPhase = run.pick?.phase ?? '';
    if (open()) setTimeout(() => { if (current) announce(current); }, 120);
    else announce(run);

    if (isActive(run)) syncing ??= setInterval(checkIn, SYNC_MS);
    else {
      clearInterval(syncing);
      clearTimeout(rechecking);
      syncing = undefined;
    }
  }

  // ---- Scan notice --------------------------------------------------------------------------

  function restNotice() {
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      if (!notice) return;
      if (panel.matches(':hover') || host === document.activeElement) restNotice();
      else shut();
    }, NOTICE_MS);
  }

  function showNotice(next) {
    if (current || swapping || !next || !Number.isInteger(next.count) || next.count < 0 || typeof next.host !== 'string') return;
    if (location.hostname && bareHost(location.hostname) !== bareHost(next.host)) return;
    const priceAlert = next.kind === 'price-alert';
    if (priceAlert && (notice || next.key === lastPriceAlert)) return;
    if (priceAlert) lastPriceAlert = next.key;
    const isCompare = next.kind === 'compare' || priceAlert;
    const found = next.count > 0;
    const text = priceAlert ? next.title : isCompare
      ? (next.cheaper > 0 ? 'Found a lower price at another retailer' : found ? 'Other retailer prices are ready' : 'No other retailer prices found.')
      : (found ? `Scout found ${countOf(next.count)} for ${bareHost(next.host)}` : `No codes for ${bareHost(next.host)} this time.`);
    notice = { ...next, text };
    panel.dataset.kind = 'notice';
    panel.dataset.status = 'notice';
    panel.dataset.notice = found || isCompare ? 'found' : 'none';
    noticeAction.removeAttribute('data-asked');
    showCodes.textContent = isCompare ? 'Show prices' : 'Show codes';
    showCodes.inert = !found && !isCompare;
    noticeTitle.textContent = text;
    noticeDetail.hidden = !priceAlert;
    noticeDetail.textContent = priceAlert ? next.detail : '';
    close.setAttribute('aria-label', 'Close CartScout');
    setMood(noticeScout, found ? 'happy' : 'shrug');
    showView('notice');
    const attached = open();
    setTimeout(() => {
      if (!notice) return;
      say(priceAlert ? `${text}. ${next.detail}.` : found ? `${text}.` : text);
      if (found && attached && !priceAlert) void sparkle({ host: confetti, origin: noticeScout });
    }, attached ? 420 : 0);
    restNotice();
  }

  function openCodes() {
    if (!notice) return;
    const payload = ['compare', 'price-alert'].includes(notice.kind) ? { view: 'alternatives' } : undefined;
    ask('cartscout:open-popup', payload).then((reply) => reply?.ok === true, () => false).then((opened) => {
      if (!notice) return;
      if (opened) {
        shut();
        return;
      }
      noticeAction.setAttribute('data-asked', '');
      showCodes.inert = true;
      say(noticeHint.textContent);
      restNotice();
    });
  }

  // ---- Controls -----------------------------------------------------------------------------

  function requestStop() {
    if (!current || !isActive(current) || current.stopRequested) return;
    stopAsked = current.startedAt;
    ask('cartscout:run-stop').then(() => { lost = 0; }, () => {
      stopPageRun();
      unheard();
    });
    render({ ...current, stopRequested: true });
  }

  function dismiss() {
    if (notice) {
      shut();
      return;
    }
    if (!current) return;
    if (current.status === 'pick') {
      picker.stop();
      closedRun = current.startedAt;
      ask('cartscout:pick-cancel').catch(() => {});
      shut();
      return;
    }
    if (isActive(current) && !current.stopRequested) {
      closeWhenStopped = current.startedAt;
      requestStop();
      return;
    }
    closedRun = current.startedAt;
    ask('cartscout:run-dismiss').catch(() => {});
    shut();
  }

  function handleSecondaryAction() {
    const run = current;
    if (!run) return;
    if (run.status === 'pick' && run.pick?.phase === 'offer') {
      ask('cartscout:pick-start').catch(() => {});
      return;
    }
    if (isActive(run) || !run.rest?.length || restAsked === run.startedAt) return;
    restAsked = run.startedAt;
    render(run);
    const failed = (message, final) => {
      if (current?.startedAt !== run.startedAt) return;
      if (!final) restAsked = null;
      render({ ...run, message });
    };
    ask('cartscout:run-rest').then((reply) => {
      if (reply?.ok !== true) failed(typeof reply?.error === 'string' ? reply.error : NO_RESTART, false);
    }, () => failed(RELOADED, true));
  }

  stop.addEventListener('click', requestStop);
  tryRest.addEventListener('click', handleSecondaryAction);
  close.addEventListener('click', dismiss);
  savedDone.addEventListener('click', dismiss);
  noteDone.addEventListener('click', dismiss);
  showCodes.addEventListener('click', openCodes);
  panel.addEventListener('pointerenter', () => { if (notice) restNotice(); });
  panel.addEventListener('focusin', () => { if (notice) restNotice(); });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing || !(current || notice) || !host.isConnected) return;
    const inside = event.target === host;
    if (!inside && event.target instanceof Element
      && event.target.closest('dialog[open], [aria-modal="true"], [role="combobox"][aria-expanded="true"], [aria-haspopup][aria-expanded="true"]')) return;
    if (inside) event.stopPropagation();
    dismiss();
  }, true);

  return { host, render, notice: showNotice };
}

function boot() {
  if (globalThis.__cartScoutPanel) return globalThis.__cartScoutPanel;
  const runtime = globalThis.chrome?.runtime;
  let sender = (type, payload) => runtime?.sendMessage({ ...(payload && typeof payload === 'object' ? payload : {}), type });
  const panel = createPanel({ send: (type, payload) => sender(type, payload) });
  runtime?.onMessage?.addListener((message, from, respond) => {
    if (from.id !== runtime.id) return;
    if (message?.type === 'cartscout:run-state') panel.render(message.run);
    else if (message?.type === 'cartscout:notice') panel.notice(message.notice);
    else if (message?.type !== 'cartscout:ping' || globalThis.top !== globalThis.self) return;
    respond({ ok: true });
  });
  const instance = { render: panel.render, notice: panel.notice, setSender: (next) => { sender = next; } };
  globalThis.__cartScoutPanel = instance;
  return instance;
}

const instance = boot();

export const render = (run) => instance.render(run);
export const notice = (next) => instance.notice(next);
export const setSender = (next) => instance.setSender(next);
