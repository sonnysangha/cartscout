// Interactive pick mode (D2): lets the shopper click the discount code box (or apply button) once on any page.
// Ignores clicks on CartScout's own panel host, validates safety via `__cartScoutAutoTry.pick`, and restores any
// temporary highlight outline cleanly on leave, pick, or cancel.

export function createPicker({ host, onPicked, onRejected }) {
  let active = false;
  let kind = 'input'; // 'input' | 'apply'
  let hovered = null;
  let savedOutline = '';
  let savedOffset = '';

  function clearHover() {
    if (!hovered) return;
    try {
      hovered.style.outline = savedOutline;
      hovered.style.outlineOffset = savedOffset;
    } catch {
      // Node detached.
    }
    hovered = null;
    savedOutline = '';
    savedOffset = '';
  }

  function highlight(el) {
    if (el === hovered) return;
    clearHover();
    if (!el || el === host || host.contains(el)) return;
    const api = globalThis.__cartScoutAutoTry?.pick;
    if (api && !api.isSafe(el, kind)) return;
    hovered = el;
    savedOutline = el.style.outline;
    savedOffset = el.style.outlineOffset;
    el.style.outline = '3px solid #ffd23f';
    el.style.outlineOffset = '2px';
  }

  function targetFrom(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    if (path.includes(host)) return null;
    const el = event.target instanceof Element ? event.target : null;
    if (!el) return null;
    if (kind === 'input') return el.closest('input') ?? el;
    return el.closest('button, input[type="submit"], input[type="button"], [role="button"], a') ?? el;
  }

  function onMove(event) {
    if (!active) return;
    highlight(targetFrom(event));
  }

  function onClick(event) {
    if (!active) return;
    const target = targetFrom(event);
    if (!target) return; // Click was inside the CartScout panel itself.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    clearHover();

    const api = globalThis.__cartScoutAutoTry?.pick;
    const part = api?.describe(target, kind) ?? null;
    if (!part) {
      onRejected?.(kind === 'apply'
        ? 'That button doesn’t look safe to click. Click the Apply button next to the code box.'
        : 'That doesn’t look like a discount code box. Click inside the discount input.');
      return;
    }
    stop();
    onPicked?.(kind, part);
  }

  function start(nextKind = 'input') {
    if (active && kind === nextKind) return;
    kind = nextKind;
    if (!active) {
      active = true;
      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('click', onClick, true);
    }
  }

  function stop() {
    if (!active) return;
    active = false;
    clearHover();
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('click', onClick, true);
  }

  return {
    start,
    stop,
    get active() { return active; },
  };
}
