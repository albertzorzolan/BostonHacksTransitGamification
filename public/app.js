// Station Egg Hunt: single-page app, hash routing, no build step.

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');

const LEVEL_COLORS = ['', 'var(--l1)', 'var(--l2)', 'var(--l3)', 'var(--l4)', 'var(--l5)'];
const REPORT_REASONS = [
  ['cant_find', "Can't be found"],
  ['unsafe', 'Unsafe spot'],
  ['person', 'Shows a person'],
];

const state = {
  user: readStored('egg-user'),
  config: null,
  stations: null,
  lastStationId: readStored('egg-last-station'),
  raceTrain: readStored('egg-race-train') ?? false,
  play: null, // current round
  pendingHide: null, // { stationId, level, findId }
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
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
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
function clearTimers() {
  state.timers.forEach((stop) => stop());
  state.timers = [];
}

const fmtClock = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, Math.floor(s)) % 60).padStart(2, '0')}`;
const fmtMins = (s) => (s < 60 ? 'Now' : `${Math.round(s / 60)} min`);
const lineDots = (lines) =>
  `<span class="dots">${[...new Map(lines.map((l) => [l.color, l])).values()]
    .map((l) => `<span class="dot" style="background:${l.color}" title="${esc(l.name)}"></span>`)
    .join('')}</span>`;

function distanceKm(a, b) {
  const R = 6371;
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
  const w = source.width;
  const h = source.height;
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

async function getStations() {
  if (!state.stations) state.stations = (await api('/api/stations')).stations;
  return state.stations;
}

function loading(text = 'Loading…') {
  app.innerHTML = `<div class="empty"><div class="row" style="justify-content:center"><div class="spin"></div>${esc(text)}</div></div>`;
}

// ---------- router ----------
const routes = [
  [/^#?\/?$/, viewStations],
  [/^#\/station\/([^/]+)$/, viewStation],
  [/^#\/play$/, viewPlay],
  [/^#\/hide$/, viewHide],
  [/^#\/leaderboard$/, viewLeaderboard],
  [/^#\/profile$/, viewProfile],
  [/^#\/map$/, viewMap],
];

async function render() {
  clearTimers();
  if (state.map) {
    state.map.remove();
    state.map = null;
  }
  window.scrollTo(0, 0);
  $('#me').textContent = state.user ? state.user.username : '';
  if (!state.user) return viewSignup();

  const hash = location.hash || '#/';
  const tab = hash.startsWith('#/map') ? 'map' : hash.startsWith('#/leaderboard') ? 'leaderboard' : hash.startsWith('#/profile') ? 'profile' : 'stations';
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));

  for (const [re, view] of routes) {
    const m = re.exec(hash);
    if (!m) continue;
    try {
      await view(...m.slice(1).map(decodeURIComponent));
    } catch (err) {
      if (err.status === 401) return signOut();
      app.innerHTML = `<div class="notice bad">${esc(err.message)}</div><p><a class="btn" href="#/">Back to stations</a></p>`;
    }
    return;
  }
  location.hash = '#/';
}

function signOut() {
  state.user = null;
  store('egg-user', null);
  render();
}

// ---------- sign up ----------
function viewSignup() {
  $('#tabs').hidden = true;
  app.innerHTML = `
    <h1>Find what's hiding in your station.</h1>
    <p class="sub">Riders photograph small things in MBTA stations. You get a photo and a timer, and you look around until you spot it. Find it, snap it, score points, then hide the next one.</p>
    <form id="signup" class="card stack">
      <label for="username"><strong>Pick a username</strong></label>
      <input id="username" class="input" maxlength="20" autocomplete="nickname" placeholder="e.g. kenmore_kid" required />
      <button class="btn primary block">Start playing</button>
      <div id="err"></div>
    </form>`;
  $('#signup').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { user } = await api('/api/users', { username: $('#username').value });
      state.user = user;
      store('egg-user', user);
      $('#tabs').hidden = false;
      render();
    } catch (err) {
      $('#err').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
    }
  });
}

// ---------- stations ----------
async function viewStations() {
  loading('Loading stations…');
  const stations = await getStations();
  let origin = null;

  app.innerHTML = `
    <h1>Where are you?</h1>
    <p class="sub">Pick your station to see its five eggs.</p>
    <div class="row">
      <input id="q" class="input" type="search" placeholder="Search stations" aria-label="Search stations" />
      <button id="locate" class="btn" type="button" aria-label="Use my location">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7"/></svg>
        Near me
      </button>
    </div>
    <div id="locmsg" class="small" style="margin:8px 2px"></div>
    <ul id="list" class="list"></ul>`;

  const draw = () => {
    const q = $('#q').value.trim().toLowerCase();
    let rows = stations.filter((s) => s.name.toLowerCase().includes(q));
    if (origin) rows = rows.map((s) => ({ ...s, km: distanceKm(origin, s) })).sort((a, b) => a.km - b.km);
    else rows = [...rows].sort((a, b) => b.activeEggs - a.activeEggs || a.name.localeCompare(b.name));
    $('#list').innerHTML = rows.length
      ? rows
          .map(
            (s) => `<li><a href="#/station/${encodeURIComponent(s.id)}">
              ${lineDots(s.lines)}
              <span><span class="name">${esc(s.name)}</span><br/>
              <span class="meta">${s.km != null ? `${s.km < 1 ? Math.round(s.km * 1000) + ' m' : s.km.toFixed(1) + ' km'} · ` : ''}${s.activeEggs ? `${s.activeEggs} egg${s.activeEggs > 1 ? 's' : ''} hidden` : 'No eggs yet'}</span></span>
              <span class="spacer"></span>${s.activeEggs ? `<span class="pill accent">${s.activeEggs}/5</span>` : ''}
            </a></li>`,
          )
          .join('')
      : `<li class="empty">No station matches “${esc(q)}”.</li>`;
  };
  $('#q').addEventListener('input', draw);
  $('#locate').addEventListener('click', () => {
    const msg = $('#locmsg');
    if (!window.isSecureContext || !navigator.geolocation) {
      msg.textContent = 'Location needs an HTTPS link. Pick your station from the list instead.';
      return;
    }
    msg.textContent = 'Finding you… (GPS is weak underground)';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        origin = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        draw();
        const nearest = [...stations].sort((a, b) => distanceKm(origin, a) - distanceKm(origin, b))[0];
        msg.innerHTML = `Nearest: <a href="#/station/${encodeURIComponent(nearest.id)}"><strong>${esc(nearest.name)}</strong></a>`;
      },
      () => (msg.textContent = "Couldn't get your location. Pick your station from the list."),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
    );
  });
  draw();
}

// ---------- one station ----------
async function viewStation(id) {
  loading();
  const { station, slots } = await api(`/api/stations/${encodeURIComponent(id)}?userId=${state.user.id}`);
  state.lastStationId = id;
  store('egg-last-station', id);

  app.innerHTML = `
    <a href="#/" class="small">← All stations</a>
    <h1>${esc(station.name)}</h1>
    <div class="row" style="margin-bottom:6px">${lineDots(station.lines)}<span class="small">${esc([...new Set(station.lines.map((l) => l.name))].join(' · '))}</span></div>

    <h2>Next trains</h2>
    <div id="trains" class="card"><div class="small">Loading live times…</div></div>

    <div class="row" style="justify-content:space-between; margin-top:22px">
      <h2 style="margin:0">Eggs here</h2>
      <label class="toggle"><input id="race" type="checkbox" ${state.raceTrain ? 'checked' : ''}/> Race the next train</label>
    </div>
    <p class="small" style="margin:6px 0 12px">${state.raceTrain ? 'Your timer is the time until the next train (1.5–15 min). Otherwise the level timer is used.' : 'Each level has its own timer. Turn on “Race the next train” to beat the train instead.'}</p>
    <div class="levels">${slots.map(slotCard).join('')}</div>`;

  $('#race').addEventListener('change', (e) => {
    state.raceTrain = e.target.checked;
    store('egg-race-train', state.raceTrain);
    render();
  });

  app.querySelectorAll('[data-play]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const round = await api('/api/attempts', { userId: state.user.id, eggId: btn.dataset.play, mode: state.raceTrain ? 'train' : 'fixed' });
        state.play = { ...round, receivedAt: performance.now(), result: null };
        location.hash = '#/play';
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
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
    const box = $('#trains');
    if (!box) return;
    try {
      const { trains, error } = await api(`/api/stations/${encodeURIComponent(id)}/predictions`);
      box.innerHTML = trains.length
        ? `<div class="trains">${trains
            .slice(0, 6)
            .map((t) => `<div class="train"><span class="bar" style="background:${t.color}"></span><span><strong>${esc(t.headsign || t.line)}</strong><br/><span class="small">${esc(t.line)}${t.status ? ' · ' + esc(t.status) : ''}</span></span><span class="mins">${fmtMins(t.seconds)}</span></div>`)
            .join('')}</div>`
        : `<div class="small">${esc(error || 'No live predictions right now.')}</div>`;
    } catch (err) {
      box.innerHTML = `<div class="small">${esc(err.message)}</div>`;
    }
  };
  loadTrains();
  every(30_000, loadTrains);
}

function slotCard(slot) {
  const { egg } = slot;
  let desc;
  let action;
  if (!egg) {
    desc = 'Empty. Be the first to hide one.';
    action = `<button class="btn small" data-hide="${slot.level}">Hide one</button>`;
  } else if (egg.mine) {
    desc = `Your egg · found ${egg.timesFound}×`;
    action = `<span class="pill">Yours</span>`;
  } else if (egg.foundByMe) {
    desc = `Hidden by ${esc(egg.createdBy)} · found ${egg.timesFound}×`;
    action = `<span class="pill">Found ✓</span>`;
  } else {
    desc = `Hidden by ${esc(egg.createdBy)} · ${Math.round(slot.seconds / 60)} min timer`;
    action = `<button class="btn small primary" data-play="${egg.id}">Play</button>`;
  }
  return `<div class="level" data-level="${slot.level}" style="--lc:${LEVEL_COLORS[slot.level]}">
    <div class="num">${slot.level}</div>
    <div><div class="title">${esc(slot.name)} <span class="small">· ${slot.points} pts</span></div><div class="desc">${desc}</div></div>
    ${action}
  </div>`;
}

// ---------- play a round ----------
function viewPlay() {
  const play = state.play;
  if (!play) {
    location.hash = state.lastStationId ? `#/station/${encodeURIComponent(state.lastStationId)}` : '#/';
    return;
  }
  if (play.result) return renderResult();

  const { attempt, egg } = play;
  const secondsLeft = () => attempt.secondsLeft - (performance.now() - play.receivedAt) / 1000;
  const graceLeft = () => secondsLeft() + (state.config?.graceSeconds ?? 15);

  app.innerHTML = `
    <div class="row" style="justify-content:space-between">
      <span class="pill" style="background:${LEVEL_COLORS[egg.level]};color:#fff">${egg.level} · ${esc(egg.levelName)} · ${egg.points} pts</span>
      <span class="small">${esc(egg.stationName)}</span>
    </div>
    <div class="row" style="margin:14px 0 8px; align-items:flex-end">
      <div id="clock" class="timer">${fmtClock(secondsLeft())}</div>
      <span class="spacer"></span>
      <span class="small" style="text-align:right">${attempt.limitSource === 'train' ? `Beat the ${esc(attempt.train?.headsign || 'next')} train` : 'Level timer'}</span>
    </div>
    <div class="timerbar"><div id="bar" style="width:100%"></div></div>
    <div class="play-photo" style="margin-top:12px"><img src="${egg.imageUrl}" alt="The egg to find: a photo of something in this station" /></div>
    ${egg.hint ? `<p class="notice" style="margin-top:10px"><strong>Hint:</strong> ${esc(egg.hint)}</p>` : ''}
    <div id="status" style="margin-top:12px"></div>
    <label class="btn primary block" id="snap" style="margin-top:12px">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>
      I found it, take a photo
      <input id="cam" class="file-hidden" type="file" accept="image/*" capture="environment" />
    </label>
    <div class="row" style="margin-top:14px; flex-wrap:wrap">
      <span class="small">Report:</span>
      ${REPORT_REASONS.map(([k, label]) => `<button class="linkbtn" data-report="${k}">${label}</button>`).join('')}
      <span class="spacer"></span>
      <button class="linkbtn" id="quit">Give up</button>
    </div>`;

  const tick = () => {
    const s = secondsLeft();
    const clock = $('#clock');
    if (!clock) return;
    clock.textContent = fmtClock(s);
    clock.classList.toggle('low', s <= 20);
    $('#bar').style.width = `${Math.max(0, (s / attempt.limitSeconds) * 100)}%`;
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
    $('#snap').style.display = 'none';
    status.innerHTML = `<div class="notice row"><div class="spin"></div>${state.config?.gemini ? 'Checking your photo against the egg…' : 'Saving your find…'}</div>`;
    try {
      const image = await photoToJpeg(file);
      const result = await api(`/api/attempts/${attempt.id}/find`, { userId: state.user.id, image });
      if (result.status === 'no_match') {
        status.innerHTML = `<div class="notice bad"><strong>Not a match.</strong> ${esc(result.reason)} Keep looking.</div>`;
        $('#snap').style.display = '';
        e.target.value = '';
        return;
      }
      play.result = result;
      renderResult();
    } catch (err) {
      status.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
      $('#snap').style.display = '';
      e.target.value = '';
    }
  });

  app.querySelectorAll('[data-report]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm(`Report this egg as “${b.textContent}”?`)) return;
      try {
        const r = await api(`/api/eggs/${egg.id}/report`, { userId: state.user.id, reason: b.dataset.report });
        toast(r.retired ? 'Thanks. That egg has been removed.' : 'Thanks, report sent.');
      } catch (err) {
        toast(err.message);
      }
    }),
  );
  $('#quit').addEventListener('click', () => {
    state.play = null;
    location.hash = `#/station/${encodeURIComponent(egg.stationId)}`;
  });
}

