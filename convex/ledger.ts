import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const DAY = 86_400_000;
const HOLD_LEASE = 5 * 60_000;

function utcDayStart(now: number): number {
  return Math.floor(now / DAY) * DAY;
}

function utcMonthStart(now: number, monthsLater = 0): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + monthsLater, 1);
}

const bucketValidator = v.object({
  from: v.number(),
  to: v.number(),
  requests: v.number(),
  answered: v.number(),
  failed: v.number(),
  unanswered: v.number(),
  searches: v.number(),
  reads: v.number(),
  rendered: v.number(),
  ai: v.number(),
  forScans: v.number(),
  forLookups: v.number(),
});

export const reserve = internalMutation({
  args: {
    holdId: v.string(),
    operation: v.union(v.literal("scan"), v.literal("lookup")),
    requests: v.number(),
    now: v.number(),
    daily: v.number(),
    monthly: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), holdId: v.string() }),
    v.object({
      ok: v.literal(false),
      refused: v.object({
        scope: v.union(v.literal("day"), v.literal("month")),
        resetAt: v.number(),
      }),
    }),
  ),
  handler: async (ctx, args) => {
    // Drop expired holds so stale crashes never block fresh operations.
    const expired = await ctx.db
      .query("oxylabs_holds")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", args.now))
      .take(100);
    for (const row of expired) {
      await ctx.db.delete(row._id);
    }

    const activeHolds = await ctx.db
      .query("oxylabs_holds")
      .withIndex("by_expiresAt", (q) => q.gt("expiresAt", args.now))
      .take(200);
    const held = activeHolds.reduce((sum, row) => sum + row.held, 0);

    const monthStart = utcMonthStart(args.now);
    const monthRows = await ctx.db
      .query("oxylabs_requests")
      .withIndex("by_at", (q) => q.gte("at", monthStart))
      .take(5000);

    if (monthRows.length + held + args.requests > args.monthly) {
      return {
        ok: false as const,
        refused: {
          scope: "month" as const,
          resetAt: utcMonthStart(args.now, 1),
        },
      };
    }

    const dayStart = utcDayStart(args.now);
    const dayCount = monthRows.filter((r) => r.at >= dayStart).length;
    if (dayCount + held + args.requests > args.daily) {
      return {
        ok: false as const,
        refused: { scope: "day" as const, resetAt: dayStart + DAY },
      };
    }

    await ctx.db.insert("oxylabs_holds", {
      holdId: args.holdId,
      operation: args.operation,
      held: args.requests,
      expiresAt: args.now + HOLD_LEASE,
    });
    return { ok: true as const, holdId: args.holdId };
  },
});

export const spend = internalMutation({
  args: {
    holdId: v.string(),
    operation: v.union(v.literal("scan"), v.literal("lookup")),
    kind: v.union(v.literal("search"), v.literal("read"), v.literal("read_js")),
    host: v.string(),
    ai: v.boolean(),
    at: v.number(),
  },
  returns: v.union(v.id("oxylabs_requests"), v.null()),
  handler: async (ctx, args) => {
    const hold = await ctx.db
      .query("oxylabs_holds")
      .withIndex("by_holdId", (q) => q.eq("holdId", args.holdId))
      .unique();
    if (!hold || hold.held <= 0 || hold.expiresAt <= args.at) {
      return null;
    }
    await ctx.db.patch(hold._id, { held: hold.held - 1 });
    return await ctx.db.insert("oxylabs_requests", {
      at: args.at,
      operation: args.operation,
      kind: args.kind,
      host: args.host,
      ai: args.ai,
      ok: null,
      ms: null,
    });
  },
});

export const finish = internalMutation({
  args: {
    requestId: v.id("oxylabs_requests"),
    ok: v.boolean(),
    ms: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.requestId);
    if (existing) {
      await ctx.db.patch(args.requestId, {
        ok: args.ok,
        ms: Math.max(0, Math.round(args.ms)),
      });
    }
    return null;
  },
});

export const release = internalMutation({
  args: { holdId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const hold = await ctx.db
      .query("oxylabs_holds")
      .withIndex("by_holdId", (q) => q.eq("holdId", args.holdId))
      .unique();
    if (hold) await ctx.db.delete(hold._id);
    return null;
  },
});

export const totals = internalQuery({
  args: { now: v.number() },
  returns: v.object({
    day: bucketValidator,
    month: bucketValidator,
    held: v.number(),
    hosts: v.array(v.object({ host: v.string(), requests: v.number() })),
  }),
  handler: async (ctx, args) => {
    const dayFrom = utcDayStart(args.now);
    const dayTo = dayFrom + DAY;
    const monthFrom = utcMonthStart(args.now);
    const monthTo = utcMonthStart(args.now, 1);

    const monthRows = await ctx.db
      .query("oxylabs_requests")
      .withIndex("by_at", (q) => q.gte("at", monthFrom).lt("at", monthTo))
      .take(5000);

    const summarise = (
      rows: typeof monthRows,
      from: number,
      to: number,
    ) => {
      let answered = 0;
      let failed = 0;
      let unanswered = 0;
      let searches = 0;
      let reads = 0;
      let rendered = 0;
      let ai = 0;
      let forScans = 0;
      let forLookups = 0;
      for (const r of rows) {
        if (r.ok === true) answered += 1;
        else if (r.ok === false) failed += 1;
        else unanswered += 1;
        if (r.kind === "search") searches += 1;
        else if (r.kind === "read") reads += 1;
        else rendered += 1;
        if (r.ai) ai += 1;
        if (r.operation === "scan") forScans += 1;
        else forLookups += 1;
      }
      return {
        from,
        to,
        requests: rows.length,
        answered,
        failed,
        unanswered,
        searches,
        reads,
        rendered,
        ai,
        forScans,
        forLookups,
      };
    };

    const dayRows = monthRows.filter((r) => r.at >= dayFrom && r.at < dayTo);
    const hostCounts = new Map<string, number>();
    for (const r of monthRows) {
      if (r.host) hostCounts.set(r.host, (hostCounts.get(r.host) ?? 0) + 1);
    }
    const hosts = [...hostCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([host, requests]) => ({ host, requests }));

    const activeHolds = await ctx.db
      .query("oxylabs_holds")
      .withIndex("by_expiresAt", (q) => q.gt("expiresAt", args.now))
      .take(200);
    const held = activeHolds.reduce((sum, row) => sum + row.held, 0);

    return {
      day: summarise(dayRows, dayFrom, dayTo),
      month: summarise(monthRows, monthFrom, monthTo),
      held,
      hosts,
    };
  },
});
