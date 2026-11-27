// One coupon ticket, printed like a real coupon: the code, the offer, and the small print
// (thumbs up and down, where it was seen, when it ends). The whole ticket copies the code and the stub then asks
// whether it worked. Every change happens inside the ticket's fixed box, so nothing around it moves.
//
// A coupon is `{ code, reportCode, offer, sources, expiresOn, worked, failed, myReport }`. `code` is what is printed
// and copied (upper case); `reportCode` is the API's own spelling, which a thumb is filed under. A coupon with
// `pageOnly` was read from the shop's own page: the server has never heard of it, so it has no thumbs to show or ask for.

import { prefersReducedMotion } from './confetti.js';
import { isWorking, shortcutHints, tally } from './popup-order.js';

const COPIED_MS = 1200;
const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

function sourceHost(coupon) {
  for (const source of coupon.sources ?? []) {
    try {
      const url = new URL(source);
      if (['https:', 'http:'].includes(url.protocol)) return url.hostname.replace(/^www\./, '');
    } catch {
      // Not a link: try the next source.
    }
  }
  return '';
}

function expiryText(expiresOn) {
  const date = expiresOn ? new Date(`${expiresOn}T00:00:00`) : null;
  return date && !Number.isNaN(date.getTime()) ? `ends ${day.format(date)}` : '';
}

const people = (count) => (count === 1 ? '1 person' : `${count} people`);

/** One sentence for the pair of thumbs. On Free the counts are the shopper's own report, so it says so. */
function thumbsSentence(coupon, shared) {
  const worked = tally(coupon.worked);
  const failed = tally(coupon.failed);
  if (!worked && !failed) return '';
  if (!shared) return worked ? 'You said it worked' : 'You said it didn’t work';
  return `Worked for ${people(worked)}, didn’t work for ${people(failed)}`;
}

const trialFacts = {
  applied: (message) => (message && message !== 'Worked' ? message : 'Applied to this basket'),
  rejected: (message) => (message ? `Turned down: ${message}` : 'Turned down for this basket'),
  error: (message) => message || 'The shop’s answer was unclear',
};

// A long code steps its size down rather than wrapping or losing its end: 19px, then 16, 14 and 12.
function codeSize(code) {
  return code.length <= 16 ? '' : code.length <= 20 ? '2' : code.length <= 24 ? '3' : '4';
}

const ON_PAGE = 'Shown on this shop’s page';

function tick(element) {
  if (prefersReducedMotion()) return;
  element.animate(
    [{ opacity: 0, translate: '0 .4em' }, { opacity: 1, translate: '0 0' }],
    { duration: 260, easing: 'cubic-bezier(.34, 1.4, .64, 1)' },
  );
}

/**
 * Build a ticket row from the popup's <template id="coupon">.
 * `copy(code)` and `vote(coupon, worked)` are async and throw on failure; `vote` resolves with
 * `{ worked, failed, myReport }` for this code. `shared` is true when the counts include other members (Pro).
 */
