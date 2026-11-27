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
  const preferred = marketFor({ currency: own.currency, host: merchant });
  const countries = [preferred, ...Object.keys(markets).filter(country => country !== preferred)]
    .filter(country => markets[country][1] === own.currency);
  const item = { name: product.name, variant: product.variant ?? '' };
  const settled = await Promise.allSettled(countries.map(async country => {
    const [result] = await cached(merchant, country, item);
    if (!(Date.parse(result?.freshUntil) > now()) || !Array.isArray(result.offers)) return null;
    const best = bestOffer(result.offers, own);
    return best ? { country, result, best } : null;
  }));
  const matches = settled.flatMap(match => match.status === 'fulfilled' && match.value ? [match.value] : []);
  matches.sort((a, b) => a.best.price - b.best.price);
  if (!matches.length) return null;
  const [{ country, result, best }] = matches;

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
