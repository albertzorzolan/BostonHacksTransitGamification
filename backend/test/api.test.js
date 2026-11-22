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
  { id: 'test-count', name: 'Test Count', lat: 42.39, lng: -71.1, lines: [{ id: 'Blue', name: 'Blue Line', color: '#003DA5' }] },
  { id: 'test-activity', name: 'Test Activity', lat: 42.4, lng: -71.11, lines: [{ id: 'Red', name: 'Red Line', color: '#DA291C' }] },
  { id: 'test-clock', name: 'Test Clock', lat: 42.37, lng: -71.08, lines: [{ id: 'Blue', name: 'Blue Line', color: '#003DA5' }] },
  { id: 'test-map', name: 'Test Map', lat: 42.41, lng: -71.12, lines: [{ id: 'Green-B', name: 'Green Line B', color: '#00843D' }] },
  { id: 'test-screen', name: 'Test Screen', lat: 42.43, lng: -71.14, lines: [{ id: 'Red', name: 'Red Line', color: '#DA291C' }] },
  { id: 'test-map', name: 'Test Map', lat: 42.41, lng: -71.12, lines: [{ id: 'Orange', name: 'Orange Line', color: '#ED8B00' }] },
];
let fakeVehicles = []; // live trains, for the train lobby tests
const fakeMbta = {
  vehicles: async () => fakeVehicles,
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
let nextScreen = { ok: true, method: 'gemini', subject: 'a red sticker' };
const screened = [];
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
    screen: async (args) => { screened.push(args); return nextScreen; },
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
let emailN = 0; // a username can be freed and reused (renames), so each sign-up gets its own address
const user = async (name) => {
  const { user: u, token } = await ok('/api/auth/register', { username: name, password: PW, email: `player${++emailN}@example.com` });
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

  assert.equal((await call('/api/eggs', { name: 'sticker', stationId: 'place-kencl', level: 2, image: IMG })).status, 401, 'must be signed in');
  await ok('/api/eggs', { name: 'sticker', stationId: 'place-kencl', level: 2, image: IMG, hint: 'by the stairs' }, ana);
  assert.equal((await call('/api/eggs', { name: 'sticker', stationId: 'place-kencl', level: 2, image: IMG }, ana)).status, 409, 'slot is taken');

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
  assert.equal((await call('/api/eggs', { name: 'sticker', stationId: 'place-kencl', level: 3, findId: found.findId, image: IMG }, ben)).status, 400);
  assert.equal((await call('/api/eggs', { name: 'sticker', stationId: 'place-kencl', level: 2, findId: found.findId, image: IMG }, ana)).status, 403, "can't use someone else's find");
  await ok('/api/eggs', { name: 'sticker', stationId: 'place-kencl', level: 2, findId: found.findId, image: IMG }, ben);
  assert.equal((await call('/api/eggs', { name: 'sticker', stationId: 'place-kencl', level: 2, findId: found.findId, image: IMG }, ben)).status, 409, 'one hide per find');

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
  await ok('/api/eggs', { name: 'sticker', stationId: 'place-pktrm', level: 2, image: IMG }, mo);
  const eggId = (await ok('/api/stations/place-pktrm')).slots[1].egg.id;
  const round = await ok('/api/attempts', { eggId }, ned);
  const results = await Promise.all([1, 2, 3].map(() => call(`/api/attempts/${round.attempt.id}/find`, { image: IMG }, ned)));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal(await db.col.finds.countDocuments({ userId: ned.id }), 1);
});

