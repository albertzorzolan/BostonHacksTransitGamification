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
import sharp from 'sharp';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DB_NAME = `egghunt_test_${crypto.randomBytes(4).toString('hex')}`;

const STATIONS = [
  { id: 'place-kencl', name: 'Kenmore', lat: 42.3489, lng: -71.0952, lines: [{ id: 'Green-B', name: 'Green Line B', color: '#00843D' }] },
  { id: 'place-pktrm', name: 'Park Street', lat: 42.3564, lng: -71.0624, lines: [{ id: 'Red', name: 'Red Line', color: '#DA291C' }, { id: 'Green-B', name: 'Green Line B', color: '#00843D' }] },
  // Same line layout as the two above, kept for the progress test so its slots are free.
  { id: 'test-green', name: 'Test Green', lat: 42.35, lng: -71.09, lines: [{ id: 'Green-B', name: 'Green Line B', color: '#00843D' }] },
  { id: 'test-redgreen', name: 'Test Red Green', lat: 42.355, lng: -71.06, lines: [{ id: 'Red', name: 'Red Line', color: '#DA291C' }, { id: 'Green-B', name: 'Green Line B', color: '#00843D' }] },
  { id: 'test-blur', name: 'Test Blur', lat: 42.36, lng: -71.07, lines: [{ id: 'Orange', name: 'Orange Line', color: '#ED8B00' }] },
  { id: 'test-count', name: 'Test Count', lat: 42.37, lng: -71.08, lines: [{ id: 'Blue', name: 'Blue Line', color: '#003DA5' }] },
  { id: 'test-activity', name: 'Test Activity', lat: 42.38, lng: -71.09, lines: [{ id: 'Red', name: 'Red Line', color: '#DA291C' }] },
];
const fakeMbta = {
  loadStations: async () => STATIONS,
  predictions: async () => [{ routeId: 'Green-B', line: 'Green Line B', color: '#00843D', headsign: 'Boston College', seconds: 240 }],
};
// A real JPEG (with some detail, so a blurred copy is measurably different).
const IMG_BUF = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#d94a3a' } })
  .composite([{ input: Buffer.from('<svg width="320" height="240"><rect x="40" y="40" width="80" height="160" fill="#fff"/><rect x="200" y="60" width="60" height="60" fill="#123"/></svg>'), top: 0, left: 0 }])
  .jpeg({ quality: 90 })
  .toBuffer();
const IMG = `data:image/jpeg;base64,${IMG_BUF.toString('base64')}`;
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
  assert.equal((await photo.arrayBuffer()).byteLength, IMG_BUF.length, 'level 2: the original photo, served from the database');

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

  clock += (180 + 16) * 1000; // past the 3-minute limit + grace
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
  clock += 1000; // iris joins after hugo, so hugo is the longest-standing member later
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
  assert.deepEqual([first.message.emoji, first.message.label, first.message.name, first.message.mine, first.message.seq], ['👑', "Who's the king now", kai.chatName, true, 1]);
  await ok(chat, { sticker: 'snail' }, lou);

  // Anonymous: senders show by chat name only, with no username or user id.
  const all = await ok(chat, null, lou);
  assert.deepEqual(all.messages.map((m) => [m.name, m.mine, m.sticker]), [[kai.chatName, false, 'crown'], [lou.chatName, true, 'snail']]);
  assert.equal(all.messages.some((m) => 'text' in m || 'username' in m || 'userId' in m), false);
  assert.equal(JSON.stringify(all).includes(kai.id), false);
  // A new chat name shows on old messages too.
  await ok('/api/me/names', { chatName: 'Masked Crown' }, kai);
  assert.equal((await ok(chat, null, lou)).messages[0].name, 'Masked Crown');
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

