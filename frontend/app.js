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
  el.onclick = () => (el.hidden = true); // tap to dismiss
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
const anA = (word) => (/^[aeiou]/i.test(String(word)) ? 'an' : 'a'); // "an Easy egg", "a Hard egg"

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
  // The Here tab and the station's own page already say all this: don't cover them with a toast.
  const h = location.hash || '#/';
  if (document.visibilityState === 'visible' && (h === '#/' || h === href)) return;
  if (left) notifyPlayer(`${s.name}:`, `${plural(left, 'egg')} for you here.`, href);
  else if (s.activeEggs) notifyPlayer(`${s.name}:`, 'you found every egg here.', href);
  else notifyPlayer(`${s.name}:`, 'no eggs yet. Hide the first.', href);
}

// ---------- trains ----------
// About every 20 s the phone's position is compared with the live trains. Two matching checks
// that moved together with the same train verify you're on it, and you can join its lobby.
const TRAIN_CHECK_MS = 20_000;
const trainFam = (routeId) => String(routeId ?? '').split('-')[0];
async function checkTrain() {
  if (!state.user || loc.status !== 'ok' || !loc.pos || document.visibilityState === 'hidden') return;
  try {
    const r = await api('/api/trains/check', { lat: loc.pos.lat, lng: loc.pos.lng, accuracy: loc.pos.accuracy ?? 0 });
    state.train = r;
    drawTrainBar();
    const t = r.onTrain;
    if (t?.verified && !(r.lobby && r.lobby.tripId === t.tripId)) {
      const told = readStored('egg-train-told');
      if (told !== t.tripId) {
        store('egg-train-told', t.tripId);
        notifyPlayer(`🚇 ${t.line}`, 'Join the lobby', '#/train');
      }
    }
  } catch {
    /* extra: try again next time */
  }
}

// A slim bar under the HUD while you're on a train or in a lobby.
function drawTrainBar() {
  const hud = $('#hud');
  if (!hud || hud.hidden) return;
  hud.querySelector('.train-bar')?.remove();
  const { onTrain, lobby } = state.train ?? {};
  let html = '';
  if (lobby) {
    html = `<a class="train-bar" href="#/lobby/${encodeURIComponent(lobby.id)}" style="--ln:${LINE_VAR[trainFam(lobby.routeId)] ?? 'var(--ink)'}"><span aria-hidden="true">🚇</span><b>Lobby</b><span>${lobby.status === 'reached' ? '🏆' : `${lobby.atTarget}/${lobby.riders} at ${lobby.target}`}</span></a>`;
  } else if (onTrain?.verified) {
    html = `<a class="train-bar" href="#/train" style="--ln:${LINE_VAR[trainFam(onTrain.routeId)] ?? 'var(--ink)'}"><span aria-hidden="true">🚇</span><b>${esc(onTrain.line)}${onTrain.headsign ? ` to ${esc(onTrain.headsign)}` : ''}</b><span>Join</span></a>`;
  } else if ((state.config?.trainSim || state.user?.tester) && !/^#\/(train|lobby)/.test(location.hash)) {
    // Testing only: a way into the train lobby without riding a train.
    html = '<a class="train-bar train-sim" href="#/train"><span aria-hidden="true">🧪</span><b>Simulate ride</b><span>›</span></a>';
  }
  if (html) hud.insertAdjacentHTML('beforeend', html);
}

async function viewTrain() {
  loading();
  await checkTrain();
  const { lobby } = state.train ?? {};
  let onTrain = state.train?.onTrain;
  // A simulated ride has no matching GPS, so checkTrain may not report it: keep it while it lasts.
  if (!onTrain?.verified && state.simTrain) onTrain = state.simTrain;
  if (lobby) return location.replace(`#/lobby/${encodeURIComponent(lobby.id)}`);
  const fam = trainFam(onTrain?.routeId);
  app.innerHTML = `
    <section class="tk" style="--ln:${LINE_VAR[fam] ?? 'var(--ink)'}">
      <div class="band train-band"><span>${onTrain ? esc(onTrain.line) : 'Train lobby'}</span></div>
      <div class="tk-top">
        <p class="here">${onTrain?.verified ? (onTrain.simulated ? '🧪 Riding' : 'Riding') : 'Train lobby'}</p>
        <h1 class="page-h">${onTrain ? esc(onTrain.headsign ? `To ${onTrain.headsign}` : onTrain.line) : 'Not on a train'}</h1>
        ${onTrain?.verified && onTrain.lobby ? `<p class="page-sub">👥 ${onTrain.lobby.riders}</p>` : !onTrain?.verified ? '<p class="page-sub">🚇 Ride with the app open</p>' : ''}
      </div>
      <div class="tk-perf" aria-hidden="true"></div>
      <div class="tk-bottom stack">
        ${onTrain?.verified ? '<button id="joinLobby" class="btn btn-ink btn-block btn-l" type="button">Join lobby</button>' : '<button id="recheck" class="btn btn-ghost btn-block" type="button">Check again</button>'}
        ${!onTrain?.verified && (state.config?.trainSim || state.user?.tester) ? '<button id="simulate" class="btn btn-primary btn-block" type="button">🧪 Simulate ride</button>' : ''}
        <div id="err"></div>
      </div>
    </section>`;
  $('#recheck')?.addEventListener('click', () => render());
  $('#simulate')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('/api/trains/simulate', loc.pos ? { lat: loc.pos.lat, lng: loc.pos.lng } : {});
      state.train = { ...(state.train ?? {}), onTrain: r.onTrain, lobby: null };
      state.simTrain = r.onTrain;
      drawTrainBar();
      render();
    } catch (err) {
      $('#err').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
      e.target.disabled = false;
    }
  });
  $('#joinLobby')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const { lobby: joined } = await api('/api/trains/lobby', { tripId: onTrain.tripId });
      state.train = { ...state.train, lobby: joined };
      drawTrainBar();
      location.hash = `#/lobby/${encodeURIComponent(joined.id)}`;
    } catch (err) {
      $('#err').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
      e.target.disabled = false;
    }
  });
}

