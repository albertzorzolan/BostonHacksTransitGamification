// Station Egg Hunt API. Stateless: everything lives in Postgres, so any number
// of instances can run behind a load balancer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifyMatch } from './verify.js';
import { isUniqueViolation } from './db.js';
import * as game from './game.js';
import * as slots from './slots.js';
import * as auth from './auth.js';

const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
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
 * @param {ReturnType<import('./db.js').createDb>} opts.db
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
  const publicUser = (u) => ({ id: u.id, username: u.username, createdAt: u.created_at });
  const requireUser = (ctx) => ctx.user ?? fail(401, 'Sign in to play.');

  // ---------- rounds: resume, retry cooldown ----------
  // A round can be submitted until limit + grace after it started.
  const roundEnd = (a) => new Date(a.started_at.getTime() + (a.limit_seconds + game.GRACE_SECONDS) * 1000);
  const isRunning = (a, t) => a?.status === 'open' && t < roundEnd(a);
  // When this player may start a new round on an egg, given their latest round on it.
  // null means right now (or never, if they found it).
  function retryAt(a, t) {
    if (!a || a.status === 'found' || isRunning(a, t)) return null;
    const ended = Math.min(roundEnd(a).getTime(), a.ended_at?.getTime() ?? Infinity);
    const at = new Date(ended + game.RETRY_COOLDOWN_MINUTES * 60_000);
    return at > t ? at : null;
  }
  const latestAttempt = (userId, eggId) =>
    db.one('select * from attempts where user_id = $1 and egg_id = $2 order by started_at desc limit 1', [userId, eggId]);

  // The round as the app sees it. secondsLeft is worked out from the server clock, so a
  // phone that reloads, slept or lost signal picks up exactly where the round really is.
  function roundPayload(a, egg, t, train = null) {
    const info = game.levelInfo(egg.level);
    return {
      attempt: {
        id: a.id,
        limitSeconds: a.limit_seconds,
        limitSource: a.limit_source,
        secondsLeft: Math.round(a.limit_seconds - (t - a.started_at) / 1000),
        train,
      },
      egg: {
        id: egg.id,
        level: egg.level,
        levelName: info.name,
        points: info.points,
        hint: egg.hint,
        imageUrl: photoUrl(egg.photo_id),
        stationId: egg.station_id,
        stationName: stationName(egg.station_id),
      },
    };
  }

  // A find replayed for a retried upload (the first response never reached the phone).
  async function replayFind(attempt, userId) {
    const f = await db.one(
      `select f.*, not exists (select 1 from finds g where g.egg_id = f.egg_id and g.id <> f.id
                and (g.found_at < f.found_at or (g.found_at = f.found_at and g.id < f.id))) as first
         from finds f where f.user_id = $1 and f.egg_id = $2`,
      [userId, attempt.egg_id],
    );
    if (!f) fail(409, `This round is already ${attempt.status.replace('_', ' ')}.`);
    return {
      status: 'found',
      findId: f.id,
      points: { base: f.base, bonus: f.bonus, total: f.points },
      secondsTaken: f.seconds_taken,
      verification: f.verified
        ? { method: 'gemini', match: true, reason: '' }
        : { method: 'honor', match: true, reason: 'Counted on the honor system.' },
      stationId: f.station_id,
      level: f.level,
      firstFind: f.first,
      replayed: true,
    };
  }

  function decodeImage(dataUrl) {
    const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/s.exec(String(dataUrl ?? ''));
    if (!m) fail(400, 'Photo must be a JPEG, PNG or WebP image.');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_IMAGE_BYTES) fail(413, 'Photo is too large.');
    if (buf.length < 100) fail(400, 'Photo is empty.');
    return { data: buf, contentType: `image/${m[1]}` };
  }

  async function savePhoto(c, { data, contentType }) {
    const id = crypto.randomUUID();
    await c.query('insert into photos (id, content_type, data, created_at) values ($1, $2, $3, $4)', [
      id,
      contentType,
      data,
      now(),
    ]);
    return id;
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
    await db.query(
      `insert into sessions (id, user_id, token_hash, device, created_at, last_seen_at, expires_at)
       values ($1, $2, $3, $4, $5, $5, $6)`,
      [
        crypto.randomUUID(),
        user.id,
        auth.hashToken(token),
        String(req.headers['user-agent'] ?? '').slice(0, 200),
        t,
        new Date(t.getTime() + auth.SESSION_DAYS * 86400_000),
      ],
    );
    return { user: publicUser(user), token };
  }

  // Returns { user, session } for a valid bearer token, null with no token, 401 for a bad one.
  async function authenticate(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (!m) return null;
    const t = now();
    const row = await db.one(
      `select s.id as session_id, s.last_seen_at, u.id, u.username, u.created_at
         from sessions s join users u on u.id = s.user_id
        where s.token_hash = $1 and s.expires_at > $2`,
      [auth.hashToken(m[1]), t],
    );
    if (!row) fail(401, 'Your session has expired. Sign in again.');
    if (t - row.last_seen_at > SESSION_TOUCH_MS) {
      await db.query('update sessions set last_seen_at = $2, expires_at = $3 where id = $1', [
        row.session_id,
        t,
        new Date(t.getTime() + auth.SESSION_DAYS * 86400_000),
      ]);
    }
    return { user: row, sessionId: row.session_id };
  }

  function validateCredentials(body) {
    const username = String(body?.username ?? '').trim();
    const password = String(body?.password ?? '');
    return { username, password };
  }

  // ---------- handlers ----------
  const api = {
    async health() {
      await db.query('select 1');
      return { ok: true };
    },

    config() {
      return {
        levels: game.LEVELS,
        gemini: Boolean(geminiKey),
        graceSeconds: game.GRACE_SECONDS,
        maxTimeBonus: game.MAX_TIME_BONUS,
        passwordMin: auth.PASSWORD_MIN,
        hideWindowMinutes: game.HIDE_WINDOW_MINUTES,
        retryCooldownMinutes: game.RETRY_COOLDOWN_MINUTES,
      };
    },

    // ----- auth -----
    async register({ body, req }) {
      const { username, password } = validateCredentials(body);
      if (!/^[A-Za-z0-9_. -]{2,20}$/.test(username)) {
        fail(400, 'Username must be 2–20 letters, numbers, spaces, dots, dashes or underscores.');
      }
      if (password.length < auth.PASSWORD_MIN) fail(400, `Password must be at least ${auth.PASSWORD_MIN} characters.`);
      if (password.length > auth.PASSWORD_MAX) fail(400, 'Password is too long.');
      const user = { id: crypto.randomUUID(), username, created_at: now() };
      try {
        await db.query('insert into users (id, username, password_hash, created_at) values ($1, $2, $3, $4)', [
          user.id,
          username,
          await auth.hashPassword(password),
          user.created_at,
        ]);
      } catch (err) {
        if (isUniqueViolation(err)) fail(409, 'That username is taken.');
        throw err;
      }
      return startSession(user, req);
    },

    async login({ body, req }) {
      const { username, password } = validateCredentials(body);
      if (!username || !password || password.length > auth.PASSWORD_MAX) fail(400, 'Enter your username and password.');
      const user = await db.one('select * from users where lower(username) = lower($1)', [username]);
      const ok = await auth.verifyPassword(password, user?.password_hash ?? auth.DUMMY_HASH);
      if (!user || !ok) fail(401, 'Wrong username or password.');
      return startSession(user, req);
    },

    async logout(ctx) {
      requireUser(ctx);
      await db.query('delete from sessions where id = $1', [ctx.sessionId]);
      return { ok: true };
    },

    async logoutAll(ctx) {
      const user = requireUser(ctx);
      const r = await db.query('delete from sessions where user_id = $1', [user.id]);
      return { ok: true, signedOut: r.rowCount };
    },

    me(ctx) {
      return { user: publicUser(requireUser(ctx)) };
    },

    async sessions(ctx) {
      const user = requireUser(ctx);
      const rows = await db.many(
        `select id, device, created_at, last_seen_at from sessions
          where user_id = $1 and expires_at > $2 order by last_seen_at desc`,
        [user.id, now()],
      );
      return {
        sessions: rows.map((s) => ({
          id: s.id,
          device: s.device,
          createdAt: s.created_at,
          lastSeenAt: s.last_seen_at,
          current: s.id === ctx.sessionId,
        })),
      };
    },

    // ----- game -----
    async stations() {
      await ensureStations();
      await housekeeping();
      const counts = new Map(
        (await db.many(`select station_id, count(*)::int as n from eggs where status = 'active' group by station_id`)).map(
          (r) => [r.station_id, r.n],
        ),
      );
      return { stations: stations.map((s) => ({ ...s, activeEggs: counts.get(s.id) ?? 0 })) };
    },

    async station({ params: [id], user }) {
      await ensureStations();
      await housekeeping();
      const s = station(id);
      const t = now();
      const eggs = await db.many(
        `select e.id, e.level, e.times_found, e.created_by, u.username as creator,
                exists (select 1 from finds f where f.egg_id = e.id and f.user_id = $2::uuid) as found_by_me
           from eggs e join users u on u.id = e.created_by
          where e.station_id = $1 and e.status = 'active'`,
        [id, user?.id ?? null],
      );
      // Your latest round on each egg here: running (resume it) or cooling down.
      const mine = user && eggs.length
        ? await db.many(
            `select distinct on (egg_id) * from attempts
              where user_id = $1 and egg_id = any($2::uuid[]) order by egg_id, started_at desc`,
            [user.id, eggs.map((e) => e.id)],
          )
        : [];
      const lastRound = new Map(mine.map((a) => [a.egg_id, a]));
      const byLevel = new Map(eggs.map((e) => [e.level, e]));
      const slotsOut = game.LEVELS.map((l) => {
        const egg = byLevel.get(l.level);
        const a = egg && lastRound.get(egg.id);
        return {
          ...l,
          egg: egg
            ? {
                id: egg.id,
                timesFound: egg.times_found,
                createdBy: egg.creator,
                mine: egg.created_by === user?.id,
                foundByMe: egg.found_by_me,
                round: isRunning(a, t) ? { attemptId: a.id, secondsLeft: roundPayload(a, egg, t).attempt.secondsLeft } : null,
                retryAt: retryAt(a, t),
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
      const user = (await db.one('select * from users where id = $1', [id])) ?? fail(404, 'Unknown player');
      const month = game.monthKey(now());
      const totals = await db.one(
        `select coalesce(sum(points), 0)::int as all_time,
                coalesce(sum(points) filter (where month = $2), 0)::int as month
           from finds where user_id = $1`,
        [id, month],
      );
      const rank = await db.one(
        `with t as (select user_id, sum(points) as p, count(*) as n from finds where month = $1 group by user_id)
         select r from (select t.user_id, row_number() over (order by t.p desc, t.n desc, u.username) as r
                          from t join users u on u.id = t.user_id) x
          where user_id = $2`,
        [month, id],
      );
      const findsByLevel = Object.fromEntries(game.LEVELS.map((l) => [l.name, 0]));
      for (const r of await db.many('select level, count(*)::int as n from finds where user_id = $1 group by level', [id])) {
        findsByLevel[game.levelInfo(r.level).name] = r.n;
      }
      const hidden = await db.one(
        `select (select count(*)::int from eggs where created_by = $1) as eggs_hidden,
                (select count(*)::int from finds f join eggs e on e.id = f.egg_id where e.created_by = $1) as found`,
        [id],
      );
      const recent = await db.many(
        'select * from finds where user_id = $1 order by found_at desc, id desc limit 10',
        [id],
      );
      return {
        user: publicUser(user),
        monthPoints: totals.month,
        allTimePoints: totals.all_time,
        monthRank: rank ? Number(rank.r) : null,
        findsByLevel,
        eggsHidden: hidden.eggs_hidden,
        timesYourEggsWereFound: hidden.found,
        recentFinds: recent.map((f) => ({
          id: f.id,
          stationName: stationName(f.station_id),
          level: f.level,
          levelName: game.levelInfo(f.level).name,
          points: f.points,
          foundAt: f.found_at,
          photoUrl: photoUrl(f.photo_id),
          verified: f.verified,
        })),
      };
    },

    async startAttempt(ctx) {
      const user = requireUser(ctx);
      const { body } = ctx;
      if (!isUuid(body?.eggId)) fail(404, 'Egg not found');
      const egg = (await db.one('select * from eggs where id = $1', [body.eggId])) ?? fail(404, 'Egg not found');
      if (egg.status !== 'active') fail(409, 'That egg was just swapped out. Pick another.');
      if (egg.created_by === user.id) fail(403, "You hid this one, so you can't play it.");
      if (await db.one('select 1 from finds where user_id = $1 and egg_id = $2', [user.id, egg.id])) {
        fail(409, 'You already found this egg.');
      }

      // A round that's still running is picked up where it is (after a reload, a closed
      // app, or "give up" then "play" again), so the timer can't be reset.
      const t = now();
      const last = await latestAttempt(user.id, egg.id);
      if (isRunning(last, t)) return { ...roundPayload(last, egg, t), resumed: true };
      const wait = retryAt(last, t);
      if (wait) {
        const mins = Math.ceil((wait - t) / 60_000);
        const how = last.status === 'given_up' ? 'gave up on' : 'ran out of time on';
        fail(409, `You ${how} this egg. Try it again in ${mins} ${mins === 1 ? 'minute' : 'minutes'}.`);
      }

      const info = game.levelInfo(egg.level);
      let limitSeconds = info.seconds;
      let limitSource = 'fixed';
      let train = null;
      if (body?.mode === 'train') {
        try {
          const trains = await mbta.predictions(egg.station_id);
          train = trains.find((t) => t.seconds >= game.TRAIN_MIN_SECONDS && t.seconds <= game.TRAIN_MAX_SECONDS) ?? null;
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
        started_at: t,
        limit_seconds: limitSeconds,
        limit_source: limitSource,
      };
      await db.query(
        `insert into attempts (id, user_id, egg_id, started_at, limit_seconds, limit_source, status)
         values ($1, $2, $3, $4, $5, $6, 'open')`,
        [attempt.id, user.id, egg.id, attempt.started_at, limitSeconds, limitSource],
      );
      return roundPayload(attempt, egg, attempt.started_at, train);
    },

    // Ends a round on purpose. The retry cooldown starts now.
    async giveUp(ctx) {
      const user = requireUser(ctx);
      const [attemptId] = ctx.params;
      if (!isUuid(attemptId)) fail(404, 'Round not found');
      const attempt = (await db.one('select * from attempts where id = $1', [attemptId])) ?? fail(404, 'Round not found');
      if (attempt.user_id !== user.id) fail(403, 'Not your round');
      const t = now();
      const row = await db.one(
        `update attempts set status = 'given_up', ended_at = $2 where id = $1 and status = 'open' returning *`,
        [attempt.id, t],
      );
      const after = row ?? attempt;
      return { status: after.status, retryAt: retryAt(after, t) };
    },

    // What this player has going on right now, for an app that was closed or reloaded:
    // a round still on the clock, and finds they can still hide the next egg for.
    async active(ctx) {
      const user = requireUser(ctx);
      await ensureStations();
      const t = now();
      const a = await db.one(
        `select a.* from attempts a
          where a.user_id = $1 and a.status = 'open'
            and a.started_at + make_interval(secs => a.limit_seconds + $3) > $2
            and not exists (select 1 from finds f where f.user_id = a.user_id and f.egg_id = a.egg_id)
          order by a.started_at desc limit 1`,
        [user.id, t, game.GRACE_SECONDS],
      );
      const egg = a && (await db.one('select * from eggs where id = $1', [a.egg_id]));
      const hides = await db.many(
        `select id, station_id, level, found_at from finds
          where user_id = $1 and can_hide and found_at > $2 order by found_at desc`,
        [user.id, new Date(t.getTime() - game.HIDE_WINDOW_MINUTES * 60_000)],
      );
      return {
        round: egg ? { ...roundPayload(a, egg, t), station: stationById.get(egg.station_id) ?? null } : null,
        hides: hides.map((f) => ({
          findId: f.id,
          stationId: f.station_id,
          stationName: stationName(f.station_id),
          level: f.level,
          levelName: game.levelInfo(f.level).name,
          points: game.levelInfo(f.level).points,
          expiresAt: new Date(f.found_at.getTime() + game.HIDE_WINDOW_MINUTES * 60_000),
        })),
      };
    },

    async submitFind(ctx) {
      const user = requireUser(ctx);
      const [attemptId] = ctx.params;
      if (!isUuid(attemptId)) fail(404, 'Round not found');
      const attempt = (await db.one('select * from attempts where id = $1', [attemptId])) ?? fail(404, 'Round not found');
      if (attempt.user_id !== user.id) fail(403, 'Not your round');
      // Signal drops underground: if the phone resends a find that was already saved,
      // answer with that find instead of an error.
      if (attempt.status === 'found') return replayFind(attempt, user.id);
      if (attempt.status !== 'open') fail(409, `This round is already ${attempt.status.replace('_', ' ')}.`);
      const egg = (await db.one('select * from eggs where id = $1', [attempt.egg_id])) ?? fail(404, 'Egg not found');
      if (await db.one('select 1 from finds where user_id = $1 and egg_id = $2', [user.id, egg.id])) {
        fail(409, 'You already found this egg.');
      }

      // Time counts until the upload started arriving, not until the last byte did,
      // so a slow connection in a station doesn't eat the player's clock.
      const elapsed = ((ctx.at ?? now()) - attempt.started_at) / 1000;
      if (elapsed > attempt.limit_seconds + game.GRACE_SECONDS) {
        await db.query(`update attempts set status = 'expired', ended_at = $2 where id = $1 and status = 'open'`, [
          attempt.id,
          roundEnd(attempt),
        ]);
        return { status: 'expired' };
      }

      const candidate = decodeImage(ctx.body?.image);
      const original = await db.one('select data from photos where id = $1', [egg.photo_id]);
      // The (slow) photo check runs outside any transaction.
      const verification = await verify({
        originalJpeg: original.data,
        candidateJpeg: candidate.data,
        apiKey: geminiKey,
        model: geminiModel,
      });
      const secondsLeft = Math.max(0, Math.round(attempt.limit_seconds - elapsed));
      if (!verification.match) return { status: 'no_match', reason: verification.reason, secondsLeft };

      const secondsTaken = Math.min(elapsed, attempt.limit_seconds);
      const score = game.scoreFind(egg.level, secondsTaken, attempt.limit_seconds);
      const findId = crypto.randomUUID();
      const t = now();
      let firstFind = false;
      let alreadySaved = false;
      await db.tx(async (c) => {
        await slots.lockSlot(c, egg.station_id, egg.level);
        // Re-check under lock: the same round may have been submitted twice (a retry, another tab).
        const locked = await c.one('select status from attempts where id = $1 for update', [attempt.id]);
        if (locked.status === 'found') {
          alreadySaved = true;
          return;
        }
        if (locked.status !== 'open') fail(409, `This round is already ${locked.status.replace('_', ' ')}.`);
        const photoId = await savePhoto(c, candidate);
        try {
          await c.query(
            `insert into finds (id, egg_id, user_id, station_id, level, found_at, month, seconds_taken,
                                points, base, bonus, photo_id, verified, can_hide)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true)`,
            [findId, egg.id, user.id, egg.station_id, egg.level, t, game.monthKey(t), Math.round(secondsTaken),
              score.total, score.base, score.bonus, photoId, verification.method === 'gemini'],
          );
        } catch (err) {
          if (isUniqueViolation(err)) fail(409, 'You already found this egg.');
          throw err;
        }
        const fresh = await c.one(
          `update eggs set avg_find_seconds = round((coalesce(avg_find_seconds, 0) * times_found + $2)::numeric / (times_found + 1)),
                           times_found = times_found + 1
            where id = $1 returning *`,
          [egg.id, Math.round(secondsTaken)],
        );
        await c.query(`update attempts set status = 'found', ended_at = $2 where id = $1`, [attempt.id, t]);
        firstFind = fresh.times_found === 1;
        if (fresh.status === 'active') await slots.rotateAfterFind(c, fresh, user.id, t);
      });
      if (alreadySaved) return replayFind(attempt, user.id);
      return {
        status: 'found',
        findId,
        points: score,
        secondsTaken: Math.round(secondsTaken),
        verification,
        stationId: egg.station_id,
        level: egg.level,
        firstFind,
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

      await db.tx(async (c) => {
        await slots.lockSlot(c, s.id, level);
        if (body?.findId) {
          if (!isUuid(body.findId)) fail(404, 'Find not found');
          const find = (await c.one('select * from finds where id = $1 for update', [body.findId])) ?? fail(404, 'Find not found');
          if (find.user_id !== user.id) fail(403, 'Not your find');
          if (!find.can_hide) fail(409, 'You already hid an egg for this find.');
          if (find.station_id !== s.id || find.level !== level) {
            fail(400, 'The new egg must be at the same station and level as the one you found.');
          }
          if ((t - find.found_at) / 60000 > game.HIDE_WINDOW_MINUTES) fail(409, 'Too long since your find to hide the next egg.');
          await c.query('update finds set can_hide = false where id = $1', [find.id]);
        } else if (await slots.activeEgg(c, s.id, level)) {
          fail(409, 'This level already has an egg. Find it first to earn the right to hide the next one.');
        }
        const photoId = await savePhoto(c, image);
        await slots.placeEgg(c, { id: eggId, stationId: s.id, level, photoId, hint, createdBy: user.id }, t);
      });
      return { egg: { id: eggId, stationId: s.id, level } };
    },

    async reportEgg(ctx) {
      const user = requireUser(ctx);
      const [eggId] = ctx.params;
      if (!isUuid(eggId)) fail(404, 'Egg not found');
      const reason = ['cant_find', 'unsafe', 'person', 'other'].includes(ctx.body?.reason) ? ctx.body.reason : 'other';
      const first = (await db.one('select station_id, level from eggs where id = $1', [eggId])) ?? fail(404, 'Egg not found');
      const t = now();
      return db.tx(async (c) => {
        await slots.lockSlot(c, first.station_id, first.level);
        const egg = await c.one('select * from eggs where id = $1', [eggId]);
        await c.query(
          `insert into reports (id, egg_id, user_id, reason, created_at) values ($1, $2, $3, $4, $5)
           on conflict (egg_id, user_id) do nothing`,
          [crypto.randomUUID(), eggId, user.id, reason, t],
        );
        const { n } = await c.one('select count(*)::int as n from reports where egg_id = $1', [eggId]);
        const retired = n >= game.REPORTS_TO_RETIRE && egg.status !== 'retired';
        if (retired) await slots.retireEgg(c, egg, t);
        return { reports: n, retired };
      });
    },

    // Rider level, today's challenge, stamps, and the stations and lines you've found eggs on.
    // All derived from finds, attempts and eggs: nothing extra is stored.
    async progress(ctx) {
      const user = requireUser(ctx);
      await ensureStations();
      const today = game.dayKey(now());
      const finds = await db.many(
        `select f.station_id, f.level, f.found_at, f.seconds_taken, f.points,
                not exists (select 1 from finds g where g.egg_id = f.egg_id and g.id <> f.id
                              and (g.found_at < f.found_at or (g.found_at = f.found_at and g.id < f.id))) as first,
                exists (select 1 from attempts a where a.user_id = f.user_id and a.egg_id = f.egg_id
                          and a.status = 'found' and a.limit_source = 'train') as raced
           from finds f where f.user_id = $1 order by f.found_at, f.id`,
        [user.id],
      );
      const { n: hidden } = await db.one('select count(*)::int as n from eggs where created_by = $1', [user.id]);

      const families = (stationId) =>
        [...new Set((stationById.get(stationId)?.lines ?? []).map((l) => game.lineFamily(l.id)))];
      const allLines = new Set();
      const days = new Map(); // day -> { stations, lines }
      const byStation = new Map();
      let allTime = 0;
      for (const f of finds) {
        allTime += f.points;
        const day = game.dayKey(f.found_at);
        const fams = families(f.station_id);
        fams.forEach((x) => allLines.add(x));
        const d = days.get(day) ?? { stations: new Set(), lines: new Set() };
        d.stations.add(f.station_id);
        fams.forEach((x) => d.lines.add(x));
        days.set(day, d);
        const st = byStation.get(f.station_id) ?? { finds: 0, points: 0, firstFoundAt: f.found_at };
        st.finds += 1;
        st.points += f.points;
        byStation.set(f.station_id, st);
      }
      const todays = finds.filter((f) => game.dayKey(f.found_at) === today);
      // "Transfer" means riding somewhere on another line, so finds at a single station count as
      // one line, even at a two-line station like Park Street (Red and Green), until you find an
      // egg at a second station.
      const transferLines = (stations, lines) => (stations.size >= 2 ? lines.size : Math.min(1, lines.size));
      const mostLinesInADay = Math.max(0, ...[...days.values()].map((d) => transferLines(d.stations, d.lines)));
      const mainLinesFound = game.MAIN_LINES.filter((x) => allLines.has(x)).length;

      const stamp = (id, name, description, target, progress) => ({
        id, name, description, target, progress: Math.min(target, progress), earned: progress >= target,
      });
      const stamps = [
        stamp('first_find', 'First find', 'Find your first egg.', 1, finds.length),
        stamp('transfer', 'Transfer', 'Find eggs at 2 stations on different lines in one day.', 2, mostLinesInADay),
        stamp('beat_train', 'Beat the train', 'Find an egg while racing a train.', 1, finds.filter((f) => f.raced).length),
        stamp('first_to_find', 'First', 'Be the first to find an egg.', 1, finds.filter((f) => f.first).length),
        stamp('speedy', '30 s', 'Find an egg in 30 seconds or less.', 1, finds.filter((f) => f.seconds_taken <= 30).length),
        stamp('impossible', 'Impossible', 'Find a level 5 egg.', 1, finds.filter((f) => f.level === 5).length),
        stamp('all_lines', '4 lines', 'Find eggs on the Red, Orange, Blue and Green lines.', 4, mainLinesFound),
        stamp('hider', 'Hider', 'Hide 5 eggs.', 5, hidden),
        stamp('ten_finds', '10 finds', 'Find 10 eggs.', 10, finds.length),
      ];

      const ch = game.challengeFor(today);
      const todayLines = [...new Set(todays.flatMap((f) => families(f.station_id)))];
      const measure = {
        transfer: transferLines(new Set(todays.map((f) => f.station_id)), new Set(todayLines)),
        racer: todays.filter((f) => f.raced).length,
        climber: todays.filter((f) => f.level >= 3).length,
        triple: todays.length,
      }[ch.id];

      return {
        level: game.riderLevel(allTime),
        today: { day: today, ...ch, progress: Math.min(ch.target, measure), done: measure >= ch.target, lines: todayLines },
        stamps,
        stations: [...byStation]
          .map(([id, st]) => ({
            stationId: id,
            name: stationName(id),
            lines: families(id),
            finds: st.finds,
            points: st.points,
            firstFoundAt: st.firstFoundAt,
          }))
          .sort((a, b) => new Date(a.firstFoundAt) - new Date(b.firstFoundAt)),
        lines: game.MAIN_LINES.map((line) => ({
          line,
          stations: [...byStation.keys()].filter((id) => families(id).includes(line)).length,
        })),
      };
    },

    async leaderboard({ query }) {
      await ensureStations();
      const month = query.get('month') || game.monthKey(now());
      if (!/^\d{4}-\d{2}$/.test(month)) fail(400, 'Month must look like 2026-11.');
      const stationId = query.get('stationId') || null;
      const rows = await db.many(
        `select f.user_id, u.username, sum(f.points)::int as points, count(*)::int as finds
           from finds f join users u on u.id = f.user_id
          where f.month = $1 and ($2::text is null or f.station_id = $2)
          group by f.user_id, u.username
          order by points desc, finds desc, u.username
          limit 50`,
        [month, stationId],
      );
      const byStation = await db.many(
        `select station_id, sum(points)::int as points from finds
          where month = $1 and ($2::text is null or station_id = $2) group by station_id`,
        [month, stationId],
      );
      const lineTotals = new Map();
      for (const r of byStation) {
        const families = new Set((stationById.get(r.station_id)?.lines ?? []).map((l) => game.lineFamily(l.id)));
        for (const fam of families) lineTotals.set(fam, (lineTotals.get(fam) ?? 0) + r.points);
      }
      return {
        month,
        stationId,
        rows: rows.map((r, i) => ({ userId: r.user_id, username: r.username, points: r.points, finds: r.finds, rank: i + 1 })),
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
    ['POST', /^\/api\/attempts\/([^/]+)\/give-up$/, api.giveUp, 'optional'],
    ['GET', /^\/api\/me\/active$/, api.active, 'optional'],
    ['POST', /^\/api\/eggs$/, api.createEgg, 'optional'],
    ['POST', /^\/api\/eggs\/([^/]+)\/report$/, api.reportEgg, 'optional'],
    ['GET', /^\/api\/me\/progress$/, api.progress, 'optional'],
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
    const at = now(); // when the request arrived, before a slow body upload
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
          const ctx = { params: m.slice(1), query: url.searchParams, body, req, at, user: session?.user ?? null, sessionId: session?.sessionId ?? null };
          return sendJson(res, 200, await fn(ctx), cors);
        }
        fail(404, 'Not found');
      }

      const photo = /^\/photos\/([0-9a-f-]{36})\.jpg$/i.exec(pathname);
      if (photo) {
        const row = isUuid(photo[1]) && (await db.one('select content_type, data from photos where id = $1', [photo[1]]));
        if (!row) fail(404, 'Photo not found');
        res.writeHead(200, {
          ...cors,
          'content-type': row.content_type,
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
