// Small motion helpers shared by the popup, the in-page panel and the account portal.
// Every helper lands on its final state straight away when the user asks for reduced motion.

import { prefersReducedMotion } from './confetti.js';

const EASE_OUT = 'cubic-bezier(.2, .8, .2, 1)';
const EASE_POP = 'cubic-bezier(.34, 1.4, .64, 1)';

/** Count a number up into an element. `format` turns the running value into text; use tabular numerals so it holds its width. */
export function countUp(element, { from = 0, to, duration = 900, format = (value) => String(Math.round(value)) }) {
  if (prefersReducedMotion() || duration <= 0 || from === to) {
    element.textContent = format(to);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const started = performance.now();
    const step = (now) => {
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - (1 - progress) ** 4;
      element.textContent = format(from + (to - from) * eased);
      if (progress < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

/** Swap text like a departure board: characters flicker and lock in from the left. Best in a monospace face. */
export function rollText(element, text, { duration = 420, alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' } = {}) {
  if (prefersReducedMotion() || duration <= 0) {
    element.textContent = text;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const started = performance.now();
    const step = (now) => {
      const progress = Math.min(1, (now - started) / duration);
      const locked = Math.floor(progress * text.length);
      let shown = text.slice(0, locked);
      for (let index = locked; index < text.length; index += 1) {
        shown += /[A-Za-z0-9]/.test(text[index]) ? alphabet[Math.floor(Math.random() * alphabet.length)] : text[index];
      }
      element.textContent = progress < 1 ? shown : text;
      if (progress < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

/** Deal a list of elements in, one after another. Leaves nothing behind in the cascade. */
export function dealIn(elements, { distance = 12, gap = 55, duration = 380, delay = 0 } = {}) {
  if (prefersReducedMotion()) return;
  [...elements].forEach((element, index) => {
    element.animate(
      [{ opacity: 0, translate: `0 ${distance}px`, scale: '.97' }, { opacity: 1, translate: '0 0', scale: '1' }],
      { duration, delay: delay + index * gap, easing: EASE_OUT, fill: 'backwards' },
    );
  });
}

/** A sticker pressed on: in from slightly large and tilted, with one small overshoot. */
export function stickOn(element, { duration = 460, delay = 0, tilt = -6 } = {}) {
  if (prefersReducedMotion()) return;
  element.animate(
    [{ opacity: 0, scale: '1.28', rotate: `${tilt}deg` }, { opacity: 1, scale: '1', rotate: '0deg' }],
    { duration, delay, easing: EASE_POP, fill: 'backwards' },
  );
}

/** Draw the yellow highlighter under a `.swipe` element from left to right. */
export function drawSwipe(element, { duration = 520, delay = 0 } = {}) {
  if (prefersReducedMotion()) return;
  // The stripe's thickness differs between themes, so it is read from the element rather than assumed.
  const thickness = getComputedStyle(element).backgroundSize.split(' ')[1] ?? '.46em';
  element.animate(
    [{ backgroundSize: `0% ${thickness}` }, { backgroundSize: `100% ${thickness}` }],
    { duration, delay, easing: EASE_OUT, fill: 'backwards' },
  );
}

/** Resolve after `ms`, or at once when motion is reduced and the wait is only for show. */
export function beat(ms) {
  return new Promise((resolve) => setTimeout(resolve, prefersReducedMotion() ? 0 : ms));
}