async function viewLobby(id) {
  loading();
  const lid = encodeURIComponent(id);
  let { lobby } = await api(`/api/lobbies/${lid}`);
  const chat = { messages: (await api(`/api/lobbies/${lid}/messages`)).messages, lastSeq: 0 };
  chat.lastSeq = chat.messages.at(-1)?.seq ?? 0;
  const fam = trainFam(lobby.routeId);

  // Help requests show as a card with a Help button (or "Covered" once that rider has 100).
  const riderById = (rid) => lobby.ridersList?.find((r) => r.id === rid);
  const msgHtml = (m) => {
    if (m.help) {
      const r = riderById(m.help.riderId);
      const need = r ? r.need : m.help.need;
      return `<div class="msg msg-help ${m.mine ? 'mine' : ''}" data-id="${esc(m.id)}">
        <p class="help-card"><span aria-hidden="true">🙋</span> <b>${m.mine ? 'You' : esc(m.name)}</b> ${need > 0 ? `<b>−${need}</b>` : '✓'}
        ${need > 0 && !m.mine && lobby.status === 'open' ? `<button class="btn btn-primary help-btn" type="button" data-help="${esc(m.help.riderId)}">Help</button>` : ''}</p>
        <p class="msg-meta">${fmtTime(m.createdAt)}</p>
      </div>`;
    }
    return `<div class="msg ${m.mine ? 'mine' : ''}" data-id="${esc(m.id)}">
      ${m.text != null ? `<p class="msg-text">${esc(m.text)}</p>` : `<span class="msg-emoji" aria-hidden="true">${esc(m.emoji)}</span><p class="msg-cap">${esc(m.label)}</p>`}
      <p class="msg-meta">${m.mine ? 'You' : esc(m.name)} · ${fmtTime(m.createdAt)}${m.mine ? '' : ` <button class="link msg-report" type="button" data-report="${esc(m.id)}" aria-label="Report this message">Report</button>`}</p>
    </div>`;
  };

  // The pledge: every rider needs `target` pts of found eggs in their name. You pick eggs from
  // your stash by level and pledge them for yourself or for another rider.
  const pick = {}; // level -> count chosen
  let forRider = null; // rider id you're donating to, or null for yourself
  const pickedPts = () => Object.entries(pick).reduce((n, [lv, c]) => n + (lobby.stash.levels.find((l) => l.level === Number(lv))?.points ?? 0) * c, 0);
  const pledgeHtml = () => {
    const me = lobby.ridersList.find((r) => r.you);
    const status = lobby.status === 'reached' ? '<p class="stamp">Goal reached</p>'
      : lobby.status === 'ended' ? `<p class="stamp stamp-quiet">${lobby.outcome === 'reached' ? 'Goal reached' : 'Ride over'}</p>` : '';
    const target = forRider ? riderById(forRider) : me;
    if (forRider && (!target || target.need <= 0)) forRider = null;
    const recipient = forRider ? riderById(forRider) : me;
    const pts = pickedPts();
    const riders = lobby.ridersList
      .map((r) => `<li class="${r.you ? 'is-me' : ''} ${r.need ? '' : 'is-done'}">
        <span class="rd-name">${r.you ? 'You' : esc(r.name)}</span>
        <span class="rd-bar" aria-hidden="true"><i style="--p:${Math.min(100, Math.round((r.pledged / lobby.target) * 100))}%"></i></span>
        <span class="rd-n">${r.need ? `${r.pledged}/${lobby.target}` : '✓ 100'}</span>
        ${!r.you && r.need && lobby.status === 'open' ? `<button class="link rd-help" type="button" data-help="${esc(r.id)}">Help</button>` : ''}
      </li>`)
      .join('');
    return `
      <div class="pledge-head"><p class="pledge-n"><b>${lobby.atTarget}</b>/${lobby.riders} at ${lobby.target}</p>${status}</div>
      <ul class="pledge-rules" aria-label="Rewards">
        <li title="Everyone pledges ${lobby.target} pts of found eggs">🎯 ${lobby.target} each</li>
        <li title="Every rider, when all reach ${lobby.target}">🏆 +${lobby.bonus}</li>
        <li title="Per egg you donate">🎁 +${lobby.donorBonus}/egg</li>
        ${lobby.status === 'open' && lobby.riders < lobby.minRiders ? '<li class="is-wait">⏳ 2nd rider</li>' : ''}
      </ul>
      <ol class="riders">${riders}</ol>
      ${lobby.status === 'open' ? `
      <div class="pledge-box">
        ${(() => {
          // Who the eggs go to: you, or any rider still short of 100 (a donation).
          const others = lobby.ridersList.filter((r) => !r.you && r.need > 0);
          const chip = (id, label, need, on) => `<button type="button" class="for-chip ${on ? 'is-on' : ''}" data-for="${id}" aria-pressed="${on}" ${need ? '' : 'disabled'}>${label}<small>${need ? `−${need}` : '✓'}</small></button>`;
          return `<div class="for-chips">${chip('me', 'You', me.need, !forRider)}${others.map((r) => chip(esc(r.id), `🎁 ${esc(r.name)}`, r.need, forRider === r.id)).join('')}</div>`;
        })()}
        <ul class="stash">${lobby.stash.levels
          .map((l) => {
            const c = pick[l.level] ?? 0;
            return `<li class="${l.count ? '' : 'is-none'}">
              ${eggSvg(l.level, { size: 26, title: `${l.name} egg` })}
              <span class="st-lv">${esc(l.name)}<small>${l.points} pts · ×${l.count}</small></span>
              <span class="st-pick"><button type="button" class="st-b" data-dec="${l.level}" ${c ? '' : 'disabled'} aria-label="One fewer ${esc(l.name)}">−</button><b>${c}</b><button type="button" class="st-b" data-inc="${l.level}" ${c < l.count ? '' : 'disabled'} aria-label="One more ${esc(l.name)}">+</button></span>
            </li>`;
          })
          .join('')}</ul>
        <div class="pledge-actions">
          <button id="doPledge" class="btn btn-ink" type="button" ${pts && (forRider || me.need) ? '' : 'disabled'}>${forRider ? `🎁 Donate ${pts}` : `Pledge ${pts}`}</button>
          ${me.need && !forRider ? `<button id="askHelp" class="btn btn-ghost" type="button">🙋 Help me</button>` : ''}
        </div>
      </div>` : ''}
      <div id="pledgeErr"></div>`;
  };

  app.innerHTML = `
    <section class="tk lobby-tk" style="--ln:${LINE_VAR[fam] ?? 'var(--ink)'}">
      <div class="band train-band"><span>${esc(lobby.line)}</span><span>👥 ${lobby.riders}</span></div>
      <div class="tk-top">
        <p class="here">Train lobby</p>
        <h1 class="page-h">${esc(lobby.headsign ? `To ${lobby.headsign}` : lobby.line)}</h1>
        <p class="page-sub">Chatting as <b>${esc(state.user.chatName ?? 'anonymous')}</b></p>
      </div>
      <div class="tk-perf" aria-hidden="true"></div>
      <div class="tk-bottom" id="pledge">${pledgeHtml()}</div>
    </section>
    <section class="tk"><div id="feed" class="feed" aria-live="polite">${chat.messages.length ? chat.messages.map(msgHtml).join('') : '<div class="empty"><p aria-label="No messages yet">👋</p></div>'}</div></section>
    ${lobby.status === 'ended' ? '' : `<form id="say" class="say"><input id="sayText" class="input" maxlength="140" placeholder="Message" autocomplete="off" /><button class="btn btn-ink" type="submit">Send</button></form>
    <div id="sayErr"></div>
    <div class="stickers">${(state.config?.stickers ?? []).map((st) => `<button class="stk" type="button" data-sticker="${esc(st.id)}" aria-label="Send ${esc(st.label)}"><span aria-hidden="true">${esc(st.emoji)}</span><small>${esc(st.label)}</small></button>`).join('')}</div>`}
    ${state.config?.trainSim || state.user?.tester ? '<div class="account"><button id="switchLobby" class="btn btn-ghost" type="button">🧪 Switch lobby</button></div>' : ''}`;

  // Testers: hop onto the train where another tester's lobby is open (or a fresh one).
  $('#switchLobby')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('/api/trains/simulate', loc.pos ? { lat: loc.pos.lat, lng: loc.pos.lng } : {});
      state.simTrain = r.onTrain;
      if (r.onTrain.lobbyId === lobby.id) {
        toast("You're already in the shared test lobby.");
        e.target.disabled = false;
        return;
      }
      const { lobby: joined } = await api('/api/trains/lobby', { tripId: r.onTrain.tripId });
      state.train = { ...(state.train ?? {}), onTrain: r.onTrain, lobby: joined };
      if (joined.id === lobby.id) {
        toast('No other tester lobby is open, so you stay here. Have the other account tap Switch.');
        e.target.disabled = false;
        return;
      }
      toast(r.onTrain.sharedLobby ? 'Joined the other tester’s lobby.' : 'No other tester lobby open: moved to a new one.');
      location.hash = `#/lobby/${encodeURIComponent(joined.id)}`;
    } catch (err) {
      toast(err.message);
      e.target.disabled = false;
    }
  });

  const feed = $('#feed');
  feed.scrollTop = feed.scrollHeight;
  if (lobby.status !== 'ended') {
    state.train = { ...(state.train ?? {}), lobby };
    drawTrainBar();
  }
  const append = (messages) => {
    const fresh = messages.filter((m) => m.seq > chat.lastSeq);
    if (!fresh.length) return;
    chat.lastSeq = fresh.at(-1).seq;
    chat.messages.push(...fresh);
    feed.querySelector('.empty')?.remove();
    const near = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    feed.insertAdjacentHTML('beforeend', fresh.map(msgHtml).join(''));
    if (near || fresh.some((m) => m.mine)) feed.scrollTop = feed.scrollHeight;
  };
  const drawPledge = () => {
    $('#pledge').innerHTML = pledgeHtml();
    wirePledge();
    // Keep the train bar under the header in step with the meter.
    state.train = { ...(state.train ?? {}), lobby: lobby.status === 'ended' ? null : lobby };
    drawTrainBar();
  };
  const help = (rid) => {
    forRider = rid;
    for (const k of Object.keys(pick)) delete pick[k];
    drawPledge();
    $('#pledge').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  };
  function wirePledge() {
    app.querySelectorAll('[data-inc]').forEach((b) => b.addEventListener('click', () => { pick[b.dataset.inc] = (pick[b.dataset.inc] ?? 0) + 1; drawPledge(); }));
    app.querySelectorAll('[data-dec]').forEach((b) => b.addEventListener('click', () => { pick[b.dataset.dec] = Math.max(0, (pick[b.dataset.dec] ?? 0) - 1); drawPledge(); }));
    $('#pledge').querySelectorAll('[data-help]').forEach((b) => b.addEventListener('click', () => help(b.dataset.help)));
    app.querySelectorAll('[data-for]').forEach((b) => b.addEventListener('click', () => { forRider = b.dataset.for === 'me' ? null : b.dataset.for; drawPledge(); }));
    $('#askHelp')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        append([(await api(`/api/lobbies/${lid}/help`, {})).message]);
        toast('🙋 Sent');
      } catch (err) {
        $('#pledgeErr').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
      }
      e.target.disabled = false;
    });
    $('#doPledge')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const eggs = Object.fromEntries(Object.entries(pick).filter(([, c]) => c > 0));
        const r = await api(`/api/lobbies/${lid}/pledge`, { eggs, ...(forRider && { for: forRider }) });
        lobby = r.lobby;
        for (const k of Object.keys(pick)) delete pick[k];
        if (r.reached) notifyPlayer('🏆', `+${lobby.bonus}${lobby.ridersList.find((x) => x.you)?.donatedEggs ? ` · 🎁 +${lobby.donorBonus * lobby.ridersList.find((x) => x.you).donatedEggs}` : ''}`, `#/lobby/${lid}`);
        else toast(r.donated ? `🎁 +${r.points}` : `+${r.points}`);
        forRider = null;
        drawPledge();
        redrawHelpCards();
        refreshHud(true);
      } catch (err) {
        drawPledge();
        $('#pledgeErr').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
      }
    });
  }
  wirePledge();
  // Help cards in the chat follow the riders' current totals.
  const redrawHelpCards = () => {
    for (const m of chat.messages.filter((x) => x.help)) {
      const el = feed.querySelector(`[data-id="${CSS.escape(m.id)}"]`);
      if (el) el.outerHTML = msgHtml(m);
    }
  };
  feed.addEventListener('click', (e) => {
    const b = e.target.closest('[data-help]');
    if (b) help(b.dataset.help);
  });

  const send = async (body) => {
    try {
      append([(await api(`/api/lobbies/${lid}/messages`, body)).message]);
      $('#sayErr').innerHTML = '';
      return true;
    } catch (err) {
      $('#sayErr').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
      return false;
    }
  };
  $('#say')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#sayText');
    if (!input.value.trim()) return;
    if (await send({ text: input.value })) input.value = '';
  });
  app.querySelectorAll('[data-sticker]').forEach((b) => b.addEventListener('click', () => send({ sticker: b.dataset.sticker })));
  feed.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-report]');
    if (!b || !confirm('Report this message? It disappears for you now, and for everyone after 3 reports.')) return;
    try {
      await api(`/api/lobbies/${lid}/messages/${encodeURIComponent(b.dataset.report)}/report`, {});
      b.closest('.msg')?.remove();
      toast('Reported. Thanks.');
    } catch (err) {
      toast(err.message);
    }
  });

  // Poll: new messages every 4 s, the pledge meter every 8 s.
  let tick = 0;
  every(4000, async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      append((await api(`/api/lobbies/${lid}/messages?after=${chat.lastSeq}`)).messages);
      if (++tick % 2 === 0) {
        const fresh = (await api(`/api/lobbies/${lid}`)).lobby;
        const sig = (l) => JSON.stringify([l.status, l.ridersList.map((r) => [r.id, r.pledged]), l.stash.points]);
        const changed = sig(fresh) !== sig(lobby);
        const justReached = fresh.status === 'reached' && lobby.status === 'open';
        lobby = fresh;
        if (changed) {
          drawPledge();
          redrawHelpCards();
        }
        if (justReached) notifyPlayer('🏆', `+${lobby.bonus}`, `#/lobby/${lid}`);
        if (fresh.status === 'ended') render();
      }
    } catch {
      /* next tick */
    }
  });
}

