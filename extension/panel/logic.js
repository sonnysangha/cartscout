// The panel's decisions that need no page: which corner it sits in, and what a check-in's answer means.
// Kept apart from panel.js so they run under node --test.

/** The corners the panel may sit in, in order of preference. */
export const DOCKS = ['top-right', 'bottom-right', 'bottom-left', 'top-left'];
export const INSET = 16;
export const CLEARANCE = 8;
/** An item row's price is worth keeping in view, but a quarter as much as the promo box, the total or the way to pay. */
export const ROW_WEIGHT = 0.25;
/** A landmark that is off screen counts this much against the edge it is not heading for. */
export const FAR_EDGE = 0.5;

/** A landmark the panel should keep clear of: a box in viewport px, and how much covering it matters. */
export const landmark = ({ left, top, right, bottom }, weight = 1) => ({ left, top, right, bottom, weight });

/**
 * How much of the shop each corner would cover. `total` is every landmark by its weight; `hard` is only what is
 * on screen now at full weight, which is the one thing that moves a panel that has already settled.
 */
export function dockScores({ landmarks, viewport, size }) {
  return DOCKS.map((dock) => {
    const left = dock.endsWith('right') ? viewport.width - INSET - size.width : INSET;
    const top = dock.startsWith('bottom') ? viewport.height - INSET - size.height : INSET;
    let total = 0;
    let hard = 0;
    for (const rect of landmarks) {
      const weight = rect.weight ?? 1;
      const clearance = weight >= 1 ? CLEARANCE : 0;
      const across = Math.min(left + size.width, rect.right + clearance) - Math.max(left, rect.left - clearance);
      if (across <= 0) continue;
      const down = Math.min(top + size.height, rect.bottom + clearance) - Math.max(top, rect.top - clearance);
      if (down > 0) {
        total += across * down * weight;
        if (weight >= 1) hard += across * down;
        continue;
      }
      const below = rect.top >= viewport.height;
      if (!below && rect.bottom > 0) continue;
      const near = dock.startsWith(below ? 'bottom' : 'top');
      total += across * (rect.bottom - rect.top) / 4 * weight * (near ? 1 : FAR_EDGE);
    }
    return { total, hard };
  });
}

/**
 * Choose a corner: the first that covers none of the shop's landmarks, else the one that covers least by weight.
 */
export function chooseDock({ landmarks, viewport, size, keep = '', settled = false }) {
  const scores = dockScores({ landmarks, viewport, size });
  const kept = scores[DOCKS.indexOf(keep)];
  if (kept && kept.total === 0) return keep;
  let best = 0;
  for (let index = 1; index < scores.length; index += 1) {
    if (scores[index].total < scores[best].total) best = index;
  }
  if (kept && settled && scores[best].hard >= kept.hard) return keep;
  return DOCKS[best];
}

export const SYNC_MS = 5000;
export const RECHECK_MS = 1000;
export const LOST_AFTER = 2;

export function readCheckIn(current, reply) {
  const run = reply?.run;
  if (!run || typeof run !== 'object' || !Array.isArray(run.results)) return 'lost';
  if (run.panelDismissed) return 'stale';
  const behind = run.startedAt === current.startedAt
    && (run.index < current.index || run.results.length < current.results.length);
  return behind ? 'stale' : 'draw';
}

/**
 * What a run says once it has been asked to stop and the code in flight is finishing: `note` is shown on the panel,
 * `live` is spoken.
 */
export function stopCopy(closing) {
  const note = closing ? 'Finishing this code, then closing. Press Esc again to close now.' : 'Finishing this code, then stopping.';
  return { note, live: closing ? note : 'Stopping after this code.' };
}

/**
 * Ask any legacy in-page trial to stop (kept for unit-test compatibility).
 */
export function stopPageRun(scope = globalThis) {
  const trial = scope.cartScoutCouponTrial;
  if (trial?.state !== 'running') return false;
  trial.stopRequested = true;
  return true;
}
