/* dsvinyl — a cozy now-playing display for Spotify.
 * Vanilla JS. Auth is PKCE with the Client ID only; no secret anywhere.
 * The Client ID is entered once in the setup card and kept in localStorage. */
'use strict';

/* ───────────────────────── Config ───────────────────────── */

const SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state';
// Worked out from wherever the page is served (GitHub Pages or 127.0.0.1), so no edits are needed.
const REDIRECT_URI = (() => {
  let path = location.pathname.replace(/index\.html$/, '');
  if (!path.endsWith('/')) path += '/';
  return location.origin + path;
})();
const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';

const POLL_PLAYING = 5000;          // while music plays
const POLL_IDLE = 20000;            // paused / nothing playing
const BACKOFF_START = 2000;
const BACKOFF_MAX = 60000;
const FETCH_TIMEOUT = 10000;        // a dropped Wi-Fi link shouldn't hang a request forever
const REFRESH_EARLY = 5 * 60000;    // refresh the access token 5 min before it expires
const GRACE_MS = 4000;              // how long an optimistic play/pause outranks a stale poll

const RPM = 100 / 3;                 // a true 33⅓
const SPIN_UP_MS = 1600;
const SPIN_DOWN_MS = 2200;
const IDLE_AFTER_PAUSE = 10 * 60000; // a long pause counts as "nothing playing": the clock takes over

const K = {
  access: 'dsvinyl.access', expires: 'dsvinyl.expires', refresh: 'dsvinyl.refresh',
  verifier: 'dsvinyl.verifier', state: 'dsvinyl.state', last: 'dsvinyl.last', clientId: 'dsvinyl.clientId',
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode / full: carry on in memory */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const clientId = () => store.get(K.clientId) || '';
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
  if (!clientId()) return;
  const verifier = randomString(64);
  const state = randomString(16);
  store.set(K.verifier, verifier);
  store.set(K.state, state);
  const params = new URLSearchParams({
    client_id: clientId(),
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
        client_id: clientId(),
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
  setMode();
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
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: used, client_id: clientId() }),
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
  clearTokens();
  stopPolling();
  state.expect = null;
  state.real = false;
  state.playing = false;
  state.hasPlayback = false;
  render();
  setMode();                           // calm "Connect Spotify", never an error screen
}

/* ───────────────────────── Playback state ───────────────────────── */

const state = {
  playing: false,      // what the scene shows (may be optimistic)
  real: false,         // last thing Spotify told us
  track: null,         // { key, title, artist, art }
  progress: 0, duration: 0, at: 0,   // progress anchor, extrapolated locally
  expect: null, expectUntil: 0,      // optimistic play/pause awaiting confirmation
  hasPlayback: false,                // false when Spotify reports nothing playing
  pausedSince: 0,
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
  state.hasPlayback = true;
  reconcile(!!data.is_playing);
  setTrack(describe(item));
  render();
}

