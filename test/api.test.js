import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';

const STATIONS = [
  { id: 'place-kencl', name: 'Kenmore', lat: 42.3489, lng: -71.0952, lines: [{ id: 'Green-B', name: 'Green Line B', color: '#00843D' }] },
  { id: 'place-pktrm', name: 'Park Street', lat: 42.3564, lng: -71.0624, lines: [{ id: 'Red', name: 'Red Line', color: '#DA291C' }, { id: 'Green-B', name: 'Green Line B', color: '#00843D' }] },
];
const fakeMbta = {
  loadStations: async () => STATIONS,
  predictions: async () => [{ routeId: 'Green-B', line: 'Green Line B', color: '#00843D', headsign: 'Boston College', seconds: 240 }],
};
const IMG = `data:image/jpeg;base64,${Buffer.alloc(300, 7).toString('base64')}`;

let clock = Date.parse('2026-11-21T20:00:00Z');
let nextVerify = { method: 'gemini', match: true, confidence: 0.9, reason: 'Same sticker.' };
let server;
let base;
let dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egg-test-'));
  const app = await createApp({
    dataDir,
    mbta: fakeMbta,
    verify: async () => nextVerify,
    geminiKey: 'test',
    now: () => new Date(clock),
  });
  server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(p, body) {
  const res = await fetch(base + p, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const ok = async (p, body) => {
  const r = await call(p, body);
  assert.equal(r.status, 200, `${p} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};
const user = async (name) => (await ok('/api/users', { username: name })).user;

test('full round: hide, find, hide next, leaderboard', async () => {
  const ana = await user('ana');
  const ben = await user('ben');
  assert.equal((await call('/api/users', { username: 'ANA' })).status, 409);

  await ok('/api/eggs', { userId: ana.id, stationId: 'place-kencl', level: 2, image: IMG, hint: 'by the stairs' });
  assert.equal((await call('/api/eggs', { userId: ana.id, stationId: 'place-kencl', level: 2, image: IMG })).status, 409, 'slot is taken');

  const st = await ok(`/api/stations/place-kencl?userId=${ben.id}`);
  const egg = st.slots.find((s) => s.level === 2).egg;
  assert.ok(egg && !egg.mine && !egg.foundByMe);
  assert.equal(st.slots.filter((s) => s.egg).length, 1);

  assert.equal((await call('/api/attempts', { userId: ana.id, eggId: egg.id })).status, 403, 'cannot play own egg');

  const round = await ok('/api/attempts', { userId: ben.id, eggId: egg.id, mode: 'fixed' });
  assert.equal(round.attempt.limitSeconds, 180);
  assert.equal(round.egg.hint, 'by the stairs');

  clock += 60_000; // 60s of 180s used -> 2/3 left -> bonus round(20*0.5*2/3)=7
  const found = await ok(`/api/attempts/${round.attempt.id}/find`, { userId: ben.id, image: IMG });
  assert.equal(found.status, 'found');
  assert.deepEqual(found.points, { base: 20, bonus: 7, total: 27 });

  assert.equal((await call('/api/attempts', { userId: ben.id, eggId: egg.id })).status, 409, 'no double finds');
  assert.equal((await call(`/api/attempts/${round.attempt.id}/find`, { userId: ben.id, image: IMG })).status, 409);

  // Hide-next must match the station and level of the find.
  assert.equal((await call('/api/eggs', { userId: ben.id, stationId: 'place-kencl', level: 3, findId: found.findId, image: IMG })).status, 400);
  await ok('/api/eggs', { userId: ben.id, stationId: 'place-kencl', level: 2, findId: found.findId, image: IMG });
  assert.equal((await call('/api/eggs', { userId: ben.id, stationId: 'place-kencl', level: 2, findId: found.findId, image: IMG })).status, 409, 'one hide per find');

  const after = await ok(`/api/stations/place-kencl?userId=${ana.id}`);
  const newEgg = after.slots.find((s) => s.level === 2).egg;
  assert.notEqual(newEgg.id, egg.id, "ben's egg replaced ana's");
  assert.equal(newEgg.createdBy, 'ben');

  const board = await ok('/api/leaderboard');
  assert.equal(board.rows[0].username, 'ben');
  assert.equal(board.rows[0].points, 27);
  assert.deepEqual(board.lines, [{ line: 'Green', points: 27 }]);

  const profile = await ok(`/api/users/${ben.id}`);
  assert.equal(profile.monthPoints, 27);
  assert.equal(profile.findsByLevel.Medium, 1);
  assert.equal(profile.eggsHidden, 1);
  assert.equal(profile.monthRank, 1);
  const anaProfile = await ok(`/api/users/${ana.id}`);
  assert.equal(anaProfile.timesYourEggsWereFound, 1);

  const stations = await ok('/api/stations');
  assert.equal(stations.stations.find((s) => s.id === 'place-kencl').activeEggs, 1);
});

test('no match keeps the round open; time runs out', async () => {
  const cat = await user('cat');
  const dan = await user('dan');
  await ok('/api/eggs', { userId: cat.id, stationId: 'place-pktrm', level: 1, image: IMG });
  const eggId = (await ok('/api/stations/place-pktrm')).slots[0].egg.id;
  const round = await ok('/api/attempts', { userId: dan.id, eggId });

  nextVerify = { method: 'gemini', match: false, confidence: 0.2, reason: 'Different sign.' };
  const miss = await ok(`/api/attempts/${round.attempt.id}/find`, { userId: dan.id, image: IMG });
  assert.equal(miss.status, 'no_match');
  nextVerify = { method: 'gemini', match: true, confidence: 0.9, reason: 'ok' };

  clock += (120 + 16) * 1000; // past limit + grace
  const late = await ok(`/api/attempts/${round.attempt.id}/find`, { userId: dan.id, image: IMG });
  assert.equal(late.status, 'expired');
});

test('race-the-train timer uses the next train', async () => {
  const eve = await user('eve');
  const fay = await user('fay');
  await ok('/api/eggs', { userId: eve.id, stationId: 'place-pktrm', level: 4, image: IMG });
  const eggId = (await ok('/api/stations/place-pktrm')).slots[3].egg.id;
  const round = await ok('/api/attempts', { userId: fay.id, eggId, mode: 'train' });
  assert.equal(round.attempt.limitSource, 'train');
  assert.equal(round.attempt.limitSeconds, 240);
});

test('three reports retire an egg and the pool refills the slot', async () => {
  const [gus, hal, ivy, jo] = [await user('gus'), await user('hal'), await user('ivy'), await user('jo')];
  await ok('/api/eggs', { userId: gus.id, stationId: 'place-pktrm', level: 3, image: IMG });
  const first = (await ok('/api/stations/place-pktrm')).slots[2].egg.id;
  // hal finds it and hides a new one, so the first egg goes to the pool.
  const r = await ok('/api/attempts', { userId: hal.id, eggId: first });
  const f = await ok(`/api/attempts/${r.attempt.id}/find`, { userId: hal.id, image: IMG });
  await ok('/api/eggs', { userId: hal.id, stationId: 'place-pktrm', level: 3, findId: f.findId, image: IMG });
  const second = (await ok('/api/stations/place-pktrm')).slots[2].egg.id;
  assert.notEqual(second, first);

  for (const u of [gus, ivy, ivy]) await ok(`/api/eggs/${second}/report`, { userId: u.id, reason: 'cant_find' });
  assert.equal((await ok('/api/stations/place-pktrm')).slots[2].egg.id, second, 'duplicate report from ivy not counted');
  const last = await ok(`/api/eggs/${second}/report`, { userId: jo.id, reason: 'unsafe' });
  assert.equal(last.retired, true);
  assert.equal((await ok('/api/stations/place-pktrm')).slots[2].egg.id, first, 'pool egg back in the slot');
});

test('unfound eggs retire after 7 days', async () => {
  const kim = await user('kim');
  await ok('/api/eggs', { userId: kim.id, stationId: 'place-kencl', level: 5, image: IMG });
  assert.ok((await ok('/api/stations/place-kencl')).slots[4].egg);
  clock += 8 * 86400_000;
  assert.equal((await ok('/api/stations/place-kencl')).slots[4].egg, null);
});

test('bad input and static files', async () => {
  assert.equal((await call('/api/users', { username: '<script>' })).status, 400);
  const lee = await user('lee');
  assert.equal((await call('/api/eggs', { userId: lee.id, stationId: 'place-kencl', level: 1, image: 'data:text/html;base64,AAAA' })).status, 400);
  assert.equal((await call('/api/eggs', { userId: lee.id, stationId: 'nope', level: 1, image: IMG })).status, 404);
  assert.equal((await call('/api/eggs', { userId: lee.id, stationId: 'place-kencl', level: 9, image: IMG })).status, 400, 'unknown level');
  assert.equal((await call('/api/attempts', { userId: 'ghost', eggId: 'x' })).status, 401);

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Station Egg Hunt/);
  assert.equal((await fetch(`${base}/..%2fserver.js`)).status, 404);
  assert.equal((await fetch(`${base}/photos/..%2f..%2fserver.js`)).status, 404);
});