test('every level has a 3-minute timer; Extreme and Impossible show a blurred photo', async () => {
  const cfg = await ok('/api/config');
  assert.deepEqual(cfg.levels.map((l) => l.seconds), [180, 180, 180, 180, 180]);
  assert.deepEqual(cfg.levels.map((l) => l.points), [10, 20, 30, 40, 60], 'points unchanged');

  const [hider, finder, rival] = [await user('blurhider'), await user('blurfinder'), await user('blurrival')];
  for (const level of [1, 4, 5]) await ok('/api/eggs', { stationId: 'test-blur', level, image: IMG }, hider);
  const slots = (await ok('/api/stations/test-blur', null, finder)).slots;
  const pixels = async (url) => sharp(Buffer.from(await (await fetch(base + url)).arrayBuffer())).resize(64, 48).raw().toBuffer();
  const sharpPx = await sharp(IMG_BUF).resize(64, 48).raw().toBuffer();
  // Mean absolute pixel difference from the original: 0 = identical.
  const diffFrom = (px) => px.reduce((sum, v, i) => sum + Math.abs(v - sharpPx[i]), 0) / px.length;

  const rounds = {};
  for (const level of [1, 4, 5]) {
    const egg = slots.find((s) => s.level === level).egg;
    rounds[level] = await ok('/api/attempts', { eggId: egg.id }, finder);
    assert.equal(rounds[level].attempt.limitSeconds, 180, `level ${level}: 3 minutes`);
  }
  assert.equal(rounds[1].egg.blur, null);
  assert.equal(rounds[4].egg.blur, 'light');
  assert.equal(rounds[5].egg.blur, 'heavy');

  const d1 = diffFrom(await pixels(rounds[1].egg.imageUrl));
  const d4 = diffFrom(await pixels(rounds[4].egg.imageUrl));
  const d5 = diffFrom(await pixels(rounds[5].egg.imageUrl));
  assert.ok(d1 < 2, `Easy is the original (diff ${d1.toFixed(1)})`);
  assert.ok(d4 > d1 + 3, `Extreme is blurred (diff ${d4.toFixed(1)})`);
  assert.ok(d5 > d4 + 3, `Impossible is blurred much more (diff ${d5.toFixed(1)})`);

  // The finder never gets the original's URL until they find it; then it's revealed.
  const egg5 = await db.col.eggs.findOne({ _id: rounds[5].egg.id });
  assert.notEqual(rounds[5].egg.imageUrl, `/photos/${egg5.photoId}.jpg`);
  const found = await ok(`/api/attempts/${rounds[5].attempt.id}/find`, { image: IMG }, finder);
  assert.equal(found.revealUrl, `/photos/${egg5.photoId}.jpg`);

  // A rival can't see the finder's sharp find photo while that egg is still in play...
  const fromRival = await ok(`/api/users/${finder.id}`, null, rival);
  assert.equal(fromRival.recentFinds[0].photoUrl, null);
  // ...but the finder sees their own.
  assert.ok((await ok(`/api/users/${finder.id}`, null, finder)).recentFinds[0].photoUrl);

  // Eggs hidden before blurring existed get their blurred copy on first play.
  const egg4 = await db.col.eggs.findOne({ _id: rounds[4].egg.id });
  await db.col.eggs.updateOne({ _id: egg4._id }, { $unset: { displayPhotoId: '' } });
  const again = await ok('/api/attempts', { eggId: egg4._id }, rival);
  assert.notEqual(again.egg.imageUrl, `/photos/${egg4.photoId}.jpg`);
  assert.ok((await db.col.eggs.findOne({ _id: egg4._id })).displayPhotoId, 'copy saved for next time');

  // A level-5 upload that isn't a real image is refused instead of breaking later.
  const junk = `data:image/jpeg;base64,${Buffer.alloc(400, 7).toString('base64')}`;
  assert.equal((await call('/api/eggs', { stationId: 'test-blur', level: 4, image: junk }, hider)).status, 400);
});

