// End-to-end API tests against a real Postgres. Each run creates its own
// throwaway schema in TEST_DATABASE_URL (default: local egg_hunt_test) and drops it after.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DB_URL = process.env.TEST_DATABASE_URL || 'postgres://localhost:5432/egg_hunt_test';
const SCHEMA = `test_${crypto.randomBytes(4).toString('hex')}`;

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

before(async () => {
  const admin = new pg.Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`create schema ${SCHEMA}`);
  await admin.end();
  db = createDb({ connectionString: DB_URL, schema: SCHEMA, max: 5 });
  await db.migrate(path.join(ROOT, 'migrations'));
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
  await db?.query(`drop schema ${SCHEMA} cascade`);
  await db?.close();
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
  const { rows } = await db.query('select count(*)::int as n from finds where user_id = $1', [ned.id]);
  assert.equal(rows[0].n, 1);
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
