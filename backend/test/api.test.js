// End-to-end API tests against a real MongoDB: a throwaway in-memory replica set
// (mongodb-memory-server), or TEST_MONGODB_URI if set (a random database is used and dropped).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { createDb, startMemoryMongo } from '../src/db.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DB_NAME = `egghunt_test_${crypto.randomBytes(4).toString('hex')}`;

const STATIONS = [
  { id: 'place-kencl', name: 'Kenmore', lat: 42.3489, lng: -71.0952, lines: [{ id: 'Green-B', name: 'Green Line B', color: '#00843D' }] },
  { id: 'place-pktrm', name: 'Park Street', lat: 42.3564, lng: -71.0624, lines: [{ id: 'Red', name: 'Red Line', color: '#DA291C' }, { id: 'Green-B', name: 'Green Line B', color: '#00843D' }] },
];
const fakeMbta = {
  loadStations: async () => STATIONS,
  predictions: async () => [{ routeId: 'Green-B', line: 'Green Line B', color: '#00843D', headsign: 'Boston College', seconds: 240 }],
};
const IMG = `data:image/jpeg;base64,${Buffer.alloc(300, 7).toString('base64')}`;
const PW = 'correct horse';

let clock = Date.parse('2026-11-21T20:00:00Z');
let nextVerify = { method: 'gemini', match: true, confidence: 0.9, reason: 'Same sticker.' };
let server;
let base;
let db;
let memory;

before(async () => {
  let uri = process.env.TEST_MONGODB_URI;
  if (!uri) {
    memory = await startMemoryMongo();
    uri = memory.uri;
  }
  db = await createDb({ uri, dbName: DB_NAME, maxPoolSize: 5 });
  const app = await createApp({
    db,
    mbta: fakeMbta,
    verify: async () => nextVerify,
    geminiKey: 'test',
    now: () => new Date(clock),
    frontendDir: path.resolve(ROOT, '../frontend'),
    corsOrigins: ['https://app.example'],
  });
  server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server?.close();
  await db?.db.dropDatabase();
  await db?.close();
  await memory?.stop();
});

