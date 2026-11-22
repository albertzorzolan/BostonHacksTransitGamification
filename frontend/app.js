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

const API_BASE = String(window.EGG_API_BASE ?? '').replace(/\/$/, '');
const apiUrl = (path) => API_BASE + path;

// session = { user, token } from register/login. Each device gets its own token.
const session = readStored('egg-session');
const state = {
  user: session?.user ?? null,
  token: session?.token ?? null,
  config: null,
  stations: null,
  lastStationId: readStored('egg-last-station'),
  raceTrain: readStored('egg-race-train') ?? false,
  line: readStored('egg-line'), // colour family the app is wearing: Red | Orange | Blue | Green | null
  play: null, // current round
  pendingHide: null, // { stationId, stationName, level, findId }
  board: { mode: 'all', stationId: null },
  hud: null, // { rank, points, rival, gap, rows, lines, at }
  progress: null, // /api/me/progress
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

async function api(path, body) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  let res;
  try {
    res = await fetch(apiUrl(path), { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error("Can't reach the game server. Check your connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
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

// Downscale photos on the phone before upload (faster, and enough for matching).
async function photoToJpeg(file, max = 1280) {
  let source;
  try {
    source = await createImageBitmap(file);
  } catch {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Couldn't read that photo. Try again."));
      img.src = URL.createObjectURL(file);
    });
  }
  const scale = Math.min(1, max / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

async function getStations() {
  if (!state.stations) state.stations = (await api('/api/stations')).stations;
  return state.stations;
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
const loc = { status: 'idle', pos: null, watchId: null, subs: new Set() };

function startLocation() {
  if (!window.isSecureContext || !navigator.geolocation) {
    loc.status = 'insecure';
    return notifyLoc();
  }
  if (loc.watchId != null) return;
  if (!loc.pos) loc.status = 'locating';
  notifyLoc();
  loc.watchId = navigator.geolocation.watchPosition(
    (p) => {
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
const isInRange = (n) => Boolean(n && n.m <= RANGE_METERS + Math.min(loc.pos?.accuracy ?? 0, ACCURACY_CAP));

// ---------- alerts ----------
// Two kinds, both shown as a toast, and as a phone/desktop notification when the player allowed it:
//  - someone found one of your eggs (polled from /api/me/notifications?summary=1)
//  - GPS puts you at a station: how many eggs are waiting for you there today
const ALERT_POLL_MS = 30_000;
const ARRIVAL_COOLDOWN_MS = 30 * 60_000; // per station, so walking around a platform doesn't repeat it
const canNotify = () => 'Notification' in window && Notification.permission === 'granted';

// Alerts queue up so two at once (say, arriving at a station just as your egg is found)
// don't overwrite each other.
const alertQueue = [];
function showNextAlert() {
  if (showNextAlert.busy || !alertQueue.length) return;
  showNextAlert.busy = true;
  toast(alertQueue.shift(), 5000);
  setTimeout(() => {
    showNextAlert.busy = false;
    showNextAlert();
  }, 5200);
}
function notifyPlayer(title, body, href) {
  alertQueue.push(`${title} ${body}`);
  showNextAlert();
  if (!canNotify()) return;
  try {
    const n = new Notification(title, { body, icon: 'icon.svg', tag: href });
    n.onclick = () => {
      window.focus();
      location.hash = href;
      n.close();
    };
  } catch {
    /* some mobile browsers only allow notifications from a service worker: the toast is enough */
  }
}

async function checkNotifications() {
  if (!state.user || document.visibilityState === 'hidden' && !canNotify()) return;
  try {
    const { unseen, latest } = await api('/api/me/notifications?summary=1');
    state.unseen = unseen;
    drawBell();
    // Alert once per find: remember the newest one already announced.
    const key = `egg-told:${state.user.id}`;
    const told = readStored(key) ?? 0;
    const fresh = latest.filter((n) => Date.parse(n.at) > told);
    if (fresh.length) {
      const n = fresh[0];
      const more = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : '';
      notifyPlayer('Your egg was found!', `${n.by} found your ${n.levelName} egg at ${n.stationName}.${more}`, '#/notifications');
    }
    if (latest.length) store(key, Math.max(told, ...latest.map((n) => Date.parse(n.at))));
  } catch {
    /* extra: try again next time */
  }
}

async function checkArrival() {
  if (!state.user || loc.status !== 'ok') return;
  const stations = state.stations ?? (await getStations().catch(() => null));
  const near = stations && nearestStation(stations);
  if (!isInRange(near)) {
    state.arrivedAt = null; // left the station: arriving again later can alert again
    return;
  }
  const st = near.station;
  if (state.arrivedAt === st.id) return;
  state.arrivedAt = st.id;
  const seen = readStored('egg-arrivals') ?? {};
  if (Date.now() - (seen[st.id] ?? 0) < ARRIVAL_COOLDOWN_MS) return;
  store('egg-arrivals', { ...seen, [st.id]: Date.now() });
  let fresh;
  try {
    fresh = (await api('/api/stations')).stations;
    state.stations = fresh;
  } catch {
    return;
  }
  const s = fresh.find((x) => x.id === st.id) ?? st;
  const left = s.playable ?? 0;
  const href = `#/station/${encodeURIComponent(s.id)}`;
  if (left) notifyPlayer(`You're at ${s.name}.`, `Find your eggs today: ${plural(left, 'egg')} waiting for you here.`, href);
  else if (s.activeEggs) notifyPlayer(`You're at ${s.name}.`, "You've cleared every egg here today. Hide a new one!", href);
  else notifyPlayer(`You're at ${s.name}.`, 'No eggs here yet. Hide the first one today!', href);
}

function startAlerts() {
  if (state.alerting) return;
  state.alerting = true;
  loc.subs.add(checkArrival); // stays on for the whole visit, not just one page
  setInterval(checkNotifications, ALERT_POLL_MS);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && checkNotifications());
  checkNotifications();
}

function drawBell() {
  const b = $('#bell');
  if (!b) return;
  const n = state.unseen ?? 0;
  b.querySelector('.bell-n')?.remove();
  if (n) b.insertAdjacentHTML('beforeend', `<span class="bell-n">${n > 9 ? '9+' : n}</span>`);
  b.setAttribute('aria-label', n ? `Notifications, ${n} new` : 'Notifications');
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
  el.innerHTML = `
    <div class="hud-top">
      <a href="#/" class="brand"><img src="icon.svg" alt="" width="28" height="28" />Lookout</a>
      <div class="hud-right">
        <a id="bell" class="bell" href="#/notifications" aria-label="Notifications"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></svg></a>
        <a class="mypts" href="#/leaderboard">${chip}<b>${h?.points ?? 0}</b> pts</a>
      </div>
    </div>
    <a class="rival" href="#/leaderboard">${rival}</a>`;
  drawBell();
}

async function refreshProgress() {
  try {
    state.progress = await api('/api/me/progress');
  } catch {
    /* extra */
  }
  return state.progress;
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
  [/^#\/notifications$/, viewNotifications],
  [/^#\/user\/([^/]+)$/, viewPlayer],
  [/^#\/map$/, viewMap],
  [/^#\/groups$/, viewGroups],
  [/^#\/group\/([^/]+)$/, viewGroup],
  [/^#\/join\/([^/]+)$/, viewJoin],
];

async function render() {
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
  const playing = hash.startsWith('#/play') || hash.startsWith('#/hide');
  $('#hud').classList.toggle('hud-quiet', playing);
  $('#tabs').hidden = playing;
  const tab = hash.startsWith('#/map')
    ? 'map'
    : hash.startsWith('#/leaderboard') || hash.startsWith('#/user/')
      ? 'leaderboard'
      : hash.startsWith('#/profile') || hash.startsWith('#/notifications')
        ? 'profile'
        : /^#\/(groups|group\/|join\/)/.test(hash)
          ? 'groups'
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
      if (err.status === 401) return signOut();
      app.innerHTML = `<div class="notice bad">${esc(err.message)}</div><p><a class="btn btn-ghost" href="#/">Back</a></p>`;
    }
    return;
  }
  location.hash = '#/';
}

function setSession(data) {
  state.user = data?.user ?? null;
  state.token = data?.token ?? null;
  store('egg-session', data ? { user: data.user, token: data.token } : null);
  if (state.user) startAlerts();
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
        ${registering ? '<p class="field-hint">Shown on leaderboards. Group chats use a separate anonymous name.</p>' : ''}
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
      if (registering && data.user.chatName) toast(`In group chats you're "${data.user.chatName}". Change it in Profile.`, 4200);
      if (location.hash && location.hash !== '#/' && !location.hash.startsWith('#/join/')) location.hash = '#/';
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
  loading('Finding your station');
  const stations = await getStations();
  let lastKey = null;
  const keyNow = () => {
    const n = nearestStation(stations);
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
  if (isInRange(n)) return showStation(n.station.id, { here: true, distance: n.m });
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
    unavailable: ['No location fix yet', 'Step closer to the entrance or above ground, then try again. Or pick your station below.'],
    insecure: ['Pick your station', 'Phones only share location with https:// pages. Open the https link to detect your station automatically.'],
  }[loc.status] ?? ['Pick your station', ''];
  const canRetry = loc.status === 'denied' || loc.status === 'unavailable';
  app.innerHTML = `
    <section class="tk locate">
      ${BAND_LINES}
      <div class="tk-top">
        ${loc.status === 'locating' ? '<div class="spin" aria-hidden="true"></div>' : ''}
        <h1 class="locate-h">${esc(msg[0])}</h1>
        <p class="locate-p">${esc(msg[1])}</p>
        ${canRetry ? '<button id="retry" class="btn btn-ink btn-block" type="button">Try again</button>' : ''}
      </div>
    </section>
    <h2 class="sec-h">Stations</h2>
    ${stationSearch()}`;
  $('#retry')?.addEventListener('click', retryLocation);
  wireStationSearch(stations);
}

function showNearby(stations, n) {
  app.innerHTML = `
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
    rows = loc.pos
      ? rows.map((s) => ({ ...s, m: distanceM(loc.pos, s) })).sort((a, b) => a.m - b.m)
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
  loading();
  const stations = await getStations();
  app.innerHTML = `<h1 class="page-h">Stations</h1><p class="page-sub">Any station on the T. Play opens wherever you are.</p>${stationSearch()}`;
  wireStationSearch(stations);
}

// ---------- one station ----------
async function viewStation(id) {
  loading();
  const stations = await getStations();
  const n = nearestStation(stations);
  const here = isInRange(n) && n.station.id === id;
  const st = stations.find((s) => s.id === id);
  await showStation(id, { here, distance: st && loc.pos ? distanceM(loc.pos, st) : null });
}

// Which eggs here you can still score, and how many you've found.
function stationCard(slots) {
  const playable = slots.filter((s) => s.egg && !s.egg.mine);
  const found = playable.filter((s) => s.egg.foundByMe).length;
  return { playable: playable.length, found, cleared: playable.length > 0 && found === playable.length };
}

async function showStation(id, { here = false, distance = null } = {}) {
  const [{ station, slots }] = await Promise.all([
    api(`/api/stations/${encodeURIComponent(id)}`),
    state.progress ? null : refreshProgress(),
  ]);
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
    <section class="tk station-tk">
      ${lineBand(station)}
      <div class="tk-top">
        <p class="here">${here ? "You're at" : 'Station'}</p>
        ${stationHead(station.name)}
        ${stamp}
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
      btn.setAttribute('aria-disabled', 'true');
      const slot = slots.find((s) => s.egg?.id === btn.dataset.play);
      const before = { hud: state.hud, progress: state.progress, card };
      try {
        const round = await api('/api/attempts', { eggId: btn.dataset.play, mode: state.raceTrain ? 'train' : 'fixed' });
        state.play = { ...round, station, receivedAt: performance.now(), result: null, firstChance: slot?.egg?.timesFound === 0, before };
        if (round.attempt.resumed) toast(`Your clock kept running: ${fmtClock(round.attempt.secondsLeft)} left.`);
        location.hash = '#/play';
      } catch (err) {
        toast(err.message);
        btn.removeAttribute('aria-disabled');
      }
    }),
  );
  app.querySelectorAll('[data-hide]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.pendingHide = { stationId: id, stationName: station.name, level: Number(btn.dataset.hide), findId: null };
      location.hash = '#/hide';
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

  // Running clocks on this page keep counting down; when one hits zero, reload to show the lock.
  const running = [...app.querySelectorAll('[data-ends]')];
  if (running.length) {
    every(1000, () => {
      for (const el of running) {
        const left = (Number(el.dataset.ends) - Date.now()) / 1000;
        el.textContent = fmtClock(left);
        if (left < -(state.config?.graceSeconds ?? 15)) return render();
      }
    });
  }
}

function stubRow(slot) {
  const { egg } = slot;
  const pips = `<span class="pips" aria-label="Difficulty ${slot.level} of 5">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= slot.level ? 'on' : ''}"></i>`).join('')}</span>`;
  const mins = `${Math.round(slot.seconds / 60)} min${slot.blur ? (slot.blur >= 12 ? ', very blurry photo' : ', blurred photo') : ''}`;
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
  const hot = egg.timesFound === 0;
  const bounty = egg.bounty ? `Bounty +${egg.bounty}, beat ${plural(egg.beaten, 'player')}. ` : '';
  // A running clock keeps ticking here too: leaving the round doesn't pause it.
  const meta = egg.clock
    ? `Your clock is running: <span data-ends="${Date.now() + egg.clock.secondsLeft * 1000}">${fmtClock(egg.clock.secondsLeft)}</span> left.`
    : egg.retry
      ? `${bounty}It beat you last time. A retry earns no time bonus.`
      : `${bounty}${hot ? `${mins}. Nobody's found it yet.` : `${mins}, found ${plural(egg.timesFound, 'time')}`}`;
  return `<li class="stub is-open ${hot || egg.bounty || egg.clock ? 'is-hot' : ''}">
    <span class="punch" aria-hidden="true">${slot.level}</span>
    <div class="stub-body"><p class="stub-name">${esc(slot.name)}</p>${pips}<p class="stub-meta">${meta}</p></div>
    <button class="stub-act" type="button" data-play="${egg.id}"><b>${slot.points + (egg.bounty ?? 0)}</b><span>${egg.clock ? 'Resume' : egg.retry ? 'Retry' : 'Play'}</span></button>
  </li>`;
}

function challengeTicket(today) {
  if (!today) return '';
  const steps = today.id === 'transfer'
    ? MAIN_LINES.filter((l) => today.lines?.includes(l)).map((l) => `<li class="done" style="--ln:${LINE_VAR[l]}">${l[0]}</li>`).join('') +
      Array.from({ length: Math.max(0, today.target - (today.lines?.length ?? 0)) }, () => '<li></li>').join('')
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
  const secondsLeft = () => attempt.secondsLeft - (performance.now() - play.receivedAt) / 1000;
  const graceLeft = () => secondsLeft() + (state.config?.graceSeconds ?? 15);
  const maxBonus = state.config?.maxTimeBonus ?? 0.5;
  const perHole = attempt.limitSeconds / PUNCH_HOLES;
  const tag = [play.firstChance && 'Nobody has found this yet', egg.bounty && `Bounty +${egg.bounty}: beat ${plural(egg.beaten, 'player')}`]
    .filter(Boolean)
    .join(' · ');

  app.innerHTML = `
    <div class="play-bar">
      <a class="icon-btn" href="#/station/${encodeURIComponent(egg.stationId)}" id="quitX" aria-label="Leave for now. Your clock keeps running."><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></a>
      <p class="play-title"><b>${esc(egg.levelName)}</b> at ${esc(egg.stationName)}</p>
      <p class="mypts mypts-here"><b>${egg.points + (egg.bounty ?? 0)}</b> pts</p>
    </div>
    <section class="tk play-tk">
      <div class="tk-top">
        <div class="egg-photo">
          <img src="${apiUrl(egg.imageUrl)}" alt="The egg to find: a photo of something in this station" />
          ${tag ? `<p class="first-tag">${esc(tag)}</p>` : ''}
          ${egg.blur ? `<p class="blur-tag">${egg.blur === 'heavy' ? 'Heavily blurred' : 'Blurred'}: ${esc(egg.levelName)}</p>` : ''}
        </div>
        ${egg.hint ? `<p class="hint"><b>Hint</b> ${esc(egg.hint)}</p>` : ''}
      </div>
      <div class="tk-perf" aria-hidden="true"></div>
      <div class="tk-bottom">
        <div class="clock-row">
          <p id="clock" class="clock">${fmtClock(secondsLeft())}</p>
          <div class="bonus"><p class="bonus-label">${attempt.retry ? 'Retry: no bonus' : 'Bonus right now'}</p><p class="bonus-val">+<span id="bonus">0</span></p></div>
        </div>
        <ol id="holes" class="punchclock" aria-hidden="true">${'<li></li>'.repeat(PUNCH_HOLES)}</ol>
        <p class="clock-ctx">${attempt.limitSource === 'train' ? `Racing the ${esc(attempt.train?.headsign || 'next')} train. ` : ''}${attempt.retry ? "This is a retry, so there's no time bonus. " : `Each hole is ${Math.round(perHole)} seconds. The bonus drains as they go. `}Leaving doesn't stop your clock.</p>
      </div>
    </section>
    <div id="status"></div>
    <label class="btn btn-ink btn-block btn-l" id="snap">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>
      Found it, take a photo
      <input id="cam" class="file-hidden" type="file" accept="image/*" capture="environment" />
    </label>
    <div class="play-foot">
      <span class="report">Report: ${REPORT_REASONS.map(([k, label]) => `<button class="link" type="button" data-report="${k}">${label}</button>`).join('')}</span>
      <button class="link" type="button" id="quit">Give up</button>
    </div>`;

  const holes = [...app.querySelectorAll('#holes li')];
  const tick = () => {
    const s = secondsLeft();
    const clock = $('#clock');
    if (!clock) return;
    clock.textContent = fmtClock(s);
    clock.classList.toggle('is-low', s <= 20);
    $('#bonus').textContent = attempt.retry ? 0 : Math.round(egg.points * maxBonus * Math.max(0, Math.min(1, s / attempt.limitSeconds)));
    const punched = Math.floor((attempt.limitSeconds - Math.max(0, s)) / perHole);
    holes.forEach((h, i) => h.classList.toggle('p', i < punched));
    if (graceLeft() <= 0) {
      play.result = { status: 'expired' };
      renderResult();
    }
  };
  tick();
  every(250, tick);

  $('#cam').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const status = $('#status');
    $('#snap').hidden = true;
    status.innerHTML = `<div class="notice row"><div class="spin" aria-hidden="true"></div>${state.config?.gemini ? 'Checking it is the same object as the egg' : 'Saving your find'}</div>`;
    try {
      const image = await photoToJpeg(file);
      const result = await api(`/api/attempts/${attempt.id}/find`, { image });
      if (result.status === 'no_match') {
        status.innerHTML = result.unavailable
          ? `<div class="notice bad"><b>Photo check failed.</b> ${esc(result.reason)} Your timer is still running.</div>`
          : `<div class="notice bad"><b>Failed: not the same object.</b> ${esc(result.reason)} Keep looking.</div>`;
        $('#snap').hidden = false;
        e.target.value = '';
        return;
      }
      play.result = result;
      play.myPhoto = image;
      renderResult();
    } catch (err) {
      status.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
      $('#snap').hidden = false;
      e.target.value = '';
    }
  });

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
  // Giving up ends the round now (and locks the egg); the X just leaves, with the clock still running.
  $('#quit').addEventListener('click', () => {
    if (!confirm('Give up on this egg? You can retry, but a retry earns no time bonus.')) return;
    play.result = { status: 'given_up' };
    renderResult();
  });
  $('#quitX').addEventListener('click', () => (state.play = null));
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

  if (result.status === 'expired' || result.status === 'given_up') {
    const gaveUp = result.status === 'given_up';
    app.innerHTML = `
      <section class="tk win">
        ${play.station ? lineBand(play.station, esc(egg.levelName)) : ''}
        <div class="tk-top">
          <h1 class="win-head">${gaveUp ? 'You gave up' : "Time's up"}</h1>
          <p class="win-sub">The ${esc(egg.levelName)} egg at ${esc(egg.stationName)} beat you.${gaveUp ? '' : ' Every hole is punched.'} You can retry it, but a retry earns no time bonus.</p>
          <p class="win-sub" id="bountyNote"></p>
        </div>
      </section>
      <a class="btn btn-ink btn-block btn-l" href="${back}">Try another level</a>`;
    state.play = null;
    // Tell the server the round is over: it locks the egg for you and counts your miss toward the
    // bounty. If this fails, the round still runs out on its own a moment later.
    try {
      const end = await api(`/api/attempts/${play.attempt.id}/end`, {});
      const note = $('#bountyNote');
      if (note && end.counted) {
        note.innerHTML = `<b>You added to its bounty.</b> Whoever finds it now gets +${end.bounty}, and its hider gets half.`;
      }
    } catch {
      /* nothing to show */
    }
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
        ${points.bounty ? `<div><dt>Bounty</dt><dd>+${points.bounty}</dd></div>` : `<div><dt>Took</dt><dd>${fmtClock(result.secondsTaken)}</dd></div>`}
      </dl>
    </section>
    <section class="match" aria-label="Photo check">
      <div class="match-pair">
        <figure class="m"><img src="${apiUrl(result.revealUrl || egg.imageUrl)}" alt="The egg photo" /><figcaption>${egg.blur && result.revealUrl ? 'The egg, unblurred' : 'The egg'}</figcaption></figure>
        ${play.myPhoto ? `<figure class="m"><img src="${play.myPhoto}" alt="Your photo" /><figcaption>Your photo</figcaption></figure>` : ''}
      </div>
      <p class="match-verdict ${verification.method === 'gemini' ? 'is-ok' : ''}">${verification.method === 'gemini' ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg><b>Cleared.</b> Same object${verification.reason ? `: ${esc(verification.reason)}` : ''}` : esc(verification.reason)}</p>
    </section>
    <ul id="gains" class="gains" aria-live="polite"></ul>
    <section class="next-egg">
      <h2 class="sec-h">Hide the next one</h2>
      <p class="next-egg-copy">Your photo becomes the new ${esc(egg.levelName)} egg at ${esc(egg.stationName)}. Every player it beats grows its bounty, and you get half when someone finally finds it.</p>
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

  $('#hide').addEventListener('click', () => {
    state.pendingHide = { stationId: egg.stationId, stationName: egg.stationName, level: egg.level, findId: result.findId };
    state.play = null;
    location.hash = '#/hide';
  });
  $('#skip').addEventListener('click', () => (state.play = null));

  // What this find changed: rank, rival, line war, challenge, stamps, the station card.
  const before = play.before ?? {};
  const [, progress, stationNow] = await Promise.all([
    refreshHud(true),
    refreshProgress(),
    api(`/api/stations/${encodeURIComponent(egg.stationId)}`).catch(() => null),
  ]);
  const gains = [];
  if (points.bounty) {
    const hider = result.hider ? ` ${esc(result.hider.username)} gets +${result.hider.points} for hiding it.` : '';
    gains.push(['stamp', `<b>Bounty +${points.bounty}.</b> This egg beat ${plural(result.beaten, 'player')} before you.${hider}`]);
  }
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
  const fam = play.station ? familiesOf(play.station.lines)[0] : null;
  if (MAIN_LINES.includes(fam) && h?.lines?.length) {
    const sorted = MAIN_LINES.map((l) => ({ line: l, points: h.lines.find((x) => x.line === l)?.points ?? 0 })).sort((a, b) => b.points - a.points);
    const i = sorted.findIndex((x) => x.line === fam);
    const line = sorted[i];
    const note = i === 0
      ? `${fam} leads ${sorted[1].line} by ${(line.points - sorted[1].points).toLocaleString()}.`
      : `${fam} is ${ordinal(i + 1)}, ${(sorted[i - 1].points - line.points).toLocaleString()} behind ${sorted[i - 1].line}.`;
    gains.push(['line', `<b>+${points.total} for the ${fam} Line.</b> ${note}`, fam]);
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
  if (!hide) {
    location.hash = '#/';
    return;
  }
  const level = state.config.levels.find((l) => l.level === hide.level);
  let image = null;

  app.innerHTML = `
    <div class="play-bar">
      <a class="icon-btn" href="#/station/${encodeURIComponent(hide.stationId)}" aria-label="Back to ${esc(hide.stationName)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></a>
      <p class="play-title">Hide a <b>${esc(level.name)}</b> egg</p>
      <p class="mypts mypts-here"><b>${level.points}</b> pts</p>
    </div>
    <section class="tk hide-tk">
      <div class="tk-top">
        <div id="preview" class="egg-photo egg-photo-empty">
          <p class="photo-empty">Photograph something small in ${esc(hide.stationName)}. Easy should take a minute to find. Impossible should take real searching.${level.blur ? ` Finders will see this photo ${level.blur >= 12 ? 'heavily blurred' : 'blurred'}, so pick something they can still recognise up close.` : ''}</p>
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
        <p class="clock-ctx">You score when your egg beats people. Each player who runs out of time adds to its bounty, and you get half when someone finally finds it. An egg nobody finds pays nothing, so make it hard but findable.</p>
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
      state.pendingHide = null;
      state.stations = null; // egg counts changed
      toast('Egg hidden. Now someone else has to find it.');
      location.hash = `#/station/${encodeURIComponent(hide.stationId)}`;
    } catch (err) {
      $('#err').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
      btn.disabled = false;
      btn.textContent = 'Hide this egg';
    }
  });
}

// ---------- ranks ----------
async function viewLeaderboard() {
  loading();
  const stations = await getStations();
  let { mode } = state.board;
  let period = state.board.period ?? 'month'; // 'month' | 'all'
  let stationId = state.board.stationId || state.lastStationId || stations.find((s) => s.activeEggs)?.id || stations[0]?.id;
  const monthLabel = new Date().toLocaleString('en-US', { month: 'long', timeZone: 'America/New_York' });
  const nextMonth = new Date();
  nextMonth.setMonth(nextMonth.getMonth() + 1, 1);
  const resetLabel = nextMonth.toLocaleString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' });

  const heading = () => (period === 'month'
    ? `<h1 class="page-h">${esc(monthLabel)}</h1><p class="page-sub">Everything resets on ${esc(resetLabel)}. Tap a player to see their profile.</p>`
    : '<h1 class="page-h">All time</h1><p class="page-sub">Every point since the game began. Tap a player to see their profile.</p>');

  app.innerHTML = `
    <div class="seg" id="periodSeg" role="tablist" aria-label="Period">
      <button type="button" role="tab" data-period="month" aria-selected="${period === 'month'}">This month</button>
      <button type="button" role="tab" data-period="all" aria-selected="${period === 'all'}">All time</button>
    </div>
    <div id="lbHead">${heading()}</div>
    <div id="versus"></div>
    <div id="war"></div>
    <div class="seg" id="modeSeg" role="tablist" aria-label="Players">
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
    const q = new URLSearchParams({ period, ...(mode === 'station' && { stationId }) });
    const data = await api(`/api/leaderboard?${q}`);
    if (mode === 'all') {
      $('#war').innerHTML = data.lines.length ? lineWar(data.lines, period === 'all' ? { sub: "Points at each line's stations, all time" } : {}) : '';
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
          ? `<section class="tk versus versus-top"><p class="vs-top"><b>You're 1st ${period === 'month' ? 'this month' : 'of all time'}</b> with ${mine.points} points.</p></section>`
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

  app.querySelectorAll('#periodSeg button').forEach((b) =>
    b.addEventListener('click', () => {
      period = state.board.period = b.dataset.period;
      app.querySelectorAll('#periodSeg button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      $('#lbHead').innerHTML = heading();
      draw();
    }),
  );
  app.querySelectorAll('#modeSeg button').forEach((b) =>
    b.addEventListener('click', () => {
      mode = state.board.mode = b.dataset.mode;
      app.querySelectorAll('#modeSeg button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
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

// ---------- profile ----------
// Each find is a little punched ticket.
function ticketsGrid(finds) {
  return finds.length
    ? `<ul class="book">${finds
        .map((f) => {
          const st = state.stations?.find((s) => s.name === f.stationName);
          const fam = st ? familiesOf(st.lines)[0] : null;
          return `<li class="mini" style="--ln:${LINE_VAR[fam] ?? 'var(--ink)'}">
            <p class="mini-band ${fam === 'Orange' ? 'mini-band-dark' : ''}">${esc(f.stationName)}</p>
            <div class="mini-pic">${f.photoUrl
              ? `<img src="${apiUrl(f.photoUrl)}" alt="Find at ${esc(f.stationName)}" loading="lazy" />`
              : '<p class="mini-hidden">Hidden until you find it</p>'}</div>
            <p class="mini-lv">${esc(f.levelName)} <b>+${f.points}</b></p>
            <span class="hole hole-s" aria-hidden="true"></span>
          </li>`;
        })
        .join('')}</ul>`
    : '<div class="empty"><p>No finds yet. Find an egg and it lands here.</p></div>';
}

// Your recent activity, newest first (only ever sent for your own profile).
const fmtWhen = (iso) => {
  const mins = (Date.now() - new Date(iso).getTime()) / 60_000;
  if (mins < 1) return 'just now';
  if (mins < 60) return relTime.format(-Math.floor(mins), 'minute');
  if (mins < 24 * 60) return relTime.format(-Math.floor(mins / 60), 'hour');
  if (mins < 7 * 24 * 60) return relTime.format(-Math.floor(mins / 1440), 'day');
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
function activityList(items) {
  if (!items?.length) return '';
  const at = (a) => `<a href="#/station/${encodeURIComponent(a.stationId)}">${esc(a.stationName)}</a>`;
  const row = (a) => {
    const [icon, text, pts] =
      a.type === 'found' ? ['🥚', `Found the ${esc(a.levelName)} egg at ${at(a)}`, `+${a.points}`]
      : a.type === 'hid' ? ['📍', `Hid a ${esc(a.levelName)} egg at ${at(a)}`]
      : a.type === 'egg_found' ? ['👀', `<b>${esc(a.by)}</b> found your ${esc(a.levelName)} egg at ${at(a)}`]
      : a.type === 'joined_group' ? ['👥', `Joined <a href="#/group/${encodeURIComponent(a.groupId)}">${esc(a.groupName)}</a>`]
      : ['🎟️', 'Joined Lookout'];
    return `<li><span class="act-ic" aria-hidden="true">${icon}</span><p>${text}<small>${fmtWhen(a.at)}</small></p>${pts ? `<b class="act-pts">${pts}</b>` : ''}</li>`;
  };
  return `<ol class="activity">${items.map(row).join('')}</ol>`;
}

// Username (public: leaderboards, profile) and chat name (anonymous: group chats only).
function namesCard(user) {
  return `<section class="tk names">
    <div class="name-row">
      <div><p class="next-label">Username</p><p class="name-val">${esc(user.username)}</p><small>On leaderboards and your profile. You sign in with it.</small></div>
      <button class="link" type="button" data-edit="username">Change</button>
    </div>
    <div class="tk-perf" aria-hidden="true"></div>
    <div class="name-row">
      <div><p class="next-label">Anonymous chat name</p><p class="name-val">${esc(user.chatName ?? '')}</p><small>All group chats show this name instead of your username. Only you can see it's yours.</small></div>
      <button class="link" type="button" data-edit="chatName">Change</button>
    </div>
    <form id="nameForm" class="name-form" hidden>
      <label class="field-label" for="nameInput"></label>
      <div class="name-edit"><input id="nameInput" class="input" maxlength="20" autocapitalize="none" autocomplete="off" required /><button class="btn btn-ink" type="submit">Save</button></div>
      <div class="name-tools"><button id="dice" class="link" type="button" hidden>Random name</button><button id="nameCancel" class="link" type="button">Cancel</button></div>
      <div id="nameErr"></div>
    </form>
  </section>`;
}

const CHAT_WORDS = [['Sleepy', 'Speedy', 'Sneaky', 'Lucky', 'Rusty', 'Shiny', 'Grumpy', 'Jolly', 'Cosmic', 'Salty', 'Mystic', 'Stealthy'], ['Turnstile', 'Trolley', 'Pigeon', 'Conductor', 'Railcar', 'Signal', 'Token', 'Tunnel', 'Caboose', 'Owl', 'Raccoon', 'Otter']];
const randomChatName = () => `${CHAT_WORDS.map((w) => w[Math.floor(Math.random() * w.length)]).join(' ')} ${10 + Math.floor(Math.random() * 90)}`;

function wireNames(onSaved) {
  const form = $('#nameForm');
  let field = null;
  app.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => {
      field = b.dataset.edit;
      form.hidden = false;
      form.querySelector('label').textContent = field === 'username' ? 'New username' : 'New chat name';
      $('#dice').hidden = field !== 'chatName';
      $('#nameErr').innerHTML = '';
      $('#nameInput').value = state.user[field] ?? '';
      $('#nameInput').focus();
      $('#nameInput').select();
    }),
  );
  $('#dice').addEventListener('click', () => ($('#nameInput').value = randomChatName()));
  $('#nameCancel').addEventListener('click', () => (form.hidden = true));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('.btn');
    btn.disabled = true;
    try {
      const { user } = await api('/api/me/names', { [field]: $('#nameInput').value });
      setSession({ user, token: state.token });
      toast(field === 'username' ? 'Username changed. Sign in with the new one from now on.' : `You're now "${user.chatName}" in group chats.`, 3600);
      onSaved();
    } catch (err) {
      $('#nameErr').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
      btn.disabled = false;
    }
  });
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

async function viewProfile() {
  loading();
  const [p, progress, sessions] = await Promise.all([
    api(`/api/users/${state.user.id}`),
    refreshProgress(),
    api('/api/auth/sessions').then((d) => d.sessions, () => null),
    getStations(),
  ]);
  const lv = progress?.level;
  const xp = lv?.next ? Math.round(((lv.points - lv.floor) / (lv.next - lv.floor)) * 100) : 100;
  const earned = progress?.stamps.filter((s) => s.earned).length ?? 0;

  app.innerHTML = `
    <section class="tk level-tk">
      <div class="tk-top level-top">
        <div>
          <h1 class="page-h">${esc(p.user.username)}</h1>
          <p class="page-sub">${p.monthRank ? `${ordinal(p.monthRank)} this month. ` : ''}${lv ? `Rider level ${lv.level}${lv.next ? `, ${lv.next - lv.points} pts to level ${lv.level + 1}.` : '.'}` : ''}${p.hiderPoints ? ` Your eggs have earned you ${p.hiderPoints} pts in bounties.` : ''}</p>
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
      </div>
    </section>
    ${namesCard({ ...p.user, chatName: p.user.chatName ?? state.user.chatName })}
    ${p.activity?.length ? `<div class="eggs-head"><h2 class="sec-h">Activity</h2><p class="eggs-count">Latest first</p></div>${activityList(p.activity)}` : ''}
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
    <div class="eggs-head"><h2 class="sec-h">Recent finds</h2><p class="eggs-count">${plural(p.recentFinds.length, 'find')}</p></div>
    ${ticketsGrid(p.recentFinds)}
    <h2 class="sec-h">Signed-in devices</h2>
    ${deviceList(sessions)}
    <div class="account">
      <button id="out" class="btn btn-ghost" type="button">Sign out</button>
      <button id="outAll" class="link" type="button">Sign out on all devices</button>
    </div>`;
  wireNames(viewProfile);
  $('#out').addEventListener('click', () => signOut({ remote: true }));
  $('#outAll').addEventListener('click', () => {
    if (confirm('Sign out on every phone and computer using this account?')) signOut({ remote: true, everywhere: true });
  });
}

// Another player's public profile, opened from the ranks.
async function viewPlayer(id) {
  if (id === state.user.id) return location.replace('#/profile');
  loading();
  const [p] = await Promise.all([api(`/api/users/${encodeURIComponent(id)}`), getStations()]);
  app.innerHTML = `
    <a class="back" href="#/leaderboard"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>Ranks</a>
    <section class="tk level-tk">
      <div class="tk-top"><h1 class="page-h">${esc(p.user.username)}</h1><p class="page-sub">${p.monthRank ? `${ordinal(p.monthRank)} this month` : 'Not on the board yet this month'}${p.hiderPoints ? `. Their eggs have earned ${p.hiderPoints} pts in bounties` : ''}</p></div>
      <div class="tk-perf" aria-hidden="true"></div>
      <dl class="tk-bottom mini-stats">
        <div><dt>This month</dt><dd>${p.monthPoints}</dd></div>
        <div><dt>All time</dt><dd>${p.allTimePoints}</dd></div>
        <div><dt>Eggs hidden</dt><dd>${p.eggsHidden}</dd></div>
        <div><dt>Found by others</dt><dd>${p.timesYourEggsWereFound}</dd></div>
      </dl>
    </section>
    <div class="eggs-head"><h2 class="sec-h">Recent finds</h2></div>
    ${ticketsGrid(p.recentFinds)}`;
}

// ---------- notifications ----------
// Your eggs, and every time someone found one. Opening the page marks them seen.
const EGG_STATUS = { active: 'Live now', pool: 'Waiting in the pool', retired: 'Retired' };
async function viewNotifications() {
  loading();
  const [data] = await Promise.all([api('/api/me/notifications'), getStations()]);
  const c = data.counts;
  const at = (n) => `<a href="#/station/${encodeURIComponent(n.stationId)}">${esc(n.stationName)}</a>`;
  const row = (n) =>
    n.type === 'egg_found'
      ? `<li class="${n.unseen ? 'is-new' : ''}"><span class="act-ic" aria-hidden="true">🎉</span><p><b>${esc(n.by)}</b> found your ${esc(n.levelName)} egg at ${at(n)}<small>${fmtWhen(n.at)}${n.unseen ? ' · New' : ''}</small></p><b class="act-pts">+${n.points}</b></li>`
      : `<li class="nt-egg"><img src="${apiUrl(n.photoUrl)}" alt="Your egg at ${esc(n.stationName)}" loading="lazy" /><p>You hid a ${esc(n.levelName)} egg at ${at(n)}${n.hint ? `<small>Hint: ${esc(n.hint)}</small>` : ''}<small>${fmtWhen(n.at)} · ${EGG_STATUS[n.status] ?? esc(n.status)} · ${n.timesFound ? `found ${plural(n.timesFound, 'time')}` : 'not found yet'}</small></p></li>`;
  const ask = 'Notification' in window && Notification.permission === 'default';
  app.innerHTML = `
    <h1 class="page-h">Notifications</h1>
    <p class="page-sub">Your eggs, and every time someone finds one.</p>
    <div class="map-tally nt-tally">
      <p><b>${c.finds}</b>${c.finds === 1 ? 'egg' : 'eggs'} you found</p>
      <p><b>${c.eggsHidden}</b>${c.eggsHidden === 1 ? 'egg' : 'eggs'} you hid</p>
      <p><b>${c.foundByOthers}</b>${c.foundByOthers === 1 ? 'time' : 'times'} others found yours</p>
    </div>
    ${ask ? '<div class="notice nt-ask"><p>Get a heads-up when someone finds your egg, or when you reach a station with eggs waiting.</p><button id="allow" class="btn btn-ink" type="button">Turn on alerts</button></div>' : ''}
    ${data.items.length
      ? `<ol class="activity nt-list">${data.items.map(row).join('')}</ol>`
      : '<div class="empty"><p>Nothing yet. Hide an egg at a station and you\'ll hear here when someone finds it.</p><a class="btn btn-ghost" href="#/">Find a station</a></div>'}`;
  $('#allow')?.addEventListener('click', async () => {
    const r = await Notification.requestPermission().catch(() => 'denied');
    toast(r === 'granted' ? "Alerts on. We'll tell you when your eggs are found." : 'Alerts are off. You can still check this page.');
    $('.nt-ask')?.remove();
  });
  if (data.unseen) {
    api('/api/me/notifications/seen', {}).catch(() => {});
    state.unseen = 0;
    drawBell();
  }
}

// ---------- friend groups ----------
// Private leaderboards with friends, joined by invite code or link, plus a sticker-only chat.
const CHAT_POLL_MS = 4000;
const inviteLink = (code) => `${location.origin}${location.pathname}#/join/${code}`;
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

async function shareInvite(group) {
  const url = inviteLink(group.inviteCode);
  const text = `Join my Lookout group "${group.name}" and see who finds the most eggs.`;
  try {
    if (navigator.share) return await navigator.share({ title: group.name, text, url });
  } catch (err) {
    if (err?.name === 'AbortError') return; // closed the share sheet
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied.');
  } catch {
    prompt('Copy this invite link:', url);
  }
}

async function viewGroups() {
  loading();
  const { groups, limits } = await api('/api/groups');
  app.innerHTML = `
    <h1 class="page-h">Groups</h1>
    <p class="page-sub">Your own leaderboard with friends. Start a group, then send them the invite link.</p>
    ${groups.length
      ? `<ul class="st-list">${groups
          .map((g) => `<li><a href="#/group/${encodeURIComponent(g.id)}">
              <span class="st-lines"><i style="--ln:var(--stamp)"></i></span>
              <span class="st-txt"><b>${esc(g.name)}</b><small>${plural(g.memberCount, 'member')}${g.isOwner ? ', you run it' : ''}</small></span>
              <span class="st-count">${g.memberCount}</span>
            </a></li>`)
          .join('')}</ul>`
      : '<div class="empty"><p>You\'re not in any groups yet.</p></div>'}
    <section class="tk grp-forms">
      ${BAND_LINES}
      <form id="create" class="tk-top">
        <h2 class="sec-h">Start a group</h2>
        <label class="field-label" for="gname">Group name</label>
        <input id="gname" class="input" maxlength="30" placeholder="e.g. Red Line Regulars" required />
        <button class="btn btn-ink btn-block">Create group</button>
        <div id="createErr"></div>
      </form>
      <div class="tk-perf" aria-hidden="true"></div>
      <form id="join" class="tk-bottom">
        <h2 class="sec-h">Join with a code</h2>
        <label class="field-label" for="gcode">Invite code <span class="opt">(8 letters and numbers)</span></label>
        <input id="gcode" class="input" maxlength="12" autocapitalize="characters" autocomplete="off" placeholder="e.g. K7PQ2MXR" required />
        <button class="btn btn-ghost btn-block">Join group</button>
        <div id="joinErr"></div>
      </form>
    </section>
    <p class="page-sub">Up to ${limits.groups} groups each, ${limits.members} players per group.</p>`;

  $('#create').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { group } = await api('/api/groups', { name: $('#gname').value });
      location.hash = `#/group/${encodeURIComponent(group.id)}`;
    } catch (err) {
      $('#createErr').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
    }
  });
  $('#join').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { group } = await api('/api/groups/join', { code: $('#gcode').value });
      toast(`You joined ${group.name}.`);
      location.hash = `#/group/${encodeURIComponent(group.id)}`;
    } catch (err) {
      $('#joinErr').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
    }
  });
}

async function viewGroup(id) {
  loading();
  const gid = encodeURIComponent(id);
  let tab = 'board';
  let period = 'month';
  let data = await api(`/api/groups/${gid}`);
  let chat = null; // { messages, lastSeq } once the chat has been opened
  let stopPolling = null;
  const monthLabel = new Date().toLocaleString('en-US', { month: 'long', timeZone: 'America/New_York' });

  // The chat is anonymous: everyone shows by their chat name, never their username or rank.
  const myRank = () => data.rows.find((r) => r.userId === state.user.id)?.rank ?? null;
  const stickerHtml = (m) => {
    const r = m.mine ? myRank() : null;
    return `<div class="msg ${m.mine ? 'mine' : ''}">
      <span class="msg-emoji" aria-hidden="true">${esc(m.emoji)}</span>
      <p class="msg-cap">${esc(m.label)}</p>
      <p class="msg-meta">${m.mine ? 'You' : esc(m.name)}${r ? `<span class="rank-chip">${r === 1 ? '👑 ' : ''}${ordinal(r)}</span>` : ''} · ${fmtTime(m.createdAt)}</p>
    </div>`;
  };

  const boardHtml = () => {
    const href = (r) => (r.userId === state.user.id ? '#/profile' : `#/user/${encodeURIComponent(r.userId)}`);
    return `
      <div class="seg" role="tablist" aria-label="Period">
        <button type="button" role="tab" data-period="month" aria-selected="${period === 'month'}">${esc(monthLabel)}</button>
        <button type="button" role="tab" data-period="all" aria-selected="${period === 'all'}">All time</button>
      </div>
      <ol class="ranks">${data.rows
        .map((r) => `<li class="${r.userId === state.user.id ? 'is-me' : ''}"><a href="${href(r)}">
            <span class="rk ${r.rank ? '' : 'rk-none'}">${r.rank ?? '–'}</span>
            <span class="who"><b>${r.userId === state.user.id ? 'You' : esc(r.username)}${r.isOwner ? '<span class="tag">Owner</span>' : ''}</b><small>${r.finds ? plural(r.finds, 'find') : 'No finds yet'}</small></span>
            <span class="sc">${r.points}</span>
          </a></li>`)
        .join('')}</ol>
      ${data.rows.every((r) => !r.points) ? `<p class="page-sub">Nobody has scored ${period === 'month' ? 'this month' : 'yet'}. Find an egg to take the lead.</p>` : ''}`;
  };

  const chatHtml = () => `
    <section class="tk"><div id="feed" class="feed" aria-live="polite">${chat.messages.length
      ? chat.messages.map(stickerHtml).join('')
      : '<div class="empty"><p>No stickers yet. Start the trash talk.</p></div>'}</div></section>
    <p class="chat-hint">You're <b>${esc(state.user.chatName ?? 'anonymous')}</b> here (<a href="#/profile">change</a>). Tap a sticker to send it.</p>
    <div class="stickers">${(state.config?.stickers ?? [])
      .map((st) => `<button class="stk" type="button" data-sticker="${esc(st.id)}" aria-label="Send ${esc(st.label)}"><span aria-hidden="true">${esc(st.emoji)}</span><small>${esc(st.label)}</small></button>`)
      .join('')}</div>`;

  function scrollFeed(force) {
    const feed = $('#feed');
    if (!feed) return;
    if (force || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80) feed.scrollTop = feed.scrollHeight;
  }

  function appendMessages(messages) {
    const fresh = messages.filter((m) => m.seq > chat.lastSeq);
    if (!fresh.length) return;
    chat.messages.push(...fresh);
    chat.lastSeq = fresh.at(-1).seq;
    const feed = $('#feed');
    if (!feed) return;
    feed.querySelector('.empty')?.remove();
    feed.insertAdjacentHTML('beforeend', fresh.map(stickerHtml).join(''));
    scrollFeed(fresh.some((m) => m.mine));
  }

  async function poll() {
    if (document.visibilityState !== 'visible' || tab !== 'chat') return;
    try {
      appendMessages((await api(`/api/groups/${gid}/messages?after=${chat.lastSeq}`)).messages);
    } catch {
      /* try again next tick */
    }
  }

  function startPolling() {
    if (stopPolling) return;
    const iv = setInterval(poll, CHAT_POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && poll();
    document.addEventListener('visibilitychange', onVisible);
    stopPolling = () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVisible);
      stopPolling = null;
    };
    onCleanup(() => stopPolling?.()); // stops when leaving the page
  }

  const draw = () => {
    const { group } = data;
    app.innerHTML = `
      <a class="back" href="#/groups"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>Groups</a>
      <section class="tk">
        ${BAND_LINES}
        <div class="tk-top grp-head">
          <div>
            <p class="here">Group</p>
            <h1 class="page-h">${esc(group.name)}</h1>
            <p class="page-sub">${plural(group.memberCount, 'member')}${group.isOwner ? ', you run it' : ''}</p>
          </div>
          ${group.isOwner ? '<button id="rename" class="link" type="button">Rename</button>' : ''}
        </div>
        <div class="tk-perf" aria-hidden="true"></div>
        <div class="tk-bottom invite-row">
          <div><p class="next-label">Invite code</p><p class="invite-code">${esc(group.inviteCode)}</p></div>
          <button id="share" class="btn btn-primary" type="button">Share invite</button>
        </div>
      </section>
      <div class="seg" role="tablist" aria-label="Group">
        <button type="button" role="tab" data-tab="board" aria-selected="${tab === 'board'}">Ranks</button>
        <button type="button" role="tab" data-tab="chat" aria-selected="${tab === 'chat'}">Chat</button>
      </div>
      <div class="grp-pane">${tab === 'board' ? boardHtml() : chatHtml()}</div>
      <div class="account"><button id="leave" class="link" type="button">Leave group</button></div>`;

    $('#share').addEventListener('click', () => shareInvite(group));
    app.querySelectorAll('[data-tab]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (b.dataset.tab === tab) return;
        tab = b.dataset.tab;
        if (tab === 'chat' && !chat) {
          try {
            const { messages } = await api(`/api/groups/${gid}/messages`);
            chat = { messages, lastSeq: messages.at(-1)?.seq ?? 0 };
          } catch (err) {
            tab = 'board';
            return toast(err.message);
          }
        }
        draw();
        if (tab === 'chat') {
          scrollFeed(true);
          startPolling();
          poll();
        } else stopPolling?.();
      }),
    );
    app.querySelectorAll('[data-period]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (b.dataset.period === period) return;
        period = b.dataset.period;
        try {
          data = await api(`/api/groups/${gid}${period === 'all' ? '?period=all' : ''}`);
          draw();
        } catch (err) {
          toast(err.message);
        }
      }),
    );
    app.querySelectorAll('[data-sticker]').forEach((b) =>
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          const { message } = await api(`/api/groups/${gid}/messages`, { sticker: b.dataset.sticker });
          // Pick up anything others sent meanwhile, then ours, in order.
          const { messages } = await api(`/api/groups/${gid}/messages?after=${chat.lastSeq}`);
          appendMessages(messages.length ? messages : [message]);
        } catch (err) {
          toast(err.message);
        } finally {
          b.disabled = false;
        }
      }),
    );
    $('#rename')?.addEventListener('click', async () => {
      const name = prompt('New group name', group.name);
      if (!name || name.trim() === group.name) return;
      try {
        data.group = (await api(`/api/groups/${gid}/rename`, { name })).group;
        draw();
        toast('Group renamed.');
      } catch (err) {
        toast(err.message);
      }
    });
    $('#leave').addEventListener('click', async () => {
      const lastOne = group.memberCount === 1;
      const msg = lastOne
        ? `You're the only member. Leaving deletes "${group.name}" and its chat. Continue?`
        : group.isOwner
          ? `Leave "${group.name}"? The longest-standing member takes over.`
          : `Leave "${group.name}"?`;
      if (!confirm(msg)) return;
      try {
        await api(`/api/groups/${gid}/leave`, {});
        toast(lastOne ? 'Group deleted.' : 'You left the group.');
        location.hash = '#/groups';
      } catch (err) {
        toast(err.message);
      }
    });
  };
  draw();
}

