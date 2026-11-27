export const COUPON_SOURCE_TARGET = 20;
export const COUPON_SEARCH_LIMIT = 4;
export const COUPON_SEARCH_TIMEOUT = 12_000;
const MAX_QUERY_EXCLUSIONS = 22;
const OPEN_PUBLISHERS = [
  'wethrift.com', 'couponbirds.com', 'worthepenny.com', 'dontpayfull.com', 'retailcoupons.com',
  'simplycodes.com', 'retailmenot.com', 'coupert.com',
];
const UK_PUBLISHERS = [
  'discountcode.dailymail.co.uk', 'discountcodes.thesun.co.uk', 'vouchers4u.com', 'everysaving.co.uk',
  'vouchercloud.com', 'voucherbox.co.uk', 'whatsdiscount.co.uk',
];

const ISOLATED_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net',
  'myshopify.com', 'shopify.com', 'bigcartel.com', 'squarespace.com', 'wixsite.com',
  'storenvy.com', 'wordpress.com', 'blogspot.com', 'github.io', 'netlify.app',
  'vercel.app', 'pages.dev', 'web.app', 'firebaseapp.com', 'herokuapp.com',
]);

/** @param {string} host A normalized hostname. */
export function storefrontDomain(host) {
  const labels = host.split('.');
  const twoPartSuffix = labels.length >= 3
    && labels.at(-1).length === 2
    && /^(?:co|com|org|net|ac|gov|ne|or)$/.test(labels.at(-2));
  const domain = labels.slice(twoPartSuffix ? -3 : -2).join('.');
  return ISOLATED_DOMAINS.has(domain) ? null : domain;
}

/** @param {string} host A normalized hostname. */
export const couponPublisher = (host) => storefrontDomain(host) ?? host;

/**
 * Search once, then look across different query terms and exclusions if there
 * are too few eligible publishers. A failed follow-up keeps the candidates
 * found so far and leaves success/failure reporting to the scan's ledger.
 *
 * @param {{
 *   merchant: string,
 *   excluded: string[],
 *   location?: string,
 *   publishers: Map<string, unknown>,
 *   search: (query: string) => Promise<Array<Record<string, unknown>>>,
 *   collect: (results: Array<Record<string, unknown>>) => void,
 * }} options
 */
export async function collectCouponSearch({ merchant, excluded, location, publishers, search, collect }) {
  const exclusions = (hosts) => hosts.map(host => `-site:${host}`).join(' ');
  const recent = [...new Set(excluded.map(couponPublisher))].reverse();
  const name = merchant === 'johnlewis.com' ? '"John Lewis"' : merchant;
  const omitRecent = exclusions(recent.slice(0, MAX_QUERY_EXCLUSIONS));
  const initial = recent.length
    ? `${name} voucher code ${omitRecent}`
    : `${merchant} coupon codes promo codes discount checkout`;
  collect(await search(initial));
  if (publishers.size >= COUPON_SOURCE_TARGET) return;

  const known = new Set([...recent, ...publishers.keys()]);
  const excludeCandidates = exclusions([...recent, ...publishers.keys()].slice(0, MAX_QUERY_EXCLUSIONS));
  const targets = [...OPEN_PUBLISHERS, ...(location === 'GB' ? UK_PUBLISHERS : [])]
    .filter(host => !known.has(couponPublisher(host)));
  const publisherQuery = targets.length
    ? `(${targets.slice(0, 9).map(host => `site:${host}`).join(' OR ')})`
    : excludeCandidates;
  const queries = [
    `${name} savings offers "discount codes" -site:${merchant} ${excludeCandidates}`,
    `${name} "promo code" voucher (student OR membership OR cashback OR newsletter) -site:${merchant}`,
    `${name} voucher code ${publisherQuery}`,
  ];
  const settled = await Promise.allSettled(queries.map(query => search(query.trim())));
  for (const result of settled) {
    if (result.status === 'fulfilled') collect(result.value);
  }
}
