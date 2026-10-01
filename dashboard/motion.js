// Motion built on the Web Animations API. Every helper is a no-op for readers
// who ask for reduced motion, so the final state is always shown immediately.
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
export const motionOff = () => reduced.matches;

export const EASE_OUT = 'cubic-bezier(.16,1,.3,1)';
export const EASE_SPRING = 'cubic-bezier(.34,1.36,.64,1)';

let running = [];
export function stopAll() {
  for (const animation of running) animation.finish();
  running = [];
}
function track(animation) {
  running.push(animation);
  animation.finished.then(() => { running = running.filter(item => item !== animation); }, () => {});
  return animation;
}

// Rise-and-settle entrance for a group of elements, staggered in reading order.
export function reveal(elements, { delay = 0, step = 45, distance = 14, duration = 620 } = {}) {
  if (motionOff()) return;
  [...elements].forEach((element, index) => track(element.animate([
    { opacity: 0, transform: `translateY(${distance}px) scale(.985)`, filter: 'blur(3px)' },
    { opacity: 1, transform: 'none', filter: 'blur(0)' }
  ], { duration, delay: delay + index * step, easing: EASE_OUT, fill: 'backwards' })));
}

export function fadeIn(element, { duration = 360, delay = 0 } = {}) {
  if (motionOff()) return;
  track(element.animate([{ opacity: 0 }, { opacity: 1 }], { duration, delay, easing: 'ease-out', fill: 'backwards' }));
}

// Counts a figure up from zero, formatting every frame with the final formatter.
export function countUp(element, value, format, { duration = 900, delay = 0 } = {}) {
  element.textContent = format(value);
  if (motionOff() || !Number.isFinite(value) || value === 0) return;
  const start = performance.now() + delay;
  const tick = now => {
    const t = Math.min(1, Math.max(0, (now - start) / duration));
    const eased = 1 - Math.pow(2, -10 * t);
    element.textContent = format(t >= 1 ? value : value * eased);
    if (t < 1) requestAnimationFrame(tick);
  };
  element.textContent = format(0);
  requestAnimationFrame(tick);
}

// Draws an SVG path along its length, as if traced by hand.
export function drawPath(path, { duration = 1100, delay = 120 } = {}) {
  if (motionOff()) return;
  const length = path.getTotalLength();
  if (!length) return;
  path.style.strokeDasharray = `${length}`;
  const animation = track(path.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], { duration, delay, easing: EASE_OUT, fill: 'backwards' }));
  animation.finished.then(() => { path.style.strokeDasharray = ''; }, () => {});
}

export function growX(elements, { delay = 0, step = 35, duration = 700 } = {}) {
  if (motionOff()) return;
  [...elements].forEach((element, index) => track(element.animate([
    { transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }
  ], { duration, delay: delay + index * step, easing: EASE_OUT, fill: 'backwards' })));
}

export function slideIn(element, from = 'right') {
  if (motionOff()) return;
  const offset = from === 'right' ? 'translateX(36px)' : 'translateY(24px)';
  track(element.animate([{ opacity: 0, transform: offset }, { opacity: 1, transform: 'none' }], { duration: 480, easing: EASE_SPRING }));
}

export function slideOut(element, from = 'right') {
  if (motionOff()) return Promise.resolve();
  const offset = from === 'right' ? 'translateX(36px)' : 'translateY(24px)';
  return element.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: offset }], { duration: 220, easing: 'ease-in' }).finished.catch(() => {});
}
