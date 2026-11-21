// Lookout (Station Egg Hunt): single-page app, hash routing, no build step.
// Talks to the backend at window.EGG_API_BASE (set in config.js; empty = same origin).
//
// Look: every egg is a ticket. The app takes the colour of the line you're at
// (html[data-line]), found eggs get punched, and the game marks tickets with purple stamps.

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');

const REPORT_REASONS = [
  ['cant_find', "Can't be found"],
  ['unsafe', 'Unsafe spot'],
  ['person', 'Shows a person'],
];
const MAIN_LINES = ['Red', 'Orange', 'Blue', 'Green'];
const RANGE_METERS = 400; // closer than this to a station counts as "at" it
const ACCURACY_CAP = 150; // forgive up to this much GPS error
const PUNCH_HOLES = 18; // the play clock is a row of holes, punched as time runs out
const EXIT_EXTRA = 150; // once you're at a station, leaving it takes this much more distance (GPS wobbles underground)
const AWAY_MS = 45_000; // away from the app longer than this (a train ride, say) and the old location fix no longer counts
const STALE_MS = 120_000; // refetch egg counts and progress after this long
const DEFAULT_GRACE = 15; // seconds after the clock hits zero that a find is still accepted (the server sends the real value)

const API_BASE = String(window.EGG_API_BASE ?? '').replace(/\/$/, '');
const apiUrl = (path) => API_BASE + path;

// session = { user, token } from register/login. Each device gets its own token.
const session = readStored('egg-session');
const state = {
  user: session?.user ?? null,
  token: session?.token ?? null,
  config: null,
  stations: null,
  stationsAt: 0,
  lastStationId: readStored('egg-last-station'),
  raceTrain: readStored('egg-race-train') ?? false,
  line: readStored('egg-line'), // colour family the app is wearing: Red | Orange | Blue | Green | null
  // The round on the clock. Kept in localStorage, so a reload, a closed app or the camera
  // app pushing this tab out of memory all come back to the same round.
  play: readPlay(),
  pendingHide: readStored('egg-pending-hide'), // the hide in progress: { stationId, stationName, level, levelName, findId, expiresAt }
  hides: (readStored('egg-hides') ?? []).filter((h) => Date.parse(h.expiresAt) > Date.now()), // finds you can still hide the next egg for
  skippedHides: readStored('egg-hides-skipped') ?? [],
  board: { mode: 'all', stationId: null },
  hud: null, // { rank, points, rival, gap, rows, lines, at }
  progress: null, // /api/me/progress
  progressAt: 0,
  timers: [],
  map: null,
};

// ---------- helpers ----------
function readStored(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}
function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: fine */
  }
}

// Every call has a timeout: in a dead spot underground a request can otherwise hang for minutes.
async function api(path, body, { timeout = body?.image ? 60_000 : 20_000 } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  const sentToken = state.token;
  if (sentToken) headers.authorization = `Bearer ${sentToken}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  let data;
  try {
    res = await fetch(apiUrl(path), { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    data = await res.json().catch(() => ({}));
  } catch {
    throw new Error(
      ctrl.signal.aborted
        ? 'The connection timed out. Signal is patchy in stations, so try again.'
        : "Can't reach the game server. Check your signal and try again.",
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // Signed out on another device, or the session expired: back to sign-in, wherever this happened.
    if (res.status === 401 && sentToken && sentToken === state.token && !/^\/api\/auth\/(login|register)$/.test(path)) {
      sessionEnded();
    }
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), ms);
}

function every(ms, fn) {
  const id = setInterval(fn, ms);
  state.timers.push(() => clearInterval(id));
}
function onCleanup(fn) {
  state.timers.push(fn);
}
function clearTimers() {
  state.timers.forEach((stop) => stop());
  state.timers = [];
}
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const fmtClock = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, Math.floor(s)) % 60).padStart(2, '0')}`;
const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const an = (word) => (/^[aeiou]/i.test(word) ? 'an' : 'a');

// The server refreshes a session's last-seen time at most once an hour, so don't claim more precision than that.
const relTime = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function fmtLastSeen(iso) {
  const hours = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (hours < 1) return 'within the last hour';
  if (hours < 24) return relTime.format(-Math.floor(hours), 'hour');
  return relTime.format(-Math.floor(hours / 24), 'day');
}

// Sessions store the raw user-agent. Turn it into something like "Safari on iPhone".
function describeDevice(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /CrOS/.test(ua) ? 'Chromebook'
    : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
    : /Linux/.test(ua) ? 'Linux'
    : '';
  const browser = /Edg(A|iOS)?\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome|CriOS/.test(ua) ? 'Chrome'
    : /Safari/.test(ua) ? 'Safari'
    : '';
  if (os && browser) return `${browser} on ${os}`;
  return os || browser || 'Unknown device';
}

function distanceM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Downscale photos on the phone before upload: small enough to send on one bar of signal,
// big enough for the photo check.
async function photoToJpeg(file, max = 1024) {
  let source;
  try {
    source = await createImageBitmap(file);
  } catch {
    const url = URL.createObjectURL(file);
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Couldn't read that photo. Try again."));
      img.src = url;
    }).finally(() => setTimeout(() => URL.revokeObjectURL(url), 0));
  }
  const scale = Math.min(1, max / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8);
}

// Station list with egg counts. Refetched when it's a couple of minutes old; with no
// signal the last copy is still good for picking a station.
async function getStations() {
  if (!state.stations || Date.now() - state.stationsAt > STALE_MS) {
    try {
      state.stations = (await api('/api/stations')).stations;
      state.stationsAt = Date.now();
    } catch (err) {
      if (!state.stations) throw err;
    }
  }
  return state.stations;
}

// ---------- the round on the clock, kept across reloads ----------
// The deadline is wall-clock time, not performance.now(): phones stop that clock while the screen is off.
function readPlay() {
  const p = readStored('egg-play');
  return p?.attempt && p.deadline + DEFAULT_GRACE * 1000 > Date.now() ? { ...p, result: null, before: null, restored: true } : null;
}
function savePlay() {
  const p = state.play;
  store(
    'egg-play',
    p && !p.result
      ? { attempt: p.attempt, egg: p.egg, station: p.station, deadline: p.deadline, firstChance: p.firstChance, requestedTrain: p.requestedTrain }
      : null,
  );
}
function setPlay(round, extra = {}) {
  state.play = {
    attempt: round.attempt,
    egg: round.egg,
    station: extra.station ?? state.stations?.find((s) => s.id === round.egg.stationId) ?? null,
    deadline: Date.now() + round.attempt.secondsLeft * 1000,
    firstChance: Boolean(extra.firstChance),
    requestedTrain: Boolean(extra.requestedTrain),
    restored: Boolean(round.resumed),
    before: extra.before ?? null,
    result: null,
  };
  savePlay();
}
function endPlay() {
  state.play = null;
  savePlay();
  store('egg-photo', null);
}
const graceSeconds = () => state.config?.graceSeconds ?? DEFAULT_GRACE;
const secondsLeftOf = (p) => (p.deadline - Date.now()) / 1000;
// The round still takes a find (there's a grace period after the clock hits zero).
const liveRound = () => (state.play && !state.play.result && secondsLeftOf(state.play) + graceSeconds() > 0 ? state.play : null);

// ---------- finds you can still hide the next egg for ----------
// Kept on the phone and refreshed from the server, so closing the app after a find doesn't lose the hide.
function setHides(list) {
  state.hides = list.filter((h) => Date.parse(h.expiresAt) > Date.now());
  store('egg-hides', state.hides);
}
const addHide = (h) => setHides([h, ...state.hides.filter((x) => x.findId !== h.findId)]);
const dropHide = (findId) => setHides(state.hides.filter((h) => h.findId !== findId));
function skipHide(findId) {
  state.skippedHides = [...state.skippedHides.slice(-20), findId];
  store('egg-hides-skipped', state.skippedHides);
}
const openHides = () => state.hides.filter((h) => Date.parse(h.expiresAt) > Date.now() && !state.skippedHides.includes(h.findId));
function startHide(h) {
  state.pendingHide = h;
  store('egg-pending-hide', h);
  location.hash = '#/hide';
}
function forgetRounds() {
  endPlay();
  state.pendingHide = null;
  store('egg-pending-hide', null);
  store('egg-giveups', null);
  setHides([]);
}

// Giving up has to reach the server, or the round comes back on the next sync (and Play on
// that egg would resume it). With no signal, it's remembered and sent on the next sync.
const pendingGiveUps = () => readStored('egg-giveups') ?? [];
async function giveUp(attemptId) {
  store('egg-giveups', [...new Set([...pendingGiveUps(), attemptId])]);
  try {
    await api(`/api/attempts/${attemptId}/give-up`, {}, { timeout: 6000 });
  } catch (err) {
    if (!err.status || err.status >= 500) return; // no signal: try again later
    // 403/404/409: not yours or already over, so there's nothing left to give up.
  }
  store('egg-giveups', pendingGiveUps().filter((id) => id !== attemptId));
}

// Ask the server what's running: after a reload, a closed app, or coming back to the tab.
async function syncActive() {
  if (!state.user) return;
  for (const id of pendingGiveUps()) await giveUp(id);
  let data;
  try {
    data = await api('/api/me/active', null, { timeout: 8000 });
  } catch {
    return; // no signal, or an older server without this endpoint: keep what this phone remembers
  }
  if (data.round && pendingGiveUps().includes(data.round.attempt.id)) data.round = null; // given up offline
  const local = state.play;
  if (data.round) {
    if (local && !local.result && local.attempt.id === data.round.attempt.id) {
      local.deadline = Date.now() + data.round.attempt.secondsLeft * 1000; // the server's clock wins
      savePlay();
    } else if (!local?.result) {
      setPlay(data.round, { station: data.round.station });
      state.play.restored = true;
    }
  } else if (local && !local.result) {
    // It ran out, was scored, or was given up on another device.
    const saved = data.hides.some((h) => h.stationId === local.egg.stationId && h.level === local.egg.level);
    endPlay();
    if (saved) toast(`Your find at ${local.egg.stationName} was saved.`);
  }
  setHides(data.hides);
}

// Keep the screen on while the clock runs, so the timer stays in view while you search.
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    /* not supported, or battery saver said no: fine */
  }
}

// Station names as a big head: break after "/" and step down the size for long names.
const stationHead = (name) =>
  `<h1 class="station ${name.length > 13 ? 'station-long' : ''}">${esc(name).replace(/\//g, '/<wbr>')}</h1>`;
