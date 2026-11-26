// The stage is 380 x 560, but Chrome only gives a toolbar popup the room there is between the toolbar and the
// bottom of the screen. On a short screen that is less than 560, and a fixed stage would lose its footer.
// When that happens the stage is told the height it really has (--stage-block in popup.css), so header, tab bar,
// pinned bar and footer keep their heights and only the scrolling middle gets shorter.
//
// Chrome sizes the popup from the document, so shrinking the stage is a one-way street: a reading taken while
// the popup is still growing would lock it small. Nothing is ever shrunk for a tiny, passing viewport, and a
// short reading is only believed at once when the screen agrees there is no more room; otherwise it has to hold.

const root = document.documentElement;
const STAGE_REM = 37;
// Anything under this is the popup before Chrome has sized it, not a real screen.
const LEAST = 320;
// How far the screen's own figure may sit above what Chrome hands over (the popup's frame) and still agree.
const FRAME = 24;
const HOLD_MS = 450;
let holding;

const full = () => STAGE_REM * (Number.parseFloat(getComputedStyle(root).fontSize) || 16);

/** The room from the popup's top edge to the bottom of the usable screen, or Infinity when the screen won't say. */
function roomBelow() {
  const room = window.screen.availTop + window.screen.availHeight - window.screenY;
  return Number.isFinite(room) && room > 0 ? room : Infinity;
}

function fit() {
  const seen = Math.floor(window.innerHeight);
  if (seen >= full()) root.style.removeProperty('--stage-block');
  else if (seen >= LEAST) root.style.setProperty('--stage-block', `${seen}px`);
}

function check() {
  clearTimeout(holding);
  const seen = window.innerHeight;
  if (seen >= full()) {
    // All the room the stage wants (or a window that has been made taller again): nothing to do.
    if (root.style.getPropertyValue('--stage-block')) fit();
    return;
  }
  if (seen < LEAST) return;
  if (roomBelow() < full() + FRAME) fit();
  else holding = setTimeout(fit, HOLD_MS);
}

// Chrome resizes the popup once it has measured the document; that resize is the first reading worth having.
window.addEventListener('resize', check);
// If the popup opened at its final size there is no resize to wait for.
window.addEventListener('load', () => { holding = setTimeout(check, 120); }, { once: true });
