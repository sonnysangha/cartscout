// Reads promo codes the shop is advertising on the page itself, such as a banner saying "Use code: EXTRA".
// It runs inside the page through chrome.scripting.executeScript({ func }), so everything it needs is inside the function.
// It only reads visible text, and only reports a word as a code when the page plainly calls it one.
export function readPageCodes(root = document) {
  const text = String(root.body?.innerText ?? '').slice(0, 80_000);
  if (!text) return [];

  // Words that follow "code" in ordinary sentences and labels, never codes themselves.
  const notCodes = new Set([
    'THE', 'AND', 'FOR', 'AT', 'ON', 'IN', 'TO', 'OR', 'OF', 'IS', 'IT', 'NOW', 'HERE', 'BELOW', 'ABOVE', 'TODAY',
    'NEEDED', 'REQUIRED', 'NECESSARY', 'APPLY', 'APPLIED', 'APPLIES', 'ENTER', 'ENTERED', 'VALID', 'INVALID', 'EXPIRES',
    'EXPIRED', 'ENDS', 'ONLY', 'ONLINE', 'CHECKOUT', 'BASKET', 'CART', 'BAG', 'WHEN', 'WITH', 'YOUR', 'YOU', 'THIS',
    'THAT', 'CODE', 'CODES', 'PROMO', 'DISCOUNT', 'VOUCHER', 'COUPON', 'OFF', 'SHOP', 'COPY', 'COPIED', 'SUBMIT', 'ADD',
    'REMOVE', 'OPTIONAL', 'WILL', 'CAN', 'MUST', 'MAY', 'NOT', 'FROM', 'BEFORE', 'AFTER', 'DURING', 'EXCLUSIONS',
    'TERMS', 'DETAILS', 'INSTORE', 'FIELD', 'BOX', 'AUTOMATICALLY', 'EXCLUSIVE', 'HAS', 'HAVE', 'WAS', 'ARE',
    // Labels of a basket's own promo form and what sits around it.
    'REDEEM', 'UPDATE', 'CONTINUE', 'PROCEED', 'SUBTOTAL', 'TOTAL', 'DELIVERY', 'SHIPPING', 'SUMMARY', 'CANCEL', 'CLOSE',
    'ORDER', 'PAYMENT', 'SECURE', 'CHECK', 'GIFT', 'VALIDATE', 'CONFIRM', 'NEXT', 'BACK',
    'USE', 'USING', 'GET', 'SEE', 'CLICK', 'TAP', 'TYPE', 'PASTE', 'INPUT',
  ]);
  // "postcode", "QR code", "gift card code" and friends are not promotions.
  const otherKinds = /(?:post|postal|zip|bar|qr|country|area|dialling|dialing|sort|security|verification|access|tracking|order|reference|product|item|stock|model|part|sku|ean|upc|style|colou?r|error|source|dress|gift\s*card|pin|referral)\s*$/i;

  const sentenceCase = (value) => (value === value.toUpperCase()
    ? value.charAt(0) + value.slice(1).toLowerCase()
    : value);
  const tidy = (value) => sentenceCase(value.replace(/\s+/g, ' ').replace(/^[\s|–—,.:;*-]+|[\s|–—,.:;*-]+$/g, ''));

  const found = new Map();
  // Group 1: an invitation ("use code", "with code", "enter code"). Group 2: the word offered as the code.
  // The code sits on the same line as the word "code". Only a colon lets it drop to a later line ("Code:" above
  // "SAVE"): without one, the next line is something else, such as the "Subtotal" under an "Apply promo code" button.
  // Every gap is bounded so a page full of whitespace cannot stall the tab.
  const mention = /\b((?:use|using|with|enter|apply|quote)\s{1,10}(?:the\s{1,10})?(?:promo(?:tional)?\s{1,10}|discount\s{1,10}|voucher\s{1,10}|coupon\s{1,10}|offer\s{1,10})?)?code\b(?:[ \t]{0,40}:[ \t]{0,40}(?:\r?\n[ \t]{0,40}){0,3}|[ \t]{0,40}[-–][ \t]{0,40}|[ \t]{1,40})["'‘“]?([A-Za-z0-9][A-Za-z0-9_-]{2,19})(?![A-Za-z0-9_-])/gi;
  for (const match of text.matchAll(mention)) {
    const [whole, invited, joined] = match;
    // Text scraped without its layout can glue a button's label onto the code: "Code:SAVECopiedShop now".
    const word = /^([A-Z0-9][A-Z0-9_-]{2,19})(?:Copied|Copy|Shop|Apply|Use|Get|Click|Tap|Reveal|Show|Terms|Offer|Ends|Valid|See|View|Redeem)/.exec(joined)?.[1] ?? joined;
    const before = text.slice(Math.max(0, match.index - 24), match.index);
    if (!invited && otherKinds.test(before)) continue;
    if (notCodes.has(word.toUpperCase()) || !/[A-Za-z]/.test(word) && word.length < 4) continue;
    // "Code: 10530943" on its own is a reference number. A code made only of digits needs an invitation to use it.
    if (!invited && !/[A-Za-z]/.test(word)) continue;
    const shouted = word === word.toUpperCase();
    const labelled = /code[ \t]{0,40}[:\-–]\s{0,130}["'‘“]?$/i.test(whole.slice(0, whole.length - joined.length));
    // Without an invitation, only a labelled, upper-case or numbered word counts ("Code: SAVE", "code SAVE10").
    if (!invited && !(labelled && shouted) && !(shouted && /\d/.test(word))) continue;
    // With one, a plain lower-case word still has to look deliberate.
    if (invited && !shouted && !/\d/.test(word) && word.length < 4) continue;

    const code = word.toUpperCase();
    if (found.has(code)) continue;
    const from = match.index + whole.length;
    const lineEnd = text.indexOf('\n', from);
    const tail = text.slice(from, Math.min(lineEnd === -1 ? text.length : lineEnd, from + 140));
    // Skip checkout live-region status announcements (e.g. Shopify's "Discount code X has been applied. Updated total price...").
    if (/^\s*(?:has\s+been\s+(?:applied|removed)|was\s+(?:applied|removed)|is\s+(?:applied|invalid|expired|not\s+valid)|cannot\s+be\s+applied|couldn['’]?t\s+be\s+applied|updated\s+total\s+price)/i.test(tail)) {
      continue;
    }
    // The offer is what the same line says before the code is mentioned, or the line above a bare "Code:" label.
    const promising = /\d|%|\bfree\b|\boff\b|\bsave\b/i;
    const statusNoise = /\b(?:has\s+been\s+applied|updated\s+total\s+price|applied\s+to\s+your|british\s+pounds)\b/i;
    const lineBreak = text.lastIndexOf('\n', match.index - 1);
    const lastPart = (fromPos, toPos) => text.slice(Math.max(fromPos, toPos - 140), toPos).split(/[|\u2022\t]|\s{2,}/).at(-1);
    let lead = lastPart(lineBreak + 1, match.index);
    if (!promising.test(lead) || statusNoise.test(lead)) {
      // "Use code SAVE10 for 10% off": the offer follows the code on its own line.
      const rest = tail
        .split(/[|\u2022\t]|\s{2,}|\.(?:\s|$)/)[0]
        .replace(/^\s*(?:at\s+(?:the\s+)?checkout\s+)?(?:for|to\s+(?:get|save|receive|enjoy)|and\s+(?:get|save|receive|enjoy))\s+/i, '');
      if (promising.test(rest) && !statusNoise.test(rest)) lead = rest;
      else lead = '';
    }
    if ((!promising.test(lead) || statusNoise.test(lead)) && lineBreak > 0) {
      // Skip blank lines: the offer is the last thing written above the label.
      const above = text.slice(Math.max(0, lineBreak - 200), lineBreak).split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
      const candidate = above.split(/[|\u2022\t]|\s{2,}/).at(-1);
      if (promising.test(candidate) && !statusNoise.test(candidate)) lead = candidate;
    }
    const offer = tidy(lead.replace(/\b(?:and|then|just|simply|please)\s*$/i, '')).slice(0, 120);
    found.set(code, { code, offer: promising.test(offer) && !statusNoise.test(offer) ? offer : '' });
    if (found.size >= 5) break;
  }
  return [...found.values()];
}