function renderResult() {
  clearTimers();
  const { result, egg } = state.play;
  const back = `#/station/${encodeURIComponent(egg.stationId)}`;

  if (result.status === 'expired') {
    app.innerHTML = `
      <h1>Time's up</h1>
      <p class="sub">The ${esc(egg.levelName)} egg at ${esc(egg.stationName)} stays hidden for now.</p>
      <a class="btn primary block" href="${back}">Try another level</a>`;
    state.play = null;
    return;
  }

  const { points, verification } = result;
  app.innerHTML = `
    <p class="small">${esc(egg.stationName)} · ${esc(egg.levelName)}</p>
    <h1>Found it!</h1>
    <div class="card" style="margin:12px 0">
      <div class="big-points">+${points.total}</div>
      <div class="small" style="margin-top:6px">${points.base} for ${esc(egg.levelName)} + ${points.bonus} time bonus · ${fmtClock(result.secondsTaken)} taken</div>
      <div class="small" style="margin-top:6px">${verification.method === 'gemini' ? `✓ Photo matched${verification.reason ? ': ' + esc(verification.reason) : ''}` : esc(verification.reason)}</div>
    </div>
    <h2>Hide the next one?</h2>
    <p class="sub">Photograph something small in this station. It becomes the new ${esc(egg.levelName)} egg here.</p>
    <button id="hide" class="btn primary block">Take a photo to hide an egg</button>
    <a class="btn block" style="margin-top:8px" href="${back}">Skip</a>`;

  $('#hide').addEventListener('click', () => {
    state.pendingHide = { stationId: egg.stationId, stationName: egg.stationName, level: egg.level, findId: result.findId };
    state.play = null;
    location.hash = '#/hide';
  });
  // Leaving via Skip clears the round.
  app.querySelector(`a[href="${back}"]`).addEventListener('click', () => (state.play = null));
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
    <a href="#/station/${encodeURIComponent(hide.stationId)}" class="small">← ${esc(hide.stationName)}</a>
    <h1>Hide a ${esc(level.name)} egg</h1>
    <p class="sub">Worth ${level.points} points to whoever finds it. Pick something that fits the level: Easy should be findable in a minute, Impossible should take real searching.</p>
    <ul class="rules">
      <li>Only things you can see from public areas. No tracks or staff-only spots.</li>
      <li>No other riders' faces.</li>
      <li>Photograph something that's already there. Don't put up stickers or objects.</li>
      <li>Stay behind the yellow line.</li>
    </ul>
    <div id="preview" class="preview" style="margin-top:14px" hidden></div>
    <label class="btn block" id="pick" style="margin-top:14px">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>
      <span id="pickText">Take the photo</span>
      <input id="cam" class="file-hidden" type="file" accept="image/*" capture="environment" />
    </label>
    <label for="hint" style="display:block; margin-top:14px"><strong>Hint</strong> <span class="small">(optional, one line)</span></label>
    <input id="hint" class="input" maxlength="80" placeholder="e.g. near the stairs to outbound" style="margin-top:6px" />
    <button id="submit" class="btn primary block" style="margin-top:14px" disabled>Hide this egg</button>
    <div id="err" style="margin-top:10px"></div>`;

  $('#cam').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      image = await photoToJpeg(file);
      const pv = $('#preview');
      pv.hidden = false;
      pv.innerHTML = `<img src="${image}" alt="Your egg photo" />`;
      $('#pickText').textContent = 'Retake photo';
      $('#submit').disabled = false;
    } catch (err) {
      $('#err').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
    }
  });

  $('#submit').addEventListener('click', async () => {
    $('#submit').disabled = true;
    $('#submit').textContent = 'Hiding…';
    try {
      await api('/api/eggs', {
        userId: state.user.id,
        stationId: hide.stationId,
        level: hide.level,
        findId: hide.findId,
        hint: $('#hint').value,
        image,
      });
      state.pendingHide = null;
      state.stations = null; // egg counts changed
      toast('Egg hidden. Now someone else has to find it.');
      location.hash = `#/station/${encodeURIComponent(hide.stationId)}`;
    } catch (err) {
      $('#err').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
      $('#submit').disabled = false;
      $('#submit').textContent = 'Hide this egg';
    }
  });
}

