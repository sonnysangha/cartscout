import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DAY = 86_400_000;

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
  `);

  const search = db.prepare('SELECT * FROM searches WHERE merchant = ?');
  const saveSearch = db.prepare(`
    INSERT INTO searches VALUES (?, ?, ?, ?)
    ON CONFLICT (merchant) DO UPDATE SET
      refreshed_at = excluded.refreshed_at, retry_at = excluded.retry_at, partial = excluded.partial
  `);
  const saveCoupon = db.prepare(`
    INSERT INTO coupons VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (merchant, code) DO UPDATE SET offer = excluded.offer, sources = excluded.sources,
      expires_on = excluded.expires_on, seen_at = excluded.seen_at
  `);
  // Older personal votes are shown in the UI but should not affect recent totals.
  const aggregate = db.prepare(`
    SELECT c.code, c.offer, c.sources, c.expires_on AS expiresOn,
      COALESCE(SUM(CASE WHEN r.reported_at >= :recent THEN r.worked END), 0) AS worked,
      COALESCE(SUM(CASE WHEN r.reported_at >= :recent THEN 1 - r.worked END), 0) AS failed,
      MAX(CASE WHEN r.reporter = :reporter THEN r.worked END) AS myReport
    FROM coupons c LEFT JOIN reports r ON r.merchant = c.merchant AND r.code = c.code
      AND (r.reported_at >= :recent OR r.reporter = :reporter)
    WHERE c.merchant = :merchant AND c.seen_at >= :cutoff
      AND (c.expires_on IS NULL OR c.expires_on >= :today)
    GROUP BY c.code
    ORDER BY (worked - failed) DESC, worked DESC, c.seen_at DESC, c.code
    LIMIT 24
  `);
  const report = db.prepare(`
    INSERT INTO reports (merchant, code, reporter, worked, reported_at)
    SELECT merchant, code, ?, ?, ? FROM coupons
    WHERE merchant = ? AND code = ? AND seen_at >= ?
      AND (expires_on IS NULL OR expires_on >= ?)
    ON CONFLICT (merchant, code, reporter) DO UPDATE SET
      worked = excluded.worked, reported_at = excluded.reported_at
  `);

  function listing(merchant, reporter, now) {
    return aggregate.all({
      reporter, merchant, recent: now - 30 * DAY, cutoff: now - 7 * DAY,
      today: new Date(now).toISOString().slice(0, 10),
    }).map(({ sources, ...coupon }) => ({ ...coupon, sources: JSON.parse(sources) }));
  }

  return {
    get: (merchant) => search.get(merchant),
    listing,
    save(merchant, { coupons, complete }, now) {
      const ttl = !complete ? 10 * 60_000 : coupons.length ? DAY : 2 * 60 * 60_000;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const coupon of coupons) {
          saveCoupon.run(merchant, coupon.code, coupon.offer, JSON.stringify(coupon.sources), coupon.expiresOn, now);
        }
        saveSearch.run(merchant, now, now + ttl, Number(!complete));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    report(merchant, code, reporter, worked, now) {
      return report.run(reporter, Number(worked), now, merchant, code, now - 7 * DAY,
        new Date(now).toISOString().slice(0, 10)).changes > 0;
    },
    close: () => db.close(),
  };
}