// Live times can fail (rate limits, the MBTA API being down): say so plainly.
const trainsUnavailable = (msg) => (/429|rate/i.test(msg || '') ? 'Live train times are busy right now. Try again in a minute.' : msg || 'No live predictions right now');

function loading(text = 'Loading') {
  app.innerHTML = `<div class="empty"><div class="spin" aria-hidden="true"></div><p>${esc(text)}</p></div>`;
}

// ---------- line colour ----------
// Green-B/C/D/E roll up to Green and Mattapan to Red, the same way the leaderboard counts lines.
const family = (routeId) => (routeId.startsWith('Green') ? 'Green' : routeId === 'Mattapan' ? 'Red' : routeId);
const familiesOf = (lines = []) => [...new Set(lines.map((l) => family(l.id)))];
const branchesOf = (lines = []) => lines.filter((l) => /^Green-[A-E]$/.test(l.id)).map((l) => l.id.slice(-1));
const LINE_VAR = { Red: 'var(--line-red)', Orange: 'var(--line-orange)', Blue: 'var(--line-blue)', Green: 'var(--line-green)' };

// The whole app takes the colour of this line: buttons, bands, points, the timer.
function setLine(fam) {
  state.line = MAIN_LINES.includes(fam) ? fam : null;
  document.documentElement.dataset.line = state.line ?? '';
  store('egg-line', state.line);
  const meta = document.querySelector('meta[name="theme-color"]');
  const color = getComputedStyle(document.documentElement).getPropertyValue('--here').trim();
  if (meta && color) meta.content = color;
}

function lineBand(station, right = '') {
  const fams = familiesOf(station.lines);
  const branches = branchesOf(station.lines);
  const others = fams
    .slice(1)
    .map((f) => `<span class="band-chip" style="--ln:${LINE_VAR[f] ?? 'var(--muted)'}">${esc(f)}</span>`)
    .join('');
  return `<div class="band">
    <p class="band-name">${esc(fams[0] ? `${fams[0]} Line` : 'Station')}</p>
    ${others}
    ${branches.length ? `<ul class="branches" aria-label="Branches">${branches.map((b) => `<li>${b}</li>`).join('')}</ul>` : ''}
    ${right ? `<p class="band-right">${right}</p>` : ''}
  </div>`;
}

// ---------- location: detected automatically ----------
// status: idle | locating | ok | denied | unavailable | insecure
// hereId: the station you're at (sticky, see hereStation). pinned: you picked it yourself.
// minFixAt: ignore fixes older than this (the phone may hand back one from the last station).
// prev / lastHereId: where you were before the app went away, to suggest it and sort the list.
const loc = {
  status: 'idle', pos: null, watchId: null, subs: new Set(),
  hereId: null, pinned: false, minFixAt: 0, prev: null, lastHereId: null, slowTimer: null,
};

function startLocation() {
  if (!window.isSecureContext || !navigator.geolocation) {
    loc.status = 'insecure';
    return notifyLoc();
  }
  if (loc.watchId != null) return;
  if (!loc.pos) loc.status = 'locating';
  notifyLoc();
  // Deep underground there may be no fresh fix at all: stop the spinner and offer the list.
  clearTimeout(loc.slowTimer);
  loc.slowTimer = setTimeout(() => {
    if (!loc.pos && loc.status === 'locating') {
      loc.status = 'unavailable';
      notifyLoc();
    }
  }, 15_000);
  loc.watchId = navigator.geolocation.watchPosition(
    (p) => {
      if (p.timestamp < loc.minFixAt) return; // taken before you left the last station
      loc.pos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
      loc.status = 'ok';
      notifyLoc();
    },
    (err) => {
      if (err.code === 1) {
        loc.status = 'denied';
        navigator.geolocation.clearWatch(loc.watchId);
        loc.watchId = null;
      } else if (!loc.pos) loc.status = 'unavailable';
      notifyLoc();
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 120000 },
  );
}
function retryLocation() {
  if (loc.watchId != null) navigator.geolocation.clearWatch(loc.watchId);
  loc.watchId = null;
  startLocation();
}
// Back after a while (off a train, say): the fix we have belongs to the last station.
function freshLocation(awayFrom) {
  loc.minFixAt = awayFrom;
  if (loc.pos) loc.prev = loc.pos;
  if (loc.hereId) loc.lastHereId = loc.hereId;
  loc.pos = null;
  loc.hereId = null;
  loc.pinned = false;
  if (loc.status === 'ok') loc.status = 'locating';
  retryLocation();
}
// Remember where you were when the app goes away, for the next open.
function markAway() {
  hiddenAt = Date.now();
  store('egg-away-at', { at: hiddenAt, pos: loc.pos ?? loc.prev, hereId: loc.hereId ?? loc.lastHereId });
}
let hiddenAt = null;
function notifyLoc() {
  loc.subs.forEach((fn) => fn());
}
function onLoc(fn) {
  loc.subs.add(fn);
  onCleanup(() => loc.subs.delete(fn));
}
function nearestStation(stations) {
  if (!loc.pos) return null;
  let best = null;
  for (const s of stations) {
    const m = distanceM(loc.pos, s);
    if (!best || m < best.m) best = { station: s, m };
  }
  return best;
}
const slack = () => Math.min(loc.pos?.accuracy ?? 0, ACCURACY_CAP);
const isInRange = (n) => Boolean(n && n.m <= RANGE_METERS + slack() + (n.station.id === loc.hereId ? EXIT_EXTRA : 0));
// The station you're at. GPS wobbles underground, so once you're at one it takes a clear move
// to switch: past the exit distance, or another station much nearer. A station you picked
// yourself ("Not this station?") sticks while you're in range of it.
function hereStation(stations) {
  const n = nearestStation(stations);
  if (!n || !loc.hereId || n.station.id === loc.hereId) return n;
  const cur = stations.find((s) => s.id === loc.hereId);
  if (!cur) return n;
  const m = distanceM(loc.pos, cur);
  const keep = m <= RANGE_METERS + slack() + EXIT_EXTRA && (loc.pinned || m - n.m < 150);
  return keep ? { station: cur, m } : n;
}

// ---------- the HUD: rank, points and the rival just above you ----------
async function refreshHud(force = false) {
  if (!state.user) return;
  if (!force && state.hud && Date.now() - state.hud.at < 30_000) return drawHud();
  try {
    const board = await api('/api/leaderboard');
    const mine = board.rows.find((r) => r.userId === state.user.id);
    const rival = mine ? board.rows.find((r) => r.rank === mine.rank - 1) : board.rows[board.rows.length - 1];
    state.hud = {
      at: Date.now(),
      rank: mine?.rank ?? null,
      points: mine?.points ?? 0,
      rows: board.rows,
      lines: board.lines,
      rival: rival ?? null,
      gap: rival ? rival.points - (mine?.points ?? 0) + 1 : 0,
    };
  } catch {
    /* the HUD is extra: keep the last one */
  }
  drawHud();
}

function drawHud() {
  const el = $('#hud');
  if (!state.user) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const h = state.hud;
  const chip = h?.rank ? `<span class="rank-chip">${ordinal(h.rank)}</span>` : '';
  let rival = '<span class="rival-txt">Find an egg to get on the board</span><span class="rival-bar" style="--p:0%"></span>';
  if (h?.rival) {
    const p = h.rival.points ? Math.max(4, Math.min(100, Math.round((h.points / h.rival.points) * 100))) : 0;
    rival = `<span class="rival-txt"><b>${plural(h.gap, 'pt')}</b> to pass ${esc(h.rival.username)}</span><span class="rival-bar" style="--p:${p}%"></span>`;
  } else if (h?.rank === 1) {
    rival = '<span class="rival-txt"><b>1st this month.</b> Hold on to it.</span><span class="rival-bar" style="--p:100%"></span>';
  }
  // Left the round's screen (back button, another tab) while the clock is still running.
  const live = liveRound();
  const round = live && !(location.hash || '').startsWith('#/play')
    ? `<a class="round-call" href="#/play"><span><b>Round running:</b> ${esc(live.egg.levelName)} at ${esc(live.egg.stationName)}</span><span class="rc-clock" data-live-clock>${fmtClock(secondsLeftOf(live))}</span><span class="rc-go">Back to it</span></a>`
    : '';
  el.innerHTML = `
    <div class="hud-top">
      <a href="#/" class="brand"><img src="icon.svg" alt="" width="28" height="28" />Lookout</a>
      <a class="mypts" href="#/leaderboard">${chip}<b>${h?.points ?? 0}</b> pts</a>
    </div>
    <a class="rival" href="#/leaderboard">${rival}</a>
    ${round}`;
}

async function refreshProgress() {
  try {
    state.progress = await api('/api/me/progress');
    state.progressAt = Date.now();
  } catch {
    /* extra */
  }
  return state.progress;
}

// "Hide the next egg" calls for finds whose 30 minutes aren't up, shown on the station screens.
function hideCalls() {
  return openHides()
    .slice(0, 2)
    .map((h) => {
      const mins = Math.max(1, Math.ceil((Date.parse(h.expiresAt) - Date.now()) / 60_000));
      return `<section class="hide-call" aria-label="Hide the next egg">
        <p><b>Hide the next ${esc(h.levelName)} egg at ${esc(h.stationName)}.</b> You have ${plural(mins, 'minute')} to photograph one there.</p>
        <div class="hide-call-act">
          <button class="btn btn-primary" type="button" data-hide-find="${esc(h.findId)}">Hide it</button>
          <button class="link" type="button" data-skip-find="${esc(h.findId)}">Skip</button>
        </div>
      </section>`;
    })
    .join('');
}

