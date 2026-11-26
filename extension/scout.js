// Scout, the CartScout mascot: a little shopping cart who goes looking for codes.
// One inline SVG; scout.css moves it according to data-mood.

export const SCOUT_MOODS = ['idle', 'wave', 'search', 'work', 'happy', 'party', 'shrug', 'oops'];

// Moods that play once and then rest in another mood.
const SETTLES = { wave: 'idle', happy: 'idle', oops: 'idle' };
const SETTLE_AFTER_MS = { wave: 2300, happy: 2600, oops: 1500 };
const settleTimers = new WeakMap();

// Fixed markup written here, never built from page or network data.
export const SCOUT_SVG = `
<svg class="scout-art" viewBox="-8 -4 104 80" aria-hidden="true" focusable="false">
  <ellipse class="scout-shadow" cx="54" cy="71.500" rx="27" ry="2.600"/>
  <g class="scout-speed">
    <path d="M-5 31h9"/>
    <path d="M-7 41h7"/>
    <path d="M-4 51h9"/>
  </g>
  <g class="scout-cart">
    <g class="scout-flag">
      <path class="scout-pole" d="M32 24V4.500"/>
      <path class="scout-pennant" d="M32 4.600 46 9.400 32 14.200Z"/>
    </g>
    <g class="scout-loot">
      <g class="scout-loot-a">
        <rect x="42" y="9" width="12" height="19" rx="2.600"/>
        <path d="M45 15.500h6"/>
      </g>
      <g class="scout-loot-b">
        <rect x="57" y="11" width="12" height="18" rx="2.600"/>
        <path d="M60 17.500h6"/>
      </g>
    </g>
    <path class="scout-basket" d="M27 24h54q5 0 3.420 4.740l-5.890 17.670Q76 54 68 54H38q-8 0-10.060-7.730l-4.650-17.440Q22 24 27 24Z"/>
    <path class="scout-rim" d="M5 10.500h6.500L18 24h71"/>
    <g class="scout-face">
      <g class="scout-eyes">
        <ellipse class="scout-white" cx="50" cy="37" rx="6.600" ry="7.200"/>
        <ellipse class="scout-white" cx="66" cy="37" rx="6.600" ry="7.200"/>
        <g class="scout-pupils">
          <circle class="scout-pupil" cx="51.800" cy="37.600" r="3.500"/>
          <circle class="scout-pupil" cx="67.800" cy="37.600" r="3.500"/>
          <circle class="scout-glint" cx="50.600" cy="36.200" r="1.150"/>
          <circle class="scout-glint" cx="66.600" cy="36.200" r="1.150"/>
        </g>
      </g>
      <g class="scout-eyes-joy">
        <path d="M45.400 39q4.600-6.600 9.200 0"/>
        <path d="M61.400 39q4.600-6.600 9.200 0"/>
      </g>
      <path class="scout-smile" d="M54 46.400q4 3.600 8 0"/>
      <path class="scout-grin" d="M52.600 45.200h10.800a5.400 5.400 0 0 1-10.800 0Z"/>
      <path class="scout-flat" d="M54.600 47.600h6.800"/>
      <ellipse class="scout-oh" cx="58" cy="47.800" rx="2.300" ry="2.700"/>
    </g>
    <g class="scout-wheel">
      <circle class="scout-tyre" cx="38" cy="62" r="8.500"/>
      <circle class="scout-hub" cx="38" cy="62" r="3.100"/>
      <circle class="scout-hub" cx="38" cy="56.400" r="1.250"/>
    </g>
    <g class="scout-wheel">
      <circle class="scout-tyre" cx="70" cy="62" r="8.500"/>
      <circle class="scout-hub" cx="70" cy="62" r="3.100"/>
      <circle class="scout-hub" cx="70" cy="56.400" r="1.250"/>
    </g>
  </g>
</svg>`;

/**
 * Fill an element with Scout. Give the element its size in CSS (`--scout-size`, or a width) so nothing shifts.
 * `tile` draws the app-icon tile behind Scout, for use as the brand mark.
 * `sticker` gives Scout a white die-cut edge, for yellow surfaces.
 */
export function mountScout(element, { mood = 'idle', tile = false, sticker = false, label = '' } = {}) {
  element.classList.add('scout');
  element.classList.toggle('scout-tile', tile);
  element.classList.toggle('scout-sticker', sticker);
  element.replaceChildren(document.createRange().createContextualFragment(SCOUT_SVG));
  if (label) {
    element.setAttribute('role', 'img');
    element.setAttribute('aria-label', label);
  } else {
    element.setAttribute('aria-hidden', 'true');
  }
  setMood(element, mood);
  return element;
}

export function createScout(options) {
  return mountScout(document.createElement('span'), options);
}

/** Change Scout's mood. Setting the same one-shot mood again replays it. */
export function setMood(element, mood) {
  if (!element) return;
  const next = SCOUT_MOODS.includes(mood) ? mood : 'idle';
  clearTimeout(settleTimers.get(element));
  if (element.dataset.mood === next && next in SETTLES) {
    delete element.dataset.mood;
    void element.offsetWidth;
  }
  element.dataset.mood = next;
  if (next in SETTLES) {
    settleTimers.set(element, setTimeout(() => {
      if (element.dataset.mood === next) element.dataset.mood = SETTLES[next];
    }, SETTLE_AFTER_MS[next]));
  }
}
