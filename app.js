/* dsvinyl — a cozy now-playing display for Spotify.
 * Vanilla JS. Auth is PKCE with the Client ID only; no secret anywhere. */
'use strict';

// Paste your Spotify app's Client ID here (developer.spotify.com → Dashboard → your app).
const CLIENT_ID = 'PASTE_YOUR_CLIENT_ID_HERE';

/* ───────────────────────── Config ───────────────────────── */

const SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state';
const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, '');
const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const CONFIGURED = /^[0-9a-zA-Z]{16,}$/.test(CLIENT_ID);

const POLL_PLAYING = 5000;          // while music plays
const POLL_IDLE = 20000;            // paused / nothing playing
const BACKOFF_START = 2000;
const BACKOFF_MAX = 60000;
const FETCH_TIMEOUT = 10000;        // a dropped Wi-Fi link shouldn't hang a request forever
const REFRESH_EARLY = 5 * 60000;    // refresh the access token 5 min before it expires
const GRACE_MS = 4000;              // how long an optimistic play/pause outranks a stale poll

const DEG_PER_MS = (100 / 3) * 360 / 60000;   // 33⅓ RPM
const SPIN_UP_MS = 1200;
const SPIN_DOWN_MS = 2600;
const ARM_REST = 0, ARM_LEAD_IN = 26.5, ARM_RUN_OUT = 50;   // degrees, from the plinth geometry

const K = {
  access: 'dsvinyl.access', expires: 'dsvinyl.expires', refresh: 'dsvinyl.refresh',
  verifier: 'dsvinyl.verifier', state: 'dsvinyl.state', last: 'dsvinyl.last',
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode / full: carry on in memory */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const $ = (s) => document.querySelector(s);
const root = document.documentElement;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

class AuthError extends Error {}
class NetError extends Error {}
class RateLimited extends Error { constructor(ms) { super('rate limited'); this.ms = ms; } }

/* ───────────────────────── Network ───────────────────────── */

async function timedFetch(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal, cache: 'no-store' });
  } catch (e) {
    throw new NetError(e && e.message);       // offline, DNS, timeout, CORS on an error page…
  } finally {
    clearTimeout(timer);
  }
}

function retryAfterMs(res) {
  const h = res.headers.get('Retry-After');
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(1000, secs * 1000);
  const date = Date.parse(h);
  return Number.isFinite(date) ? Math.max(1000, date - Date.now()) : null;
}

/* ───────────────────────── Auth (PKCE) ───────────────────────── */

const auth = {
  access: store.get(K.access),
  expiresAt: Number(store.get(K.expires)) || 0,
  refresh: store.get(K.refresh),
  pending: null,
  timer: 0,
  dead: false,
};

function randomString(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function login() {
  if (!CONFIGURED) return;
  const verifier = randomString(64);
  const state = randomString(16);
  store.set(K.verifier, verifier);
  store.set(K.state, state);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: await challengeFor(verifier),
    scope: SCOPES,
    state,
  });
  location.assign(`${AUTH_URL}?${params}`);
}

async function handleRedirect() {
  const p = new URLSearchParams(location.search);
  if (!p.has('code') && !p.has('error')) return;
  history.replaceState(null, '', REDIRECT_URI);
  const verifier = store.get(K.verifier);
  const expected = store.get(K.state);
  store.del(K.verifier);
  store.del(K.state);
  if (!p.get('code') || !verifier || p.get('state') !== expected) return;   // cancelled or stale
  try {
    const res = await timedFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: p.get('code'),
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      }),
    });
    if (res.ok) saveTokens(await res.json());
  } catch { /* the Connect button stays up; one more click fixes it */ }
}

function saveTokens(data) {
  auth.access = data.access_token;
  auth.expiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  if (data.refresh_token) auth.refresh = data.refresh_token;   // Spotify may rotate it
  store.set(K.access, auth.access);
  store.set(K.expires, String(auth.expiresAt));
  if (auth.refresh) store.set(K.refresh, auth.refresh);
  auth.dead = false;
  showConnect(false);
  scheduleRefresh();
}

