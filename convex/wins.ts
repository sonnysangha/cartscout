import { v } from "convex/values";
import { query } from "./_generated/server";

/**
 * Clerk-authenticated real-time pulse for the account portal.
 * Returns only aggregate feed metadata (count + latest timestamp), never real coupon codes,
 * so Free members cannot read Pro codes while signed-in portal tabs react instantly to new wins
 * over Convex WebSockets.
 */
export const feedPulse = query({
  args: {},
  returns: v.union(
    v.object({
      authenticated: v.literal(true),
      subject: v.string(),
      count: v.number(),
      latestAt: v.union(v.number(), v.null()),
    }),
    v.object({
      authenticated: v.literal(false),
      count: v.number(),
      latestAt: v.null(),
    }),
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { authenticated: false as const, count: 0, latestAt: null };
    }
    const rows = await ctx.db
      .query("reports")
      .withIndex("by_worked_and_reportedAt", (q) => q.eq("worked", true))
      .order("desc")
      .take(100);
    const publicRows = rows.filter((r) => !r.merchant.startsWith("private:"));
    const uniquePairs = new Set(publicRows.map((r) => `${r.merchant}\0${r.code}`));
    return {
      authenticated: true as const,
      subject: identity.subject,
      count: uniquePairs.size,
      latestAt: publicRows[0]?.reportedAt ?? null,
    };
  },
});
