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
