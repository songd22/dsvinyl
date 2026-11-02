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
  settings: 'dsvinyl.settings', account: 'dsvinyl.account',
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
  viz.poke();
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
  viz.colours(tint, mesh);
}

/* ───────────────────────── Progress, clock, evening, drift ───────────────────────── */

function drawProgress(instant) {
  const f = state.duration ? clamp(progressNow() / state.duration, 0, 1) : 0;
  // Updated each second with a matching linear transition, so the line glides.
  els.progress.style.transition = instant || !state.playing ? 'none' : 'transform 1s linear';
  els.progress.style.transform = `scaleX(${f.toFixed(4)})`;
}

let fmtTime = null;
function buildClockFormat() {
  fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', hourCycle: settings.clockFormat === '24' ? 'h23' : 'h12' });
}
const fmtDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
let clockMinute = -1;
function drawClock() {
  const now = new Date();
  const minute = Math.floor(now.getTime() / 60000);
  if (minute === clockMinute || !fmtTime) return;
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

// 0 by day, 1 at night. Each edge eases over an hour centred on the chosen time
// (by default 21:00 and 06:00), so the change is never noticeable as it happens.
function eveningLevel(d) {
  if (!settings.evening) return 0;
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const start = toMin(settings.eveningStart), end = toMin(settings.eveningEnd);
  if (start === end) return 0;
  const now = d.getHours() * 60 + d.getMinutes();
  const inside = (x) => { x = ((x % 1440) + 1440) % 1440; return start < end ? x >= start && x < end : x >= start || x < end; };
  let n = 0;
  for (let k = -30; k <= 30; k++) n += inside(now + k);
  return 0.5 - Math.cos(Math.PI * (n / 61)) / 2;
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
  viz.poke();
}

// Which screen: first-run setup, "Connect Spotify", or the live display.
function setMode() {
  const mode = !clientId() ? 'setup' : (auth.dead || (!auth.refresh && !auth.access)) ? 'connect' : 'live';
  root.classList.toggle('setup-mode', mode === 'setup');
  root.classList.toggle('connect-mode', mode === 'connect');
  els.setup.hidden = mode !== 'setup';
  els.connect.hidden = mode !== 'connect';
  if (mode === 'setup') $('#redirectUri').textContent = REDIRECT_URI;
  viz.poke();
  if (panel.open) syncPanel();
  return mode;
}

function clearTokens() {
  auth.access = null; auth.refresh = null; auth.expiresAt = 0;
  clearTimeout(auth.timer);
  [K.access, K.expires, K.refresh, K.verifier, K.state].forEach((k) => store.del(k));
}

function resetAll() {
  clearTokens();
  [K.clientId, K.last, K.account].forEach((k) => store.del(k));
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

/* ───────────────────────── Settings ─────────────────────────
 * One config object with defaults. To add an option: add a default here, (optionally) a
 * list of valid values, a control in the panel with data-setting="key", and handle it in
 * applySettings(). Everything is saved to localStorage and applied at once. */

const DEFAULTS = Object.freeze({
  visualizer: 'ambient',                       // 'off' | 'ambient' | 'mic'
  intensity: 'normal',                         // 'subtle' | 'normal' | 'vivid'
  clock: true,
  clockFormat: new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 ? '12' : '24',
  clockDate: true,
  evening: true,
  eveningStart: '21:00',
  eveningEnd: '06:00',
  progress: true,
});
const CHOICES = { visualizer: ['off', 'ambient', 'mic'], intensity: ['subtle', 'normal', 'vivid'], clockFormat: ['12', '24'] };
const isTime = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(store.get(K.settings) || '{}') || {}; } catch { saved = {}; }
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const v = saved[key];
    if (v === undefined || typeof v !== typeof DEFAULTS[key]) continue;
    if (CHOICES[key] && !CHOICES[key].includes(v)) continue;
    if (/^evening(Start|End)$/.test(key) && !isTime(v)) continue;
    out[key] = v;
  }
  return out;
}
let settings = loadSettings();
function saveSettings() { store.set(K.settings, JSON.stringify(settings)); }

