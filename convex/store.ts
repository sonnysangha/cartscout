import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  couponItemValidator,
  lookupPageValidator,
  offerItemValidator,
} from "./schema";

const DISCOVERY_VERSION = 2;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const FREE_LIMIT = 5;
const SCAN_LEASE = 3 * 60_000;
const SCAN_LIFETIME = { complete: DAY, partial: 60 * 60_000 };
const FAILED_SCAN_WAIT = 10 * 60_000;

function lastDayStillRunning(now: number): string {
  return new Date(now - 12 * 3_600_000).toISOString().slice(0, 10);
}

function startOfScanWeek(now: number): number {
  const day = Math.floor(now / DAY);
  return (day - (((day + 3) % 7 + 7) % 7)) * DAY;
}

const searchReturnValidator = v.union(
  v.object({
    merchant: v.string(),
    refreshed_at: v.number(),
    retry_at: v.number(),
    partial: v.number(),
    discovery_version: v.number(),
    reused: v.number(),
    seeded: v.number(),
  }),
  v.null(),
);

const shopScanReturnValidator = v.union(
  v.object({
    result: v.object({
      coupons: v.array(couponItemValidator),
      complete: v.boolean(),
    }),
    fetchedAt: v.number(),
    seeded: v.boolean(),
  }),
  v.null(),
);

const listingItemValidator = v.object({
  code: v.string(),
  offer: v.string(),
  sources: v.array(v.string()),
  expiresOn: v.union(v.string(), v.null()),
  worked: v.number(),
  failed: v.number(),
  myReport: v.union(v.number(), v.null()),
  seeded: v.optional(v.boolean()),
});

const winItemValidator = v.object({
  merchant: v.string(),
  code: v.string(),
  offer: v.string(),
  savedAmount: v.union(v.number(), v.null()),
  savedCurrency: v.union(v.string(), v.null()),
  memberName: v.union(v.string(), v.null()),
  reportedAt: v.number(),
  workedCount: v.number(),
});

async function writeScanHelper(
  ctx: MutationCtx,
  args: {
    merchant: string;
    coupons: Array<{
      code: string;
      offer: string;
      sources: string[];
      expiresOn: string | null;
    }>;
    complete: boolean;
    now: number;
    reservation: string | null;
    fetchedAt: number;
    freshFrom: number;
    reused: boolean;
    seeded: boolean;
  },
) {
  const ttl = args.complete ? SCAN_LIFETIME.complete : SCAN_LIFETIME.partial;
  for (const coupon of args.coupons) {
    const code = coupon.code.toUpperCase();
    const existing = await ctx.db
      .query("coupons")
      .withIndex("by_merchant_and_code", (q) =>
        q.eq("merchant", args.merchant).eq("code", code),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        offer: coupon.offer,
        sources: coupon.sources,
        expiresOn: coupon.expiresOn,
        seenAt: args.now,
        discoveryVersion: DISCOVERY_VERSION,
        seeded: args.seeded,
      });
    } else {
      await ctx.db.insert("coupons", {
        merchant: args.merchant,
        code,
        offer: coupon.offer,
        sources: coupon.sources,
        expiresOn: coupon.expiresOn,
        seenAt: args.now,
        discoveryVersion: DISCOVERY_VERSION,
        seeded: args.seeded,
      });
    }
  }

  const existingSearch = await ctx.db
    .query("searches")
    .withIndex("by_merchant_and_discoveryVersion", (q) =>
      q.eq("merchant", args.merchant).eq("discoveryVersion", DISCOVERY_VERSION),
    )
    .unique();
  const searchDoc = {
    merchant: args.merchant,
    refreshedAt: args.fetchedAt,
    retryAt: args.freshFrom + ttl,
    partial: !args.complete,
    discoveryVersion: DISCOVERY_VERSION,
    reused: args.reused,
    seeded: args.seeded,
  };
  if (existingSearch) {
    await ctx.db.patch(existingSearch._id, searchDoc);
  } else {
    await ctx.db.insert("searches", searchDoc);
  }

  if (args.reservation) {
    const scan = await ctx.db
      .query("free_site_scans")
      .withIndex("by_scanId", (q) => q.eq("scanId", args.reservation!))
      .unique();
    if (scan && !scan.complete) {
      await ctx.db.patch(scan._id, { complete: true });
    }
  }
}

