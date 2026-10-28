const PREFERENCE_KEY = 'inspectgo:motion';
const IDLE_MS = 250;
const TRAIL_LENGTH = 115;
let currentCleanup = null;

export function initMotion({ replayIntro = true } = {}) {
  currentCleanup?.();

  const root = document.documentElement;
  const title = document.getElementById('brand-title');
  const titleLetters = title?.querySelector('.title-letters');
  const toggle = document.getElementById('motion-toggle');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const desktopPointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const events = new AbortController();
  const oldMotion = root.getAttribute('data-motion');
  const oldFeedback = root.getAttribute('data-feedback');
  const oldToggleTitle = toggle?.getAttribute('title');
  let preference = true;
  try {
    preference = localStorage.getItem(PREFERENCE_KEY) !== 'off';
  } catch {
    // Storage restrictions must not prevent the page from working.
  }

  const canvas = document.createElement('canvas');
  canvas.className = 'inspectgo-ribbon';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.hidden = true;
  document.body.append(canvas);
  const context = canvas.getContext('2d');
  let width = 1;
  let height = 1;
  let frame = 0;
  let introFrame = 0;
  let flipTimer = 0;
  let disposed = false;
  let overlayOpen = Boolean(document.querySelector('dialog[open]'));
  let pressed = false;
  let flipping = false;
  let lastMove = 0;
  let points = [];

  const on = (target, type, listener, options = {}) => {
    target?.addEventListener(type, listener, { ...options, signal: events.signal });
  };
  const allowed = () => preference && !reducedMotion.matches && !document.hidden && !overlayOpen;
  const hasSelection = () => window.getSelection()?.isCollapsed === false;
  const excluded = target => target instanceof Element && Boolean(
    target.closest('button, input, textarea, select, a, img, [contenteditable="true"], [role="button"]')
  );

  function finishTitle() {
    clearTimeout(flipTimer);
    flipTimer = 0;
    flipping = false;
    title?.classList.remove('is-flipping');
  }

  function playTitle() {
    if (disposed || !allowed() || flipping || !titleLetters) return;
    flipping = true;
    title.classList.add('is-flipping');
    flipTimer = window.setTimeout(finishTitle, 1000);
  }

  function stopRibbon() {
    cancelAnimationFrame(frame);
    frame = 0;
    points = [];
    context?.clearRect(0, 0, width, height);
    canvas.hidden = true;
  }

  function resize() {
    stopRibbon();
    width = window.innerWidth;
    height = window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    context?.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function curve(side) {
    for (let i = 1; i < side.length; i += 1) {
      const previous = side[i - 1];
      const point = side[i];
      context.quadraticCurveTo(previous.x, previous.y, (previous.x + point.x) / 2, (previous.y + point.y) / 2);
    }
    const last = side[side.length - 1];
    context.lineTo(last.x, last.y);
  }

  function draw(now) {
    frame = 0;
    const idle = now - lastMove;
    if (!allowed() || !desktopPointer.matches || pressed || hasSelection() || idle >= IDLE_MS) {
      stopRibbon();
      return;
    }
    context.clearRect(0, 0, width, height);
    points = points.filter(point => now - point.at < IDLE_MS);
    if (points.length > 1) {
      const left = [];
      const right = [];
      points.forEach((point, index) => {
        const before = points[Math.max(0, index - 1)];
        const after = points[Math.min(points.length - 1, index + 1)];
        const dx = after.x - before.x;
        const dy = after.y - before.y;
        const distance = Math.hypot(dx, dy) || 1;
        const halfWidth = 1.65 * (index / (points.length - 1));
        left.push({ x: point.x - dy / distance * halfWidth, y: point.y + dx / distance * halfWidth });
        right.push({ x: point.x + dy / distance * halfWidth, y: point.y - dx / distance * halfWidth });
      });
      const tail = points[0];
      const head = points[points.length - 1];
      const tint = context.createLinearGradient(tail.x, tail.y, head.x, head.y);
      tint.addColorStop(0, 'rgba(15, 118, 110, 0)');
      tint.addColorStop(0.7, 'rgba(15, 118, 110, 0.12)');
      tint.addColorStop(1, 'rgba(2, 132, 199, 0.16)');
      context.globalAlpha = Math.max(0, 1 - idle / IDLE_MS);
      context.fillStyle = tint;
      context.beginPath();
      context.moveTo(left[0].x, left[0].y);
      curve(left);
      right.reverse();
      context.lineTo(right[0].x, right[0].y);
      curve(right);
      context.closePath();
      context.fill();
      context.globalAlpha = 1;
      canvas.hidden = false;
    }
    frame = requestAnimationFrame(draw);
  }

  function move(event) {
    if (!context || event.pointerType !== 'mouse' || !desktopPointer.matches || !allowed() ||
      pressed || event.buttons || excluded(event.target) || hasSelection()) {
      stopRibbon();
      return;
    }
    const point = { x: event.clientX, y: event.clientY, at: performance.now() };
    const previous = points[points.length - 1];
    const distance = previous ? Math.hypot(point.x - previous.x, point.y - previous.y) : 0;
    if (previous && distance < 1) return;
    if (distance > 90) points = [];
    points.push(point);
    if (points.length > 24) points.shift();
    let length = 0;
    for (let i = points.length - 1; i > 0; i -= 1) {
      length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      if (length > TRAIL_LENGTH) {
        points.splice(0, i);
        break;
      }
    }
    lastMove = point.at;
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function updatePolicy() {
    root.dataset.motion = allowed() ? 'on' : 'off';
    const feedback = preference && !reducedMotion.matches && !document.hidden ? 'on' : 'off';
    const feedbackChanged = root.dataset.feedback !== feedback;
    root.dataset.feedback = feedback;
    if (feedbackChanged) {
      document.dispatchEvent(new CustomEvent('inspectgo:feedback', { detail: { enabled: feedback === 'on' } }));
    }
    if (toggle) {
      toggle.checked = preference;
      toggle.title = reducedMotion.matches
        ? '系统已开启减少动态效果，背景、标题、鼠标拖尾和控件点击反馈已暂停；此开关仍会保存你的动效偏好。'
        : '控制背景动效、标题翻转、鼠标短拖尾和控件点击反馈；不影响巡检操作。';
    }
    if (!allowed()) finishTitle();
    stopRibbon();
  }

  function cleanup() {
    if (disposed) return;
    disposed = true;
    events.abort();
    cancelAnimationFrame(introFrame);
    finishTitle();
    stopRibbon();
    canvas.remove();
    if (oldMotion === null) root.removeAttribute('data-motion');
    else root.setAttribute('data-motion', oldMotion);
    if (oldFeedback === null) root.removeAttribute('data-feedback');
    else root.setAttribute('data-feedback', oldFeedback);
    document.dispatchEvent(new CustomEvent('inspectgo:feedback', { detail: { enabled: false } }));
    if (toggle) {
      if (oldToggleTitle === null) toggle.removeAttribute('title');
      else toggle.setAttribute('title', oldToggleTitle);
    }
    if (currentCleanup === cleanup) currentCleanup = null;
  }

  titleLetters?.setAttribute('aria-hidden', 'true');
  on(title, 'pointerenter', event => {
    if (desktopPointer.matches && event.pointerType === 'mouse') playTitle();
  }, { passive: true });
  on(toggle, 'change', () => {
    preference = toggle.checked;
    try {
      localStorage.setItem(PREFERENCE_KEY, preference ? 'on' : 'off');
    } catch {
      // The preference still works for this visit if storage is unavailable.
    }
    updatePolicy();
  });
  on(reducedMotion, 'change', updatePolicy);
  on(desktopPointer, 'change', updatePolicy);
  on(document, 'visibilitychange', () => {
    pressed = false;
    updatePolicy();
  });
  on(document, 'inspectgo:overlay', event => {
    overlayOpen = Boolean(event.detail?.open);
    updatePolicy();
  });
  on(document, 'selectionchange', () => {
    if (hasSelection()) stopRibbon();
  });
  on(document, 'pointerover', event => {
    if (excluded(event.target)) stopRibbon();
  }, { passive: true });
  on(window, 'pointermove', move, { passive: true });
  on(window, 'pointerdown', () => {
    pressed = true;
    stopRibbon();
  }, { passive: true });
  on(window, 'pointerup', () => { pressed = false; }, { passive: true });
  on(window, 'pointercancel', () => { pressed = false; stopRibbon(); }, { passive: true });
  on(document.documentElement, 'pointerleave', stopRibbon, { passive: true });
  on(window, 'blur', () => { pressed = false; stopRibbon(); finishTitle(); });
  on(window, 'scroll', stopRibbon, { passive: true, capture: true });
  on(window, 'resize', resize, { passive: true });
  on(window, 'pagehide', cleanup, { once: true });

  resize();
  updatePolicy();
  // The single entrance never replays on a timer or after a policy change.
  if (replayIntro) {
    introFrame = requestAnimationFrame(() => {
      introFrame = 0;
      playTitle();
    });
  }
  currentCleanup = cleanup;
  return cleanup;
}