// ---------- router ----------
const routes = [
  [/^#?\/?$/, viewHere],
  [/^#\/stations$/, viewStations],
  [/^#\/station\/([^/]+)$/, (id) => viewStation(id)],
  [/^#\/play$/, viewPlay],
  [/^#\/hide$/, viewHide],
  [/^#\/leaderboard$/, viewLeaderboard],
  [/^#\/profile$/, viewProfile],
  [/^#\/user\/([^/]+)$/, viewPlayer],
  [/^#\/map$/, viewMap],
];

// Each render gets an id. A view that awaited something checks it's still the latest before
// drawing, so a slow screen finishing late can't cover the one you tapped after it.
let renderId = 0;
let booted = false;

const route = { prev: null, now: null };
async function render() {
  const rid = ++renderId;
  clearTimers();
  if (state.map) {
    state.map.remove();
    state.map = null;
  }
  window.scrollTo(0, 0);
  if (!state.user) {
    $('#tabs').hidden = true;
    drawHud();
    return viewSignup();
  }
  const hash = location.hash || '#/';
  if (hash !== route.now) [route.prev, route.now] = [route.now, hash];
  const playing = hash.startsWith('#/play') || hash.startsWith('#/hide');
  $('#hud').classList.toggle('hud-quiet', playing);
  $('#tabs').hidden = playing;
  const tab = hash.startsWith('#/map')
    ? 'map'
    : hash.startsWith('#/leaderboard') || hash.startsWith('#/user/')
      ? 'leaderboard'
      : hash.startsWith('#/profile')
        ? 'profile'
        : 'here';
  document.querySelectorAll('#tabs a').forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  refreshHud();

  for (const [re, view] of routes) {
    const m = re.exec(hash);
    if (!m) continue;
    try {
      await view(...m.slice(1).map(decodeURIComponent));
    } catch (err) {
      if (rid !== renderId || err.status === 401) return; // a newer screen, or sessionEnded() is already showing sign-in
      // No signal (or a server error): offer a retry, and retry by itself when signal comes back.
      const retry = !err.status || err.status >= 500;
      app.innerHTML = `<div class="notice bad" data-load-failed="${retry}">${esc(err.message)}</div>
        <p class="btn-row">${retry ? '<button class="btn btn-ink" type="button" id="retryView">Try again</button>' : ''}<a class="btn btn-ghost" href="#/">Back</a></p>`;
      $('#retryView')?.addEventListener('click', render);
    }
    return;
  }
  location.hash = '#/';
}

function setSession(data) {
  state.user = data?.user ?? null;
  state.token = data?.token ?? null;
  store('egg-session', data ? { user: data.user, token: data.token } : null);
}

// The server said this device's session is gone (signed out elsewhere, or expired).
function sessionEnded() {
  setSession(null);
  forgetRounds();
  state.hud = null;
  state.progress = null;
  if (booted) {
    toast('You were signed out. Sign in again to keep playing.');
    setTimeout(render);
  }
}

// Forget this device's session. `everywhere` signs out every device on the account.
async function signOut({ remote = false, everywhere = false } = {}) {
  if (remote && state.token) {
    try {
      await api(everywhere ? '/api/auth/logout-all' : '/api/auth/logout', {});
    } catch {
      /* already invalid: fine */
    }
  }
  setSession(null);
  forgetRounds();
  state.hud = null;
  state.progress = null;
  render();
}

// ---------- line war (public) ----------
function lineWar(lines, { title = 'Line war', sub = "Points at each line's stations this month" } = {}) {
  const totals = MAIN_LINES.map((l) => ({ line: l, points: lines?.find((x) => x.line === l)?.points ?? 0 })).sort(
    (a, b) => b.points - a.points,
  );
  const max = Math.max(1, totals[0].points);
  return `<section class="tk war" aria-label="${esc(title)}">
    <div class="war-head"><h3 class="war-title">${esc(title)}</h3><p class="war-sub">${esc(sub)}</p></div>
    <ol class="war-bars">${totals
      .map(
        (t) => `<li style="--ln:${LINE_VAR[t.line]};--w:${Math.round((t.points / max) * 100)}%"><span class="war-name">${t.line}</span><span class="war-bar" aria-hidden="true"></span><b>${t.points.toLocaleString()}</b></li>`,
      )
      .join('')}</ol>
  </section>`;
}

// ---------- sign in / create account ----------
function viewSignup(mode = 'register') {
  setLine(state.line);
  const registering = mode === 'register';
  const min = state.config?.passwordMin ?? 8;
  app.innerHTML = `
    <form id="auth" class="tk welcome">
      <div class="band band-lines" aria-hidden="true"><i style="--ln:var(--line-red)"></i><i style="--ln:var(--line-orange)"></i><i style="--ln:var(--line-blue)"></i><i style="--ln:var(--line-green)"></i></div>
      <div class="tk-top">
        <span class="brand brand-l"><img src="icon.svg" alt="" width="36" height="36" />Lookout</span>
        <h1 class="welcome-h">Find what's hiding in your station.</h1>
        <p class="welcome-p">Riders photograph small things in MBTA stations. You get the photo and a timer. Find it, take a photo, and score for your line.</p>
      </div>
      <div class="tk-perf" aria-hidden="true"></div>
      <div class="tk-bottom stack">
        <div class="seg" role="tablist">
          <button type="button" role="tab" data-mode="register" aria-selected="${registering}">Create account</button>
          <button type="button" role="tab" data-mode="login" aria-selected="${!registering}">Sign in</button>
        </div>
        <label class="field-label" for="username">Username</label>
        <input id="username" class="input" maxlength="20" autocomplete="username" autocapitalize="none" placeholder="e.g. kenmore_kid" required />
        <label class="field-label" for="password">Password ${registering ? `<span class="opt">(at least ${min} characters)</span>` : ''}</label>
        <input id="password" class="input" type="password" maxlength="200" ${registering ? `minlength="${min}"` : ''} autocomplete="${registering ? 'new-password' : 'current-password'}" required />
        <button class="btn btn-ink btn-block btn-l">${registering ? 'Start playing' : 'Sign in'}</button>
        <div id="err"></div>
      </div>
    </form>
    <div id="teaser"></div>`;
  app.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => viewSignup(b.dataset.mode)));
  $('#auth').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#auth .btn-ink');
    btn.disabled = true;
    try {
      const data = await api(registering ? '/api/auth/register' : '/api/auth/login', {
        username: $('#username').value,
        password: $('#password').value,
      });
      setSession(data);
      startLocation();
      await syncActive(); // a round started on another phone carries on here
      const to = liveRound() ? '#/play' : '#/';
      if ((location.hash || '#/') !== to) location.hash = to;
      else render();
    } catch (err) {
      $('#err').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
      btn.disabled = false;
    }
  });
  api('/api/leaderboard')
    .then((b) => {
      const t = $('#teaser');
      if (t && b.lines.length) t.innerHTML = lineWar(b.lines, { title: 'Line war this month', sub: 'Every find scores for its line' });
    })
    .catch(() => {});
}

// ---------- Here: the station you're standing in ----------
async function viewHere() {
  const rid = renderId;
  loading('Finding your station');
  const stations = await getStations();
  if (rid !== renderId) return;
  let lastKey = null;
  const keyNow = () => {
    const n = hereStation(stations);
    return { n, key: `${loc.status}|${n?.station.id ?? ''}|${isInRange(n)}` };
  };
  onLoc(() => {
    const { n, key } = keyNow();
    if (key !== lastKey) return render();
    const d = $('#dist');
    if (d && n) d.textContent = fmtDist(n.m);
  });
  if (loc.status === 'idle') startLocation();
  const { n, key } = keyNow();
  lastKey = key;
  if (isInRange(n)) {
    loc.hereId = n.station.id;
    return showStation(n.station.id, { here: true, distance: n.m, rid });
  }
  loc.hereId = null;
  loc.pinned = false;
  if (n) {
    setLine(familiesOf(n.station.lines)[0]);
    return showNearby(stations, n);
  }
  return showLocating(stations);
}

const BAND_LINES = '<div class="band band-lines" aria-hidden="true"><i style="--ln:var(--line-red)"></i><i style="--ln:var(--line-orange)"></i><i style="--ln:var(--line-blue)"></i><i style="--ln:var(--line-green)"></i></div>';

function showLocating(stations) {
  const msg = {
    idle: ['Finding your station', 'Lookout uses your location to open the station you are in.'],
    locating: ['Finding your station', "Underground? A fix from the last couple of minutes works, so it's fine if you got one on the way in."],
    denied: ['Location is off for Lookout', 'Allow location for this site in your browser settings, then try again. Or pick your station below.'],
    unavailable: ['No location fix yet', "Underground the phone often can't get one. Pick your station below, or try again near the entrance."],
    insecure: ['Pick your station', 'Phones only share location with https:// pages. Open the https link to detect your station automatically.'],
  }[loc.status] ?? ['Pick your station', ''];
  const canRetry = loc.status === 'denied' || loc.status === 'unavailable';
  // Where you were the last time the app was open: one tap if you're still there.
  const last = loc.lastHereId && stations.find((s) => s.id === loc.lastHereId);
  app.innerHTML = `
    ${hideCalls()}
    <section class="tk locate">
      ${BAND_LINES}
      <div class="tk-top">
        ${loc.status === 'locating' ? '<div class="spin" aria-hidden="true"></div>' : ''}
        <h1 class="locate-h">${esc(msg[0])}</h1>
        <p class="locate-p">${esc(msg[1])}</p>
        ${canRetry ? '<button id="retry" class="btn btn-ink btn-block" type="button">Try again</button>' : ''}
        ${last ? `<a class="btn btn-ghost btn-block still-here" href="#/station/${encodeURIComponent(last.id)}">Still at ${esc(last.name)}?</a>` : ''}
      </div>
    </section>
    <h2 class="sec-h">Stations</h2>
    ${stationSearch()}`;
  $('#retry')?.addEventListener('click', retryLocation);
  wireStationSearch(stations);
}

function showNearby(stations, n) {
  app.innerHTML = `
    ${hideCalls()}
    <section class="tk locate">
      ${lineBand(n.station)}
      <div class="tk-top">
        <p class="here">Nearest station</p>
        ${stationHead(n.station.name)}
        <p class="far"><b id="dist">${fmtDist(n.m)}</b> away. Get within ${RANGE_METERS} m and it opens here.</p>
      </div>
      <div class="tk-perf" aria-hidden="true"></div>
      <div class="tk-bottom stack">
        <a class="btn btn-primary btn-block" href="#/station/${encodeURIComponent(n.station.id)}">See ${esc(n.station.name)}</a>
        <a class="btn btn-ghost btn-block" href="#/map">Open the map</a>
      </div>
    </section>
    <h2 class="sec-h">Stations near you</h2>
    ${stationSearch()}`;
  wireStationSearch(stations);
}

function stationSearch() {
  return `<input id="q" class="input" type="search" placeholder="Search stations" aria-label="Search stations" />
    <ul id="list" class="st-list"></ul>`;
}
function wireStationSearch(stations) {
  const draw = () => {
    const q = $('#q').value.trim().toLowerCase();
    let rows = stations.filter((s) => s.name.toLowerCase().includes(q));
    // With no fix yet, sort around where you last were (the next station is near the last one),
    // but only show distances from a real fix.
    const ref = loc.pos ?? loc.prev;
    rows = ref
      ? rows.map((s) => ({ ...s, m: distanceM(ref, s) })).sort((a, b) => a.m - b.m).map((s) => (loc.pos ? s : { ...s, m: null }))
      : [...rows].sort((a, b) => b.activeEggs - a.activeEggs || a.name.localeCompare(b.name));
    $('#list').innerHTML = rows.length
      ? rows
          .slice(0, 40)
          .map(
            (s) => `<li><a href="#/station/${encodeURIComponent(s.id)}">
              <span class="st-lines">${familiesOf(s.lines).map((f) => `<i style="--ln:${LINE_VAR[f] ?? 'var(--muted)'}"></i>`).join('')}</span>
              <span class="st-txt"><b>${esc(s.name)}</b><small>${s.m != null ? `${fmtDist(s.m)} away, ` : ''}${s.activeEggs ? `${plural(s.activeEggs, 'egg')} hidden` : 'no eggs yet'}</small></span>
              ${s.activeEggs ? `<span class="st-count">${s.activeEggs}/5</span>` : ''}
            </a></li>`,
          )
          .join('')
      : `<li class="empty"><p>No station called “${esc(q)}”.</p></li>`;
  };
  $('#q').addEventListener('input', draw);
  draw();
}

async function viewStations() {
  const rid = renderId;
  loading();
  const stations = await getStations();
  if (rid !== renderId) return;
  app.innerHTML = `<h1 class="page-h">Stations</h1><p class="page-sub">Any station on the T. Play opens wherever you are.</p>${stationSearch()}`;
  wireStationSearch(stations);
}

// ---------- one station ----------
async function viewStation(id) {
  const rid = renderId;
  loading();
  const stations = await getStations();
  if (rid !== renderId) return;
  const st = stations.find((s) => s.id === id);
  const m = st && loc.pos ? distanceM(loc.pos, st) : null;
  // Picking a station you're in range of from the list means you're there. This is how a wrong
  // GPS guess gets fixed: "Not this station?" -> pick yours, and Here sticks to it. (Opening a
  // nearby station from the map is just looking, so it doesn't move Here.)
  const here = m != null && isInRange({ station: st, m });
  if (here && loc.hereId !== id && route.prev === '#/stations') {
    loc.hereId = id;
    loc.pinned = true;
  }
  await showStation(id, { here, distance: m, rid });
}

// Which eggs here you can still score, and how many you've found.
function stationCard(slots) {
  const playable = slots.filter((s) => s.egg && !s.egg.mine);
  const found = playable.filter((s) => s.egg.foundByMe).length;
  return { playable: playable.length, found, cleared: playable.length > 0 && found === playable.length };
}

async function showStation(id, { here = false, distance = null, rid = renderId } = {}) {
  const [{ station, slots }] = await Promise.all([
    api(`/api/stations/${encodeURIComponent(id)}`),
    state.progress && Date.now() - state.progressAt < STALE_MS ? null : refreshProgress(),
  ]);
  if (rid !== renderId) return;
  state.lastStationId = id;
  store('egg-last-station', id);
  setLine(familiesOf(station.lines)[0]);
  const card = stationCard(slots);
  const stamp = here
    ? '<p class="stamp stamp-corner">In range</p>'
    : distance != null
      ? `<p class="stamp stamp-corner stamp-quiet">${fmtDist(distance)} away</p>`
      : '';
  const raceNote = (on) => (on ? 'On. Your timer is the time until the next train (1.5 to 15 min).' : 'Off. Each level has its own timer.');

  app.innerHTML = `
    ${here ? '' : '<a class="back" href="#/stations"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>All stations</a>'}
    ${hideCalls()}
    <section class="tk station-tk">
      ${lineBand(station)}
      <div class="tk-top">
        <p class="here">${here ? "You're at" : 'Station'}</p>
        ${stationHead(station.name)}
        ${stamp}
        ${here ? '<a class="link not-here" href="#/stations">Not this station? Pick yours</a>' : ''}
      </div>
      <div class="tk-perf" aria-hidden="true"></div>
      <div class="tk-bottom">
        <div id="next" class="next-row"><span class="route" aria-hidden="true"></span><div><p class="next-label">Next train</p><p class="next-to next-none">Loading live times</p></div></div>
        <label class="race">
          <span class="race-text"><b>Race the next train</b><small id="raceNote">${raceNote(state.raceTrain)}</small></span>
          <input id="race" type="checkbox" role="switch" class="race-input" ${state.raceTrain ? 'checked' : ''} />
        </label>
      </div>
    </section>
    ${challengeTicket(state.progress?.today)}
    <div class="eggs-head">
      <h2 class="sec-h">Eggs here</h2>
      ${card.playable ? `<div class="clear">
        <ol class="clear-slots" aria-label="Your ${esc(station.name)} card: ${card.found} of ${card.playable} found">${slots
          .map((s) => `<li class="slot ${!s.egg ? 'is-empty' : s.egg.mine ? 'is-mine' : s.egg.foundByMe ? 'is-found' : 'is-open'}"><span>${s.level}</span></li>`)
          .join('')}</ol>
        <p class="clear-note">${card.cleared ? '<b>Cleared.</b> Every egg here is punched.' : `<b>${card.found} of ${card.playable}</b> found here`}</p>
      </div>` : ''}
    </div>
    <ol class="stubs">${slots.map((s) => stubRow(s)).join('')}</ol>`;

  $('#race').addEventListener('change', (e) => {
    state.raceTrain = e.target.checked;
    store('egg-race-train', state.raceTrain);
    $('#raceNote').textContent = raceNote(state.raceTrain);
  });

  app.querySelectorAll('[data-play]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (btn.getAttribute('aria-disabled') === 'true') return;
      const eggId = btn.dataset.play;
      const live = liveRound();
      if (live?.egg.id === eggId) {
        location.hash = '#/play'; // already on the clock for this one
        return;
      }
      if (live && !confirm(`Your ${live.egg.levelName} round at ${live.egg.stationName} is still running. Give it up and start this one?`)) return;
      btn.setAttribute('aria-disabled', 'true');
      const slot = slots.find((s) => s.egg?.id === eggId);
      const before = { hud: state.hud, progress: state.progress, card };
      try {
        // The server picks up a round that's still running instead of restarting the clock.
        const round = await api('/api/attempts', { eggId, mode: state.raceTrain ? 'train' : 'fixed' });
        if (live) giveUp(live.attempt.id);
        setPlay(round, { station, firstChance: slot?.egg?.timesFound === 0, before, requestedTrain: state.raceTrain && !round.resumed });
        location.hash = '#/play';
      } catch (err) {
        toast(err.message);
        btn.removeAttribute('aria-disabled');
      }
    }),
  );
  app.querySelectorAll('[data-hide]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const level = state.config.levels.find((l) => l.level === Number(btn.dataset.hide));
      startHide({ stationId: id, stationName: station.name, level: level.level, levelName: level.name, findId: null, expiresAt: null });
    }),
  );

  const loadTrains = async () => {
    const box = $('#next');
    if (!box) return;
    try {
      const { trains, error } = await api(`/api/stations/${encodeURIComponent(id)}/predictions`);
      const t = trains.find((x) => x.seconds > -20);
      box.innerHTML = t
        ? `<span class="route" style="--ln:${esc(t.color)}" aria-hidden="true"></span>
           <div><p class="next-label">Next train${t.line ? `, ${esc(t.line)}` : ''}</p><p class="next-to">${esc(t.headsign || t.line)}</p></div>
           <p class="next-min">${t.seconds < 60 ? '<span class="now">Now</span>' : `${Math.round(t.seconds / 60)}<small>min</small>`}</p>`
        : `<span class="route" aria-hidden="true"></span><div><p class="next-label">Next train</p><p class="next-to next-none">${esc(trainsUnavailable(error))}</p></div>`;
    } catch (err) {
      box.innerHTML = `<span class="route" aria-hidden="true"></span><div><p class="next-label">Next train</p><p class="next-to next-none">${esc(trainsUnavailable(err.message))}</p></div>`;
    }
  };
  loadTrains();
  every(30_000, loadTrains);
}

function stubRow(slot) {
  const { egg } = slot;
  const pips = `<span class="pips" aria-label="Difficulty ${slot.level} of 5">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= slot.level ? 'on' : ''}"></i>`).join('')}</span>`;
  const mins = `${Math.round(slot.seconds / 60)} min`;
  if (!egg) {
    return `<li class="stub is-empty">
      <span class="punch" aria-hidden="true">${slot.level}</span>
      <div class="stub-body"><p class="stub-name">${esc(slot.name)}</p>${pips}<p class="stub-meta">Empty. Hide the first one, worth ${slot.points}.</p></div>
      <button class="stub-act" type="button" data-hide="${slot.level}"><b aria-hidden="true">+</b><span>Hide</span></button>
    </li>`;
  }
  if (egg.mine) {
    return `<li class="stub is-mine">
      <span class="punch" aria-hidden="true">${slot.level}</span>
      <div class="stub-body"><p class="stub-name">${esc(slot.name)}</p><p class="stub-meta">Your egg, ${egg.timesFound === 0 ? 'nobody has found it yet' : `found ${plural(egg.timesFound, 'time')}`}</p></div>
      <div class="stub-act"><p class="stamp stamp-s">Yours</p></div>
    </li>`;
  }
  if (egg.foundByMe) {
    return `<li class="stub is-found">
      <span class="punch" aria-hidden="true">${slot.level}</span>
      <div class="stub-body"><p class="stub-name">${esc(slot.name)}</p><p class="stub-meta">You found it. Hidden by ${esc(egg.createdBy)}.</p></div>
      <div class="stub-act"><p class="stamp stamp-s">Found</p></div>
    </li>`;
  }
  // Your round on this egg is still running (here or on another phone): pick it back up.
  const live = liveRound();
  const running = live?.egg.id === egg.id ? secondsLeftOf(live) : egg.round?.secondsLeft;
  if (running != null) {
    return `<li class="stub is-open is-live">
      <span class="punch" aria-hidden="true">${slot.level}</span>
      <div class="stub-body"><p class="stub-name">${esc(slot.name)}</p>${pips}<p class="stub-meta">Your round is running.</p></div>
      <button class="stub-act" type="button" data-play="${egg.id}"><b ${live?.egg.id === egg.id ? 'data-live-clock' : ''}>${fmtClock(running)}</b><span>Resume</span></button>
    </li>`;
  }
  // Ran out of time or gave up on it: you can try again after the cooldown.
  const wait = egg.retryAt ? Math.ceil((Date.parse(egg.retryAt) - Date.now()) / 60_000) : 0;
  if (wait > 0) {
    return `<li class="stub is-open is-wait">
      <span class="punch" aria-hidden="true">${slot.level}</span>
      <div class="stub-body"><p class="stub-name">${esc(slot.name)}</p>${pips}<p class="stub-meta">Not this time. Try it again in ${plural(wait, 'minute')}.</p></div>
      <div class="stub-act"><b>${wait}</b><span>min</span></div>
    </li>`;
  }
  const hot = egg.timesFound === 0;
  return `<li class="stub is-open ${hot ? 'is-hot' : ''}">
    <span class="punch" aria-hidden="true">${slot.level}</span>
    <div class="stub-body"><p class="stub-name">${esc(slot.name)}</p>${pips}<p class="stub-meta">${hot ? `${mins}. Nobody's found it yet.` : `${mins}, found ${plural(egg.timesFound, 'time')}`}</p></div>
    <button class="stub-act" type="button" data-play="${egg.id}"><b>${slot.points}</b><span>Play</span></button>
  </li>`;
}

function challengeTicket(today) {
  if (!today) return '';
  // Transfer: fill one circle per line that counts (one find at a two-line station counts once).
  const lines = MAIN_LINES.filter((l) => today.lines?.includes(l)).slice(0, today.progress);
  const steps = today.id === 'transfer'
    ? lines.map((l) => `<li class="done" style="--ln:${LINE_VAR[l]}">${l[0]}</li>`).join('') +
      Array.from({ length: Math.max(0, today.target - lines.length) }, () => '<li></li>').join('')
    : Array.from({ length: today.target }, (_, i) => `<li class="${i < today.progress ? 'done' : ''}"></li>`).join('');
  return `<section class="challenge ${today.done ? 'is-done' : ''}" aria-label="Today's challenge">
    <span class="seal-mini" aria-hidden="true"><svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" stroke-width="2.5" ${today.done ? '' : 'stroke-dasharray="3 2.4"'}/><path d="M12 22h16M24 17l4 5-4 5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    <div class="ch-body">
      <p class="ch-title">Today: ${esc(today.title)}</p>
      <p class="ch-desc">${today.done ? 'Done. Stamp earned.' : esc(today.description)}</p>
      <ol class="ch-steps" aria-label="${today.progress} of ${today.target}">${steps}</ol>
    </div>
    <p class="ch-reward">${today.done ? 'Stamped' : 'Earns a stamp'}</p>
  </section>`;
}

// ---------- play a round ----------
function viewPlay() {
  const play = state.play;
  if (!play) {
    location.hash = state.lastStationId ? `#/station/${encodeURIComponent(state.lastStationId)}` : '#/';
    return;
  }
  if (play.result) return renderResult();
  if (play.station) setLine(familiesOf(play.station.lines)[0]);

  const { attempt, egg } = play;
  const secondsLeft = () => secondsLeftOf(play);
  const graceLeft = () => secondsLeft() + graceSeconds();
  const maxBonus = state.config?.maxTimeBonus ?? 0.5;
  const perHole = attempt.limitSeconds / PUNCH_HOLES;
  const back = `#/station/${encodeURIComponent(egg.stationId)}`;
  const welcomeBack = play.restored;
  play.restored = false;
  const timerNote = attempt.limitSource === 'train'
    ? `Racing the ${esc(attempt.train?.headsign || 'next')} train. `
    : play.requestedTrain
      ? 'No train due in 1.5 to 15 minutes, so this round uses the level timer. '
      : '';

  app.innerHTML = `
    <div class="play-bar">
      <a class="icon-btn" href="${back}" aria-label="Back to ${esc(egg.stationName)}. Your round keeps running."><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></a>
      <p class="play-title"><b>${esc(egg.levelName)}</b> at ${esc(egg.stationName)}</p>
      <p class="mypts mypts-here"><b>${egg.points}</b> pts</p>
    </div>
    ${welcomeBack ? '<p class="notice">Welcome back. The clock kept running while you were away.</p>' : ''}
    <section class="tk play-tk">
      <div class="tk-top">
        <div class="egg-photo">
          <img src="${apiUrl(egg.imageUrl)}" alt="The egg to find: a photo of something in this station" />
          ${play.firstChance ? '<p class="first-tag">Nobody has found this yet</p>' : ''}
        </div>
        ${egg.hint ? `<p class="hint"><b>Hint</b> ${esc(egg.hint)}</p>` : ''}
      </div>
      <div class="tk-perf" aria-hidden="true"></div>
      <div class="tk-bottom">
        <div class="clock-row">
          <p id="clock" class="clock" role="timer" aria-label="Time left">${fmtClock(secondsLeft())}</p>
          <div class="bonus"><p class="bonus-label">Bonus right now</p><p class="bonus-val">+<span id="bonus">0</span></p></div>
        </div>
        <ol id="holes" class="punchclock" aria-hidden="true">${'<li></li>'.repeat(PUNCH_HOLES)}</ol>
        <p class="clock-ctx">${timerNote}Each hole is ${Math.round(perHole)} seconds. The bonus drains as they go.</p>
      </div>
    </section>
    <div id="status" aria-live="polite"></div>
    <label class="btn btn-ink btn-block btn-l" id="snap">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>
      <span id="snapText">Found it, take a photo</span>
      <input id="cam" class="file-hidden" type="file" accept="image/*" capture="environment" />
    </label>
    <div class="play-foot">
      <span class="report">Report: ${REPORT_REASONS.map(([k, label]) => `<button class="link" type="button" data-report="${k}">${label}</button>`).join('')}</span>
      <button class="link" type="button" id="quit">Give up</button>
    </div>`;

  // The clock runs on the deadline (wall-clock time), so it's right after the screen was off.
  const holes = [...app.querySelectorAll('#holes li')];
  let sending = false;
  const tick = () => {
    const s = secondsLeft();
    const clock = $('#clock');
    if (!clock) return;
    clock.textContent = fmtClock(s);
    clock.classList.toggle('is-low', s <= 20);
    $('#bonus').textContent = Math.round(egg.points * maxBonus * Math.max(0, Math.min(1, s / attempt.limitSeconds)));
    const punched = Math.floor((attempt.limitSeconds - Math.max(0, s)) / perHole);
    holes.forEach((h, i) => h.classList.toggle('p', i < punched));
    // Out of time, unless a photo is on its way (the server judges it by when the upload started).
    if (graceLeft() <= 0 && !sending) {
      play.result = { status: 'expired' };
      renderResult();
    }
  };
  tick();
  every(250, tick);
  keepAwake(true);
  onCleanup(() => keepAwake(false));

  const status = $('#status');
  const snap = $('#snap');
  function showRetry(message, image) {
    status.innerHTML = `<div class="notice bad">${esc(message)}</div>
      <div class="retry">
        <img src="${image}" alt="Your photo" />
        <button id="resend" class="btn btn-primary btn-block" type="button">Send this photo again</button>
      </div>`;
    snap.hidden = false;
    $('#snapText').textContent = 'Take a new photo';
    $('#resend').addEventListener('click', () => send(image));
  }
  async function send(image) {
    sending = true;
    snap.hidden = true;
    status.innerHTML = `<div class="notice row"><div class="spin" aria-hidden="true"></div>${state.config?.gemini ? 'Checking your photo against the egg' : 'Saving your find'}</div>`;
    try {
      const result = await api(`/api/attempts/${attempt.id}/find`, { image });
      if (state.play !== play) return; // left this round meanwhile
      store('egg-photo', null);
      if (result.status === 'no_match') {
        status.innerHTML = `<div class="notice bad"><b>Not a match.</b> ${esc(result.reason)} Keep looking.</div>`;
        snap.hidden = false;
        $('#snapText').textContent = 'Found it, take a photo';
        return;
      }
      play.result = result;
      play.myPhoto = image;
      savePlay();
      renderResult();
    } catch (err) {
      if (state.play !== play || err.status === 401) return;
      if ([403, 404, 409].includes(err.status)) {
        // The round is over (given up on another phone, say): nothing to resend.
        endPlay();
        status.innerHTML = `<div class="notice bad">${esc(err.message)}</div><a class="btn btn-ghost btn-block" href="${back}">Back to ${esc(egg.stationName)}</a>`;
        return;
      }
      showRetry(err.message, image);
    } finally {
      sending = false;
    }
  }

  $('#cam').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    let image;
    try {
      image = await photoToJpeg(file);
    } catch (err) {
      status.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
      return;
    }
    // Keep the photo until the server has it: if the signal drops or the app closes, it can still go.
    store('egg-photo', { attemptId: attempt.id, image });
    send(image);
  });
  // A photo that didn't finish sending last time: send it now (or when there's signal).
  const pending = readStored('egg-photo');
  if (pending?.attemptId === attempt.id && pending.image) {
    if (navigator.onLine === false) showRetry("Your photo hasn't been sent yet. Send it when you have signal.", pending.image);
    else send(pending.image);
  }

  app.querySelectorAll('[data-report]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm(`Report this egg as “${b.textContent}”?`)) return;
      try {
        const r = await api(`/api/eggs/${egg.id}/report`, { reason: b.dataset.report });
        toast(r.retired ? 'Thanks. That egg has been removed.' : 'Thanks, report sent.');
      } catch (err) {
        toast(err.message);
      }
    }),
  );
  $('#quit').addEventListener('click', async (e) => {
    const mins = state.config?.retryCooldownMinutes ?? 60;
    if (!confirm(`Give up this round? You can try this egg again in ${mins} minutes.`)) return;
    e.currentTarget.disabled = true;
    endPlay();
    await giveUp(attempt.id); // before the station loads, so it shows the cooldown and not Play
    location.hash = back;
  });
}

