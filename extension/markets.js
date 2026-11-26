export const markets = {
  GB: ['United Kingdom', 'GBP'],
  US: ['United States', 'USD'],
  AE: ['United Arab Emirates', 'AED'],
  AU: ['Australia', 'AUD'],
  CA: ['Canada', 'CAD'],
  DE: ['Germany', 'EUR'],
  FR: ['France', 'EUR'],
  IE: ['Ireland', 'EUR'],
  NL: ['Netherlands', 'EUR'],
};

export const basketLimit = 4;

const timeZoneMarkets = {
  'Europe/London': 'GB',
  'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US',
  'America/Phoenix': 'US', 'America/Los_Angeles': 'US', 'America/Anchorage': 'US',
  'Pacific/Honolulu': 'US',
  'Asia/Dubai': 'AE',
  'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Perth': 'AU',
  'Australia/Brisbane': 'AU', 'Australia/Adelaide': 'AU',
  'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'America/Edmonton': 'CA',
  'America/Winnipeg': 'CA', 'America/Halifax': 'CA',
  'Europe/Berlin': 'DE', 'Europe/Paris': 'FR', 'Europe/Dublin': 'IE', 'Europe/Amsterdam': 'NL',
};

export function suggestMarket(timeZone, languages) {
  if (Object.hasOwn(timeZoneMarkets, timeZone)) return timeZoneMarkets[timeZone];
  for (const language of languages) {
    const region = new Intl.Locale(language).region;
    if (Object.hasOwn(markets, region)) return region;
  }
  return 'GB';
}

const currencyMarkets = { GBP: 'GB', USD: 'US', AED: 'AE', AUD: 'AU', CAD: 'CA' };
const euroMarkets = { de: 'DE', fr: 'FR', ie: 'IE', nl: 'NL' };
// A shop's address says where it sells: lego.co.uk is a UK shop wherever the shopper's clock is set.
const domainMarkets = [
  [/\.co\.uk$|\.uk$/, 'GB'], [/\.com\.au$|\.au$/, 'AU'], [/\.ca$/, 'CA'], [/\.de$/, 'DE'],
  [/\.fr$/, 'FR'], [/\.ie$/, 'IE'], [/\.nl$/, 'NL'], [/\.ae$/, 'AE'],
];

function marketFromHost(host) {
  const name = String(host ?? '').toLowerCase().replace(/\.$/, '');
  return domainMarkets.find(([ending]) => ending.test(name))?.[1];
}

/**
 * The country to compare prices in when the shopper has not chosen one: the currency the page prices its product
 * in, then the shop's own address, and only then a guess from the clock. Comparing a pound price with dirham
 * listings tells nobody anything.
 */
export function marketFor({ currency, host, timeZone, languages = [] } = {}) {
  const code = typeof currency === 'string' ? currency.toUpperCase() : '';
  if (Object.hasOwn(currencyMarkets, code)) return currencyMarkets[code];
  const fromHost = marketFromHost(host);
  if (code === 'EUR') return Object.values(euroMarkets).includes(fromHost) ? fromHost : 'DE';
  return fromHost ?? suggestMarket(timeZone, languages);
}