async function computeRecentWins(
  ctx: QueryCtx,
  now: number,
  limit: number,
) {
  const recent = now - 30 * DAY;
  const today = lastDayStillRunning(now);
  const rows = await ctx.db
    .query("reports")
    .withIndex("by_worked_and_reportedAt", (q) =>
      q.eq("worked", true).gte("reportedAt", recent),
    )
    .order("desc")
    .take(300);

  const grouped = new Map<
    string,
    {
      merchant: string;
      code: string;
      savedAmount: number | null;
      savedCurrency: string | null;
      memberName: string | null;
      fallbackMember: string | null;
      reportedAt: number;
      workedCount: number;
    }
  >();

  for (const r of rows) {
    if (r.merchant.startsWith("private:")) continue;
    const key = `${r.merchant}\0${r.code}`;
    const cur = grouped.get(key);
    const hasSaving = r.savedAmount !== null && r.savedAmount > 0;
    if (!cur) {
      grouped.set(key, {
        merchant: r.merchant,
        code: r.code,
        savedAmount: hasSaving ? r.savedAmount : null,
        savedCurrency: hasSaving ? r.savedCurrency : null,
        memberName: hasSaving && r.memberName ? r.memberName : null,
        fallbackMember: r.memberName,
        reportedAt: r.reportedAt,
        workedCount: 1,
      });
    } else {
      cur.workedCount += 1;
      if (r.reportedAt > cur.reportedAt) cur.reportedAt = r.reportedAt;
      if (
        hasSaving &&
        (cur.savedAmount === null || (r.savedAmount ?? 0) > cur.savedAmount)
      ) {
        cur.savedAmount = r.savedAmount;
        cur.savedCurrency = r.savedCurrency;
        if (r.memberName) cur.memberName = r.memberName;
      }
      if (!cur.fallbackMember && r.memberName) cur.fallbackMember = r.memberName;
    }
  }

  const wins: Array<{
    merchant: string;
    code: string;
    offer: string;
    savedAmount: number | null;
    savedCurrency: string | null;
    memberName: string | null;
    reportedAt: number;
    workedCount: number;
  }> = [];

  for (const item of grouped.values()) {
    const coupon = await ctx.db
      .query("coupons")
      .withIndex("by_merchant_and_code", (q) =>
        q.eq("merchant", item.merchant).eq("code", item.code),
      )
      .unique();
    if (!coupon || coupon.discoveryVersion !== DISCOVERY_VERSION) continue;
    if (coupon.expiresOn !== null && coupon.expiresOn < today) continue;
    wins.push({
      merchant: item.merchant,
      code: item.code,
      offer: coupon.offer,
      savedAmount: item.savedAmount,
      savedCurrency: item.savedCurrency,
      memberName: item.memberName ?? item.fallbackMember,
      reportedAt: item.reportedAt,
      workedCount: item.workedCount,
    });
  }

  wins.sort(
    (a, b) => b.reportedAt - a.reportedAt || b.workedCount - a.workedCount,
  );
  return wins.slice(0, Math.min(Math.max(limit, 1), 30));
}

export const getSearch = internalQuery({
  args: { merchant: v.string() },
  returns: searchReturnValidator,
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("searches")
      .withIndex("by_merchant_and_discoveryVersion", (q) =>
        q
          .eq("merchant", args.merchant)
          .eq("discoveryVersion", DISCOVERY_VERSION),
      )
      .unique();
    if (!row) return null;
    return {
      merchant: row.merchant,
      refreshed_at: row.refreshedAt,
      retry_at: row.retryAt,
      partial: row.partial ? 1 : 0,
      discovery_version: row.discoveryVersion,
      reused: row.reused ? 1 : 0,
      seeded: row.seeded ? 1 : 0,
    };
  },
});

