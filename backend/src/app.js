// Station Egg Hunt API. Stateless: everything lives in MongoDB, so any number
// of instances (or serverless functions) can serve it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifyMatch, checkGemini, screenEggPhoto } from './verify.js';
import { isDuplicateKey } from './db.js';
import * as game from './game.js';
import * as slots from './slots.js';
import * as auth from './auth.js';
import { blurredCopy } from './images.js';

// Vercel functions accept request bodies up to 4.5 MB; phones send ~0.3 MB after downscaling.
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;
const HOUSEKEEPING_EVERY_MS = 60_000;
const SESSION_TOUCH_MS = 60 * 60_000; // refresh last_seen / expiry at most hourly
const HUNTING_NOW_MS = 15 * 60_000; // a round started in the last 15 minutes counts as hunting now
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};
// Friend groups: invite codes avoid look-alike characters (no 0/O, 1/I/L).
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const INVITE_LENGTH = 8;
export const MAX_GROUPS_PER_USER = 20;
export const MAX_GROUP_MEMBERS = 50;
export const CHAT_PAGE = 50;
export const CHAT_RATE = { messages: 8, seconds: 10 };
const GROUP_NAME_RE = /^[\p{L}\p{N} _.,'!&()-]{2,30}$/u;
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
  screen = screenEggPhoto, // checks a photo before it's hidden as an egg
  geminiKey = '',
  geminiModel = 'gemini-3.1-flash-lite,gemini-3-flash-preview',
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
  // Only the player themself sees their chat name: it's what keeps the group chat anonymous.
  const selfUser = (u) => ({ ...publicUser(u), chatName: u.chatName ?? null, email: u.email ?? null });
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

  // The photo a finder is shown: the original for Easy to Hard, a blurred copy for Extreme and
  // Impossible. Eggs hidden before blurring existed get their copy made on first play.
  async function displayPhotoId(egg) {
    const sigma = game.levelInfo(egg.level).blur;
    if (!sigma) return egg.photoId;
    if (egg.displayPhotoId) return egg.displayPhotoId;
    const original = await col.photos.findOne({ _id: egg.photoId }, { promoteBuffers: true });
    let data;
    try {
      data = await blurredCopy(original.data, sigma);
    } catch {
      fail(409, "This egg's photo can't be prepared. Please report it.");
    }
    const id = await savePhoto(undefined, { data, contentType: 'image/jpeg' });
    // If another request got there first, use theirs (the extra copy is just unused).
    await col.eggs.updateOne({ _id: egg._id, displayPhotoId: { $exists: false } }, { $set: { displayPhotoId: id } });
    return (await col.eggs.findOne({ _id: egg._id }, { projection: { displayPhotoId: 1 } })).displayPhotoId;
  }

  // Retiring stale eggs runs lazily on station reads, at most once a minute per instance.
  let lastHousekeeping = -Infinity;
  let mapLinesCache = null; // route shapes, per instance
  async function housekeeping() {
    const t = now();
    if (t.getTime() - lastHousekeeping < HOUSEKEEPING_EVERY_MS) return;
    lastHousekeeping = t.getTime();
    await slots.retireStale(db, t);
  }

  // ---------- the per-egg clock ----------
  // A player's latest round on an egg. Their clock on that egg is this round's clock.
  const latestRound = (userId, eggId, session) =>
    col.attempts.findOne({ userId, eggId }, { session, sort: { startedAt: -1, _id: -1 } });

  // Where a player stands on an egg: 'running' (a round is live, so coming back resumes it),
  // 'retry' (an earlier round ran out or was given up: a new one earns no time bonus) or 'new'.
  function clockState(round, t) {
    if (!round || round.status === 'found') return { state: 'new' };
    if (round.status === 'open' && game.roundEndsAt(round) > t) {
      return { state: 'running', secondsLeft: round.limitSeconds - (t - round.startedAt) / 1000 };
    }
    return { state: 'retry' };
  }

  // ---------- bounty ----------
  // For each egg, the players it has beaten since its bounty was last claimed: their clock on it
  // ran out, or they gave up. A miss counts only if the player already had a find when it
  // happened, so brand-new throwaway accounts can't pump a friend's bounty, and a first find
  // doesn't make earlier misses count after the fact. Returns Map eggId -> Set of userIds.
  async function playersBeaten(eggs, t, session) {
    const out = new Map(eggs.map((e) => [e._id, new Set()]));
    if (!eggs.length) return out;
    const since = (e) => e.bountyFrom ?? e.createdAt;
    const rounds = await col.attempts
      .find(
        {
          status: { $ne: 'found' },
          $or: eggs.map((e) => ({ eggId: e._id, startedAt: { $gt: new Date(since(e).getTime() - game.MAX_ROUND_MS) } })),
        },
        { session, projection: { eggId: 1, userId: 1, startedAt: 1, limitSeconds: 1, endedAt: 1 } },
      )
      .toArray();
    const eggById = new Map(eggs.map((e) => [e._id, e]));
    const over = rounds.filter((r) => {
      const egg = eggById.get(r.eggId);
      const endsAt = game.roundEndsAt(r);
      return r.userId !== egg.createdBy && endsAt <= t && endsAt > since(egg);
    });
    const ids = [...new Set(over.map((r) => r.userId))];
    // Each player's first ever find.
    const firstFind = new Map(
      ids.length
        ? (await col.finds
            .aggregate([{ $match: { userId: { $in: ids } } }, { $group: { _id: '$userId', at: { $min: '$foundAt' } } }], { session })
            .toArray()).map((f) => [f._id, f.at])
        : [],
    );
    for (const r of over) {
      const first = firstFind.get(r.userId);
      if (first && first < game.roundEndsAt(r)) out.get(r.eggId).add(r.userId);
    }
    return out;
  }

  // What a player would win by finding `egg` now: a pot from the *other* players it has beaten.
  function potFor(egg, beaten, userId) {
    const n = [...beaten].filter((u) => u !== userId).length;
    return { beaten: n, bounty: game.bountyFor(egg.level, n) };
  }

  // A player's points from payouts (their share of bounties on eggs they hid).
  async function payoutPoints(userId, month = null) {
    const [r] = await col.payouts
      .aggregate([
        { $match: { userId } },
        { $group: { _id: null, allTime: { $sum: '$points' }, month: { $sum: { $cond: [{ $eq: ['$month', month] }, '$points', 0] } } } },
      ])
      .toArray();
    return { allTime: r?.allTime ?? 0, month: r?.month ?? 0 };
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
    return { user: selfUser(user), token };
  }

  // ---------- names ----------
  // Usernames show on leaderboards and profiles; chat names show only in group chats.
  // One namespace for both, so nobody can take a chat name that looks like someone's username.
  const NAME_RE = /^[A-Za-z0-9_. -]{2,20}$/;
  const NAME_RULE = '2–20 letters, numbers, spaces, dots, dashes or underscores';
  const cleanName = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');

  async function nameTaken(name, exceptUserId = null) {
    const lower = name.toLowerCase();
    const q = { $or: [{ usernameLower: lower }, { chatNameLower: lower }] };
    if (exceptUserId) q._id = { $ne: exceptUserId };
    return Boolean(await col.users.findOne(q, { projection: { _id: 1 } }));
  }

  // Gives an account a random anonymous chat name, retrying on the rare collision.
  async function ensureChatName(user) {
    if (user.chatName) return user;
    for (let i = 0; i < 10; i++) {
      const chatName = game.randomChatName();
      if (await nameTaken(chatName)) continue;
      try {
        const r = await col.users.updateOne({ _id: user._id, chatName: { $exists: false } }, { $set: { chatName, chatNameLower: chatName.toLowerCase() } });
        if (r.matchedCount) return { ...user, chatName, chatNameLower: chatName.toLowerCase() };
        return (await col.users.findOne({ _id: user._id })) ?? user; // another request named it first
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
      }
    }
    throw new Error('Could not pick a free chat name.');
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
  // Every account is linked to an email. It's private: only its owner ever sees it.
  const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;
  const cleanEmail = (v) => {
    const email = String(v ?? '').trim();
    if (!email) fail(400, 'Enter your email.');
    if (email.length > 254 || !EMAIL_RE.test(email)) fail(400, "That doesn't look like an email address.");
    return email;
  };
  const emailTaken = async (email, exceptId = null) =>
    Boolean(await col.users.findOne({ emailLower: email.toLowerCase(), ...(exceptId && { _id: { $ne: exceptId } }) }, { projection: { _id: 1 } }));

  // Finds plus payouts (a hider's bounty share) matching `match`, as { userId, stationId, points, find }.
  // Payout docs carry the same month/stationId/userId fields as finds, so one match fits both.
  const scoredPoints = (match) => [
    { $match: match },
    { $project: { userId: 1, stationId: 1, points: 1, find: { $literal: 1 } } },
    {
      $unionWith: {
        coll: col.payouts.collectionName,
        pipeline: [{ $match: match }, { $project: { userId: 1, stationId: 1, points: 1, find: { $literal: 0 } } }],
      },
    },
  ];

  // Points per player for the finds and payouts matching `match`, best first. Ties: more finds, then username.
  function pointsBoard(match) {
    return col.finds
      .aggregate([
        ...scoredPoints(match),
        { $group: { _id: '$userId', points: { $sum: '$points' }, finds: { $sum: '$find' } } },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
        { $set: { username: { $first: '$u.username' } } },
        { $sort: { points: -1, finds: -1, username: 1 } },
        { $project: { u: 0 } },
      ])
      .toArray();
  }

  // ---------- groups ----------
  function groupName(raw) {
    const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (!GROUP_NAME_RE.test(name)) fail(400, 'Group name must be 2–30 letters, numbers, spaces or simple punctuation.');
    return name;
  }
  const normalizeCode = (raw) => String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const publicGroup = (g, user) => ({
    id: g._id,
    name: g.name,
    memberCount: g.memberCount,
    isOwner: g.ownerId === user._id,
    inviteCode: g.inviteCode,
    createdAt: g.createdAt,
  });

  async function newInviteCode() {
    for (let i = 0; i < 10; i++) {
      const code = Array.from({ length: INVITE_LENGTH }, () => INVITE_ALPHABET[crypto.randomInt(INVITE_ALPHABET.length)]).join('');
      if (!(await col.groups.findOne({ inviteCode: code }, { projection: { _id: 1 } }))) return code;
    }
    throw new Error('Could not generate a unique invite code');
  }

  // Serializes one player's group joins/creates, so the per-player limit holds under concurrency.
  const lockUser = (session, userId) =>
    col.locks.updateOne({ _id: `user:${userId}` }, { $inc: { v: 1 } }, { upsert: true, session });

  async function checkGroupLimit(session, userId) {
    if ((await col.groupMembers.countDocuments({ userId }, { session })) >= MAX_GROUPS_PER_USER) {
      fail(409, `You can be in up to ${MAX_GROUPS_PER_USER} groups. Leave one first.`);
    }
  }

  // Returns { user, g } when the signed-in player belongs to group `id`.
  async function memberGroup(ctx, id) {
    const user = requireUser(ctx);
    if (!isUuid(id)) fail(404, 'Group not found');
    const g = (await col.groups.findOne({ _id: id })) ?? fail(404, 'Group not found');
    if (!(await col.groupMembers.findOne({ groupId: id, userId: user._id }))) fail(403, "You're not in this group.");
    return { user, g };
  }

  // Stickers only: messages carry a sticker id from game.STICKERS, never free text.
  // The chat is anonymous: a message names its sender only by chat name, and carries no
  // user id (just whether it's yours), so it can't be matched to the group's leaderboard.
  const publicMessage = (m, viewerId, names) => {
    const s = game.stickerById.get(m.sticker);
    return {
      id: m._id,
      seq: m.seq,
      mine: m.userId === viewerId,
      name: names.get(m.userId) ?? 'Anonymous rider',
      sticker: m.sticker,
      emoji: s?.emoji ?? '🥚',
      label: s?.label ?? '',
      createdAt: m.createdAt,
    };
  };
  const chatNames = async (userIds) =>
    new Map((await col.users.find({ _id: { $in: [...new Set(userIds)] } }, { projection: { chatName: 1 } }).toArray()).map((u) => [u._id, u.chatName]));

  // A player's own recent activity, newest first: finds, eggs hidden, their eggs found by
  // others, groups joined and the day they signed up. Only ever sent to the player themself.
  const ACTIVITY_LIMIT = 30;
  async function activityFor(user, myEggIds) {
    const recent = (c, q, sortField) => c.find(q).sort({ [sortField]: -1 }).limit(ACTIVITY_LIMIT).toArray();
    const [finds, hidden, foundByOthers, memberships] = await Promise.all([
      recent(col.finds, { userId: user._id }, 'foundAt'),
      recent(col.eggs, { createdBy: user._id }, 'createdAt'),
      myEggIds.length ? recent(col.finds, { eggId: { $in: myEggIds }, userId: { $ne: user._id } }, 'foundAt') : [],
      recent(col.groupMembers, { userId: user._id }, 'joinedAt'),
    ]);
    const finders = new Map((await col.users.find({ _id: { $in: [...new Set(foundByOthers.map((f) => f.userId))] } }, { projection: { username: 1 } }).toArray()).map((u) => [u._id, u.username]));
    const groupNames = new Map((await col.groups.find({ _id: { $in: memberships.map((m) => m.groupId) } }, { projection: { name: 1 } }).toArray()).map((g) => [g._id, g.name]));
    const where = (x) => ({ stationId: x.stationId, stationName: stationName(x.stationId), levelName: game.levelInfo(x.level).name });
    const events = [
      ...finds.map((f) => ({ type: 'found', at: f.foundAt, ...where(f), points: f.points })),
      ...hidden.map((e) => ({ type: 'hid', at: e.createdAt, ...where(e) })),
      ...foundByOthers.map((f) => ({ type: 'egg_found', at: f.foundAt, ...where(f), by: finders.get(f.userId) ?? 'A player' })),
      ...memberships.filter((m) => groupNames.has(m.groupId)).map((m) => ({ type: 'joined_group', at: m.joinedAt, groupId: m.groupId, groupName: groupNames.get(m.groupId) })),
      { type: 'signed_up', at: user.createdAt },
    ];
    return events.sort((a, b) => b.at - a.at).slice(0, ACTIVITY_LIMIT);
  }

  // ---------- notifications ----------
  // The eggs you hid, and every time another player found one. "Unseen" means found since you
  // last opened the notifications page (users.notificationsSeenAt).
  const NOTIFY_LIMIT = 40;
  async function notificationsFor(user, { summary = false } = {}) {
    const seenAt = user.notificationsSeenAt ?? user.createdAt;
    const mine = await col.eggs.find({ createdBy: user._id }, { projection: { photoId: 1, stationId: 1, level: 1, status: 1, createdAt: 1, timesFound: 1, hint: 1 } }).sort({ createdAt: -1 }).toArray();
    const eggIds = mine.map((e) => e._id);
    const none = async () => [];
    const [unseenFinds, finds] = await Promise.all([
      eggIds.length ? col.finds.find({ eggId: { $in: eggIds }, foundAt: { $gt: seenAt } }).sort({ foundAt: -1 }).limit(summary ? 3 : NOTIFY_LIMIT).toArray() : none(),
      summary ? none() : eggIds.length ? col.finds.find({ eggId: { $in: eggIds } }).sort({ foundAt: -1 }).limit(NOTIFY_LIMIT).toArray() : none(),
    ]);
    const unseen = eggIds.length ? await col.finds.countDocuments({ eggId: { $in: eggIds }, foundAt: { $gt: seenAt } }) : 0;
    const shown = summary ? unseenFinds : finds;
    const finders = new Map((await col.users.find({ _id: { $in: [...new Set(shown.map((f) => f.userId))] } }, { projection: { username: 1 } }).toArray()).map((u) => [u._id, u.username]));
    const where = (x) => ({ stationId: x.stationId, stationName: stationName(x.stationId), levelName: game.levelInfo(x.level).name });
    const foundItems = shown.map((f) => ({ id: f._id, type: 'egg_found', at: f.foundAt, ...where(f), by: finders.get(f.userId) ?? 'A player', points: f.points, unseen: f.foundAt > seenAt }));
    if (summary) return { unseen, latest: foundItems };
    const hidItems = mine.slice(0, NOTIFY_LIMIT).map((e) => ({
      id: e._id,
      type: 'egg_hidden',
      at: e.createdAt,
      ...where(e),
      hint: e.hint ?? null,
      photoUrl: photoUrl(e.photoId),
      timesFound: e.timesFound ?? 0,
      status: e.status,
    }));
    const [findCount, foundByOthers] = await Promise.all([
      col.finds.countDocuments({ userId: user._id }),
      eggIds.length ? col.finds.countDocuments({ eggId: { $in: eggIds } }) : 0,
    ]);
    return {
      unseen,
      counts: { finds: findCount, eggsHidden: mine.length, foundByOthers },
      items: [...foundItems, ...hidItems].sort((a, b) => b.at - a.at).slice(0, NOTIFY_LIMIT),
    };
  }

  // ---------- handlers ----------
  const api = {
    // ?gemini=1 also checks that the photo-check model is reachable with the configured key.
    async health({ query }) {
      await db.db.command({ ping: 1 });
      if (query.get('gemini') !== '1') return { ok: true };
      return { ok: true, ...(await checkGemini({ apiKey: geminiKey, model: geminiModel })) };
    },

    config() {
      return {
        levels: game.LEVELS,
        gemini: Boolean(geminiKey),
        graceSeconds: game.GRACE_SECONDS,
        maxTimeBonus: game.MAX_TIME_BONUS,
        bountyPerPlayer: game.BOUNTY_PER_PLAYER,
        bountyCap: game.BOUNTY_CAP,
        hiderShare: game.HIDER_SHARE,
        passwordMin: auth.PASSWORD_MIN,
        stickers: game.STICKERS,
      };
    },

    // ----- auth -----
    async register({ body, req }) {
      const { username, password } = credentials(body);
      if (!NAME_RE.test(username)) fail(400, `Username must be ${NAME_RULE}.`);
      if (password.length < auth.PASSWORD_MIN) fail(400, `Password must be at least ${auth.PASSWORD_MIN} characters.`);
      if (password.length > auth.PASSWORD_MAX) fail(400, 'Password is too long.');
      if (await nameTaken(username)) fail(409, 'That username is taken.');
      const email = cleanEmail(body?.email);
      if (await emailTaken(email)) fail(409, 'An account already uses that email. Sign in instead.');
      const user = {
        _id: crypto.randomUUID(),
        username,
        usernameLower: username.toLowerCase(),
        email,
        emailLower: email.toLowerCase(),
        passwordHash: await auth.hashPassword(password),
        createdAt: now(),
      };
      try {
        await col.users.insertOne(user);
      } catch (err) {
        if (isDuplicateKey(err)) fail(409, 'That username or email is taken.');
        throw err;
      }
      return startSession(await ensureChatName(user), req);
    },

    async login({ body, req }) {
      const { username, password } = credentials(body);
      if (!username || !password || password.length > auth.PASSWORD_MAX) fail(400, 'Enter your username or email, and your password.');
      // Sign in with either the username or the account's email.
      const key = username.toLowerCase();
      const user = await col.users.findOne(key.includes('@') ? { emailLower: key } : { usernameLower: key });
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

    async me(ctx) {
      return { user: selfUser(await ensureChatName(requireUser(ctx))) };
    },

    // Add or change the account's email (accounts made before emails were required add one here).
    async updateEmail(ctx) {
      const user = requireUser(ctx);
      const email = cleanEmail(ctx.body?.email);
      if (await emailTaken(email, user._id)) fail(409, 'Another account already uses that email.');
      try {
        await col.users.updateOne({ _id: user._id }, { $set: { email, emailLower: email.toLowerCase() } });
      } catch (err) {
        if (isDuplicateKey(err)) fail(409, 'Another account already uses that email.');
        throw err;
      }
      return { user: selfUser({ ...user, email }) };
    },

    // ?summary=1 is the cheap poll: just the unseen count and the newest unseen finds.
    async notifications(ctx) {
      return notificationsFor(requireUser(ctx), { summary: ctx.query.get('summary') === '1' });
    },

    async notificationsSeen(ctx) {
      const user = requireUser(ctx);
      await col.users.updateOne({ _id: user._id }, { $set: { notificationsSeenAt: now() } });
      return { ok: true };
    },

    // Change your username (public) and/or chat name (anonymous). Send only the ones you change.
    async updateNames(ctx) {
      const user = await ensureChatName(requireUser(ctx));
      const set = {};
      for (const [field, label] of [['username', 'Username'], ['chatName', 'Chat name']]) {
        if (ctx.body?.[field] === undefined) continue;
        const v = cleanName(ctx.body[field]);
        if (!NAME_RE.test(v)) fail(400, `${label} must be ${NAME_RULE}.`);
        if (v === user[field]) continue;
        if (await nameTaken(v, user._id)) fail(409, `"${v}" is taken. Try another.`);
        set[field] = v;
        set[`${field}Lower`] = v.toLowerCase();
      }
      const next = { ...user, ...set };
      if (next.username.toLowerCase() === next.chatName.toLowerCase()) {
        fail(400, "Your chat name can't be your username, or the chat wouldn't be anonymous.");
      }
      if (Object.keys(set).length) {
        try {
          await col.users.updateOne({ _id: user._id }, { $set: set });
        } catch (err) {
          if (isDuplicateKey(err)) fail(409, 'That name was just taken. Try another.');
          throw err;
        }
      }
      return { user: selfUser(next) };
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
    // Every station with its count of active eggs (0 to 5). Signed in, each station also says how
    // many of those the player can still find (not their own, not already found by them).
    async stations({ user }) {
      await ensureStations();
      await housekeeping();
      const active = await col.eggs.find({ status: 'active' }, { projection: { stationId: 1, createdBy: 1 } }).toArray();
      const found = user
        ? new Set((await col.finds.find({ userId: user._id, eggId: { $in: active.map((e) => e._id) } }, { projection: { eggId: 1 } }).toArray()).map((f) => f.eggId))
        : null;
      const counts = new Map();
      for (const e of active) {
        const c = counts.get(e.stationId) ?? { activeEggs: 0, playable: 0 };
        c.activeEggs += 1;
        if (user && e.createdBy !== user._id && !found.has(e._id)) c.playable += 1;
        counts.set(e.stationId, c);
      }
      const rows = stations.map((s) => {
        const c = counts.get(s.id) ?? { activeEggs: 0, playable: 0 };
        return { ...s, activeEggs: c.activeEggs, ...(user && { playable: c.playable }) };
      });
      return {
        stations: rows,
        totals: {
          eggs: active.length,
          stationsWithEggs: rows.filter((r) => r.activeEggs).length,
          stations: rows.length,
          ...(user && { playable: rows.reduce((n, r) => n + r.playable, 0) }),
        },
      };
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
      const t = now();
      const beatenBy = await playersBeaten(eggs, t);
      // The viewer's clock on each egg: their latest round there.
      const myRounds = new Map();
      if (user) {
        const rounds = await col.attempts
          .find({ userId: user._id, eggId: { $in: eggs.map((e) => e._id) } })
          .sort({ startedAt: -1, _id: -1 })
          .toArray();
        for (const r of rounds) if (!myRounds.has(r.eggId)) myRounds.set(r.eggId, r);
      }
      const byLevel = new Map(eggs.map((e) => [e.level, e]));
      const slotsOut = game.LEVELS.map((l) => {
        const egg = byLevel.get(l.level);
        if (!egg) return { ...l, egg: null };
        const clock = clockState(myRounds.get(egg._id), t);
        return {
          ...l,
          egg: {
            id: egg._id,
            timesFound: egg.timesFound,
            createdBy: creators.get(egg.createdBy) ?? 'someone',
            mine: egg.createdBy === user?._id,
            foundByMe: foundByMe.has(egg._id),
            ...potFor(egg, beatenBy.get(egg._id), user?._id), // { bounty, beaten }
            clock: clock.state === 'running' ? { secondsLeft: Math.max(0, Math.round(clock.secondsLeft)) } : null,
            retry: clock.state === 'retry', // it beat you before: playing again earns no time bonus
          },
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
      const paid = await payoutPoints(id, month);
      const board = await pointsBoard({ month });
      const rankIndex = board.findIndex((r) => r._id === id);
      const findsByLevel = Object.fromEntries(game.LEVELS.map((l) => [l.name, 0]));
      for (const r of await col.finds.aggregate([{ $match: { userId: id } }, { $group: { _id: '$level', n: { $sum: 1 } } }]).toArray()) {
        findsByLevel[game.levelInfo(r._id).name] = r.n;
      }
      const myEggIds = (await col.eggs.find({ createdBy: id }, { projection: { _id: 1 } }).toArray()).map((e) => e._id);
      const recent = await col.finds.find({ userId: id }).sort({ foundAt: -1, _id: -1 }).limit(10).toArray();
      // Someone else's find photo is a sharp picture of the egg. Keep it hidden while that egg can
      // still be played (active, or in the pool) unless the viewer has found it too.
      const viewerId = ctx.user._id;
      let hidden = new Set();
      if (viewerId !== id && recent.length) {
        const eggIds = recent.map((f) => f.eggId);
        const live = (await col.eggs.find({ _id: { $in: eggIds }, status: { $in: ['active', 'pool'] } }, { projection: { _id: 1 } }).toArray()).map((e) => e._id);
        const seen = new Set((await col.finds.find({ userId: viewerId, eggId: { $in: live } }, { projection: { eggId: 1 } }).toArray()).map((f) => f.eggId));
        hidden = new Set(live.filter((e) => !seen.has(e)));
      }
      return {
        user: viewerId === id ? selfUser(user) : publicUser(user),
        ...(viewerId === id && { activity: await activityFor(user, myEggIds) }),
        monthPoints: (totals?.month ?? 0) + paid.month,
        allTimePoints: (totals?.allTime ?? 0) + paid.allTime,
        hiderPoints: paid.allTime, // all-time points from bounties on eggs this player hid
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
          photoUrl: hidden.has(f.eggId) ? null : photoUrl(f.photoId),
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
      const t = now();
      // One clock per player per egg. If a round is already running on this egg, coming back
      // resumes it with the time it has left, instead of starting a fresh clock. After a miss, a
      // new round is a retry: a fresh clock, but no time bonus.
      let round = await latestRound(user._id, egg._id);
      let clock = clockState(round, t);
      let resumed = clock.state === 'running';
      if (!resumed) {
        const limitSeconds = info.seconds; // every level: 3 minutes
        round = await tx(async (session) => {
          // Serializes this player's starts, so two taps (or two phones) can't open two clocks.
          await lockUser(session, user._id);
          const last = await latestRound(user._id, egg._id, session);
          const state = clockState(last, t);
          resumed = state.state === 'running';
          if (resumed) return last;
          const doc = {
            _id: crypto.randomUUID(),
            userId: user._id,
            eggId: egg._id,
            startedAt: t,
            limitSeconds,
            ...(state.state === 'retry' && { retry: true }),
            status: 'open',
          };
          await col.attempts.insertOne(doc, { session });
          return doc;
        });
        clock = clockState(round, t);
      }

      const pot = potFor(egg, (await playersBeaten([egg], t)).get(egg._id), user._id);
      return {
        attempt: {
          id: round._id,
          limitSeconds: round.limitSeconds,
          secondsLeft: Math.round(clock.secondsLeft),
          resumed,
          retry: Boolean(round.retry), // no time bonus on this round
        },
        egg: {
          bounty: pot.bounty,
          beaten: pot.beaten,
          id: egg._id,
          level: egg.level,
          levelName: info.name,
          points: info.points,
          hint: egg.hint,
          imageUrl: photoUrl(await displayPhotoId(egg)),
          blur: info.blur ? (info.blur >= 12 ? 'heavy' : 'light') : null,
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
      if (attempt.status !== 'open') fail(409, attempt.status === 'found' ? 'This round is already finished.' : 'This round is over.');
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
        originalType: original.contentType,
        candidateType: candidate.contentType,
        apiKey: geminiKey,
        model: geminiModel,
      });
      const secondsLeft = Math.max(0, Math.round(attempt.limitSeconds - elapsed));
      // Failed check: nothing is saved and the round stays open, so the player can look again.
      if (!verification.match) {
        return { status: 'no_match', verdict: 'failed', reason: verification.reason, unavailable: Boolean(verification.unavailable), secondsLeft };
      }

      const secondsTaken = Math.min(elapsed, attempt.limitSeconds);
      const findId = crypto.randomUUID();
      const t = now();
      let firstFind = false;
      let score;
      let beaten = 0;
      let hiderPoints = 0;
      await tx(async (session) => {
        await slots.lockSlot(col, session, egg.stationId, egg.level);
        // Closing the round atomically means a round submitted twice (two tabs) scores once.
        const closed = await col.attempts.findOneAndUpdate(
          { _id: attempt._id, status: 'open' },
          { $set: { status: 'found' } },
          { session },
        );
        if (!closed) fail(409, 'This round is already finished.');
        const fresh = await col.eggs.findOne({ _id: egg._id }, { session });
        // Claim the bounty: other players this egg beat since it was last claimed. Read under the
        // slot lock, so two players finding it at once can't both take the same pot.
        const pot = potFor(fresh, (await playersBeaten([fresh], t, session)).get(fresh._id), user._id);
        beaten = pot.beaten;
        score = game.scoreFind(egg.level, secondsTaken, attempt.limitSeconds, { bounty: pot.bounty, retry: Boolean(attempt.retry) });
        hiderPoints = game.hiderShare(pot.bounty);
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
              bounty: score.bounty,
              ...(attempt.retry && { retry: true }), // found on a retry: no speed stamp
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
        const avg = Math.round(((fresh.avgFindSeconds ?? 0) * fresh.timesFound + Math.round(secondsTaken)) / (fresh.timesFound + 1));
        // bountyFrom: the pot is claimed, so the next one only counts players beaten from now on.
        await col.eggs.updateOne({ _id: egg._id }, { $set: { avgFindSeconds: avg, bountyFrom: t }, $inc: { timesFound: 1 } }, { session });
        // The hider is paid only when their egg is found: a share of the pot it built up.
        if (hiderPoints) {
          await col.payouts.insertOne(
            {
              _id: crypto.randomUUID(),
              userId: fresh.createdBy,
              kind: 'bounty',
              eggId: egg._id,
              findId,
              finderId: user._id,
              stationId: egg.stationId,
              level: egg.level,
              month: game.monthKey(t),
              points: hiderPoints,
              createdAt: t,
            },
            { session },
          );
        }
        firstFind = fresh.timesFound === 0; // read under the slot lock, before this find was counted
        if (fresh.status === 'active') await slots.rotateAfterFind(col, session, fresh, user._id, t);
      });
      const hider = hiderPoints ? await col.users.findOne({ _id: egg.createdBy }, { projection: { username: 1 } }) : null;
      return {
        status: 'found',
        findId,
        points: score, // { base, bonus, bounty, total }
        beaten, // how many other players this egg beat before you (what built the bounty)
        hider: hider ? { username: hider.username, points: hiderPoints } : null,
        secondsTaken: Math.round(secondsTaken),
        verification,
        stationId: egg.stationId,
        level: egg.level,
        firstFind,
        // Earned: the sharp original of a blurred egg, shown on the result screen.
        revealUrl: photoUrl(egg.photoId),
      };
    },

    // Ends a round that won't be found: the player gave up, or their clock ran out (the app calls
    // this when its timer hits zero). If they count, they've added to the egg's bounty. They can
    // retry right away, but a retry earns no time bonus.
    async endRound(ctx) {
      const user = requireUser(ctx);
      const [attemptId] = ctx.params;
      if (!isUuid(attemptId)) fail(404, 'Round not found');
      const attempt = (await col.attempts.findOne({ _id: attemptId })) ?? fail(404, 'Round not found');
      if (attempt.userId !== user._id) fail(403, 'Not your round');
      const t = now();
      if (attempt.status === 'open') {
        const ranOut = game.roundEndsAt(attempt) <= t;
        // Conditional on 'open', so a find that lands at the same moment wins cleanly.
        await col.attempts.updateOne(
          { _id: attempt._id, status: 'open' },
          { $set: ranOut ? { status: 'expired' } : { status: 'given_up', endedAt: t } },
        );
      }
      const round = await col.attempts.findOne({ _id: attempt._id });
      if (round.status === 'found') fail(409, 'You found this one.');
      const egg = (await col.eggs.findOne({ _id: round.eggId })) ?? fail(404, 'Egg not found');
      const beaten = (await playersBeaten([egg], t)).get(egg._id);
      return {
        status: round.status, // 'given_up' | 'expired'
        counted: beaten.has(user._id), // whether this miss added to the bounty
        bounty: game.bountyFor(egg.level, beaten.size), // what the next finder takes now
        beaten: beaten.size,
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
      const sigma = game.levelInfo(level).blur;
      let blurred = null;
      if (sigma) {
        try {
          blurred = { data: await blurredCopy(image.data, sigma), contentType: 'image/jpeg' };
        } catch {
          fail(400, "Couldn't read that photo. Try taking it again.");
        }
      }
      const hint = String(body?.hint ?? '').trim().slice(0, 80);
      // Screen the photo first: no faces, a real object to find, not a blank wall.
      // Cheap checks (slot taken, find already used) still run before the Gemini call.
      if (!body?.findId) {
        if (await slots.activeEgg(col, undefined, s.id, level)) fail(409, 'This level already has an egg. Find it first to earn the right to hide the next one.');
      }
      const screening = await screen({ jpeg: image.data, type: image.contentType, apiKey: geminiKey, model: geminiModel });
      if (!screening.ok) fail(screening.problem === 'unavailable' ? 503 : 422, screening.message);
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
        const displayPhotoId = blurred ? await savePhoto(session, blurred) : undefined;
        await slots.placeEgg(
          col,
          session,
          { _id: eggId, stationId: s.id, level, photoId, ...(displayPhotoId && { displayPhotoId }), hint, createdBy: user._id },
          t,
        );
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

    // ----- map -----
    // Route shapes to draw the lines. Loaded once per instance; empty if the MBTA API can't be reached.
    async mapLines() {
      if (!mapLinesCache) {
        try {
          mapLinesCache = typeof mbta.shapes === 'function' ? await mbta.shapes() : [];
        } catch (err) {
          console.warn('[mbta] could not load shapes:', err.message);
          return { lines: [] };
        }
      }
      return { lines: mapLinesCache };
    },

    // Live train positions (the MBTA client caches these for a few seconds).
    async mapVehicles() {
      try {
        return { vehicles: typeof mbta.vehicles === 'function' ? await mbta.vehicles() : [] };
      } catch (err) {
        return { vehicles: [], error: `Live trains unavailable (${err.message}).` };
      }
    },

    // Per-station numbers for the map: eggs up, people hunting now, finds this month,
    // your finds there, and this month's Keeper (most finds at the station).
    async mapStations(ctx) {
      await ensureStations();
      await housekeeping();
      const t = now();
      const month = game.monthKey(t);
      const since = new Date(t.getTime() - HUNTING_NOW_MS);
      const count = (match, key = '$stationId') => [{ $match: match }, { $group: { _id: key, n: { $sum: 1 } } }];
      const [eggs, hunting, monthFinds, mine, keepers] = await Promise.all([
        col.eggs.aggregate(count({ status: 'active' })).toArray(),
        // distinct players with a round started recently, per station of the egg they're after
        col.attempts
          .aggregate([
            { $match: { startedAt: { $gt: since } } },
            { $lookup: { from: 'eggs', localField: 'eggId', foreignField: '_id', as: 'egg', pipeline: [{ $project: { stationId: 1 } }] } },
            { $unwind: '$egg' },
            { $group: { _id: { s: '$egg.stationId', u: '$userId' } } },
            { $group: { _id: '$_id.s', n: { $sum: 1 } } },
          ])
          .toArray(),
        col.finds.aggregate(count({ month })).toArray(),
        ctx.user ? col.finds.aggregate(count({ userId: ctx.user._id })).toArray() : [],
        // this month's Keeper per station: most finds, then most points, then username
        col.finds
          .aggregate([
            { $match: { month } },
            { $group: { _id: { s: '$stationId', u: '$userId' }, n: { $sum: 1 }, pts: { $sum: '$points' } } },
            { $lookup: { from: 'users', localField: '_id.u', foreignField: '_id', as: 'user', pipeline: [{ $project: { username: 1 } }] } },
            { $unwind: '$user' },
            { $sort: { n: -1, pts: -1, 'user.username': 1 } },
            { $group: { _id: '$_id.s', username: { $first: '$user.username' }, n: { $first: '$n' } } },
          ])
          .toArray(),
      ]);
      const by = (rows) => new Map(rows.map((r) => [r._id, r]));
      const [e, h, m, me, k] = [eggs, hunting, monthFinds, mine, keepers].map(by);
      return {
        stations: stations.map((s) => ({
          id: s.id,
          activeEggs: e.get(s.id)?.n ?? 0,
          huntingNow: h.get(s.id)?.n ?? 0,
          findsThisMonth: m.get(s.id)?.n ?? 0,
          yourFinds: me.get(s.id)?.n ?? 0,
          keeper: k.get(s.id) ? { username: k.get(s.id).username, finds: k.get(s.id).n } : null,
        })),
      };
    },

    // Rider level, today's challenge, stamps, and the stations and lines you've found eggs on.
    // All derived from finds, attempts and eggs: nothing extra is stored.
    async progress(ctx) {
      const user = requireUser(ctx);
      await ensureStations();
      const today = game.dayKey(now());
      const finds = await col.finds.find({ userId: user._id }).sort({ foundAt: 1, _id: 1 }).toArray();
      const eggIds = [...new Set(finds.map((f) => f.eggId))];
      // Whether each find was the first ever on its egg (earliest foundAt, then _id).
      const firstByEgg = new Map(
        (await col.finds
          .aggregate([
            { $match: { eggId: { $in: eggIds } } },
            { $sort: { foundAt: 1, _id: 1 } },
            { $group: { _id: '$eggId', first: { $first: '$_id' } } },
          ])
          .toArray()).map((r) => [r._id, r.first]),
      );
      const hidden = await col.eggs.countDocuments({ createdBy: user._id });
      const isFirst = (f) => firstByEgg.get(f.eggId) === f._id;

      const families = (stationId) => [...new Set((stationById.get(stationId)?.lines ?? []).map((l) => game.lineFamily(l.id)))];
      const allLines = new Set();
      const linesByDay = new Map();
      const byStation = new Map();
      let allTime = 0;
      for (const f of finds) {
        allTime += f.points;
        const day = game.dayKey(f.foundAt);
        const fams = families(f.stationId);
        fams.forEach((x) => allLines.add(x));
        if (!linesByDay.has(day)) linesByDay.set(day, new Set());
        fams.forEach((x) => linesByDay.get(day).add(x));
        const st = byStation.get(f.stationId) ?? { finds: 0, points: 0, firstFoundAt: f.foundAt };
        st.finds += 1;
        st.points += f.points;
        byStation.set(f.stationId, st);
      }
      const todays = finds.filter((f) => game.dayKey(f.foundAt) === today);
      const mostLinesInADay = Math.max(0, ...[...linesByDay.values()].map((x) => x.size));
      const mainLinesFound = game.MAIN_LINES.filter((x) => allLines.has(x)).length;

      const stamp = (id, name, description, target, n) => ({ id, name, description, target, progress: Math.min(target, n), earned: n >= target });
      const stamps = [
        stamp('first_find', 'First find', 'Find your first egg.', 1, finds.length),
        stamp('transfer', 'Transfer', 'Find eggs on 2 lines in one day.', 2, mostLinesInADay),
        stamp('first_to_find', 'First', 'Be the first to find an egg.', 1, finds.filter(isFirst).length),
        stamp('speedy', '30 s', 'Find an egg in 30 seconds or less.', 1, finds.filter((f) => f.secondsTaken <= 30 && !f.retry).length),
        stamp('impossible', 'Impossible', 'Find a level 5 egg.', 1, finds.filter((f) => f.level === 5).length),
        stamp('all_lines', '4 lines', 'Find eggs on the Red, Orange, Blue and Green lines.', 4, mainLinesFound),
        stamp('hider', 'Hider', 'Hide 5 eggs.', 5, hidden),
        stamp('ten_finds', '10 finds', 'Find 10 eggs.', 10, finds.length),
      ];

      const ch = game.challengeFor(today);
      const todayLines = [...new Set(todays.flatMap((f) => families(f.stationId)))];
      const measure = {
        transfer: todayLines.length,
        climber: todays.filter((f) => f.level >= 3).length,
        triple: todays.length,
      }[ch.id];

      return {
        // Rider level counts bounty shares from eggs you hid, too.
        level: game.riderLevel(allTime + (await payoutPoints(user._id)).allTime),
        today: { day: today, ...ch, progress: Math.min(ch.target, measure), done: measure >= ch.target, lines: todayLines },
        stamps,
        stations: [...byStation]
          .map(([id, st]) => ({ stationId: id, name: stationName(id), lines: families(id), finds: st.finds, points: st.points, firstFoundAt: st.firstFoundAt }))
          .sort((a, b) => a.firstFoundAt - b.firstFoundAt),
        lines: game.MAIN_LINES.map((line) => ({ line, stations: [...byStation.keys()].filter((id) => families(id).includes(line)).length })),
      };
    },

    // ----- friend groups -----
    async groups(ctx) {
      const user = requireUser(ctx);
      const memberships = await col.groupMembers.find({ userId: user._id }).sort({ joinedAt: 1 }).toArray();
      const groups = new Map(
        (await col.groups.find({ _id: { $in: memberships.map((m) => m.groupId) } }).toArray()).map((g) => [g._id, g]),
      );
      return {
        groups: memberships.map((m) => groups.get(m.groupId)).filter(Boolean).map((g) => publicGroup(g, user)),
        limits: { groups: MAX_GROUPS_PER_USER, members: MAX_GROUP_MEMBERS },
      };
    },

    async createGroup(ctx) {
      const user = requireUser(ctx);
      const name = groupName(ctx.body?.name);
      const g = { _id: crypto.randomUUID(), name, ownerId: user._id, inviteCode: await newInviteCode(), memberCount: 1, createdAt: now() };
      await tx(async (session) => {
        await lockUser(session, user._id);
        await checkGroupLimit(session, user._id);
        await col.groups.insertOne(g, { session });
        await col.groupMembers.insertOne({ _id: crypto.randomUUID(), groupId: g._id, userId: user._id, joinedAt: g.createdAt }, { session });
      });
      return { group: publicGroup(g, user) };
    },

    // What an invite link points to, so the join screen can show the group's name first.
    async groupInvite(ctx) {
      const user = requireUser(ctx);
      const code = normalizeCode(ctx.params[0]);
      const g = (code.length === INVITE_LENGTH && (await col.groups.findOne({ inviteCode: code }))) || fail(404, 'That invite link is not valid. Ask for a new one.');
      const member = await col.groupMembers.findOne({ groupId: g._id, userId: user._id });
      return {
        group: { id: g._id, name: g.name, memberCount: g.memberCount, full: g.memberCount >= MAX_GROUP_MEMBERS },
        alreadyMember: Boolean(member),
      };
    },

    async joinGroup(ctx) {
      const user = requireUser(ctx);
      const code = normalizeCode(ctx.body?.code);
      const g = (code.length === INVITE_LENGTH && (await col.groups.findOne({ inviteCode: code }))) || fail(404, 'No group has that invite code.');
      await tx(async (session) => {
        await lockUser(session, user._id);
        if (await col.groupMembers.findOne({ groupId: g._id, userId: user._id }, { session })) return; // already in
        await checkGroupLimit(session, user._id);
        // Counting atomically on the group document keeps the size limit under concurrent joins.
        const r = await col.groups.updateOne({ _id: g._id, memberCount: { $lt: MAX_GROUP_MEMBERS } }, { $inc: { memberCount: 1 } }, { session });
        if (!r.matchedCount) {
          const exists = await col.groups.findOne({ _id: g._id }, { session });
          fail(exists ? 409 : 404, exists ? `This group is full (${MAX_GROUP_MEMBERS} players).` : 'That group no longer exists.');
        }
        await col.groupMembers.insertOne({ _id: crypto.randomUUID(), groupId: g._id, userId: user._id, joinedAt: now() }, { session });
      });
      return { group: publicGroup(await col.groups.findOne({ _id: g._id }), user) };
    },

    async group(ctx) {
      const [id] = ctx.params;
      const { user, g } = await memberGroup(ctx, id);
      const period = ctx.query.get('period') === 'all' ? 'all' : 'month';
      const month = game.monthKey(now());
      const memberIds = (await col.groupMembers.find({ groupId: id }).sort({ joinedAt: 1 }).toArray()).map((m) => m.userId);
      const board = await pointsBoard(period === 'all' ? { userId: { $in: memberIds } } : { month, userId: { $in: memberIds } });
      // Members who haven't scored are listed too (unranked), so everyone sees who's in.
      const scored = new Set(board.map((r) => r._id));
      const idle = (await col.users.find({ _id: { $in: memberIds.filter((m) => !scored.has(m)) } }, { projection: { username: 1 } }).toArray())
        .map((u) => ({ _id: u._id, username: u.username, points: 0, finds: 0 }))
        .sort((a, b) => a.username.localeCompare(b.username));
      return {
        group: publicGroup(g, user),
        period,
        month,
        rows: [...board, ...idle].map((r, i) => ({
          userId: r._id,
          username: r.username,
          points: r.points,
          finds: r.finds,
          rank: r.points > 0 ? i + 1 : null,
          isOwner: r._id === g.ownerId,
        })),
      };
    },

    async renameGroup(ctx) {
      const [id] = ctx.params;
      const { user, g } = await memberGroup(ctx, id);
      if (g.ownerId !== user._id) fail(403, 'Only the group owner can rename it.');
      const name = groupName(ctx.body?.name);
      await col.groups.updateOne({ _id: id }, { $set: { name } });
      return { group: publicGroup({ ...g, name }, user) };
    },

    // Leaving hands ownership to the longest-standing member; the last one out deletes the group.
    async leaveGroup(ctx) {
      const user = requireUser(ctx);
      const [id] = ctx.params;
      if (!isUuid(id)) fail(404, 'Group not found');
      return tx(async (session) => {
        const g = await col.groups.findOneAndUpdate({ _id: id }, { $inc: { memberCount: -1 } }, { session, returnDocument: 'after' });
        if (!g) fail(404, 'Group not found');
        const left = await col.groupMembers.deleteOne({ groupId: id, userId: user._id }, { session });
        if (!left.deletedCount) fail(403, "You're not in this group.");
        if (g.memberCount <= 0) {
          await col.groups.deleteOne({ _id: id }, { session });
          await col.groupMessages.deleteMany({ groupId: id }, { session });
          return { left: true, deleted: true };
        }
        if (g.ownerId === user._id) {
          const heir = await col.groupMembers.find({ groupId: id }, { session }).sort({ joinedAt: 1, _id: 1 }).limit(1).next();
          await col.groups.updateOne({ _id: id }, { $set: { ownerId: heir.userId } }, { session });
        }
        return { left: true, deleted: false };
      });
    },

    // ----- group chat (stickers only) -----
    // Without ?after: the latest CHAT_PAGE messages. With ?after=<seq>: only newer ones (for polling).
    async groupMessages(ctx) {
      const [id] = ctx.params;
      const { user } = await memberGroup(ctx, id);
      const after = Number(ctx.query.get('after'));
      const rows = Number.isInteger(after) && after >= 0
        ? await col.groupMessages.find({ groupId: id, seq: { $gt: after } }).sort({ seq: 1 }).limit(CHAT_PAGE).toArray()
        : (await col.groupMessages.find({ groupId: id }).sort({ seq: -1 }).limit(CHAT_PAGE).toArray()).reverse();
      const names = await chatNames(rows.map((m) => m.userId));
      return { messages: rows.map((m) => publicMessage(m, user._id, names)) };
    },

    async sendGroupMessage(ctx) {
      const [id] = ctx.params;
      const { user: member } = await memberGroup(ctx, id);
      const user = await ensureChatName(member);
      const sticker = game.stickerById.get(String(ctx.body?.sticker ?? ''));
      if (!sticker) fail(400, 'Pick one of the stickers.');
      const t = now();
      const recent = await col.groupMessages.countDocuments({
        groupId: id,
        userId: user._id,
        createdAt: { $gt: new Date(t.getTime() - CHAT_RATE.seconds * 1000) },
      });
      if (recent >= CHAT_RATE.messages) fail(429, 'Easy there! Wait a few seconds before the next sticker.');
      // The per-group counter runs in the same transaction as the insert, so messages
      // commit in seq order and a poller using ?after=<seq> never skips one.
      const message = await tx(async (session) => {
        const g = await col.groups.findOneAndUpdate({ _id: id }, { $inc: { msgSeq: 1 } }, { session, returnDocument: 'after' });
        if (!g) fail(404, 'Group not found');
        const m = { _id: crypto.randomUUID(), groupId: id, seq: g.msgSeq, userId: user._id, sticker: sticker.id, createdAt: t };
        await col.groupMessages.insertOne(m, { session });
        return m;
      });
      return { message: publicMessage(message, user._id, new Map([[user._id, user.chatName]])) };
    },

    async leaderboard({ query }) {
      await ensureStations();
      // ?period=all ranks every point ever scored; otherwise one month (this one by default).
      const period = query.get('period') === 'all' ? 'all' : 'month';
      const month = query.get('month') || game.monthKey(now());
      if (!/^\d{4}-\d{2}$/.test(month)) fail(400, 'Month must look like 2026-11.');
      const stationId = query.get('stationId') || null;
      const match = { ...(period === 'month' && { month }), ...(stationId && { stationId }) };
      const board = await pointsBoard(match);
      const byStation = await col.finds.aggregate([...scoredPoints(match), { $group: { _id: '$stationId', points: { $sum: '$points' } } }]).toArray();
      const lineTotals = new Map();
      for (const r of byStation) {
        const families = new Set((stationById.get(r._id)?.lines ?? []).map((l) => game.lineFamily(l.id)));
        for (const fam of families) lineTotals.set(fam, (lineTotals.get(fam) ?? 0) + r.points);
      }
      return {
        period,
        month: period === 'month' ? month : null,
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
    ['GET', /^\/api\/stations$/, api.stations, 'optional'],
    ['GET', /^\/api\/stations\/([^/]+)$/, api.station, 'optional'],
    ['GET', /^\/api\/stations\/([^/]+)\/predictions$/, api.predictions, 'none'],
    ['GET', /^\/api\/users\/([^/]+)$/, api.profile, 'optional'],
    ['POST', /^\/api\/attempts$/, api.startAttempt, 'optional'],
    ['POST', /^\/api\/attempts\/([^/]+)\/find$/, api.submitFind, 'optional'],
    ['POST', /^\/api\/attempts\/([^/]+)\/end$/, api.endRound, 'optional'],
    ['POST', /^\/api\/eggs$/, api.createEgg, 'optional'],
    ['POST', /^\/api\/eggs\/([^/]+)\/report$/, api.reportEgg, 'optional'],
    ['GET', /^\/api\/me\/progress$/, api.progress, 'optional'],
    ['POST', /^\/api\/me\/names$/, api.updateNames, 'optional'],
    ['POST', /^\/api\/me\/email$/, api.updateEmail, 'optional'],
    ['GET', /^\/api\/me\/notifications$/, api.notifications, 'optional'],
    ['POST', /^\/api\/me\/notifications\/seen$/, api.notificationsSeen, 'optional'],
    ['GET', /^\/api\/map\/lines$/, api.mapLines, 'none'],
    ['GET', /^\/api\/map\/vehicles$/, api.mapVehicles, 'none'],
    ['GET', /^\/api\/map\/stations$/, api.mapStations, 'optional'],
    ['GET', /^\/api\/leaderboard$/, api.leaderboard, 'none'],
    ['GET', /^\/api\/groups$/, api.groups, 'optional'],
    ['POST', /^\/api\/groups$/, api.createGroup, 'optional'],
    ['POST', /^\/api\/groups\/join$/, api.joinGroup, 'optional'],
    ['GET', /^\/api\/groups\/invite\/([^/]+)$/, api.groupInvite, 'optional'],
    ['GET', /^\/api\/groups\/([^/]+)$/, api.group, 'optional'],
    ['POST', /^\/api\/groups\/([^/]+)\/rename$/, api.renameGroup, 'optional'],
    ['POST', /^\/api\/groups\/([^/]+)\/leave$/, api.leaveGroup, 'optional'],
    ['GET', /^\/api\/groups\/([^/]+)\/messages$/, api.groupMessages, 'optional'],
    ['POST', /^\/api\/groups\/([^/]+)\/messages$/, api.sendGroupMessage, 'optional'],
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
