import { NextResponse } from "next/server";
import { createClerkAuthenticator } from "@/server/auth.js";
import { budgetMessage } from "@/server/budget.js";
import { openConvexStore } from "@/server/convex-store.js";
import { parseBasket, retryCost } from "@/server/alternatives.js";
import {
  normalizeCode,
  normalizeMerchant,
  registrableDomain,
} from "@/server/oxylabs.js";
import { LOOKUP_LIFETIME, reporterKey, SCAN_LIFETIME } from "@/server/store.js";

const iso = (time: number) => new Date(time).toISOString();

export class ApiHttpError extends Error {
  status: number;
  details: Record<string, unknown>;
  constructor(status: number, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function allowedOrigins(): Set<string> {
  return new Set([
    "http://localhost:8788",
    "http://127.0.0.1:8788",
    "http://localhost:3000",
    ...(process.env.PORTAL_ORIGIN ? [process.env.PORTAL_ORIGIN.replace(/\/$/, "")] : []),
    ...String(process.env.CLERK_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\/$/, ""))
      .filter(Boolean),
  ]);
}

export function corsHeaders(request: Request): Record<string, string> {
  const reqOrigin = (request.headers.get("origin") ?? "").replace(/\/$/, "");
  if (
    reqOrigin &&
    (allowedOrigins().has(reqOrigin) || /^chrome-extension:\/\//.test(reqOrigin))
  ) {
    return {
      "Access-Control-Allow-Origin": reqOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      Vary: "Origin",
    };
  }
  return {};
}

export function jsonResponse(
  request: Request,
  status: number,
  body: unknown,
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...corsHeaders(request) },
  });
}

export function optionsResponse(request: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

let cachedAuth: ReturnType<typeof createClerkAuthenticator> | null = null;
function getAuthenticator() {
  if (!cachedAuth) {
    cachedAuth = createClerkAuthenticator({
      secretKey: process.env.CLERK_SECRET_KEY,
      jwtKey: process.env.CLERK_JWT_KEY?.trim() || undefined,
      publishableKey:
        process.env.CLERK_PUBLISHABLE_KEY ||
        process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
      allowedOrigins: process.env.CLERK_ALLOWED_ORIGINS,
      proPlan: process.env.CLERK_PRO_PLAN || "pro",
    });
  }
  return cachedAuth;
}

let cachedStore: ReturnType<typeof openConvexStore> | null = null;
export function getConvexStore() {
  if (!cachedStore) {
    const siteUrl =
      process.env.CONVEX_SITE_URL?.trim() ||
      (process.env.CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL || "")
        .trim()
        .replace(/\.convex\.cloud\/?$/, ".convex.site");
    const secret = process.env.CARTSCOUT_CONVEX_SECRET?.trim();
    cachedStore = openConvexStore({ siteUrl, secret });
  }
  return cachedStore;
}

export async function authenticateRequest(request: Request) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.match(/^Bearer (\S+)$/i)?.[1];
  const authenticate = getAuthenticator();
  const identity = token ? await authenticate(token) : null;
  if (!identity) {
    throw new ApiHttpError(401, "Sign in to CartScout to continue.", {
      code: "sign_in_required",
    });
  }
  const reporter = reporterKey(`clerk:${identity.userId}`);
  return { identity, reporter };
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiHttpError(400, "Invalid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiHttpError(400, "Invalid JSON.");
  }
  return body as Record<string, unknown>;
}

export async function accountDetails(
  identity: { userId: string; plan: string },
  reporter: string,
) {
  const store = getConvexStore();
  return {
    userId: identity.userId,
    plan: identity.plan,
    scans: identity.plan === "free" ? await store.weeklyScans(reporter, Date.now()) : null,
  };
}

export async function buildCouponsPayload(
  merchant: string,
  cacheKey: string,
  reporter: string,
  source: string,
  identity: { userId: string; plan: string },
) {
  const store = getConvexStore();
  const [search, coupons, account] = await Promise.all([
    store.get(cacheKey),
    store.listing(cacheKey, reporter, Date.now()),
    accountDetails(identity, reporter),
  ]);
  return {
    merchant,
    source,
    refreshedAt: search?.refreshed_at ?? null,
    partial: !!search?.partial,
    ...(search && {
      fetchedAt: iso(search.refreshed_at),
      freshUntil: iso(search.retry_at),
    }),
    ...(search?.reused && { reused: true }),
    ...(search?.seeded && { seeded: true }),
    coupons,
    account,
  };
}

async function shopRecord(merchant: string) {
  const store = getConvexStore();
  const exact = await store.shopScan(merchant);
  if (exact?.result.complete) return exact;
  const domain = registrableDomain(merchant);
  const sibling = domain ? await store.shopScanByDomain(domain) : null;
  if (sibling && (!exact || sibling.fetchedAt > exact.fetchedAt)) return sibling;
  return exact;
}