// The round stamp shown when a station is cleared.
function stationSeal(name, sub) {
  const id = `ring-${Math.random().toString(36).slice(2, 8)}`;
  return `<svg class="seal-svg" viewBox="0 0 160 160" role="img" aria-label="${esc(name)} cleared">
    <defs><path id="${id}" d="M80,80 m-58,0 a58,58 0 1,1 116,0 a58,58 0 1,1 -116,0"/></defs>
    <circle cx="80" cy="80" r="74" fill="none" stroke="currentColor" stroke-width="5"/>
    <circle cx="80" cy="80" r="44" fill="none" stroke="currentColor" stroke-width="2.5"/>
    <text class="seal-ring"><textPath href="#${id}" startOffset="2%">${esc(sub)}</textPath></text>
    <text class="seal-mid" x="80" y="88" text-anchor="middle">Cleared</text>
  </svg>`;
}

async function renderResult() {
  clearTimers();
  const play = state.play;
  const { result, egg } = play;
  const back = `#/station/${encodeURIComponent(egg.stationId)}`;

  if (result.status === 'expired') {
    app.innerHTML = `
      <section class="tk win">
        ${play.station ? lineBand(play.station, esc(egg.levelName)) : ''}
        <div class="tk-top">
          <h1 class="win-head">Time's up</h1>
          <p class="win-sub">The ${esc(egg.levelName)} egg at ${esc(egg.stationName)} stays hidden for now. Every hole is punched. You can try it again in ${plural(state.config?.retryCooldownMinutes ?? 60, 'minute')}.</p>
        </div>
      </section>
      <a class="btn btn-ink btn-block btn-l" href="${back}">Try another level</a>`;
    endPlay();
    return;
  }

  const { points, verification } = result;
  const chads = [[-46, -30, 120], [38, -42, -80], [52, 10, 200], [-30, 36, 60], [14, 48, -140], [-56, 4, 30]]
    .map(([x, y, r]) => `<i class="chad" style="--x:${x}px;--y:${y}px;--r:${r}deg"></i>`)
    .join('');
  app.innerHTML = `
    <section class="tk win">
      ${play.station ? lineBand(play.station, esc(egg.levelName)) : ''}
      <div class="tk-top">
        <h1 class="win-head">${result.firstFind ? 'Found it first' : 'Found it'}</h1>
        <p class="win-pts">+<span id="count">${points.total}</span></p>
        <span class="hole hole-big" aria-hidden="true">${chads}</span>
        <p class="stamp stamp-big">Found ${fmtClock(result.secondsTaken)}</p>
      </div>
      <div class="tk-perf" aria-hidden="true"></div>
      <dl class="tk-bottom win-math">
        <div><dt>${esc(egg.levelName)}</dt><dd>${points.base}</dd></div>
        <div><dt>Time bonus</dt><dd>+${points.bonus}</dd></div>
        <div><dt>Took</dt><dd>${fmtClock(result.secondsTaken)}</dd></div>
      </dl>
    </section>
    <section class="match" aria-label="Photo check">
      <div class="match-pair">
        <figure class="m"><img src="${apiUrl(egg.imageUrl)}" alt="The egg photo" /><figcaption>The egg</figcaption></figure>
        ${play.myPhoto ? `<figure class="m"><img src="${play.myPhoto}" alt="Your photo" /><figcaption>Your photo</figcaption></figure>` : ''}
      </div>
      <p class="match-verdict ${verification.method === 'gemini' ? 'is-ok' : ''}">${verification.method === 'gemini' ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>Photos match${verification.reason ? `: ${esc(verification.reason)}` : ''}` : esc(verification.reason)}</p>
    </section>
    <ul id="gains" class="gains" aria-live="polite"></ul>
    <section class="next-egg">
      <h2 class="sec-h">Hide the next one</h2>
      <p class="next-egg-copy">Your photo becomes the new ${esc(egg.levelName)} egg at ${esc(egg.stationName)}.</p>
      <button id="hide" class="btn btn-primary btn-block btn-l" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>Hide the next ${esc(egg.levelName)} egg</button>
      <a id="skip" class="btn btn-ghost btn-block" href="${back}">Skip</a>
    </section>`;

  // Count the points up once (unless the viewer asked for less motion).
  if (!reducedMotion()) {
    const el = $('#count');
    const t0 = performance.now() + 450;
    const step = (now) => {
      if (!el.isConnected) return;
      const k = Math.min(1, Math.max(0, (now - t0) / 700));
      el.textContent = Math.round(points.total * (1 - (1 - k) ** 3));
      if (k < 1) requestAnimationFrame(step);
    };
    el.textContent = '0';
    requestAnimationFrame(step);
  }

  // The right to hide the next egg lasts 30 minutes and survives closing the app: the station
  // screens show a "Hide the next egg" call until it's used, skipped or runs out.
  const hideRight = {
    findId: result.findId,
    stationId: egg.stationId,
    stationName: egg.stationName,
    level: egg.level,
    levelName: egg.levelName,
    points: egg.points,
    expiresAt: new Date(Date.now() + (state.config?.hideWindowMinutes ?? 30) * 60_000).toISOString(),
  };
  addHide(hideRight);
  state.stationsAt = 0; // egg counts may have changed
  $('#hide').addEventListener('click', () => {
    endPlay();
    startHide(hideRight);
  });
  $('#skip').addEventListener('click', () => {
    skipHide(result.findId);
    endPlay();
  });

  // What this find changed: rank, rival, line war, challenge, stamps, the station card.
  const before = play.before ?? {};
  const [, progress, stationNow] = await Promise.all([
    refreshHud(true),
    refreshProgress(),
    api(`/api/stations/${encodeURIComponent(egg.stationId)}`).catch(() => null),
  ]);
  const gains = [];
  const h = state.hud;
  if (h?.rank) {
    const was = before.hud?.rank ?? null;
    if (!was) gains.push(['up', `<b>You're on the board at ${ordinal(h.rank)}.</b>`]);
    else if (h.rank < was) {
      const passed = h.rows.filter((r) => r.rank > h.rank && r.rank <= was).map((r) => r.username);
      gains.push(['up', `<b>Up to ${ordinal(h.rank)}.</b> You passed ${esc(passed[0] ?? 'someone')}${passed.length > 1 ? ` and ${passed.length - 1} more` : ''}.`]);
    }
    if (h.rival) gains.push(['rival', `<b>Next: ${esc(h.rival.username)}.</b> ${plural(h.gap, 'point')} to pass.`]);
  }
  // A find scores for every line at the station (Park Street: Red and Green).
  const fams = play.station ? familiesOf(play.station.lines).filter((f) => MAIN_LINES.includes(f)) : [];
  const fam = fams[0] ?? null;
  if (fam && h?.lines?.length) {
    const sorted = MAIN_LINES.map((l) => ({ line: l, points: h.lines.find((x) => x.line === l)?.points ?? 0 })).sort((a, b) => b.points - a.points);
    const i = sorted.findIndex((x) => x.line === fam);
    const line = sorted[i];
    const tied = sorted.filter((x) => x.line !== fam && x.points === line.points).map((x) => x.line);
    const note = tied.length
      ? `${fam} is tied with ${tied.join(' and ')}.`
      : i === 0
        ? `${fam} leads ${sorted[1].line} by ${(line.points - sorted[1].points).toLocaleString()}.`
        : `${fam} is ${ordinal(i + 1)}, ${(sorted[i - 1].points - line.points).toLocaleString()} behind ${sorted[i - 1].line}.`;
    const lines = fams.length > 1 ? `the ${fams.slice(0, -1).join(', ')} and ${fams.at(-1)} Lines` : `the ${fam} Line`;
    gains.push(['line', `<b>+${points.total} for ${lines}.</b> ${note}`, fam]);
  }
  if (progress?.today?.done && before.progress && !before.progress.today?.done) {
    gains.push(['stamp', `<b>Challenge done: ${esc(progress.today.title)}.</b> Stamp earned.`]);
  }
  const had = new Set((before.progress?.stamps ?? []).filter((s) => s.earned).map((s) => s.id));
  if (before.progress) {
    for (const s of progress?.stamps ?? []) if (s.earned && !had.has(s.id)) gains.push(['stamp', `<b>Stamp earned: ${esc(s.name)}.</b> ${esc(s.description)}`]);
  }

  const box = $('#gains');
  if (!box) return;
  const card = stationNow ? stationCard(stationNow.slots) : null;
  const month = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'America/New_York' });
  const sealHtml = card?.cleared && !before.card?.cleared
    ? `<li class="gain gain-seal">${stationSeal(egg.stationName, `${egg.stationName}, ${fam ? `${fam} Line, ` : ''}${month}`)}<p><b>${esc(egg.stationName)} cleared.</b> Every egg you can play here is punched.</p></li>`
    : card && card.playable
      ? `<li class="gain"><span class="gain-ico gain-card" aria-hidden="true">${card.found}/${card.playable}</span><p><b>${esc(egg.stationName)} card: ${card.found} of ${card.playable}.</b> ${card.playable - card.found === 1 ? 'One egg left to clear it.' : `${card.playable - card.found} eggs left to clear it.`}</p></li>`
      : '';
  const icon = (kind, f) =>
    kind === 'line'
      ? `<span class="gain-ico gain-line" style="--ln:${LINE_VAR[f]}" aria-hidden="true">${f[0]}</span>`
      : kind === 'stamp'
        ? '<span class="gain-ico gain-stamp-ico" aria-hidden="true"><svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="16"/><path d="m13 20.5 5 5 9-10"/></svg></span>'
        : kind === 'rival'
          ? '<span class="gain-ico gain-rival" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg></span>'
          : '<span class="gain-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg></span>';
  box.innerHTML = sealHtml + gains.map(([k, html, f]) => `<li class="gain ${k === 'stamp' ? 'gain-stamp' : ''}">${icon(k, f)}<p>${html}</p></li>`).join('');
}

