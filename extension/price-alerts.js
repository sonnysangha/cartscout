import { marketFor, markets } from './markets.js';
import { bestOffer, money, priceDifference, usablePrice } from './presentation.js';

export const alertPermission = (origin) => ({ origins: [`${origin}/*`] });

export function canEnablePriceAlerts(site, hostPermissions = []) {
  return !!site && !hostPermissions.includes(alertPermission(site.origin).origins[0]);
}

export function priceAlertSite(href) {
  try {
    const url = new URL(href);
    const host = url.hostname;
    if (url.protocol !== 'https:' || url.port || !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i.test(host)
      || /\.(?:local|localhost|internal|invalid|test|example|onion|lan)$/i.test(host)) return null;
    return url;
  } catch {
    return null;
  }
}

export async function findCachedSaving(cached, merchant, product, now = Date.now) {
  const own = usablePrice(product);
  if (!own || typeof product.name !== 'string' || product.name.trim().length < 3) return null;
  const country = marketFor({ currency: own.currency, host: merchant });
  if (markets[country][1] !== own.currency) return null;
  const [result] = await cached(merchant, country, { name: product.name, variant: product.variant ?? '' });
  const expiresAt = Date.parse(result?.freshUntil);
  if (!(expiresAt > now()) || !Array.isArray(result.offers)) return null;
  const best = bestOffer(result.offers, own);
  if (!best) return null;

  const savings = priceDifference(best, own).diff;
  const name = markets[country][0];
  const destination = ['GB', 'US', 'AE', 'NL'].includes(country) ? `the ${name}` : name;
  return {
    country,
    result: { ...result, own },
    title: `${savings} cheaper in ${destination}`,
    detail: `${money(best.price, best.currency)} at ${best.retailer} · before delivery`,
  };
}
