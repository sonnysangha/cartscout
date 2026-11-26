// Pure outcome classification (D7): evidence in, verdict and thumb decision out.
// Imported by extension/run.js (service worker) and tested directly under node --test.

const REASON_MESSAGES = {
  better: 'A better offer is already on this basket',
  shopper: 'Already used',
  combine: 'Can’t be combined with another offer',
  basket: 'Doesn’t apply to this basket',
  expired: 'Expired',
  usedUp: 'Not valid, or all used up',
  invalid: 'Not a valid code',
  generic: 'The shop turned it down',
};

// Reasons intrinsic to the code itself — including a plain refusal with no basket/account reason —
// automatically earn a thumbs-down. Basket/shopper/better/combine refusals stay neutral.
const VOTE_DOWN_REASONS = new Set(['expired', 'usedUp', 'invalid', 'generic']);

/** Friendly shop name for sentences: e.g. 'Myprotein' on THG nutrition, else 'The shop'. */
export function shopLabel(driver) {
  return driver?.label ? driver.label : 'The shop';
}

/**
 * Classify one attempt's Evidence into a verdict and optional thumb vote.
 *
 * D7 rules:
 * - Strong evidence for thumbs-up: total fell, OR a verified recipe/endpoint applied marker.
 * - Generic marker or recalled recipe marker: accepted (`applied`), NEVER files a thumb.
 * - Strong evidence for thumbs-down: verified recipe/endpoint error with a code-intrinsic reason.
 * - Heuristic wording or recalled recipe error: rejected, NEVER files a thumb.
 * - Basket/shopper/better/combine refusals: rejected, NEVER file a thumb.
 */
export function classifyAnswer(evidence, driver) {
  if (!evidence) {
    return { verdict: 'unclear', outcome: 'error', message: 'No clear answer from the shop' };
  }
  if (evidence.blocked) {
    return { verdict: 'blocked', reason: evidence.blocked };
  }
  if (evidence.pause) {
    return { verdict: 'pause', reason: 'paused' };
  }
  // A verified total drop always proves a saving and earns a thumbs-up.
  if (evidence.total?.comparable && evidence.total.fell) {
    return {
      verdict: 'saved',
      outcome: 'applied',
      message: '',
      vote: true,
    };
  }
  // Marker with effect 'applied' (when total didn't drop or couldn't be read).
  if (evidence.marker?.effect === 'applied') {
    const strong = evidence.marker.trust === 'verified'
      && (evidence.marker.by === 'recipe' || evidence.marker.by === 'endpoint');
    return {
      verdict: 'applied',
      outcome: 'applied',
      message: '',
      ...(strong && { vote: true }),
    };
  }
  // Marker showing the shop parked/ignored the code (e.g. SFRA "Not Applied", Shopify shipping-only).
  if (evidence.marker?.effect === 'none') {
    return {
      verdict: 'rejected',
      outcome: 'rejected',
      message: REASON_MESSAGES.basket,
    };
  }
  // Total rose unexpectedly (e.g. removed an automatic discount): stop safely.
  if (evidence.total?.comparable && evidence.total.rose && !evidence.error) {
    return { verdict: 'rose', reason: 'rose' };
  }
  // Refusal message from recipe, endpoint, or wording next to the box.
  if (evidence.error) {
    const reason = evidence.error.reason || 'generic';
    const message = REASON_MESSAGES[reason] ?? REASON_MESSAGES.generic;
    const voteDown = VOTE_DOWN_REASONS.has(reason);
    return {
      verdict: 'rejected',
      outcome: 'rejected',
      message,
      ...(voteDown && { vote: false }),
    };
  }
  return {
    verdict: 'unclear',
    outcome: 'error',
    message: 'No clear answer from the shop',
  };
}