function setSetting(key, value) {
  if (settings[key] === value) return;
  settings[key] = value;
  saveSettings();
  applySettings(key);
  syncPanel();
}

let quickEveningTimer = 0;
function applySettings(changed) {
  root.classList.toggle('no-clock', !settings.clock);
  root.classList.toggle('no-date', !settings.clockDate);
  root.classList.toggle('no-progress', !settings.progress);
  if (!changed || changed === 'clockFormat') { buildClockFormat(); clockMinute = -1; drawClock(); }
  if (!changed || /^evening/.test(changed)) {
    if (changed) {               // show the change within seconds, not over the usual minute
      root.classList.add('quick-evening');
      clearTimeout(quickEveningTimer);
      quickEveningTimer = setTimeout(() => root.classList.remove('quick-evening'), 3000);
    }
    drawEvening();
  }
  if (changed === 'intensity') viz.poke();
  if (!changed || changed === 'visualizer') {
    if (changed === 'visualizer') setVizNote('');
    viz.setMode(settings.visualizer, !!changed);
  }
}

/* Panel */

const panel = { el: $('#settings'), scrim: $('#scrim'), gear: $('#gearBtn'), open: false };

function openSettings() {
  if (panel.open) return;
  panel.open = true;
  root.classList.add('settings-open');
  panel.el.setAttribute('aria-hidden', 'false');
  panel.gear.setAttribute('aria-expanded', 'true');
  panel.scrim.hidden = false;
  syncPanel();
  loadAccount();
  nudgeCursor();
  panel.el.focus({ preventScroll: true });
}
function closeSettings() {
  if (!panel.open) return;
  panel.open = false;
  root.classList.remove('settings-open');
  panel.el.setAttribute('aria-hidden', 'true');
  panel.gear.setAttribute('aria-expanded', 'false');
  panel.scrim.hidden = true;
  if (panel.el.contains(document.activeElement)) document.activeElement.blur();
  nudgeCursor();
}
const toggleSettings = () => (panel.open ? closeSettings() : openSettings());