export const listing = internalQuery({
  args: {
    merchant: v.string(),
    reporter: v.string(),
    now: v.number(),
  },
  returns: v.array(listingItemValidator),
  handler: async (ctx, args) => {
    const recent = args.now - 30 * DAY;
    const cutoff = args.now - 7 * DAY;
    const today = lastDayStillRunning(args.now);

    const rows = await ctx.db
      .query("coupons")
      .withIndex("by_merchant_and_discoveryVersion", (q) =>
        q
          .eq("merchant", args.merchant)
          .eq("discoveryVersion", DISCOVERY_VERSION),
      )
      .take(100);

    const eligible = rows.filter(
      (c) =>
        c.seenAt >= cutoff && (c.expiresOn === null || c.expiresOn >= today),
    );

    const results: Array<{
      code: string;
      offer: string;
      sources: string[];
      expiresOn: string | null;
      worked: number;
      failed: number;
      myReport: number | null;
      seenAt: number;
      seeded?: boolean;
    }> = [];
    for (const c of eligible) {
      const reports = await ctx.db
        .query("reports")
        .withIndex("by_merchant_and_code", (q) =>
          q.eq("merchant", args.merchant).eq("code", c.code),
        )
        .take(500);
      let worked = 0;
      let failed = 0;
      let myReport: number | null = null;
      for (const r of reports) {
        if (r.reportedAt >= recent || r.reporter === args.reporter) {
          if (r.worked) worked += 1;
          else failed += 1;
          if (r.reporter === args.reporter) myReport = r.worked ? 1 : 0;
        }
      }
      results.push({
        code: c.code,
        offer: c.offer,
        sources: c.sources,
        expiresOn: c.expiresOn,
        worked,
        failed,
        myReport,
        seenAt: c.seenAt,
        ...(c.seeded ? { seeded: true } : {}),
      });
    }

    results.sort(
      (a, b) =>
        b.worked - b.failed - (a.worked - a.failed) ||
        b.worked - a.worked ||
        b.seenAt - a.seenAt ||
        a.code.localeCompare(b.code),
    );

    return results.slice(0, 24).map(({ seenAt: _seenAt, ...rest }) => rest);
  },
});

export const shopScan = internalQuery({
  args: { merchant: v.string() },
  returns: shopScanReturnValidator,
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("shop_scans")
      .withIndex("by_merchant_and_discoveryVersion", (q) =>
        q
          .eq("merchant", args.merchant)
          .eq("discoveryVersion", DISCOVERY_VERSION),
      )
      .unique();
    if (!row) return null;
    return {
      result: { coupons: row.coupons, complete: row.complete },
      fetchedAt: row.fetchedAt,
      seeded: row.seeded,
    };
  },
});

export const shopScanByDomain = internalQuery({
  args: { domain: v.string() },
  returns: shopScanReturnValidator,
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("shop_scans")
      .withIndex("by_domain_and_discoveryVersion_and_complete_and_fetchedAt", (q) =>
        q
          .eq("domain", args.domain)
          .eq("discoveryVersion", DISCOVERY_VERSION)
          .eq("complete", true),
      )
      .order("desc")
      .first();
    if (!row) return null;
    return {
      result: { coupons: row.coupons, complete: row.complete },
      fetchedAt: row.fetchedAt,
      seeded: row.seeded,
    };
  },
});

