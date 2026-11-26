// Convex-backed store and Oxylabs ledger adapter.
// Mirrors the exact interface of server/store.js so the API server runs seamlessly on Convex
// (with async calls) while unit tests can continue using in-memory SQLite or mocked stores.
import { randomUUID } from 'node:crypto';
import { registrableDomain } from './oxylabs.js';

export function openConvexStore({ siteUrl, secret, request = fetch }) {
  const base = String(siteUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('Set CONVEX_SITE_URL (or CONVEX_URL) to use the Convex store.');
  if (!secret) throw new Error('Set CARTSCOUT_CONVEX_SECRET to use the Convex store.');
  const endpoint = `${base}/internal/rpc`;

  async function rpc(op, args = {}, timeoutMs = 20_000) {
    const response = await request(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ op, args }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || `Convex RPC ${op} failed (HTTP ${response.status}).`);
    }
    return data.result;
  }

  const ledger = {
    async reserve({ operation, requests, now, daily, monthly }) {
      const holdId = randomUUID();
      const res = await rpc('ledger:reserve', { holdId, operation, requests, now, daily, monthly });
      if (!res.ok) return { refused: res.refused };
      return {
        ticket: {
          operation,
          async use({ kind, host, ai = false, at }) {
            const requestId = await rpc('ledger:spend', {
              holdId, operation, kind, host: host ?? '', ai: !!ai, at,
            });
            if (!requestId) throw new Error(`This ${operation} has used every request it reserved.`);
            return async (ok, ms) => {
              try {
                await rpc('ledger:finish', { requestId, ok: !!ok, ms: Math.max(0, Math.round(ms)) });
              } catch {
                // Request is already counted in Convex.
              }
            };
          },
          async release() {
            try {
              await rpc('ledger:release', { holdId });
            } catch {
              // The hold lease expires automatically in Convex.
            }
          },
        },
      };
    },
    totals: (now) => rpc('ledger:totals', { now }),
  };

  const normCoupons = (coupons = []) => coupons.map((c) => ({
    code: String(c.code || '').toUpperCase(),
    offer: typeof c.offer === 'string' ? c.offer : '',
    sources: Array.isArray(c.sources) ? c.sources : [],
    expiresOn: typeof c.expiresOn === 'string' ? c.expiresOn : null,
  }));

  return {
    kind: 'convex',
    siteUrl: base,
    ledger,
    get: (merchant) => rpc('store:getSearch', { merchant }),
    listing: (merchant, reporter, now) => rpc('store:listing', { merchant, reporter, now }),
    shopScan: (merchant) => rpc('store:shopScan', { merchant, domain: registrableDomain(merchant) }),
    shopScanByDomain: (domain) => rpc('store:shopScanByDomain', { domain }),
    saveShopScan: (merchant, result, fetchedAt, seeded = false) => rpc('store:saveShopScan', {
      merchant,
      domain: registrableDomain(merchant),
      coupons: normCoupons(result.coupons),
      complete: !!result.complete,
      fetchedAt,
      seeded: !!seeded,
    }),
    scanFailure: (merchant) => rpc('store:scanFailure', { merchant }),
    markScanFailure: (merchant, now) => rpc('store:markScanFailure', { merchant, now }),
    clearScanFailure: (merchant) => rpc('store:clearScanFailure', { merchant }),
    lookup: (merchant, country, item) => rpc('store:getLookup', {
      merchant, country, name: item.name, variant: item.variant ?? '',
    }),
    saveLookup: (merchant, country, item, { offers, partial, pages }, { fetchedAt, freshUntil }) => rpc('store:saveLookup', {
      merchant,
      country,
      name: item.name,
      variant: item.variant ?? '',
      fetchedAt,
      freshUntil,
      partial: !!partial,
      offers: offers ?? [],
      pages: pages ?? [],
    }),
    seedScan: (merchant, coupons, now) => rpc('store:seedScan', {
      merchant,
      domain: registrableDomain(merchant),
      coupons: normCoupons(coupons),
      now,
    }),
    weeklyScans: (reporter, now) => rpc('store:weeklyScans', { reporter, now }),
    reserveScan: (reporter, now) => rpc('store:reserveScan', { scanId: randomUUID(), reporter, now }),
    releaseScan: (scanId) => rpc('store:releaseScan', { scanId }),
    save: (merchant, result, now, reservation = null, origin = {}) => {
      const fetchedAt = origin.fetchedAt ?? now;
      const freshFrom = origin.freshFrom ?? fetchedAt;
      return rpc('store:saveScan', {
        merchant,
        coupons: normCoupons(result.coupons),
        complete: !!result.complete,
        now,
        reservation: reservation ?? null,
        fetchedAt,
        freshFrom,
        reused: !!origin.reused,
        seeded: !!origin.seeded,
      });
    },
    report: (merchant, code, reporter, worked, now, saving) => rpc('store:recordReport', {
      merchant,
      code,
      reporter,
      worked: !!worked,
      now,
      savedAmount: saving?.amount ?? null,
      savedCurrency: saving?.currency ?? null,
      memberName: saving?.memberName ?? null,
    }),
    recentWins: (now, limit = 12) => rpc('store:recentWins', { now, limit }),
    winsCount: (now) => rpc('store:winsCount', { now }),
    discoverShopAction: (merchant, force = false) => rpc('oxylabs:discoverShop', {
      merchant,
      domain: registrableDomain(merchant),
      force: !!force,
    }, 90_000),
    findAlternativesAction: (merchant, country, item, previousPages = null) => rpc('oxylabs:findAlternatives', {
      merchant,
      country,
      item,
      previousPages,
    }, 90_000),
    close() {},
  };
}