// ---------- hide an egg ----------
function viewHide() {
  const hide = state.pendingHide;
  const expired = hide?.findId && Date.parse(hide.expiresAt) < Date.now();
  if (!hide || expired) {
    state.pendingHide = null;
    store('egg-pending-hide', null);
    if (expired) toast('More than 30 minutes since your find, so that hide has run out.');
    location.hash = '#/';
    return;
  }
  const level = state.config.levels.find((l) => l.level === hide.level);
  let image = null;

  app.innerHTML = `
    <div class="play-bar">
      <a class="icon-btn" href="#/station/${encodeURIComponent(hide.stationId)}" aria-label="Back to ${esc(hide.stationName)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></a>
      <p class="play-title">Hide ${an(level.name)} <b>${esc(level.name)}</b> egg</p>
      <p class="mypts mypts-here"><b>${level.points}</b> pts</p>
    </div>
    <section class="tk hide-tk">
      <div class="tk-top">
        <div id="preview" class="egg-photo egg-photo-empty">
          <p class="photo-empty">Photograph something small in ${esc(hide.stationName)}. Easy should take a minute to find. Impossible should take real searching.</p>
        </div>
        <label class="btn btn-ghost btn-block" id="pick">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>
          <span id="pickText">Take the photo</span>
          <input id="cam" class="file-hidden" type="file" accept="image/*" capture="environment" />
        </label>
      </div>
      <div class="tk-perf" aria-hidden="true"></div>
      <div class="tk-bottom">
        <label class="field-label" for="hint">Hint <span class="opt">(optional, one line)</span></label>
        <input id="hint" class="input" maxlength="80" placeholder="e.g. near the stairs to outbound" />
      </div>
    </section>
    <ul class="rules">
      <li>Only things you can see from public areas. No tracks or staff-only spots.</li>
      <li>No other riders' faces.</li>
      <li>Photograph something that's already there. Don't put up stickers or objects.</li>
      <li>Stay behind the yellow line.</li>
    </ul>
    <button id="submit" class="btn btn-primary btn-block btn-l" type="button" disabled>Hide this egg</button>
    <div id="err"></div>`;

  $('#cam').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      image = await photoToJpeg(file);
      const pv = $('#preview');
      pv.classList.remove('egg-photo-empty');
      pv.innerHTML = `<img src="${image}" alt="Your egg photo" />`;
      $('#pickText').textContent = 'Retake photo';
      $('#submit').disabled = false;
    } catch (err) {
      $('#err').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
    }
  });

  $('#submit').addEventListener('click', async () => {
    const btn = $('#submit');
    btn.disabled = true;
    btn.textContent = 'Hiding';
    try {
      await api('/api/eggs', { stationId: hide.stationId, level: hide.level, findId: hide.findId, hint: $('#hint').value, image });
      if (hide.findId) dropHide(hide.findId);
      state.pendingHide = null;
      store('egg-pending-hide', null);
      state.stationsAt = 0; // egg counts changed
      toast('Egg hidden. Now someone else has to find it.');
      location.hash = `#/station/${encodeURIComponent(hide.stationId)}`;
    } catch (err) {
      if (err.status === 401) return;
      // Too late or already used: that hide is gone, so stop offering it.
      if (err.status === 409 && hide.findId) dropHide(hide.findId);
      $('#err').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
      btn.disabled = false;
      btn.textContent = 'Hide this egg';
    }
  });
}

