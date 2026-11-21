// Station Easter Egg Hunt: zero-dependency Node server (API + static files).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStore } from './lib/store.js';
import { createMbta } from './lib/mbta.js';
import { verifyMatch } from './lib/verify.js';
import * as game from './lib/game.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

export async function createApp({
  dataDir,
  mbta,
  verify = verifyMatch,
  geminiKey = '',
  geminiModel = 'gemini-2.5-flash',
  now = () => new Date(),
}) {
  const store = createStore(dataDir);
  const { db } = store;

  // ---------- stations ----------
  let stations = [];
  let stationById = new Map();
  async function ensureStations() {
    if (stations.length) return;
    try {
      stations = await mbta.loadStations();
      stationById = new Map(stations.map((s) => [s.id, s]));
    } catch (err) {
      console.warn('[mbta] could not load stations:', err.message);
      fail(503, 'Could not reach the MBTA API to load stations. Check the internet connection.');
    }
  }
  await ensureStations().catch(() => {});

  const station = (id) => stationById.get(id) ?? fail(404, 'Unknown station');
  const userById = (id) => db.users.find((u) => u.id === id);
  const requireUser = (id) => userById(id) ?? fail(401, 'Unknown player. Sign in again.');
  const username = (id) => userById(id)?.username ?? 'someone';
  const photoUrl = (name) => `/photos/${name}`;

  function decodeImage(dataUrl) {
    const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/s.exec(String(dataUrl ?? ''));
    if (!m) fail(400, 'Photo must be a JPEG, PNG or WebP image.');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_IMAGE_BYTES) fail(413, 'Photo is too large.');
    if (buf.length < 100) fail(400, 'Photo is empty.');
    return buf;
  }

  function housekeeping() {
    if (game.retireStale(db, now())) store.save();
  }

  // ---------- handlers ----------
  const api = {
    config() {
      return {
        levels: game.LEVELS,
        gemini: Boolean(geminiKey),
        graceSeconds: game.GRACE_SECONDS,
        maxTimeBonus: game.MAX_TIME_BONUS,
      };
    },

    async stations() {
      await ensureStations();
      housekeeping();
      const counts = new Map();
      for (const e of db.eggs) if (e.status === 'active') counts.set(e.stationId, (counts.get(e.stationId) ?? 0) + 1);
      return { stations: stations.map((s) => ({ ...s, activeEggs: counts.get(s.id) ?? 0 })) };
    },

    async station({ params: [id], query }) {
      await ensureStations();
      housekeeping();
      const s = station(id);
      const userId = query.get('userId');
      const slots = game.LEVELS.map((l) => {
        const egg = game.activeEgg(db, id, l.level);
        return {
          ...l,
          egg: egg
            ? {
                id: egg.id,
                timesFound: egg.timesFound,
                createdBy: username(egg.createdBy),
                mine: egg.createdBy === userId,
                foundByMe: userId ? game.hasFound(db, userId, egg.id) : false,
              }
            : null,
        };
      });
      return { station: s, slots };
    },

    async predictions({ params: [id] }) {
      await ensureStations();
      station(id);
      try {
        return { trains: await mbta.predictions(id) };
      } catch (err) {
        return { trains: [], error: `Live train times unavailable (${err.message}).` };
      }
    },

    createUser({ body }) {
      const name = String(body?.username ?? '').trim();
      if (!/^[A-Za-z0-9_. -]{2,20}$/.test(name)) {
        fail(400, 'Username must be 2–20 letters, numbers, spaces, dots, dashes or underscores.');
      }
      if (db.users.some((u) => u.username.toLowerCase() === name.toLowerCase())) {
        fail(409, 'That username is taken.');
      }
      const user = { id: crypto.randomUUID(), username: name, createdAt: now().toISOString() };
      db.users.push(user);
      store.save();
      return { user };
    },

    profile({ params: [id] }) {
      const user = userById(id) ?? fail(404, 'Unknown player');
      const month = game.monthKey(now());
      const mine = db.finds.filter((f) => f.userId === id);
      const monthFinds = mine.filter((f) => game.monthKey(f.foundAt) === month);
      const hidden = db.eggs.filter((e) => e.createdBy === id);
      const hiddenIds = new Set(hidden.map((e) => e.id));
      const findsByLevel = Object.fromEntries(game.LEVELS.map((l) => [l.name, 0]));
      for (const f of mine) findsByLevel[game.levelInfo(f.level).name] += 1;
      const board = leaderboardRows(db.finds.filter((f) => game.monthKey(f.foundAt) === month));
      return {
        user: { id: user.id, username: user.username, createdAt: user.createdAt },
        monthPoints: monthFinds.reduce((sum, f) => sum + f.points, 0),
        allTimePoints: mine.reduce((sum, f) => sum + f.points, 0),
        monthRank: board.find((r) => r.userId === id)?.rank ?? null,
        findsByLevel,
        eggsHidden: hidden.length,
        timesYourEggsWereFound: db.finds.filter((f) => hiddenIds.has(f.eggId)).length,
        recentFinds: mine
          .slice(-10)
          .reverse()
          .map((f) => ({
            id: f.id,
            stationName: stationById.get(f.stationId)?.name ?? f.stationId,
            level: f.level,
            levelName: game.levelInfo(f.level).name,
            points: f.points,
            foundAt: f.foundAt,
            photoUrl: photoUrl(f.photo),
            verified: f.verified,
          })),
      };
    },

    async startAttempt({ body }) {
      const user = requireUser(body?.userId);
      const egg = db.eggs.find((e) => e.id === body?.eggId) ?? fail(404, 'Egg not found');
      if (egg.status !== 'active') fail(409, 'That egg was just swapped out. Pick another.');
      if (egg.createdBy === user.id) fail(403, "You hid this one, so you can't play it.");
      if (game.hasFound(db, user.id, egg.id)) fail(409, 'You already found this egg.');

      const info = game.levelInfo(egg.level);
      let limitSeconds = info.seconds;
      let limitSource = 'fixed';
      let train = null;
      if (body?.mode === 'train') {
        try {
          const trains = await mbta.predictions(egg.stationId);
          train = trains.find(
            (t) => t.seconds >= game.TRAIN_MIN_SECONDS && t.seconds <= game.TRAIN_MAX_SECONDS,
          ) ?? null;
          if (train) {
            limitSeconds = train.seconds;
            limitSource = 'train';
          }
        } catch {
          /* fall back to the fixed timer */
        }
      }

      const attempt = {
        id: crypto.randomUUID(),
        userId: user.id,
        eggId: egg.id,
        startedAt: now().toISOString(),
        limitSeconds,
        limitSource,
        status: 'open',
      };
      db.attempts.push(attempt);
      store.save();
      return {
        attempt: { id: attempt.id, limitSeconds, limitSource, secondsLeft: limitSeconds, train },
        egg: {
          id: egg.id,
          level: egg.level,
          levelName: info.name,
          points: info.points,
          hint: egg.hint,
          imageUrl: photoUrl(egg.photo),
          stationId: egg.stationId,
          stationName: stationById.get(egg.stationId)?.name ?? egg.stationId,
        },
      };
    },

    async submitFind({ params: [attemptId], body }) {
      const user = requireUser(body?.userId);
      const attempt = db.attempts.find((a) => a.id === attemptId) ?? fail(404, 'Round not found');
      if (attempt.userId !== user.id) fail(403, 'Not your round');
      if (attempt.status !== 'open') fail(409, `This round is already ${attempt.status}.`);
      const egg = db.eggs.find((e) => e.id === attempt.eggId) ?? fail(404, 'Egg not found');
      if (game.hasFound(db, user.id, egg.id)) fail(409, 'You already found this egg.');

      const elapsed = (now() - Date.parse(attempt.startedAt)) / 1000;
      if (elapsed > attempt.limitSeconds + game.GRACE_SECONDS) {
        attempt.status = 'expired';
        store.save();
        return { status: 'expired' };
      }

      const candidate = decodeImage(body?.image);
      const original = fs.readFileSync(store.photoPath(egg.photo));
      const verification = await verify({
        originalJpeg: original,
        candidateJpeg: candidate,
        apiKey: geminiKey,
        model: geminiModel,
      });
      const secondsLeft = Math.max(0, Math.round(attempt.limitSeconds - elapsed));
      if (!verification.match) {
        return { status: 'no_match', reason: verification.reason, secondsLeft };
      }

      const secondsTaken = Math.min(elapsed, attempt.limitSeconds);
      const score = game.scoreFind(egg.level, secondsTaken, attempt.limitSeconds);
      const find = {
        id: crypto.randomUUID(),
        eggId: egg.id,
        userId: user.id,
        stationId: egg.stationId,
        level: egg.level,
        foundAt: now().toISOString(),
        secondsTaken: Math.round(secondsTaken),
        points: score.total,
        base: score.base,
        bonus: score.bonus,
        photo: store.savePhoto(candidate),
        verified: verification.method === 'gemini',
        canHide: true,
      };
      db.finds.push(find);
      egg.avgFindSeconds = Math.round(
        ((egg.avgFindSeconds ?? 0) * egg.timesFound + find.secondsTaken) / (egg.timesFound + 1),
      );
      egg.timesFound += 1;
      attempt.status = 'found';
      game.rotateAfterFind(db, egg, user.id, now());
      store.save();
      return {
        status: 'found',
        findId: find.id,
        points: score,
        secondsTaken: find.secondsTaken,
        verification,
        stationId: egg.stationId,
        level: egg.level,
      };
    },

    async createEgg({ body }) {
      await ensureStations();
      const user = requireUser(body?.userId);
      const s = station(body?.stationId);
      const level = Number(body?.level);
      if (!game.LEVELS.some((l) => l.level === level)) fail(400, 'Level must be 1–5.');

      if (body?.findId) {
        const find = db.finds.find((f) => f.id === body.findId) ?? fail(404, 'Find not found');
        if (find.userId !== user.id) fail(403, 'Not your find');
        if (!find.canHide) fail(409, 'You already hid an egg for this find.');
        if (find.stationId !== s.id || find.level !== level) {
          fail(400, 'The new egg must be at the same station and level as the one you found.');
        }
        const ageMin = (now() - Date.parse(find.foundAt)) / 60000;
        if (ageMin > game.HIDE_WINDOW_MINUTES) fail(409, 'Too long since your find to hide the next egg.');
        find.canHide = false;
      } else if (game.activeEgg(db, s.id, level)) {
        fail(409, 'This level already has an egg. Find it first to earn the right to hide the next one.');
      }

      const hint = String(body?.hint ?? '').trim().slice(0, 80);
      const egg = {
        id: crypto.randomUUID(),
        stationId: s.id,
        level,
        photo: store.savePhoto(decodeImage(body?.image)),
        hint,
        createdBy: user.id,
        createdAt: now().toISOString(),
        timesFound: 0,
        avgFindSeconds: null,
      };
      game.placeEgg(db, egg, now());
      store.save();
      return { egg: { id: egg.id, stationId: egg.stationId, level: egg.level } };
    },

    reportEgg({ params: [eggId], body }) {
      const user = requireUser(body?.userId);
      const egg = db.eggs.find((e) => e.id === eggId) ?? fail(404, 'Egg not found');
      const reason = ['cant_find', 'unsafe', 'person', 'other'].includes(body?.reason) ? body.reason : 'other';
      if (!db.reports.some((r) => r.eggId === eggId && r.userId === user.id)) {
        db.reports.push({ id: crypto.randomUUID(), eggId, userId: user.id, reason, createdAt: now().toISOString() });
      }
      const count = db.reports.filter((r) => r.eggId === eggId).length;
      const retired = count >= game.REPORTS_TO_RETIRE && egg.status !== 'retired';
      if (retired) game.retireEgg(db, egg, now());
      store.save();
      return { reports: count, retired };
    },

    leaderboard({ query }) {
      const month = query.get('month') || game.monthKey(now());
      const stationId = query.get('stationId');
      let finds = db.finds.filter((f) => game.monthKey(f.foundAt) === month);
      if (stationId) finds = finds.filter((f) => f.stationId === stationId);

      const lineTotals = new Map();
      for (const f of finds) {
        const families = new Set((stationById.get(f.stationId)?.lines ?? []).map((l) => game.lineFamily(l.id)));
        for (const fam of families) lineTotals.set(fam, (lineTotals.get(fam) ?? 0) + f.points);
      }
      return {
        month,
        stationId,
        rows: leaderboardRows(finds).slice(0, 50),
        lines: [...lineTotals].map(([line, points]) => ({ line, points })).sort((a, b) => b.points - a.points),
      };
    },
  };

  function leaderboardRows(finds) {
    const totals = new Map();
    for (const f of finds) {
      const t = totals.get(f.userId) ?? { userId: f.userId, points: 0, finds: 0 };
      t.points += f.points;
      t.finds += 1;
      totals.set(f.userId, t);
    }
    return [...totals.values()]
      .sort((a, b) => b.points - a.points || b.finds - a.finds)
      .map((t, i) => ({ ...t, rank: i + 1, username: username(t.userId) }));
  }

  const routes = [
    ['GET', /^\/api\/config$/, api.config],
    ['GET', /^\/api\/stations$/, api.stations],
    ['GET', /^\/api\/stations\/([^/]+)$/, api.station],
    ['GET', /^\/api\/stations\/([^/]+)\/predictions$/, api.predictions],
    ['POST', /^\/api\/users$/, api.createUser],
    ['GET', /^\/api\/users\/([^/]+)$/, api.profile],
    ['POST', /^\/api\/attempts$/, api.startAttempt],
    ['POST', /^\/api\/attempts\/([^/]+)\/find$/, api.submitFind],
    ['POST', /^\/api\/eggs$/, api.createEgg],
    ['POST', /^\/api\/eggs\/([^/]+)\/report$/, api.reportEgg],
    ['GET', /^\/api\/leaderboard$/, api.leaderboard],
  ];

  async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);

      if (pathname.startsWith('/api/')) {
        for (const [method, re, fn] of routes) {
          const m = re.exec(pathname);
          if (!m || req.method !== method) continue;
          const body = method === 'POST' ? await readJson(req) : null;
          return sendJson(res, 200, await fn({ params: m.slice(1), query: url.searchParams, body }));
        }
        fail(404, 'Not found');
      }

      if (pathname.startsWith('/photos/')) {
        const file = store.photoPath(pathname.slice('/photos/'.length));
        if (!file || !fs.existsSync(file)) fail(404, 'Photo not found');
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' });
        return fs.createReadStream(file).pipe(res);
      }

      return serveStatic(pathname, res);
    } catch (err) {
      const status = err.status ?? 500;
      if (status === 500) console.error(err);
      sendJson(res, status, { error: status === 500 ? 'Server error' : err.message });
    }
  }

  return { handler, store };
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    fail(404, 'Not found');
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Upload too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

// ---------- run directly ----------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dataDir = path.join(ROOT, 'data');
  const app = await createApp({
    dataDir,
    mbta: createMbta({ apiKey: process.env.MBTA_API_KEY, cacheFile: path.join(dataDir, 'stations.json') }),
    geminiKey: process.env.GEMINI_API_KEY ?? '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  });
  const port = Number(process.env.PORT) || 3000;
  http.createServer(app.handler).listen(port, '0.0.0.0', () => {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i?.family === 'IPv4' && !i.internal)?.address;
    console.log(`Station Egg Hunt running:`);
    console.log(`  this laptop:  http://localhost:${port}`);
    if (lan) console.log(`  same Wi-Fi:   http://${lan}:${port}`);
    console.log(`  photo check:  ${process.env.GEMINI_API_KEY ? 'Gemini' : 'honor system (no GEMINI_API_KEY)'}`);
  });
}