function adoptStoredTokens() {           // another tab (or an earlier session) may hold newer tokens
  const r = store.get(K.refresh);
  const a = store.get(K.access);
  const e = Number(store.get(K.expires)) || 0;
  if (r) auth.refresh = r;
  if (a && e > auth.expiresAt) { auth.access = a; auth.expiresAt = e; }
}

function scheduleRefresh() {
  clearTimeout(auth.timer);
  const ms = Math.max(5000, auth.expiresAt - Date.now() - REFRESH_EARLY);
  auth.timer = setTimeout(() => {
    refreshAccess().catch((e) => { if (e instanceof AuthError) setAuthDead(); });
    // Network trouble here is fine: the next API call refreshes on demand.
  }, ms);
}

// One refresh at a time: with rotating refresh tokens, two parallel refreshes would burn one.
function refreshAccess() {
  if (!auth.pending) auth.pending = doRefresh(0).finally(() => { auth.pending = null; });
  return auth.pending;
}

async function doRefresh(attempt) {
  adoptStoredTokens();
  if (!auth.refresh) throw new AuthError('no refresh token');
  const used = auth.refresh;
  const res = await timedFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: used, client_id: CLIENT_ID }),
  });
  if (res.ok) {
    let data = null;
    try { data = await res.json(); } catch { /* fall through */ }
    if (!data || !data.access_token) throw new NetError('bad token response');
    saveTokens(data);
    return;
  }
  if (res.status === 400 || res.status === 401) {
    // Rejected. If another tab rotated the token meanwhile, use theirs; otherwise we're signed out.
    const latest = store.get(K.refresh);
    if (latest && latest !== used && attempt < 2) return doRefresh(attempt + 1);
    throw new AuthError('refresh rejected');
  }
  if (res.status === 429) throw new RateLimited(retryAfterMs(res));
  throw new NetError(`token endpoint ${res.status}`);   // 5xx: transient, keep the tokens
}

async function ensureAccess() {
  if (auth.dead) throw new AuthError('signed out');
  if (auth.access && auth.expiresAt - Date.now() > 60000) return;
  await refreshAccess();
}

async function api(method, path, retried = false) {
  await ensureAccess();
  const res = await timedFetch(API + path, { method, headers: { Authorization: `Bearer ${auth.access}` } });
  if (res.status === 401) {
    if (retried) throw new AuthError('401 after refresh');
    await refreshAccess();                   // refresh once, then retry once
    return api(method, path, true);
  }
  if (res.status === 429) throw new RateLimited(retryAfterMs(res));
  return res;
}

function setAuthDead() {
  auth.dead = true;
  auth.access = null;
  auth.expiresAt = 0;
  clearTimeout(auth.timer);
  store.del(K.access);
  store.del(K.expires);
  store.del(K.refresh);
  stopPolling();
  state.expect = null;
  state.real = false;
  state.playing = false;
  render();
  showConnect(true);
}

function showConnect(on) {
  const btn = $('#connect');
  btn.hidden = !on;
  if (!CONFIGURED) {
    btn.textContent = 'Add your Client ID in app.js';
    btn.disabled = true;
  }
}

/* ───────────────────────── Playback state ───────────────────────── */

const state = {
  playing: false,      // what the scene shows (may be optimistic)
  real: false,         // last thing Spotify told us
  track: null,         // { key, title, artist, art }
  progress: 0, duration: 0, at: 0,   // progress anchor, extrapolated locally
  expect: null, expectUntil: 0,      // optimistic play/pause awaiting confirmation
};

function progressNow() {
  const p = state.progress + (state.playing ? Date.now() - state.at : 0);
  return state.duration ? Math.min(p, state.duration) : p;
}

function freezeProgress() {
  state.progress = progressNow();
  state.at = Date.now();
}

function describe(item) {
  const episode = item.type === 'episode';
  const images = episode
    ? ((item.images && item.images.length) ? item.images : (item.show && item.show.images) || [])
    : (item.album && item.album.images) || [];
  const best = images.slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  return {
    key: item.uri || item.id || item.name,
    title: item.name || '',
    artist: episode ? ((item.show && item.show.name) || '') : (item.artists || []).map((a) => a.name).join(', '),
    art: best ? best.url : null,
  };
}

