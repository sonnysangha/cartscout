// Multi-currency money parser and formatter for checkout totals and savings.
// Pure: runs in both the injected page bundle and Node unit tests.

const CLEAN_RE = /[\u200e\u200f\u00ad]/g;
const APOSTROPHE_GROUP_RE = /(\d)['’](?=\d{3})/g;
const FOOTNOTE_RE = /[*†‡]+\s*$/;
const INSTALMENT_RE = /\b(?:\d+\s*(?:x|payments?|instal?ments?|months?)|per\s+month|\/mo\b|monthly)\b/i;

// Unambiguous currency symbols/codes -> ISO 4217. Bare "$" and "kr" are ambiguous across countries, so currency is ''.
const SYMBOL_TO_ISO = {
  '£': 'GBP', gbp: 'GBP',
  '€': 'EUR', eur: 'EUR',
  '¥': 'JPY', '￥': 'JPY', jpy: 'JPY',
  '₹': 'INR', inr: 'INR',
  '₩': 'KRW', krw: 'KRW',
  '₽': 'RUB', rub: 'RUB',
  '₺': 'TRY', try: 'TRY',
  '₪': 'ILS', ils: 'ILS',
  '₫': 'VND', vnd: 'VND',
  '฿': 'THB', thb: 'THB',
  '₴': 'UAH', uah: 'UAH',
  '₦': 'NGN', ngn: 'NGN',
  '₱': 'PHP', php: 'PHP',
  'zł': 'PLN', zl: 'PLN', pln: 'PLN',
  'kč': 'CZK', kc: 'CZK', czk: 'CZK',
  ft: 'HUF', huf: 'HUF',
  lei: 'RON', ron: 'RON',
  chf: 'CHF',
  usd: 'USD', us$: 'USD',
  cad: 'CAD', c$: 'CAD', ca$: 'CAD',
  aud: 'AUD', a$: 'AUD', au$: 'AUD',
  nzd: 'NZD', nz$: 'NZD',
  r$: 'BRL', brl: 'BRL',
  sek: 'SEK', nok: 'NOK', dkk: 'DKK',
  aed: 'AED', sar: 'SAR', kwd: 'KWD',
};

const CURRENCY_TOKEN = String.raw`(?:US\$|CA?\$|AU?\$|NZ\$|R\$|[£$€¥￥₹₩₽₺₪₫฿₴₦₱]|(?<![A-Za-z])(?:zł|Kč)(?![A-Za-z])|\b(?:GBP|EUR|USD|CAD|AUD|NZD|CHF|SEK|NOK|DKK|PLN|CZK|HUF|RON|AED|SAR|KWD|BRL|INR|JPY|zl|kc|kr\.?|Ft|lei)\b)`;
const NUMBER_TOKEN = String.raw`\d{1,3}(?:[.,\s'\u2019]\d{3})*(?:[.,]\d{1,3})?|\d+(?:[.,]\d{1,3})?`;

// Match either prefix currency + number (+ optional trailing ISO code), or number + suffix currency.
const PRICE_RE = new RegExp(
  `^(?:(?<sign>[-−])\\s*)?(?:(?<pre>${CURRENCY_TOKEN})\\s*)?(?:(?<sign2>[-−])\\s*)?(?<num>${NUMBER_TOKEN})(?:\\s*(?<post>${CURRENCY_TOKEN}))?$`,
  'i',
);

const ALL_MONEY_RE = new RegExp(
  `(?:${CURRENCY_TOKEN})\\s*\\d|\\d\\s*(?:${CURRENCY_TOKEN})`,
  'gi',
);

function detectCurrency(pre, post) {
  for (const raw of [post, pre]) {
    if (!raw) continue;
    const key = raw.trim().replace(/\.$/, '').toLowerCase();
    if (Object.hasOwn(SYMBOL_TO_ISO, key)) return SYMBOL_TO_ISO[key];
  }
  return '';
}

function parseNumber(rawNum, currency) {
  const compact = rawNum.replace(/[\u00a0\u202f\u2009]/g, ' ');
  let group = '';
  let decimal = '';
  let decimals = 0;

  const lastDot = compact.lastIndexOf('.');
  const lastComma = compact.lastIndexOf(',');
  const hasSpace = /\s/.test(compact);
  const hasApos = /['’]/.test(compact);

  if (lastDot !== -1 && lastComma !== -1) {
    // Both separators present: whichever appears last is the decimal separator.
    if (lastComma > lastDot) {
      group = '.';
      decimal = ',';
      decimals = compact.length - lastComma - 1;
    } else {
      group = ',';
      decimal = '.';
      decimals = compact.length - lastDot - 1;
    }
  } else if (lastComma !== -1) {
    const after = compact.length - lastComma - 1;
    const count = (compact.match(/,/g) ?? []).length;
    if (count === 1 && (after === 1 || after === 2)) {
      decimal = ',';
      decimals = after;
      if (hasSpace) group = ' ';
      else if (hasApos) group = "'";
    } else if (count === 1 && after === 3 && currency === 'KWD') {
      decimal = ',';
      decimals = 3;
    } else {
      group = ',';
    }
  } else if (lastDot !== -1) {
    const after = compact.length - lastDot - 1;
    const count = (compact.match(/\./g) ?? []).length;
    if (count === 1 && (after === 1 || after === 2)) {
      decimal = '.';
      decimals = after;
      if (hasSpace) group = ' ';
      else if (hasApos) group = "'";
    } else if (count === 1 && after === 3 && currency === 'KWD') {
      decimal = '.';
      decimals = 3;
    } else {
      group = '.';
    }
  } else if (hasSpace) {
    group = ' ';
  } else if (hasApos) {
    group = "'";
  }

  let normalized = compact.replace(/[\s'’]/g, '');
  if (group) normalized = normalized.replaceAll(group, '');
  if (decimal && decimal !== '.') normalized = normalized.replace(decimal, '.');
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return {
    value,
    group: group || (decimal === ',' ? '.' : ','),
    decimal: decimal || '.',
    decimals: Math.min(3, Math.max(0, decimals)),
  };
}

/**
 * Parse a single money string into `{ value, currency, format }` or `null`.
 * Rejects multiple prices in one string, instalment strings, zero (unless `allowZero`), and unpriced text.
 */
export function parseMoney(raw, { allowZero = false, allowBare = false, currency: fallbackCurrency = '' } = {}) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(CLEAN_RE, '').replace(FOOTNOTE_RE, '').replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length > 36 || INSTALMENT_RE.test(cleaned)) return null;

  // Reject two prices side by side (e.g. "£49.99 £39.99").
  const tokens = cleaned.match(ALL_MONEY_RE) ?? [];
  if (tokens.length > 2) return null;
  // Also reject two separate numeric blocks with spaces between them unless it's space-grouped thousands.
  if (/[£$€¥￥₹]\s*\d[\d.,]*\s+[£$€¥￥₹]\s*\d/.test(cleaned)) return null;

  // Handle "GBP £67.95" where an ISO code precedes a symbol.
  let isoHint = '';
  let candidate = cleaned;
  const leadingIso = /^(GBP|EUR|USD|CAD|AUD|NZD|CHF|SEK|NOK|DKK|PLN|CZK|HUF|RON|AED|SAR|KWD)\s+([£$€¥￥₹])/i.exec(candidate);
  if (leadingIso) {
    isoHint = leadingIso[1].toUpperCase();
    candidate = candidate.slice(leadingIso[1].length).trim();
  }

  const match = PRICE_RE.exec(candidate);
  if (!match?.groups?.num) return null;
  if (match.groups.sign || match.groups.sign2) return null;
  const { pre = '', num, post = '' } = match.groups;
  if (!pre && !post && !isoHint && !allowBare) return null;

  const currency = isoHint || detectCurrency(pre, post) || (allowBare ? fallbackCurrency : '');
  // Keep Swiss apostrophes intact for format detection, strip for arithmetic inside parseNumber.
  const parsed = parseNumber(num.replace(APOSTROPHE_GROUP_RE, "$1'"), currency);
  if (!parsed) return null;
  if (parsed.value < 0 || (!allowZero && parsed.value === 0)) return null;

  const preSpaced = pre ? (new RegExp(`${pre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`).test(candidate) ? `${pre} ` : pre) : '';
  const postSpaced = post ? (new RegExp(`\\s${post.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(candidate) ? ` ${post}` : post) : '';
  return {
    value: parsed.value,
    currency,
    format: {
      prefix: preSpaced,
      suffix: postSpaced,
      group: parsed.group,
      decimal: parsed.decimal,
      decimals: parsed.decimals,
    },
  };
}

/** Format a numeric amount using the shop's own MoneyFormat (or Intl currency fallback). */
export function formatMoney(value, format, currency = '') {
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  if (format && typeof format === 'object') {
    const decimals = Number.isInteger(format.decimals) ? Math.min(3, Math.max(0, format.decimals)) : 2;
    const fixed = Math.abs(num).toFixed(decimals);
    const [whole, frac] = fixed.split('.');
    const grouped = format.group ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, format.group) : whole;
    const body = frac !== undefined ? `${grouped}${format.decimal || '.'}${frac}` : grouped;
    return `${num < 0 ? '-' : ''}${format.prefix ?? ''}${body}${format.suffix ?? ''}`;
  }
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(num);
    } catch {
      // Fall through.
    }
  }
  return num.toFixed(2);
}

const ZERO_MINOR = new Set(['JPY', 'KRW', 'VND', 'HUF', 'CLP', 'ISK']);
const THREE_MINOR = new Set(['KWD', 'BHD', 'OMR', 'JOD', 'TND']);

/** Format an integer amount in minor units (e.g. Shopify / WooCommerce Store API cents) into a Money object. */
export function moneyFromMinor(minorAmount, currency = '', minorUnit = null, kind = 'total', label = 'Total') {
  const iso = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency.toUpperCase()) ? currency.toUpperCase() : '';
  const resolvedUnit = Number.isInteger(minorUnit)
    ? minorUnit
    : (ZERO_MINOR.has(iso) ? 0 : THREE_MINOR.has(iso) ? 3 : 2);
  const scale = 10 ** resolvedUnit;
  const value = Number(minorAmount) / scale;
  if (!Number.isFinite(value) || value < 0) return null;
  const symbolMap = { GBP: '£', EUR: '€', USD: '$', CAD: 'CA$', AUD: 'A$', JPY: '¥', PLN: ' zł', SEK: ' kr', DKK: ' kr' };
  const suffixSet = new Set(['PLN', 'SEK', 'DKK', 'NOK', 'CZK']);
  const sym = symbolMap[iso] ?? (iso ? `${iso} ` : '');
  const format = suffixSet.has(iso)
    ? { prefix: '', suffix: sym, group: ' ', decimal: ',', decimals: resolvedUnit }
    : { prefix: sym, suffix: '', group: ',', decimal: '.', decimals: resolvedUnit };
  const text = formatMoney(value, format, iso);
  return { value, text, kind, label, currency: iso, format };
}

/** True when two Money objects are in the same currency and can be compared arithmetically. */
export function sameCurrency(a, b) {
  if (!a || !b) return false;
  if (a.currency && b.currency) return a.currency === b.currency;
  return (a.format?.prefix ?? '').trim() === (b.format?.prefix ?? '').trim()
    && (a.format?.suffix ?? '').trim() === (b.format?.suffix ?? '').trim();
}