// ---------- leaderboard ----------
async function viewLeaderboard() {
  loading();
  const stations = await getStations();
  let mode = 'all';
  let stationId = state.lastStationId || stations.find((s) => s.activeEggs)?.id || stations[0]?.id;
  const monthLabel = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'America/New_York' });

  app.innerHTML = `
    <h1>Leaderboard</h1>
    <p class="sub">${esc(monthLabel)}. Points reset at the start of each month.</p>
    <div class="seg" role="tablist">
      <button data-mode="all" class="on">Everyone</button>
      <button data-mode="station">By station</button>
      <button data-mode="lines">By line</button>
    </div>
    <div id="stationPick" style="margin-top:10px" hidden>
      <select id="sel" class="input" aria-label="Station">${[...stations]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => `<option value="${esc(s.id)}" ${s.id === stationId ? 'selected' : ''}>${esc(s.name)}</option>`)
        .join('')}</select>
    </div>
    <div id="board" style="margin-top:12px"></div>`;

  const draw = async () => {
    const box = $('#board');
    box.innerHTML = '<div class="empty"><div class="spin" style="margin:auto"></div></div>';
    const q = mode === 'station' ? `?stationId=${encodeURIComponent(stationId)}` : '';
    const data = await api(`/api/leaderboard${q}`);
    if (mode === 'lines') {
      const colors = { Red: 'var(--red)', Orange: 'var(--orange)', Blue: 'var(--blue)', Green: 'var(--green)' };
      box.innerHTML = data.lines.length
        ? `<ol class="board">${data.lines.map((l, i) => `<li><span class="rank">${i + 1}</span><span class="row"><span class="dot" style="background:${colors[l.line] ?? '#888'}"></span><strong>${esc(l.line)} Line</strong></span><span class="pts">${l.points}</span></li>`).join('')}</ol>`
        : '<div class="empty">No finds yet this month.</div>';
      return;
    }
    box.innerHTML = data.rows.length
      ? `<ol class="board">${data.rows
          .map((r) => `<li class="${r.userId === state.user.id ? 'me' : ''}"><span class="rank">${r.rank}</span><span><strong>${esc(r.username)}</strong><br/><span class="small">${r.finds} find${r.finds === 1 ? '' : 's'}</span></span><span class="pts">${r.points}</span></li>`)
          .join('')}</ol>`
      : '<div class="empty">No finds yet. Be the first on the board.</div>';
  };

  app.querySelectorAll('.seg button').forEach((b) =>
    b.addEventListener('click', () => {
      mode = b.dataset.mode;
      app.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
      $('#stationPick').hidden = mode !== 'station';
      draw();
    }),
  );
  $('#sel').addEventListener('change', (e) => {
    stationId = e.target.value;
    draw();
  });
  await draw();
}