// ---------- ranks ----------
async function viewLeaderboard() {
  const rid = renderId;
  loading();
  const stations = await getStations();
  if (rid !== renderId) return;
  let { mode } = state.board;
  let stationId = state.board.stationId || state.lastStationId || stations.find((s) => s.activeEggs)?.id || stations[0]?.id;
  const monthLabel = new Date().toLocaleString('en-US', { month: 'long', timeZone: 'America/New_York' });
  const nextMonth = new Date();
  nextMonth.setMonth(nextMonth.getMonth() + 1, 1);
  const resetLabel = nextMonth.toLocaleString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' });

  app.innerHTML = `
    <h1 class="page-h">${esc(monthLabel)}</h1>
    <p class="page-sub">Everything resets on ${esc(resetLabel)}. Tap a player to see their tickets.</p>
    <div id="versus"></div>
    <div id="war"></div>
    <div class="seg" role="tablist" aria-label="Players">
      <button type="button" role="tab" data-mode="all" aria-selected="${mode === 'all'}">Everyone</button>
      <button type="button" role="tab" data-mode="station" aria-selected="${mode === 'station'}">One station</button>
    </div>
    <div id="stationPick" ${mode === 'station' ? '' : 'hidden'}>
      <select id="sel" class="input" aria-label="Station">${[...stations]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => `<option value="${esc(s.id)}" ${s.id === stationId ? 'selected' : ''}>${esc(s.name)}</option>`)
        .join('')}</select>
    </div>
    <div id="board"></div>`;

  const draw = async () => {
    const box = $('#board');
    box.innerHTML = '<div class="empty"><div class="spin" aria-hidden="true"></div></div>';
    const q = mode === 'station' ? `?stationId=${encodeURIComponent(stationId)}` : '';
    const data = await api(`/api/leaderboard${q}`);
    if (!box.isConnected) return;
    if (mode !== 'all') {
      // The rival and the line war are about everyone; don't show them over one station's list.
      $('#war').innerHTML = '';
      $('#versus').innerHTML = '';
    } else {
      $('#war').innerHTML = data.lines.length ? lineWar(data.lines) : '';
      const mine = data.rows.find((r) => r.userId === state.user.id);
      const rival = mine && data.rows.find((r) => r.rank === mine.rank - 1);
      $('#versus').innerHTML = mine && rival
        ? `<section class="tk versus" aria-label="You and the player just above you">
            <div class="vs-side"><p class="vs-name">You</p><p class="vs-sc">${mine.points}</p><p class="vs-rk">${ordinal(mine.rank)}</p></div>
            <div class="vs-mid"><p class="vs-gap">${rival.points - mine.points + 1}</p><p class="vs-gap-l">to pass</p></div>
            <div class="vs-side vs-them"><p class="vs-name">${esc(rival.username)}</p><p class="vs-sc">${rival.points}</p><p class="vs-rk">${ordinal(rival.rank)}</p></div>
            <div class="vs-bar" aria-hidden="true"><span style="--p:${Math.round((mine.points / Math.max(1, rival.points)) * 100)}%"></span></div>
          </section>`
        : mine?.rank === 1
          ? `<section class="tk versus versus-top"><p class="vs-top"><b>You're 1st this month</b> with ${mine.points} points.</p></section>`
          : '';
    }
    if (!data.rows.length) {
      box.innerHTML = '<div class="empty"><p>No finds yet. The first one puts you at the top.</p></div>';
      return;
    }
    const href = (r) => (r.userId === state.user.id ? '#/profile' : `#/user/${encodeURIComponent(r.userId)}`);
    const top = data.rows.slice(0, 3);
    const podium = top.length === 3
      ? `<ol class="podium" aria-label="Top three">${[top[1], top[0], top[2]]
          .map((r) => `<li class="pod pod-${r.rank} ${r.userId === state.user.id ? 'is-me' : ''}"><a href="${href(r)}"><span class="pod-name">${esc(r.username)}</span><span class="pod-sc">${r.points}</span><span class="pod-rk">${r.rank}</span></a></li>`)
          .join('')}</ol>`
      : '';
    const rest = top.length === 3 ? data.rows.slice(3) : data.rows;
    box.innerHTML = `${podium}<ol class="ranks">${rest
      .map(
        (r) => `<li class="${r.userId === state.user.id ? 'is-me' : ''}"><a href="${href(r)}"><span class="rk">${r.rank}</span><span class="who"><b>${r.userId === state.user.id ? 'You' : esc(r.username)}</b><small>${plural(r.finds, 'find')}</small></span><span class="sc">${r.points}</span></a></li>`,
      )
      .join('')}</ol>`;
  };

  app.querySelectorAll('.seg button').forEach((b) =>
    b.addEventListener('click', () => {
      mode = state.board.mode = b.dataset.mode;
      app.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      $('#stationPick').hidden = mode !== 'station';
      draw();
    }),
  );
  $('#sel').addEventListener('change', (e) => {
    stationId = state.board.stationId = e.target.value;
    draw();
  });
  await draw();
}