// Opened from an invite link. Signing up first works too: the hash survives it.
async function viewJoin(code) {
  loading();
  const { group, alreadyMember } = await api(`/api/groups/invite/${encodeURIComponent(code)}`);
  if (alreadyMember) return location.replace(`#/group/${encodeURIComponent(group.id)}`);
  app.innerHTML = `
    <section class="tk">
      ${BAND_LINES}
      <div class="tk-top">
        <p class="here">You're invited to a group</p>
        <h1 class="page-h">${esc(group.name)}</h1>
        <p class="page-sub">${plural(group.memberCount, 'member')}. Join to see the group's ranks and send stickers.</p>
      </div>
      <div class="tk-perf" aria-hidden="true"></div>
      <div class="tk-bottom stack">
        ${group.full
          ? '<div class="notice bad">This group is full.</div><a class="btn btn-ghost btn-block" href="#/groups">Back to groups</a>'
          : `<button id="joinBtn" class="btn btn-ink btn-block btn-l" type="button">Join ${esc(group.name)}</button>
             <a class="btn btn-ghost btn-block" href="#/groups">Not now</a>
             <div id="err"></div>`}
      </div>
    </section>`;
  $('#joinBtn')?.addEventListener('click', async () => {
    $('#joinBtn').disabled = true;
    try {
      const { group: joined } = await api('/api/groups/join', { code });
      toast(`You joined ${joined.name}.`);
      location.replace(`#/group/${encodeURIComponent(joined.id)}`);
    } catch (err) {
      $('#err').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
      $('#joinBtn').disabled = false;
    }
  });
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

// Every station gets a badge with its egg count: line colour when there are eggs, faded once
// you've found (or hidden) all of them, a small grey 0 when there are none.
async function viewMap() {
  loading('Loading the map');
  const [{ stations, totals }] = await Promise.all([api('/api/stations'), loadLeaflet()]); // fresh counts
  state.stations = stations;
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue('--ink').trim();
  const ticket = css.getPropertyValue('--ticket').trim();
  app.innerHTML = `
    <h1 class="page-h">Map</h1>
    <div class="map-tally" aria-label="Eggs on the T right now">
      <p><b>${totals.eggs}</b>${totals.eggs === 1 ? 'egg' : 'eggs'} hidden</p>
      <p><b>${totals.stationsWithEggs}</b>of ${totals.stations} stations</p>
      <p><b>${totals.playable ?? totals.eggs}</b>left for you</p>
    </div>
    <div id="map" class="map"></div>
    <ul class="map-key" aria-label="Map key">
      <li><span class="pin pin-key" data-fam="Red" style="--ln:var(--line-red)">3</span>Eggs to find</li>
      <li><span class="pin pin-done pin-key" style="--ln:var(--line-blue)">2</span>All found by you</li>
      <li><span class="pin pin-zero pin-key">0</span>None yet</li>
    </ul>`;
  const map = L.map('map', { zoomControl: true }).setView(loc.pos ? [loc.pos.lat, loc.pos.lng] : [42.3555, -71.0805], loc.pos ? 14 : 12);
  state.map = map;
  // Zoomed out, stations without eggs shrink to dots and badges get smaller, so the city view stays readable.
  const scale = () => {
    const z = map.getZoom();
    $('#map').dataset.z = z >= 14 ? 'near' : z >= 13 ? 'mid' : 'far';
  };
  map.on('zoomend', scale);
  scale();
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  for (const s of stations) {
    const fam = familiesOf(s.lines)[0];
    const n = s.activeEggs;
    const left = s.playable ?? n;
    const size = n ? 28 : 18;
    const cls = n === 0 ? 'pin pin-zero' : left === 0 ? 'pin pin-done' : 'pin';
    const icon = L.divIcon({
      className: 'pin-wrap',
      html: `<span class="${cls}" data-fam="${esc(fam ?? '')}" style="--ln:${LINE_VAR[fam] ?? 'var(--ink)'}">${n}</span>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -size / 2],
    });
    const what = n
      ? `${plural(n, 'egg')} hidden${left !== n ? `, ${left === 0 ? 'none' : left} left for you` : ''}`
      : 'No eggs yet. Hide the first one.';
    L.marker([s.lat, s.lng], { icon, title: `${s.name}: ${plural(n, 'egg')}`, riseOnHover: true, zIndexOffset: n ? 1000 + n * 10 + left : 0 })
      .addTo(map)
      .bindPopup(`<strong>${esc(s.name)}</strong><br/>${what}<br/><a href="#/station/${encodeURIComponent(s.id)}">Open station</a>`);
  }
  if (loc.pos) {
    L.circle([loc.pos.lat, loc.pos.lng], { radius: RANGE_METERS, color: ink, weight: 1, fillOpacity: 0.06 }).addTo(map);
    L.circleMarker([loc.pos.lat, loc.pos.lng], { radius: 7, color: ticket, weight: 3, fillColor: ink, fillOpacity: 1 }).addTo(map).bindPopup('You are here');
  }
}

// ---------- boot ----------
(async function boot() {
  setLine(state.line);
  try {
    state.config = await api('/api/config');
  } catch {
    app.innerHTML = '<div class="notice bad">Can\'t reach the game server. Is it running?</div>';
    return;
  }
  // Make sure this device's session is still valid (it may have been signed out elsewhere).
  if (state.token) {
    try {
      const { user } = await api('/api/auth/me');
      setSession({ user, token: state.token });
    } catch (err) {
      if (err.status === 401) setSession(null);
    }
  }
  // Detect the station automatically as soon as a player is signed in.
  if (state.user) startLocation();
  window.addEventListener('hashchange', render);
  render();
})();