// ---------- profile ----------
async function viewProfile() {
  loading();
  const p = await api(`/api/users/${state.user.id}`);
  app.innerHTML = `
    <h1>${esc(p.user.username)}</h1>
    <p class="sub">${p.monthRank ? `#${p.monthRank} this month` : 'Not on the board yet this month'}</p>
    <div class="stats">
      <div class="card stat"><div class="v">${p.monthPoints}</div><div class="k">Points this month</div></div>
      <div class="card stat"><div class="v">${p.allTimePoints}</div><div class="k">Points all-time</div></div>
      <div class="card stat"><div class="v">${p.eggsHidden}</div><div class="k">Eggs you hid</div></div>
      <div class="card stat"><div class="v">${p.timesYourEggsWereFound}</div><div class="k">Times others found yours</div></div>
    </div>
    <h2>Finds by level</h2>
    <div class="card">${Object.entries(p.findsByLevel)
      .map(([name, n], i) => `<div class="row" style="padding:4px 0"><span class="dot" style="background:${LEVEL_COLORS[i + 1]}"></span>${esc(name)}<span class="spacer"></span><strong>${n}</strong></div>`)
      .join('')}</div>
    <h2>Recent finds</h2>
    ${p.recentFinds.length
      ? `<div class="finds">${p.recentFinds
          .map((f) => `<figure><img src="${f.photoUrl}" alt="Find at ${esc(f.stationName)}" loading="lazy"/><figcaption>${esc(f.stationName)} · ${esc(f.levelName)} · +${f.points}</figcaption></figure>`)
          .join('')}</div>`
      : '<div class="empty">No finds yet. Pick a station and play a round.</div>'}
    <p style="margin-top:24px"><button id="out" class="linkbtn">Switch player on this phone</button></p>`;
  $('#out').addEventListener('click', () => {
    if (confirm('Switch player? You can make a new username, but this one stays on the leaderboard.')) signOut();
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

async function viewMap() {
  loading('Loading map…');
  const [stations] = await Promise.all([getStations(), loadLeaflet()]);
  app.innerHTML = `
    <h1>Station map</h1>
    <p class="sub">Bigger dots have more eggs hidden. Tap a station to play.</p>
    <div id="map"></div>`;
  const map = L.map('map', { zoomControl: true }).setView([42.3555, -71.0805], 12);
  state.map = map;
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  for (const s of stations) {
    L.circleMarker([s.lat, s.lng], {
      radius: 5 + s.activeEggs * 1.6,
      color: '#fff',
      weight: 2,
      fillColor: s.lines[0]?.color ?? '#555',
      fillOpacity: s.activeEggs ? 1 : 0.55,
    })
      .addTo(map)
      .bindPopup(`<strong>${esc(s.name)}</strong><br/>${s.activeEggs}/5 eggs hidden<br/><a href="#/station/${encodeURIComponent(s.id)}">Open station →</a>`);
  }
}

// ---------- boot ----------
(async function boot() {
  try {
    state.config = await api('/api/config');
  } catch {
    app.innerHTML = '<div class="notice bad">Can\'t reach the game server. Is it running?</div>';
    return;
  }
  // Make sure a saved player still exists on this server.
  if (state.user) {
    try {
      await api(`/api/users/${state.user.id}`);
    } catch (err) {
      if (err.status === 404) {
        state.user = null;
        store('egg-user', null);
      }
    }
  }
  $('#tabs').hidden = !state.user;
  window.addEventListener('hashchange', render);
  render();
})();