test('two players finding the same egg at once rotate the slot once', async () => {
  const [ola, pat, quinn, ray] = [await user('ola'), await user('pat'), await user('quinn'), await user('ray')];
  // Two eggs in the Park Street level-5 slot: ola's in the pool, pat's active.
  await ok('/api/eggs', { name: 'sticker', stationId: 'place-pktrm', level: 5, image: IMG }, ola);
  const r0 = await ok('/api/attempts', { eggId: (await ok('/api/stations/place-pktrm')).slots[4].egg.id }, pat);
  const f0 = await ok(`/api/attempts/${r0.attempt.id}/find`, { image: IMG }, pat);
  await ok('/api/eggs', { name: 'sticker', stationId: 'place-pktrm', level: 5, findId: f0.findId, image: IMG }, pat);
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
  await ok('/api/eggs', { name: 'sticker', stationId: 'place-pktrm', level: 1, image: IMG }, cat);
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

test('there is no race-the-train mode: every round gets its level\'s fixed clock', async () => {
  const eve = await user('eve');
  const fay = await user('fay');
  await ok('/api/eggs', { name: 'sticker', stationId: 'place-pktrm', level: 4, image: IMG }, eve);
  const eggId = (await ok('/api/stations/place-pktrm')).slots[3].egg.id;
  const round = await ok('/api/attempts', { eggId, mode: 'train' }, fay);
  assert.equal(round.attempt.limitSeconds, 180);
  assert.equal('limitSource' in round.attempt, false);
});

test('three reports retire an egg and the pool refills the slot', async () => {
  const [gus, hal, ivy, jo] = [await user('gus'), await user('hal'), await user('ivy'), await user('jo')];
  await ok('/api/eggs', { name: 'sticker', stationId: 'place-pktrm', level: 3, image: IMG }, gus);
  const first = (await ok('/api/stations/place-pktrm')).slots[2].egg.id;
  // hal finds it and hides a new one, so the first egg goes to the pool.
  const r = await ok('/api/attempts', { eggId: first }, hal);
  const f = await ok(`/api/attempts/${r.attempt.id}/find`, { image: IMG }, hal);
  await ok('/api/eggs', { name: 'sticker', stationId: 'place-pktrm', level: 3, findId: f.findId, image: IMG }, hal);
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
  await ok('/api/eggs', { name: 'sticker', stationId: 'place-kencl', level: 5, image: IMG }, kim);
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
  await ok('/api/eggs', { name: 'sticker', stationId: 'place-kencl', level: 4, image: IMG }, gia);
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
  assert.equal((await call(chat, { text: 'see www.spam.com' }, kai)).status, 400, 'no links');
  assert.equal((await call(chat, { text: 'x'.repeat(141) }, kai)).status, 400, 'short messages only');
  assert.equal((await call(chat, { sticker: '<img src=x>' }, kai)).status, 400, 'unknown sticker');

  const first = await ok(chat, { sticker: 'crown' }, kai);
  assert.deepEqual([first.message.emoji, first.message.label, first.message.name, first.message.mine, first.message.seq], ['👑', "Who's the king now", kai.chatName, true, 1]);
  await ok(chat, { sticker: 'snail' }, lou);
  // Text with emojis is fine too (a separate group, so the sequence checks below stay simple).
  const { group: g2 } = await ok('/api/groups', { name: 'Text Squad' }, kai);
  const said = await ok(`/api/groups/${g2.id}/messages`, { text: '  gg   😂🔥 ' }, kai);
  assert.deepEqual([said.message.text, said.message.mine, 'sticker' in said.message], ['gg 😂🔥', true, false]);
  await ok(`/api/groups/${g2.id}/leave`, {}, kai);

  // Anonymous: senders show by chat name only, with no username or user id.
  const all = await ok(chat, null, lou);
  assert.deepEqual(all.messages.map((m) => [m.name, m.mine, m.sticker]), [[kai.chatName, false, 'crown'], [lou.chatName, true, 'snail']]);
  assert.equal(all.messages.some((m) => 'username' in m || 'userId' in m), false);
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

test('Hard gets 2 minutes and Impossible 1, the rest 3; Extreme and Impossible show a blurred photo', async () => {
  const cfg = await ok('/api/config');
  assert.deepEqual(cfg.levels.map((l) => l.seconds), [180, 180, 120, 180, 60]);
  assert.deepEqual(cfg.levels.map((l) => l.points), [10, 20, 30, 40, 60], 'points unchanged');

  const [hider, finder, rival] = [await user('blurhider'), await user('blurfinder'), await user('blurrival')];
  for (const level of [1, 4, 5]) await ok('/api/eggs', { name: 'sticker', stationId: 'test-blur', level, image: IMG }, hider);
  const slots = (await ok('/api/stations/test-blur', null, finder)).slots;
  const pixels = async (url) => sharp(Buffer.from(await (await fetch(base + url)).arrayBuffer())).resize(64, 48).raw().toBuffer();
  const sharpPx = await sharp(IMG_BUF).resize(64, 48).raw().toBuffer();
  // Mean absolute pixel difference from the original: 0 = identical.
  const diffFrom = (px) => px.reduce((sum, v, i) => sum + Math.abs(v - sharpPx[i]), 0) / px.length;

  const rounds = {};
  for (const level of [1, 4, 5]) {
    const egg = slots.find((s) => s.level === level).egg;
    rounds[level] = await ok('/api/attempts', { eggId: egg.id }, finder);
    assert.equal(rounds[level].attempt.limitSeconds, { 1: 180, 4: 180, 5: 60 }[level], `level ${level} timer`);
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
  assert.equal((await call('/api/eggs', { name: 'sticker', stationId: 'test-blur', level: 4, image: junk }, hider)).status, 400);
});

test('station list: egg count at every station, what each player can still find, totals', async () => {
  const [ann, bo, cy] = [await user('countann'), await user('countbo'), await user('countcy')];
  await ok('/api/eggs', { name: 'sticker', stationId: 'test-count', level: 1, image: IMG }, ann);
  await ok('/api/eggs', { name: 'sticker', stationId: 'test-count', level: 2, image: IMG }, ann);
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
  assert.equal((await call('/api/eggs', { name: 'sticker', stationId: 'place-kencl', level: 1, image: 'data:text/html;base64,AAAA' }, lee)).status, 400);
  assert.equal((await call('/api/eggs', { name: 'sticker', stationId: 'nope', level: 1, image: IMG }, lee)).status, 404);
  assert.equal((await call('/api/eggs', { name: 'sticker', stationId: 'place-kencl', level: 9, image: IMG }, lee)).status, 400, 'unknown level');
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
  await ok('/api/eggs', { name: 'sticker', stationId: 'test-green', level: 5, image: IMG }, quin);
  await ok('/api/eggs', { name: 'sticker', stationId: 'test-redgreen', level: 5, image: IMG }, quin);
  const ken = (await ok('/api/stations/test-green')).slots[4].egg.id;
  const pk = (await ok('/api/stations/test-redgreen')).slots[4].egg.id;

  const r1 = await ok('/api/attempts', { eggId: ken, mode: 'fixed' }, rae);
  clock += 20_000;
  const f1 = await ok(`/api/attempts/${r1.attempt.id}/find`, { image: IMG }, rae);
  assert.equal(f1.firstFind, true, 'first to find this egg');

  const r2 = await ok('/api/attempts', { eggId: pk }, rae);
  clock += 60_000;
  await ok(`/api/attempts/${r2.attempt.id}/find`, { image: IMG }, rae);

  const p = await ok('/api/me/progress', null, rae);
  const earned = new Set(p.stamps.filter((s) => s.earned).map((s) => s.id));
  for (const id of ['first_find', 'transfer', 'first_to_find', 'speedy', 'impossible']) {
    assert.ok(earned.has(id), `${id} should be earned`);
  }
  assert.equal(earned.has('all_lines'), false);
  assert.equal(p.stamps.find((s) => s.id === 'all_lines').progress, 2, 'Red and Green');
  assert.equal(p.stations.length, 2);
  assert.deepEqual(p.lines.find((l) => l.line === 'Green'), { line: 'Green', stations: 2 });
  assert.deepEqual(p.lines.find((l) => l.line === 'Red'), { line: 'Red', stations: 1 });
  assert.deepEqual(new Set(p.today.lines), new Set(['Green', 'Red']));
  // Impossible has a 1-minute timer: 60 + 20 bonus (20 s of 60) at Kenmore, 60 + 0 bonus (all 60 s used) = 140 -> level 2 (50 to 150)
  assert.equal(p.level.points, 140);
  assert.deepEqual([p.level.level, p.level.floor, p.level.next], [2, 50, 150]);
  assert.ok(['transfer', 'climber', 'triple'].includes(p.today.id));
  assert.equal(p.stamps.some((st) => st.id === 'beat_train'), false, 'no train stamp');
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
  const { egg } = await ok('/api/eggs', { name: 'sticker', stationId: st.id, level: 2, image: IMG, hint: 'by the map' }, cy);
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
  const { egg } = await ok('/api/eggs', { name: 'sticker', stationId: 'test-activity', level: 3, image: IMG, hint: 'under the clock' }, eve);
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

test('one clock per egg: coming back resumes it; a retry after a miss gets a fresh clock but no time bonus', async () => {
  const [hid, sam, pal] = [await user('clockhider'), await user('clocksam'), await user('clockpal')];
  await ok('/api/eggs', { name: 'sticker', stationId: 'test-clock', level: 3, image: IMG }, hid);
  const eggId = (await ok('/api/stations/test-clock')).slots[2].egg.id;

  const first = await ok('/api/attempts', { eggId, mode: 'fixed' }, sam);
  assert.deepEqual([first.attempt.secondsLeft, first.attempt.resumed, first.attempt.retry], [120, false, false], 'Hard: 2 minutes');

  // sam leaves for 70 s and comes back: same round, 50 s left, not a fresh 2 minutes.
  clock += 70_000;
  assert.deepEqual((await ok('/api/stations/test-clock', null, sam)).slots[2].egg.clock, { secondsLeft: 50 });
  assert.equal((await ok('/api/stations/test-clock', null, pal)).slots[2].egg.clock, null, "pal's clock hasn't started");
  const back = await ok('/api/attempts', { eggId }, sam);
  assert.equal(back.attempt.id, first.attempt.id, 'resumed, not restarted');
  assert.deepEqual([back.attempt.secondsLeft, back.attempt.resumed], [50, true]);
  assert.equal(await db.col.attempts.countDocuments({ userId: sam.id, eggId }), 1);

  // Two taps (or two phones) at once open one clock, not two.
  const [p1, p2] = await Promise.all([ok('/api/attempts', { eggId }, pal), ok('/api/attempts', { eggId }, pal)]);
  assert.equal(p1.attempt.id, p2.attempt.id);
  assert.equal(await db.col.attempts.countDocuments({ userId: pal.id, eggId }), 1);

  // sam's time and the upload grace run out. The station now offers sam a retry.
  clock += (50 + 16) * 1000;
  const view = (await ok('/api/stations/test-clock', null, sam)).slots[2].egg;
  assert.deepEqual([view.clock, view.retry], [null, true]);
  assert.equal((await ok('/api/stations/test-clock', null, pal)).slots[2].egg.retry, false, "pal's clock is still running");
  const end = await ok(`/api/attempts/${first.attempt.id}/end`, {}, sam);
  assert.equal(end.status, 'expired');
  assert.equal((await call(`/api/attempts/${first.attempt.id}/find`, { image: IMG }, sam)).status, 409);

  // Retry straight away: a fresh clock, marked as a retry.
  const retry = await ok('/api/attempts', { eggId }, sam);
  assert.notEqual(retry.attempt.id, first.attempt.id);
  assert.deepEqual([retry.attempt.secondsLeft, retry.attempt.resumed, retry.attempt.retry], [120, false, true]);

  // Giving up ends that round; sam can retry again at once.
  assert.equal((await call(`/api/attempts/${retry.attempt.id}/end`, {}, hid)).status, 403, 'not your round');
  assert.equal((await ok(`/api/attempts/${retry.attempt.id}/end`, {}, sam)).status, 'given_up');
  assert.equal((await call(`/api/attempts/${retry.attempt.id}/find`, { image: IMG }, sam)).status, 409, 'a given-up round cannot score');
  const again = await ok('/api/attempts', { eggId }, sam);
  assert.equal(again.attempt.retry, true);

  // A find on a retry scores base points but no time bonus, however fast it is.
  clock += 20_000;
  const found = await ok(`/api/attempts/${again.attempt.id}/find`, { image: IMG }, sam);
  assert.deepEqual(found.points, { base: 30, bonus: 0, total: 30 });
  const stamps = (await ok('/api/me/progress', null, sam)).stamps;
  assert.equal(stamps.find((s) => s.id === 'speedy').earned, false, 'a 20 s find on a retry is not a speed stamp');
  assert.equal(stamps.find((s) => s.id === 'first_find').earned, true);
});

test('leaderboard: this month or all time', async () => {
  const [old, now_] = [await user('lb_old'), await user('lb_new')];
  // lb_old scores 10 this month, then the month rolls over and lb_new scores 10 too.
  await db.col.finds.insertOne({ _id: 'lb-old-find', userId: old.id, eggId: 'lb-egg-1', stationId: 'test-count', level: 1, points: 500, month: '2001-01', foundAt: new Date('2001-01-15') });
  await db.col.finds.insertOne({ _id: 'lb-new-find', userId: now_.id, eggId: 'lb-egg-2', stationId: 'test-count', level: 1, points: 400, month: '2001-02', foundAt: new Date('2001-02-15') });
  const month = await ok('/api/leaderboard?month=2001-02');
  assert.deepEqual([month.period, month.month, month.rows.map((r) => r.username)], ['month', '2001-02', ['lb_new']]);
  const all = await ok('/api/leaderboard?period=all');
  assert.deepEqual([all.period, all.month], ['all', null]);
  assert.deepEqual(all.rows.slice(0, 2).map((r) => [r.username, r.points, r.rank]), [['lb_old', 500, 1], ['lb_new', 400, 2]]);
  const station = await ok('/api/leaderboard?period=all&stationId=test-count');
  assert.ok(station.rows.some((r) => r.username === 'lb_old'), 'all time works per station too');
});

test('map: per-station stats, keeper and hunting now; lines and trains degrade to empty without the MBTA', async () => {
  const sal = await user('sal');
  const tia = await user('tia');
  await ok('/api/eggs', { name: 'sticker', stationId: 'test-map', level: 3, image: IMG }, sal);
  const eggId = (await ok('/api/stations/test-map')).slots[2].egg.id;

  // tia starts a round: she's hunting there now, then finds it.
  const round = await ok('/api/attempts', { eggId }, tia);
  let m = await ok('/api/map/stations', null, tia);
  let ken = m.stations.find((s) => s.id === 'test-map');
  assert.ok(ken.huntingNow >= 1, 'a round started just now counts as hunting');
  clock += 30_000;
  await ok(`/api/attempts/${round.attempt.id}/find`, { image: IMG }, tia);

  m = await ok('/api/map/stations', null, tia);
  ken = m.stations.find((s) => s.id === 'test-map');
  assert.equal(ken.yourFinds, 1);
  assert.ok(ken.findsThisMonth >= 1);
  assert.ok(ken.keeper && typeof ken.keeper.username === 'string');
  assert.equal(m.stations.length, STATIONS.length, 'one row per station');

  const anon = await ok('/api/map/stations');
  assert.equal(anon.stations.find((s) => s.id === 'test-map').yourFinds, 0, 'no player, no personal count');

  clock += 16 * 60_000; // past the 15-minute window
  m = await ok('/api/map/stations');
  assert.equal(m.stations.find((s) => s.id === 'test-map').huntingNow, 0);

  // The fake MBTA has no shapes or vehicles: the endpoints answer with empty lists instead of failing.
  assert.deepEqual(await ok('/api/map/lines'), { lines: [] });
  assert.deepEqual((await ok('/api/map/vehicles')).vehicles, []);
});

test('train lobbies: verified riders join one lobby per journey, everyone pledges 100 pts of eggs, helpers donate', async () => {
  const at = (lat, lng = -71.1) => ({ lat, lng, accuracy: 20 });
  const train = (tripId, lat, lng = -71.1) => ({ id: `v-${tripId}`, tripId, routeId: 'Green-B', line: 'Green Line', headsign: 'Boston College', lat, lng });
  const check = (who, fix) => ok('/api/trains/check', fix, who);
  const [ann, ben, cat] = [await user('ride_ann'), await user('ride_ben'), await user('ride_cat')];
  // Found eggs, by level (worth 10/20/30/40/60): ann 2 Impossible + 1 Medium + 2 Easy = 160,
  // ben 3 Hard + 1 Easy + 1 Medium = 120, cat 1 Medium = 20.
  let fid = 0;
  const found = (u, levels) => db.col.finds.insertMany(levels.map((level) => ({ _id: `rf-${++fid}`, userId: u.id, eggId: `re-${fid}`, stationId: 'test-map', level, points: 10, month: '2001-01', foundAt: new Date(Date.UTC(2001, 0, 1, 0, fid)) })));
  await found(ann, [5, 5, 2, 1, 1]);
  await found(ben, [3, 3, 3, 1, 2]);
  await found(cat, [2]);

  // First fix next to the train: seen, not yet verified.
  fakeVehicles = [train('trip-1', 42.35)];
  let r = await check(ann, at(42.3501));
  assert.deepEqual([r.onTrain.tripId, r.onTrain.verified, r.onTrain.lobby], ['trip-1', false, null]);
  assert.equal((await call('/api/trains/lobby', { tripId: 'trip-1' }, ann)).status, 403, 'not verified yet');
  await check(ben, at(42.3501)); // ben is on the platform...
  await check(cat, at(42.3501));
  assert.equal((await check(ann, at(42.40))).onTrain, null, 'far from every train');

  // 30 s later the train has moved ~330 m. ann and cat moved with it; ben stayed on the platform.
  clock += 30_000;
  fakeVehicles = [train('trip-1', 42.353)];
  assert.equal((await check(ann, at(42.3531))).onTrain.verified, true);
  assert.equal((await check(cat, at(42.3529))).onTrain.verified, true);
  assert.equal((await check(ben, at(42.3502))).onTrain, null, 'standing still while the train leaves is not riding');
  assert.equal((await call('/api/trains/lobby', {}, ben)).status, 403);
  // ann's GPS drops out (a tunnel): she stays verified on that train for a while.
  const tunnel = await check(ann, at(42.30));
  assert.deepEqual([tunnel.onTrain.tripId, tunnel.onTrain.verified], ['trip-1', true]);

  // ann opens the lobby; cat joins the same one (one lobby per journey).
  const { lobby } = await ok('/api/trains/lobby', { tripId: 'trip-1' }, ann);
  assert.deepEqual([lobby.riders, lobby.target, lobby.yourPledged, lobby.stash.points, lobby.status], [1, 100, 0, 160, 'open']);
  assert.equal(lobby.stash.levels.find((l) => l.name === 'Impossible').count, 2);
  assert.equal((await ok('/api/trains/lobby', {}, cat)).lobby.id, lobby.id);
  assert.equal((await ok('/api/trains/lobby', {}, cat)).lobby.riders, 2, 'joining twice counts once');
  assert.equal((await call(`/api/lobbies/${lobby.id}`, null, ben)).status, 403, 'members only');

  // ben gets on at the next stop and rides along: verified, joins.
  clock += 30_000;
  fakeVehicles = [train('trip-1', 42.356)];
  await check(ben, at(42.356));
  clock += 30_000;
  fakeVehicles = [train('trip-1', 42.36)];
  assert.equal((await check(ben, at(42.3601))).onTrain.verified, true);
  await ok('/api/trains/lobby', {}, ben);
  const L = `/api/lobbies/${lobby.id}`;
  const riders = (await ok(L, null, ann)).lobby.ridersList;
  const byName = (rows) => rows.map((r) => [r.name, r.you, r.need]).sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(byName(riders), byName([{ name: ann.chatName, you: true, need: 100 }, { name: cat.chatName, you: false, need: 100 }, { name: ben.chatName, you: false, need: 100 }]));
  assert.equal(JSON.stringify(riders).includes(cat.id), false, 'riders by chat name and lobby id only');
  const riderId = (u) => riders.find((r) => r.name === u.chatName).id;

  // Each rider needs 100 pts in their name. Eggs count their level's points.
  assert.equal((await call(`${L}/pledge`, { eggs: { 1: 1 } }, cat)).status, 400, 'cat has no Easy eggs');
  assert.equal((await call(`${L}/pledge`, { eggs: {} }, cat)).status, 400);
  let p = await ok(`${L}/pledge`, { eggs: { 2: 1 } }, cat);
  assert.deepEqual([p.points, p.donated, p.reached, p.lobby.yourPledged, p.lobby.stash.points], [20, false, false, 20, 0]);
  // cat asks for help: a help request lands in the chat.
  const ask = await ok(`${L}/help`, {}, cat);
  assert.deepEqual(ask.message.help, { riderId: riderId(cat), need: 80 });
  assert.equal((await call(`${L}/help`, {}, cat)).status, 429, 'one ask a minute');
  // ann fills her own 100, then donates an Impossible to cat.
  p = await ok(`${L}/pledge`, { eggs: { 5: 1, 1: 2 } }, ann);
  assert.equal(p.lobby.yourPledged, 80);
  p = await ok(`${L}/pledge`, { eggs: { 2: 1 } }, ann);
  assert.equal(p.lobby.yourPledged, 100);
  assert.equal((await call(`${L}/pledge`, { eggs: { 5: 1 } }, ann)).status, 409, 'already at 100');
  p = await ok(`${L}/pledge`, { eggs: { 5: 1 }, for: riderId(cat) }, ann);
  assert.deepEqual([p.points, p.donated, p.lobby.ridersList.find((r) => r.name === cat.chatName).pledged], [60, true, 80]);
  // An egg is pledged once, ever: ann has nothing left.
  assert.equal((await call(`${L}/pledge`, { eggs: { 5: 1 }, for: riderId(ben) }, ann)).status, 400);
  assert.equal((await call(`${L}/pledge`, { eggs: { 1: 1 }, for: 'not-a-rider' }, ben)).status, 404);
  // ben fills his own and gives cat the last 20: every rider at 100 -> goal reached.
  p = await ok(`${L}/pledge`, { eggs: { 3: 3, 1: 1 } }, ben);
  assert.equal(p.reached, false, 'cat is still short');
  p = await ok(`${L}/pledge`, { eggs: { 2: 1 }, for: riderId(cat) }, ben);
  assert.deepEqual([p.reached, p.lobby.status, p.lobby.atTarget], [true, 'reached', 3]);
  assert.equal((await call(`${L}/pledge`, { eggs: { 1: 1 } }, ben)).status, 409, 'goal already reached');
  // Every rider +50; donors +10 per egg they gave someone else.
  const bonus = async (u) => (await db.col.payouts.find({ userId: u.id, kind: { $in: ['lobby', 'lobby_donor'] } }).toArray()).reduce((n, x) => n + x.points, 0);
  assert.deepEqual([await bonus(ann), await bonus(ben), await bonus(cat)], [60, 60, 50]);
  const annProfile = await ok(`/api/users/${ann.id}`, null, ann);
  assert.equal(annProfile.lobbyPoints, 60);
  assert.equal(annProfile.findsByLevel.Impossible, 2, 'pledged eggs stay in the collection');
  assert.equal(await db.col.finds.countDocuments({ userId: ann.id, pledgedIn: lobby.id }), 5, 'every egg ann used is marked pledged');

  // Lobby bonuses count on the leaderboard, the profile and rider level. Old payouts from the
  // removed bounty system don't.
  const findPoints = (await db.col.finds.find({ userId: ann.id }).toArray()).reduce((n, f) => n + f.points, 0);
  const annTotals = async () => [
    (await ok('/api/leaderboard?period=all')).rows.find((r) => r.userId === ann.id)?.points,
    (await ok(`/api/users/${ann.id}`, null, ann)).allTimePoints,
    (await ok('/api/me/progress', null, ann)).level.points,
  ];
  const withBonus = findPoints + 60;
  assert.deepEqual(await annTotals(), [withBonus, withBonus, withBonus]);
  await db.col.payouts.insertOne({ _id: 'legacy-bounty-payout', userId: ann.id, kind: 'bounty', stationId: null, month: null, points: 99, createdAt: new Date(clock) });
  assert.deepEqual(await annTotals(), [withBonus, withBonus, withBonus], 'a leftover bounty payout scores nothing');

  // Anonymous chat: stickers and short text, filtered, reportable.
  const chat = `${L}/messages`;
  const hello = await ok(chat, { text: '  hi   train friends ' }, ann);
  assert.deepEqual([hello.message.text, hello.message.name, hello.message.mine], ['hi train friends', ann.chatName, true]);
  await ok(chat, { sticker: 'crown' }, cat);
  assert.equal((await call(chat, { text: 'visit www.spam.com' }, cat)).status, 400, 'no links');
  assert.equal((await call(chat, { text: 'you are a b.i.t.c.h' }, cat)).status, 400, 'word filter');
  assert.equal((await call(chat, { text: 'x'.repeat(141) }, cat)).status, 400, 'too long');
  assert.equal((await call(chat, { text: '' }, cat)).status, 400);
  const seen = await ok(chat, null, ben);
  assert.deepEqual(seen.messages.map((m) => m.text ?? m.emoji ?? (m.help && `needs ${m.help.need}`)), ['needs 80', 'hi train friends', '👑']);
  assert.equal(JSON.stringify(seen).includes(ann.id) || JSON.stringify(seen).includes('ride_ann'), false, 'anonymous');
  assert.equal((await call(`${chat}/${hello.message.id}/report`, {}, ann)).status, 400, "can't report yourself");
  await ok(`${chat}/${hello.message.id}/report`, {}, ben);
  assert.equal((await ok(chat, null, ben)).messages.length, 2, 'hidden for the reporter at once');
  assert.equal((await ok(chat, null, cat)).messages.length, 3, 'still shown to others below the threshold');

  // The journey ends (the trip leaves the live feed): the lobby ends. A second trip is a new lobby.
  clock += 30_000;
  fakeVehicles = [train('trip-2', 42.37)];
  await check(cat, at(42.37));
  clock += 30_000;
  fakeVehicles = [train('trip-2', 42.374)];
  assert.equal((await check(cat, at(42.374))).onTrain.verified, true);
  const second = (await ok('/api/trains/lobby', {}, cat)).lobby;
  assert.notEqual(second.id, lobby.id, 'one lobby per journey');
  await found(cat, [4, 5, 5]);
  const solo = await ok(`/api/lobbies/${second.id}/pledge`, { eggs: { 4: 1, 5: 2 } }, cat);
  assert.deepEqual([solo.points, solo.reached], [160, false], 'one rider alone never reaches the goal');
  assert.equal((await ok(`/api/lobbies/${second.id}`, null, cat)).lobby.stash.points, 0);
  clock += 4 * 60_000;
  fakeVehicles = [];
  const ended = (await ok(`/api/lobbies/${second.id}`, null, cat)).lobby;
  assert.deepEqual([ended.status, ended.outcome, ended.stash.points], ['ended', 'missed', 0], 'missed goal: pledged eggs stay pledged');
  assert.equal((await ok(`/api/users/${cat.id}`, null, cat)).findsByLevel.Extreme, 1, 'but stay in the collection');
  assert.equal((await call(`/api/lobbies/${second.id}/messages`, { sticker: 'wave' }, cat)).status, 409);
  assert.equal((await ok(L, null, ann)).lobby.outcome, 'reached');
  fakeVehicles = [];
});

test('admin seed endpoint is off unless a token is configured', async () => {
  assert.equal((await call('/api/admin/seed', {}, null, { 'x-seed-token': 'x'.repeat(32) })).status, 404);
});

test('train simulation: off by default; when on, puts a player on a live train for the real lobby flow', async () => {
  const sim = await user('sim_rider');
  assert.equal((await call('/api/trains/simulate', {}, sim)).status, 404, 'off unless enabled');
  assert.equal((await ok('/api/config')).trainSim, false);
  // A tester account may simulate even with it off, and only sees its own flag.
  await db.col.users.updateOne({ _id: sim.id }, { $set: { tester: true } });
  assert.equal((await ok('/api/auth/me', null, sim)).user.tester, true);
  fakeVehicles = [{ id: 'v-sim', tripId: 'trip-sim', routeId: 'Red', line: 'Red Line', headsign: 'Ashmont', status: 'IN_TRANSIT_TO', lat: 42.35, lng: -71.06 }];
  const r = await ok('/api/trains/simulate', { lat: 42.35, lng: -71.06 }, sim);
  assert.deepEqual([r.onTrain.tripId, r.onTrain.verified], ['trip-sim', true]);
  assert.equal((await ok('/api/trains/lobby', {}, sim)).lobby.riders, 1, 'then the real lobby flow');
  assert.equal('tester' in (await ok(`/api/users/${sim.id}`, null, await user('sim_other'))).user, false);
  // A second tester simulating from somewhere else lands on the same train, in the same lobby.
  const sim2 = await user('sim_rider_2');
  await db.col.users.updateOne({ _id: sim2.id }, { $set: { tester: true } });
  fakeVehicles.push({ id: 'v-far', tripId: 'trip-far', routeId: 'Blue', line: 'Blue Line', headsign: 'Wonderland', status: 'IN_TRANSIT_TO', lat: 42.41, lng: -70.99 });
  const r2 = await ok('/api/trains/simulate', { lat: 42.41, lng: -70.99 }, sim2);
  assert.deepEqual([r2.onTrain.tripId, r2.onTrain.sharedLobby], ['trip-sim', true]);
  const l2 = (await ok('/api/trains/lobby', {}, sim2)).lobby;
  assert.equal(l2.riders, 2, 'both testers in one lobby');
  fakeVehicles = [];
});

test('email: required at sign-up, unique, private, usable to sign in, and addable later', async () => {
  const reg = (body) => call('/api/auth/register', { password: PW, ...body });
  assert.equal((await reg({ username: 'em_a' })).status, 400, 'no email');
  assert.equal((await reg({ username: 'em_a', email: 'not-an-email' })).status, 400);
  const a = await ok('/api/auth/register', { username: 'em_a', password: PW, email: 'Em.A@Example.com' });
  assert.equal(a.user.email, 'Em.A@Example.com');
  assert.equal((await reg({ username: 'em_b', email: 'em.a@example.com' })).status, 409, 'one account per email');

  // Sign in with the email instead of the username (any case).
  assert.equal((await ok('/api/auth/login', { username: 'EM.A@example.com', password: PW })).user.username, 'em_a');
  assert.equal((await call('/api/auth/login', { username: 'em.a@example.com', password: 'wrong password' })).status, 401);

  // Other players never see it.
  const b = await user('em_viewer');
  const seen = await ok(`/api/users/${a.user.id}`, null, b);
  assert.equal('email' in seen.user, false);

  // An older account without an email adds one; it can't take someone else's.
  const legacy = await user('em_legacy');
  await db.col.users.updateOne({ _id: legacy.id }, { $unset: { email: 1, emailLower: 1 } });
  assert.equal((await ok('/api/auth/me', null, legacy)).user.email, null);
  assert.equal((await call('/api/me/email', { email: 'em.a@example.com' }, legacy)).status, 409);
  assert.equal((await ok('/api/me/email', { email: 'legacy@example.com' }, legacy)).user.email, 'legacy@example.com');
  assert.equal((await ok('/api/auth/me', null, legacy)).user.email, 'legacy@example.com');
});

test('photo screen: a rejected egg photo is never hidden, and the player is told why', async () => {
  const hider = await user('screen_hider');
  const hide = () => call('/api/eggs', { name: 'sticker', stationId: 'test-screen', level: 1, image: IMG }, hider);
  const before = await db.col.eggs.countDocuments({ stationId: 'test-screen' });

  for (const [problem, status, words] of [['face', 422, /face/], ['too_plain', 422, /too plain/], ['no_object', 422, /nothing specific/], ['unavailable', 503, /unavailable/]]) {
    const { SCREEN_MESSAGES } = await import('../src/verify.js');
    nextScreen = { ok: false, method: 'gemini', problem, message: SCREEN_MESSAGES[problem] ?? 'The photo check is unavailable right now. Try again in a moment.' };
    const r = await hide();
    assert.equal(r.status, status, problem);
    assert.match(r.data.error, words);
  }
  assert.equal(await db.col.eggs.countDocuments({ stationId: 'test-screen' }), before, 'nothing saved');

  // A good photo goes through; the screen saw the uploaded image.
  nextScreen = { ok: true, method: 'gemini', subject: 'a red sticker' };
  const n = screened.length;
  assert.equal((await hide()).status, 200);
  assert.equal(screened.length, n + 1);
  assert.ok(Buffer.isBuffer(screened.at(-1).jpeg));
  // A slot that's already taken is refused before spending a Gemini call.
  assert.equal((await hide()).status, 409);
  assert.equal(screened.length, n + 1);
});

test('egg name: required, passed to the photo screen, rejected when it does not match, shown to finders', async () => {
  const [hider, finder] = [await user('name_hider'), await user('name_finder')];
  const hide = (body) => call('/api/eggs', { stationId: 'test-screen', level: 2, image: IMG, ...body }, hider);
  assert.equal((await hide({})).status, 400, 'no name');
  assert.equal((await hide({ name: 'x' })).status, 400, 'too short');
  assert.equal((await hide({ name: 'a'.repeat(41) })).status, 400, 'too long');

  nextScreen = { ok: false, method: 'gemini', problem: 'name_mismatch', message: 'That doesn\'t look like "bench". It looks like a red sticker. Change what you typed, or retake the photo.' };
  const bad = await hide({ name: 'bench' });
  assert.equal(bad.status, 422);
  assert.match(bad.data.error, /doesn't look like "bench"/);
  assert.equal(screened.at(-1).name, 'bench', 'the screen saw what they typed');

  nextScreen = { ok: true, method: 'gemini', subject: 'a red sticker' };
  await ok('/api/eggs', { stationId: 'test-screen', level: 2, image: IMG, name: '  red   sticker ' }, hider);
  const egg = (await ok('/api/stations/test-screen', null, finder)).slots[1].egg;
  const round = await ok('/api/attempts', { eggId: egg.id }, finder);
  assert.equal(round.egg.name, 'red sticker', 'finders see what it is');
});