function syncPanel() {
  panel.el.querySelectorAll('[data-setting]').forEach((el) => {
    const v = settings[el.dataset.setting];
    if (el.classList.contains('switch')) el.setAttribute('aria-checked', String(!!v));
    else if (el.classList.contains('seg')) el.querySelectorAll('[data-value]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === v)));
    else if (el.tagName === 'INPUT' && document.activeElement !== el) el.value = v;
  });
  panel.el.querySelectorAll('[data-requires]').forEach((row) => {
    const [key, not] = row.dataset.requires.split('!=');
    row.classList.toggle('off', not !== undefined ? settings[key] === not : !settings[key]);
  });
  const live = !!clientId() && !auth.dead && !!(auth.refresh || auth.access);
  const name = store.get(K.account);
  const acct = $('#account');
  acct.textContent = '';
  if (live) {
    acct.append(name ? 'Connected as ' : 'Connected');
    if (name) { const b = document.createElement('strong'); b.textContent = name; acct.append(b); }
  } else acct.textContent = clientId() ? 'Not connected' : 'Not set up yet';
  $('#disconnectBtn').disabled = !live;
  $('#resetBtn').disabled = !clientId() && !live;
}

function setVizNote(text) { $('#vizNote').textContent = text; }

async function loadAccount(force) {
  if (!clientId() || auth.dead || !(auth.refresh || auth.access)) return;
  if (!force && store.get(K.account)) return;
  try {
    const res = await api('GET', '/me');
    if (!res.ok) return;
    const me = await res.json();
    store.set(K.account, me.display_name || me.id || '');
    syncPanel();
  } catch { /* the name is a nicety; polling handles auth trouble */ }
}

function signOutLocally() {
  stopPolling();
  state.expect = null; state.real = false; state.playing = false; state.hasPlayback = false;
  render();
}

function bindSettings() {
  panel.el.addEventListener('click', (e) => {
    const sw = e.target.closest('.switch[data-setting]');
    if (sw) { setSetting(sw.dataset.setting, !settings[sw.dataset.setting]); return; }
    const opt = e.target.closest('.seg [data-value]');
    if (opt) { setSetting(opt.closest('.seg').dataset.setting, opt.dataset.value); }
  });
  panel.el.querySelectorAll('input[type="time"][data-setting]').forEach((input) => {
    input.addEventListener('change', () => { if (isTime(input.value)) setSetting(input.dataset.setting, input.value); });
  });
  $('#settingsClose').addEventListener('click', closeSettings);
  panel.scrim.addEventListener('pointerdown', (e) => { e.preventDefault(); closeSettings(); });
  panel.scrim.addEventListener('click', (e) => e.stopPropagation());
  [panel.el, panel.scrim].forEach((el) => el.addEventListener('dblclick', (e) => e.stopPropagation()));

  $('#disconnectBtn').addEventListener('click', () => {
    clearTokens();
    store.del(K.account);
    auth.dead = false;
    signOutLocally();
    setMode();
    closeSettings();
  });
  $('#resetBtn').addEventListener('click', () => {
    resetAll();
    auth.dead = false;
    signOutLocally();
    $('#cidInput').value = '';
    setMode();
    closeSettings();
  });
  $('#restoreBtn').addEventListener('click', () => {
    settings = { ...DEFAULTS };
    saveSettings();
    setVizNote('');
    applySettings();
    syncPanel();
  });
}

/* ───────────────────────── Visualizer ─────────────────────────
 * Light, not shapes. One low-resolution canvas (it's all soft light, so the browser's
 * upscaling only softens it further), blended with "screen" over the scene:
 *   • a luminous glow along the bottom edge, built from soft light pools that mirror out
 *     from the centre (bass in the middle, highs at the edges) and drift slowly sideways;
 *   • a few diffuse glints drifting across the exposed part of the disc.
 * Mic: 8 log-spaced bands → adaptive gain (rolling floor/peak) with a noise gate →
 * fast-attack / slow-release envelopes → perceptual curve; kicks flash the light.
 * Ambient: the same visuals, driven by smooth noise and an occasional gentle swell.
 * Press D for a debug overlay with the band levels and gain ranges. */

const viz = (() => {
  const canvas = $('#viz');
  const g = canvas.getContext('2d');
  const SCALE = 0.3;
  const FRAME_MS = 1000 / 30;
  const BANDS = 8;
  const INTENSITY = { subtle: { a: 0.6, h: 0.85 }, normal: { a: 1, h: 1 }, vivid: { a: 1.45, h: 1.12 } };
  const ATTACK = 0.03, RELEASE = 0.42;          // seconds
  const CURVE = 1.7;                            // soft passages stay calm, peaks bloom
  const PEAK_TAU = 10;                          // seconds for a peak to decay back toward the floor
  const MIN_RANGE = 14, GATE_DB = 3, ABS_GATE = -88;   // dB

  let W = 0, H = 0, mode = 'off', raf = 0, last = 0, t = 0, vis = 0, play = 0;
  let debugOn = false, debugTick = 0;
  const level = new Float32Array(BANDS);        // what the light shows, 0–1 (after the curve)
  const env = new Float32Array(BANDS);          // envelopes, 0–1
  let flash = 0;
  const seeds = Array.from({ length: BANDS * 2 + 6 }, () => Math.random() * 100);
  const swell = { v: 0, phase: -1, next: 12 + Math.random() * 18, amp: 0.4 };
  const glints = Array.from({ length: 4 }, (_, i) => ({ phase: Math.random() * 6.28, speed: 0.05 + i * 0.017, seed: Math.random() * 100 }));

  const palette = { now: [], want: [] };
  for (let b = 0; b < BANDS; b++) { palette.now.push([255, 190, 120]); palette.want.push([255, 190, 120]); }
  const glintCol = { now: [255, 226, 190], want: [255, 226, 190] };

  const mic = {
    stream: null, ctx: null, an: null, spec: null, td: null, token: 0,
    db: new Float32Array(BANDS).fill(-100), floor: new Float32Array(BANDS).fill(-70), peak: new Float32Array(BANDS).fill(-50),
    norm: new Float32Array(BANDS), lastOnset: 0, input: -100, edges: [], lowHist: [-100, -100, -100], flux: 1,
  };

  // Smooth noise in 0–1: a few incommensurate sines.
  const noise = (x, s) => 0.5 + 0.25 * Math.sin(x + s) + 0.15 * Math.sin(x * 1.73 + s * 2.1) + 0.1 * Math.sin(x * 2.97 + s * 3.7);

  function resize() {
    W = canvas.width = Math.max(1, Math.round(innerWidth * SCALE));
    H = canvas.height = Math.max(1, Math.round(innerHeight * SCALE));
    poke();
  }

  const visTarget = () => (mode === 'off' || root.classList.contains('idle') || root.classList.contains('setup-mode') || root.classList.contains('connect-mode') ? 0 : 1);

  /* ── Mic analysis ── */

  function listen(dt) {
    if (!mic.an) return;
    mic.an.getFloatFrequencyData(mic.spec);     // dB per bin
    mic.an.getFloatTimeDomainData(mic.td);
    let sum = 0;
    for (let i = 0; i < mic.td.length; i++) sum += mic.td[i] * mic.td[i];
    mic.input = 20 * Math.log10(Math.sqrt(sum / mic.td.length) + 1e-9);
    const silent = mic.input < -66;                       // room silence reads as nothing
    // Band energy, then a gentle tilt (+4.5 dB per band) so the loudest band can be compared
    // fairly across the spectrum: music naturally has less energy per bin up high.
    let loudest = -200;
    for (let b = 0; b < BANDS; b++) {
      const [lo, hi] = mic.edges[b];
      let p = 0;
      for (let k = lo; k <= hi; k++) p += Math.pow(10, mic.spec[k] / 10);
      mic.db[b] = 10 * Math.log10(p / (hi - lo + 1) + 1e-12);
      loudest = Math.max(loudest, mic.db[b] + 4.5 * b);
    }
    for (let b = 0; b < BANDS; b++) {
      const db = mic.db[b];
      // Adaptive gain: the floor follows the quiet level (falls fast, rises slowly); the peak
      // jumps up instantly and relaxes toward the floor over ~10 s.
      if (db < mic.floor[b]) mic.floor[b] += (db - mic.floor[b]) * Math.min(1, dt / 0.5);
      else mic.floor[b] += (db - mic.floor[b]) * Math.min(1, dt / 8);
      if (db > mic.peak[b]) mic.peak[b] = db;
      else mic.peak[b] += (mic.floor[b] - mic.peak[b]) * Math.min(1, dt / PEAK_TAU);
      const range = Math.max(MIN_RANGE, mic.peak[b] - mic.floor[b]);
      // Noise gate: room silence, and bands holding only faint leakage (30 dB+ under the
      // loudest), read as nothing instead of being amplified into light.
      const significant = clamp((db + 4.5 * b - (loudest - 30)) / 10, 0, 1);
      const n = silent || db < ABS_GATE ? 0 : significant * clamp((db - mic.floor[b] - GATE_DB) / (range - GATE_DB), 0, 1);
      mic.norm[b] = n;
      env[b] += (n - env[b]) * (1 - Math.exp(-dt / (n > env[b] ? ATTACK : RELEASE)));
      level[b] = Math.pow(env[b], CURVE);
    }
    // Beat: a sharp rise in the low end (over two frames, since an attack spans analysis
    // windows), well above its typical rise, while the low end leads the mix.
    const lowDb = 10 * Math.log10((Math.pow(10, mic.db[0] / 10) + Math.pow(10, mic.db[1] / 10)) / 2 + 1e-12);
    const rise = Math.max(0, lowDb - mic.lowHist[0]);
    mic.lowHist.shift(); mic.lowHist.push(lowDb);
    const prominent = lowDb + 2 >= loudest - 10;
    if (!silent && prominent && rise > Math.max(3, 2.2 * mic.flux) && Math.max(mic.norm[0], mic.norm[1]) > 0.3 && t - mic.lastOnset > 0.28) {
      flash = 1; mic.lastOnset = t;
    }
    mic.flux += (rise - mic.flux) * Math.min(1, dt / 1.2);
  }

  /* ── Ambient driver ── */

  function ambient(dt) {
    // An occasional gentle swell, every 15–40 s.
    swell.next -= dt;
    if (swell.phase < 0 && swell.next <= 0 && play > 0.5) { swell.phase = 0; swell.amp = 0.3 + Math.random() * 0.25; }
    if (swell.phase >= 0) {
      swell.phase += dt;
      const p = swell.phase;
      swell.v = p < 3 ? swell.amp * (0.5 - Math.cos(Math.PI * p / 3) / 2) : p < 4.5 ? swell.amp : swell.amp * (0.5 + Math.cos(Math.PI * Math.min(1, (p - 4.5) / 7)) / 2);
      if (p > 11.5) { swell.phase = -1; swell.v = 0; swell.next = 15 + Math.random() * 25; }
    }
    for (let b = 0; b < BANDS; b++) {
      const n = noise(t * (0.21 + b * 0.025), seeds[b]);
      const target = play * (0.16 + 0.42 * n + swell.v * (1 - b / (BANDS + 2)));
      env[b] += (target - env[b]) * (1 - Math.exp(-dt / (target < env[b] ? 0.45 : 0.6)));
      level[b] = Math.pow(env[b], 1.4);
    }
  }

  /* ── Drawing ── */

  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.min(0.92, Math.max(0, a)).toFixed(4)})`;

  // A soft elliptical pool of light; the gradient reaches zero long before the shape's bounds.
  function pool(x, y, rx, ry, c, a, angle = 0) {
    if (a < 0.003 || rx < 0.5 || ry < 0.5) return;
    g.save();
    g.translate(x, y);
    if (angle) g.rotate(angle);
    g.scale(rx / ry, 1);
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, ry);
    gr.addColorStop(0, rgba(c, a));
    gr.addColorStop(0.28, rgba(c, a * 0.66));
    gr.addColorStop(0.6, rgba(c, a * 0.24));
    gr.addColorStop(0.85, rgba(c, a * 0.05));
    gr.addColorStop(1, rgba(c, 0));
    g.fillStyle = gr;
    g.fillRect(-ry, -ry, ry * 2, ry * 2);
    g.restore();
  }

  function draw() {
    g.clearRect(0, 0, W, H);
    if (vis < 0.004) return;
    const I = INTENSITY[settings.intensity] || INTENSITY.normal;
    const A = vis * I.a;
    g.globalCompositeOperation = 'lighter';               // light adds up, like light does

    // A wide, faint haze that carries the overall loudness.
    let overall = 0;
    for (let b = 0; b < BANDS; b++) overall += level[b] / BANDS;
    pool(W / 2, H * 1.04, W * 0.7, H * (0.08 + 0.07 * overall + 0.03 * flash) * I.h, palette.now[0], (0.05 + 0.2 * overall + 0.14 * flash) * A);

    // Light pools, mirrored from the centre: bass in the middle, highs toward the edges.
    for (let b = 0; b < BANDS; b++) {
      const lv = level[b];
      const kick = flash * (b < 3 ? 1 : 0.45);
      const ry = Math.min(H * 0.23, H * (0.04 + 0.16 * lv + 0.035 * kick) * I.h);
      const rx = W * (0.075 + 0.055 * lv);
      const a = (0.025 + 0.68 * lv + 0.32 * kick) * A;
      for (const side of [-1, 1]) {
        const drift = (noise(t * 0.045 + b * 0.7, seeds[BANDS + b] + (side > 0 ? 13 : 0)) - 0.5) * 0.05;
        const x = W * (0.5 + side * (0.03 + b * 0.064 + drift));
        pool(x, H + ry * 0.14, rx, ry, palette.now[b], a);
      }
    }

    // Glints: soft patches drifting across the part of the disc the sleeve doesn't cover.
    const d = els.disc.getBoundingClientRect(), c = els.cover.getBoundingClientRect(), o = canvas.getBoundingClientRect();
    if (d.width > 4) {
      const cx = (d.left - o.left + d.width / 2) * SCALE, cy = (d.top - o.top + d.height / 2) * SCALE, R = (d.width / 2) * SCALE;
      const away = Math.atan2(cy - (c.top - o.top + c.height / 2) * SCALE, cx - (c.left - o.left + c.width / 2) * SCALE);
      const mids = (level[3] + level[4] + level[5] + level[6]) / 4;
      for (const gl of glints) {
        const th = away + 1.25 * Math.sin(gl.phase);
        const r = R * (0.5 + 0.5 * noise(t * 0.07, gl.seed));
        const x = cx + Math.cos(th) * r, y = cy + Math.sin(th) * r;
        const swellG = 0.5 + 0.5 * noise(t * 0.19, gl.seed + 7);
        const lv = mode === 'mic' ? mids : level[2 + (glints.indexOf(gl) % 4)];
        const a = (0.025 + 0.4 * lv * swellG + 0.34 * flash) * A;
        pool(x, y, R * (0.26 + 0.14 * lv + 0.08 * flash), R * (0.1 + 0.05 * lv), glintCol.now, a, th + Math.PI / 2);
      }
    }
    g.globalCompositeOperation = 'source-over';
  }

  /* ── Loop ── */

  function frame(now) {
    raf = 0;
    if (document.hidden) return;
    if (now - last < FRAME_MS - 2) { raf = requestAnimationFrame(frame); return; }
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const still = reducedMotion.matches;
    const ease = (cur, target, tau, eps) => { if (still) return target; const n = cur + (target - cur) * (1 - Math.exp(-dt / tau)); return Math.abs(n - target) < eps ? target : n; };
    vis = ease(vis, visTarget(), 0.9, 0.004);
    const playTarget = still ? 0.55 : state.playing ? 1 : 0;
    play = ease(play, playTarget, playTarget > play ? 1.4 : 0.9, 0.005);
    if (!still) t += dt;
    if (still) { for (let b = 0; b < BANDS; b++) { env[b] = 0.35; level[b] = Math.pow(0.35, 1.4); } flash = 0; }
    else if (mode === 'mic') listen(dt);
    else ambient(dt);
    flash = ease(flash, 0, 0.26, 0.002);
    palette.now.forEach((c, b) => { for (let k = 0; k < 3; k++) c[k] = ease(c[k], palette.want[b][k], 2, 0.5); });
    for (let k = 0; k < 3; k++) glintCol.now[k] = ease(glintCol.now[k], glintCol.want[k], 2, 0.5);
    if (!still) glints.forEach((gl) => { gl.phase += dt * gl.speed * (mode === 'mic' ? 1 : play); });   // still when paused
    draw();
    if (debugOn && (debugTick = (debugTick + 1) % 3) === 0) drawDebug();

    const coloursSettled = palette.now.every((c, b) => c.every((v, k) => v === palette.want[b][k])) && glintCol.now.every((v, k) => v === glintCol.want[k]);
    const quiet = mode !== 'mic' && play === 0 && flash === 0 && env.every((v) => v < 0.002);
    const settled = vis === visTarget() && coloursSettled && (still || quiet || vis === 0);
    if (!settled) raf = requestAnimationFrame(frame);
  }

  function poke() {
    if (raf || document.hidden) return;
    last = performance.now() - FRAME_MS;
    raf = requestAnimationFrame(frame);
  }

  /* ── Debug overlay (D) ── */

  const dbg = $('#vizDebug');
  function drawDebug() {
    const rows = [];
    for (let b = 0; b < BANDS; b++) {
      const hz = mic.edges[b] && mic.ctx ? `${Math.round(mic.edges[b][0] * mic.ctx.sampleRate / mic.an.fftSize)}Hz` : `b${b}`;
      const bar = '█'.repeat(Math.round(level[b] * 20)).padEnd(20, '·');
      rows.push(mode === 'mic'
        ? `${hz.padStart(7)} ${bar} ${level[b].toFixed(2)}  ${mic.db[b].toFixed(0).padStart(4)} dB  [${mic.floor[b].toFixed(0)} … ${mic.peak[b].toFixed(0)}]`
        : `${hz.padStart(7)} ${bar} ${level[b].toFixed(2)}`);
    }
    dbg.textContent = [
      `visualizer: ${mode}   intensity: ${settings.intensity}   ${flash > 0.5 ? '● beat' : '○'}`,
      mode === 'mic' ? `input ${mic.input.toFixed(1)} dBFS${mic.input < -66 ? '  (gated: silence)' : ''}` : `ambient   play ${play.toFixed(2)}   swell ${swell.v.toFixed(2)}`,
      '', ...rows,
    ].join('\n');
  }

  /* ── Microphone ── */

  async function startMic() {
    const token = ++mic.token;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('unsupported'), { name: 'NotSupportedError' });
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (token !== mic.token || mode !== 'mic') { stream.getTracks().forEach((tr) => tr.stop()); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0.3;               // we do our own smoothing
    an.minDecibels = -110; an.maxDecibels = -10;
    ctx.createMediaStreamSource(stream).connect(an);      // analysed only; never played back
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const hz = ctx.sampleRate / an.fftSize;
    const edges = [];                             // 8 log-spaced bands, 40 Hz – 12 kHz
    for (let b = 0; b < BANDS; b++) {
      const lo = Math.max(1, Math.round(40 * Math.pow(300, b / BANDS) / hz));
      const hi = Math.max(lo, Math.round(40 * Math.pow(300, (b + 1) / BANDS) / hz) - 1);
      edges.push([lo, Math.min(an.frequencyBinCount - 1, hi)]);
    }
    Object.assign(mic, { stream, ctx, an, edges, spec: new Float32Array(an.frequencyBinCount), td: new Float32Array(an.fftSize) });
    mic.floor.fill(-70); mic.peak.fill(-50); env.fill(0);
    stream.getTracks().forEach((tr) => tr.addEventListener('ended', () => { if (mode === 'mic' && mic.stream === stream) fallback({ name: 'NotFoundError' }); }));
    poke();
  }

  function stopMic() {
    mic.token++;
    const s = mic.stream;
    mic.stream = null;
    if (s) s.getTracks().forEach((tr) => tr.stop());
    if (mic.ctx) mic.ctx.close().catch(() => {});
    Object.assign(mic, { ctx: null, an: null });
  }

  function fallback(err) {
    stopMic();
    mode = 'ambient';
    settings.visualizer = 'ambient';
    saveSettings();
    syncPanel();
    const name = err && err.name;
    setVizNote(name === 'NotAllowedError' || name === 'SecurityError' ? 'Microphone access was not allowed, so Ambient is on instead.'
      : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'No microphone found, so Ambient is on instead.'
      : 'The microphone isn’t available here, so Ambient is on instead.');
    poke();
  }

  async function micGranted() {
    try { return (await navigator.permissions.query({ name: 'microphone' })).state === 'granted'; } catch { return false; }
  }

  const lift = (c, tint, k = 0.3) => mixRgb(mixRgb(c, tint, 0.3), [255, 244, 228], k);

  return {
    // userChose: true when picked in the panel (may prompt); false on load (only if already allowed).
    async setMode(next, userChose) {
      if (next === mode && (next !== 'mic' || mic.stream)) { poke(); return; }
      if (mode === 'mic' && next !== 'mic') stopMic();
      mode = next;
      if (next !== 'mic') env.fill(Math.min(...env));     // no jump when switching back to ambient
      poke();
      if (next !== 'mic') return;
      if (!userChose && !(await micGranted())) {          // never prompt on page load
        fallback({ name: 'Deferred' });
        setVizNote('Pick Mic again to allow the microphone.');
        return;
      }
      try { await startMic(); } catch (e) { if (mode === 'mic') fallback(e); }
    },
    // Palette across the bands: the vinyl tint at the centre, the cover's other colours outward.
    colours(tint, mesh) {
      const order = [tint, mesh[3], mesh[1], tint, mesh[2], mesh[4], mesh[3], mesh[1]];
      for (let b = 0; b < BANDS; b++) {
        const c = order[b];
        palette.want[b] = c === tint ? mixRgb(tint, [255, 244, 228], 0.18) : lift(c, tint, 0.32);
        // keep the light luminous even when the cover is dark
        const [h, s, l] = rgbToHsl(palette.want[b]);
        palette.want[b] = hslToRgb([h, clamp(s * 1.1, 0.25, 0.85), clamp(l, 0.55, 0.78)]);
      }
      glintCol.want = mixRgb(tint, [255, 248, 236], 0.55);
      poke();
    },
    poke,
    resize,
    toggleDebug() { debugOn = !debugOn; dbg.hidden = !debugOn; if (debugOn) { drawDebug(); poke(); } },
    stats() { return { mode, level: Array.from(level), norm: Array.from(mic.norm), floor: Array.from(mic.floor), peak: Array.from(mic.peak), db: Array.from(mic.db), flash, input: mic.input, onsetAt: mic.lastOnset, t }; },
    hidden() { if (mic.stream) stopMic(); },                // mic off while the tab is hidden
    visible() { if (mode === 'mic' && !mic.stream) startMic().catch((e) => { if (mode === 'mic') fallback(e); }); poke(); },
  };
})();

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
    if (panel.open || document.querySelector('.controls:hover')) { cursorTimer = setTimeout(hide, 1000); return; }
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
    if (btn.dataset.action === 'settings') { toggleSettings(); btn.blur(); return; }
    control(btn.dataset.action);
    btn.blur();                                   // so Space doesn't re-press it
  });
  $('#controls').addEventListener('dblclick', (e) => e.stopPropagation());
  addEventListener('dblclick', () => { clearTimeout(clickTimer); toggleFullscreen(); });

  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (e.key === 'Escape' && panel.open) { e.preventDefault(); closeSettings(); return; }
    if ((e.key === 's' || e.key === 'S') && !(t.closest && t.closest('input, textarea'))) { e.preventDefault(); toggleSettings(); return; }
    if ((e.key === 'd' || e.key === 'D') && !(t.closest && t.closest('input, textarea'))) { e.preventDefault(); viz.toggleDebug(); return; }
    if (t.closest && t.closest('input, textarea, .setup, .connect')) return;   // typing / setup
    if (t.closest && t.closest('button') && (e.key === ' ' || e.key === 'Enter')) return;
    if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); if (!e.repeat) control('toggle'); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); control('previous'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); control('next'); }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopPolling(); viz.hidden(); return; }   // no polling, no mic while hidden
    acquireWakeLock();
    viz.visible();
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
  addEventListener('resize', viz.resize);

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
  bindSettings();
  viz.resize();
  applySettings();
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
  loadAccount();
}

start();