// ---------- tickets (your profile) ----------
function ticketsGrid(finds) {
  return finds.length
    ? `<ul class="book">${finds
        .map((f) => {
          const st = state.stations?.find((s) => s.name === f.stationName);
          const fam = st ? familiesOf(st.lines)[0] : null;
          return `<li class="mini" style="--ln:${LINE_VAR[fam] ?? 'var(--ink)'}">
            <p class="mini-band ${fam === 'Orange' ? 'mini-band-dark' : ''}">${esc(f.stationName)}</p>
            <div class="mini-pic"><img src="${apiUrl(f.photoUrl)}" alt="Find at ${esc(f.stationName)}" loading="lazy" /></div>
            <p class="mini-lv">${esc(f.levelName)} <b>+${f.points}</b></p>
            <span class="hole hole-s" aria-hidden="true"></span>
          </li>`;
        })
        .join('')}</ul>`
    : '<div class="empty"><p>No punched tickets yet. Find an egg and it lands here.</p></div>';
}

function deviceList(sessions) {
  if (!sessions) return `<div class="notice">Couldn't load your devices right now.</div>`;
  const thisYear = new Date().getFullYear();
  const fmtDay = (iso) => {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() !== thisYear && { year: 'numeric' }) });
  };
  return `<ul class="devices">${sessions
    .map(
      (s) => `<li><b>${esc(describeDevice(s.device))}</b>${s.current ? ' <span class="tag">This device</span>' : ''}<small>${s.current ? 'Active now' : `Active ${fmtLastSeen(s.lastSeenAt)}`}, signed in ${fmtDay(s.createdAt)}</small></li>`,
    )
    .join('')}</ul>`;
}

// Finds per level, Easy to Impossible.
const levelFinds = (p) =>
  `<ol class="lv-finds" aria-label="Finds by level">${(state.config?.levels ?? [])
    .map((l) => `<li><b>${p.findsByLevel?.[l.name] ?? 0}</b><span>${esc(l.name)}</span></li>`)
    .join('')}</ol>`;

