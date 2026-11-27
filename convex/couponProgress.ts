import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { couponItemValidator } from "./schema";

const PROGRESS_TTL = 10 * 60_000;
const ACTIVE_TTL = 2 * 60_000;

function byToken(ctx: QueryCtx, token: string) {
  return ctx.db.query("coupon_scan_progress").withIndex("by_token", q => q.eq("token", token)).unique();
}

export const start = internalMutation({
  args: { token: v.string(), reporter: v.string(), merchant: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const now = Date.now();
    if (await latestActive(ctx, args.reporter, args.merchant, now)) return false;
    const id = await ctx.db.insert("coupon_scan_progress", {
      ...args, startedAt: now, checked: 0, total: 0, coupons: [], finished: false,
    });
    await ctx.scheduler.runAfter(PROGRESS_TTL, internal.couponProgress.remove, { id });
    return true;
  },
});

export const remove = internalMutation({
  args: { id: v.id("coupon_scan_progress") },
  handler: (ctx, { id }) => ctx.db.delete("coupon_scan_progress", id),
});

async function latestActive(ctx: QueryCtx, reporter: string, merchant: string, now: number) {
  const row = await ctx.db.query("coupon_scan_progress")
    .withIndex("by_reporter_and_merchant_and_startedAt", q =>
      q.eq("reporter", reporter).eq("merchant", merchant).gt("startedAt", now - ACTIVE_TTL))
    .order("desc").first();
  return row && !row.finished ? row.token : null;
}

export const active = internalQuery({
  args: { reporter: v.string(), merchant: v.string(), now: v.number() },
  handler: (ctx, { reporter, merchant, now }) => latestActive(ctx, reporter, merchant, now),
});

export const addPages = internalMutation({
  args: { token: v.string(), count: v.number() },
  handler: async (ctx, { token, count }) => {
    const row = await byToken(ctx, token);
    if (row && !row.finished) await ctx.db.patch("coupon_scan_progress", row._id, { total: row.total + count });
  },
});

export const recordPage = internalMutation({
  args: { token: v.string(), coupons: v.array(couponItemValidator) },
  handler: async (ctx, { token, coupons }) => {
    const row = await byToken(ctx, token);
    if (!row || row.finished) return;
    const merged = new Map(row.coupons.map(coupon => [coupon.code, coupon]));
    for (const coupon of coupons) {
      const previous = merged.get(coupon.code);
      if (previous) merged.set(coupon.code, {
        ...previous,
        sources: [...new Set([...previous.sources, ...coupon.sources])],
        offer: previous.offer || coupon.offer,
        expiresOn: previous.expiresOn ?? coupon.expiresOn,
      });
      else if (merged.size < 24) merged.set(coupon.code, coupon);
    }
    await ctx.db.patch("coupon_scan_progress", row._id, {
      checked: row.checked + 1,
      coupons: [...merged.values()],
    });
  },
});

export const finish = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const row = await byToken(ctx, token);
    if (row) await ctx.db.patch("coupon_scan_progress", row._id, { finished: true });
  },
});

// The Next API keeps this random capability server-side and authorizes each stream.
// Expose only public coupon evidence and counters for the specific capability.
export const read = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const row = await byToken(ctx, token);
    if (!row) return null;
    return { checked: row.checked, total: row.total, coupons: row.coupons, finished: row.finished };
  },
});
