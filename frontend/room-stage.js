// Room stage: native 3D circular carousel, warp transition and parallax.
// No third-party component source; visual mechanics adapted from the approved design.

const STEP_FALLBACK = 45;
const CARD_W = 236;
const CARD_H = 302;
const CARD_GAP = 26;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const wrapDeg = degrees => ((((degrees + 180) % 360) + 360) % 360) - 180;
const pad2 = value => String(value).padStart(2, '0');

function motionAllowed() {
  return document.documentElement.dataset.motion !== 'off' &&
    !matchMedia('(prefers-reduced-motion: reduce)').matches &&
    !document.hidden;
}

function createRoomStage({ getPoints, onSelect, onEnter }) {
  const stage = document.getElementById('room-stage');
  const viewport = document.getElementById('room-carousel');
  const ring = document.getElementById('room-ring');
  const countEl = document.getElementById('room-active-count');
  const totalEl = document.getElementById('room-count');
  const nameEl = document.getElementById('room-selected-name');
  const locationEl = document.getElementById('room-selected-location');
  const statusEl = document.getElementById('room-selected-status');
  const enterBtn = document.getElementById('room-enter');
  const arrows = [...document.querySelectorAll('#room-stage .room-arrow')];
  const emptyEl = document.getElementById('room-placeholder');
  if (!stage || !viewport || !ring) return { sync() {} };

  let points = [];
  let cards = [];
  let active = 0;
  let position = 0;
  let dragging = false;
  let suppressClick = false;
  let warping = false;
  let pointer = null;
  let wheelLock = 0;
  let scrollFrame = 0;
  let scrollTimer = 0;
  let mobile = matchMedia('(max-width: 767px)').matches;

  function pointFor(id) {
    return points.find(point => point.point_id === id) || null;
  }

  function coverage(point) {
    if (!point.required) return ['不计入必检统计', 'muted'];
    if (point.covered) return ['现场记录有效', 'good'];
    return ['缺少有效记录', 'warn'];
  }

  function statusOf(point) {
    if (point.latest_status === 'alarm') return ['告警待关注', 'danger'];
    if (point.latest_status === 'ok') return ['最近记录正常', 'good'];
    if (point.latest_status === 'unknown') return ['状态待确认', 'warn'];
    return ['暂无状态记录', 'muted'];
  }

  function illustration(point, index) {
    const text = `${point.device || ''}${point.point_id || ''}`;
    if (/照明|灯/.test(text)) return 'lamp';
    if (/空调|排风|机柜/.test(text)) return 'climate';
    if (/网络|交换/.test(text)) return 'network';
    if (/电源|配电/.test(text)) return 'power';
    if (/门禁|禁/.test(text)) return 'access';
    if (/水|给排/.test(text)) return 'water';
    if (/消防|火/.test(text)) return 'fire';
    if (/传感|环境/.test(text)) return 'sensor';
    return ['lamp', 'climate', 'network', 'power', 'access', 'sensor', 'water', 'fire'][index % 8];
  }

  function illustrationMarkup(kind) {
    if (kind === 'lamp') return '<i class="illu-glow"></i><i class="illu-lamp"></i><i class="illu-floor"></i>';
    if (kind === 'climate') return '<i class="climate-orbit"></i><i class="climate-snow">✳</i><i class="illu-floor"></i>';
    if (kind === 'network') return '<i class="network-node"></i><i class="network-line network-line--a"></i><i class="network-line network-line--b"></i><i class="network-line network-line--c"></i><i class="illu-floor"></i>';
    if (kind === 'power') return '<i class="power-bolt">ϟ</i><i class="power-ring"></i><i class="illu-floor"></i>';
    if (kind === 'access') return '<i class="access-panel"><b></b><b></b><b></b></i><i class="access-wave"></i><i class="illu-floor"></i>';
    if (kind === 'water') return '<i class="water-drop">⌁</i><i class="water-ripple"></i><i class="illu-floor"></i>';
    if (kind === 'fire') return '<i class="fire-shield"><b>✓</b></i><i class="fire-ring"></i><i class="illu-floor"></i>';
    return '<i class="sensor-body"><b></b></i><i class="sensor-wave"></i><i class="illu-floor"></i>';
  }

  function cardMarkup(point, index, total) {
    const [coverageText, coverageTone] = coverage(point);
    const [statusText, statusTone] = statusOf(point);
    const tone = statusTone === 'danger' ? 'warn' : statusTone === 'warn' ? 'warn' : statusTone === 'muted' ? 'muted' : 'check';
    const statusIcon = tone === 'warn' ? '!' : tone === 'muted' ? '·' : '✓';
    const kind = illustration(point, index);
    return `<button class="room-card" data-point="${point.point_id}" type="button"
      aria-label="${point.device}，${point.building}${point.floor}，点位 ${index + 1} / ${total}"
      aria-pressed="false">
      <span class="room-card__top"><span class="room-code">${point.point_id} <i>·</i> ${point.required ? '必检' : '普通'}</span><span class="room-card__arrow">↗</span></span>
      <span class="room-illustration"><span class="illu-scene">${illustrationMarkup(kind)}</span></span>
      <span class="room-card__name">${point.device}</span>
      <span class="room-card__location">${point.building} <i>/</i> ${point.floor} <b>·</b> ${point.zone_id}</span>
      <span class="room-card__status ${tone === 'warn' ? 'status-warn' : tone === 'muted' ? 'status-muted' : ''}">
        <i class="${tone === 'warn' ? 'status-warn-icon' : tone === 'muted' ? 'status-muted-icon' : 'status-check'}">${statusIcon}</i>
        ${statusTone === 'danger' ? statusText : coverageText}
      </span>
    </button>`;
  }

  function render() {
    const previousId = points[active]?.point_id;
    ring.replaceChildren();
    cards = [];
    totalEl.textContent = pad2(points.length);
    if (!points.length) {
      emptyEl.hidden = false;
      emptyEl.textContent = '暂无巡查点位';
      viewport.hidden = true;
      enterBtn.disabled = true;
      nameEl.textContent = '暂无点位';
      locationEl.textContent = '等待巡检数据';
      statusEl.textContent = '';
      return;
    }
    emptyEl.hidden = true;
    viewport.hidden = false;
    enterBtn.disabled = false;
    ring.insertAdjacentHTML('beforeend', points.map((point, index) => cardMarkup(point, index, points.length)).join(''));
    cards = [...ring.querySelectorAll('.room-card')];
    const nextIndex = previousId ? Math.max(0, points.findIndex(point => point.point_id === previousId)) : 0;
    active = nextIndex >= 0 ? nextIndex : 0;
    cards.forEach((card, index) => {
      card.addEventListener('click', () => onCardClick(index));
      card.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onCardActivate(index);
        }
      });
    });
    position = active;
    updateSelection(false);
    apply(false);
    ensureRevealed();
  }

  function apply() {
    if (mobile) {
      ring.style.transform = 'none';
      cards.forEach(card => {
        card.style.transform = '';
        card.style.opacity = '';
        card.style.zIndex = '';
        card.style.visibility = '';
        card.style.pointerEvents = '';
      });
      return;
    }
    const count = points.length || 1;
    cards.forEach((card, index) => {
      let offset = index - position;
      offset = ((offset % count) + count) % count;
      if (offset > count / 2) offset -= count;
      const distance = Math.abs(offset);
      const visible = distance <= 2.2;
      const scale = 1 - Math.min(distance, 2.2) * 0.07;
      card.style.transform = `translateX(${(offset * 250).toFixed(2)}px) rotateY(${(-offset * 13).toFixed(2)}deg) scale(${scale.toFixed(4)})`;
      card.style.opacity = '1';
      card.style.zIndex = String(Math.round(100 - distance * 10));
      card.style.visibility = visible ? '' : 'hidden';
      card.style.pointerEvents = visible ? '' : 'none';
    });
  }

  function updateSelection(notify = true) {
    const point = points[active];
    if (!point) return;
    countEl.textContent = pad2(active + 1);
    nameEl.textContent = point.device;
    const [coverageText] = coverage(point);
    const [statusText] = statusOf(point);
    locationEl.textContent = `${point.building} · ${point.floor} · ${point.point_id}`;
    statusEl.textContent = `${coverageText} · ${statusText}`;
    cards.forEach((card, index) => {
      const isActive = index === active;
      card.classList.toggle('is-active', isActive);
      card.setAttribute('aria-pressed', String(isActive));
    });
    if (notify && typeof onSelect === 'function') onSelect(point);
    if (mobile && notify) {
      cards[active]?.scrollIntoView({ behavior: motionAllowed() ? 'smooth' : 'auto', inline: 'center', block: 'nearest' });
    }
  }

  function setActive(index, { notify = true, animate = true } = {}) {
    if (!points.length) return;
    const count = points.length;
    let target = index;
    while (target - position > count / 2) target -= count;
    while (target - position < -count / 2) target += count;
    position = target;
    active = ((Math.round(target) % count) + count) % count;
    if (mobile) {
      updateSelection(notify);
      return;
    }
    if (!animate) ring.classList.add('is-dragging');
    apply();
    if (!animate) {
      requestAnimationFrame(() => ring.classList.remove('is-dragging'));
    }
    updateSelection(notify);
  }

  function onCardClick(index) {
    if (suppressClick) return;
    if (index === active) {
      sparkAtCenter(cards[index]);
      warp();
      return;
    }
    setActive(index, { notify: true, animate: true });
  }

  function onCardActivate(index) {
    if (index === active) warp();
    else setActive(index, { notify: true, animate: true });
  }

  function sparkAtCenter(element) {
    if (!element || !motionAllowed()) return;
    const rect = element.getBoundingClientRect();
    spark(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  function spark(x, y) {
    if (!motionAllowed()) return;
    const canvas = document.createElement('canvas');
    canvas.id = 'room-spark';
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(innerWidth * ratio);
    canvas.height = Math.round(innerHeight * ratio);
    canvas.style.width = innerWidth + 'px';
    canvas.style.height = innerHeight + 'px';
    document.body.append(canvas);
    const context = canvas.getContext('2d');
    if (!context) { canvas.remove(); return; }
    context.scale(ratio, ratio);
    const start = performance.now();
    const colors = ['#0f766e', '#0284c7', '#ffffff'];
    const rays = Array.from({ length: 10 }, (_, index) => ({
      angle: (index / 10) * Math.PI * 2 + Math.random() * 0.2,
      length: 26 + Math.random() * 18,
      offset: Math.random() * 2
    }));
    function frame(now) {
      const progress = Math.min(1, (now - start) / 320);
      context.clearRect(0, 0, innerWidth, innerHeight);
      context.globalAlpha = 1 - progress;
      context.lineWidth = 1;
      rays.forEach((ray, index) => {
        const distance = 4 + (ray.length - 4) * progress;
        const x1 = x + Math.cos(ray.angle) * distance;
        const y1 = y + Math.sin(ray.angle) * distance;
        const x2 = x + Math.cos(ray.angle) * (distance + 7);
        const y2 = y + Math.sin(ray.angle) * (distance + 7);
        context.strokeStyle = colors[index % colors.length];
        context.beginPath();
        context.moveTo(x1, y1);
        context.lineTo(x2, y2);
        context.stroke();
      });
      if (progress < 1) requestAnimationFrame(frame);
      else canvas.remove();
    }
    requestAnimationFrame(frame);
  }

  function warp() {
    const point = points[active];
    const card = cards[active];
    if (!point || !card || warping) return;
    if (!motionAllowed() || !card.animate) {
      onEnter?.(point);
      return;
    }
    warping = true;
    const rect = card.getBoundingClientRect();
    const layer = document.createElement('div');
    layer.id = 'warp-layer';
    layer.setAttribute('aria-hidden', 'true');
    const clone = document.createElement('div');
    clone.className = 'warp-clone room-card';
    clone.setAttribute('aria-hidden', 'true');
    clone.innerHTML = card.innerHTML;
    clone.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    clone.querySelectorAll('button').forEach(node => { node.disabled = true; node.tabIndex = -1; });
    clone.style.position = 'fixed';
    clone.style.left = `${rect.left}px`;
    clone.style.top = `${rect.top}px`;
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    clone.style.margin = '0';
    clone.style.transformOrigin = 'top left';
    clone.style.zIndex = '2';
    clone.style.opacity = '1';
    layer.innerHTML = '<div class="warp-tunnel"></div><div class="warp-flash"></div>';
    layer.append(clone);
    document.body.append(layer);
    const scaleX = innerWidth / Math.max(1, rect.width);
    const scaleY = innerHeight / Math.max(1, rect.height);
    const animation = clone.animate([
      { transform: 'translate(0, 0) scale(1)', borderRadius: '14px' },
      { transform: `translate(${-rect.left}px, ${-rect.top}px) scale(${scaleX}, ${scaleY})`, borderRadius: '0px' }
    ], { duration: 560, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'forwards' });
    const cleanup = () => {
      animation.cancel();
      layer.remove();
      warping = false;
    };
    animation.finished.then(() => {}, () => {});
    window.setTimeout(() => {
      try { onEnter?.(point); } catch { /* the drawer owns its own errors */ }
    }, 620);
    window.setTimeout(cleanup, 900);
  }

  function pointerDown(event) {
    if (mobile || event.button !== 0 || !points.length) return;
    pointer = { x: event.clientX, startPosition: position, moved: false };
    viewport.setPointerCapture?.(event.pointerId);
  }

  function pointerMove(event) {
    if (!pointer || mobile) return;
    const dx = event.clientX - pointer.x;
    if (!pointer.moved && Math.abs(dx) < 5) return;
    if (!pointer.moved) {
      pointer.moved = true;
      dragging = true;
      ring.classList.add('is-dragging');
      viewport.classList.add('is-dragging');
    }
    position = pointer.startPosition - dx / 250;
    apply();
  }

  function pointerUp() {
    if (!pointer) return;
    const moved = pointer.moved;
    pointer = null;
    if (!moved) return;
    dragging = false;
    ring.classList.remove('is-dragging');
    viewport.classList.remove('is-dragging');
    const index = Math.round(position);
    suppressClick = true;
    setActive(index, { notify: true, animate: true });
    window.setTimeout(() => { suppressClick = false; }, 60);
  }

  function pointerCancel() {
    pointer = null;
    dragging = false;
    ring.classList.remove('is-dragging');
    viewport.classList.remove('is-dragging');
  }

  function onWheel(event) {
    if (mobile || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    event.preventDefault();
    const now = performance.now();
    if (now - wheelLock < 220) return;
    wheelLock = now;
    setActive(active + (event.deltaX > 0 ? 1 : -1), { notify: true, animate: true });
  }

  function onKeyDown(event) {
    if (!points.length) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(active + 1, { notify: true, animate: true });
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(active - 1, { notify: true, animate: true });
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActive(0, { notify: true, animate: true });
    } else if (event.key === 'End') {
      event.preventDefault();
      setActive(points.length - 1, { notify: true, animate: true });
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (event.target === viewport) {
        event.preventDefault();
        warp();
      }
    }
  }

  function sync(nextPoints) {
    const list = Array.isArray(nextPoints) ? nextPoints : [];
    const signature = list.map(point => `${point.point_id}:${point.device}:${point.covered}:${point.latest_status}:${point.review?.status || ''}`).join('|');
    const previousSignature = points.map(point => `${point.point_id}:${point.device}:${point.covered}:${point.latest_status}:${point.review?.status || ''}`).join('|');
    if (signature === previousSignature && list.length === points.length) return;
    const focusedCard = document.activeElement?.closest?.('.room-card');
    const hadFocus = Boolean(focusedCard && ring.contains(focusedCard));
    const activeId = points[active]?.point_id;
    points = list;
    render();
    if (activeId) {
      const index = points.findIndex(point => point.point_id === activeId);
      if (index >= 0) setActive(index, { notify: false, animate: false });
    }
    if (hadFocus) cards[active]?.focus({ preventScroll: true });
  }

  function syncFromSearch() {
    const search = document.getElementById('search');
    if (!search || !points.length) return;
    const query = search.value.trim();
    if (!query) return;
    const index = points.findIndex(point =>
      point.point_id.toLocaleLowerCase() === query.toLocaleLowerCase() ||
      point.device.toLocaleLowerCase() === query.toLocaleLowerCase()
    );
    if (index >= 0 && index !== active) setActive(index, { notify: false, animate: true });
  }

  function syncFromScope() {
    const select = document.getElementById('mobile-scope');
    if (!select || !points.length) return;
    const value = select.value;
    if (value === 'all') return;
    const [kind, name] = value.split(':');
    const index = points.findIndex(point => kind === 'building' ? point.building === name : point.zone_id === name);
    if (index >= 0 && index !== active) setActive(index, { notify: false, animate: true });
  }

  function ensureRevealed() {
    if (!stage) return;
    if (!motionAllowed()) { stage.classList.add('is-revealed'); return; }
    if (stage.classList.contains('is-revealed')) return;
    stage.classList.add('is-revealed');
  }

  function updateParallax() {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      if (!motionAllowed() || mobile) {
        document.documentElement.style.setProperty('--parallax-ambient', '0px');
        stage.style.setProperty('--parallax-stage', '0px');
        return;
      }
      const y = window.scrollY || 0;
      document.documentElement.style.setProperty('--parallax-ambient', `${clamp(-y * 0.04, -40, 40).toFixed(2)}px`);
      stage.style.setProperty('--parallax-stage', `${clamp(-y * 0.10, -48, 48).toFixed(2)}px`);
    });
  }

  function onScroll() {
    updateParallax();
    window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(() => { scrollTimer = 0; }, 160);
  }

  function onResize() {
    const nextMobile = matchMedia('(max-width: 767px)').matches;
    if (nextMobile !== mobile) {
      mobile = nextMobile;
      apply(false);
      updateSelection(false);
    } else if (!mobile) {
      apply(false);
    }
  }

  viewport.addEventListener('pointerdown', pointerDown, { passive: true });
  viewport.addEventListener('pointermove', pointerMove, { passive: true });
  viewport.addEventListener('pointerup', pointerUp, { passive: true });
  viewport.addEventListener('pointercancel', pointerCancel, { passive: true });
  viewport.addEventListener('pointerleave', event => { if (pointer && !pointer.moved) pointer = null; }, { passive: true });
  viewport.addEventListener('wheel', onWheel, { passive: false });
  viewport.addEventListener('keydown', onKeyDown);
  arrows.forEach(button => button.addEventListener('click', () => setActive(active + Number(button.dataset.dir), { notify: true, animate: true })));
  enterBtn.addEventListener('click', event => {
    const rect = enterBtn.getBoundingClientRect();
    spark(rect.left + rect.width / 2, rect.top + rect.height / 2);
    warp();
  });
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      pointerCancel();
      document.querySelectorAll('#room-spark').forEach(node => node.remove());
    }
  });
  document.addEventListener('inspectgo:data', event => sync(event.detail?.points));
  document.getElementById('search')?.addEventListener('input', syncFromSearch);
  document.getElementById('mobile-scope')?.addEventListener('change', syncFromScope);
  document.addEventListener('inspectgo:feedback', event => {
    if (!event.detail?.enabled) {
      pointerCancel();
      document.querySelectorAll('#warp-layer, #room-spark').forEach(node => node.remove());
      warping = false;
    }
    updateParallax();
  });

  ensureRevealed();
  updateParallax();
  const initial = typeof getPoints === 'function' ? getPoints() : [];
  if (initial?.length) sync(initial);

  return { sync, focusById(id) { const index = points.findIndex(point => point.point_id === id); if (index >= 0) setActive(index, { notify: false, animate: true }); } };
}

export function initRoomStage(options) {
  return createRoomStage(options);
}