function reconcile(realPlaying) {
  state.real = realPlaying;
  const waiting = state.expect !== null && Date.now() < state.expectUntil;
  if (waiting && realPlaying !== state.expect) return;     // stale echo of the old state; keep optimism
  state.expect = null;
  state.playing = realPlaying;
}

function applyPlayback(data) {
  const item = data && data.item;
  const type = data && data.currently_playing_type;
  if (!item || type === 'ad' || type === 'unknown') return applyIdle();   // ads read as idle
  state.progress = Number(data.progress_ms) || 0;
  state.duration = Number(item.duration_ms) || 0;
  state.at = Date.now();
  reconcile(!!data.is_playing);
  setTrack(describe(item));
  render();
}

function applyIdle() {
  freezeProgress();
  reconcile(false);
  render();
}

/* ───────────────────────── Polling ───────────────────────── */

const poll = { timer: 0, inFlight: false, again: false, backoff: 0, last: 0 };

function stopPolling() {
  clearTimeout(poll.timer);
  poll.timer = 0;
}

function schedulePoll(ms) {
  stopPolling();
  if (document.hidden || auth.dead || !CONFIGURED) return;
  poll.timer = setTimeout(pollNow, Math.max(0, ms));
}

function nextDelay() {
  if (!state.playing) return POLL_IDLE;
  const left = state.duration - progressNow();
  // Catch the track change promptly, but never hammer.
  return left > 0 && left < POLL_PLAYING ? Math.max(1000, left + 600) : POLL_PLAYING;
}

function backoffDelay() {
  poll.backoff = poll.backoff ? Math.min(poll.backoff * 2, BACKOFF_MAX) : BACKOFF_START;
  return Math.min(BACKOFF_MAX, poll.backoff * (0.85 + Math.random() * 0.3));
}

async function pollNow() {
  stopPolling();
  if (document.hidden || auth.dead || !CONFIGURED) return;
  if (poll.inFlight) { poll.again = true; return; }
  poll.inFlight = true;
  poll.last = Date.now();
  let delay = null;
  try {
    const res = await api('GET', '/me/player/currently-playing?additional_types=episode');
    if (res.status >= 500) throw new NetError(`api ${res.status}`);
    if (res.status === 204 || !res.ok) {
      applyIdle();                                  // nothing playing (or 403/404): calm, not an error
    } else {
      const text = await res.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch { throw new NetError('bad json'); } }
      if (data) applyPlayback(data); else applyIdle();   // empty body means idle
    }
    poll.backoff = 0;
    delay = nextDelay();
  } catch (e) {
    if (e instanceof AuthError) setAuthDead();
    else if (e instanceof RateLimited) delay = (e.ms != null ? e.ms : backoffDelay()) + Math.random() * 1000;
    else delay = backoffDelay();                    // offline / timeout: keep the last scene, retry quietly
  } finally {
    poll.inFlight = false;
  }
  if (delay === null) return;
  if (poll.again) { poll.again = false; delay = Math.min(delay, 300); }
  schedulePoll(delay);
}

/* ───────────────────────── Controls ───────────────────────── */

const ENDPOINTS = {
  play: ['PUT', '/me/player/play'],
  pause: ['PUT', '/me/player/pause'],
  next: ['POST', '/me/player/next'],
  previous: ['POST', '/me/player/previous'],
};
let commandQueue = Promise.resolve();
let skipTimer = 0;

function control(action) {
  if (!CONFIGURED || auth.dead) return;
  if (action === 'toggle') action = state.playing ? 'pause' : 'play';
  if (action === 'play' || action === 'pause') {
    freezeProgress();
    state.playing = action === 'play';
    state.expect = state.playing;
    state.expectUntil = Date.now() + GRACE_MS;
    render();
  } else {
    root.classList.add('skipping');
    clearTimeout(skipTimer);
    skipTimer = setTimeout(() => root.classList.remove('skipping'), 4000);
  }
  commandQueue = commandQueue.then(() => send(action));
}

