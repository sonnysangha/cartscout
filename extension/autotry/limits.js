// Shared constants for the generic auto-try engine (worker + injected page bundle).
// A recipe may lower a wait, never raise it.

export const BUILD = 1;
export const AUTOTRY_FILE = 'autotry.js';
export const PANEL_FILE = 'panel.js';

export const RUN_LIMIT = 10;
export const CALL_LIMIT_MS = 15_000;
export const BUTTON_MS = 1_500;
export const ANSWER_MS = 8_000;
export const HOLD_MS = 500;
export const CONFIRM_MS = 1_000;
export const LATE_TOTAL_MS = 1_500;
export const QUIET_MS = 400;
export const SETTLE_CAP_MS = 4_000;
export const REVEAL_MS = 2_000;
export const PACE_MS = 800;
export const ENDPOINT_PACE_MS = 500;
export const LEAVE_GRACE_MS = 6_000;
export const RELOAD_WAIT_MS = 20_000;
export const DRAW_WAIT_MS = 8_000;
export const POLL_MS = 250;
export const RECHECK_PAGE_MS = 1_000;

export const MAX_LOADS = 24;
export const MAX_UNCLEAR = 2;
export const NO_REACTION = 3;
export const RUN_BUDGET_MS = 150_000;
export const BEST_SOFT_MS = 90_000;
export const PAUSE_MS = 300_000;
export const MAX_PAUSE_MS = 30 * 60_000;
export const PROBE_MS = 600;

export const PICK_KEEP_DAYS = 180;
export const PICK_MAX = 200;
export const MISSES_TO_FORGET = 2;

export const DOCKS = ['top-right', 'bottom-right', 'bottom-left', 'top-left'];

export const bareHost = (host) => String(host ?? '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
export const pickKey = (host) => `box:${bareHost(host)}`;
export const pauseKey = (host) => `pause:${bareHost(host)}`;

/** Recipes may tighten timing limits, never loosen them above the engine's ceiling. */
export const capMs = (given, ceiling) => (Number.isFinite(given) && given >= 0 ? Math.min(given, ceiling) : ceiling);
