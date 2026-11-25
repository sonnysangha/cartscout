// Chrome serializes this function into the active tab's isolated world.
export async function runMyproteinCoupons(codes, background = false) {
  const supported = location.protocol === 'https:'
    && ['www.myprotein.com', 'myprotein.com'].includes(location.hostname)
    && /^\/basket\/?$/.test(location.pathname);
  if (!supported) return { state: 'unsupported' };

  let current = globalThis.cartScoutCouponTrial;
  if (['saved', 'accepted'].includes(current?.state)
    && !document.getElementById('promo-code-remove')) {
    current = undefined;
    delete globalThis.cartScoutCouponTrial;
  }
  if (codes === 'stop' && current?.state === 'running') current.stopRequested = true;
  if (!Array.isArray(codes) || current?.state === 'running') return current ?? { state: 'idle' };

  const candidates = [...new Set(codes.filter((code) => typeof code === 'string'
    && /^[a-z0-9_-]{3,40}$/i.test(code)))].slice(0, 10);
  const find = (id) => document.getElementById(id);
  const addButton = () => find('promo-code-add');
  const applied = () => !!find('promo-code-remove');
  const input = () => find('promo-code-input');

  function subtotal() {
    const labels = [...document.querySelectorAll('main span, main p')];
    for (const label of labels) {
      if (label.childElementCount || label.textContent.trim() !== 'Basket subtotal:') continue;
      const money = label.nextElementSibling?.textContent.match(/£\s*([\d,]+)\.(\d{2})/);
      if (money) return Number(money[1].replaceAll(',', '')) * 100 + Number(money[2]);
    }
    return null;
  }

  function setInput(field, value) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function waitForResponse(button) {
    return new Promise((resolve) => {
      const previous = find('promo-error-message');
      let changed = false;
      const observer = new MutationObserver((records) => {
        changed ||= records.some(({ target }) => find('promo-error-message')?.contains(target));
      });
      observer.observe(document.body, { childList: true, characterData: true, subtree: true });
      const started = performance.now();
      const timer = setInterval(() => {
        const alert = find('promo-error-message');
        const error = alert?.textContent.trim();
        if (applied()) finish('accepted');
        else if (error && (changed || alert !== previous)) {
          finish(/invalid|max redemptions|not (?:valid|applicable|apply|recognised|recognized)|expired|cannot be applied|does not apply|aren.t eligible|requirements/i
            .test(error) ? 'rejected' : 'unknown');
        } else if (performance.now() - started >= 5000) finish('unknown');
      }, 100);

      function finish(outcome) {
        clearInterval(timer);
        observer.disconnect();
        resolve(outcome);
      }

      button.click();
    });
  }

  if (!candidates.length || !input() || !addButton()) return { state: 'unavailable' };
  if (applied()) return { state: 'alreadyApplied' };
  if (input().value.trim()) return { state: 'inputOccupied' };
  const before = subtotal();
  if (before === null) return { state: 'unavailable' };

  const progress = { state: 'running', attempted: 0, total: candidates.length, rejected: [] };
  globalThis.cartScoutCouponTrial = progress;
  let lastCode = '';

  function complete(result) {
    Object.assign(progress, result);
    return progress;
  }

  async function attempt() {
    try {
      for (const code of candidates) {
        const field = input();
        const button = addButton();
        if (!field || !button || button.disabled || applied() || subtotal() !== before
          || (field.value && field.value !== lastCode)) {
          return complete({ state: 'changed' });
        }
        progress.attempted += 1;
        lastCode = code;
        progress.code = code;
        setInput(field, code);
        const outcome = await waitForResponse(button);
        if (outcome === 'rejected') {
          progress.rejected.push(code);
          if (progress.stopRequested) {
            if (input()?.value === code) setInput(input(), '');
            return complete({ state: 'stopped' });
          }
          continue;
        }
        if (outcome !== 'accepted') return complete({ state: 'unknown', code });

        // The applied marker can appear just before the subtotal finishes rendering.
        for (let check = 0; check < 10; check += 1) {
          const after = subtotal();
          if (applied() && after !== null && after < before) {
            return complete({ state: 'saved', code, before, after });
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return complete({ state: 'accepted', code });
      }
      // Clear only the last rejected value written by CartScout.
      const field = input();
      if (field?.value === lastCode) setInput(field, '');
      return complete({ state: 'noMatch' });
    } catch {
      return complete({ state: 'unknown', code: lastCode });
    }
  }

  if (background) {
    void attempt();
    return progress;
  }
  return attempt();
}

export function readMyproteinBasket() {
  if (location.protocol !== 'https:' || !['www.myprotein.com', 'myprotein.com'].includes(location.hostname)
    || !/^\/basket\/?$/.test(location.pathname)) return [];

  const items = new Map();
  for (const row of document.querySelectorAll('main basket-item')) {
    const link = [...row.querySelectorAll('a[href^="/p/"]')].find((anchor) => anchor.textContent.trim());
    if (!link || !row.querySelector('[data-e2e="basket-remove_item_button"]')) continue;
    const name = link.textContent.trim();
    const specs = link?.parentElement.nextElementSibling;
    const variant = specs?.tagName === 'UL'
      ? [...specs.querySelectorAll('li')].map((spec) => spec.textContent.trim().replace(/\s*-\s*\d+\s*servings?$/i, ''))
        .filter(Boolean).join(', ').slice(0, 100)
      : '';
    const branded = (/^myprotein\b/i.test(name) ? name : `Myprotein ${name}`).slice(0, 140);
    items.set(JSON.stringify([branded, variant]), { name: branded, variant });
  }
  return [...items.values()];
}