/** Human-friendly message for an error or refusal reason. */
export function reasonCopy(reason, { driver, code = '', twice = false } = {}) {
  const shop = shopLabel(driver);
  const who = shop === 'The shop' ? 'The shop' : shop;
  switch (reason) {
    case 'paused':
      return {
        title: `${who} asked for a pause`,
        message: `${who} has paused code tries for now. Try again in a few minutes.`,
      };
    case 'captcha':
      return {
        title: 'Security check on this page',
        message: `${who} asked for a security check, so Scout stopped. Finish it on the page, then try again.`,
      };
    case 'login':
      return {
        title: 'Sign in on the shop first',
        message: 'Sign in on this shop’s page first, then open CartScout to try codes.',
      };
    case 'confirmation':
      return {
        title: 'Order already placed',
        message: 'This looks like an order confirmation page, so Scout didn’t try any codes.',
      };
    case 'frame':
      return {
        title: 'Code box is in another frame',
        message: 'This shop’s code box sits inside a separate frame Scout can’t reach. Copy a code and paste it there.',
      };
    case 'insecure':
      return {
        title: 'Only on secure shops',
        message: 'Scout only tries codes on secure HTTPS checkout pages.',
      };
    case 'unsafeForm':
      return {
        title: 'Scout won’t submit this form',
        message: 'That code box shares a form with payment or personal details, so Scout won’t submit it. Paste a code by hand.',
      };
    case 'applied':
      return {
        title: 'Code already on your basket',
        message: 'Your basket already has a promo code applied.',
      };
    case 'occupied':
      return {
        title: 'Code box isn’t empty',
        message: 'Clear the discount field before trying codes.',
      };
    case 'empty':
      return {
        title: 'Your basket looks empty',
        message: driver?.label
          ? `Add an item to your ${driver.label} basket to try codes.`
          : 'Add an item to your basket to try codes.',
      };
    case 'noTotal':
      return {
        title: 'Couldn’t read your total',
        message: 'Scout couldn’t read your basket total on this page, so it didn’t try any codes.',
      };
    case 'noCodes':
      return {
        title: 'No codes to try',
        message: 'There are no codes to try on this basket yet.',
      };
    case 'changed':
      return {
        title: 'Your basket changed',
        message: 'The basket changed while Scout was trying codes. Check it before trying again.',
      };
    case 'rose':
      return {
        title: 'The total went up',
        message: 'The basket total went up while Scout was trying codes, so Scout stopped. Check your basket before you pay.',
      };
    case 'moved':
      return {
        title: 'Scout can’t follow',
        message: 'The shop moved you to another address, where Scout can’t follow. Click the CartScout icon there to carry on.',
      };
    case 'left':
      return {
        title: 'You left the basket',
        message: 'You left the basket, so Scout stopped. Check your basket before trying again.',
      };
    case 'lost':
      return {
        title: 'Lost touch with the page',
        message: 'CartScout lost touch with the basket. Check it before trying again.',
      };
    case 'reloads':
      return {
        title: 'Too many page reloads',
        message: 'This page reloaded too many times, so Scout stopped. Check your basket before trying again.',
      };
    case 'time':
      return {
        title: 'Took too long',
        message: 'Trying codes took longer than usual, so Scout stopped. Check your basket before trying again.',
      };
    case 'silent':
      return {
        title: `${who} didn’t respond`,
        message: `${who} didn’t respond to any code Scout tried. Copy a code and paste it by hand.`,
      };
    case 'restore':
      return {
        title: 'Check your basket',
        message: code
          ? `Scout found a saving with ${code}, but couldn’t put it back on your basket. Copy ${code} and apply it by hand.`
          : 'Scout couldn’t put the best code back on your basket. Check it before you pay.',
      };
    case 'unclear':
      return {
        title: 'Scout couldn’t tell',
        message: twice
          ? `${who} gave no clear answer twice in a row, so Scout stopped. Check your basket before trying again.`
          : `${who} gave no clear answer on ${code || 'the code'}. Check your basket before trying again.`,
      };
    default:
      return {
        title: 'That didn’t go to plan',
        message: 'Scout couldn’t read the basket. Check it before trying again.',
      };
  }
}
