export const SHOP_SCAN_CACHE_NAME = "shopScanV2";
export const SHOP_SCAN_TTL = 24 * 60 * 60 * 1000; // 24 hours
export const SHOP_SCAN_PARTIAL_TTL = 60 * 60 * 1000; // 1 hour

export const ALTERNATIVES_CACHE_NAME = "alternativesV1";
export const ALTERNATIVES_TTL = 6 * 60 * 60 * 1000; // 6 hours
export const ALTERNATIVES_PARTIAL_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Single cache key for a store scan: shares fresh 24h scans across regional subdomains of the
 * same brand (e.g. `uk.ridge.com` and `ridge.com` both key to `"ridge.com"`), while keeping
 * multi-tenant hosts (`*.myshopify.com`, where `domain` is null) isolated by full hostname.
 */
export function shopScanKey(merchant: string, domain: string | null): string {
  return domain ?? merchant;
}

/** Normalized single key for cross-retailer price comparison lookups (6h TTL). */
export function alternativesKey(
  merchant: string,
  country: string,
  name: string,
  variant: string,
) {
  return {
    merchant,
    country,
    name: name.toLowerCase(),
    variant: variant.toLowerCase(),
  };
}
