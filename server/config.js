// Reads how the server may use Oxylabs from the environment. Every setting has a default that is safe to run with.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DAILY_REQUESTS, DEFAULT_MONTHLY_REQUESTS } from './budget.js';

const MODES = ['live', 'replay', 'off'];
const PARSERS = ['ai', 'local'];

function oneOf(value, choices, name) {
  const chosen = value?.trim().toLowerCase() || choices[0];
  if (!choices.includes(chosen)) throw new Error(`Use ${choices.slice(0, -1).join(', ')} or ${choices.at(-1)} for ${name}.`);
  return chosen;
}

function wholeNumber(value, fallback, name) {
  const written = value?.trim();
  if (!written) return fallback;
  if (!/^\d{1,9}$/.test(written)) throw new Error(`Use a whole number for ${name}.`);
  return Number(written);
}

/** The two request budgets, each counted in UTC because Oxylabs bills by the UTC day. */
export function readBudgetLimits(env = process.env) {
  return {
    daily: wholeNumber(env.OXYLABS_DAILY_REQUESTS, DEFAULT_DAILY_REQUESTS, 'OXYLABS_DAILY_REQUESTS'),
    monthly: wholeNumber(env.OXYLABS_MONTHLY_REQUESTS, DEFAULT_MONTHLY_REQUESTS, 'OXYLABS_MONTHLY_REQUESTS'),
  };
}

export function readConfig(env = process.env) {
  // live: scans and price lookups go to Oxylabs, inside the budget.
  // replay: Oxylabs is never called. Scans and lookups are answered from the database and the replay folder.
  // off: Oxylabs is never called. Saved results still open; anything that needs live work is refused.
  const mode = oneOf(env.OXYLABS_MODE, MODES, 'OXYLABS_MODE');
  const live = mode === 'live';
  // Only a live server holds the key. In replay and off it is not even read, so it cannot be used by mistake.
  const key = live ? env.OXYLABS_WEB_API_KEY?.trim() : undefined;
  if (live && !key) {
    throw new Error('Set OXYLABS_WEB_API_KEY on the coupon server, or start it with OXYLABS_MODE=replay or OXYLABS_MODE=off.');
  }
  const location = env.OXYLABS_LOCATION?.trim().toUpperCase();
  if (location && !/^[A-Z]{2}$/.test(location)) throw new Error('Use a two-letter OXYLABS_LOCATION.');
  const databasePath = env.DATABASE_PATH || 'data/cartscout.sqlite';
  return {
    mode,
    key,
    location: location || undefined,
    parser: oneOf(env.OXYLABS_PAGE_PARSER, PARSERS, 'OXYLABS_PAGE_PARSER'),
    ...readBudgetLimits(env),
    record: live && env.OXYLABS_RECORD?.trim() === '1',
    recordFolder: env.OXYLABS_RECORD_DIR?.trim() || join(dirname(databasePath), 'oxylabs-recordings'),
    replayFolder: env.OXYLABS_REPLAY_DIR?.trim() || fileURLToPath(new URL('./replay', import.meta.url)),
    databasePath,
  };
}