function applyIdle() {
  freezeProgress();
  reconcile(false);
  if (!state.playing) state.hasPlayback = false;
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
  if (document.hidden || auth.dead || !clientId()) return;
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
  if (document.hidden || auth.dead || !clientId()) return;
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
  if (!clientId() || auth.dead) return;
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

/* ───────────────────────── Scene ───────────────────────── */

const els = {
  pair: $('#pair'), meta: $('#meta'), title: $('#title'), artist: $('#artist'), progress: $('#progress'),
  disc: $('#disc'), cover: $('#cover'), toggle: $('#toggleBtn'),
  coverImgs: Array.from(document.querySelectorAll('.cover img')),
  labelImgs: Array.from(document.querySelectorAll('.label img')),
  setup: $('#setup'), connect: $('#connect'),
};

// The spin is a Web Animation, so it runs on the compositor and stays perfectly even.
// Starting and stopping ease the playback rate along a sine curve.
const spin = (() => {
  const period = 60000 / RPM;
  const anim = $('#spin').animate([{ transform: 'rotate(0turn)' }, { transform: 'rotate(1turn)' }], { duration: period, iterations: Infinity });
  anim.currentTime = Math.random() * period;
  anim.playbackRate = 0;
  let rate = 0, target = 0, raf = 0;
  const ease = (t) => 0.5 - Math.cos(Math.PI * t) / 2;
  return {
    set(on) {
      const want = on && !reducedMotion.matches ? 1 : 0;
      if (want === target) return;
      target = want;
      cancelAnimationFrame(raf);
      const from = rate, dur = (want > from ? SPIN_UP_MS : SPIN_DOWN_MS) * Math.abs(want - from), t0 = performance.now();
      const step = (now) => {
        const t = dur ? Math.min(1, (now - t0) / dur) : 1;
        rate = from + (want - from) * ease(t);
        anim.playbackRate = rate;
        if (t < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    },
  };
})();

/* Track changes: preload the new art, then Ember's choreography — the disc slides back into
 * the sleeve, art and text change, the disc slides out again. */

const pres = { key: undefined, art: undefined, busyKey: null, busyArt: null, id: 0 };
let choreoTimers = [];
let artFront = 0;

function setTrack(track) {
  if (!state.track || state.track.key !== track.key) {
    root.classList.remove('skipping');
    store.set(K.last, JSON.stringify(track));
  }
  state.track = track;
  present(track, false);
}

function present(track, instant) {
  const url = track.art || null;
  if (pres.key === track.key && pres.art === url) return;              // already on screen
  if (pres.busyKey === track.key && pres.busyArt === url) return;      // already loading
  const id = ++pres.id;
  pres.busyKey = track.key; pres.busyArt = url;
  const load = url ? preload(url).catch(() => null) : Promise.resolve(null);
  load.then((img) => {
    if (id !== pres.id) return;
    pres.busyKey = pres.busyArt = null;
    const newTrack = pres.key !== track.key;
    const artOk = !url || !!img;
    if (!newTrack && !artOk) return;                // same song, art still unreachable: retry next poll
    pres.key = track.key;
    pres.art = artOk ? url : null;                  // a miss stays "unshown", so the next poll retries it
    if (newTrack && !instant && !reducedMotion.matches && pres.everShown) choreograph(track, img);
    else { applyArt(img, url); setText(track); drawProgress(true); }
    pres.everShown = true;
  });
}

function choreograph(track, img) {
  choreoTimers.forEach(clearTimeout);
  els.pair.classList.add('swap');
  els.meta.classList.add('out');
  choreoTimers = [
    setTimeout(() => { applyArt(img, track.art); setText(track); drawProgress(true); els.meta.classList.remove('out'); }, 560),
    setTimeout(() => els.pair.classList.remove('swap'), 700),
  ];
}

function preload(url) {
  const load = (cors) => new Promise((resolve, reject) => {
    const img = new Image();
    if (cors) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
  // CORS lets us read the colours; if the CDN ever refuses, still show the art.
  return load(true).catch(() => load(false))
    .then((img) => (img.decode ? img.decode().then(() => img, () => img) : img));
}

async function applyArt(img, url) {
  if (!img) {                                     // e.g. a local file without artwork
    [...els.coverImgs, ...els.labelImgs].forEach((el) => el.classList.remove('on'));
    setPalette(null);
    return;
  }
  const back = 1 - artFront;
  const layers = [els.coverImgs[back], els.labelImgs[back]];
  await Promise.all(layers.map((el) => {
    el.crossOrigin = img.crossOrigin || null;     // same CORS mode → served from cache
    el.src = url;
    return el.decode ? el.decode().catch(() => {}) : null;
  }));
  layers.forEach((el) => el.classList.add('on'));
  els.coverImgs[artFront].classList.remove('on');
  els.labelImgs[artFront].classList.remove('on');
  artFront = back;
  setPalette(img);
}

function setText(track) {
  els.title.textContent = track.title;
  els.artist.textContent = track.artist;
  document.title = track.title ? `${track.title} · ${track.artist}` : 'dsvinyl';
}

function restoreLast() {
  let last = null;
  try { last = JSON.parse(store.get(K.last) || 'null'); } catch { /* ignore */ }
  if (last && last.key) { state.track = last; present(last, true); }
}

/* ───────────────────────── Palette ─────────────────────────
 * Four colours from the cover become the drifting background; its most vivid colour tints
 * the vinyl. The CSS colour properties are registered, so a new palette blends in over
 * several seconds instead of swapping. */

const DEFAULT_MESH = [[30, 18, 11], [122, 70, 38], [92, 48, 58], [140, 92, 44], [64, 40, 30]];
const DEFAULT_TINT = [214, 140, 70];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mixRgb = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const cssRgb = (c) => `rgb(${c.map((v) => Math.round(v)).join(' ')})`;

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslToRgb([h, s, l]) {
  h = (((h % 360) + 360) % 360) / 360;
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => v * 255);
}

function readColours(img) {
  const N = 40;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, N, N);
  const d = g.getImageData(0, 0, N, N).data;              // throws if the image is tainted
  const bins = new Map();
  for (let i = 0; i < d.length; i += 4) {
    const k = (d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | (d[i + 2] >> 4);
    const b = bins.get(k) || { n: 0, r: 0, g: 0, b: 0 };
    b.n++; b.r += d[i]; b.g += d[i + 1]; b.b += d[i + 2];
    bins.set(k, b);
  }
  return Array.from(bins.values(), (b) => ({ rgb: [b.r / b.n, b.g / b.n, b.b / b.n], n: b.n / (N * N) }))
    .sort((a, b) => b.n - a.n);
}

function setPalette(img) {
  let mesh = DEFAULT_MESH, tint = DEFAULT_TINT;
  if (img) {
    try {
      const cols = readColours(img);
      // Up to four clearly different colours, most common first.
      const picks = [];
      for (const c of cols) {
        if (c.n < 0.004) break;
        if (picks.every((p) => Math.hypot(p[0] - c.rgb[0], p[1] - c.rgb[1], p[2] - c.rgb[2]) > 64)) picks.push(c.rgb);
        if (picks.length === 4) break;
      }
      while (picks.length < 4) {                          // few-colour covers: neighbouring hues
        const [h, s, l] = rgbToHsl(picks[picks.length % Math.max(1, picks.length)] || DEFAULT_MESH[1]);
        picks.push(hslToRgb([h + (picks.length % 2 ? 22 : -22), s, l]));
      }
      // Into a dark, glowing range. Greys lean warm, so every palette still feels like evening.
      const amb = picks.map((rgb) => {
        let [h, s, l] = rgbToHsl(rgb);
        if (s < 0.14) { [h, s] = rgbToHsl(mixRgb(rgb, [176, 112, 64], 0.55)); }
        return hslToRgb([h, clamp(s * 1.15, 0.2, 0.72), 0.17 + l * 0.27]);
      });
      const darkest = picks.reduce((a, b) => (rgbToHsl(a)[2] < rgbToHsl(b)[2] ? a : b));
      const [bh, bs] = rgbToHsl(darkest);
      mesh = [hslToRgb([bh, clamp(bs, 0.15, 0.5), 0.085]), ...amb];

      // Vinyl: the most vivid well-represented colour, kept glassy and mid-toned.
      let best = null, score = -1;
      for (const c of cols.slice(0, 60)) {
        const [, s, l] = rgbToHsl(c.rgb);
        const sc = s * (1 - Math.abs(l - 0.52) * 1.6) * Math.sqrt(c.n);
        if (sc > score) { score = sc; best = c.rgb; }
      }
      const [th, ts] = rgbToHsl(best);
      tint = ts > 0.22 && score > 0.02 ? hslToRgb([th, clamp(ts, 0.4, 0.82), clamp(rgbToHsl(best)[2], 0.44, 0.6)]) : DEFAULT_TINT;
    } catch { /* tainted canvas: keep the warm defaults */ }
  }
  mesh.forEach((c, i) => root.style.setProperty(`--m${i}`, cssRgb(c)));
  root.style.setProperty('--tint', cssRgb(tint));
}

/* ───────────────────────── Progress, clock, evening, drift ───────────────────────── */

function drawProgress(instant) {
  const f = state.duration ? clamp(progressNow() / state.duration, 0, 1) : 0;
  // Updated each second with a matching linear transition, so the line glides.
  els.progress.style.transition = instant || !state.playing ? 'none' : 'transform 1s linear';
  els.progress.style.transform = `scaleX(${f.toFixed(4)})`;
}

const fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
let clockMinute = -1;
function drawClock() {
  const now = new Date();
  const minute = Math.floor(now.getTime() / 60000);
  if (minute === clockMinute) return;
  clockMinute = minute;
  const parts = fmtTime.formatToParts(now);
  const main = parts.filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim();
  const period = parts.find((p) => p.type === 'dayPeriod');
  document.querySelectorAll('.clock .time').forEach((el) => {
    el.textContent = main;
    if (period) { const s = document.createElement('span'); s.className = 'ampm'; s.textContent = period.value; el.appendChild(s); }
  });
  document.querySelectorAll('.clock .date').forEach((el) => { el.textContent = fmtDate.format(now); });
}

// 0 by day, easing to 1 between 20:30–21:30, back to 0 between 05:30–06:30.
function eveningLevel(d) {
  const h = d.getHours() + d.getMinutes() / 60;
  const ramp = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : 0.5 - Math.cos(Math.PI * x) / 2);
  return h >= 12 ? ramp(h - 20.5) : 1 - ramp(h - 5.5);
}
function drawEvening() { root.style.setProperty('--evening', eveningLevel(new Date()).toFixed(3)); }

// Burn-in care: every few minutes pick a new resting offset a few pixels away, and walk
// there one pixel at a time. Whole pixels keep text crisp; single steps are invisible.
const drift = { x: 0, y: 0, tx: 0, ty: 0 };
function driftTarget() { drift.tx = Math.round(Math.random() * 12 - 6); drift.ty = Math.round(Math.random() * 10 - 5); }
function driftStep() {
  if (drift.x === drift.tx && drift.y === drift.ty) return;
  drift.x += Math.sign(drift.tx - drift.x);
  drift.y += Math.sign(drift.ty - drift.y);
  root.style.setProperty('--dx', `${drift.x}px`);
  root.style.setProperty('--dy', `${drift.y}px`);
}

/* ───────────────────────── State → screen ───────────────────────── */

function isIdle() {
  if (!state.hasPlayback) return true;                      // nothing playing at all
  return !state.playing && state.pausedSince > 0 && Date.now() - state.pausedSince > IDLE_AFTER_PAUSE;
}

function render() {
  if (state.playing) state.pausedSince = 0;
  else if (!state.pausedSince) state.pausedSince = Date.now();
  const idle = isIdle();
  root.classList.toggle('playing', state.playing);
  root.classList.toggle('paused', !state.playing && !idle);
  root.classList.toggle('idle', idle);
  root.classList.toggle('has-track', !!state.track);
  els.toggle.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  spin.set(state.playing);
  drawProgress();
}

// Which screen: first-run setup, "Connect Spotify", or the live display.
function setMode() {
  const mode = !clientId() ? 'setup' : (auth.dead || (!auth.refresh && !auth.access)) ? 'connect' : 'live';
  root.classList.toggle('setup-mode', mode === 'setup');
  root.classList.toggle('connect-mode', mode === 'connect');
  els.setup.hidden = mode !== 'setup';
  els.connect.hidden = mode !== 'connect';
  if (mode === 'setup') $('#redirectUri').textContent = REDIRECT_URI;
  return mode;
}

function clearTokens() {
  auth.access = null; auth.refresh = null; auth.expiresAt = 0;
  clearTimeout(auth.timer);
  [K.access, K.expires, K.refresh, K.verifier, K.state].forEach((k) => store.del(k));
}

function resetAll() {
  clearTokens();
  [K.clientId, K.last].forEach((k) => store.del(k));
}

function bindSetup() {
  $('#copyUri').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    let ok = false;
    try { await navigator.clipboard.writeText(REDIRECT_URI); ok = true; } catch {
      try {                                             // older browsers / non-secure contexts
        const r = document.createRange(); r.selectNodeContents($('#redirectUri'));
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
        ok = document.execCommand('copy');
      } catch { /* the URI is selectable anyway */ }
    }
    btn.textContent = ok ? 'Copied' : 'Select';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1800);
  });
  $('#cidForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#cidInput').value.trim();
    if (!/^[A-Za-z0-9]{16,64}$/.test(v)) {
      $('#cidHint').textContent = 'That doesn’t look like a Client ID. It’s a 32-character code on your app’s page.';
      $('#cidHint').classList.add('bad');
      return;
    }
    store.set(K.clientId, v);
    auth.dead = false;
    setMode();
  });
  $('#connectBtn').addEventListener('click', login);
  $('#changeCid').addEventListener('click', () => {
    clearTokens();
    store.del(K.clientId);
    $('#cidInput').value = '';
    setMode();
  });
  [els.setup, els.connect].forEach((el) => el.addEventListener('dblclick', (e) => e.stopPropagation()));
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
function onArtClick(e) {
  e.stopPropagation();
  // Wait a beat so a double-click (fullscreen) doesn't also toggle playback.
  clearTimeout(clickTimer);
  if (e.detail > 1) return;
  clickTimer = setTimeout(() => control('toggle'), 260);
}

