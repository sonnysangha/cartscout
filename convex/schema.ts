import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const couponItemValidator = v.object({
  code: v.string(),
  offer: v.string(),
  sources: v.array(v.string()),
  expiresOn: v.union(v.string(), v.null()),
});

export const offerItemValidator = v.object({
  title: v.string(),
  variant: v.string(),
  match: v.union(
    v.literal("exact"),
    v.literal("different_variant"),
    v.literal("unconfirmed"),
  ),
  retailer: v.string(),
  url: v.string(),
  price: v.number(),
  currency: v.string(),
  stockText: v.string(),
  availability: v.union(v.literal("in_stock"), v.literal("unknown")),
});

export const lookupPageValidator = v.object({
  retailer: v.string(),
  url: v.string(),
  read: v.boolean(),
  tries: v.number(),
  offer: v.union(offerItemValidator, v.null()),
});

export default defineSchema({
  // Per-shop (Pro) or per-member (Free) scan freshness metadata.
  searches: defineTable({
    merchant: v.string(),
    refreshedAt: v.number(),
    retryAt: v.number(),
    partial: v.boolean(),
    discoveryVersion: v.number(),
    reused: v.boolean(),
    seeded: v.boolean(),
  }).index("by_merchant_and_discoveryVersion", ["merchant", "discoveryVersion"]),

  // Discovered coupon codes tied to a cache key (`merchant` or `private:<hash>:<merchant>`).
  coupons: defineTable({
    merchant: v.string(),
    code: v.string(),
    offer: v.string(),
    sources: v.array(v.string()),
    expiresOn: v.union(v.string(), v.null()),
    seenAt: v.number(),
    discoveryVersion: v.number(),
    seeded: v.boolean(),
  })
    .index("by_merchant_and_code", ["merchant", "code"])
    .index("by_merchant_and_discoveryVersion", ["merchant", "discoveryVersion"]),

  // Member thumbs up / down reports and verified checkout savings.
  reports: defineTable({
    merchant: v.string(),
    code: v.string(),
    reporter: v.string(),
    worked: v.boolean(),
    reportedAt: v.number(),
    savedAmount: v.union(v.number(), v.null()),
    savedCurrency: v.union(v.string(), v.null()),
    memberName: v.union(v.string(), v.null()),
  })
    .index("by_merchant_and_code_and_reporter", ["merchant", "code", "reporter"])
    .index("by_merchant_and_code", ["merchant", "code"])
    .index("by_worked_and_reportedAt", ["worked", "reportedAt"]),

  // Weekly Free-tier scan reservations and completions (resets Monday 00:00 UTC).
  free_site_scans: defineTable({
    scanId: v.string(),
    reporter: v.string(),
    weekStart: v.number(),
    startedAt: v.number(),
    complete: v.boolean(),
  })
    .index("by_scanId", ["scanId"])
    .index("by_reporter_and_weekStart", ["reporter", "weekStart"]),

  // Shared 24-hour public shop scan pool (indexed by exact merchant and registrable brand domain).
  shop_scans: defineTable({
    merchant: v.string(),
    domain: v.union(v.string(), v.null()),
    fetchedAt: v.number(),
    complete: v.boolean(),
    coupons: v.array(couponItemValidator),
    seeded: v.boolean(),
    discoveryVersion: v.number(),
  })
    .index("by_merchant_and_discoveryVersion", ["merchant", "discoveryVersion"])
    .index("by_domain_and_discoveryVersion_and_complete_and_fetchedAt", [
      "domain",
      "discoveryVersion",
      "complete",
      "fetchedAt",
    ]),

  // Short cooldown window after a failed scan so broken sites aren't hammered.
  scan_failures: defineTable({
    merchant: v.string(),
    failedAt: v.number(),
    retryAt: v.number(),
  }).index("by_merchant", ["merchant"]),

  // Shared 6-hour cross-retailer price comparison cache.
  lookups: defineTable({
    merchant: v.string(),
    country: v.string(),
    name: v.string(),
    variant: v.string(),
    fetchedAt: v.number(),
    freshUntil: v.number(),
    partial: v.boolean(),
    offers: v.array(offerItemValidator),
    pages: v.array(lookupPageValidator),
  }).index("by_merchant_and_country_and_name_and_variant", [
    "merchant",
    "country",
    "name",
    "variant",
  ]),

  // Persistent UTC Oxylabs request ledger.
  oxylabs_requests: defineTable({
    at: v.number(),
    operation: v.union(v.literal("scan"), v.literal("lookup")),
    kind: v.union(v.literal("search"), v.literal("read"), v.literal("read_js")),
    host: v.string(),
    ai: v.boolean(),
    ok: v.union(v.boolean(), v.null()),
    ms: v.union(v.number(), v.null()),
  }).index("by_at", ["at"]),

  // Atomic budget holds reserved before live Oxylabs work starts.
  oxylabs_holds: defineTable({
    holdId: v.string(),
    operation: v.union(v.literal("scan"), v.literal("lookup")),
    held: v.number(),
    expiresAt: v.number(),
  })
    .index("by_holdId", ["holdId"])
    .index("by_expiresAt", ["expiresAt"]),
});