async function viewProfile() {
  const rid = renderId;
  loading();
  const [p, progress, sessions] = await Promise.all([
    api(`/api/users/${state.user.id}`),
    refreshProgress(),
    api('/api/auth/sessions').then((d) => d.sessions, () => null),
    getStations(),
  ]);
  if (rid !== renderId) return;
  const lv = progress?.level;
  const xp = lv?.next ? Math.round(((lv.points - lv.floor) / (lv.next - lv.floor)) * 100) : 100;
  const earned = progress?.stamps.filter((s) => s.earned).length ?? 0;

  app.innerHTML = `
    <section class="tk level-tk">
      <div class="tk-top level-top">
        <div>
          <h1 class="page-h">${esc(p.user.username)}</h1>
          <p class="page-sub">${p.monthRank ? `${ordinal(p.monthRank)} this month. ` : ''}${lv ? `Rider level ${lv.level}${lv.next ? `, ${lv.next - lv.points} pts to level ${lv.level + 1}.` : '.'}` : ''}</p>
        </div>
        ${lv ? `<span class="level-badge" aria-hidden="true">${lv.level}</span>` : ''}
      </div>
      <div class="tk-perf" aria-hidden="true"></div>
      <div class="tk-bottom">
        <div class="xp" aria-hidden="true"><span style="--p:${xp}%"></span></div>
        <dl class="mini-stats">
          <div><dt>This month</dt><dd>${p.monthPoints}</dd></div>
          <div><dt>All time</dt><dd>${p.allTimePoints}</dd></div>
          <div><dt>Eggs hidden</dt><dd>${p.eggsHidden}</dd></div>
          <div><dt>Found by others</dt><dd>${p.timesYourEggsWereFound}</dd></div>
        </dl>
        ${levelFinds(p)}
      </div>
    </section>
    ${challengeTicket(progress?.today)}
    ${progress ? `
    <div class="eggs-head"><h2 class="sec-h">Lines punched</h2><p class="eggs-count">${progress.lines.filter((l) => l.stations).length} of 4</p></div>
    <ol class="line-badges">${progress.lines
      .map((l) => `<li class="lb ${l.stations ? 'is-got' : ''}" style="--ln:${LINE_VAR[l.line]}"><span class="lb-dot">${l.line[0]}</span><span class="lb-n">${l.stations ? plural(l.stations, 'station') : 'Not yet'}</span></li>`)
      .join('')}</ol>
    <div class="eggs-head"><h2 class="sec-h">Stamps</h2><p class="eggs-count">${earned} of ${progress.stamps.length}</p></div>
    <ul class="stamps">${progress.stamps
      .map((s) => `<li class="st ${s.earned ? 'is-got' : ''}"><span class="st-seal">${esc(s.name)}</span><p>${s.earned || s.target === 1 ? esc(s.description) : `${esc(s.description)} ${s.progress} of ${s.target}.`}</p></li>`)
      .join('')}${progress.stations
      .map((s) => `<li class="st is-got"><span class="st-seal st-station" style="--ln:${LINE_VAR[s.lines[0]] ?? 'var(--stamp)'}">${esc(s.name)}</span><p>${plural(s.finds, 'find')} here</p></li>`)
      .join('')}</ul>` : ''}
    <div class="eggs-head"><h2 class="sec-h">Punched tickets</h2><p class="eggs-count">${plural(p.recentFinds.length, 'recent find')}</p></div>
    ${ticketsGrid(p.recentFinds)}
    <h2 class="sec-h">Signed-in devices</h2>
    ${deviceList(sessions)}
    <div class="account">
      <button id="out" class="btn btn-ghost" type="button">Sign out</button>
      <button id="outAll" class="link" type="button">Sign out on all devices</button>
    </div>`;
  $('#out').addEventListener('click', () => signOut({ remote: true }));
  $('#outAll').addEventListener('click', () => {
    if (confirm('Sign out on every phone and computer using this account?')) signOut({ remote: true, everywhere: true });
  });
}

// Another player's public profile, opened from the ranks.
async function viewPlayer(id) {
  if (id === state.user.id) return location.replace('#/profile');
  const rid = renderId;
  loading();
  const [p] = await Promise.all([api(`/api/users/${encodeURIComponent(id)}`), getStations()]);
  if (rid !== renderId) return;
  app.innerHTML = `
    <a class="back" href="#/leaderboard"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>Ranks</a>
    <section class="tk level-tk">
      <div class="tk-top"><h1 class="page-h">${esc(p.user.username)}</h1><p class="page-sub">${p.monthRank ? `${ordinal(p.monthRank)} this month` : 'Not on the board yet this month'}</p></div>
      <div class="tk-perf" aria-hidden="true"></div>
      <div class="tk-bottom">
        <dl class="mini-stats">
          <div><dt>This month</dt><dd>${p.monthPoints}</dd></div>
          <div><dt>All time</dt><dd>${p.allTimePoints}</dd></div>
          <div><dt>Eggs hidden</dt><dd>${p.eggsHidden}</dd></div>
          <div><dt>Found by others</dt><dd>${p.timesYourEggsWereFound}</dd></div>
        </dl>
        ${levelFinds(p)}
      </div>
    </section>
    <div class="eggs-head"><h2 class="sec-h">Punched tickets</h2></div>
    ${ticketsGrid(p.recentFinds)}`;
}

// ---------- map ----------
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
    document.head.append(css);
    const js = document.createElement('script');
    js.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
    js.onload = resolve;
    js.onerror = () => reject(new Error("Couldn't load the map. Check the internet connection."));
    document.head.append(js);
  });
}

async function viewMap() {
  const rid = renderId;
  loading('Loading the map');
  const [stations] = await Promise.all([getStations(), loadLeaflet()]);
  if (rid !== renderId) return;
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue('--ink').trim();
  const ticket = css.getPropertyValue('--ticket').trim();
  const muted = css.getPropertyValue('--muted').trim();
  app.innerHTML = `
    <h1 class="page-h">Map</h1>
    <p class="page-sub">Bigger dots have more eggs hidden. Tap a station to open it.</p>
    <div id="map" class="map"></div>`;
  const map = L.map('map', { zoomControl: true }).setView(loc.pos ? [loc.pos.lat, loc.pos.lng] : [42.3555, -71.0805], loc.pos ? 14 : 12);
  state.map = map;
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  for (const s of stations) {
    L.circleMarker([s.lat, s.lng], {
      radius: 5 + s.activeEggs * 1.6,
      color: ticket,
      weight: 2,
      fillColor: s.lines[0]?.color ?? muted,
      fillOpacity: s.activeEggs ? 1 : 0.55,
    })
      .addTo(map)
      .bindPopup(`<strong>${esc(s.name)}</strong><br/>${s.activeEggs} of 5 eggs hidden<br/><a href="#/station/${encodeURIComponent(s.id)}">Open station</a>`);
  }
  if (loc.pos) {
    L.circle([loc.pos.lat, loc.pos.lng], { radius: RANGE_METERS, color: ink, weight: 1, fillOpacity: 0.06 }).addTo(map);
    L.circleMarker([loc.pos.lat, loc.pos.lng], { radius: 7, color: ticket, weight: 3, fillColor: ink, fillOpacity: 1 }).addTo(map).bindPopup('You are here');
  }
}

// ---------- coming back to the app ----------
// Phones put a backgrounded tab to sleep, or throw it away and reload it later. Either way,
// pick up the real state: the round's clock, finds to hide for, and (after a while away,
// like a train ride) a fresh location instead of the last station's.
async function onResume() {
  const away = hiddenAt ? Date.now() - hiddenAt : 0;
  const since = hiddenAt;
  hiddenAt = null;
  if (!booted || !state.user) return;
  const hash = location.hash || '#/';
  // Never redraw these on return: a photo (from the camera app) or a hint may be in progress.
  const busy = hash.startsWith('#/play') || hash.startsWith('#/hide');
  if (hash.startsWith('#/play') && liveRound()) keepAwake(true);
  if (away > AWAY_MS) {
    state.stationsAt = 0;
    state.progressAt = 0;
    state.hud = null;
    freshLocation(since); // on Here, this redraws by itself as the new fix comes in
  }
  const before = JSON.stringify([state.play?.attempt.id ?? null, openHides().map((h) => h.findId)]);
  await syncActive();
  const changed = JSON.stringify([state.play?.attempt.id ?? null, openHides().map((h) => h.findId)]) !== before;
  if (busy) {
    if (hash.startsWith('#/play') && !state.play) render(); // the round ended elsewhere
    return;
  }
  if (changed || (away > AWAY_MS && !(hash === '#/' || hash === '#'))) render();
  else drawHud();
}
document.addEventListener('visibilitychange', () => (document.hidden ? markAway() : onResume()));
window.addEventListener('pagehide', markAway);
window.addEventListener('pageshow', (e) => e.persisted && onResume());

// No signal: say so, and catch up as soon as it's back.
function drawNet() {
  $('#net').hidden = navigator.onLine !== false;
}
window.addEventListener('offline', drawNet);
window.addEventListener('online', () => {
  drawNet();
  if (!booted || !state.user) return;
  syncActive().then(() => (app.querySelector('[data-load-failed="true"]') ? render() : drawHud()));
});

// One clock for everything outside the play screen: the "Round running" call and Resume
// buttons count down, and a round that ran out while you were elsewhere is cleared.
setInterval(() => {
  const live = liveRound();
  document.querySelectorAll('[data-live-clock]').forEach((el) => {
    if (live) el.textContent = fmtClock(secondsLeftOf(live));
  });
  if (state.play && !state.play.result && !live && !(location.hash || '').startsWith('#/play')) {
    endPlay();
    drawHud();
  }
}, 1000);

// "Hide the next egg" calls can be on any station screen.
app.addEventListener('click', (e) => {
  const go = e.target.closest('[data-hide-find]');
  const skip = e.target.closest('[data-skip-find]');
  if (go) {
    const h = state.hides.find((x) => x.findId === go.dataset.hideFind);
    if (h) startHide(h);
  } else if (skip) {
    skipHide(skip.dataset.skipFind);
    skip.closest('.hide-call')?.remove();
  }
});

// Opening the app with no signal (underground) waits for signal instead of a dead end.
function waitForServer() {
  app.innerHTML = `<div class="notice bad">Can't reach the game server. No signal down here? Lookout connects by itself once you have signal.</div>
    <p><button id="retryBoot" class="btn btn-ink btn-block" type="button">Try again</button></p>`;
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener('online', done);
      resolve();
    };
    const timer = setTimeout(done, 8000);
    window.addEventListener('online', done);
    $('#retryBoot').addEventListener('click', done);
  });
}

// ---------- boot ----------
(async function boot() {
  setLine(state.line);
  drawNet();
  while (!state.config) {
    try {
      state.config = await api('/api/config', null, { timeout: 10_000 });
    } catch {
      await waitForServer();
    }
  }
  // Make sure this device's session is still valid (it may have been signed out elsewhere).
  // A 401 signs out inside api(); with no signal, keep the session and carry on.
  if (state.token) {
    try {
      const { user } = await api('/api/auth/me');
      setSession({ user, token: state.token });
    } catch {
      /* see above */
    }
  }
  if (state.user) {
    // Reopened soon after using it somewhere else (off a train, say): fixes from before that
    // belong to the last station, so wait for a fresh one and offer the last station as a guess.
    const away = readStored('egg-away-at');
    if (away?.at && Date.now() - away.at < 30 * 60_000) {
      loc.minFixAt = away.at;
      loc.prev = away.pos ?? null;
      loc.lastHereId = away.hereId ?? null;
    }
    startLocation();
    await syncActive();
    // Closed the app mid-round: go straight back to the clock.
    if (liveRound() && !/^#\/(play|hide)/.test(location.hash)) history.replaceState(null, '', '#/play');
  }
  window.addEventListener('hashchange', render);
  booted = true;
  render();
})();