function bindInput() {
  ['mousemove', 'pointerdown', 'wheel'].forEach((t) => addEventListener(t, nudgeCursor, { passive: true }));
  addEventListener('pointerdown', acquireWakeLock, { passive: true });

  els.disc.addEventListener('click', onArtClick);
  els.cover.addEventListener('click', onArtClick);

  $('#controls').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    control(btn.dataset.action);
    btn.blur();                                   // so Space doesn't re-press it
  });
  $('#controls').addEventListener('dblclick', (e) => e.stopPropagation());
  addEventListener('dblclick', () => { clearTimeout(clickTimer); toggleFullscreen(); });

  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t.closest && t.closest('input, textarea, .setup, .connect')) return;   // typing / setup
    if (t.closest && t.closest('button') && (e.key === ' ' || e.key === 'Enter')) return;
    if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); if (!e.repeat) control('toggle'); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); control('previous'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); control('next'); }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopPolling(); return; }   // no polling while hidden
    acquireWakeLock();
    drawClock();
    pollNow();
  });
  addEventListener('online', () => { poll.backoff = 0; pollNow(); });
  addEventListener('pageshow', (e) => { if (e.persisted) pollNow(); });

  // Another tab signed in or rotated the refresh token.
  addEventListener('storage', (e) => {
    if (e.key !== K.refresh || !e.newValue) return;
    adoptStoredTokens();
    if (auth.dead) { auth.dead = false; setMode(); pollNow(); }
  });

  reducedMotion.addEventListener('change', () => { spin.set(false); render(); });

  // Sleep/wake watchdog: timers stall during sleep, so notice the gap and resume right away.
  // Also revives polling if it ever stopped for an unexpected reason.
  let beat = Date.now();
  setInterval(() => {
    const now = Date.now();
    const slept = now - beat > 30000;
    beat = now;
    drawClock();
    if (document.hidden || auth.dead || !clientId()) return;
    if (slept) { poll.backoff = 0; acquireWakeLock(); drawEvening(); pollNow(); return; }
    if (!poll.timer && !poll.inFlight && (auth.refresh || auth.access)) pollNow();
  }, 10000);

  setInterval(drawClock, 2000);
  setInterval(drawProgress, 1000);
  setInterval(drawEvening, 60000);
  setInterval(render, 30000);                     // lets a long pause settle into idle
  setInterval(driftStep, 15000);
  setInterval(driftTarget, 4 * 60000);
}

/* ───────────────────────── Start ───────────────────────── */

async function start() {
  // Spotify only accepts 127.0.0.1 redirect URIs, not "localhost".
  if (location.hostname === 'localhost') {
    location.replace(location.href.replace('//localhost', '//127.0.0.1'));
    return;
  }
  if (new URLSearchParams(location.search).has('reset')) {
    resetAll();
    history.replaceState(null, '', REDIRECT_URI);
  }
  bindInput();
  bindSetup();
  drawClock();
  drawEvening();
  setPalette(null);
  restoreLast();
  render();
  setMode();
  // Enable colour/dim transitions only after first paint, so the page opens settled.
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('ready')));
  nudgeCursor();
  acquireWakeLock();

  await handleRedirect();
  if (setMode() !== 'live') return;
  if (auth.access) scheduleRefresh();
  pollNow();
}

start();
