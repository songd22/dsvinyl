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
  viz.colours(tint, mesh[1], mesh[3]);
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
  clock: true,
  clockFormat: new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 ? '12' : '24',
  clockDate: true,
  evening: true,
  eveningStart: '21:00',
  eveningEnd: '06:00',
  progress: true,
});
const CHOICES = { visualizer: ['off', 'ambient', 'mic'], clockFormat: ['12', '24'] };
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
  panel.el.querySelectorAll('[data-requires]').forEach((row) => row.classList.toggle('off', !settings[row.dataset.requires]));
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
 * A row of soft, rounded bars along the bottom edge, tinted by the album. Mirrored from
 * the centre: the middle is the low end, the edges the highs, and both ends taper away.
 * Ambient: a slow wave travels outward while music plays and settles when paused.
 * Mic: the bars follow real frequency bands, heavily smoothed.
 * One small canvas strip, at most 30 fps, and it stops drawing whenever nothing moves. */

const viz = (() => {
  const canvas = $('#viz');
  const g = canvas.getContext('2d');
  const FRAME_MS = 1000 / 30;
  const SLOT = 11;                 // CSS px per bar (bar + gap): fine lines, not blocks
  let W = 0, H = 0, scale = 1, N = 0, raf = 0, last = 0, clock = 0, mode = 'off';
  let vis = 0, energy = 0;
  let cur = new Float32Array(0), seed = new Float32Array(0), soft = new Float32Array(0);
  const col = [DEFAULT_TINT.slice(), DEFAULT_MESH[1].slice(), DEFAULT_MESH[3].slice()];
  const want = col.map((c) => c.slice());
  const mic = { stream: null, ctx: null, an: null, fd: null, td: null, level: 0, bands: new Float32Array(32), peaks: new Float32Array(32).fill(0.15), token: 0 };

  function resize() {
    scale = Math.min(2, window.devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    W = canvas.width = Math.max(1, Math.round(r.width * scale));
    H = canvas.height = Math.max(1, Math.round(r.height * scale));
    const n = Math.max(12, 2 * Math.round(r.width / SLOT / 2));
    if (n !== N) {
      N = n;
      const old = cur; cur = new Float32Array(N);
      for (let i = 0; i < N; i++) cur[i] = old.length ? old[Math.floor(i * old.length / N)] : 0;
      seed = Float32Array.from({ length: N }, () => Math.random() * Math.PI * 2);
      soft = new Float32Array(N);
    }
    poke();
  }

  const visTarget = () => (mode === 'off' || root.classList.contains('idle') || root.classList.contains('setup-mode') || root.classList.contains('connect-mode') ? 0 : 1);
  const energyTarget = () => (mode === 'mic' ? 1 : state.playing ? 1 : 0);

  // Distance from the centre, 0 (middle) … 1 (edge), and the gentle taper toward both ends.
  const dist = (i) => Math.abs((i + 0.5) / N * 2 - 1);
  const envelope = (d) => (0.38 + 0.62 * Math.pow(1 - d, 1.15)) * Math.min(1, (1 - d) / 0.14);

  function listen() {
    if (!mic.an) return;
    mic.an.getFloatTimeDomainData(mic.td);
    let sum = 0;
    for (let i = 0; i < mic.td.length; i++) sum += mic.td[i] * mic.td[i];
    const db = 20 * Math.log10(Math.sqrt(sum / mic.td.length) + 1e-7);
    mic.level += (clamp((db + 60) / 46, 0, 1) - mic.level) * 0.2;
    mic.an.getByteFrequencyData(mic.fd);
    const hz = mic.ctx.sampleRate / mic.an.fftSize, B = mic.bands.length;
    for (let b = 0; b < B; b++) {               // log-spaced bands, 40 Hz – 9 kHz
      const lo = 40 * Math.pow(9000 / 40, b / B), hi = 40 * Math.pow(9000 / 40, (b + 1) / B);
      let s = 0, n = 0;
      for (let k = Math.max(1, Math.floor(lo / hz)); k <= Math.min(mic.fd.length - 1, Math.ceil(hi / hz)); k++) { s += mic.fd[k]; n++; }
      const v = n ? s / n / 255 : 0;
      mic.peaks[b] = Math.max(v, mic.peaks[b] * 0.996, 0.1);   // self-adjusting, so quiet rooms still read
      mic.bands[b] = v / mic.peaks[b];
    }
  }

  function target(i) {
    const d = dist(i), env = envelope(d);
    if (mode === 'mic') {
      const b = Math.min(mic.bands.length - 1, Math.floor(d * mic.bands.length));
      return env * Math.pow(mic.bands[b], 1.4) * (0.45 + 0.55 * mic.level);
    }
    // Ambient: two slow waves drifting outward from the centre, a little different per bar.
    const w1 = 0.5 + 0.5 * Math.sin(clock * 0.95 - d * 5.2 + seed[i] * 0.18);
    const w2 = 0.5 + 0.5 * Math.sin(clock * 0.53 + d * 2.9 + seed[i] * 0.25);
    const breathe = 0.88 + 0.12 * Math.sin(clock * 0.6);
    return env * (0.06 + energy * (0.22 + 0.95 * w1 * w2) * breathe);
  }

  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

  // Heights blended with their neighbours, so the row reads as one flowing shape.
  function smooth() {
    soft.set(cur);
    const tmp = new Float32Array(N);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < N; i++) tmp[i] = 0.25 * soft[Math.max(0, i - 1)] + 0.5 * soft[i] + 0.25 * soft[Math.min(N - 1, i + 1)];
      soft.set(tmp);
    }
  }

  function draw() {
    g.clearRect(0, 0, W, H);
    if (vis < 0.004) return;
    smooth();
    const slot = W / N, bw = Math.max(1, slot * 0.46), maxH = H * 0.95;

    g.globalAlpha = vis;                            // fades the whole row in and out

    // 1. A low, soft mound of light that the bars rise out of.
    const pt = (k) => [(k + 0.5) * slot, H - soft[k] * maxH * 0.75];
    g.beginPath();
    g.moveTo(0, H);
    g.lineTo(0, pt(0)[1]);
    for (let k = 1; k < N; k++) {
      const [x0, y0] = pt(k - 1), [x1, y1] = pt(k);
      g.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    }
    g.lineTo(W, pt(N - 1)[1]);
    g.lineTo(W, H);
    g.closePath();
    const glow = g.createLinearGradient(0, H - maxH * 0.9, 0, H);
    glow.addColorStop(0, 'rgba(255,255,255,0)');
    glow.addColorStop(1, 'rgba(255,255,255,0.32)');
    g.fillStyle = glow;
    g.fill();

    // 2. Fine bars of light, each fading out toward its top (no hard caps).
    for (let i = 0; i < N; i++) {
      const h = soft[i] * maxH;
      if (h < 1) continue;
      const x = i * slot + (slot - bw) / 2, y = H - h;
      const bar = g.createLinearGradient(0, y, 0, H);
      bar.addColorStop(0, 'rgba(255,255,255,0)');
      bar.addColorStop(0.55, 'rgba(255,255,255,0.32)');
      bar.addColorStop(1, 'rgba(255,255,255,0.6)');
      g.fillStyle = bar;
      g.fillRect(x, y, bw, h);
    }

    // 3. Tint everything with the album palette, flowing across the row.
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-in';
    const tint = g.createLinearGradient(0, 0, W, 0);
    tint.addColorStop(0, rgba(col[1], 1)); tint.addColorStop(0.3, rgba(col[0], 1));
    tint.addColorStop(0.5, rgba(col[2], 1)); tint.addColorStop(0.7, rgba(col[0], 1)); tint.addColorStop(1, rgba(col[1], 1));
    g.fillStyle = tint;
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';
  }

  function frame(now) {
    raf = 0;
    if (document.hidden) return;
    if (now - last < FRAME_MS - 2) { raf = requestAnimationFrame(frame); return; }
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const still = reducedMotion.matches;
    const ease = (c, t, tau, eps) => { if (still) return t; const n = c + (t - c) * (1 - Math.exp(-dt / tau)); return Math.abs(n - t) < eps ? t : n; };
    if (mode === 'mic' && !still) listen();
    vis = ease(vis, visTarget(), 0.9, 0.004);
    const eT = still ? (state.playing ? 0.5 : 0) : energyTarget();   // reduced motion: a still silhouette
    energy = ease(energy, eT, eT > energy ? 1.4 : 1.0, 0.006);
    for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) col[c][k] = ease(col[c][k], want[c][k], 2, 0.5);
    if (!still && energy > 0) clock += dt * (0.4 + 0.6 * energy);   // the wave slows as it settles
    let bars = true;
    for (let i = 0; i < N; i++) {
      const t = target(i);
      const tau = mode === 'mic' ? (t > cur[i] ? 0.07 : 0.32) : 0.25;   // mic: quick rise, slow fall
      cur[i] = ease(cur[i], t, tau, 0.0015);
      if (cur[i] !== t) bars = false;
    }
    draw();
    const settled = vis === visTarget() && col.every((c, ci) => c.every((v, k) => v === want[ci][k])) &&
      (still || (mode !== 'mic' && energy === 0 && eT === 0 && bars));
    if (!settled) raf = requestAnimationFrame(frame);
  }

  function poke() {
    if (raf || document.hidden) return;
    last = performance.now() - FRAME_MS;
    raf = requestAnimationFrame(frame);
  }

  async function startMic() {
    const token = ++mic.token;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('unsupported'), { name: 'NotSupportedError' });
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (token !== mic.token || mode !== 'mic') { stream.getTracks().forEach((t) => t.stop()); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0.8;
    ctx.createMediaStreamSource(stream).connect(an);      // analysed only; never played back
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    Object.assign(mic, { stream, ctx, an, td: new Float32Array(an.fftSize), fd: new Uint8Array(an.frequencyBinCount) });
    stream.getTracks().forEach((t) => t.addEventListener('ended', () => { if (mode === 'mic' && mic.stream === stream) fallback({ name: 'NotFoundError' }); }));
    poke();
  }

  function stopMic() {
    mic.token++;
    const s = mic.stream;
    mic.stream = null;
    if (s) s.getTracks().forEach((t) => t.stop());
    if (mic.ctx) mic.ctx.close().catch(() => {});
    Object.assign(mic, { ctx: null, an: null, level: 0 });
    mic.bands.fill(0);
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

  return {
    // userChose: true when picked in the panel (may prompt); false on load (only if already allowed).
    async setMode(next, userChose) {
      if (next === mode && (next !== 'mic' || mic.stream)) { poke(); return; }
      if (mode === 'mic' && next !== 'mic') stopMic();
      mode = next;
      poke();
      if (next !== 'mic') return;
      if (!userChose && !(await micGranted())) {          // never prompt on page load
        fallback({ name: 'Deferred' });
        setVizNote('Pick Mic again to allow the microphone.');
        return;
      }
      try { await startMic(); } catch (e) { if (mode === 'mic') fallback(e); }
    },
    colours(tint, a, b) {
      const lift = (c) => mixRgb(mixRgb(c, tint, 0.35), [255, 240, 220], 0.3);
      want[0] = mixRgb(tint, [255, 240, 220], 0.12); want[1] = lift(a); want[2] = lift(b);
      poke();
    },
    poke,
    resize,
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
