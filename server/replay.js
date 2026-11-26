// The replay folder: saved answers the server gives back in OXYLABS_MODE=replay, where it never calls Oxylabs.
// Each .json file in the folder is one answer, in the shape the API itself sends (see server/replay/README.md):
//   a price lookup:  { "country": "GB", "results": [{ "name", "variant", "offers": [...], "partial" }] }
//   a shop scan:     { "merchant": "shop.com", "coupons": [{ "code", "offer", "sources", "expiresOn" }] }
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeCode, normalizeMerchant, sourceUrl } from './oxylabs.js';

const clean = (value, limit) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, limit) : '');
const same = (a, b) => clean(a, 200).toLowerCase() === clean(b, 200).toLowerCase();

// A file may say when its pages were read. Otherwise the file's own date stands in for it.
function readAt(data, modified) {
  const stated = typeof data.fetchedAt === 'string' ? Date.parse(data.fetchedAt)
    : Number.isFinite(data.refreshedAt) ? data.refreshedAt : NaN;
  return Number.isFinite(stated) ? stated : Math.round(modified);
}

// Saved files are written by hand as often as by the server, so nothing in them is passed on unchecked.
function savedCoupons(coupons) {
  return coupons.flatMap((coupon) => {
    const code = normalizeCode(coupon?.code);
    if (!code) return [];
    return [{
      code,
      offer: clean(coupon.offer, 180),
      sources: (Array.isArray(coupon.sources) ? coupon.sources : []).flatMap((source) => sourceUrl(source)?.href ?? []).slice(0, 8),
      expiresOn: typeof coupon.expiresOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(coupon.expiresOn) ? coupon.expiresOn : null,
    }];
  }).slice(0, 24);
}

function savedOffers(offers) {
  return offers.flatMap((offer) => {
    const url = sourceUrl(offer?.url);
    const title = clean(offer?.title, 180);
    if (!url || !title || !Number.isFinite(offer.price) || offer.price <= 0 || !/^[A-Z]{3}$/.test(offer.currency ?? '')
      || !['exact', 'different_variant', 'unconfirmed'].includes(offer.match)) return [];
    const stockText = clean(offer.stockText, 120);
    return [{
      title, variant: clean(offer.variant, 100), match: offer.match, retailer: normalizeMerchant(url.hostname), url: url.href,
      price: offer.price, currency: offer.currency, stockText,
      availability: offer.availability === 'in_stock' && stockText ? 'in_stock' : 'unknown',
    }];
  });
}

export function openReplayFolder(folder, { log = console.error } = {}) {
  const seen = new Map();

  // Files are read again when they change, so a rig can drop a new answer in without restarting the server.
  function answers() {
    let names;
    try {
      names = readdirSync(folder).filter((name) => name.endsWith('.json')).sort();
    } catch {
      return [];
    }
    return names.flatMap((name) => {
      try {
        const path = join(folder, name);
        const { mtimeMs, size } = statSync(path);
        const known = seen.get(name);
        if (known?.mtimeMs === mtimeMs && known.size === size) return known.data ? [known] : [];
        let data = null;
        try {
          const parsed = JSON.parse(readFileSync(path, 'utf8'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
          else log(`Replay file ${name} is not a saved answer.`);
        } catch (error) {
          log(`Replay file ${name} could not be read:`, error.message);
        }
        const entry = { mtimeMs, size, data };
        seen.set(name, entry);
        return data ? [entry] : [];
      } catch {
        return [];
      }
    });
  }

  return {
    /** A saved scan of this shop: { result: { coupons, complete }, fetchedAt, seeded }, or null. The newest file wins. */
    scan(merchant) {
      const found = answers()
        .filter(({ data }) => Array.isArray(data.coupons) && normalizeMerchant(data.merchant) === merchant)
        .map(({ data, mtimeMs }) => ({
          result: { coupons: savedCoupons(data.coupons), complete: !data.partial },
          fetchedAt: readAt(data, mtimeMs),
          seeded: false,
        }));
      return found.sort((a, b) => b.fetchedAt - a.fetchedAt)[0] ?? null;
    },
    /**
     * A saved price lookup for this product in this country: { offers, partial, fetchedAt }, or null. A file that
     * names a "merchant" only answers for that shop; one that names none answers wherever the product is asked about.
     */
    lookup(merchant, country, item) {
      for (const { data, mtimeMs } of answers()) {
        if (!Array.isArray(data.results) || data.country !== country) continue;
        if (data.merchant !== undefined && normalizeMerchant(data.merchant) !== merchant) continue;
        const result = data.results.find((entry) => same(entry?.name, item.name) && same(entry?.variant, item.variant));
        if (!result || !Array.isArray(result.offers)) continue;
        return { offers: savedOffers(result.offers), partial: !!result.partial, fetchedAt: readAt(data, mtimeMs) };
      }
      return null;
    },
  };
}