async function send(action) {
  const [method, path] = ENDPOINTS[action];
  try {
    const res = await api(method, path);
    if (res.ok) {                      // 200/202/204: accepted. Confirm on the next poll.
      schedulePoll(action === 'next' || action === 'previous' ? 700 : 1000);
      return;
    }
    // 404 no active device, 403 not Premium, etc. → fall through and revert.
  } catch (e) {
    if (e instanceof AuthError) { setAuthDead(); return; }
    if (e instanceof RateLimited) { revert(); schedulePoll(e.ms != null ? e.ms : POLL_IDLE); return; }
  }
  revert();
  schedulePoll(poll.backoff ? poll.backoff : 1500);
}

function revert() {                    // quietly back to the real state, no popups
  state.expect = null;
  if (state.playing !== state.real) { freezeProgress(); state.playing = state.real; }
  root.classList.remove('skipping');
  render();
}

/* ───────────────────────── Track & art ───────────────────────── */

const els = {
  meta: $('#meta'), title: $('#metaTitle'), artist: $('#metaArtist'),
  record: $('#record'), arm: $('#arm'), armShadow: $('#armShadow'),
  sleeveArt: Array.from(document.querySelectorAll('.sleeve .art')),
  labelArt: Array.from(document.querySelectorAll('.label .art')),
  toggle: $('#toggleBtn'),
};
const art = { shown: undefined, loading: null, front: 0 };
let metaTimer = 0;

function setTrack(track) {
  const changed = !state.track || state.track.key !== track.key;
  if (changed) {
    root.classList.remove('skipping');
    state.track = track;
    setMeta(track);
    store.set(K.last, JSON.stringify(track));
  }
  // Called on every poll: also retries art that failed to load while offline.
  showArt(track.art);
}

function setMeta(track) {
  clearTimeout(metaTimer);
  const apply = () => {
    els.title.textContent = track.title;
    els.artist.textContent = track.artist;
    document.title = track.title ? `${track.title} · ${track.artist}` : 'dsvinyl';
    els.meta.classList.remove('swap');
  };
  if (!els.title.textContent || reducedMotion.matches) return apply();
  els.meta.classList.add('swap');
  metaTimer = setTimeout(apply, 500);
}

function preload(url) {
  const load = (cors) => new Promise((resolve, reject) => {
    const img = new Image();
    if (cors) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
  // CORS lets us sample colours; if the CDN ever refuses, still show the art without the tint.
  return load(true).catch(() => load(false))
    .then((img) => (img.decode ? img.decode().then(() => img, () => img) : img));
}

function showArt(url) {
  url = url || null;
  if (url === art.shown || url === art.loading) return;
  if (!url) { art.loading = null; swapArt(null, null); return; }
  art.loading = url;
  preload(url).then(
    (img) => { if (art.loading === url) { art.loading = null; swapArt(url, img); } },
    () => { if (art.loading === url) art.loading = null; },   // offline: try again next poll
  );
}

async function swapArt(url, img) {
  art.shown = url;
  if (!url) {                                          // e.g. a local file without artwork
    [...els.sleeveArt, ...els.labelArt].forEach((el) => el.classList.remove('on'));
    setTint(null);
    return;
  }
  const back = 1 - art.front;
  const layers = [els.sleeveArt[back], els.labelArt[back]];
  await Promise.all(layers.map((el) => {
    el.crossOrigin = img.crossOrigin || null;          // same CORS mode → served from cache
    el.src = url;
    return el.decode ? el.decode().catch(() => {}) : null;
  }));
  if (art.shown !== url) return;                       // superseded while decoding
  layers.forEach((el) => el.classList.add('on'));
  els.sleeveArt[art.front].classList.remove('on');
  els.labelArt[art.front].classList.remove('on');
  art.front = back;
  setTint(img);
}

// Nudge the lamp toward the album's colours. Subtle on purpose.
function setTint(img) {
  const gold = [255, 184, 102];
  let mix = gold;
  if (img) {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 24;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, 24, 24);
      const d = g.getImageData(0, 0, 24, 24).data;
      let r = 0, gr = 0, b = 0, w = 0;
      for (let i = 0; i < d.length; i += 4) {
        const max = Math.max(d[i], d[i + 1], d[i + 2]);
        const min = Math.min(d[i], d[i + 1], d[i + 2]);
        const wt = 0.05 + (max ? (max - min) / max : 0) * (max / 255);   // favour vivid, bright pixels
        r += d[i] * wt; gr += d[i + 1] * wt; b += d[i + 2] * wt; w += wt;
      }
      const avg = [r / w, gr / w, b / w];
      const peak = Math.max(...avg, 1);
      const lifted = avg.map((v) => (v / peak) * 255);   // keep it a light, not a shade
      mix = gold.map((v, i) => Math.round(v * 0.75 + lifted[i] * 0.25));
    } catch { /* tainted canvas: stay golden */ }
  }
  root.style.setProperty('--tint', `rgb(${mix[0]} ${mix[1]} ${mix[2]})`);
}