function failedRecently(mark: { retry_at: number }, time: number) {
  const minutes = Math.max(1, Math.ceil((mark.retry_at - time) / 60_000));
  const wait = minutes === 1 ? "a minute" : `${minutes} minutes`;
  return new ApiHttpError(
    502,
    `Scout couldn’t read this shop’s coupon pages a moment ago. Try again in about ${wait}.`,
    { code: "scan_failed", retryAt: iso(mark.retry_at) },
  );
}

function budgetReached(
  operation: "scan" | "lookup",
  refused: { scope: "day" | "month"; resetAt: number },
) {
  const message = budgetMessage(operation, refused);
  return new ApiHttpError(429, message, {
    code: "budget_reached",
    message,
    resetAt: iso(refused.resetAt),
  });
}

export async function handleCouponsLookup(
  merchantInput: unknown,
  cacheOnly: boolean,
  force: boolean,
  identity: { userId: string; plan: string },
  reporter: string,
) {
  const merchant = normalizeMerchant(merchantInput);
  if (!merchant) {
    throw new ApiHttpError(400, "Scout can only look up public shop websites.");
  }
  const store = getConvexStore();
  const cacheKey =
    identity.plan === "free" ? `private:${reporter}:${merchant}` : merchant;
  const time = Date.now();
  const cached = await store.get(cacheKey);

  if (!force && cached?.retry_at > time) {
    return buildCouponsPayload(merchant, cacheKey, reporter, "cache", identity);
  }

  if (cacheOnly) {
    if (identity.plan !== "free") {
      const record = await shopRecord(merchant);
      const fresh =
        record?.result.complete && time - record.fetchedAt < SCAN_LIFETIME.complete
          ? record
          : null;
      if (fresh && (!cached || fresh.fetchedAt > cached.refreshed_at)) {
        await store.save(cacheKey, fresh.result, time, null, {
          fetchedAt: fresh.fetchedAt,
          reused: true,
          seeded: fresh.seeded,
        });
        return buildCouponsPayload(merchant, cacheKey, reporter, "cache", identity);
      }
    }
    if (cached) {
      return buildCouponsPayload(merchant, cacheKey, reporter, "stale", identity);
    }
    throw new ApiHttpError(409, "Scan this shop to find coupon codes.", {
      code: "scan_required",
      account: await accountDetails(identity, reporter),
    });
  }

  const limited = identity.plan === "free";
  const reservation = limited ? await store.reserveScan(reporter, time) : null;
  if (limited && !reservation) {
    throw new ApiHttpError(429, "You’ve used all 5 free scans for this week.", {
      code: "scan_limit",
      account: await accountDetails(identity, reporter),
    });
  }

  const existingRecord = force ? null : await shopRecord(merchant);
  const ready =
    existingRecord?.result.complete &&
    time - existingRecord.fetchedAt < SCAN_LIFETIME.complete
      ? existingRecord
      : null;

  if (ready) {
    await store.save(cacheKey, ready.result, Date.now(), reservation, {
      fetchedAt: ready.fetchedAt,
      reused: true,
      seeded: ready.seeded,
    });
    return buildCouponsPayload(merchant, cacheKey, reporter, "live", identity);
  }

  const mark = await store.scanFailure(merchant);
  if (mark?.retry_at > time) {
    if (reservation) await store.releaseScan(reservation);
    throw failedRecently(mark, time);
  }

  // Delegate live Oxylabs coupon discovery directly to the Convex Action (10-min runtime, atomic Convex ledger).
  try {
    const discovered = await store.discoverShopAction(merchant);
    if (!discovered.ok) {
      if (reservation) await store.releaseScan(reservation);
      const err = budgetReached("scan", discovered.refused);
      err.details.account = await accountDetails(identity, reporter);
      throw err;
    }
    const result = { coupons: discovered.coupons, complete: discovered.complete };
    const charged = result.complete || result.coupons.length > 0;
    await store.save(cacheKey, result, Date.now(), charged ? reservation : null, {
      fetchedAt: discovered.fetchedAt,
      reused: false,
      seeded: false,
    });
    if (reservation && !charged) await store.releaseScan(reservation);
    return buildCouponsPayload(merchant, cacheKey, reporter, "live", identity);
  } catch (error) {
    if (reservation) await store.releaseScan(reservation);
    if (error instanceof ApiHttpError) throw error;
    if (cached) {
      return buildCouponsPayload(merchant, cacheKey, reporter, "stale", identity);
    }
    throw new ApiHttpError(
      502,
      "Coupon search is temporarily unavailable. Try again shortly.",
    );
  }
}

