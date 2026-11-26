// Pure decision function mapping a page's `Probe` result to the popup dock's mode and copy.
// Tested directly under node --test (server/popup-probe.test.js).

const countText = (n) => (n === 1 ? '1 code' : `${n} codes`);

/**
 * Decide what the popup's pinned dock should offer when no run is currently active or finished.
 * Returns `{ mode: 'cta' | 'goto' | 'info', action: 'run' | 'pick' | 'goto' | 'none', label, note, info, cart }`.
 */
export function dockPlan({ probe = null, codes = 0, handed = false, pauseUntil = 0, now = Date.now() } = {}) {
  if (handed) {
    return { mode: 'info', action: 'none', label: '', note: '', info: 'Click CartScout in the toolbar to auto-try here.', cart: null };
  }
  if (pauseUntil > now) {
    return { mode: 'info', action: 'none', label: '', note: '', info: 'This shop paused code tries. Try again shortly.', cart: null };
  }
  if (!probe) {
    return { mode: 'info', action: 'none', label: '', note: '', info: 'Open your basket or checkout to auto-try.', cart: null };
  }
  if (!probe.secure || probe.blocked === 'insecure') {
    return { mode: 'info', action: 'none', label: '', note: '', info: 'Auto-try needs HTTPS. Copy and paste at checkout.', cart: null };
  }
  if (probe.blocked === 'frame') {
    return { mode: 'info', action: 'none', label: '', note: '', info: 'Code box is in a separate frame. Copy and paste.', cart: null };
  }
  if (probe.blocked === 'confirmation') {
    return { mode: 'info', action: 'none', label: '', note: '', info: 'Order already placed.', cart: null };
  }
  if (probe.blocked === 'login') {
    return { mode: 'info', action: 'none', label: '', note: '', info: 'Sign in on this shop first to auto-try.', cart: null };
  }
  if (probe.blocked === 'captcha') {
    return { mode: 'info', action: 'none', label: '', note: '', info: 'Finish the security check on the page first.', cart: null };
  }
  if (probe.applied) {
    return { mode: 'info', action: 'none', label: '', note: '', info: 'A code is already applied. Remove it to auto-try.', cart: null };
  }
  if (probe.blocked === 'empty') {
    return { mode: 'info', action: 'none', label: '', note: '', info: 'Add an item to your basket to auto-try.', cart: null };
  }
  if (probe.box === 'found' || probe.box === 'behind' || probe.box === 'recipe') {
    return {
      mode: 'cta',
      action: 'run',
      label: `Try ${countText(codes)} at checkout`,
      note: probe.mode === 'best'
        ? 'Tries all codes and keeps the biggest saving.'
        : 'Tries each code and keeps the first that works.',
      info: '',
      cart: null,
    };
  }
  if (probe.page === 'cart' || probe.page === 'checkout' || probe.candidates > 0) {
    return {
      mode: 'cta',
      action: 'pick',
      label: 'Show Scout the code box',
      note: 'Click the discount box once — Scout remembers it.',
      info: '',
      cart: null,
    };
  }
  if (probe.cart) {
    return {
      mode: 'goto',
      action: 'goto',
      label: 'Open basket to auto-try',
      note: 'Opens your basket on this shop.',
      info: '',
      cart: probe.cart,
    };
  }
  return {
    mode: 'info',
    action: 'none',
    label: '',
    note: '',
    info: probe.where === 'checkout'
      ? 'Open checkout on this shop to auto-try.'
      : 'Open your basket or checkout to auto-try.',
    cart: null,
  };
}