// `as` is a session ({ token }) or null for an anonymous call.
async function call(p, body, as = null, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (body) headers['content-type'] = 'application/json';
  if (as?.token) headers.authorization = `Bearer ${as.token}`;
  const res = await fetch(base + p, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
}
const ok = async (p, body, as) => {
  const r = await call(p, body, as);
  assert.equal(r.status, 200, `${p} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};
// Registers and returns { id, username, token }.
const user = async (name) => {
  const { user: u, token } = await ok('/api/auth/register', { username: name, password: PW });
  return { ...u, token };
};

test('accounts: register, login on a second device, sessions, logout', async () => {
  const zed = await user('zed');
  assert.equal((await call('/api/auth/register', { username: 'ZED', password: PW })).status, 409, 'usernames are case-insensitive');
  assert.equal((await call('/api/auth/register', { username: 'shorty', password: 'short' })).status, 400, 'password too short');
  assert.equal((await call('/api/auth/login', { username: 'zed', password: 'wrong password' })).status, 401);
  assert.equal((await call('/api/auth/login', { username: 'nobody', password: PW })).status, 401);

  const phone = await ok('/api/auth/login', { username: 'Zed', password: PW });
  assert.equal(phone.user.id, zed.id, 'login from another device gets the same account');
  assert.notEqual(phone.token, zed.token);

  const me = await ok('/api/auth/me', null, phone);
  assert.equal(me.user.username, 'zed');
  const { sessions } = await ok('/api/auth/sessions', null, phone);
  assert.equal(sessions.length, 2);
  assert.equal(sessions.filter((s) => s.current).length, 1);

  await ok('/api/auth/logout', {}, phone);
  assert.equal((await call('/api/auth/me', null, phone)).status, 401, 'logged-out token is dead');
  await ok('/api/auth/me', null, zed); // other device still signed in

  const tablet = await ok('/api/auth/login', { username: 'zed', password: PW });
  const all = await ok('/api/auth/logout-all', {}, tablet);
  assert.equal(all.signedOut, 2);
  assert.equal((await call('/api/auth/me', null, zed)).status, 401);

  assert.equal((await call('/api/auth/me')).status, 401, 'no token');
  assert.equal((await call('/api/auth/me', null, { token: 'forged' })).status, 401);
});

test('sessions expire after 30 idle days', async () => {
  const old = await user('old');
  clock += 31 * 86400_000;
  assert.equal((await call('/api/auth/me', null, old)).status, 401);
});

test('full round: hide, find, hide next, leaderboard', async () => {
  const ana = await user('ana');
  const ben = await user('ben');

  assert.equal((await call('/api/eggs', { stationId: 'place-kencl', level: 2, image: IMG })).status, 401, 'must be signed in');
  await ok('/api/eggs', { stationId: 'place-kencl', level: 2, image: IMG, hint: 'by the stairs' }, ana);
  assert.equal((await call('/api/eggs', { stationId: 'place-kencl', level: 2, image: IMG }, ana)).status, 409, 'slot is taken');

  const st = await ok('/api/stations/place-kencl', null, ben);
  const egg = st.slots.find((s) => s.level === 2).egg;
  assert.ok(egg && !egg.mine && !egg.foundByMe);
  assert.equal(st.slots.filter((s) => s.egg).length, 1);
  assert.equal((await ok('/api/stations/place-kencl', null, ana)).slots[1].egg.mine, true);

  assert.equal((await call('/api/attempts', { eggId: egg.id }, ana)).status, 403, 'cannot play own egg');

  const round = await ok('/api/attempts', { eggId: egg.id, mode: 'fixed' }, ben);
  assert.equal(round.attempt.limitSeconds, 180);
  assert.equal(round.egg.hint, 'by the stairs');
  const photo = await fetch(base + round.egg.imageUrl);
  assert.equal(photo.status, 200);
  assert.equal((await photo.arrayBuffer()).byteLength, 300, 'egg photo is served from the database');

  assert.equal((await call(`/api/attempts/${round.attempt.id}/find`, { image: IMG }, ana)).status, 403, 'not your round');

  clock += 60_000; // 60s of 180s used -> 2/3 left -> bonus round(20*0.5*2/3)=7
  const found = await ok(`/api/attempts/${round.attempt.id}/find`, { image: IMG }, ben);
  assert.equal(found.status, 'found');
  assert.deepEqual(found.points, { base: 20, bonus: 7, total: 27 });

  assert.equal((await call('/api/attempts', { eggId: egg.id }, ben)).status, 409, 'no double finds');
  assert.equal((await call(`/api/attempts/${round.attempt.id}/find`, { image: IMG }, ben)).status, 409);

  // Hide-next must match the station and level of the find.
  assert.equal((await call('/api/eggs', { stationId: 'place-kencl', level: 3, findId: found.findId, image: IMG }, ben)).status, 400);
  assert.equal((await call('/api/eggs', { stationId: 'place-kencl', level: 2, findId: found.findId, image: IMG }, ana)).status, 403, "can't use someone else's find");
  await ok('/api/eggs', { stationId: 'place-kencl', level: 2, findId: found.findId, image: IMG }, ben);
  assert.equal((await call('/api/eggs', { stationId: 'place-kencl', level: 2, findId: found.findId, image: IMG }, ben)).status, 409, 'one hide per find');

  const after = await ok('/api/stations/place-kencl', null, ana);
  const newEgg = after.slots.find((s) => s.level === 2).egg;
  assert.notEqual(newEgg.id, egg.id, "ben's egg replaced ana's");
  assert.equal(newEgg.createdBy, 'ben');

  const board = await ok('/api/leaderboard');
  assert.equal(board.rows[0].username, 'ben');
  assert.equal(board.rows[0].points, 27);
  assert.deepEqual(board.lines, [{ line: 'Green', points: 27 }]);

  const profile = await ok(`/api/users/${ben.id}`, null, ben);
  assert.equal(profile.monthPoints, 27);
  assert.equal(profile.findsByLevel.Medium, 1);
  assert.equal(profile.eggsHidden, 1);
  assert.equal(profile.monthRank, 1);
  assert.equal(profile.recentFinds.length, 1);
  const anaProfile = await ok(`/api/users/${ana.id}`, null, ana);
  assert.equal(anaProfile.timesYourEggsWereFound, 1);

  const stations = await ok('/api/stations');
  assert.equal(stations.stations.find((s) => s.id === 'place-kencl').activeEggs, 1);
});

test('the same round submitted twice at once scores once', async () => {
  const mo = await user('mo');
  const ned = await user('ned');
  await ok('/api/eggs', { stationId: 'place-pktrm', level: 2, image: IMG }, mo);
  const eggId = (await ok('/api/stations/place-pktrm')).slots[1].egg.id;
  const round = await ok('/api/attempts', { eggId }, ned);
  const results = await Promise.all([1, 2, 3].map(() => call(`/api/attempts/${round.attempt.id}/find`, { image: IMG }, ned)));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal(await db.col.finds.countDocuments({ userId: ned.id }), 1);
});

test('two players finding the same egg at once rotate the slot once', async () => {
  const [ola, pat, quinn, ray] = [await user('ola'), await user('pat'), await user('quinn'), await user('ray')];
  // Two eggs in the Park Street level-5 slot: ola's in the pool, pat's active.
  await ok('/api/eggs', { stationId: 'place-pktrm', level: 5, image: IMG }, ola);
  const r0 = await ok('/api/attempts', { eggId: (await ok('/api/stations/place-pktrm')).slots[4].egg.id }, pat);
  const f0 = await ok(`/api/attempts/${r0.attempt.id}/find`, { image: IMG }, pat);
  await ok('/api/eggs', { stationId: 'place-pktrm', level: 5, findId: f0.findId, image: IMG }, pat);
  const eggId = (await ok('/api/stations/place-pktrm')).slots[4].egg.id;

  const [a, b] = [await ok('/api/attempts', { eggId }, quinn), await ok('/api/attempts', { eggId }, ray)];
  const results = await Promise.all([
    call(`/api/attempts/${a.attempt.id}/find`, { image: IMG }, quinn),
    call(`/api/attempts/${b.attempt.id}/find`, { image: IMG }, ray),
  ]);
  assert.deepEqual(results.map((r) => r.status), [200, 200], 'both finds count');
  assert.equal(await db.col.eggs.countDocuments({ stationId: 'place-pktrm', level: 5, status: 'active' }), 1, 'still exactly one active egg');
  assert.equal((await db.col.eggs.findOne({ _id: eggId })).timesFound, 2);
});

test('no match keeps the round open; time runs out', async () => {
  const cat = await user('cat');
  const dan = await user('dan');
  await ok('/api/eggs', { stationId: 'place-pktrm', level: 1, image: IMG }, cat);
  const eggId = (await ok('/api/stations/place-pktrm')).slots[0].egg.id;
  const round = await ok('/api/attempts', { eggId }, dan);

  nextVerify = { method: 'gemini', match: false, confidence: 0.2, reason: 'Different sign.' };
  const miss = await ok(`/api/attempts/${round.attempt.id}/find`, { image: IMG }, dan);
  assert.equal(miss.status, 'no_match');
  nextVerify = { method: 'gemini', match: true, confidence: 0.9, reason: 'ok' };

  clock += (120 + 16) * 1000; // past limit + grace
  const late = await ok(`/api/attempts/${round.attempt.id}/find`, { image: IMG }, dan);
  assert.equal(late.status, 'expired');
});

test('race-the-train timer uses the next train', async () => {
  const eve = await user('eve');
  const fay = await user('fay');
  await ok('/api/eggs', { stationId: 'place-pktrm', level: 4, image: IMG }, eve);
  const eggId = (await ok('/api/stations/place-pktrm')).slots[3].egg.id;
  const round = await ok('/api/attempts', { eggId, mode: 'train' }, fay);
  assert.equal(round.attempt.limitSource, 'train');
  assert.equal(round.attempt.limitSeconds, 240);
});

test('three reports retire an egg and the pool refills the slot', async () => {
  const [gus, hal, ivy, jo] = [await user('gus'), await user('hal'), await user('ivy'), await user('jo')];
  await ok('/api/eggs', { stationId: 'place-pktrm', level: 3, image: IMG }, gus);
  const first = (await ok('/api/stations/place-pktrm')).slots[2].egg.id;
  // hal finds it and hides a new one, so the first egg goes to the pool.
  const r = await ok('/api/attempts', { eggId: first }, hal);
  const f = await ok(`/api/attempts/${r.attempt.id}/find`, { image: IMG }, hal);
  await ok('/api/eggs', { stationId: 'place-pktrm', level: 3, findId: f.findId, image: IMG }, hal);
  const second = (await ok('/api/stations/place-pktrm')).slots[2].egg.id;
  assert.notEqual(second, first);

  for (const u of [gus, ivy, ivy]) await ok(`/api/eggs/${second}/report`, { reason: 'cant_find' }, u);
  assert.equal((await ok('/api/stations/place-pktrm')).slots[2].egg.id, second, 'duplicate report from ivy not counted');
  const last = await ok(`/api/eggs/${second}/report`, { reason: 'unsafe' }, jo);
  assert.equal(last.retired, true);
  assert.equal((await ok('/api/stations/place-pktrm')).slots[2].egg.id, first, 'pool egg back in the slot');
});

test('unfound eggs retire after 7 days', async () => {
  const kim = await user('kim');
  await ok('/api/eggs', { stationId: 'place-kencl', level: 5, image: IMG }, kim);
  assert.ok((await ok('/api/stations/place-kencl')).slots[4].egg);
  clock += 8 * 86400_000;
  assert.equal((await ok('/api/stations/place-kencl')).slots[4].egg, null);
});

test('friend groups: create, invite, join, group leaderboard', async () => {
  const [gia, hugo, iris, outsider] = [await user('gia'), await user('hugo'), await user('iris'), await user('outsider')];
  assert.equal((await call('/api/groups', { name: 'Red Line Crew' })).status, 401, 'must be signed in');
  assert.equal((await call('/api/groups', { name: 'x' }, gia)).status, 400, 'name too short');
  assert.equal((await call('/api/groups', { name: '<b>hi</b>' }, gia)).status, 400, 'no markup in names');

  const { group } = await ok('/api/groups', { name: '  Red   Line Crew ' }, gia);
  assert.equal(group.name, 'Red Line Crew', 'whitespace is tidied');
  assert.equal(group.isOwner, true);
  assert.match(group.inviteCode, /^[A-HJ-NP-Z2-9]{8}$/);

  // Invite preview, then join (codes are case- and dash-insensitive).
  const preview = await ok(`/api/groups/invite/${group.inviteCode.toLowerCase()}`, null, hugo);
  assert.deepEqual([preview.group.name, preview.alreadyMember], ['Red Line Crew', false]);
  const sloppy = `${group.inviteCode.slice(0, 4)}-${group.inviteCode.slice(4)}`.toLowerCase();
  assert.equal((await ok('/api/groups/join', { code: sloppy }, hugo)).group.memberCount, 2);
  assert.equal((await ok('/api/groups/join', { code: group.inviteCode }, hugo)).group.memberCount, 2, 'joining twice is a no-op');
  await ok('/api/groups/join', { code: group.inviteCode }, iris);
  assert.equal((await call('/api/groups/join', { code: 'ZZZZZZZZ' }, iris)).status, 404);
  assert.equal((await call(`/api/groups/invite/nope`, null, iris)).status, 404);

  // Only members can see the board.
  assert.equal((await call(`/api/groups/${group.id}`, null, outsider)).status, 403);
  assert.equal((await call(`/api/groups/${group.id}`)).status, 401);

  // hugo scores; the outsider scores more but isn't in the group.
  await ok('/api/eggs', { stationId: 'place-kencl', level: 4, image: IMG }, gia);
  const egg4 = (await ok('/api/stations/place-kencl')).slots[3].egg.id;
  for (const who of [hugo, outsider]) {
    const r = await ok('/api/attempts', { eggId: egg4 }, who);
    await ok(`/api/attempts/${r.attempt.id}/find`, { image: IMG }, who);
  }
  const board = await ok(`/api/groups/${group.id}`, null, iris);
  assert.equal(board.group.isOwner, false);
  assert.deepEqual(board.rows.map((r) => [r.username, r.rank]), [['hugo', 1], ['gia', null], ['iris', null]], 'members only; zero-point members listed unranked');
  assert.equal(board.rows[0].points, 60, 'level 4 = 40 base + 20 full time bonus');
  assert.equal(board.rows.find((r) => r.username === 'gia').isOwner, true);
  const allTime = await ok(`/api/groups/${group.id}?period=all`, null, iris);
  assert.equal(allTime.period, 'all');
  assert.equal(allTime.rows[0].points, 60);

  const mine = await ok('/api/groups', null, hugo);
  assert.deepEqual(mine.groups.map((g) => g.name), ['Red Line Crew']);

  // Rename: owner only.
  assert.equal((await call(`/api/groups/${group.id}/rename`, { name: 'Hacked' }, hugo)).status, 403);
  assert.equal((await ok(`/api/groups/${group.id}/rename`, { name: 'Green Line Gang' }, gia)).group.name, 'Green Line Gang');

  // Owner leaves: the longest-standing member (hugo) takes over.
  assert.equal((await call(`/api/groups/${group.id}/leave`, {}, outsider)).status, 403);
  await ok(`/api/groups/${group.id}/leave`, {}, gia);
  const after = await ok(`/api/groups/${group.id}`, null, hugo);
  assert.equal(after.group.isOwner, true, 'ownership passed to hugo');
  assert.equal(after.group.memberCount, 2);
  assert.equal((await call(`/api/groups/${group.id}`, null, gia)).status, 403, 'gia is out');

  // Last one out deletes the group.
  await ok(`/api/groups/${group.id}/leave`, {}, iris);
  const last = await ok(`/api/groups/${group.id}/leave`, {}, hugo);
  assert.equal(last.deleted, true);
  assert.equal((await call(`/api/groups/join`, { code: group.inviteCode }, gia)).status, 404, 'invite dies with the group');
});

test('friend groups: size and per-player limits hold under concurrent joins', async () => {
  const { MAX_GROUP_MEMBERS, MAX_GROUPS_PER_USER } = await import('../src/app.js');
  const owner = await user('bigowner');
  const { group } = await ok('/api/groups', { name: 'Huge Group' }, owner);
  // Fill to one below the limit directly, then race 3 joiners for the last seat.
  const filler = Array.from({ length: MAX_GROUP_MEMBERS - 2 }, (_, i) => ({ _id: crypto.randomUUID(), groupId: group.id, userId: crypto.randomUUID(), joinedAt: new Date(clock) }));
  await db.col.groupMembers.insertMany(filler);
  await db.col.groups.updateOne({ _id: group.id }, { $set: { memberCount: MAX_GROUP_MEMBERS - 1 } });
  const racers = [await user('racer1'), await user('racer2'), await user('racer3')];
  const results = await Promise.all(racers.map((r) => call('/api/groups/join', { code: group.inviteCode }, r)));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409], 'exactly one gets the last seat');
  assert.equal(await db.col.groupMembers.countDocuments({ groupId: group.id }), MAX_GROUP_MEMBERS);
  assert.equal((await db.col.groups.findOne({ _id: group.id })).memberCount, MAX_GROUP_MEMBERS);

  const busy = await user('busy');
  await Promise.all(Array.from({ length: MAX_GROUPS_PER_USER }, (_, i) => ok('/api/groups', { name: `Group ${i}` }, busy)));
  assert.equal((await call('/api/groups', { name: 'One too many' }, busy)).status, 409);
  assert.equal(await db.col.groupMembers.countDocuments({ userId: busy.id }), MAX_GROUPS_PER_USER);
});

test('group sticker chat: members only, stickers only, polling, rate limit', async () => {
  const [kai, lou, nosy] = [await user('kai'), await user('lou'), await user('nosy')];
  const { group } = await ok('/api/groups', { name: 'Sticker Squad' }, kai);
  await ok('/api/groups/join', { code: group.inviteCode }, lou);
  const chat = `/api/groups/${group.id}/messages`;

  const { stickers } = await ok('/api/config');
  assert.ok(stickers.length >= 10 && stickers.every((s) => s.id && s.emoji && s.label));

  assert.equal((await call(chat, { sticker: 'crown' }, nosy)).status, 403, 'non-members cannot send');
  assert.equal((await call(chat, null, nosy)).status, 403, 'or read');
  assert.equal((await call(chat, { text: 'hello' }, kai)).status, 400, 'no typed messages');
  assert.equal((await call(chat, { sticker: '<img src=x>' }, kai)).status, 400, 'unknown sticker');

  const first = await ok(chat, { sticker: 'crown' }, kai);
  assert.deepEqual([first.message.emoji, first.message.label, first.message.username, first.message.seq], ['👑', "Who's the king now", 'kai', 1]);
  await ok(chat, { sticker: 'snail' }, lou);

  const all = await ok(chat, null, lou);
  assert.deepEqual(all.messages.map((m) => [m.username, m.sticker]), [['kai', 'crown'], ['lou', 'snail']]);
  assert.equal(all.messages.some((m) => 'text' in m), false);
  // Polling returns only what's new.
  assert.deepEqual((await ok(`${chat}?after=2`, null, kai)).messages, []);
  await ok(chat, { sticker: 'fire' }, kai);
  assert.deepEqual((await ok(`${chat}?after=2`, null, lou)).messages.map((m) => m.sticker), ['fire']);

  // Concurrent sends get unique, gap-free sequence numbers.
  clock += 60_000;
  await Promise.all(['eyes', 'goat', 'skull', 'egg'].map((st, i) => ok(chat, { sticker: st }, i % 2 ? kai : lou)));
  const seqs = (await ok(chat, null, kai)).messages.map((m) => m.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7]);

  // Rate limit: 8 per 10 seconds per player.
  clock += 60_000;
  for (let i = 0; i < 8; i++) await ok(chat, { sticker: 'laugh' }, lou);
  assert.equal((await call(chat, { sticker: 'laugh' }, lou)).status, 429);
  await ok(chat, { sticker: 'cry' }, kai); // others aren't affected
  clock += 11_000;
  await ok(chat, { sticker: 'wave' }, lou);

  // Deleting the group (last one out) deletes its chat.
  await ok(`/api/groups/${group.id}/leave`, {}, kai);
  await ok(`/api/groups/${group.id}/leave`, {}, lou);
  assert.equal(await db.col.groupMessages.countDocuments({ groupId: group.id }), 0);
});

test('bad input, CORS, health and static files', async () => {
  assert.equal((await call('/api/auth/register', { username: '<script>', password: PW })).status, 400);
  const lee = await user('lee');
  assert.equal((await call('/api/eggs', { stationId: 'place-kencl', level: 1, image: 'data:text/html;base64,AAAA' }, lee)).status, 400);
  assert.equal((await call('/api/eggs', { stationId: 'nope', level: 1, image: IMG }, lee)).status, 404);
  assert.equal((await call('/api/eggs', { stationId: 'place-kencl', level: 9, image: IMG }, lee)).status, 400, 'unknown level');
  assert.equal((await call('/api/attempts', { eggId: 'x' }, lee)).status, 404);
  assert.equal((await call('/api/attempts/not-a-uuid/find', { image: IMG }, lee)).status, 404);
  assert.equal((await call('/api/attempts', { eggId: crypto.randomUUID() })).status, 401);
  assert.equal((await call('/api/leaderboard?month=bad')).status, 400);

  assert.deepEqual((await ok('/api/health')), { ok: true });
  const allowed = await call('/api/config', null, null, { origin: 'https://app.example' });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.example');
  const blocked = await call('/api/config', null, null, { origin: 'https://evil.example' });
  assert.equal(blocked.headers.get('access-control-allow-origin'), null);
  const preflight = await fetch(`${base}/api/eggs`, { method: 'OPTIONS', headers: { origin: 'https://app.example' } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/);

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Station Egg Hunt/);
  assert.equal((await fetch(`${base}/..%2fbackend%2fserver.js`)).status, 404);
  assert.equal((await fetch(`${base}/photos/..%2f..%2fserver.js`)).status, 404);
  assert.equal((await fetch(`${base}/photos/${crypto.randomUUID()}.jpg`)).status, 404);
});
