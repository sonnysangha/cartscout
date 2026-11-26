import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLedger } from './ledger.js';

const DISCOVERY_VERSION = 2;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const FREE_LIMIT = 5;
const SCAN_LEASE = 3 * 60_000;

// How long a saved scan answers before the shop is read again, counted from when its pages were read. A scan that
// read every source is good for a day whether or not it found a code; one that missed some sources for an hour.
export const SCAN_LIFETIME = { complete: DAY, partial: 60 * 60_000 };
// After a scan fails outright, the same shop is not tried again for this long.
export const FAILED_SCAN_WAIT = 10 * 60_000;
// Prices move faster than codes do.
export const LOOKUP_LIFETIME = { complete: 6 * 60 * 60_000, partial: 30 * 60_000 };

// A code that ends "on the 25th" is good until the 25th is over for every shopper, so its last day is read
// twelve hours behind UTC rather than cut off at midnight in London.
export const lastDayStillRunning = (now) => new Date(now - 12 * 3_600_000).toISOString().slice(0, 10);

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
    -- What the server last read about a shop, whoever asked for it. It holds public pages only: no member, no thumbs.
    -- A scan of the same shop by anyone else is answered from here while it is fresh.
    CREATE TABLE IF NOT EXISTS shop_scans (
      merchant TEXT PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
      coupons TEXT NOT NULL,
      seeded INTEGER NOT NULL DEFAULT 0 CHECK (seeded IN (0, 1)),
      discovery_version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scan_failures (
      merchant TEXT PRIMARY KEY,
      failed_at INTEGER NOT NULL,
      retry_at INTEGER NOT NULL
    );
    -- Price lookups are public prices, so one saved answer serves every member who asks for the same product.
    -- "pages" keeps how each retailer page went, so a retry only asks again for the ones that failed.
    CREATE TABLE IF NOT EXISTS lookups (
      merchant TEXT NOT NULL,
      country TEXT NOT NULL,
      name TEXT NOT NULL,
      variant TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      fresh_until INTEGER NOT NULL,
      partial INTEGER NOT NULL CHECK (partial IN (0, 1)),
      offers TEXT NOT NULL,
      pages TEXT NOT NULL,
      PRIMARY KEY (merchant, country, name, variant)
    );
  `);
  const ledger = createLedger(db);

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

  const shopScan = db.prepare('SELECT * FROM shop_scans WHERE merchant = ? AND discovery_version = ?');
  const shopScanByDomain = db.prepare(`
    SELECT * FROM shop_scans
    WHERE discovery_version = ? AND complete = 1 AND (merchant = ? OR merchant LIKE ?)
    ORDER BY fetched_at DESC
    LIMIT 1
  `);
  const saveShopScan = db.prepare(`
    INSERT INTO shop_scans (merchant, fetched_at, complete, coupons, seeded, discovery_version) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (merchant) DO UPDATE SET fetched_at = excluded.fetched_at, complete = excluded.complete,
      coupons = excluded.coupons, seeded = excluded.seeded, discovery_version = excluded.discovery_version
  `);
  // A shop's record is its latest read, with one exception: a read that missed some sources does not push out a
  // full read from the last day.
  function keepShopScan(merchant, result, fetchedAt, seeded = false) {
    const current = shopScan.get(merchant, DISCOVERY_VERSION);
    if (current && (fetchedAt < current.fetched_at
      || (current.complete && !result.complete && fetchedAt - current.fetched_at < SCAN_LIFETIME.complete))) return false;
    saveShopScan.run(merchant, fetchedAt, Number(result.complete), JSON.stringify(result.coupons), Number(seeded), DISCOVERY_VERSION);
    return true;
  }

  atomically(() => {
    const addColumn = (table, column, definition) => {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some(({ name }) => name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    };
    // Keep older codes and their reports, but rediscover public evidence before showing them.
    for (const table of ['searches', 'coupons']) addColumn(table, 'discovery_version', 'INTEGER NOT NULL DEFAULT 0');
    // "reused": the list was answered from pages read for an earlier scan. "seeded": a developer put it there by hand.
    addColumn('searches', 'reused', 'INTEGER NOT NULL DEFAULT 0');
    addColumn('searches', 'seeded', 'INTEGER NOT NULL DEFAULT 0');
    addColumn('coupons', 'seeded', 'INTEGER NOT NULL DEFAULT 0');
    addColumn('reports', 'saved_amount', 'REAL');
    addColumn('reports', 'saved_currency', 'TEXT');
    addColumn('reports', 'member_name', 'TEXT');
    // Codes are kept in one spelling, upper case. Fold rows saved in another spelling into it, thumbs included.
    // Where one member rated both spellings, their newer answer is the one that stays.
    db.exec(`
      INSERT OR IGNORE INTO coupons (merchant, code, offer, sources, expires_on, seen_at, discovery_version, seeded)
        SELECT merchant, upper(code), offer, sources, expires_on, seen_at, discovery_version, seeded
        FROM coupons WHERE code <> upper(code);
      DELETE FROM reports WHERE code <> upper(code) AND EXISTS (
        SELECT 1 FROM reports newer WHERE newer.merchant = reports.merchant AND newer.code = upper(reports.code)
          AND newer.reporter = reports.reporter AND newer.reported_at >= reports.reported_at
      );
      UPDATE OR REPLACE reports SET code = upper(code) WHERE code <> upper(code);
      DELETE FROM coupons WHERE code <> upper(code);
    `);
    // Scans saved before the server kept one record per shop: rebuild each shop's record from the saved lists, so a
    // shop somebody already scanned is not paid for again. A list's own scan is the codes saved in the same instant.
    if (!db.prepare('SELECT 1 FROM shop_scans LIMIT 1').get()) {
      const codes = db.prepare(`
        SELECT code, offer, sources, expires_on FROM coupons
        WHERE merchant = ? AND seen_at = ? AND discovery_version = ? ORDER BY code
      `);
      const saved = db.prepare(`
        SELECT merchant, refreshed_at, partial, seeded FROM searches
        WHERE discovery_version = ? AND reused = 0 ORDER BY refreshed_at
      `).all(DISCOVERY_VERSION);
      for (const { merchant, refreshed_at: at, partial, seeded } of saved) {
        const coupons = codes.all(merchant, at, DISCOVERY_VERSION).map((coupon) => ({
          code: coupon.code, offer: coupon.offer, sources: JSON.parse(coupon.sources), expiresOn: coupon.expires_on,
        }));
        // A Free member's list is saved under their own key; the shop it is about is the last part.
        keepShopScan(merchant.replace(/^private:[a-f0-9]{64}:/, ''), { coupons, complete: !partial }, at, !!seeded);
      }
    }
  });

  const search = db.prepare('SELECT * FROM searches WHERE merchant = ? AND discovery_version = ?');
  const saveSearch = db.prepare(`
    INSERT INTO searches (merchant, refreshed_at, retry_at, partial, discovery_version, reused, seeded)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (merchant) DO UPDATE SET
      refreshed_at = excluded.refreshed_at, retry_at = excluded.retry_at, partial = excluded.partial,
      discovery_version = excluded.discovery_version, reused = excluded.reused, seeded = excluded.seeded
  `);
  const saveCoupon = db.prepare(`
    INSERT INTO coupons (merchant, code, offer, sources, expires_on, seen_at, discovery_version, seeded)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (merchant, code) DO UPDATE SET offer = excluded.offer, sources = excluded.sources,
      expires_on = excluded.expires_on, seen_at = excluded.seen_at, discovery_version = excluded.discovery_version,
      seeded = excluded.seeded
  `);
  const failure = db.prepare('SELECT failed_at, retry_at FROM scan_failures WHERE merchant = ?');
  const saveFailure = db.prepare(`
    INSERT INTO scan_failures (merchant, failed_at, retry_at) VALUES (?, ?, ?)
    ON CONFLICT (merchant) DO UPDATE SET failed_at = excluded.failed_at, retry_at = excluded.retry_at
  `);
  const dropFailure = db.prepare('DELETE FROM scan_failures WHERE merchant = ?');
  const lookup = db.prepare('SELECT * FROM lookups WHERE merchant = ? AND country = ? AND name = ? AND variant = ?');
  const saveLookup = db.prepare(`
    INSERT INTO lookups (merchant, country, name, variant, fetched_at, fresh_until, partial, offers, pages)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (merchant, country, name, variant) DO UPDATE SET fetched_at = excluded.fetched_at,
      fresh_until = excluded.fresh_until, partial = excluded.partial, offers = excluded.offers, pages = excluded.pages
  `);
  // Totals count the last 30 days of thumbs, plus the member's own answer however old it is: the app takes that
  // answer back out to say what "others" found, so it has to be in the sum it is taken from.
  // The ranking runs outside the grouped query: inside it, a bare "worked" names the raw report column, not the total.
  const aggregate = db.prepare(`
    SELECT code, offer, sources, expiresOn, worked, failed, myReport, seeded FROM (
      SELECT c.code AS code, c.offer AS offer, c.sources AS sources, c.expires_on AS expiresOn, c.seen_at AS seenAt,
        c.seeded AS seeded,
        COALESCE(SUM(r.worked), 0) AS worked,
        COALESCE(SUM(1 - r.worked), 0) AS failed,
        MAX(CASE WHEN r.reporter = :reporter THEN r.worked END) AS myReport
      FROM coupons c LEFT JOIN reports r ON r.merchant = c.merchant AND r.code = c.code
        AND (r.reported_at >= :recent OR r.reporter = :reporter)
      WHERE c.merchant = :merchant AND c.seen_at >= :cutoff AND c.discovery_version = :version
        AND (c.expires_on IS NULL OR c.expires_on >= :today)
      GROUP BY c.code
    )
    ORDER BY (worked - failed) DESC, worked DESC, seenAt DESC, code
    LIMIT 24
  `);
  const report = db.prepare(`
    INSERT INTO reports (merchant, code, reporter, worked, reported_at, saved_amount, saved_currency, member_name)
    SELECT merchant, code, ?, ?, ?, ?, ?, ? FROM coupons
    WHERE merchant = ? AND code = ? AND seen_at >= ? AND discovery_version = ?
      AND (expires_on IS NULL OR expires_on >= ?)
    ON CONFLICT (merchant, code, reporter) DO UPDATE SET
      worked = excluded.worked,
      reported_at = excluded.reported_at,
      saved_amount = CASE WHEN excluded.worked = 1 THEN COALESCE(excluded.saved_amount, reports.saved_amount) ELSE NULL END,
      saved_currency = CASE WHEN excluded.worked = 1 THEN COALESCE(excluded.saved_currency, reports.saved_currency) ELSE NULL END,
      member_name = COALESCE(excluded.member_name, reports.member_name)
  `);

  const recentWinsQuery = db.prepare(`
    SELECT merchant, code, offer, savedAmount, savedCurrency, memberName, reportedAt, workedCount FROM (
      SELECT
        r.merchant AS merchant,
        r.code AS code,
        c.offer AS offer,
        MAX(CASE WHEN r.saved_amount > 0 THEN r.saved_amount END) AS savedAmount,
        MAX(CASE WHEN r.saved_amount > 0 THEN r.saved_currency END) AS savedCurrency,
        COALESCE(
          MAX(CASE WHEN r.saved_amount > 0 AND r.member_name IS NOT NULL THEN r.member_name END),
          MAX(r.member_name)
        ) AS memberName,
        MAX(r.reported_at) AS reportedAt,
        COUNT(*) AS workedCount
      FROM reports r
      JOIN coupons c ON c.merchant = r.merchant AND c.code = r.code
      WHERE r.worked = 1
        AND r.merchant NOT LIKE 'private:%'
        AND r.reported_at >= :recent
        AND c.discovery_version = :version
        AND (c.expires_on IS NULL OR c.expires_on >= :today)
      GROUP BY r.merchant, r.code
    )
    ORDER BY reportedAt DESC, workedCount DESC
    LIMIT :limit
  `);

  const winsCountQuery = db.prepare(`
    SELECT COUNT(*) AS total FROM (
      SELECT 1
      FROM reports r
      JOIN coupons c ON c.merchant = r.merchant AND c.code = r.code
      WHERE r.worked = 1
        AND r.merchant NOT LIKE 'private:%'
        AND r.reported_at >= :recent
        AND c.discovery_version = :version
        AND (c.expires_on IS NULL OR c.expires_on >= :today)
      GROUP BY r.merchant, r.code
    )
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
      today: lastDayStillRunning(now),
    }).map(({ sources, seeded, ...coupon }) => ({ ...coupon, sources: JSON.parse(sources), ...(seeded && { seeded: true }) }));
  }

  /**
   * Writes one scan's codes under a key. `fetchedAt` is when the pages were read, which is earlier than `now` when
   * the answer comes from a read made for someone else. The list stays fresh for its lifetime after `freshFrom`.
   */
  function writeScan(merchant, { coupons, complete }, now, reservation, { fetchedAt = now, freshFrom = fetchedAt, reused = false, seeded = false } = {}) {
    const ttl = complete ? SCAN_LIFETIME.complete : SCAN_LIFETIME.partial;
    for (const coupon of coupons) {
      saveCoupon.run(merchant, coupon.code.toUpperCase(), coupon.offer, JSON.stringify(coupon.sources), coupon.expiresOn, now, DISCOVERY_VERSION, Number(seeded));
    }
    saveSearch.run(merchant, fetchedAt, freshFrom + ttl, Number(!complete), DISCOVERY_VERSION, Number(reused), Number(seeded));
    if (reservation) completeScan.run(reservation);
  }

  return {
    get: (merchant) => search.get(merchant, DISCOVERY_VERSION),
    listing,
    ledger,
    /** What the server last read about a shop: { result, fetchedAt, seeded }. */
    shopScan(merchant) {
      const row = shopScan.get(merchant, DISCOVERY_VERSION);
      return row && {
        result: { coupons: JSON.parse(row.coupons), complete: !!row.complete },
        fetchedAt: row.fetched_at,
        seeded: !!row.seeded,
      };
    },
    /** Freshest complete scan on the same registrable brand domain (e.g. `ridge.com` covering `uk.ridge.com`). */
    shopScanByDomain(domain) {
      const row = shopScanByDomain.get(DISCOVERY_VERSION, domain, `%.${domain}`);
      return row && {
        result: { coupons: JSON.parse(row.coupons), complete: !!row.complete },
        fetchedAt: row.fetched_at,
        seeded: !!row.seeded,
      };
    },
    saveShopScan: (merchant, result, now) => keepShopScan(merchant, result, now),
    scanFailure: (merchant) => failure.get(merchant),
    markScanFailure(merchant, now) {
      saveFailure.run(merchant, now, now + FAILED_SCAN_WAIT);
    },
    clearScanFailure(merchant) {
      dropFailure.run(merchant);
    },
    /** A saved price lookup for one product at one shop in one country, whichever member asked first. */
    lookup(merchant, country, item) {
      const row = lookup.get(merchant, country, item.name.toLowerCase(), item.variant.toLowerCase());
      return row && {
        fetchedAt: row.fetched_at, freshUntil: row.fresh_until, partial: !!row.partial,
        offers: JSON.parse(row.offers), pages: JSON.parse(row.pages),
      };
    },
    saveLookup(merchant, country, item, { offers, partial, pages }, { fetchedAt, freshUntil }) {
      saveLookup.run(merchant, country, item.name.toLowerCase(), item.variant.toLowerCase(), fetchedAt, freshUntil,
        Number(partial), JSON.stringify(offers), JSON.stringify(pages));
    },
    /**
     * Puts codes for a shop into the database without a scan, for test rigs and local development. The shop's
     * record, the shared list and every code it writes are marked as seeded.
     */
    seedScan(merchant, coupons, now) {
      const result = { coupons, complete: true };
      atomically(() => {
        saveShopScan.run(merchant, now, 1, JSON.stringify(coupons), 1, DISCOVERY_VERSION);
        dropFailure.run(merchant);
        writeScan(merchant, result, now, null, { seeded: true });
      });
    },
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
    save(merchant, result, now, reservation, origin) {
      atomically(() => writeScan(merchant, result, now, reservation, origin));
    },
    report(merchant, code, reporter, worked, now, saving) {
      const amount = worked && Number.isFinite(saving?.amount) && saving.amount > 0 && saving.amount <= 100_000
        ? Math.round(saving.amount * 100) / 100
        : null;
      const currency = amount !== null && typeof saving?.currency === 'string' && /^[A-Z]{3}$/.test(saving.currency)
        ? saving.currency
        : null;
      const rawHandle = typeof saving?.memberName === 'string' ? saving.memberName.trim().replace(/^@+/, '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 20) : '';
      const memberName = rawHandle ? `@${rawHandle.toLowerCase()}` : null;
      return report.run(
        reporter, Number(worked), now, amount, currency, memberName,
        merchant, code.toUpperCase(), now - 7 * DAY, DISCOVERY_VERSION, lastDayStillRunning(now),
      ).changes > 0;
    },
    recentWins(now, limit = 12) {
      return recentWinsQuery.all({
        recent: now - 30 * DAY,
        version: DISCOVERY_VERSION,
        today: lastDayStillRunning(now),
        limit: Math.max(1, Math.min(24, Number(limit) || 12)),
      });
    },
    winsCount(now) {
      return winsCountQuery.get({
        recent: now - 30 * DAY,
        version: DISCOVERY_VERSION,
        today: lastDayStillRunning(now),
      })?.total ?? 0;
    },
    close: () => db.close(),
  };
}