test('station list: egg count at every station, what each player can still find, totals', async () => {
  const [ann, bo, cy] = [await user('countann'), await user('countbo'), await user('countcy')];
  await ok('/api/eggs', { stationId: 'test-count', level: 1, image: IMG }, ann);
  await ok('/api/eggs', { stationId: 'test-count', level: 2, image: IMG }, ann);
  const eggId = (await ok('/api/stations/test-count')).slots[0].egg.id;
  const r = await ok('/api/attempts', { eggId }, bo);
  await ok(`/api/attempts/${r.attempt.id}/find`, { image: IMG }, bo);

  const pick = (d) => d.stations.find((s) => s.id === 'test-count');
  const anon = await ok('/api/stations');
  assert.equal(anon.stations.length, STATIONS.length, 'every station is listed');
  assert.ok(anon.stations.every((s) => Number.isInteger(s.activeEggs)), 'every station has a count, 0 included');
  assert.equal(pick(anon).activeEggs, 2);
  assert.equal('playable' in pick(anon), false, 'no per-player numbers when signed out');
  assert.equal(anon.totals.eggs, anon.stations.reduce((n, s) => n + s.activeEggs, 0));
  assert.equal(anon.totals.stationsWithEggs, anon.stations.filter((s) => s.activeEggs).length);
  assert.equal(anon.totals.stations, STATIONS.length);

  assert.equal(pick(await ok('/api/stations', null, ann)).playable, 0, 'both are ann\'s own');
  assert.equal(pick(await ok('/api/stations', null, bo)).playable, 1, 'bo found one');
  const forCy = await ok('/api/stations', null, cy);
  assert.equal(pick(forCy).playable, 2);
  assert.equal(forCy.totals.playable, forCy.stations.reduce((n, s) => n + s.playable, 0));
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

test('progress: rider level, daily challenge, stamps, stations and lines', async () => {
  const quin = await user('quin');
  const rae = await user('rae');
  // An empty account has level 1 and nothing earned.
  const empty = await ok('/api/me/progress', null, rae);
  assert.equal(empty.level.level, 1);
  assert.equal(empty.stamps.filter((s) => s.earned).length, 0);
  assert.equal((await call('/api/me/progress')).status, 401, 'must be signed in');

  // quin hides at Kenmore (Green) and Park Street (Red + Green); rae finds both, racing a train at Park Street.
  await ok('/api/eggs', { stationId: 'test-green', level: 5, image: IMG }, quin);
  await ok('/api/eggs', { stationId: 'test-redgreen', level: 5, image: IMG }, quin);
  const ken = (await ok('/api/stations/test-green')).slots[4].egg.id;
  const pk = (await ok('/api/stations/test-redgreen')).slots[4].egg.id;

  const r1 = await ok('/api/attempts', { eggId: ken, mode: 'fixed' }, rae);
  clock += 20_000;
  const f1 = await ok(`/api/attempts/${r1.attempt.id}/find`, { image: IMG }, rae);
  assert.equal(f1.firstFind, true, 'first to find this egg');

  const r2 = await ok('/api/attempts', { eggId: pk, mode: 'train' }, rae);
  clock += 60_000;
  await ok(`/api/attempts/${r2.attempt.id}/find`, { image: IMG }, rae);

  const p = await ok('/api/me/progress', null, rae);
  const earned = new Set(p.stamps.filter((s) => s.earned).map((s) => s.id));
  for (const id of ['first_find', 'transfer', 'beat_train', 'first_to_find', 'speedy', 'impossible']) {
    assert.ok(earned.has(id), `${id} should be earned`);
  }
  assert.equal(earned.has('all_lines'), false);
  assert.equal(p.stamps.find((s) => s.id === 'all_lines').progress, 2, 'Red and Green');
  assert.equal(p.stations.length, 2);
  assert.deepEqual(p.lines.find((l) => l.line === 'Green'), { line: 'Green', stations: 2 });
  assert.deepEqual(p.lines.find((l) => l.line === 'Red'), { line: 'Red', stations: 1 });
  assert.deepEqual(new Set(p.today.lines), new Set(['Green', 'Red']));
  // 60 + 27 bonus (20 s of 3 min) at Kenmore, 60 + 23 bonus racing the train = 170 -> level 3 (150 to 300)
  assert.equal(p.level.points, 170);
  assert.deepEqual([p.level.level, p.level.floor, p.level.next], [3, 150, 300]);
  assert.ok(['transfer', 'racer', 'climber', 'triple'].includes(p.today.id));
  assert.equal(p.today.target >= p.today.progress, true);
});

test('names: a username plus an anonymous chat name, both changeable, one namespace', async () => {
  const ada = await user('ada');
  assert.match(ada.chatName, /^[A-Z][a-z]+ [A-Z][a-z]+ \d{2}$/, 'a random chat name at sign-up');
  assert.notEqual(ada.chatName, ada.username);
  // Other players never see it.
  const bo = await user('bo');
  const seen = await ok(`/api/users/${ada.id}`, null, bo);
  assert.equal('chatName' in seen.user, false);
  assert.equal('activity' in seen, false, 'activity is private');

  const names = (body, as = ada) => call('/api/me/names', body, as);
  assert.equal((await ok('/api/me/names', { chatName: '  Night   Owl ' }, ada)).user.chatName, 'Night Owl');
  assert.equal((await ok('/api/auth/me', null, ada)).user.chatName, 'Night Owl');
  assert.equal((await names({ chatName: 'x' })).status, 400, 'too short');
  assert.equal((await names({ chatName: '<b>hi</b>' })).status, 400);
  assert.equal((await names({ chatName: 'ADA' })).status, 400, "can't be your own username");
  assert.equal((await names({ chatName: 'bo' })).status, 409, "can't look like someone else's username");
  assert.equal((await names({ chatName: 'night owl' }, bo)).status, 409, 'chat names are unique');
  assert.equal((await call('/api/auth/register', { username: 'Night Owl', password: PW })).status, 409, 'and usernames avoid chat names');

  // Username changes: login uses the new one; the old one is free again.
  assert.equal((await names({ username: 'Bo' })).status, 409);
  assert.equal((await ok('/api/me/names', { username: 'ada_lovelace' }, ada)).user.username, 'ada_lovelace');
  assert.equal((await call('/api/auth/login', { username: 'ada', password: PW })).status, 401);
  await ok('/api/auth/login', { username: 'ADA_lovelace', password: PW });
  await user('ada');
  assert.equal((await names({ username: 'Night Owl' })).status, 400, "username can't become your own chat name");

  // Accounts made before chat names existed get one the next time they load.
  const legacy = await user('legacy');
  await db.col.users.updateOne({ _id: legacy.id }, { $unset: { chatName: 1, chatNameLower: 1 } });
  assert.ok((await ok('/api/auth/me', null, legacy)).user.chatName);
});

test('profile activity: finds, eggs hidden, your eggs found by others, groups, sign-up', async () => {
  const [cy, dot] = [await user('cy'), await user('dot')];
  const st = { id: 'test-activity', name: 'Test Activity' };
  clock += 1000;
  const { egg } = await ok('/api/eggs', { stationId: st.id, level: 2, image: IMG, hint: 'by the map' }, cy);
  clock += 1000;
  const { attempt } = await ok('/api/attempts', { eggId: egg.id }, dot);
  clock += 5000;
  await ok(`/api/attempts/${attempt.id}/find`, { image: IMG }, dot);
  clock += 1000;
  const { group } = await ok('/api/groups', { name: 'Activity Club' }, cy);

  const { activity } = await ok(`/api/users/${cy.id}`, null, cy);
  assert.deepEqual(activity.map((a) => a.type), ['joined_group', 'egg_found', 'hid', 'signed_up']);
  assert.deepEqual([activity[0].groupName, activity[1].by, activity[1].stationName, activity[2].levelName], ['Activity Club', 'dot', st.name, 'Medium']);
  const mine = (await ok(`/api/users/${dot.id}`, null, dot)).activity;
  assert.equal(mine[0].type, 'found');
  assert.ok(mine[0].points > 0);
  await ok(`/api/groups/${group.id}/leave`, {}, cy);
});

test('notifications: your eggs, a heads-up when one is found, counts', async () => {
  const [eve, fin, gus] = [await user('n_eve'), await user('n_fin'), await user('n_gus')];
  const none = await ok('/api/me/notifications', null, eve);
  assert.deepEqual([none.unseen, none.counts, none.items], [0, { finds: 0, eggsHidden: 0, foundByOthers: 0 }, []]);
  assert.equal((await call('/api/me/notifications')).status, 401);

  clock += 1000;
  const { egg } = await ok('/api/eggs', { stationId: 'test-activity', level: 3, image: IMG, hint: 'under the clock' }, eve);
  const hid = (await ok('/api/me/notifications', null, eve)).items[0];
  assert.deepEqual([hid.type, hid.levelName, hid.hint, hid.timesFound, hid.status], ['egg_hidden', 'Hard', 'under the clock', 0, 'active']);
  assert.ok(hid.photoUrl, 'you see your own egg photo');

  for (const p of [fin, gus]) {
    clock += 1000;
    const { attempt } = await ok('/api/attempts', { eggId: egg.id }, p);
    clock += 3000;
    await ok(`/api/attempts/${attempt.id}/find`, { image: IMG }, p);
  }
  const poll = await ok('/api/me/notifications?summary=1', null, eve);
  assert.equal(poll.unseen, 2);
  assert.deepEqual(poll.latest.map((n) => n.by), ['n_gus', 'n_fin'], 'newest first');
  assert.equal('items' in poll, false, 'the poll stays small');

  const full = await ok('/api/me/notifications', null, eve);
  assert.deepEqual(full.counts, { finds: 0, eggsHidden: 1, foundByOthers: 2 });
  assert.deepEqual(full.items.map((n) => n.type), ['egg_found', 'egg_found', 'egg_hidden']);
  assert.ok(full.items[0].unseen && full.items[0].points > 0);
  assert.equal(full.items[2].timesFound, 2);
  assert.equal((await ok('/api/me/notifications', null, fin)).counts.finds, 1);

  await ok('/api/me/notifications/seen', {}, eve);
  const after = await ok('/api/me/notifications', null, eve);
  assert.equal(after.unseen, 0);
  assert.equal(after.items.some((n) => n.unseen), false, 'still listed, no longer new');
});
