// Confetti in CartScout's own colours: tiny tickets, dots, ribbons and sparkles.
// Each stage gets one canvas, made on first use and removed when the last piece lands.

const TAU = Math.PI * 2;
// Sticker yellow twice so it leads, then the party colours from brand.css.
const COLORS = ['#ffd23f', '#ffd23f', '#ff6fa5', '#4db8ff', '#2fcf8f', '#e2ae00'];
const SHAPES = ['ticket', 'ticket', 'dot', 'ribbon', 'spark'];
const MAX_PIECES = 280;
const stages = new WeakMap();

export function prefersReducedMotion() {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

const between = (min, max) => min + Math.random() * (max - min);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function measure(stage) {
  const { canvas } = stage;
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
  stage.width = canvas.clientWidth;
  stage.height = canvas.clientHeight;
  canvas.width = Math.round(stage.width * ratio);
  canvas.height = Math.round(stage.height * ratio);
  stage.context.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function stageFor(host) {
  let stage = stages.get(host);
  if (stage) return stage;
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;margin:0;border:0;pointer-events:none;z-index:2147483647';
  host.append(canvas);
  stage = { host, canvas, context: canvas.getContext('2d'), pieces: [], frame: 0, last: 0, width: 0, height: 0, waiting: [] };
  stage.onResize = () => measure(stage);
  globalThis.addEventListener('resize', stage.onResize);
  measure(stage);
  stages.set(host, stage);
  return stage;
}

function teardown(stage) {
  cancelAnimationFrame(stage.frame);
  globalThis.removeEventListener('resize', stage.onResize);
  stage.canvas.remove();
  stages.delete(stage.host);
  for (const done of stage.waiting) done(true);
}

function drawPiece(context, piece, alpha) {
  const size = piece.size;
  context.save();
  context.globalAlpha = alpha;
  context.translate(piece.x, piece.y);
  context.rotate(piece.spin);
  // Paper flutters: it turns edge-on and back as it falls.
  if (piece.shape !== 'dot') context.scale(1, Math.cos(piece.flip));
  context.fillStyle = piece.color;
  context.beginPath();
  if (piece.shape === 'dot') {
    context.arc(0, 0, size * 0.32, 0, TAU);
  } else if (piece.shape === 'ribbon') {
    context.roundRect(-size * 0.15, -size * 0.8, size * 0.3, size * 1.6, size * 0.15);
  } else if (piece.shape === 'spark') {
    const reach = size * 0.62;
    const waist = reach * 0.16;
    context.moveTo(0, -reach);
    context.quadraticCurveTo(waist, -waist, reach, 0);
    context.quadraticCurveTo(waist, waist, 0, reach);
    context.quadraticCurveTo(-waist, waist, -reach, 0);
    context.quadraticCurveTo(-waist, -waist, 0, -reach);
  } else {
    // A ticket: rounded corners and a notch bitten out of each short side.
    const halfWidth = size * 0.66;
    const halfHeight = size * 0.4;
    const corner = halfHeight * 0.42;
    const notch = halfHeight * 0.4;
    context.moveTo(-halfWidth + corner, -halfHeight);
    context.lineTo(halfWidth - corner, -halfHeight);
    context.quadraticCurveTo(halfWidth, -halfHeight, halfWidth, -halfHeight + corner);
    context.lineTo(halfWidth, -notch);
    context.arc(halfWidth, 0, notch, -Math.PI / 2, Math.PI / 2, true);
    context.lineTo(halfWidth, halfHeight - corner);
    context.quadraticCurveTo(halfWidth, halfHeight, halfWidth - corner, halfHeight);
    context.lineTo(-halfWidth + corner, halfHeight);
    context.quadraticCurveTo(-halfWidth, halfHeight, -halfWidth, halfHeight - corner);
    context.lineTo(-halfWidth, notch);
    context.arc(-halfWidth, 0, notch, Math.PI / 2, -Math.PI / 2, true);
    context.lineTo(-halfWidth, -halfHeight + corner);
    context.quadraticCurveTo(-halfWidth, -halfHeight, -halfWidth + corner, -halfHeight);
  }
  context.fill();
  context.restore();
}

function tick(stage, now) {
  const elapsed = Math.min((now - stage.last) / 1000, 1 / 30);
  stage.last = now;
  const { context, pieces } = stage;
  context.clearRect(0, 0, stage.width, stage.height);
  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    const piece = pieces[index];
    piece.age += elapsed;
    if (piece.age < 0) continue;
    const damping = Math.exp(-piece.drag * elapsed);
    piece.vx *= damping;
    piece.vy = piece.vy * damping + piece.gravity * elapsed;
    piece.x += (piece.vx + Math.sin(piece.age * piece.swaySpeed + piece.seed) * piece.sway) * elapsed;
    piece.y += piece.vy * elapsed;
    piece.spin += piece.spinSpeed * elapsed;
    piece.flip += piece.flipSpeed * elapsed;
    const remaining = piece.life - piece.age;
    if (remaining <= 0 || piece.y > stage.height + 48) {
      pieces.splice(index, 1);
      continue;
    }
    drawPiece(context, piece, Math.min(1, remaining / piece.fade));
  }
  if (pieces.length) stage.frame = requestAnimationFrame((time) => tick(stage, time));
  else teardown(stage);
}

function pointFrom(origin, stage) {
  if (origin && typeof origin.getBoundingClientRect === 'function') {
    const box = origin.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }
  if (origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)) return origin;
  return { x: stage.width / 2, y: stage.height / 2 };
}