export const saveShopScan = internalMutation({
  args: {
    merchant: v.string(),
    domain: v.union(v.string(), v.null()),
    coupons: v.array(couponItemValidator),
    complete: v.boolean(),
    fetchedAt: v.number(),
    seeded: v.boolean(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const current = await ctx.db
      .query("shop_scans")
      .withIndex("by_merchant_and_discoveryVersion", (q) =>
        q
          .eq("merchant", args.merchant)
          .eq("discoveryVersion", DISCOVERY_VERSION),
      )
      .unique();
    if (
      current &&
      (args.fetchedAt < current.fetchedAt ||
        (current.complete &&
          !args.complete &&
          args.fetchedAt - current.fetchedAt < SCAN_LIFETIME.complete))
    ) {
      return false;
    }
    const doc = {
      merchant: args.merchant,
      domain: args.domain,
      fetchedAt: args.fetchedAt,
      complete: args.complete,
      coupons: args.coupons,
      seeded: args.seeded,
      discoveryVersion: DISCOVERY_VERSION,
    };
    if (current) {
      await ctx.db.patch(current._id, doc);
    } else {
      await ctx.db.insert("shop_scans", doc);
    }
    return true;
  },
});

export const scanFailure = internalQuery({
  args: { merchant: v.string() },
  returns: v.union(
    v.object({ failed_at: v.number(), retry_at: v.number() }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("scan_failures")
      .withIndex("by_merchant", (q) => q.eq("merchant", args.merchant))
      .unique();
    return row ? { failed_at: row.failedAt, retry_at: row.retryAt } : null;
  },
});

export const markScanFailure = internalMutation({
  args: { merchant: v.string(), now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("scan_failures")
      .withIndex("by_merchant", (q) => q.eq("merchant", args.merchant))
      .unique();
    const doc = {
      merchant: args.merchant,
      failedAt: args.now,
      retryAt: args.now + FAILED_SCAN_WAIT,
    };
    if (row) await ctx.db.patch(row._id, doc);
    else await ctx.db.insert("scan_failures", doc);
    return null;
  },
});

export const clearScanFailure = internalMutation({
  args: { merchant: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("scan_failures")
      .withIndex("by_merchant", (q) => q.eq("merchant", args.merchant))
      .unique();
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

export const getLookup = internalQuery({
  args: {
    merchant: v.string(),
    country: v.string(),
    name: v.string(),
    variant: v.string(),
  },
  returns: v.union(
    v.object({
      fetchedAt: v.number(),
      freshUntil: v.number(),
      partial: v.boolean(),
      offers: v.array(offerItemValidator),
      pages: v.array(lookupPageValidator),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("lookups")
      .withIndex("by_merchant_and_country_and_name_and_variant", (q) =>
        q
          .eq("merchant", args.merchant)
          .eq("country", args.country)
          .eq("name", args.name.toLowerCase())
          .eq("variant", args.variant.toLowerCase()),
      )
      .unique();
    if (!row) return null;
    return {
      fetchedAt: row.fetchedAt,
      freshUntil: row.freshUntil,
      partial: row.partial,
      offers: row.offers,
      pages: row.pages,
    };
  },
});

export const saveLookup = internalMutation({
  args: {
    merchant: v.string(),
    country: v.string(),
    name: v.string(),
    variant: v.string(),
    fetchedAt: v.number(),
    freshUntil: v.number(),
    partial: v.boolean(),
    offers: v.array(offerItemValidator),
    pages: v.array(lookupPageValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const name = args.name.toLowerCase();
    const variant = args.variant.toLowerCase();
    const row = await ctx.db
      .query("lookups")
      .withIndex("by_merchant_and_country_and_name_and_variant", (q) =>
        q
          .eq("merchant", args.merchant)
          .eq("country", args.country)
          .eq("name", name)
          .eq("variant", variant),
      )
      .unique();
    const doc = {
      merchant: args.merchant,
      country: args.country,
      name,
      variant,
      fetchedAt: args.fetchedAt,
      freshUntil: args.freshUntil,
      partial: args.partial,
      offers: args.offers,
      pages: args.pages,
    };
    if (row) await ctx.db.patch(row._id, doc);
    else await ctx.db.insert("lookups", doc);
    return null;
  },
});

export const seedScan = internalMutation({
  args: {
    merchant: v.string(),
    domain: v.union(v.string(), v.null()),
    coupons: v.array(couponItemValidator),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const current = await ctx.db
      .query("shop_scans")
      .withIndex("by_merchant_and_discoveryVersion", (q) =>
        q
          .eq("merchant", args.merchant)
          .eq("discoveryVersion", DISCOVERY_VERSION),
      )
      .unique();
    const doc = {
      merchant: args.merchant,
      domain: args.domain,
      fetchedAt: args.now,
      complete: true,
      coupons: args.coupons,
      seeded: true,
      discoveryVersion: DISCOVERY_VERSION,
    };
    if (current) await ctx.db.patch(current._id, doc);
    else await ctx.db.insert("shop_scans", doc);

    const failure = await ctx.db
      .query("scan_failures")
      .withIndex("by_merchant", (q) => q.eq("merchant", args.merchant))
      .unique();
    if (failure) await ctx.db.delete(failure._id);

    await writeScanHelper(ctx, {
      merchant: args.merchant,
      coupons: args.coupons,
      complete: true,
      now: args.now,
      reservation: null,
      fetchedAt: args.now,
      freshFrom: args.now,
      reused: false,
      seeded: true,
    });
    return null;
  },
});

export const weeklyScans = internalQuery({
  args: { reporter: v.string(), now: v.number() },
  returns: v.object({
    used: v.number(),
    limit: v.number(),
    remaining: v.number(),
    resetsAt: v.string(),
  }),
  handler: async (ctx, args) => {
    const week = startOfScanWeek(args.now);
    const cutoff = args.now - SCAN_LEASE;
    const rows = await ctx.db
      .query("free_site_scans")
      .withIndex("by_reporter_and_weekStart", (q) =>
        q.eq("reporter", args.reporter).eq("weekStart", week),
      )
      .take(50);
    const used = rows.filter((r) => r.complete || r.startedAt > cutoff).length;
    return {
      used,
      limit: FREE_LIMIT,
      remaining: Math.max(0, FREE_LIMIT - used),
      resetsAt: new Date(week + WEEK).toISOString(),
    };
  },
});

export const reserveScan = internalMutation({
  args: {
    scanId: v.string(),
    reporter: v.string(),
    now: v.number(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const week = startOfScanWeek(args.now);
    const cutoff = args.now - SCAN_LEASE;
    const rows = await ctx.db
      .query("free_site_scans")
      .withIndex("by_reporter_and_weekStart", (q) =>
        q.eq("reporter", args.reporter).eq("weekStart", week),
      )
      .take(50);
    const used = rows.filter((r) => r.complete || r.startedAt > cutoff).length;
    if (used >= FREE_LIMIT) return null;
    await ctx.db.insert("free_site_scans", {
      scanId: args.scanId,
      reporter: args.reporter,
      weekStart: week,
      startedAt: args.now,
      complete: false,
    });
    return args.scanId;
  },
});

export const releaseScan = internalMutation({
  args: { scanId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("free_site_scans")
      .withIndex("by_scanId", (q) => q.eq("scanId", args.scanId))
      .unique();
    if (row && !row.complete) await ctx.db.delete(row._id);
    return null;
  },
});

export const saveScan = internalMutation({
  args: {
    merchant: v.string(),
    coupons: v.array(couponItemValidator),
    complete: v.boolean(),
    now: v.number(),
    reservation: v.union(v.string(), v.null()),
    fetchedAt: v.number(),
    freshFrom: v.number(),
    reused: v.boolean(),
    seeded: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await writeScanHelper(ctx, args);
    return null;
  },
});

export const recordReport = internalMutation({
  args: {
    merchant: v.string(),
    code: v.string(),
    reporter: v.string(),
    worked: v.boolean(),
    now: v.number(),
    savedAmount: v.union(v.number(), v.null()),
    savedCurrency: v.union(v.string(), v.null()),
    memberName: v.union(v.string(), v.null()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const code = args.code.toUpperCase();
    const today = lastDayStillRunning(args.now);
    const cutoff = args.now - 7 * DAY;
    const coupon = await ctx.db
      .query("coupons")
      .withIndex("by_merchant_and_code", (q) =>
        q.eq("merchant", args.merchant).eq("code", code),
      )
      .unique();
    if (
      !coupon ||
      coupon.discoveryVersion !== DISCOVERY_VERSION ||
      coupon.seenAt < cutoff ||
      (coupon.expiresOn !== null && coupon.expiresOn < today)
    ) {
      return false;
    }

    const amount =
      args.worked &&
      args.savedAmount !== null &&
      Number.isFinite(args.savedAmount) &&
      args.savedAmount > 0 &&
      args.savedAmount <= 100_000
        ? Math.round(args.savedAmount * 100) / 100
        : null;
    const currency =
      amount !== null &&
      args.savedCurrency !== null &&
      /^[A-Z]{3}$/.test(args.savedCurrency)
        ? args.savedCurrency
        : null;
    const rawHandle = args.memberName
      ? args.memberName
          .trim()
          .replace(/^@+/, "")
          .replace(/[^a-zA-Z0-9._-]/g, "")
          .slice(0, 20)
      : "";
    const memberName = rawHandle ? `@${rawHandle.toLowerCase()}` : null;

    const existing = await ctx.db
      .query("reports")
      .withIndex("by_merchant_and_code_and_reporter", (q) =>
        q
          .eq("merchant", args.merchant)
          .eq("code", code)
          .eq("reporter", args.reporter),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        worked: args.worked,
        reportedAt: args.now,
        savedAmount: args.worked ? (amount ?? existing.savedAmount) : null,
        savedCurrency: args.worked
          ? (currency ?? existing.savedCurrency)
          : null,
        memberName: memberName ?? existing.memberName,
      });
    } else {
      await ctx.db.insert("reports", {
        merchant: args.merchant,
        code,
        reporter: args.reporter,
        worked: args.worked,
        reportedAt: args.now,
        savedAmount: amount,
        savedCurrency: currency,
        memberName,
      });
    }
    return true;
  },
});

export const recentWins = internalQuery({
  args: { now: v.number(), limit: v.number() },
  returns: v.array(winItemValidator),
  handler: async (ctx, args) => {
    return await computeRecentWins(ctx, args.now, args.limit);
  },
});

export const winsCount = internalQuery({
  args: { now: v.number() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const wins = await computeRecentWins(ctx, args.now, 30);
    return wins.length;
  },
});

export const cleanupExpiredHolds = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("oxylabs_holds")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
      .take(200);
    for (const row of expired) {
      await ctx.db.delete(row._id);
    }
    return expired.length;
  },
});
