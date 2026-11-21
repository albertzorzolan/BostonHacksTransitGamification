// Station Egg Hunt API. Stateless: everything lives in MongoDB, so any number
// of instances (or serverless functions) can serve it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifyMatch } from './verify.js';
import { isDuplicateKey } from './db.js';
import * as game from './game.js';
import * as slots from './slots.js';
import * as auth from './auth.js';

// Vercel functions accept request bodies up to 4.5 MB; phones send ~0.3 MB after downscaling.
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;
const HOUSEKEEPING_EVERY_MS = 60_000;
const SESSION_TOUCH_MS = 60 * 60_000; // refresh last_seen / expiry at most hourly
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

/**
 * @param {object} opts
 * @param {Awaited<ReturnType<import('./db.js').createDb>>} opts.db
 * @param {string|null} [opts.frontendDir] serve the web app from here too (handy for one-tunnel phone testing)
 * @param {string[]} [opts.corsOrigins] allowed browser origins, or ['*']
 */
export async function createApp({
  db,
  mbta,
  verify = verifyMatch,
  geminiKey = '',
  geminiModel = 'gemini-2.5-flash',
  now = () => new Date(),
  frontendDir = null,
  corsOrigins = ['*'],
}) {
  const { col, tx } = db;

  // ---------- stations (static list, cached per instance) ----------
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
  const stationName = (id) => stationById.get(id)?.name ?? id;
  const photoUrl = (id) => `/photos/${id}.jpg`;
  const publicUser = (u) => ({ id: u._id, username: u.username, createdAt: u.createdAt });
  const requireUser = (ctx) => ctx.user ?? fail(401, 'Sign in to play.');
  const hasFound = (userId, eggId, session) => col.finds.findOne({ userId, eggId }, { session, projection: { _id: 1 } });

  function decodeImage(dataUrl) {
    const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/s.exec(String(dataUrl ?? ''));
    if (!m) fail(400, 'Photo must be a JPEG, PNG or WebP image.');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_IMAGE_BYTES) fail(413, 'Photo is too large.');
    if (buf.length < 100) fail(400, 'Photo is empty.');
    return { data: buf, contentType: `image/${m[1]}` };
  }

  async function savePhoto(session, { data, contentType }) {
    const _id = crypto.randomUUID();
    await col.photos.insertOne({ _id, contentType, data, createdAt: now() }, { session });
    return _id;
  }

  // Retiring stale eggs runs lazily on station reads, at most once a minute per instance.
  let lastHousekeeping = -Infinity;
  async function housekeeping() {
    const t = now();
    if (t.getTime() - lastHousekeeping < HOUSEKEEPING_EVERY_MS) return;
    lastHousekeeping = t.getTime();
    await slots.retireStale(db, t);
  }

  // ---------- sessions ----------
  async function startSession(user, req) {
    const token = auth.newToken();
    const t = now();
    await col.sessions.insertOne({
      _id: crypto.randomUUID(),
      userId: user._id,
      tokenHash: auth.hashToken(token),
      device: String(req.headers['user-agent'] ?? '').slice(0, 200),
      createdAt: t,
      lastSeenAt: t,
      expiresAt: new Date(t.getTime() + auth.SESSION_DAYS * 86400_000),
    });
    return { user: publicUser(user), token };
  }

  // Returns { user, sessionId } for a valid bearer token, null with no token, 401 for a bad one.
  async function authenticate(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (!m) return null;
    const t = now();
    const s = await col.sessions.findOne({ tokenHash: auth.hashToken(m[1]), expiresAt: { $gt: t } });
    const user = s && (await col.users.findOne({ _id: s.userId }));
    if (!user) fail(401, 'Your session has expired. Sign in again.');
    if (t - s.lastSeenAt > SESSION_TOUCH_MS) {
      await col.sessions.updateOne(
        { _id: s._id },
        { $set: { lastSeenAt: t, expiresAt: new Date(t.getTime() + auth.SESSION_DAYS * 86400_000) } },
      );
    }
    return { user, sessionId: s._id };
  }

  const credentials = (body) => ({ username: String(body?.username ?? '').trim(), password: String(body?.password ?? '') });

  // Monthly totals per player, best first. Ties: more finds, then username.
  function monthBoard(match) {
    return col.finds
      .aggregate([
        { $match: match },
        { $group: { _id: '$userId', points: { $sum: '$points' }, finds: { $sum: 1 } } },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
        { $set: { username: { $first: '$u.username' } } },
        { $sort: { points: -1, finds: -1, username: 1 } },
        { $project: { u: 0 } },
      ])
      .toArray();
  }

  // ---------- handlers ----------
  const api = {
    async health() {
      await db.db.command({ ping: 1 });
      return { ok: true };
    },

    config() {
      return {
        levels: game.LEVELS,
        gemini: Boolean(geminiKey),
        graceSeconds: game.GRACE_SECONDS,
        maxTimeBonus: game.MAX_TIME_BONUS,
        passwordMin: auth.PASSWORD_MIN,
      };
    },

    // ----- auth -----
    async register({ body, req }) {
      const { username, password } = credentials(body);
      if (!/^[A-Za-z0-9_. -]{2,20}$/.test(username)) {
        fail(400, 'Username must be 2–20 letters, numbers, spaces, dots, dashes or underscores.');
      }
      if (password.length < auth.PASSWORD_MIN) fail(400, `Password must be at least ${auth.PASSWORD_MIN} characters.`);
      if (password.length > auth.PASSWORD_MAX) fail(400, 'Password is too long.');
      const user = {
        _id: crypto.randomUUID(),
        username,
        usernameLower: username.toLowerCase(),
        passwordHash: await auth.hashPassword(password),
        createdAt: now(),
      };
      try {
        await col.users.insertOne(user);
      } catch (err) {
        if (isDuplicateKey(err)) fail(409, 'That username is taken.');
        throw err;
      }
      return startSession(user, req);
    },

    async login({ body, req }) {
      const { username, password } = credentials(body);
      if (!username || !password || password.length > auth.PASSWORD_MAX) fail(400, 'Enter your username and password.');
      const user = await col.users.findOne({ usernameLower: username.toLowerCase() });
      const ok = await auth.verifyPassword(password, user?.passwordHash ?? auth.DUMMY_HASH);
      if (!user || !ok) fail(401, 'Wrong username or password.');
      return startSession(user, req);
    },

    async logout(ctx) {
      requireUser(ctx);
      await col.sessions.deleteOne({ _id: ctx.sessionId });
      return { ok: true };
    },

    async logoutAll(ctx) {
      const user = requireUser(ctx);
      const r = await col.sessions.deleteMany({ userId: user._id });
      return { ok: true, signedOut: r.deletedCount };
    },

    me(ctx) {
      return { user: publicUser(requireUser(ctx)) };
    },

    async sessions(ctx) {
      const user = requireUser(ctx);
      const rows = await col.sessions
        .find({ userId: user._id, expiresAt: { $gt: now() } })
        .sort({ lastSeenAt: -1 })
        .toArray();
      return {
        sessions: rows.map((s) => ({
          id: s._id,
          device: s.device,
          createdAt: s.createdAt,
          lastSeenAt: s.lastSeenAt,
          current: s._id === ctx.sessionId,
        })),
      };
    },

    // ----- game -----
    async stations() {
      await ensureStations();
      await housekeeping();
      const counts = new Map(
        (await col.eggs.aggregate([{ $match: { status: 'active' } }, { $group: { _id: '$stationId', n: { $sum: 1 } } }]).toArray()).map(
          (r) => [r._id, r.n],
        ),
      );
      return { stations: stations.map((s) => ({ ...s, activeEggs: counts.get(s.id) ?? 0 })) };
    },

    async station({ params: [id], user }) {
      await ensureStations();
      await housekeeping();
      const s = station(id);
      const eggs = await col.eggs.find({ stationId: id, status: 'active' }).toArray();
      const creators = new Map(
        (await col.users.find({ _id: { $in: eggs.map((e) => e.createdBy) } }, { projection: { username: 1 } }).toArray()).map((u) => [
          u._id,
          u.username,
        ]),
      );
      const foundByMe = new Set(
        user
          ? (await col.finds.find({ userId: user._id, eggId: { $in: eggs.map((e) => e._id) } }, { projection: { eggId: 1 } }).toArray()).map(
              (f) => f.eggId,
            )
          : [],
      );
      const byLevel = new Map(eggs.map((e) => [e.level, e]));
      const slotsOut = game.LEVELS.map((l) => {
        const egg = byLevel.get(l.level);
        return {
          ...l,
          egg: egg
            ? {
                id: egg._id,
                timesFound: egg.timesFound,
                createdBy: creators.get(egg.createdBy) ?? 'someone',
                mine: egg.createdBy === user?._id,
                foundByMe: foundByMe.has(egg._id),
              }
            : null,
        };
      });
      return { station: s, slots: slotsOut };
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

    async profile(ctx) {
      requireUser(ctx);
      const [id] = ctx.params;
      if (!isUuid(id)) fail(404, 'Unknown player');
      const user = (await col.users.findOne({ _id: id })) ?? fail(404, 'Unknown player');
      const month = game.monthKey(now());
      const [totals] = await col.finds
        .aggregate([
          { $match: { userId: id } },
          {
            $group: {
              _id: null,
              allTime: { $sum: '$points' },
              month: { $sum: { $cond: [{ $eq: ['$month', month] }, '$points', 0] } },
            },
          },
        ])
        .toArray();
      const board = await monthBoard({ month });
      const rankIndex = board.findIndex((r) => r._id === id);
      const findsByLevel = Object.fromEntries(game.LEVELS.map((l) => [l.name, 0]));
      for (const r of await col.finds.aggregate([{ $match: { userId: id } }, { $group: { _id: '$level', n: { $sum: 1 } } }]).toArray()) {
        findsByLevel[game.levelInfo(r._id).name] = r.n;
      }
      const myEggIds = (await col.eggs.find({ createdBy: id }, { projection: { _id: 1 } }).toArray()).map((e) => e._id);
      const recent = await col.finds.find({ userId: id }).sort({ foundAt: -1, _id: -1 }).limit(10).toArray();
      return {
        user: publicUser(user),
        monthPoints: totals?.month ?? 0,
        allTimePoints: totals?.allTime ?? 0,
        monthRank: rankIndex >= 0 ? rankIndex + 1 : null,
        findsByLevel,
        eggsHidden: myEggIds.length,
        timesYourEggsWereFound: myEggIds.length ? await col.finds.countDocuments({ eggId: { $in: myEggIds } }) : 0,
        recentFinds: recent.map((f) => ({
          id: f._id,
          stationName: stationName(f.stationId),
          level: f.level,
          levelName: game.levelInfo(f.level).name,
          points: f.points,
          foundAt: f.foundAt,
          photoUrl: photoUrl(f.photoId),
          verified: f.verified,
        })),
      };
    },

    async startAttempt(ctx) {
      const user = requireUser(ctx);
      const { body } = ctx;
      if (!isUuid(body?.eggId)) fail(404, 'Egg not found');
      const egg = (await col.eggs.findOne({ _id: body.eggId })) ?? fail(404, 'Egg not found');
      if (egg.status !== 'active') fail(409, 'That egg was just swapped out. Pick another.');
      if (egg.createdBy === user._id) fail(403, "You hid this one, so you can't play it.");
      if (await hasFound(user._id, egg._id)) fail(409, 'You already found this egg.');

      const info = game.levelInfo(egg.level);
      let limitSeconds = info.seconds;
      let limitSource = 'fixed';
      let train = null;
      if (body?.mode === 'train') {
        try {
          const trains = await mbta.predictions(egg.stationId);
          train = trains.find((t) => t.seconds >= game.TRAIN_MIN_SECONDS && t.seconds <= game.TRAIN_MAX_SECONDS) ?? null;
          if (train) {
            limitSeconds = train.seconds;
            limitSource = 'train';
          }
        } catch {
          /* fall back to the fixed timer */
        }
      }

      const attemptId = crypto.randomUUID();
      await col.attempts.insertOne({
        _id: attemptId,
        userId: user._id,
        eggId: egg._id,
        startedAt: now(),
        limitSeconds,
        limitSource,
        status: 'open',
      });
      return {
        attempt: { id: attemptId, limitSeconds, limitSource, secondsLeft: limitSeconds, train },
        egg: {
          id: egg._id,
          level: egg.level,
          levelName: info.name,
          points: info.points,
          hint: egg.hint,
          imageUrl: photoUrl(egg.photoId),
          stationId: egg.stationId,
          stationName: stationName(egg.stationId),
        },
      };
    },

    async submitFind(ctx) {
      const user = requireUser(ctx);
      const [attemptId] = ctx.params;
      if (!isUuid(attemptId)) fail(404, 'Round not found');
      const attempt = (await col.attempts.findOne({ _id: attemptId })) ?? fail(404, 'Round not found');
      if (attempt.userId !== user._id) fail(403, 'Not your round');
      if (attempt.status !== 'open') fail(409, `This round is already ${attempt.status}.`);
      const egg = (await col.eggs.findOne({ _id: attempt.eggId })) ?? fail(404, 'Egg not found');
      if (await hasFound(user._id, egg._id)) fail(409, 'You already found this egg.');

      const elapsed = (now() - attempt.startedAt) / 1000;
      if (elapsed > attempt.limitSeconds + game.GRACE_SECONDS) {
        await col.attempts.updateOne({ _id: attempt._id, status: 'open' }, { $set: { status: 'expired' } });
        return { status: 'expired' };
      }

      const candidate = decodeImage(ctx.body?.image);
      const original = await col.photos.findOne({ _id: egg.photoId }, { promoteBuffers: true });
      // The (slow) photo check runs outside any transaction.
      const verification = await verify({
        originalJpeg: original.data,
        candidateJpeg: candidate.data,
        apiKey: geminiKey,
        model: geminiModel,
      });
      const secondsLeft = Math.max(0, Math.round(attempt.limitSeconds - elapsed));
      if (!verification.match) return { status: 'no_match', reason: verification.reason, secondsLeft };

      const secondsTaken = Math.min(elapsed, attempt.limitSeconds);
      const score = game.scoreFind(egg.level, secondsTaken, attempt.limitSeconds);
      const findId = crypto.randomUUID();
      const t = now();
      await tx(async (session) => {
        await slots.lockSlot(col, session, egg.stationId, egg.level);
        // Closing the round atomically means a round submitted twice (two tabs) scores once.
        const closed = await col.attempts.findOneAndUpdate(
          { _id: attempt._id, status: 'open' },
          { $set: { status: 'found' } },
          { session },
        );
        if (!closed) fail(409, 'This round is already finished.');
        const photoId = await savePhoto(session, candidate);
        try {
          await col.finds.insertOne(
            {
              _id: findId,
              eggId: egg._id,
              userId: user._id,
              stationId: egg.stationId,
              level: egg.level,
              foundAt: t,
              month: game.monthKey(t),
              secondsTaken: Math.round(secondsTaken),
              points: score.total,
              base: score.base,
              bonus: score.bonus,
              photoId,
              verified: verification.method === 'gemini',
              canHide: true,
            },
            { session },
          );
        } catch (err) {
          if (isDuplicateKey(err)) fail(409, 'You already found this egg.');
          throw err;
        }
        const fresh = await col.eggs.findOne({ _id: egg._id }, { session });
        const avg = Math.round(((fresh.avgFindSeconds ?? 0) * fresh.timesFound + Math.round(secondsTaken)) / (fresh.timesFound + 1));
        await col.eggs.updateOne({ _id: egg._id }, { $set: { avgFindSeconds: avg }, $inc: { timesFound: 1 } }, { session });
        if (fresh.status === 'active') await slots.rotateAfterFind(col, session, fresh, user._id, t);
      });
      return {
        status: 'found',
        findId,
        points: score,
        secondsTaken: Math.round(secondsTaken),
        verification,
        stationId: egg.stationId,
        level: egg.level,
      };
    },

    async createEgg(ctx) {
      const user = requireUser(ctx);
      const { body } = ctx;
      await ensureStations();
      const s = station(body?.stationId);
      const level = Number(body?.level);
      if (!game.LEVELS.some((l) => l.level === level)) fail(400, 'Level must be 1–5.');
      const image = decodeImage(body?.image);
      const hint = String(body?.hint ?? '').trim().slice(0, 80);
      const t = now();
      const eggId = crypto.randomUUID();

      await tx(async (session) => {
        await slots.lockSlot(col, session, s.id, level);
        if (body?.findId) {
          if (!isUuid(body.findId)) fail(404, 'Find not found');
          const find = (await col.finds.findOne({ _id: body.findId }, { session })) ?? fail(404, 'Find not found');
          if (find.userId !== user._id) fail(403, 'Not your find');
          if (!find.canHide) fail(409, 'You already hid an egg for this find.');
          if (find.stationId !== s.id || find.level !== level) {
            fail(400, 'The new egg must be at the same station and level as the one you found.');
          }
          if ((t - find.foundAt) / 60000 > game.HIDE_WINDOW_MINUTES) fail(409, 'Too long since your find to hide the next egg.');
          await col.finds.updateOne({ _id: find._id }, { $set: { canHide: false } }, { session });
        } else if (await slots.activeEgg(col, session, s.id, level)) {
          fail(409, 'This level already has an egg. Find it first to earn the right to hide the next one.');
        }
        const photoId = await savePhoto(session, image);
        await slots.placeEgg(col, session, { _id: eggId, stationId: s.id, level, photoId, hint, createdBy: user._id }, t);
      });
      return { egg: { id: eggId, stationId: s.id, level } };
    },

    async reportEgg(ctx) {
      const user = requireUser(ctx);
      const [eggId] = ctx.params;
      if (!isUuid(eggId)) fail(404, 'Egg not found');
      const reason = ['cant_find', 'unsafe', 'person', 'other'].includes(ctx.body?.reason) ? ctx.body.reason : 'other';
      const first = (await col.eggs.findOne({ _id: eggId })) ?? fail(404, 'Egg not found');
      const t = now();
      return tx(async (session) => {
        await slots.lockSlot(col, session, first.stationId, first.level);
        const egg = await col.eggs.findOne({ _id: eggId }, { session });
        // Upsert so a player's repeat report doesn't count twice.
        await col.reports.updateOne(
          { eggId, userId: user._id },
          { $setOnInsert: { _id: crypto.randomUUID(), reason, createdAt: t } },
          { upsert: true, session },
        );
        const n = await col.reports.countDocuments({ eggId }, { session });
        const retired = n >= game.REPORTS_TO_RETIRE && egg.status !== 'retired';
        if (retired) await slots.retireEgg(col, session, egg, t);
        return { reports: n, retired };
      });
    },

    async leaderboard({ query }) {
      await ensureStations();
      const month = query.get('month') || game.monthKey(now());
      if (!/^\d{4}-\d{2}$/.test(month)) fail(400, 'Month must look like 2026-11.');
      const stationId = query.get('stationId') || null;
      const match = stationId ? { month, stationId } : { month };
      const board = await monthBoard(match);
      const byStation = await col.finds.aggregate([{ $match: match }, { $group: { _id: '$stationId', points: { $sum: '$points' } } }]).toArray();
      const lineTotals = new Map();
      for (const r of byStation) {
        const families = new Set((stationById.get(r._id)?.lines ?? []).map((l) => game.lineFamily(l.id)));
        for (const fam of families) lineTotals.set(fam, (lineTotals.get(fam) ?? 0) + r.points);
      }
      return {
        month,
        stationId,
        rows: board.slice(0, 50).map((r, i) => ({ userId: r._id, username: r.username, points: r.points, finds: r.finds, rank: i + 1 })),
        lines: [...lineTotals].map(([line, points]) => ({ line, points })).sort((a, b) => b.points - a.points),
      };
    },
  };

  // [method, path, handler, auth]. auth: 'none' skips the token check,
  // 'optional' reads it if sent (handlers call requireUser when they need one).
  const routes = [
    ['GET', /^\/api\/health$/, api.health, 'none'],
    ['GET', /^\/api\/config$/, api.config, 'none'],
    ['POST', /^\/api\/auth\/register$/, api.register, 'none'],
    ['POST', /^\/api\/auth\/login$/, api.login, 'none'],
    ['POST', /^\/api\/auth\/logout$/, api.logout, 'optional'],
    ['POST', /^\/api\/auth\/logout-all$/, api.logoutAll, 'optional'],
    ['GET', /^\/api\/auth\/me$/, api.me, 'optional'],
    ['GET', /^\/api\/auth\/sessions$/, api.sessions, 'optional'],
    ['GET', /^\/api\/stations$/, api.stations, 'none'],
    ['GET', /^\/api\/stations\/([^/]+)$/, api.station, 'optional'],
    ['GET', /^\/api\/stations\/([^/]+)\/predictions$/, api.predictions, 'none'],
    ['GET', /^\/api\/users\/([^/]+)$/, api.profile, 'optional'],
    ['POST', /^\/api\/attempts$/, api.startAttempt, 'optional'],
    ['POST', /^\/api\/attempts\/([^/]+)\/find$/, api.submitFind, 'optional'],
    ['POST', /^\/api\/eggs$/, api.createEgg, 'optional'],
    ['POST', /^\/api\/eggs\/([^/]+)\/report$/, api.reportEgg, 'optional'],
    ['GET', /^\/api\/leaderboard$/, api.leaderboard, 'none'],
  ];

  function corsHeaders(req) {
    const origin = req.headers.origin;
    if (!origin) return {};
    const allowed = corsOrigins.includes('*') ? '*' : corsOrigins.includes(origin) ? origin : null;
    if (!allowed) return {};
    return {
      'access-control-allow-origin': allowed,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-max-age': '600',
      vary: 'Origin',
    };
  }

  async function handler(req, res) {
    const cors = corsHeaders(req);
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);

      if (pathname.startsWith('/api/')) {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, cors);
          return res.end();
        }
        for (const [method, re, fn, authMode] of routes) {
          const m = re.exec(pathname);
          if (!m || req.method !== method) continue;
          const session = authMode === 'none' ? null : await authenticate(req);
          const body = method === 'POST' ? await readJson(req) : null;
          const ctx = { params: m.slice(1), query: url.searchParams, body, req, user: session?.user ?? null, sessionId: session?.sessionId ?? null };
          return sendJson(res, 200, await fn(ctx), cors);
        }
        fail(404, 'Not found');
      }

      const photo = /^\/photos\/([0-9a-f-]{36})\.jpg$/i.exec(pathname);
      if (photo) {
        const row = isUuid(photo[1]) && (await col.photos.findOne({ _id: photo[1] }, { promoteBuffers: true }));
        if (!row) fail(404, 'Photo not found');
        res.writeHead(200, {
          ...cors,
          'content-type': row.contentType,
          // Photos never change, so browsers and CDNs can keep them.
          'cache-control': 'public, max-age=31536000, immutable',
        });
        return res.end(row.data);
      }

      if (!frontendDir) fail(404, 'Not found');
      return serveStatic(frontendDir, pathname, res);
    } catch (err) {
      const status = err.status ?? 500;
      if (status === 500) console.error(err);
      sendJson(res, status, { error: status === 500 ? 'Server error' : err.message }, cors);
    }
  }

  return { handler };
}

function serveStatic(root, pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
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

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { ...extraHeaders, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