function startAlerts() {
  if (state.alerting) return;
  state.alerting = true;
  loc.subs.add(checkArrival); // stays on for the whole visit, not just one page
  setInterval(checkTrain, TRAIN_CHECK_MS);
  setTimeout(checkTrain, 3000);
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
  drawTrainBar();
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
  [/^#\/train$/, viewTrain],
  [/^#\/lobby\/([^/]+)$/, (id) => viewLobby(id)],
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
  if (!state.user.email) {
    $('#tabs').hidden = true;
    drawHud();
    return viewAddEmail();
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
      </div>
      <div class="tk-perf" aria-hidden="true"></div>
      <div class="tk-bottom stack">
        <div class="seg" role="tablist">
          <button type="button" role="tab" data-mode="register" aria-selected="${registering}">Create account</button>
          <button type="button" role="tab" data-mode="login" aria-selected="${!registering}">Sign in</button>
        </div>
        ${registering ? `<label class="field-label" for="email">Email</label>
        <input id="email" class="input" type="email" maxlength="254" autocomplete="email" autocapitalize="none" inputmode="email" required />` : ''}
        <label class="field-label" for="username">${registering ? 'Username' : 'Username or email'}</label>
        <input id="username" class="input" maxlength="${registering ? 20 : 254}" autocomplete="username" autocapitalize="none" required />
        <label class="field-label" for="password">Password</label>
        <input id="password" class="input" type="password" maxlength="200" ${registering ? `minlength="${min}" placeholder="At least ${min} characters"` : ''} autocomplete="${registering ? 'new-password' : 'current-password'}" required />
        <button class="btn btn-ink btn-block btn-l">${registering ? 'Start playing' : 'Sign in'}</button>
        <div id="err"></div>
      </div>
    </form>`;
  app.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => viewSignup(b.dataset.mode)));
  $('#auth').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#auth .btn-ink');
    btn.disabled = true;
    try {
      const data = await api(registering ? '/api/auth/register' : '/api/auth/login', {
        username: $('#username').value,
        password: $('#password').value,
        ...(registering && { email: $('#email').value }),
      });
      setSession(data);
      startLocation();
      if (registering && data.user.chatName) toast(`Your chat name is ${data.user.chatName}`, 3600);
      if (location.hash && location.hash !== '#/' && !location.hash.startsWith('#/join/')) location.hash = '#/';
      else render();
    } catch (err) {
      $('#err').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
      btn.disabled = false;
    }
  });
}

// Accounts made before emails were required add one before they keep playing.
function viewAddEmail() {
  app.innerHTML = `
    <form id="emailForm" class="tk welcome">
      ${BAND_LINES}
      <div class="tk-top">
        <h1 class="welcome-h">Add your email</h1>
        <p class="welcome-p">Every Lookout account is now linked to an email. It stays private, and you can sign in with it.</p>
      </div>
      <div class="tk-perf" aria-hidden="true"></div>
      <div class="tk-bottom stack">
        <label class="field-label" for="email">Email</label>
        <input id="email" class="input" type="email" maxlength="254" autocomplete="email" autocapitalize="none" inputmode="email" required />
        <button class="btn btn-ink btn-block btn-l">Save and keep playing</button>
        <button id="emailOut" class="btn btn-ghost btn-block" type="button">Sign out</button>
        <div id="err"></div>
      </div>
    </form>`;
  $('#emailOut').addEventListener('click', () => signOut({ remote: true }));
  $('#emailForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#emailForm .btn-ink');
    btn.disabled = true;
    try {
      const { user } = await api('/api/me/email', { email: $('#email').value });
      setSession({ user: { ...state.user, ...user }, token: state.token });
      render();
    } catch (err) {
      $('#err').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
      btn.disabled = false;
    }
  });
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

// ---------- next trains, both directions ----------
// One row per line and direction at a station: where it goes, the next train, and the two after it.
// Green Line branches share a row per direction (each train shows its own branch).
const minsText = (sec) => (sec < 60 ? 'Now' : `${Math.round(sec / 60)} min`);
function trainRows(trains) {
  const rows = new Map();
  for (const t of trains) {
    if (t.seconds <= -20) continue;
    const fam = family(t.routeId);
    const key = `${fam}|${t.directionId ?? t.headsign}`;
    if (!rows.has(key)) rows.set(key, { fam, color: t.color, dirName: t.directionName, destination: t.destination, trains: [] });
    rows.get(key).trains.push(t);
  }
  const order = { Red: 0, Mattapan: 1, Orange: 2, Blue: 3, Green: 4 };
  return [...rows.values()].sort((a, b) => (order[a.fam] ?? 9) - (order[b.fam] ?? 9) || String(a.dirName).localeCompare(String(b.dirName)));
}
function trainBoardHtml(trains, error) {
  const rows = trainRows(trains);
  if (!rows.length) return `<p class="dirs-none">${esc(trainsUnavailable(error))}</p>`;
  return `<ul class="dirs">${rows
    .map((r) => {
      const [next, ...more] = r.trains;
      const green = r.fam === 'Green';
      const bound = r.dirName ? `${r.dirName}bound` : '';
      const title = green ? bound || 'Green Line' : r.destination || next.headsign || r.fam;
      const branch = (t) => (green && /^Green-[A-E]$/.test(t.routeId) ? `${t.routeId.slice(-1)} ` : '');
      const sub = [
        green ? `${branch(next)}${next.headsign}` : next.headsign && next.headsign !== title ? `To ${next.headsign}` : bound,
        more.length ? `then ${more.slice(0, 2).map((t) => (green ? `${branch(t)}${minsText(t.seconds)}` : minsText(t.seconds))).join(', ')}` : '',
      ].filter(Boolean).join(', ');
      return `<li style="--ln:${esc(r.color)}">
        <span class="route" aria-hidden="true"></span>
        <div class="dirs-txt"><p class="dirs-to">${esc(title)}</p>${sub ? `<p class="dirs-sub">${esc(sub)}</p>` : ''}</div>
        <p class="dirs-min">${next.seconds < 60 ? '<span class="now">Now</span>' : `${Math.round(next.seconds / 60)}<small>min</small>`}</p>
      </li>`;
    })
    .join('')}</ul>`;
}
// Fills `box` with the station's board and refreshes it every 30 s while the page is open.
function startTrainBoard(box, stationId) {
  if (!box) return;
  const load = async () => {
    if (!box.isConnected) return;
    try {
      const { trains, error } = await api(`/api/stations/${encodeURIComponent(stationId)}/predictions`);
      box.innerHTML = trainBoardHtml(trains, error);
    } catch (err) {
      box.innerHTML = trainBoardHtml([], err.message);
    }
  };
  load();
  every(30_000, load);
}
const TRAIN_BOARD = '<div class="train-board" aria-live="polite"><p class="next-label">Next trains</p><div id="next"><p class="dirs-none">Loading live times</p></div></div>';

const BAND_LINES = '<div class="band band-lines" aria-hidden="true"><i style="--ln:var(--line-red)"></i><i style="--ln:var(--line-orange)"></i><i style="--ln:var(--line-blue)"></i><i style="--ln:var(--line-green)"></i></div>';

function showLocating(stations) {
  const msg = {
    idle: ['Finding your station', ''],
    locating: ['Finding your station', ''],
    denied: ['Location is off', 'Turn it on in your browser settings, or pick a station below.'],
    unavailable: ['No location yet', 'Try near the entrance, or pick a station below.'],
    insecure: ['Pick your station', 'Location needs the https:// link.'],
  }[loc.status] ?? ['Pick your station', ''];
  const canRetry = loc.status === 'denied' || loc.status === 'unavailable';
  app.innerHTML = `
    <section class="tk locate">
      ${BAND_LINES}
      <div class="tk-top">
        ${loc.status === 'locating' ? '<div class="spin" aria-hidden="true"></div>' : ''}
        <h1 class="locate-h">${esc(msg[0])}</h1>
        ${msg[1] ? `<p class="locate-p">${esc(msg[1])}</p>` : ''}
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
        ${TRAIN_BOARD}
        <a class="btn btn-primary btn-block" href="#/station/${encodeURIComponent(n.station.id)}">See ${esc(n.station.name)}</a>
        <a class="btn btn-ghost btn-block" href="#/map">Open the map</a>
      </div>
    </section>
    <h2 class="sec-h">Stations near you</h2>
    ${stationSearch()}`;
  wireStationSearch(stations);
  startTrainBoard($('#next'), n.station.id);
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
  app.innerHTML = `<h1 class="page-h">Stations</h1>${stationSearch()}`;
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
        ${TRAIN_BOARD}
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
    <ol class="stubs">${stubsHtml(slots)}</ol>`;

  app.querySelectorAll('[data-play]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (btn.getAttribute('aria-disabled') === 'true') return;
      btn.setAttribute('aria-disabled', 'true');
      const slot = slots.find((s) => s.egg?.id === btn.dataset.play);
      try {
        const round = await api('/api/attempts', { eggId: btn.dataset.play });
        state.play = { ...round, station, receivedAt: performance.now(), result: null, firstChance: slot?.egg?.timesFound === 0 };
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

  startTrainBoard($('#next'), id);

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

// Stamp text size: as big as fits, so a long word ("Impossible", "Massachusetts") stays whole
// on one line and a long name ("Boston University Central") fits in the circle.
function sealFont(name) {
  const inner = 58; // px of text width inside an 80px stamp
  const words = name.split(/\s+/);
  const longest = Math.max(...words.map((w) => w.length));
  const byWord = inner / (longest * 0.55);
  const byLines = 46 / (Math.min(words.length, 3) * 1.1); // up to 3 lines tall
  return Math.max(8, Math.min(13.5, byWord, byLines)).toFixed(1);
}

// Eggs you can play first, then yours and ones you've found; empty slots fold into one row.
function stubsHtml(slots) {
  const rank = (s) => (!s.egg ? 3 : s.egg.mine || s.egg.foundByMe ? 2 : 1);
  const filled = slots.filter((s) => s.egg).sort((a, b) => rank(a) - rank(b) || a.level - b.level);
  const empty = slots.filter((s) => !s.egg);
  const emptyRow = empty.length
    ? `<li class="stub-empties">
        <p><b>${empty.length === slots.length ? 'No eggs here yet.' : `${plural(empty.length, 'empty slot')}.`}</b> Hide one for other riders to find.</p>
        <div class="hide-chips">${empty.map((s) => `<button class="hide-chip" type="button" data-hide="${s.level}"><b>${s.level}</b>${esc(s.name)}<span class="hide-pts">${s.points}</span></button>`).join('')}</div>
      </li>`
    : '';
  return filled.map((s) => stubRow(s)).join('') + emptyRow;
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
  // A running clock keeps ticking here too: leaving the round doesn't pause it.
  const meta = egg.clock
    ? `Your clock is running: <span data-ends="${Date.now() + egg.clock.secondsLeft * 1000}">${fmtClock(egg.clock.secondsLeft)}</span> left.`
    : egg.retry
      ? 'Retry · no time bonus'
      : hot ? `${mins}. Nobody's found it yet.` : `${mins}, found ${plural(egg.timesFound, 'time')}`;
  return `<li class="stub is-open ${hot || egg.clock ? 'is-hot' : ''}">
    <span class="punch" aria-hidden="true">${slot.level}</span>
    <div class="stub-body"><p class="stub-name">${esc(slot.name)}</p>${pips}<p class="stub-meta">${meta}</p></div>
    <button class="stub-act" type="button" data-play="${egg.id}"><b>${slot.points}</b><span>${egg.clock ? 'Resume' : egg.retry ? 'Retry' : 'Play'}</span></button>
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
  const tag = play.firstChance ? 'Nobody has found this yet' : '';

  app.innerHTML = `
    <div class="play-bar">
      <a class="icon-btn" href="#/station/${encodeURIComponent(egg.stationId)}" id="quitX" aria-label="Leave for now. Your clock keeps running."><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></a>
      <p class="play-title"><b>${esc(egg.levelName)}</b> at ${esc(egg.stationName)}</p>
      <p class="mypts mypts-here"><b>${egg.points}</b> pts</p>
    </div>
    <section class="tk play-tk">
      <div class="tk-top">
        <div class="egg-photo">
          <img src="${apiUrl(egg.imageUrl)}" alt="The egg to find: ${egg.name ? esc(egg.name) : 'a photo of something in this station'}" />
          ${tag ? `<p class="first-tag">${esc(tag)}</p>` : ''}
          ${egg.blur ? `<p class="blur-tag">${egg.blur === 'heavy' ? 'Heavily blurred' : 'Blurred'}: ${esc(egg.levelName)}</p>` : ''}
        </div>
        ${egg.name ? `<p class="hint"><b>Find</b> ${esc(egg.name)}</p>` : ''}
        ${egg.hint ? `<p class="hint"><b>Hint</b> ${esc(egg.hint)}</p>` : ''}
      </div>
      <div class="tk-perf" aria-hidden="true"></div>
      <div class="tk-bottom">
        <div class="clock-row">
          <p id="clock" class="clock">${fmtClock(secondsLeft())}</p>
          <div class="bonus"><p class="bonus-label">${attempt.retry ? 'Retry: no bonus' : 'Bonus right now'}</p><p class="bonus-val">+<span id="bonus">0</span></p></div>
        </div>
        <ol id="holes" class="punchclock" aria-hidden="true">${'<li></li>'.repeat(PUNCH_HOLES)}</ol>
        ${attempt.retry ? '<p class="clock-ctx">Retry · no time bonus</p>' : ''}
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
      play.myPhoto = image; // the "after" photo on the result screen
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
        </div>
      </section>
      <a class="btn btn-ink btn-block btn-l" href="${back}">Try another level</a>`;
    state.play = null;
    // Tell the server the round is over. If this fails, the round still runs out on its own a moment later.
    try {
      await api(`/api/attempts/${play.attempt.id}/end`, {});
    } catch {
      /* nothing to show */
    }
    return;
  }

  const { points } = result;
  app.innerHTML = `
    <section class="tk win">
      <div class="tk-top">
        <h1 class="win-head">${result.firstFind ? 'Found it first' : 'Found it'}</h1>
        <p class="win-pts">+<span id="count">${points.total}</span></p>
        <p class="win-sub">Image approved, good job!</p>
      </div>
    </section>
    <section class="match-pair" aria-label="Before and after">
      <figure class="m"><img src="${apiUrl(result.revealUrl || egg.imageUrl)}" alt="The egg when it was hidden" /><figcaption>Before</figcaption></figure>
      ${play.myPhoto ? `<figure class="m"><img src="${play.myPhoto}" alt="Your photo of it" /><figcaption>After</figcaption></figure>` : ''}
    </section>
    <section class="next-egg">
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

  // The find changed your points, rank and stamps: refresh them for the other screens.
  refreshHud(true);
  refreshProgress();
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
          <p class="photo-empty">Photograph something small in ${esc(hide.stationName)}</p>
        </div>
        <label class="btn btn-ghost btn-block" id="pick">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>
          <span id="pickText">Take the photo</span>
          <input id="cam" class="file-hidden" type="file" accept="image/*" capture="environment" />
        </label>
      </div>
      <div class="tk-perf" aria-hidden="true"></div>
      <div class="tk-bottom">
        <label class="field-label" for="eggName">What is it?</label>
        <input id="eggName" class="input" maxlength="40" required placeholder="e.g. sticker, red sign, cracked tile" />
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
    const name = $('#eggName').value.trim();
    if (name.length < 2) {
      $('#err').innerHTML = '<div class="notice bad">Say what it is, like "sticker" or "red sign".</div>';
      $('#eggName').focus();
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Checking your photo';
    $('#err').innerHTML = '';
    try {
      await api('/api/eggs', { stationId: hide.stationId, level: hide.level, findId: hide.findId, name, hint: $('#hint').value, image });
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
    ? `<h1 class="page-h">${esc(monthLabel)}</h1><p class="page-sub">Resets ${esc(resetLabel)}</p>`
    : '<h1 class="page-h">All time</h1>');

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
      box.innerHTML = '<div class="empty"><p>No finds yet</p></div>';
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

// ---------- egg art ----------
// One egg per level, more attractive as the level goes up: Easy a plain sky-blue egg, Medium a
// speckled mint one, Hard a painted violet one, Extreme gold, Impossible platinum (the finest).
// Inline SVG (no image files). Gradient ids get a unique prefix so many eggs can share a page.
const EGG_PATH = 'M50 5C26 5 9 47 9 76c0 27 18 44 41 44s41-17 41-44C91 47 74 5 50 5z';
let eggSeq = 0;
function eggSvg(level, { size = 64, title = '' } = {}) {
  const u = `eg${++eggSeq}`;
  const wrap = (defs, body) =>
    `<svg class="egg-art" viewBox="0 0 100 125" width="${size}" height="${size * 1.25}" role="img" aria-label="${esc(title)}"><defs>${defs}</defs>${body}</svg>`;
  const shine = `<ellipse cx="34" cy="38" rx="9" ry="17" fill="#fff" opacity=".55" transform="rotate(-18 34 38)"/>`;
  switch (level) {
    case 1: // Easy: a plain, soft sky-blue egg
      return wrap(
        `<radialGradient id="${u}a" cx="38%" cy="32%" r="78%"><stop offset="0" stop-color="#eaf6ff"/><stop offset=".6" stop-color="#9fd3f5"/><stop offset="1" stop-color="#5fa8d8"/></radialGradient>`,
        `<path d="${EGG_PATH}" fill="url(#${u}a)" stroke="#4a8fbf" stroke-width="2"/>${shine}`,
      );
    case 2: // Medium: a mint-green egg with speckles
      return wrap(
        `<radialGradient id="${u}a" cx="38%" cy="32%" r="78%"><stop offset="0" stop-color="#eefcf3"/><stop offset=".6" stop-color="#8fdcae"/><stop offset="1" stop-color="#3fae73"/></radialGradient>`,
        `<path d="${EGG_PATH}" fill="url(#${u}a)" stroke="#2f8f5b" stroke-width="2"/>
         ${[[60, 40, 2.6], [42, 60, 2.2], [67, 72, 3], [35, 86, 2.4], [57, 98, 2.1], [73, 52, 1.8], [47, 30, 1.7], [29, 70, 1.6], [50, 80, 1.9], [70, 92, 1.6]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#1f6f45" opacity=".55"/>`).join('')}
         ${shine}`,
      );
    case 3: // Hard: a painted violet egg with a zigzag band and polka dots
      return wrap(
        `<radialGradient id="${u}a" cx="38%" cy="32%" r="78%"><stop offset="0" stop-color="#f4ecff"/><stop offset=".55" stop-color="#b58cf0"/><stop offset="1" stop-color="#7448c2"/></radialGradient>`,
        `<path d="${EGG_PATH}" fill="url(#${u}a)" stroke="#5b34a6" stroke-width="2"/>
         <path d="M11 70l8-7 8 7 8-7 8 7 7-7 8 7 8-7 8 7 8-7 8 7 9-7" fill="none" stroke="#ffd43b" stroke-width="5" stroke-linejoin="round"/>
         <path d="M12 82l8-7 8 7 8-7 8 7 7-7 8 7 8-7 8 7 8-7 8 7 8-7" fill="none" stroke="#fff" stroke-width="3" stroke-linejoin="round" opacity=".85"/>
         ${[[40, 36], [60, 32], [50, 50], [30, 54], [70, 54], [38, 100], [62, 100], [50, 110]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.6" fill="#ffd43b" stroke="#fff" stroke-width="1"/>`).join('')}
         ${shine}`,
      );
    case 4: // Extreme: gold, with a jewelled band
      return wrap(
        `<linearGradient id="${u}a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff3b8"/><stop offset=".35" stop-color="#f0c33c"/><stop offset=".65" stop-color="#b8860b"/><stop offset="1" stop-color="#f5d469"/></linearGradient>
         <linearGradient id="${u}b" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8a6205"/><stop offset=".5" stop-color="#fff0a8"/><stop offset="1" stop-color="#8a6205"/></linearGradient>`,
        `<path d="${EGG_PATH}" fill="url(#${u}a)" stroke="#7a5604" stroke-width="2"/>
         <path d="M11 68c25 9 53 9 78 0v8c-25 9-53 9-78 0z" fill="url(#${u}b)"/>
         ${[[30, 73], [50, 76], [70, 73]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.6" fill="#d7263d" stroke="#fff3b8" stroke-width=".8"/>`).join('')}
         ${shine}
         <path class="egg-spark" d="M80 18l1.6 4.4L86 24l-4.4 1.6L80 30l-1.6-4.4L74 24l4.4-1.6z" fill="#fff"/>`,
      );
    default: // Impossible: platinum, the finest egg: twin bands, a diamond, sparkles and a glow
      return wrap(
        `<linearGradient id="${u}a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".3" stop-color="#e3e8ee"/><stop offset=".55" stop-color="#9aa5b3"/><stop offset=".75" stop-color="#f2f5f8"/><stop offset="1" stop-color="#b9c2ce"/></linearGradient>
         <linearGradient id="${u}b" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7d8794"/><stop offset=".5" stop-color="#ffffff"/><stop offset="1" stop-color="#7d8794"/></linearGradient>
         <linearGradient id="${u}d" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e9fbff"/><stop offset=".5" stop-color="#8fd8ff"/><stop offset="1" stop-color="#c7b6ff"/></linearGradient>
         <radialGradient id="${u}g" cx="50%" cy="55%" r="55%"><stop offset=".62" stop-color="#cfe4ff" stop-opacity=".7"/><stop offset="1" stop-color="#cfe4ff" stop-opacity="0"/></radialGradient>`,
        `<ellipse cx="50" cy="68" rx="49" ry="58" fill="url(#${u}g)"/>
         <path d="${EGG_PATH}" fill="url(#${u}a)" stroke="#6b7480" stroke-width="2"/>
         <path d="M12 62c25 8 51 8 76 0v5c-25 8-51 8-76 0zM10 84c26 9 54 9 80 0v5c-26 9-54 9-80 0z" fill="url(#${u}b)" opacity=".95"/>
         <path d="M50 64l7 9-7 10-7-10z" fill="url(#${u}d)" stroke="#6b7480" stroke-width="1"/><path d="M43 73h14M50 64v19" stroke="#fff" stroke-width=".6" opacity=".8"/>
         ${shine}<ellipse cx="66" cy="100" rx="5" ry="9" fill="#fff" opacity=".35" transform="rotate(-25 66 100)"/>
         ${[[80, 20, 6], [20, 28, 4], [88, 58, 4], [14, 100, 3]].map(([x, y, r]) => `<path class="egg-spark" d="M${x} ${y - r}L${x + r * 0.28} ${y - r * 0.28} ${x + r} ${y} ${x + r * 0.28} ${y + r * 0.28} ${x} ${y + r} ${x - r * 0.28} ${y + r * 0.28} ${x - r} ${y} ${x - r * 0.28} ${y - r * 0.28}z" fill="#fff" stroke="#c5ccd6" stroke-width=".6"/>`).join('')}`,
      );
  }
}

// The egg collection: every level's egg with how many you've found. Unfound ones are shadows.
function eggShelf(findsByLevel, { mine = true } = {}) {
  const levels = state.config?.levels ?? [];
  if (!levels.length || !findsByLevel) return '';
  const total = levels.reduce((n, l) => n + (findsByLevel[l.name] ?? 0), 0);
  return `<section class="tk egg-shelf" aria-label="Egg collection">
    <div class="tk-top shelf-top">
      <div><p class="here">Egg collection</p><p class="shelf-total"><b>${total}</b> ${total === 1 ? 'egg' : 'eggs'} found</p></div>
      ${eggSvg(Math.max(1, ...levels.filter((l) => findsByLevel[l.name]).map((l) => l.level)), { size: 40, title: 'Best egg found' })}
    </div>
    <div class="tk-perf" aria-hidden="true"></div>
    <ol class="shelf">${levels
      .map((l) => {
        const n = findsByLevel[l.name] ?? 0;
        return `<li class="shelf-egg lv-${l.level} ${n ? '' : 'is-none'}">
          <div class="shelf-pic">${eggSvg(l.level, { size: 52, title: `${l.name} egg` })}${n ? `<span class="shelf-n">×${n}</span>` : ''}</div>
          <p class="shelf-name">${esc(l.name)}</p>
          <p class="shelf-sub">${n ? plural(n, 'find') : mine ? 'Not yet' : '–'}</p>
        </li>`;
      })
      .join('')}</ol>
  </section>`;
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
    : '<div class="empty"><p>No finds yet</p></div>';
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
      : a.type === 'hid' ? ['📍', `Hid ${anA(a.levelName)} ${esc(a.levelName)} egg at ${at(a)}`]
      : a.type === 'egg_found' ? ['👀', `<b>${esc(a.by)}</b> found your ${esc(a.levelName)} egg at ${at(a)}`]
      : a.type === 'joined_group' ? ['👥', `Joined <a href="#/group/${encodeURIComponent(a.groupId)}">${esc(a.groupName)}</a>`]
      : ['🎟️', 'Joined Lookout'];
    return `<li><span class="act-ic" aria-hidden="true">${icon}</span><p>${text}<small>${fmtWhen(a.at)}</small></p>${pts ? `<b class="act-pts">${pts}</b>` : ''}</li>`;
  };
  // Its own scroll box, so a long history doesn't stretch the whole profile page.
  return `<div class="activity-scroll" tabindex="0" aria-label="Activity"><ol class="activity">${items.map(row).join('')}</ol></div>`;
}

// Username (public: leaderboards, profile) and chat name (anonymous: group chats only).
function namesCard(user) {
  return `<section class="tk names">
    <div class="name-row">
      <div><p class="next-label">Username</p><p class="name-val">${esc(user.username)}</p></div>
      <button class="link" type="button" data-edit="username">Change</button>
    </div>
    <div class="tk-perf" aria-hidden="true"></div>
    <div class="name-row">
      <div><p class="next-label">Anonymous chat name</p><p class="name-val">${esc(user.chatName ?? '')}</p></div>
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
      </div>
    </section>
    ${eggShelf(p.findsByLevel)}
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
      .map((s) => `<li class="st ${s.earned ? 'is-got' : ''}"><span class="st-seal" style="font-size:${sealFont(s.name)}px">${esc(s.name)}</span><p>${s.earned || s.target === 1 ? esc(s.description) : `${esc(s.description)} ${s.progress} of ${s.target}.`}</p></li>`)
      .join('')}${progress.stations
      .map((s) => `<li class="st is-got"><span class="st-seal st-station" style="--ln:${LINE_VAR[s.lines[0]] ?? 'var(--stamp)'};font-size:${sealFont(s.name)}px">${esc(s.name)}</span><p>${plural(s.finds, 'find')} here</p></li>`)
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
      <div class="tk-top"><h1 class="page-h">${esc(p.user.username)}</h1><p class="page-sub">${p.monthRank ? `${ordinal(p.monthRank)} this month` : 'Not on the board yet this month'}</p></div>
      <div class="tk-perf" aria-hidden="true"></div>
      <dl class="tk-bottom mini-stats">
        <div><dt>This month</dt><dd>${p.monthPoints}</dd></div>
        <div><dt>All time</dt><dd>${p.allTimePoints}</dd></div>
        <div><dt>Eggs hidden</dt><dd>${p.eggsHidden}</dd></div>
        <div><dt>Found by others</dt><dd>${p.timesYourEggsWereFound}</dd></div>
      </dl>
    </section>
    ${eggShelf(p.findsByLevel, { mine: false })}
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
      : `<li class="nt-egg"><img src="${apiUrl(n.photoUrl)}" alt="Your egg at ${esc(n.stationName)}" loading="lazy" /><p>You hid ${anA(n.levelName)} ${esc(n.levelName)} egg${n.name ? ` (${esc(n.name)})` : ''} at ${at(n)}${n.hint ? `<small>Hint: ${esc(n.hint)}</small>` : ''}<small>${fmtWhen(n.at)} · ${EGG_STATUS[n.status] ?? esc(n.status)} · ${n.timesFound ? `found ${plural(n.timesFound, 'time')}` : 'not found yet'}</small></p></li>`;
  const ask = 'Notification' in window && Notification.permission === 'default';
  app.innerHTML = `
    <h1 class="page-h">Notifications</h1>
    <div class="map-tally nt-tally">
      <p><b>${c.finds}</b>${c.finds === 1 ? 'egg' : 'eggs'} you found</p>
      <p><b>${c.eggsHidden}</b>${c.eggsHidden === 1 ? 'egg' : 'eggs'} you hid</p>
      <p><b>${c.foundByOthers}</b>${c.foundByOthers === 1 ? 'time' : 'times'} others found yours</p>
    </div>
    ${ask ? '<div class="nt-ask"><button id="allow" class="btn btn-ghost" type="button">🔔 Turn on alerts</button></div>' : ''}
    ${data.items.length
      ? `<div class="activity-scroll" tabindex="0" aria-label="Notifications"><ol class="activity nt-list">${data.items.map(row).join('')}</ol></div>`
      : '<div class="empty"><p>No eggs yet</p><a class="btn btn-ghost" href="#/">Find a station</a></div>'}`;
  $('#allow')?.addEventListener('click', async () => {
    const r = await Notification.requestPermission().catch(() => 'denied');
    toast(r === 'granted' ? 'Alerts on' : 'Alerts off');
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
      ${m.text != null ? `<p class="msg-text">${esc(m.text)}</p>` : `<span class="msg-emoji" aria-hidden="true">${esc(m.emoji)}</span>
      <p class="msg-cap">${esc(m.label)}</p>`}
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
      : '<div class="empty"><p>Nothing yet. Start the trash talk.</p></div>'}</div></section>
    <form id="say" class="say"><input id="sayText" class="input" maxlength="140" placeholder="Message the group 😎" autocomplete="off" /><button class="btn btn-ink" type="submit">Send</button></form>
    <div id="sayErr"></div>
    <p class="chat-hint">Chatting as <b>${esc(state.user.chatName ?? 'anonymous')}</b> · <a href="#/profile">Change</a></p>
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
    const sendMessage = async (body) => {
      const { message } = await api(`/api/groups/${gid}/messages`, body);
      // Pick up anything others sent meanwhile, then ours, in order.
      const { messages } = await api(`/api/groups/${gid}/messages?after=${chat.lastSeq}`);
      appendMessages(messages.length ? messages : [message]);
    };
    app.querySelectorAll('[data-sticker]').forEach((b) =>
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await sendMessage({ sticker: b.dataset.sticker });
        } catch (err) {
          toast(err.message);
        } finally {
          b.disabled = false;
        }
      }),
    );
    $('#say')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('#sayText');
      if (!input.value.trim()) return;
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      try {
        await sendMessage({ text: input.value });
        input.value = '';
        $('#sayErr').innerHTML = '';
      } catch (err) {
        $('#sayErr').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
      } finally {
        btn.disabled = false;
        input.focus();
      }
    });
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

// --- track geometry: trains ride along the real route shapes ---
// A flat projection is plenty at Boston's scale: metres east and north.
const M_PER_LAT = 110_540;
const M_PER_LNG = 111_320 * Math.cos((42.35 * Math.PI) / 180);
const ON_TRACK_M = 120; // a reported position this close to a track is treated as on it
const MAX_GLIDE_M = 4_000; // further than this between reports is a jump (new trip, yard move), not a glide
const PLAYBACK_DELAY_MS = 25_000; // trains are replayed this far behind their reports, so there's always a next point to glide to
const VEHICLE_POLL_MS = 15_000; // matches the server's cache
const MAP_LINES = ['Red', 'Orange', 'Blue', 'Green'];

function buildTrack(routeId, points) {
  const xy = points.map(([lat, lng]) => [lng * M_PER_LNG, lat * M_PER_LAT]);
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  return { routeId, points, xy, cum, length: cum[cum.length - 1] };
}
function snapToTrack(track, lat, lng) {
  const px = lng * M_PER_LNG;
  const py = lat * M_PER_LAT;
  let best = null;
  for (let i = 0; i < track.xy.length - 1; i++) {
    const [ax, ay] = track.xy[i];
    const [bx, by] = track.xy[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const off = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (!best || off < best.off) best = { along: track.cum[i] + t * Math.sqrt(len2), off };
  }
  return best;
}
function pointOnTrack(track, along) {
  const d = Math.max(0, Math.min(track.length, along));
  let lo = 0;
  let hi = track.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track.cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const t = (d - track.cum[lo]) / (track.cum[hi] - track.cum[lo] || 1);
  const [la1, ln1] = track.points[lo];
  const [la2, ln2] = track.points[hi];
  const [ax, ay] = track.xy[lo];
  const [bx, by] = track.xy[hi];
  return { lat: la1 + (la2 - la1) * t, lng: ln1 + (ln2 - ln1) * t, bearing: (Math.atan2(bx - ax, by - ay) * 180) / Math.PI };
}
// Leaflet rounds map positions to whole pixels, which makes slow trains step a pixel at a time.
// This is the same conversion without the rounding.
function subpixelPoint(map, lat, lng, zoom = map.getZoom(), origin = map.getPixelOrigin(), topLeft = map.containerPointToLayerPoint([0, 0])) {
  const pt = map.project([lat, lng], zoom);
  return { x: pt.x - origin.x - topLeft.x, y: pt.y - origin.y - topLeft.y };
}

// All trains drawn on one canvas. Each train is drawn from above as linked cars laid along the track,
// so it bends through curves like the real thing: heavy rail runs 3 cars, Green Line light rail 2, the Mattapan trolley 1.
// Speed: each car is painted once into a small image and reused, and the canvas sits in map coordinates
// with a margin around the screen, so panning moves it with the map instead of redrawing it.
const CARS = { Red: 3, Orange: 3, Blue: 3, Green: 2, Mattapan: 1 };
const DIR_MIN_M = 25; // smaller moves don't set a facing direction
const BACKSTEP_M = 400; // within a trip, a report this far behind the last one is noise, not the train reversing
const TRAIN_PAD = 0.35; // canvas margin around the screen, as a share of its size

function metresPerPixel(map) {
  return (40_075_016.686 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** (map.getZoom() + 8);
}

// One car, painted pointing right (+x = forward) into its own small canvas.
function paintCar(color, len, width, cabFront, cabBack, style, dpr) {
  const o = 1.8; // cream outline
  const sh = 1.4; // shadow drop
  const w = len + o * 2 + 2;
  const h = width + o * 2 + sh + 2;
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * dpr);
  c.height = Math.ceil(h * dpr);
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.translate(w / 2, (width + o * 2 + 2) / 2);
  const r = width / 2;
  const nose = (cab) => (cab ? r * 0.9 : r * 0.3);
  const radii = [nose(cabBack), nose(cabFront), nose(cabFront), nose(cabBack)];
  ctx.fillStyle = style.shadow;
  ctx.beginPath();
  ctx.roundRect(-len / 2 - o, -r - o + sh, len + o * 2, width + o * 2, radii.map((x) => x + o));
  ctx.fill();
  ctx.fillStyle = style.casing;
  ctx.beginPath();
  ctx.roundRect(-len / 2 - o, -r - o, len + o * 2, width + o * 2, radii.map((x) => x + o));
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(-len / 2, -r, len, width, radii);
  ctx.fill();
  ctx.fillStyle = style.glass;
  if (len >= 10) {
    const start = -len / 2 + (cabBack ? r * 0.9 : r * 0.45);
    const stop = len / 2 - (cabFront ? r * 1.2 : r * 0.45);
    const win = Math.max(1.2, width * 0.22);
    for (let x = start; x + win <= stop + 0.01; x += win * 1.9) {
      ctx.fillRect(x, -r + width * 0.14, win, width * 0.2);
      ctx.fillRect(x, r - width * 0.34, win, width * 0.2);
    }
  }
  if (cabFront) {
    ctx.beginPath();
    ctx.roundRect(len / 2 - r * 0.95, -r * 0.6, r * 0.6, r * 1.2, r * 0.3);
    ctx.fill();
  }
  return { canvas: c, w, h, cy: (width + o * 2 + 2) / 2 };
}

function makeTrainLayer() {
  return L.Layer.extend({
    onAdd(map) {
      this._map = map;
      this._canvas = L.DomUtil.create('canvas', 'train-canvas');
      map.getPane('trains').appendChild(this._canvas);
      this._ctx = this._canvas.getContext('2d');
      this._sprites = new Map();
      map.on('moveend resize zoomend viewreset', this._reset, this);
      map.on('zoomstart', this._hide, this);
      this._reset();
    },
    onRemove(map) {
      map.off('moveend resize zoomend viewreset', this._reset, this);
      map.off('zoomstart', this._hide, this);
      this._canvas.remove();
    },
    _hide() {
      this._canvas.style.opacity = '0';
    },
    // Place the canvas over the screen plus a margin, in map (layer) coordinates.
    _reset() {
      const map = this._map;
      const size = map.getSize();
      const pad = size.multiplyBy(TRAIN_PAD).round();
      const origin = map.containerPointToLayerPoint([0, 0]).subtract(pad);
      const w = size.x + pad.x * 2;
      const h = size.y + pad.y * 2;
      const dpr = window.devicePixelRatio || 1;
      this._origin = origin;
      L.DomUtil.setPosition(this._canvas, origin);
      if (this._w !== w || this._h !== h) {
        this._canvas.width = w * dpr;
        this._canvas.height = h * dpr;
        this._canvas.style.width = `${w}px`;
        this._canvas.style.height = `${h}px`;
        this._w = w;
        this._h = h;
      }
      this._canvas.style.opacity = '1';
      this.draw(this._items ?? [], this._style);
    },
    _sprite(color, len, width, cabFront, cabBack, style, dpr) {
      const key = `${color}|${len.toFixed(1)}|${width.toFixed(1)}|${cabFront ? 1 : 0}${cabBack ? 1 : 0}|${dpr}`;
      let sp = this._sprites.get(key);
      if (!sp) {
        sp = paintCar(color, len, width, cabFront, cabBack, style, dpr);
        this._sprites.set(key, sp);
      }
      return sp;
    },
    draw(items, style) {
      this._items = items;
      this._style = style;
      const ctx = this._ctx;
      const map = this._map;
      if (!ctx || !map || !style || !this._origin) return;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this._w, this._h);
      const zoom = map.getZoom();
      const pixelOrigin = map.getPixelOrigin();
      const o = this._origin;
      // map position -> canvas position, without Leaflet's whole-pixel rounding
      const at = (lat, lng) => {
        const p = map.project([lat, lng], zoom);
        return { x: p.x - pixelOrigin.x - o.x, y: p.y - pixelOrigin.y - o.y };
      };
      const s = Math.max(0.7, Math.min(1.6, (zoom - 10) / 4)); // cars grow as you zoom in
      const carPx = Math.round(15 * s * 2) / 2;
      const gapPx = 2.4 * s;
      const width = Math.round(9 * s * 2) / 2;
      const mpp = metresPerPixel(map);
      const hits = [];
      for (const it of items) {
        const head = it.track ? pointOnTrack(it.track, it.along) : it;
        const hp = at(head.lat, head.lng);
        if (hp.x < -40 || hp.y < -40 || hp.x > this._w + 40 || hp.y > this._h + 40) continue;
        const n = it.cars;
        const parts = [];
        for (let i = 0; i < n; i++) {
          let F;
          let B;
          if (it.track) {
            const front = it.along - it.dir * i * (carPx + gapPx) * mpp;
            const back = front - it.dir * carPx * mpp;
            const pf = pointOnTrack(it.track, front);
            const pb = pointOnTrack(it.track, back);
            F = at(pf.lat, pf.lng);
            B = at(pb.lat, pb.lng);
          } else {
            const a = ((it.bearing - 90) * Math.PI) / 180;
            const off = i * (carPx + gapPx);
            F = { x: hp.x - Math.cos(a) * off, y: hp.y - Math.sin(a) * off };
            B = { x: F.x - Math.cos(a) * carPx, y: F.y - Math.sin(a) * carPx };
          }
          parts.push({ F, B, i });
        }
        if (it.selected) {
          // a thin ring around the whole train, so the line stays visible underneath
          const mx = parts.reduce((a, p) => a + (p.F.x + p.B.x) / 2, 0) / parts.length;
          const my = parts.reduce((a, p) => a + (p.F.y + p.B.y) / 2, 0) / parts.length;
          const rad = (n * (carPx + gapPx)) / 2 + 9;
          ctx.beginPath();
          ctx.arc(mx, my, rad, 0, Math.PI * 2);
          ctx.fillStyle = style.halo;
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = style.ring;
          ctx.stroke();
        }
        // draw back to front so the leading cab sits on top
        for (let k = parts.length - 1; k >= 0; k--) {
          const { F, B, i } = parts[k];
          const sp = this._sprite(it.color, carPx, width, i === 0, i === n - 1, style, dpr);
          ctx.save();
          ctx.translate((F.x + B.x) / 2, (F.y + B.y) / 2);
          ctx.rotate(Math.atan2(F.y - B.y, F.x - B.x));
          ctx.drawImage(sp.canvas, -sp.w / 2, -sp.cy, sp.w, sp.h);
          ctx.restore();
          hits.push({ id: it.id, x: (B.x + F.x) / 2, y: (B.y + F.y) / 2 });
        }
      }
      this.hits = hits;
    },
    // The train drawn nearest a point on the screen, if one is within reach of a finger.
    hit(x, y, reach = 18) {
      if (!this._origin) return null;
      const tl = this._map.containerPointToLayerPoint([0, 0]);
      const cx = x + tl.x - this._origin.x;
      const cy = y + tl.y - this._origin.y;
      let best = null;
      for (const h of this.hits ?? []) {
        const d = Math.hypot(h.x - cx, h.y - cy);
        if (d <= reach && (!best || d < best.d)) best = { id: h.id, d };
      }
      return best?.id ?? null;
    },
    // Where a train's cars were last drawn, in screen coordinates (for tests).
    screenHits() {
      if (!this._origin) return [];
      const tl = this._map.containerPointToLayerPoint([0, 0]);
      return (this.hits ?? []).map((h) => ({ id: h.id, x: h.x - tl.x + this._origin.x, y: h.y - tl.y + this._origin.y }));
    },
  });
}

async function viewMap() {
  loading('Loading the map');
  const [{ stations, totals }, , linesData, statsData] = await Promise.all([
    api('/api/stations'), // fresh counts, including how many eggs are still left for you
    loadLeaflet(),
    api('/api/map/lines').catch(() => ({ lines: [] })),
    api('/api/map/stations').catch(() => ({ stations: [] })),
  ]);
  state.stations = stations;
  const stats = new Map(statsData.stations.map((s) => [s.id, s]));
  // Eggs you can still find at each station (not yours, not already found). Only known when signed in.
  const leftFor = new Map(stations.map((s) => [s.id, s.playable]));
  const allFound = (id) => (stats.get(id)?.activeEggs ?? 0) > 0 && leftFor.get(id) === 0;
  const root = getComputedStyle(document.documentElement);
  const tok = (n) => root.getPropertyValue(n).trim();
  const motion = !reducedMotion();
  let filter = null;

  app.innerHTML = `
    <h1 class="page-h">Map</h1>
    <div class="map-tally map-totals" aria-label="Eggs on the T right now">
      <p><b>${totals.eggs}</b>${totals.eggs === 1 ? 'egg' : 'eggs'} hidden</p>
      <p><b>${totals.stationsWithEggs}</b>of ${totals.stations} stations</p>
      <p><b>${totals.playable ?? totals.eggs}</b>left for you</p>
    </div>
    <section class="tk map-tk">
      ${BAND_LINES}
      <div class="map-bar">
        <div class="chips" role="group" aria-label="Show a line">
          <button type="button" class="chip" data-line="" aria-pressed="true">All</button>
          ${MAP_LINES.map((l) => `<button type="button" class="chip" data-line="${l}" aria-pressed="false" style="--ln:${LINE_VAR[l]}"><i aria-hidden="true"></i>${l}</button>`).join('')}
        </div>
      </div>
      <div class="map-wrap">
        <div id="map" class="map"></div>
        <div id="sheet" class="map-sheet" hidden></div>
      </div>
      <div class="tk-perf" aria-hidden="true"></div>
      <div class="tk-bottom map-key">
        <ul class="legend">
          <li><span class="lg-stn has-eggs" style="--ln:var(--line-green)"><b>3</b></span>Eggs up</li>
          <li><span class="lg-stn has-eggs done" style="--ln:var(--line-blue)"><b>2</b></span>All found by you</li>
          <li><span class="lg-stn" style="--ln:var(--line-green)"></span>No eggs yet</li>
          <li><span class="lg-stn mine" style="--ln:var(--line-green)"></span>You found eggs here</li>
          <li><span class="lg-stn live" style="--ln:var(--line-green)"></span>Someone hunting now</li>
          <li><span class="lg-car" style="--ln:var(--line-red)"><i></i></span>Live train</li>
        </ul>
        <div class="key-row">
          <p class="map-foot" id="mapFoot">Connecting to live trains</p>
          <label class="map-toggle"><input type="checkbox" id="showTrains" checked /> Show trains</label>
        </div>
      </div>
    </section>`;

  const map = L.map('map', {
    zoomControl: false,
    zoomSnap: 0.5,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 100,
    attributionControl: true,
    fadeAnimation: false,
  });
  state.map = map;
  const lineRenderer = L.canvas({ padding: 0.4, tolerance: 6 });
  map.createPane('trains');
  map.getPane('trains').style.zIndex = 450; // over the lines, under the station markers
  map.getPane('trains').style.pointerEvents = 'none';
  L.control.zoom({ position: 'topright' }).addTo(map);
  // Esri's light gray canvas: quiet, almost no labels, and free to use without a key.
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxNativeZoom: 16,
    maxZoom: 18,
    updateWhenZooming: false,
    keepBuffer: 4,
    attribution: 'Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
  }).addTo(map);

  const Locate = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const b = L.DomUtil.create('button', 'map-locate');
      b.type = 'button';
      b.setAttribute('aria-label', 'Show where I am');
      b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7.5"/></svg>';
      L.DomEvent.disableClickPropagation(b);
      b.addEventListener('click', () => {
        if (loc.pos) map.flyTo([loc.pos.lat, loc.pos.lng], 15, { duration: motion ? 0.8 : 0 });
        else {
          startLocation();
          toast('Finding you. Allow location if your phone asks.');
        }
      });
      return b;
    },
  });
  new Locate().addTo(map);

  // The lines, on one canvas: a cream casing under a solid colour, like the T map.
  // Branches that share track (Green B/C/D/E, Red's Ashmont and Braintree) arrive as separate shapes a few
  // metres apart. Each later branch is pulled onto the track already drawn wherever they run together,
  // so there's one line there, and trains ride exactly on the line you see.
  const MERGE_M = 20;
  const tracks = new Map();
  const lineLayers = [];
  const allPts = [];
  const drawnByFamily = new Map(); // family -> tracks drawn so far
  const mergeOnto = (points, earlier) => {
    if (!earlier.length) return points;
    const out = [];
    let prev = null; // { track, along } of the previous point if it was pulled onto earlier track
    for (const [lat, lng] of points) {
      let best = null;
      for (const t of earlier) {
        const sn = snapToTrack(t, lat, lng);
        if (sn && sn.off <= MERGE_M && (!best || sn.off < best.off)) best = { track: t, along: sn.along, off: sn.off };
      }
      if (!best) {
        out.push([lat, lng]);
        prev = null;
        continue;
      }
      // follow the earlier track's own bends between two pulled points, instead of cutting the corner
      if (prev && prev.track === best.track) {
        const { cum, points: tp } = best.track;
        const lo = Math.min(prev.along, best.along);
        const hi = Math.max(prev.along, best.along);
        const between = [];
        for (let i = 0; i < cum.length; i++) if (cum[i] > lo && cum[i] < hi) between.push(tp[i]);
        if (best.along < prev.along) between.reverse();
        out.push(...between);
      }
      const p = pointOnTrack(best.track, best.along);
      out.push([p.lat, p.lng]);
      prev = best;
    }
    return out;
  };
  for (const l of linesData.lines) {
    const fam = family(l.routeId);
    const earlier = drawnByFamily.get(fam) ?? [];
    const points = mergeOnto(l.points, earlier);
    const track = buildTrack(l.routeId, points);
    drawnByFamily.set(fam, [...earlier, track]);
    const opts = { renderer: lineRenderer, interactive: false, lineCap: 'round', lineJoin: 'round', smoothFactor: 0.5 };
    const casing = L.polyline(points, { ...opts, color: tok('--ticket'), weight: 9, opacity: 1 }).addTo(map);
    const stroke = L.polyline(points, { ...opts, color: l.color, weight: 5, opacity: 0.95 }).addTo(map);
    lineLayers.push({ fam, casing, stroke });
    if (!tracks.has(l.routeId)) tracks.set(l.routeId, []);
    tracks.get(l.routeId).push(track);
    allPts.push(...points);
  }
  if (loc.pos) map.setView([loc.pos.lat, loc.pos.lng], 14.5);
  else if (allPts.length) map.fitBounds(L.latLngBounds(allPts).pad(-0.25));
  else map.setView([42.352, -71.075], 12.5);

  // Stations. Most are plain rings drawn on the canvas; the few with something going on
  // (eggs up, your finds, someone hunting) get a richer marker with a count and a label.
  const markers = new Map(); // id -> { kind: 'dom' | 'dot', layer }
  const special = (s) => {
    const st = stats.get(s.id);
    return Boolean(st?.activeEggs || st?.yourFinds || st?.huntingNow);
  };
  const domIcon = (s, selected) => {
    const st = stats.get(s.id);
    const fams = familiesOf(s.lines);
    const n = st?.activeEggs ?? 0;
    const cls = ['stn', n ? 'has-eggs' : '', fams.length > 1 ? 'hub' : '', st?.huntingNow ? 'live' : '', st?.yourFinds ? 'mine' : '', allFound(s.id) ? 'done' : '', selected ? 'sel' : ''].filter(Boolean).join(' ');
    const size = n ? 26 : 14;
    return L.divIcon({ className: 'stn-wrap', iconSize: [size, size], iconAnchor: [size / 2, size / 2], html: `<span class="${cls}" style="--ln:${LINE_VAR[fams[0]] ?? 'var(--ink)'}">${n ? `<b>${n}</b>` : ''}</span>` });
  };
  const dotStyle = (s, selected) => {
    const fams = familiesOf(s.lines);
    const ring = fams.length > 1 ? tok('--ink') : (s.lines[0]?.color ?? tok('--ink'));
    return { renderer: lineRenderer, radius: selected ? 9 : 5.5, color: ring, weight: selected ? 4 : 3, fillColor: tok('--ticket'), fillOpacity: 1, opacity: 1 };
  };
  for (const s of stations) {
    let layer;
    if (special(s)) {
      layer = L.marker([s.lat, s.lng], { icon: domIcon(s, false), title: s.name, riseOnHover: true, zIndexOffset: 600 }).addTo(map);
      layer.bindTooltip(esc(s.name), { permanent: true, direction: 'right', offset: [stats.get(s.id)?.activeEggs ? 14 : 8, 0], className: 'stn-label stn-label-eggs', interactive: false });
      markers.set(s.id, { kind: 'dom', layer });
    } else {
      layer = L.circleMarker([s.lat, s.lng], dotStyle(s, false)).addTo(map);
      layer.bindTooltip(esc(s.name), { direction: 'right', offset: [8, 0], className: 'stn-label stn-label-hover' });
      markers.set(s.id, { kind: 'dot', layer });
    }
    layer.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      const id = e.containerPoint && trainLayer.hit(e.containerPoint.x, e.containerPoint.y, 10);
      if (id) return selectTrain(id);
      select(s);
    });
  }
  const zoomClass = () => map.getContainer().classList.toggle('z-eggs', map.getZoom() >= 13);
  map.on('zoomend', zoomClass);
  zoomClass();

  const setSelected = (s, on) => {
    const m = markers.get(s.id);
    if (!m) return;
    if (m.kind === 'dom') m.layer.setIcon(domIcon(s, on));
    else m.layer.setStyle(dotStyle(s, on));
  };
  let selectedId = null;
  function select(s, { fly = true } = {}) {
    selectedTrain = null;
    following = false;
    if (selectedId) setSelected(stations.find((x) => x.id === selectedId), false);
    selectedId = s.id;
    setSelected(s, true);
    const st = stats.get(s.id) ?? { activeEggs: 0, huntingNow: 0, findsThisMonth: 0, yourFinds: 0, keeper: null };
    const fams = familiesOf(s.lines);
    const dist = loc.pos ? distanceM(loc.pos, s) : null;
    const sheet = $('#sheet');
    sheet.hidden = false;
    sheet.classList.remove('is-train');
    sheet.style.setProperty('--ln', LINE_VAR[fams[0]] ?? 'var(--ink)');
    sheet.innerHTML = `
      <div class="sheet-band">
        <span class="sheet-lines">${fams[0] ? `${fams[0]} Line` : 'Station'}${fams.slice(1).map((f) => `<span class="also" style="--ln:${LINE_VAR[f] ?? 'var(--ink)'}">${f}</span>`).join('')}</span>
        <button class="sheet-x" type="button" id="sheetClose" aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </div>
      <div class="sheet-top">
        <h2 class="sheet-h">${esc(s.name)}</h2>
        <p class="sheet-sub">${[dist != null ? (dist <= RANGE_METERS ? "You're here." : `${fmtDist(dist)} from you.`) : '', st.activeEggs && leftFor.get(s.id) != null ? (leftFor.get(s.id) ? `${plural(leftFor.get(s.id), 'egg')} left for you.` : "You've found every egg here.") : ''].filter(Boolean).join(' ')}</p>
        ${st.keeper ? `<p class="stamp sheet-keeper">Keeper: ${esc(st.keeper.username)}</p>` : ''}
      </div>
      <div class="tk-perf" aria-hidden="true"></div>
      <div class="sheet-bottom">
        <dl class="sheet-stats">
          <div class="${st.activeEggs ? 'is-on' : ''}"><dt>Eggs up</dt><dd>${st.activeEggs}<small>/5</small></dd></div>
          <div><dt>Your finds</dt><dd>${st.yourFinds}</dd></div>
          <div class="${st.huntingNow ? 'is-live' : ''}"><dt>Hunting now</dt><dd>${st.huntingNow}</dd></div>
          <div><dt>This month</dt><dd>${st.findsThisMonth}</dd></div>
        </dl>
        <p class="sheet-note">${st.keeper ? `${esc(st.keeper.username)} has the most finds here this month (${st.keeper.finds}).` : 'No Keeper yet this month'}</p>
        <a class="btn btn-block sheet-go" href="#/station/${encodeURIComponent(s.id)}">${st.activeEggs ? `Hunt at ${esc(s.name)}` : `Open ${esc(s.name)}`}</a>
      </div>`;
    $('#sheetClose').addEventListener('click', closeSheet);
    if (fly) {
      const z = Math.max(map.getZoom(), 14.5);
      const target = map.unproject(map.project([s.lat, s.lng], z).add([0, sheet.offsetHeight / 2]), z);
      map.flyTo(target, z, { duration: motion ? 0.7 : 0, easeLinearity: 0.2 });
    }
  }
  function closeSheet() {
    const sheet = $('#sheet');
    selectedTrain = null;
    following = false;
    if (!sheet || sheet.hidden) return;
    sheet.hidden = true;
    if (selectedId) setSelected(stations.find((x) => x.id === selectedId), false);
    selectedId = null;
  }
  // A tap on the map: a train if one is under the finger, otherwise close the card.
  map.on('click', (e) => {
    const id = trainLayer.hit(e.containerPoint.x, e.containerPoint.y);
    if (id) return selectTrain(id);
    closeSheet();
  });
  map.on('mousemove', (e) => {
    map.getContainer().classList.toggle('over-train', Boolean(trainLayer.hit(e.containerPoint.x, e.containerPoint.y)));
  });
  map.on('dragstart', () => {
    if (!following) return;
    following = false;
    const b = $('#followBtn');
    if (b) { b.setAttribute('aria-pressed', 'false'); b.textContent = 'Follow train'; }
  });

  if (loc.pos) {
    L.circle([loc.pos.lat, loc.pos.lng], { renderer: lineRenderer, radius: RANGE_METERS, color: tok('--focus'), weight: 1.5, opacity: 0.5, fillColor: tok('--focus'), fillOpacity: 0.06, interactive: false }).addTo(map);
    L.marker([loc.pos.lat, loc.pos.lng], {
      icon: L.divIcon({ className: 'me-wrap', iconSize: [20, 20], iconAnchor: [10, 10], html: '<span class="me-dot" title="You"></span>' }),
      zIndexOffset: 1000,
      keyboard: false,
      interactive: false,
    }).addTo(map);
  }

  // --- live trains, replayed a little behind their reports so they glide at the pace they really moved ---
  const TrainLayer = makeTrainLayer();
  const trainLayer = new TrainLayer().addTo(map);
  const trains = new Map(); // id -> { fam, color, cars, hist: [{ t, track, along, lat, lng, bearing }], dir }
  const rgba = (hex, a) => {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? [...h].map((c) => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  };
  const style = { casing: tok('--ticket'), glass: rgba(tok('--ticket'), 0.88), shadow: rgba(tok('--ink'), 0.25), halo: rgba(tok('--ticket'), 0.35), ring: rgba(tok('--ink'), 0.8) };
  let clock = null; // ties report time to this page's clock: { dataMs, perf }
  const renderTime = () => (clock ? clock.dataMs + (performance.now() - clock.perf) - PLAYBACK_DELAY_MS : 0);
  const angleGap = (a, b) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

  const snapFor = (v, prev) => {
    // Stay on the branch the train was on if it still fits, so trains don't flip between Ashmont and Braintree.
    if (prev?.track) {
      const s = snapToTrack(prev.track, v.lat, v.lng);
      if (s && s.off <= ON_TRACK_M) return { track: prev.track, ...s };
    }
    let best = null;
    for (const t of tracks.get(v.routeId) ?? []) {
      const s = snapToTrack(t, v.lat, v.lng);
      if (s && (!best || s.off < best.off)) best = { track: t, ...s };
    }
    return best && best.off <= ON_TRACK_M ? best : null;
  };

  const ingest = (vehicles) => {
    const newest = Math.max(0, ...vehicles.map((v) => Date.parse(v.updatedAt) || 0));
    const predicted = clock ? clock.dataMs + (performance.now() - clock.perf) : 0;
    if (!clock || Math.abs(newest - predicted) > 30_000) clock = { dataMs: newest || Date.now(), perf: performance.now() };
    const seen = new Set();
    for (const v of vehicles) {
      seen.add(v.id);
      const t = Date.parse(v.updatedAt) || newest;
      const fam = family(v.routeId);
      let tr = trains.get(v.id);
      if (!tr) {
        tr = { id: v.id, fam, color: v.color, cars: CARS[v.routeId] ?? CARS[fam] ?? 2, hist: [], dir: 0 };
        trains.set(v.id, tr);
      }
      tr.v = v; // the latest report, for the train card
      const last = tr.hist[tr.hist.length - 1];
      if (last && t <= last.t) continue;
      // A new trip direction (it turned around at the end of the line): work out its facing again.
      if (tr.directionId != null && v.directionId != null && v.directionId !== tr.directionId) tr.dir = 0;
      tr.directionId = v.directionId;
      const snap = snapFor(v, last);
      // Within a trip, trains only go forward. A report a little behind the last one is position noise: hold still.
      if (snap && last?.track === snap.track && tr.dir && (snap.along - last.along) * tr.dir < 0 && Math.abs(snap.along - last.along) < BACKSTEP_M) {
        snap.along = last.along;
      }
      const point = snap
        ? { t, track: snap.track, along: snap.along, ...pointOnTrack(snap.track, snap.along), mbtaBearing: v.bearing ?? 0 }
        : { t, track: null, along: null, lat: v.lat, lng: v.lng, bearing: v.bearing ?? 0 };
      // Which way along the track this train faces, from the MBTA's own heading. Only used until it has moved.
      if (snap && !tr.dir) tr.dir = angleGap(v.bearing ?? 0, point.bearing) <= 90 ? 1 : -1;
      tr.hist.push(point);
      const cutoff = renderTime() - 60_000;
      while (tr.hist.length > 2 && tr.hist[1].t < cutoff) tr.hist.shift();
    }
    for (const id of trains.keys()) if (!seen.has(id)) trains.delete(id);
  };

  // Where each train's head is at time `rt`: on a track (track, along, dir) or, off the mapped track, a point and heading.
  const positionAt = (tr, rt) => {
    const h = tr.hist;
    if (!h.length) return null;
    const onTrack = (pt, along) => ({ track: pt.track, along, dir: tr.dir || 1, moving: false });
    const still = (pt) => (pt.track ? onTrack(pt, pt.along) : { lat: pt.lat, lng: pt.lng, bearing: pt.bearing, moving: false });
    if (!motion || rt >= h[h.length - 1].t) return still(h[h.length - 1]);
    if (rt <= h[0].t) return still(h[0]);
    let i = 0;
    while (i < h.length - 2 && h[i + 1].t <= rt) i++;
    const a = h[i];
    const b = h[i + 1];
    const k = (rt - a.t) / (b.t - a.t || 1);
    if (a.track && a.track === b.track && Math.abs(b.along - a.along) < MAX_GLIDE_M) {
      const moved = b.along - a.along;
      // Only real movement changes the facing direction; jitter at a platform doesn't.
      if (!tr.dir && Math.abs(moved) >= DIR_MIN_M) tr.dir = moved > 0 ? 1 : -1;
      return { ...onTrack(a, a.along + moved * k), moving: Math.abs(moved) >= 1 };
    }
    return still(k < 0.5 ? a : b); // a jump (new trip, yard move): switch at the midpoint instead of sliding across the city
  };

  let raf = 0;
  let showTrains = true;
  let selectedTrain = null;
  let following = false;
  let movingNow = 0;
  let lastItems = [];
  const frame = () => {
    raf = 0;
    if (state.map !== map) return;
    const rt = renderTime();
    const items = [];
    movingNow = 0;
    if (showTrains) {
      for (const tr of trains.values()) {
        if (filter && tr.fam !== filter) continue;
        const p = positionAt(tr, rt);
        if (!p) continue;
        if (p.moving) movingNow++;
        items.push({ ...p, id: tr.id, color: tr.color, cars: tr.cars, selected: tr.id === selectedTrain });
      }
    }
    if (following && selectedTrain) {
      const it = items.find((x) => x.id === selectedTrain);
      if (it) {
        const head = it.track ? pointOnTrack(it.track, it.along) : it;
        const lift = $('#sheet')?.offsetHeight ?? 0;
        const z = map.getZoom();
        map.panTo(map.unproject(map.project([head.lat, head.lng], z).add([0, lift / 2]), z), { animate: false });
      }
    }
    trainLayer.draw(items, style);
    lastItems = items;
    if (motion) raf = requestAnimationFrame(frame);
  };
  const STATUS = { STOPPED_AT: 'Stopped at', INCOMING_AT: 'Pulling into', IN_TRANSIT_TO: 'On the way to' };
  const CROWD = { MANY_SEATS_AVAILABLE: 'Seats free', FEW_SEATS_AVAILABLE: 'Few seats', STANDING_ROOM_ONLY: 'Standing room', CRUSHED_STANDING_ROOM_ONLY: 'Packed', FULL: 'Full' };
  const ago = (iso) => {
    const sec = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    return sec < 60 ? `${sec} s ago` : `${Math.round(sec / 60)} min ago`;
  };
  function renderTrainCard() {
    const sheet = $('#sheet');
    const tr = trains.get(selectedTrain);
    if (!sheet) return;
    if (!tr) {
      sheet.innerHTML = `
        <div class="sheet-band"><span class="sheet-lines">Train</span><button class="sheet-x" type="button" id="sheetClose" aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
        <div class="sheet-top"><h2 class="sheet-h">Trip finished</h2><p class="sheet-sub">This train isn't reporting any more. It probably reached the end of its trip.</p></div>`;
      $('#sheetClose').addEventListener('click', closeSheet);
      following = false;
      return;
    }
    const v = tr.v;
    const station = v.stopName ? stations.find((x) => x.name === v.stopName) : null;
    const cars = v.carriages?.length ? v.carriages : v.label ? v.label.split('-').map((label) => ({ label, occupancy: null })) : [];
    const crowdKey = (o) => (o === 'MANY_SEATS_AVAILABLE' ? 'low' : o === 'FEW_SEATS_AVAILABLE' ? 'mid' : o ? 'high' : '');
    const heading = [v.directionName, v.destination && v.destination !== v.headsign ? `toward ${v.destination}` : ''].filter(Boolean).join(' ');
    sheet.hidden = false;
    sheet.classList.add('is-train');
    sheet.style.setProperty('--ln', LINE_VAR[tr.fam] ?? 'var(--ink)');
    sheet.innerHTML = `
      <div class="sheet-band">
        <span class="sheet-lines">${esc(v.line || `${tr.fam} Line`)} train${v.label ? `<span class="also train-no">No. ${esc(v.label.split('-')[0])}</span>` : ''}</span>
        <button class="sheet-x" type="button" id="sheetClose" aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </div>
      <div class="sheet-top">
        <h2 class="sheet-h">${v.headsign ? `To ${esc(v.headsign)}` : esc(v.line)}</h2>
        <p class="sheet-sub">${v.stopName ? `${STATUS[v.status] ?? 'Near'} <b>${esc(v.stopName)}</b>` : 'Between stations'}${heading ? `, heading ${esc(heading)}` : ''}.</p>
      </div>
      <div class="tk-perf" aria-hidden="true"></div>
      <div class="sheet-bottom">
        ${cars.length ? `<div class="train-row"><p class="train-k">${plural(cars.length, 'car')}</p><ul class="train-cars" aria-label="Car numbers">${cars.map((c) => `<li class="${crowdKey(c.occupancy)}" title="${esc(CROWD[c.occupancy] ?? '')}">${esc(c.label)}</li>`).join('')}</ul></div>` : ''}
        ${cars.some((c) => c.occupancy) ? '<p class="crowd-key"><i class="low"></i>Seats free <i class="mid"></i>Few seats <i class="high"></i>Standing</p>' : ''}
        <p class="sheet-note">Reported ${v.updatedAt ? ago(v.updatedAt) : 'recently'}. Vehicle ${esc(v.id)}. The map runs about 25 s behind reports so trains glide.</p>
        <div class="sheet-acts">
          <button class="btn sheet-go" type="button" id="followBtn" aria-pressed="${following}">${following ? 'Following' : 'Follow train'}</button>
          ${station ? `<a class="btn btn-ghost" href="#/station/${encodeURIComponent(station.id)}"><span class="clip">Open ${esc(station.name)}</span></a>` : ''}
        </div>
      </div>`;
    $('#sheetClose').addEventListener('click', closeSheet);
    $('#followBtn').addEventListener('click', (e) => {
      following = !following;
      e.currentTarget.setAttribute('aria-pressed', String(following));
      e.currentTarget.textContent = following ? 'Following' : 'Follow train';
      kick();
    });
  }
  function selectTrain(id) {
    if (selectedId) setSelected(stations.find((x) => x.id === selectedId), false);
    selectedId = null;
    if (selectedTrain !== id) following = false;
    selectedTrain = id;
    renderTrainCard();
    kick();
  }

  const kick = () => {
    if (!raf) raf = requestAnimationFrame(frame);
  };
  onCleanup(() => cancelAnimationFrame(raf));

  const applyFilter = () => {
    for (const { fam, casing, stroke } of lineLayers) {
      const on = !filter || fam === filter;
      stroke.setStyle({ opacity: on ? 0.95 : 0.16 });
      casing.setStyle({ opacity: on ? 1 : 0.35 });
    }
    for (const s of stations) {
      const on = !filter || familiesOf(s.lines).includes(filter);
      const m = markers.get(s.id);
      if (m.kind === 'dom') m.layer.setOpacity(on ? 1 : 0.3);
      else m.layer.setStyle({ opacity: on ? 1 : 0.3, fillOpacity: on ? 1 : 0.3 });
    }
    kick();
  };

  const loadTrains = async () => {
    if (state.map !== map) return;
    try {
      const { vehicles, error } = await api('/api/map/vehicles');
      ingest(vehicles);
      if (selectedTrain) renderTrainCard();
      const counts = MAP_LINES.map((l) => [l, vehicles.filter((v) => family(v.routeId) === l).length]);
      $('#mapFoot').textContent = error
        ? 'Live trains are unavailable right now.'
        : `${plural(vehicles.length, 'train')} running: ${counts.map(([l, n]) => `${n} ${l}`).join(', ')}. Live from the MBTA.`;
      kick();
    } catch {
      $('#mapFoot').textContent = 'Live trains are unavailable right now.';
    }
  };
  loadTrains();
  every(VEHICLE_POLL_MS, loadTrains);
  if (!motion) map.on('move zoomend', kick);

  $('#showTrains').addEventListener('change', (e) => {
    showTrains = e.target.checked;
    kick();
  });
  app.querySelectorAll('.chip').forEach((c) =>
    c.addEventListener('click', () => {
      filter = c.dataset.line || null;
      app.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', String(x === c)));
      applyFilter();
      const pts = linesData.lines.filter((l) => !filter || family(l.routeId) === filter).flatMap((l) => l.points);
      if (pts.length) map.flyToBounds(L.latLngBounds(pts).pad(0.05), { duration: motion ? 0.7 : 0 });
    }),
  );

  const n = nearestStation(stations);
  if (isInRange(n)) select(n.station, { fly: false });
  window.__lookoutMap = { trains: () => trains.size, moving: () => movingNow, drawn: () => lastItems.map((it) => { const h = it.track ? pointOnTrack(it.track, it.along) : it; const p = subpixelPoint(map, h.lat, h.lng); return [p.x, p.y, it.dir ?? 0]; }), lines: () => lineLayers.map((l) => l.stroke.getLatLngs().map((x) => [x.lat, x.lng])), hits: () => trainLayer.screenHits(), ids: () => lastItems.map((it) => it.id), describe: (id) => { const t = trains.get(id); return t && { id, line: t.v?.line, status: t.v?.status, stop: t.v?.stopName, headsign: t.v?.headsign, hist: t.hist.map((h) => Math.round(h.along ?? -1)) }; }, map };
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