function restoreLast() {
  let last = null;
  try { last = JSON.parse(store.get(K.last) || 'null'); } catch { /* ignore */ }
  if (last && last.key) setTrack(last);
}

/* ───────────────────────── Motion ───────────────────────── */

const motion = { angle: Math.random() * 360, omega: 0, raf: 0, last: 0 };
const arm = { angle: ARM_REST, lift: 0, mode: 'rest', steps: [], cur: null };
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function playAngle() {
  const f = state.duration ? Math.min(1, Math.max(0, progressNow() / state.duration)) : 0;
  return ARM_LEAD_IN + (ARM_RUN_OUT - ARM_LEAD_IN) * f;
}

function setArmMode(mode) {
  if (arm.mode === mode) return;
  arm.mode = mode;
  arm.cur = null;
  if (reducedMotion.matches) {
    arm.steps = [];
    arm.lift = 0;
    arm.angle = mode === 'play' ? playAngle() : ARM_REST;
    return;
  }
  // Lift, swing, lower — like a cue lever.
  arm.steps = [
    { prop: 'lift', to: 1, dur: 380 },
    { prop: 'angle', to: () => (mode === 'play' ? playAngle() : ARM_REST) },
    { prop: 'lift', to: 0, dur: 520 },
  ];
}

function stepArm(now) {
  if (!arm.cur && arm.steps.length) {
    const s = arm.steps.shift();
    const from = arm[s.prop];
    const to = typeof s.to === 'function' ? s.to() : s.to;
    const dur = s.dur != null ? s.dur * Math.abs(to - from) : 420 + Math.abs(to - from) * 22;
    arm.cur = { prop: s.prop, from, to, t0: now, dur: Math.max(1, dur) };
  }
  if (arm.cur) {
    const c = arm.cur;
    const t = Math.min(1, (now - c.t0) / c.dur);
    arm[c.prop] = c.from + (c.to - c.from) * easeInOut(t);
    if (t >= 1) arm.cur = null;
    return true;
  }
  if (arm.mode === 'play') arm.angle = playAngle();   // the stylus creeps inward as the song plays
  return false;
}

function drawArm() {
  const lift = arm.lift;
  els.arm.style.transform = `translateZ(${3 + lift * 1.3}vmin) rotate(${arm.angle}deg)`;
  els.armShadow.style.transform =
    `translateZ(1.7vmin) translate(${0.8 + lift * 0.9}vmin, ${0.7 + lift * 0.8}vmin) rotate(${arm.angle}deg)`;
  els.armShadow.style.opacity = String(0.5 - lift * 0.18);
}

function frame(now) {
  const dt = Math.min(100, now - motion.last);
  motion.last = now;
  const target = state.playing && !reducedMotion.matches ? DEG_PER_MS : 0;
  if (motion.omega < target) motion.omega = Math.min(target, motion.omega + (DEG_PER_MS * dt) / SPIN_UP_MS);
  else if (motion.omega > target) motion.omega = Math.max(target, motion.omega - (DEG_PER_MS * dt) / SPIN_DOWN_MS);
  motion.angle = (motion.angle + motion.omega * dt) % 360;
  els.record.style.transform = `rotate(${motion.angle.toFixed(3)}deg)`;

  const armMoving = stepArm(now);
  drawArm();

  const keepGoing = motion.omega > 0 || target > 0 || armMoving || arm.steps.length > 0;
  motion.raf = keepGoing ? requestAnimationFrame(frame) : 0;
}

