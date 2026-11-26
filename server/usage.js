// What "npm run usage" prints: CartScout's own ledger of requests against its budgets, then Oxylabs' own count of
// billable results for each day. The database is opened read-only, so looking never changes a server's numbers.
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { readLedger } from './ledger.js';

// Oxylabs' statistics endpoint. Asking it is free of charge.
export const STATS_URL = 'https://data.oxylabs.io/v1/stats?group_by=day';
const DAYS_SHOWN = 14;

const count = (value) => new Intl.NumberFormat('en-GB').format(value);
const date = (time, options) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...options }).format(time);

/** The ledger of the database at `path`, or all zeros when no server has written one there yet. */
export function readLocalUsage(path, now) {
  const db = path !== ':memory:' && existsSync(path) ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(':memory:');
  try {
    return readLedger(db, now);
  } finally {
    db.close();
  }
}

/**
 * Oxylabs' answer, as one row per day: [{ day, results, sources: [{ title, results }] }], oldest first.
 * The documentation shows this endpoint ungrouped, as { data: { sources: [...] } }. Grouped by day it lists the same
 * sources once per day. The exact wrapping of a day is not documented, so a list of days and an object keyed by day
 * are both read, and null is returned for anything else.
 */
export function readStatsDays(body) {
  const data = body?.data;
  const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value);
  let entries;
  if (Array.isArray(data)) entries = data;
  else if (data && typeof data === 'object' && !Array.isArray(data.sources)) {
    entries = Object.entries(data).map(([day, value]) => (Array.isArray(value) ? { day, sources: value } : { day, ...value }));
  } else return null;

  const days = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.sources)) return null;
    const day = [entry.date, entry.day, entry.period, ...Object.values(entry)].find(isDay);
    if (!day) return null;
    const sources = entry.sources.map((source) => ({
      title: String(source?.title ?? 'unnamed'),
      results: Number(source?.results_count_all ?? source?.all_count ?? 0) || 0,
    }));
    days.push({ day: day.slice(0, 10), results: sources.reduce((total, source) => total + source.results, 0), sources });
  }
  return days.sort((a, b) => a.day.localeCompare(b.day));
}

/** Asks Oxylabs for its own count: { days } or { problem }. The key travels in a header and is never printed. */
export async function fetchOxylabsDays({ key, request = fetch }) {
  let response;
  try {
    response = await request(STATS_URL, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { problem: `Oxylabs could not be reached (${error?.name === 'TimeoutError' ? 'no answer in 30 seconds' : 'network error'}).` };
  }
  if (!response.ok) return { problem: `Oxylabs answered HTTP ${response.status}.` };
  let body;
  try {
    body = await response.json();
  } catch {
    return { problem: 'Oxylabs answered with something that is not JSON.' };
  }
  const days = readStatsDays(body);
  return days ? { days } : { problem: `Oxylabs answered in a form this command does not know yet. It began: ${JSON.stringify(body).slice(0, 300)}` };
}

function period(title, totals, limit, held, starts) {
  const left = Math.max(0, limit - totals.requests - held);
  const lines = [
    title,
    `  ${count(totals.requests)} of ${count(limit)} requests used, ${count(left)} left. Starts again ${starts}.`,
  ];
  if (held) lines.push(`  ${count(held)} more are held for scans or price lookups that are running now.`);
  if (totals.requests) {
    lines.push(
      `  For scans ${count(totals.forScans)}, for price lookups ${count(totals.forLookups)}.`,
      `  Searches ${count(totals.searches)}, page reads ${count(totals.reads)}, pages read again with JavaScript ${count(totals.rendered)}.`,
      `  With AI parsing ${count(totals.ai)}. Failed ${count(totals.failed)}${totals.unanswered ? `, no answer recorded ${count(totals.unanswered)}` : ''}.`,
    );
  }
  return lines;
}

/** The whole report as text. `oxylabs` is what fetchOxylabsDays answered, or { skipped: 'why' }. */
export function formatUsage({ ledger, daily, monthly, oxylabs, now }) {
  const lines = [
    'CartScout: requests sent to Oxylabs, counted in UTC',
    '',
    ...period(`Today, ${date(now, { day: 'numeric', month: 'long', year: 'numeric' })}`, ledger.day, daily, ledger.held,
      `${date(ledger.day.to, { day: 'numeric', month: 'long' })} at 00:00 UTC`),
    '',
    ...period(`This month, ${date(now, { month: 'long', year: 'numeric' })}`, ledger.month, monthly, ledger.held,
      `${date(ledger.month.to, { day: 'numeric', month: 'long' })} at 00:00 UTC`),
  ];
  if (ledger.hosts.length) {
    lines.push(`  Asked for most this month: ${ledger.hosts.map(({ host, requests }) => `${host} ${count(requests)}`).join(', ')}.`);
  }
  lines.push('', 'Oxylabs’ own count of billable results, by day');
  if (oxylabs.skipped) lines.push(`  Not asked: ${oxylabs.skipped}`);
  else if (oxylabs.problem) lines.push(`  Not available: ${oxylabs.problem}`);
  else if (!oxylabs.days.length) lines.push('  Oxylabs has counted no results for this key.');
  else {
    const shown = oxylabs.days.slice(-DAYS_SHOWN);
    if (shown.length < oxylabs.days.length) lines.push(`  The last ${shown.length} of ${oxylabs.days.length} days.`);
    const width = Math.max(...shown.map(({ results }) => count(results).length));
    for (const { day, results, sources } of shown) {
      const parts = sources.filter((source) => source.results).map((source) => `${source.title} ${count(source.results)}`);
      lines.push(`  ${day}  ${count(results).padStart(width)}${parts.length ? `   ${parts.join(', ')}` : ''}`);
    }
  }
  lines.push('', 'The remaining balance is only shown at dashboard.oxylabs.io.');
  return lines.join('\n');
}

export async function usageReport({ databasePath, daily, monthly, key, request, now = Date.now(), remote = true }) {
  const oxylabs = !remote ? { skipped: 'this run was asked to stay local.' }
    : !key ? { skipped: 'OXYLABS_WEB_API_KEY is not set.' }
      : await fetchOxylabsDays({ key, request });
  return formatUsage({ ledger: readLocalUsage(databasePath, now), daily, monthly, oxylabs, now });
}