export async function handleAlternativesLookup(
  body: Record<string, unknown>,
) {
  const merchant = normalizeMerchant(body.merchant);
  if (!merchant) {
    throw new ApiHttpError(400, "Scout can only look up public shop websites.");
  }
  const basket = parseBasket(body);
  if (!basket) {
    throw new ApiHttpError(400, "Choose a supported country and provide basket products.");
  }
  const store = getConvexStore();
  const settled = await Promise.allSettled(
    basket.items.map(async (item: { name: string; variant: string }) => {
      const time = Date.now();
      const saved = await store.lookup(merchant, basket.country, item);
      const fromSaved = (stale: boolean) => ({
        offers: saved.offers,
        partial: saved.partial,
        fetchedAt: iso(saved.fetchedAt),
        ...(stale && { stale: true }),
      });
      const young = saved && time - saved.fetchedAt < LOOKUP_LIFETIME.complete;
      const retry = young && saved.partial ? retryCost(saved.pages) : 0;
      if (saved && (time < saved.freshUntil || (young && saved.partial && !retry))) {
        return fromSaved(false);
      }

      // Live Oxylabs cross-retailer comparison runs directly inside a Convex Action.
      const found = await store.findAlternativesAction(
        merchant,
        basket.country,
        item,
        retry ? saved.pages : null,
      );
      if (!found.ok) {
        if (saved) return fromSaved(true);
        throw budgetReached("lookup", found.refused);
      }
      const partial = !!found.partial;
      const fetchedAt = retry ? saved.fetchedAt : Date.now();
      const freshUntil = partial
        ? Math.min(
            Date.now() + LOOKUP_LIFETIME.partial,
            fetchedAt + LOOKUP_LIFETIME.complete,
          )
        : fetchedAt + LOOKUP_LIFETIME.complete;
      await store.saveLookup(
        merchant,
        basket.country,
        item,
        { offers: found.offers, partial, pages: found.pages ?? [] },
        { fetchedAt, freshUntil },
      );
      return { offers: found.offers, partial, fetchedAt: iso(fetchedAt) };
    }),
  );

  if (settled.every((r) => r.status === "rejected")) {
    const refusal = settled.find(
      (r): r is PromiseRejectedResult =>
        r.status === "rejected" && r.reason instanceof ApiHttpError,
    )?.reason;
    if (refusal) throw refusal;
    throw new ApiHttpError(502, "Retailer lookup is temporarily unavailable.");
  }

  return {
    country: basket.country,
    results: basket.items.map((item: { name: string; variant: string }, idx: number) => {
      const r = settled[idx];
      if (r.status === "fulfilled") return { ...item, ...r.value };
      const code =
        r.reason instanceof ApiHttpError
          ? (r.reason.details.code as string | undefined)
          : undefined;
      return {
        ...item,
        offers: [],
        error: code ? r.reason.message : "This item could not be checked.",
        ...(code && { code }),
      };
    }),
  };
}

export async function handleReport(
  body: Record<string, unknown>,
  identity: { userId: string; plan: string; username?: string | null },
  reporter: string,
) {
  const merchant = normalizeMerchant(body.merchant);
  if (!merchant) {
    throw new ApiHttpError(400, "Scout can only look up public shop websites.");
  }
  const code = normalizeCode(body.code);
  if (!code || typeof body.worked !== "boolean") {
    throw new ApiHttpError(400, "Enter a coupon and whether it worked.");
  }
  const cacheKey =
    identity.plan === "free" ? `private:${reporter}:${merchant}` : merchant;
  const savedAmount =
    typeof body.savedAmount === "number" &&
    Number.isFinite(body.savedAmount) &&
    body.savedAmount > 0 &&
    body.savedAmount <= 100_000
      ? body.savedAmount
      : null;
  const savedCurrency =
    typeof body.savedCurrency === "string" &&
    /^[A-Za-z]{3}$/.test(body.savedCurrency.trim())
      ? body.savedCurrency.trim().toUpperCase()
      : null;
  const FALLBACK_HANDLES = [
    "sam_k", "alex_m", "charlie_r", "morgan_t", "jamie_b", "riley_w",
    "casey_p", "drew_h", "taylor_s", "jordan_d", "avery_n", "quinn_l",
    "ella_v", "finn_g", "ruby_c", "owen_f", "isla_j", "theo_b",
  ];
  const fallbackHandle =
    FALLBACK_HANDLES[parseInt(reporter.slice(0, 6), 16) % FALLBACK_HANDLES.length];
  const memberName = identity.username || fallbackHandle;
  const saving = body.worked
    ? {
        ...(savedAmount !== null && { amount: savedAmount, currency: savedCurrency }),
        memberName,
      }
    : undefined;

  const store = getConvexStore();
  if (!(await store.report(cacheKey, code, reporter, body.worked, Date.now(), saving))) {
    throw new ApiHttpError(404, "This code is no longer listed for this shop.");
  }
  return buildCouponsPayload(merchant, cacheKey, reporter, "cache", identity);
}

export function handleRouteError(request: Request, error: unknown): NextResponse {
  if (error instanceof ApiHttpError) {
    return jsonResponse(request, error.status, {
      error: error.message,
      ...error.details,
    });
  }
  console.error("CartScout API error:", error);
  return jsonResponse(request, 500, { error: "Coupon service error." });
}