function kick() {
  if (motion.raf) return;
  motion.last = performance.now();
  motion.raf = requestAnimationFrame(frame);
}

function render() {
  root.classList.toggle('playing', state.playing);
  root.classList.toggle('dim', !state.playing);
  els.toggle.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  setArmMode(state.playing ? 'play' : 'rest');
  if (reducedMotion.matches && arm.mode === 'play' && !arm.cur) arm.angle = playAngle();
  drawArm();
  kick();
}

/* ───────────────────────── Screen, cursor, input ───────────────────────── */

let wakeLock = null;
async function acquireWakeLock() {
  if (!('wakeLock' in navigator) || document.hidden || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* unsupported, denied or not focused: fail silently */ }
}

let cursorTimer = 0;
function nudgeCursor() {
  document.body.classList.remove('cursor-idle');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(function hide() {
    if (document.querySelector('.controls:hover')) { cursorTimer = setTimeout(hide, 1000); return; }
    document.body.classList.add('cursor-idle');
  }, 3000);
}

function toggleFullscreen() {
  try {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  } catch { /* no fullscreen API */ }
}

let clickTimer = 0;
function onDeckClick(e) {
  e.stopPropagation();
  // Wait a beat so a double-click (fullscreen) doesn't also toggle playback.
  clearTimeout(clickTimer);
  if (e.detail > 1) return;
  clickTimer = setTimeout(() => control('toggle'), 260);
}

function bindInput() {
  ['mousemove', 'pointerdown', 'wheel'].forEach((t) => addEventListener(t, nudgeCursor, { passive: true }));
  addEventListener('pointerdown', acquireWakeLock, { passive: true });

  els.record.addEventListener('click', onDeckClick);
  els.arm.addEventListener('click', onDeckClick);

  $('#controls').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    control(btn.dataset.action);
    btn.blur();                                   // so Space doesn't re-press it
  });
  $('#controls').addEventListener('dblclick', (e) => e.stopPropagation());
  $('#connect').addEventListener('click', login);
  $('#connect').addEventListener('dblclick', (e) => e.stopPropagation());

  addEventListener('dblclick', () => { clearTimeout(clickTimer); toggleFullscreen(); });

  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest && e.target.closest('button') && (e.key === ' ' || e.key === 'Enter')) return;
    if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); if (!e.repeat) control('toggle'); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); control('previous'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); control('next'); }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopPolling(); return; }   // no polling while hidden
    acquireWakeLock();
    pollNow();
    kick();
  });
  addEventListener('online', () => { poll.backoff = 0; pollNow(); });
  addEventListener('pageshow', (e) => { if (e.persisted) pollNow(); });

  // Another tab signed in or rotated the refresh token.
  addEventListener('storage', (e) => {
    if (e.key !== K.refresh || !e.newValue) return;
    adoptStoredTokens();
    if (auth.dead) { auth.dead = false; showConnect(false); pollNow(); }
  });

  reducedMotion.addEventListener('change', () => { arm.mode = null; render(); });

  // Sleep/wake watchdog: timers stall during sleep, so notice the gap and resume right away.
  // Also revives polling if it ever stopped for an unexpected reason.
  let beat = Date.now();
  setInterval(() => {
    const now = Date.now();
    const slept = now - beat > 30000;
    beat = now;
    if (document.hidden || auth.dead || !CONFIGURED) return;
    if (slept) { poll.backoff = 0; acquireWakeLock(); pollNow(); return; }
    if (!poll.timer && !poll.inFlight && (auth.refresh || auth.access)) pollNow();
  }, 10000);
}

/* ───────────────────────── Start ───────────────────────── */

async function start() {
  // Spotify only accepts 127.0.0.1 redirect URIs, not "localhost".
  if (location.hostname === 'localhost') {
    location.replace(location.href.replace('//localhost', '//127.0.0.1'));
    return;
  }
  bindInput();
  restoreLast();
  setTint(null);
  render();
  nudgeCursor();

  await handleRedirect();
  if (!CONFIGURED) { showConnect(true); return; }
  if (!auth.refresh && !auth.access) { showConnect(true); return; }
  if (auth.access) scheduleRefresh();
  acquireWakeLock();
  pollNow();
}

start();
