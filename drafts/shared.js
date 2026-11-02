/* Shared harness for the visual drafts: fake tracks, generated test covers,
 * palette extraction, a smooth compositor-driven spinner, idle-UI handling,
 * and a tiny control channel so drafts/index.html can drive any draft. */
'use strict';

(() => {
  const W = 900;   // cover canvas size

  /* ───────── Test covers (drawn on canvas; no image files) ───────── */

  function canvas() { const c = document.createElement('canvas'); c.width = c.height = W; return [c, c.getContext('2d')]; }
  function grain(g, amount = 14, alpha = 1) {
    const d = g.getImageData(0, 0, W, W); const p = d.data;
    for (let i = 0; i < p.length; i += 4) { const n = (Math.random() - 0.5) * amount * alpha; p[i] += n; p[i + 1] += n; p[i + 2] += n; }
    g.putImageData(d, 0, 0);
  }
  function lg(g, x0, y0, x1, y1, stops) { const gr = g.createLinearGradient(x0, y0, x1, y1); stops.forEach(([o, c]) => gr.addColorStop(o, c)); return gr; }

  const drawers = {
    sunset(g) {
      g.fillStyle = lg(g, 0, 0, 0, W, [[0, '#ffb14a'], [0.45, '#f0603f'], [0.75, '#b8306a'], [1, '#4b1858']]); g.fillRect(0, 0, W, W);
      g.fillStyle = '#ffe08a'; g.beginPath(); g.arc(W / 2, W * 0.6, W * 0.24, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#4b1858';
      for (let i = 0; i < 7; i++) { const y = W * 0.6 + i * 22 + 10; g.fillRect(0, y, W, 6 + i * 2.6); }
      g.fillRect(0, W * 0.78, W, W);
      g.fillStyle = 'rgba(255,240,220,.9)'; g.font = '600 34px Inter, sans-serif'; g.letterSpacing = '8px';
      g.fillText('LOW SUN', 60, 90); grain(g, 18);
    },
    paper(g) {
      g.fillStyle = '#f2eee6'; g.fillRect(0, 0, W, W);
      g.fillStyle = '#16140f'; g.beginPath(); g.arc(W * 0.66, W * 0.36, 70, 0, Math.PI * 2); g.fill();
      g.fillRect(90, W * 0.36, W * 0.5, 2);
      g.font = '400 26px Inter, sans-serif'; g.letterSpacing = '10px'; g.fillText('PAPER MOON', 90, W - 90);
      grain(g, 12);
    },
    neon(g) {
      g.fillStyle = '#07070b'; g.fillRect(0, 0, W, W);
      g.save(); g.translate(W / 2, W / 2); g.rotate(-0.42);
      g.shadowBlur = 50; g.shadowColor = '#19e3ff'; g.fillStyle = '#19e3ff'; g.fillRect(-W, -70, W * 2, 14);
      g.shadowColor = '#ff2fa8'; g.fillStyle = '#ff2fa8'; g.fillRect(-W, 40, W * 2, 8);
      g.restore(); g.shadowBlur = 0;
      g.fillStyle = 'rgba(255,255,255,.85)'; g.font = '700 28px Inter, sans-serif'; g.letterSpacing = '6px';
      g.fillText('NIGHT DRIVE', 60, W - 70); grain(g, 10);
    },
    garden(g) {
      g.fillStyle = '#1d5a3a'; g.fillRect(0, 0, W, W);
      const cols = ['#2f8a55', '#7cc36b', '#e8d44d', '#2bb3a3', '#0f3d27', '#f2a2b8', '#a7d989'];
      let s = 7; const r = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
      for (let i = 0; i < 120; i++) {
        g.fillStyle = cols[Math.floor(r() * cols.length)];
        g.save(); g.translate(r() * W, r() * W); g.rotate(r() * Math.PI);
        g.beginPath(); g.ellipse(0, 0, 30 + r() * 70, 12 + r() * 26, 0, 0, Math.PI * 2); g.fill(); g.restore();
      }
      grain(g, 14);
    },
    fog(g) {
      g.fillStyle = lg(g, 0, 0, W, W, [[0, '#7d8b97'], [1, '#cfd6da']]); g.fillRect(0, 0, W, W);
      g.filter = 'blur(40px)';
      g.fillStyle = 'rgba(255,255,255,.55)'; g.beginPath(); g.ellipse(W * 0.35, W * 0.55, 260, 90, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(60,72,84,.5)'; g.beginPath(); g.ellipse(W * 0.7, W * 0.3, 200, 70, 0, 0, Math.PI * 2); g.fill();
      g.filter = 'none';
      g.fillStyle = 'rgba(30,36,42,.75)'; g.font = '300 30px Inter, sans-serif'; g.letterSpacing = '4px';
      g.fillText('weather report', 70, 110); grain(g, 22);
    },
    primary(g) {
      g.fillStyle = '#efe8d8'; g.fillRect(0, 0, W, W);
      g.fillStyle = '#d7322b'; g.fillRect(80, 80, 380, 380);
      g.fillStyle = '#1f4fa8'; g.beginPath(); g.arc(620, 600, 200, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#f2c230'; g.beginPath(); g.moveTo(120, 820); g.lineTo(420, 820); g.lineTo(270, 560); g.fill();
      g.fillStyle = '#111'; g.fillRect(500, 80, 20, 360); g.fillRect(560, 80, 260, 20);
      grain(g, 10);
    },
  };

  const TRACKS = [
    { title: 'Golden Hour Again', artist: 'Mara Lin', cover: 'sunset', name: 'Warm sunset' },
    { title: 'Paper Moon', artist: 'The Quiet Rooms', cover: 'paper', name: 'Near-white minimal' },
    { title: 'Night Drive (Extended Mix)', artist: 'Kōji & The Signal', cover: 'neon', name: 'Black + neon' },
    { title: 'Greenhouse', artist: 'Fern Avenue', cover: 'garden', name: 'Busy greens' },
    { title: 'Weather Report, Part II: The Long Grey Afternoon', artist: 'Halden', cover: 'fog', name: 'Muted grey (long title)' },
    { title: 'Primary', artist: 'Studio Form', cover: 'primary', name: 'Primaries on cream' },
  ];

  /* ───────── Colour helpers + palette extraction ───────── */

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b); const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min; const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function hslToRgb([h, s, l]) {
    h = ((h % 360) + 360) % 360 / 360;
    if (!s) return [l * 255, l * 255, l * 255].map(Math.round);
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255));
  }
  const lum = ([r, g, b]) => { const c = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b); };
  const css = (rgb, a = 1) => (a === 1 ? `rgb(${rgb.map(Math.round).join(' ')})` : `rgb(${rgb.map(Math.round).join(' ')} / ${a})`);
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

  function palette(img) {
    const N = 48; const c = document.createElement('canvas'); c.width = c.height = N;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, N, N);
    const d = g.getImageData(0, 0, N, N).data;
    const bins = new Map(); let L = 0;
    for (let i = 0; i < d.length; i += 4) {
      const rgb = [d[i], d[i + 1], d[i + 2]]; L += lum(rgb);
      const k = (d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | (d[i + 2] >> 4);
      const b = bins.get(k) || { n: 0, r: 0, g: 0, b: 0 }; b.n++; b.r += rgb[0]; b.g += rgb[1]; b.b += rgb[2]; bins.set(k, b);
    }
    const colors = [...bins.values()].map((b) => ({ rgb: [b.r / b.n, b.g / b.n, b.b / b.n], n: b.n })).sort((a, b) => b.n - a.n);
    const total = N * N;
    const dominant = colors[0].rgb;
    let vibrant = null, best = -1;
    for (const col of colors) {
      const [, s, l] = rgbToHsl(col.rgb);
      const score = s * (1 - Math.abs(l - 0.52) * 1.6) * Math.sqrt(col.n / total);
      if (score > best) { best = score; vibrant = col.rgb; }
    }
    const [, vs] = rgbToHsl(vibrant);
    return { dominant, vibrant, colorful: vs > 0.22 && best > 0.02, lum: L / total, colors: colors.slice(0, 6).map((x) => x.rgb) };
  }

  /* ───────── Smooth spinner ─────────
   * The steady spin is a Web Animation, so it runs on the compositor and stays
   * smooth even if the main thread is busy. Starting/stopping eases the
   * playbackRate along a sine curve: no jerks, no fake "physics". */
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  function spinner(el, { rpm = 100 / 3, up = 1600, down = 2200 } = {}) {
    const period = 60000 / rpm;
    const anim = el.animate([{ transform: 'rotate(0turn)' }, { transform: 'rotate(1turn)' }], { duration: period, iterations: Infinity });
    anim.currentTime = Math.random() * period;
    anim.playbackRate = 0;
    let rate = 0, raf = 0;
    const ease = (t) => 0.5 - Math.cos(Math.PI * t) / 2;
    return {
      set(on, instant) {
        const target = on && !reduced.matches ? 1 : 0;
        cancelAnimationFrame(raf);
        if (instant) { rate = target; anim.playbackRate = rate; return; }
        const from = rate, dur = target > from ? up : down, t0 = performance.now();
        const step = (now) => {
          const t = Math.min(1, (now - t0) / (dur * Math.abs(target - from) || 1));
          rate = from + (target - from) * ease(t);
          anim.playbackRate = rate;
          if (t < 1) raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
      },
    };
  }

  /* ───────── Image layer crossfade helper ─────────
   * Give it two stacked <img>/<div> layers; it swaps the hidden one in. */
  function crossfader(layers, apply) {
    let front = 0;
    return (value) => {
      const back = layers.map((pair) => pair[1 - front]);
      back.forEach((el) => apply(el, value));
      layers.forEach((pair) => { pair[1 - front].classList.add('on'); pair[front].classList.remove('on'); });
      front = 1 - front;
    };
  }

  /* ───────── State + events ───────── */

  const listeners = { track: [], play: [] };
  const saved = (() => { try { return JSON.parse(localStorage.getItem('dsvinyl.drafts') || '{}'); } catch { return {}; } })();
  const DS = {
    tracks: TRACKS, index: saved.index || 0, playing: saved.playing !== false,
    duration: 214000, progress: 61000, at: performance.now(),
    on(type, fn) { listeners[type].push(fn); },
    emit(type, ...a) { listeners[type].forEach((fn) => fn(...a)); },
    get track() { return TRACKS[this.index]; },
    progressNow() { return Math.min(this.duration, this.progress + (this.playing ? performance.now() - this.at : 0)); },
    toggle() { this.progress = this.progressNow(); this.at = performance.now(); this.playing = !this.playing; persist(); this.emit('play', this.playing); },
    go(i, dir = 1) {
      this.index = (i + TRACKS.length) % TRACKS.length; this.progress = 0; this.at = performance.now(); persist();
      this.emit('track', this.track, dir);
    },
    next() { this.go(this.index + 1, 1); }, prev() { this.go(this.index - 1, -1); },
    palette, spinner, crossfader, rgbToHsl, hslToRgb, lum, css, mix, clamp, reduced,
  };
  function persist() {
    try { localStorage.setItem('dsvinyl.drafts', JSON.stringify({ index: DS.index, playing: DS.playing })); } catch { /* ignore */ }
    if (parent !== window) parent.postMessage({ type: 'ds-state', index: DS.index, playing: DS.playing, name: DS.track.name }, '*');
  }

  // Render covers once, then let the draft start.
  const ready = Promise.all(TRACKS.map((t) => new Promise((res) => {
    const [c, g] = canvas(); drawers[t.cover](g);
    t.url = c.toDataURL('image/jpeg', 0.9);
    const img = new Image(); img.onload = () => { t.img = img; t.palette = palette(img); res(); }; img.src = t.url;
  })));
  DS.ready = (fn) => ready.then(() => { fn(DS.track); persist(); });

  /* ───────── Input: controls, keys, idle UI, parent messages ───────── */

  addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    ({ prev: () => DS.prev(), next: () => DS.next(), toggle: () => DS.toggle() })[b.dataset.act]();
    b.blur();
  });
  addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); DS.toggle(); }
    else if (e.key === 'ArrowRight') DS.next();
    else if (e.key === 'ArrowLeft') DS.prev();
  });
  addEventListener('message', (e) => {
    const m = e.data || {}; if (m.type !== 'ds') return;
    if (m.act === 'next') DS.next(); else if (m.act === 'prev') DS.prev(); else if (m.act === 'toggle') DS.toggle();
    else if (m.act === 'ping') persist();
  });
  let idleTimer = 0;
  const wake = () => {
    document.body.classList.remove('idle'); clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
  };
  addEventListener('mousemove', wake); addEventListener('pointerdown', wake);
  document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('idle');
    if (parent === window) {   // opened directly: add a small dev bar
      const bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;top:10px;right:10px;z-index:99;display:flex;gap:6px;font:12px Inter,system-ui,sans-serif';
      bar.innerHTML = ['prev:‹ cover', 'toggle:play/pause', 'next:cover ›'].map((s) => { const [a, l] = s.split(':'); return `<button data-act="${a}" style="background:#0008;color:#fff;border:1px solid #fff3;border-radius:6px;padding:4px 8px;cursor:pointer">${l}</button>`; }).join('') +
        '<a href="index.html" style="background:#0008;color:#fff;border:1px solid #fff3;border-radius:6px;padding:4px 8px;text-decoration:none">all drafts</a>';
      document.body.appendChild(bar);
    }
  });

  window.DS = DS;
})();
