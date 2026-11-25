import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DISCOVERY_VERSION = 2;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const FREE_LIMIT = 5;
const SCAN_LEASE = 3 * 60_000;

function startOfScanWeek(now) {
  const day = Math.floor(now / DAY);
  // 1970-01-01 was a Thursday. Count from Monday at 00:00 UTC.
  return (day - (((day + 3) % 7 + 7) % 7)) * DAY;
}

export function reporterKey(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS searches (
      merchant TEXT PRIMARY KEY,
      refreshed_at INTEGER NOT NULL,
      retry_at INTEGER NOT NULL,
      partial INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS coupons (
      merchant TEXT NOT NULL,
      code TEXT NOT NULL,
      offer TEXT NOT NULL,
      sources TEXT NOT NULL,
      expires_on TEXT,
      seen_at INTEGER NOT NULL,
      PRIMARY KEY (merchant, code)
    );
    CREATE TABLE IF NOT EXISTS reports (
      merchant TEXT NOT NULL,
      code TEXT NOT NULL,
      reporter TEXT NOT NULL,
      worked INTEGER NOT NULL CHECK (worked IN (0, 1)),
      reported_at INTEGER NOT NULL,
      PRIMARY KEY (merchant, code, reporter),
      FOREIGN KEY (merchant, code) REFERENCES coupons (merchant, code)
    );
    CREATE TABLE IF NOT EXISTS free_site_scans (
      id TEXT PRIMARY KEY,
      reporter TEXT NOT NULL,
      week_start INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1))
    );
    CREATE INDEX IF NOT EXISTS free_site_scans_by_user_week
      ON free_site_scans (reporter, week_start, complete, started_at);
  `);

  // Keep older codes and their reports, but rediscover public evidence before showing them.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of ['searches', 'coupons']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some(({ name }) => name === 'discovery_version')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN discovery_version INTEGER NOT NULL DEFAULT 0`);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const search = db.prepare('SELECT * FROM searches WHERE merchant = ? AND discovery_version = ?');
  const saveSearch = db.prepare(`
    INSERT INTO searches VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (merchant) DO UPDATE SET
      refreshed_at = excluded.refreshed_at, retry_at = excluded.retry_at, partial = excluded.partial,
      discovery_version = excluded.discovery_version
  `);
  const saveCoupon = db.prepare(`
    INSERT INTO coupons VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (merchant, code) DO UPDATE SET offer = excluded.offer, sources = excluded.sources,
      expires_on = excluded.expires_on, seen_at = excluded.seen_at, discovery_version = excluded.discovery_version
  `);
  // Older personal votes are shown in the UI but should not affect recent totals.
  const aggregate = db.prepare(`
    SELECT c.code, c.offer, c.sources, c.expires_on AS expiresOn,
      COALESCE(SUM(CASE WHEN r.reported_at >= :recent THEN r.worked END), 0) AS worked,
      COALESCE(SUM(CASE WHEN r.reported_at >= :recent THEN 1 - r.worked END), 0) AS failed,
      MAX(CASE WHEN r.reporter = :reporter THEN r.worked END) AS myReport
    FROM coupons c LEFT JOIN reports r ON r.merchant = c.merchant AND r.code = c.code
      AND (r.reported_at >= :recent OR r.reporter = :reporter)
    WHERE c.merchant = :merchant AND c.seen_at >= :cutoff AND c.discovery_version = :version
      AND (c.expires_on IS NULL OR c.expires_on >= :today)
    GROUP BY c.code
    ORDER BY (worked - failed) DESC, worked DESC, c.seen_at DESC, c.code
    LIMIT 24
  `);
  const report = db.prepare(`
    INSERT INTO reports (merchant, code, reporter, worked, reported_at)
    SELECT merchant, code, ?, ?, ? FROM coupons
    WHERE merchant = ? AND code = ? AND seen_at >= ? AND discovery_version = ?
      AND (expires_on IS NULL OR expires_on >= ?)
    ON CONFLICT (merchant, code, reporter) DO UPDATE SET
      worked = excluded.worked, reported_at = excluded.reported_at
  `);

  const countScans = db.prepare(`
    SELECT COUNT(*) AS used FROM free_site_scans
    WHERE reporter = ? AND week_start = ? AND (complete = 1 OR started_at > ?)
  `);
  const reserveScan = db.prepare(`
    INSERT INTO free_site_scans (id, reporter, week_start, started_at)
    SELECT :id, :reporter, :week, :started
    WHERE (SELECT COUNT(*) FROM free_site_scans
      WHERE reporter = :reporter AND week_start = :week AND (complete = 1 OR started_at > :cutoff)) < :limit
    RETURNING id
  `);
  const releaseScan = db.prepare('DELETE FROM free_site_scans WHERE id = ? AND complete = 0');
  const completeScan = db.prepare('UPDATE free_site_scans SET complete = 1 WHERE id = ? AND complete = 0');

  function listing(merchant, reporter, now) {
    return aggregate.all({
      reporter, merchant, version: DISCOVERY_VERSION, recent: now - 30 * DAY, cutoff: now - 7 * DAY,
      today: new Date(now).toISOString().slice(0, 10),
    }).map(({ sources, ...coupon }) => ({ ...coupon, sources: JSON.parse(sources) }));
  }

  return {
    get: (merchant) => search.get(merchant, DISCOVERY_VERSION),
    listing,
    weeklyScans(reporter, now) {
      const week = startOfScanWeek(now);
      const { used } = countScans.get(reporter, week, now - SCAN_LEASE);
      return { used, limit: FREE_LIMIT, remaining: Math.max(0, FREE_LIMIT - used), resetsAt: new Date(week + WEEK).toISOString() };
    },
    reserveScan(reporter, now) {
      return reserveScan.get({
        id: randomUUID(), reporter, week: startOfScanWeek(now), started: now,
        cutoff: now - SCAN_LEASE, limit: FREE_LIMIT,
      })?.id;
    },
    releaseScan: (reservation) => releaseScan.run(reservation),
    save(merchant, { coupons, complete }, now, reservation) {
      const ttl = !complete ? 10 * 60_000 : coupons.length ? DAY : 2 * 60 * 60_000;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const coupon of coupons) {
          saveCoupon.run(merchant, coupon.code, coupon.offer, JSON.stringify(coupon.sources), coupon.expiresOn, now, DISCOVERY_VERSION);
        }
        saveSearch.run(merchant, now, now + ttl, Number(!complete), DISCOVERY_VERSION);
        if (reservation) completeScan.run(reservation);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    report(merchant, code, reporter, worked, now) {
      return report.run(reporter, Number(worked), now, merchant, code, now - 7 * DAY, DISCOVERY_VERSION,
        new Date(now).toISOString().slice(0, 10)).changes > 0;
    },
    close: () => db.close(),
  };
}