export function createTicket(template, coupon, index, { shared = false, wasCopied = false, shortcuts = true, copy, vote, onWorked, onProblem }) {
  const row = template.content.firstElementChild.cloneNode(true);
  const find = (selector) => row.querySelector(selector);
  const ticket = find('.ticket');
  const copyButton = find('.ticket-copy');
  const code = find('.code');
  const offer = find('.offer');
  const thumbs = find('.thumbs');
  const counts = { up: find('.thumb.up .count'), down: find('.thumb.down .count') };
  const ask = find('.stub-ask');
  const askLabel = find('.ask-label');
  const says = find('.ticket-says');
  const feedback = find('.copy-feedback');
  const votes = { yes: find('.worked'), no: find('.failed') };

  let current = coupon;
  // Only a code the server lists can be answered for.
  const askable = !coupon.pageOnly && !coupon.pending;
  let revealed = askable && (wasCopied || coupon.myReport === 0 || coupon.myReport === 1);
  let showingCopied = false;
  let copiedTimer;
  let trial = null;
  // The answer a checkout run has just filed for this code, shown at once; the counts follow when they are fetched.
  let filed = null;
  let voting = false;
  // What the stub shows as the shopper's answer: the run's fresh one, else the one on record.
  const answered = () => (filed ?? current.myReport);

  row.dataset.code = coupon.code;
  code.textContent = coupon.code;
  code.title = coupon.code;
  code.dataset.size = codeSize(coupon.code);
  offer.id = `coupon-offer-${index}`;
  says.id = `coupon-says-${index}`;
  copyButton.setAttribute('aria-label', `Copy ${coupon.code}`);
  // The first nine tickets answer to their place on the keyboard, and the first to C as well.
  function hintShortcut(on) {
    const { keys, title } = shortcutHints(index, on);
    if (keys) copyButton.setAttribute('aria-keyshortcuts', keys);
    else copyButton.removeAttribute('aria-keyshortcuts');
    if (title) copyButton.title = title;
    else copyButton.removeAttribute('title');
  }
  hintShortcut(shortcuts);
  copyButton.setAttribute('aria-describedby', `${offer.id} ${says.id}`);
  ask.setAttribute('aria-label', `Did ${coupon.code} work?`);

  function paint() {
    const report = askable ? answered() : null;
    const answer = report === 1 ? 'yes' : report === 0 ? 'no' : null;
    const stub = showingCopied ? 'copied' : !askable ? 'copy' : answer ? 'answered' : revealed ? 'ask' : 'copy';
    ticket.dataset.stub = stub;
    ticket.dataset.answer = answer ?? '';
    ask.inert = stub !== 'ask' && stub !== 'answered';
    askLabel.dataset.show = answer === 'yes' ? '2' : answer === 'no' ? '3' : '1';
    votes.yes.setAttribute('aria-pressed', String(answer === 'yes'));
    votes.no.setAttribute('aria-pressed', String(answer === 'no'));

    // The offer always keeps its two lines; when nobody stated one, the ticket says so rather than sitting blank.
    offer.textContent = current.offer || 'No offer details';
    offer.title = current.offer || '';
    offer.toggleAttribute('data-none', !current.offer);

    const worked = tally(current.worked);
    const failed = tally(current.failed);
    const reported = worked + failed > 0;
    const provenance = find('.provenance');
    // Where it was seen gives way first; the end date and the thumbs are never cut short.
    const [where, when] = trial
      ? [trialFacts[trial.outcome](trial.message), '']
      : [current.pageOnly ? ON_PAGE : sourceHost(current), expiryText(current.expiresOn)];
    const printed = JSON.stringify([where, when]);
    if (thumbs.hidden === reported || provenance.dataset.printed !== printed) {
      // The thumbs take their place at the start of the line; the text beside them is reprinted rather than slid along.
      const reprint = provenance.cloneNode(false);
      reprint.dataset.printed = printed;
      reprint.title = [where, when].filter(Boolean).join(' · ');
      for (const [name, text] of [['where', where], ['when', where && when ? `· ${when}` : when]]) {
        if (!text) continue;
        const part = document.createElement('span');
        part.className = name;
        part.textContent = text;
        reprint.append(part);
      }
      provenance.replaceWith(reprint);
    }
    thumbs.hidden = !reported;
    thumbs.dataset.lead = worked > failed ? 'up' : '';
    thumbs.dataset.alone = where || when ? '' : 'true';
    for (const [name, value] of [['up', worked], ['down', failed]]) {
      if (counts[name].textContent === String(value)) continue;
      const changed = counts[name].dataset.set === 'true';
      counts[name].textContent = String(value);
      counts[name].dataset.set = 'true';
      if (changed) tick(counts[name]);
    }
    row.toggleAttribute('data-working', isWorking(current, shared));
    says.textContent = [
      isWorking(current, shared) ? 'Worked for other members' : '',
      thumbsSentence(current, shared),
      where && !trial && !current.pageOnly ? `Seen on ${where}` : where,
      when,
    ].filter(Boolean).join('. ');
  }

  copyButton.addEventListener('click', async () => {
    try {
      await copy(coupon.code);
    } catch {
      feedback.textContent = `Couldn’t copy ${coupon.code}. Try again.`;
      onProblem?.(`Couldn’t copy ${coupon.code}. Try again.`);
      return;
    }
    if (!row.isConnected) return;
    revealed = askable;
    showingCopied = true;
    paint();
    feedback.textContent = askable ? `Copied ${coupon.code}. Tell Scout whether it worked.` : `Copied ${coupon.code}.`;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      showingCopied = false;
      feedback.textContent = '';
      if (row.isConnected) paint();
    }, COPIED_MS);
  });

  for (const [name, button] of Object.entries(votes)) {
    button.addEventListener('click', async () => {
      // The buttons stay enabled while the answer is saved, so focus never leaves the one that was pressed.
      if (voting) return;
      const worked = name === 'yes';
      if (answered() === Number(worked)) return;
      voting = true;
      ticket.setAttribute('aria-busy', 'true');
      try {
        const counted = await vote(current, worked);
        current = { ...current, ...counted, myReport: Number(worked) };
        // The shopper's own answer replaces whatever a run filed for them.
        filed = null;
        paint();
        feedback.textContent = worked
          ? `Thanks. Scout noted that ${coupon.code} worked.`
          : `Noted. ${coupon.code} didn’t work for you.`;
        if (worked) onWorked?.(button);
      } catch (error) {
        if (error?.quiet) return;
        feedback.textContent = error.message;
        onProblem?.(error.message);
      } finally {
        voting = false;
        ticket.removeAttribute('aria-busy');
      }
    });
  }

  paint();
  return {
    row,
    code: coupon.code,
    get coupon() { return current; },
    /** Fresh facts for the same code: counts, offer and provenance change in place. */
    update(next) {
      current = { ...current, ...next };
      if (askable && (current.myReport === 0 || current.myReport === 1)) revealed = true;
      paint();
    },
    /**
     * Mark the ticket with what the checkout run found: `{ outcome, message, vote }`, or null to clear it.
     * `vote` is the answer the run filed for the shopper (false when the shop turned the code down), so the stub
     * says "Didn't work" the moment the result arrives instead of still asking.
     */
    setTrial(result, { settled = false } = {}) {
      const next = result && result.outcome in trialFacts ? result : null;
      const vote = typeof next?.vote === 'boolean' ? Number(next.vote) : null;
      const kept = next?.kept;
      if (next?.outcome === trial?.outcome && next?.message === trial?.message && vote === (trial?.filed ?? null) && kept === trial?.kept) return;
      trial = next ? { outcome: next.outcome, message: next.message, filed: vote, kept } : null;
      // A result with no answer filed, or a cleared trial, hands the stub back to the answer on record. So does a
      // list loaded after the run ended (`settled`): by then the record already holds the run's answer, or the
      // shopper's correction of it, and that must not be overwritten by the older result.
      filed = settled && (current.myReport === 0 || current.myReport === 1) ? null : vote;
      row.dataset.trial = trial?.outcome === 'applied' && trial?.kept === false ? '' : (trial?.outcome ?? '');
      paint();
    },
    /** Copy this ticket's code as a click would, for the keyboard shortcuts; brings the ticket into view first. */
    press() {
      row.scrollIntoView({ block: 'nearest' });
      copyButton.click();
    },
    /** The shortcuts were switched on or off: the ticket's hints follow, where it sits. */
    setShortcuts: hintShortcut,
    focus() {
      copyButton.focus({ preventScroll: true });
    },
  };
}

export function createSkeletons(template, count) {
  return Array.from({ length: count }, () => template.content.firstElementChild.cloneNode(true));
}
