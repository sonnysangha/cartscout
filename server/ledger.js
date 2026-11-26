// The Oxylabs ledger: every request CartScout sends is written down here, and none is sent without a hold on the
// budget. Both live in SQLite, so the count survives a restart and two servers on one database share it.

const DAY = 86_400_000;
// A hold that is never released (the server stopped in the middle of a scan) stops counting after this long.
// It has to outlast the slowest scan: one search, two rounds of page reads and one rendered re-read.
const HOLD_LEASE = 5 * 60_000;

// Oxylabs bills by the UTC day, so the budget's days and months are UTC too.
export const utcDayStart = (now) => Math.floor(now / DAY) * DAY;

export function utcMonthStart(now, monthsLater = 0) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + monthsLater, 1);
}

export const LEDGER_TABLES = `
  CREATE TABLE IF NOT EXISTS oxylabs_requests (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('scan', 'lookup')),
    kind TEXT NOT NULL CHECK (kind IN ('search', 'read', 'read_js')),
    host TEXT NOT NULL,
    ai INTEGER NOT NULL DEFAULT 0 CHECK (ai IN (0, 1)),
    ok INTEGER CHECK (ok IN (0, 1)),
    ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS oxylabs_requests_by_time ON oxylabs_requests (at);
  -- AUTOINCREMENT: a hold's number is never given out again, so a ticket whose hold has run out cannot spend from
  -- a newer operation's hold.
  CREATE TABLE IF NOT EXISTS oxylabs_holds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation TEXT NOT NULL,
    held INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`;

const COUNTS = `
  COUNT(*) AS requests,
  COALESCE(SUM(ok = 1), 0) AS answered,
  COALESCE(SUM(ok = 0), 0) AS failed,
  COALESCE(SUM(ok IS NULL), 0) AS unanswered,
  COALESCE(SUM(kind = 'search'), 0) AS searches,
  COALESCE(SUM(kind = 'read'), 0) AS reads,
  COALESCE(SUM(kind = 'read_js'), 0) AS rendered,
  COALESCE(SUM(ai), 0) AS ai,
  COALESCE(SUM(operation = 'scan'), 0) AS forScans,
  COALESCE(SUM(operation = 'lookup'), 0) AS forLookups
`;

/**
 * Totals for the UTC day and month that `now` falls in. It only reads, so it also works on a database opened
 * read-only, which is how "npm run usage" looks at a server's numbers without touching them.
 */
export function readLedger(db, now) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
  const day = { from: utcDayStart(now), to: utcDayStart(now) + DAY };
  const month = { from: utcMonthStart(now), to: utcMonthStart(now, 1) };
  if (!exists.get('oxylabs_requests')) {
    const none = { requests: 0, answered: 0, failed: 0, unanswered: 0, searches: 0, reads: 0, rendered: 0, ai: 0, forScans: 0, forLookups: 0 };
    return { day: { ...day, ...none }, month: { ...month, ...none }, held: 0, hosts: [] };
  }
  const between = db.prepare(`SELECT ${COUNTS} FROM oxylabs_requests WHERE at >= ? AND at < ?`);
  const hosts = db.prepare(`
    SELECT host, COUNT(*) AS requests FROM oxylabs_requests
    WHERE at >= ? AND at < ? AND host <> '' GROUP BY host ORDER BY requests DESC, host LIMIT 8
  `);
  const held = exists.get('oxylabs_holds')
    ? db.prepare('SELECT COALESCE(SUM(held), 0) AS held FROM oxylabs_holds WHERE expires_at > ?').get(now).held
    : 0;
  return {
    day: { ...day, ...between.get(day.from, day.to) },
    month: { ...month, ...between.get(month.from, month.to) },
    held,
    hosts: hosts.all(month.from, month.to),
  };
}

export function createLedger(db) {
  db.exec(LEDGER_TABLES);
  const sentSince = db.prepare('SELECT COUNT(*) AS sent FROM oxylabs_requests WHERE at >= ?');
  const heldNow = db.prepare('SELECT COALESCE(SUM(held), 0) AS held FROM oxylabs_holds WHERE expires_at > ?');
  const dropExpired = db.prepare('DELETE FROM oxylabs_holds WHERE expires_at <= ?');
  const addHold = db.prepare('INSERT INTO oxylabs_holds (operation, held, expires_at) VALUES (?, ?, ?) RETURNING id');
  const spendHold = db.prepare('UPDATE oxylabs_holds SET held = held - 1 WHERE id = ? AND held > 0 AND expires_at > ?');
  const dropHold = db.prepare('DELETE FROM oxylabs_holds WHERE id = ?');
  const addRequest = db.prepare(`
    INSERT INTO oxylabs_requests (at, operation, kind, host, ai) VALUES (?, ?, ?, ?, ?) RETURNING id
  `);
  const finishRequest = db.prepare('UPDATE oxylabs_requests SET ok = ?, ms = ? WHERE id = ?');

  // One step at a time, on this server and on any other that shares the database file.
  function atomically(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    /**
     * Holds `requests` against the day's and the month's budget before an operation starts. Requests already sent
     * and requests other operations are still holding both count. Answers { ticket }, or { refused } naming the
     * budget that cannot cover it and when that budget starts again.
     */
    reserve({ operation, requests, now, daily, monthly }) {
      return atomically(() => {
        dropExpired.run(now);
        const { held } = heldNow.get(now);
        // The month is checked first: when both are used up, "back tomorrow" would be untrue.
        if (sentSince.get(utcMonthStart(now)).sent + held + requests > monthly) {
          return { refused: { scope: 'month', resetAt: utcMonthStart(now, 1) } };
        }
        if (sentSince.get(utcDayStart(now)).sent + held + requests > daily) {
          return { refused: { scope: 'day', resetAt: utcDayStart(now) + DAY } };
        }
        const { id } = addHold.get(operation, requests, now + HOLD_LEASE);
        return {
          ticket: {
            operation,
            /**
             * Called just before one request leaves. It moves that request from the hold into the ledger, or throws
             * when the hold has nothing left, so an operation can never send more than it reserved. The function it
             * returns records how the request ended.
             */
            use({ kind, host, ai = false, at }) {
              const request = atomically(() => {
                if (!spendHold.run(id, at).changes) throw new Error(`This ${operation} has used every request it reserved.`);
                return addRequest.get(at, operation, kind, host, Number(ai)).id;
              });
              // The request is already counted. If writing how it ended fails, the count is still right.
              return (ok, ms) => {
                try {
                  finishRequest.run(Number(ok), Math.max(0, Math.round(ms)), request);
                } catch {
                  // Left unanswered in the ledger.
                }
              };
            },
            /** Hands back whatever the operation did not use. A hold that cannot be handed back runs out by itself. */
            release() {
              try {
                dropHold.run(id);
              } catch {
                // The lease ends it.
              }
            },
          },
        };
      });
    },
    totals: (now) => readLedger(db, now),
  };
}
