import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

const ROUTES = {
  "couponProgress:start": { kind: "mutation" as const, ref: internal.couponProgress.start },
  "couponProgress:active": { kind: "query" as const, ref: internal.couponProgress.active },
  "couponProgress:finish": { kind: "mutation" as const, ref: internal.couponProgress.finish },
  "store:getSearch": { kind: "query" as const, ref: internal.store.getSearch },
  "store:listing": { kind: "query" as const, ref: internal.store.listing },
  "store:shopScan": { kind: "query" as const, ref: internal.store.shopScan },
  "store:shopScanByDomain": {
    kind: "query" as const,
    ref: internal.store.shopScanByDomain,
  },
  "store:saveShopScan": {
    kind: "mutation" as const,
    ref: internal.store.saveShopScan,
  },
  "store:scanFailure": {
    kind: "query" as const,
    ref: internal.store.scanFailure,
  },
  "store:markScanFailure": {
    kind: "mutation" as const,
    ref: internal.store.markScanFailure,
  },
  "store:clearScanFailure": {
    kind: "mutation" as const,
    ref: internal.store.clearScanFailure,
  },
  "store:getLookup": { kind: "query" as const, ref: internal.store.getLookup },
  "store:saveLookup": {
    kind: "mutation" as const,
    ref: internal.store.saveLookup,
  },
  "store:seedScan": {
    kind: "mutation" as const,
    ref: internal.store.seedScan,
  },
  "store:weeklyScans": {
    kind: "query" as const,
    ref: internal.store.weeklyScans,
  },
  "store:reserveScan": {
    kind: "mutation" as const,
    ref: internal.store.reserveScan,
  },
  "store:releaseScan": {
    kind: "mutation" as const,
    ref: internal.store.releaseScan,
  },
  "store:saveScan": {
    kind: "mutation" as const,
    ref: internal.store.saveScan,
  },
  "store:recordReport": {
    kind: "mutation" as const,
    ref: internal.store.recordReport,
  },
  "store:recentWins": {
    kind: "query" as const,
    ref: internal.store.recentWins,
  },
  "store:winsCount": { kind: "query" as const, ref: internal.store.winsCount },
  "ledger:reserve": {
    kind: "mutation" as const,
    ref: internal.ledger.reserve,
  },
  "ledger:spend": { kind: "mutation" as const, ref: internal.ledger.spend },
  "ledger:finish": { kind: "mutation" as const, ref: internal.ledger.finish },
  "ledger:release": {
    kind: "mutation" as const,
    ref: internal.ledger.release,
  },
  "ledger:totals": { kind: "query" as const, ref: internal.ledger.totals },
  "oxylabs:discoverShop": {
    kind: "action" as const,
    ref: internal.oxylabs.discoverShop,
  },
  "oxylabs:findAlternatives": {
    kind: "action" as const,
    ref: internal.oxylabs.findAlternatives,
  },
} as const;

type RouteName = keyof typeof ROUTES;

/**
 * Authenticated backend-to-Convex RPC bridge.
 * Keeps every cache and ledger table behind internalQuery/internalMutation so browser clients can never
 * tamper with scans, reports, weekly quotas, or Oxylabs budget holds.
 */
http.route({
  path: "/internal/rpc",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.CARTSCOUT_CONVEX_SECRET;
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!secret || !token || !timingSafeEqual(token, secret)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (
      !body ||
      typeof body !== "object" ||
      typeof (body as { op?: unknown }).op !== "string"
    ) {
      return new Response(JSON.stringify({ error: "Missing op" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const op = (body as { op: string }).op;
    if (!Object.hasOwn(ROUTES, op)) {
      return new Response(JSON.stringify({ error: `Unknown op: ${op}` }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const args = (body as { args?: unknown }).args;
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      return new Response(JSON.stringify({ error: "Invalid args" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const entry = ROUTES[op as RouteName];
    try {
      const result =
        entry.kind === "query"
          ? await ctx.runQuery(entry.ref, (args ?? {}) as never)
          : entry.kind === "mutation"
            ? await ctx.runMutation(entry.ref, (args ?? {}) as never)
            : await ctx.runAction(entry.ref, (args ?? {}) as never);
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Convex RPC failed";
      return new Response(JSON.stringify({ ok: false, error: message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

export default http;