/**
 * Throw one handful of confetti.
 * `origin` is an element (its centre is used) or `{ x, y }` in viewport pixels; the default is the middle of the stage.
 * `angle` is in degrees with -90 pointing straight up. Resolves `true` when the stage is clear, `false` when motion is reduced.
 */
export function burst({
  host = document.body,
  origin,
  count = 36,
  angle = -90,
  spread = 70,
  power,
  size = 9,
  gravity = 900,
  drag = 3.4,
  life = [1.5, 2.6],
  delay = 0,
  jitter = 6,
  colors = COLORS,
  shapes = SHAPES,
} = {}) {
  if (prefersReducedMotion() || !host?.isConnected) return Promise.resolve(false);
  const stage = stageFor(host);
  const start = pointFrom(origin, stage);
  const reach = power ?? Math.min(Math.max(Math.hypot(stage.width, stage.height) * 2.1, 700), 2300);
  const room = Math.max(0, MAX_PIECES - stage.pieces.length);
  for (let index = 0; index < Math.min(count, room); index += 1) {
    const heading = (angle + between(-spread / 2, spread / 2)) * (Math.PI / 180);
    const speed = reach * between(0.35, 1);
    const lifetime = between(life[0], life[1]);
    stage.pieces.push({
      shape: pick(shapes),
      color: pick(colors),
      size: size * between(0.75, 1.3),
      x: start.x + between(-jitter, jitter),
      y: start.y + between(-jitter, jitter),
      vx: Math.cos(heading) * speed,
      vy: Math.sin(heading) * speed,
      gravity: gravity * between(0.8, 1.15),
      drag: drag * between(0.85, 1.2),
      spin: between(0, TAU),
      spinSpeed: between(-7, 7),
      flip: between(0, TAU),
      flipSpeed: between(5, 13),
      sway: between(10, 46),
      swaySpeed: between(2, 5),
      seed: between(0, TAU),
      age: -(delay / 1000) - between(0, 0.06),
      life: lifetime,
      fade: Math.min(0.55, lifetime * 0.3),
    });
  }
  const done = new Promise((resolve) => stage.waiting.push(resolve));
  if (!stage.frame) {
    stage.last = performance.now();
    stage.frame = requestAnimationFrame((time) => tick(stage, time));
  }
  return done;
}

/** A small, quick sparkle for small wins such as a copied code or a "Yes, it worked". */
export function sparkle({ host = document.body, origin, count = 12, colors = COLORS } = {}) {
  return burst({
    host,
    origin,
    count,
    colors,
    shapes: ['spark', 'dot', 'dot', 'ticket'],
    angle: -90,
    spread: 300,
    power: 420,
    size: 7,
    gravity: 520,
    drag: 4.2,
    life: [0.6, 1.05],
    jitter: 3,
  });
}

/**
 * The full celebration for a real saving: a cannon from each lower corner, a pop from the headline,
 * then a light fall from the top. Call it once per win.
 */
export function celebrate({ host = document.body, origin, colors = COLORS } = {}) {
  if (prefersReducedMotion() || !host?.isConnected) return Promise.resolve(false);
  const stage = stageFor(host);
  const { width, height } = stage;
  const cannon = Math.round(Math.min(Math.max(width * height / 2600, 46), 96));
  burst({ host, colors, origin: { x: -8, y: height * 0.94 }, angle: -58, spread: 40, count: cannon });
  burst({ host, colors, origin: { x: width + 8, y: height * 0.94 }, angle: -122, spread: 40, count: cannon });
  if (origin) burst({ host, colors, origin, angle: -90, spread: 170, count: 30, power: 620, delay: 160, size: 8 });
  for (let index = 0; index < 5; index += 1) {
    burst({
      host,
      colors,
      origin: { x: width * (0.1 + index * 0.2), y: -14 },
      angle: 90,
      spread: 50,
      count: 6,
      power: 130,
      gravity: 620,
      delay: 380 + index * 90,
      life: [1.9, 2.9],
      jitter: 24,
    });
  }
  return new Promise((resolve) => stage.waiting.push(resolve));
}

/** Clear a stage at once, for when the view under the confetti goes away. */
export function stopConfetti(host = document.body) {
  const stage = stages.get(host);
  if (!stage) return;
  stage.pieces.length = 0;
  teardown(stage);
}
