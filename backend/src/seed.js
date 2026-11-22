// Demo filler data, in batches. Each batch adds demo players, live eggs at stations spread over
// all four lines, past finds (so leaderboards, profiles and egg collections have something on
// them) and one friend group with chat. Every document is tagged `seed: true` and `seedBatch`,
// so removeSeed() takes all of it out again.
// Used by scripts/seed.js (CLI) and by POST /api/admin/seed (only when SEED_TOKEN is set).
import crypto from 'node:crypto';
import { scenePhoto, FIND_OBJECTS, nameFromHint } from './seedArt.js';
import * as game from './game.js';
import { hashPassword } from './auth.js';
import { blurredCopy } from './images.js';

// players: [username, chatName]
// eggs: [stationId, level, hint, background, egg colour]  (live, hidden by players in turn)
// finds: [player index, stationId, level, seconds taken]  (of older eggs, since retired)
// group.chat: [member index, sticker id] or [member index, null, text]
export const BATCHES = {
  1: {
    players: [
      ['maya_t', 'Sleepy Pigeon 14'],
      ['DevOnTheT', 'Swift Trolley 52'],
      ['kenmore_kid', 'Lucky Lantern 33'],
      ['redline_rae', 'Cosmic Otter 71'],
      ['jpark', 'Grumpy Signal 28'],
      ['sam_rides', 'Jolly Tunnel 90'],
    ],
    eggs: [
      ['place-pktrm', 1, 'Brass plaque by the Winter St stairs', '#e8d9b5', '#c94f3d'],
      ['place-pktrm', 3, 'Mosaic tile with a fish', '#cfe3d4', '#2f7d4f'],
      ['place-dwnxg', 2, 'Sticker on the Orange Line map', '#f6d7b0', '#e07b00'],
      ['place-harsq', 1, 'Painted handprint on the mural', '#f1d0cb', '#b3261e'],
      ['place-bbsta', 4, 'Scratched initials on a bench', '#e3d6f0', '#6d3fa0'],
      ['place-kencl', 2, 'Old fare sign above the busway', '#d5e7d0', '#1f7a3a'],
      ['place-mvbcl', 3, 'Clock face with a cracked numeral', '#dfe6f2', '#1f4e9c'],
      ['place-gover', 1, 'Blue line tile next to the elevator', '#d7e3f4', '#0b4ea2'],
      ['place-north', 5, 'Tiny bronze bear on a railing', '#ead9c6', '#7a4a1e'],
      ['place-aport', 2, 'Sticker of a cat on a pillar', '#f2dccf', '#c2410c'],
    ],
    finds: [
      [0, 'place-pktrm', 2, 41], [0, 'place-bbsta', 3, 95], [0, 'place-wondl', 1, 22],
      [1, 'place-dwnxg', 1, 30], [1, 'place-kencl', 4, 140],
      [2, 'place-kencl', 2, 64], [2, 'place-mvbcl', 1, 18], [2, 'place-gover', 3, 120],
      [3, 'place-pktrm', 1, 27], [4, 'place-jaksn', 2, 88], [5, 'place-harsq', 1, 51],
    ],
    group: { name: 'Green Line Gang', members: [0, 1, 2, 3], chat: [[0, 'crown'], [1, 'snail'], [2, 'fire'], [0, 'eyes'], [3, 'laugh']] },
  },
  2: {
    players: [
      ['nora.b', 'Witty Owl 47'],
      ['quincy_q', 'Mighty Caboose 63'],
      ['lena_on_orange', 'Bouncy Whistle 25'],
      ['theo', 'Stealthy Raccoon 81'],
      ['priya_k', 'Shiny Comet 19'],
      ['marco_blue', 'Dizzy Switch 56'],
    ],
    eggs: [
      ['place-alfcl', 2, 'Rusty bike rack by the north doors', '#e6dccc', '#8c5a2b'],
      ['place-davis', 3, 'Painted tile with a blue bird', '#dbe9f5', '#2b6cb0'],
      ['place-chmnl', 1, 'Sticker on the bridge railing', '#f5e1cf', '#d9480f'],
      ['place-jfk', 4, 'Etched number on a platform pillar', '#e9e1f3', '#5f3dc4'],
      ['place-ogmnl', 1, 'Graffiti smiley on the fare gate', '#fde8c8', '#e8590c'],
      ['place-rugg', 3, 'Mosaic map near the busway exit', '#e3f1e4', '#2b8a3e'],
      ['place-state', 5, 'Tiny brass key set into the floor', '#f1e6c9', '#a17a1d'],
      ['place-aqucl', 2, 'Fish decal on the station window', '#d7f0f5', '#0c8599'],
      ['place-bmmnl', 1, 'Seagull sticker on the bench', '#e7eef6', '#364fc7'],
      ['place-coecl', 4, 'Cast iron lamp detail by the stairs', '#e9e4dc', '#495057'],
      ['place-lech', 2, 'Painted pickle on the new wall', '#e2f2d5', '#5c940d'],
      ['place-haecl', 3, 'Vegetable stall sticker on a column', '#f8e3d6', '#c92a2a'],
    ],
    finds: [
      [0, 'place-portr', 3, 70], [0, 'place-sull', 2, 45], [0, 'place-boyls', 4, 150], [0, 'place-aqucl', 1, 25],
      [1, 'place-brdwy', 1, 33], [1, 'place-forhl', 5, 170],
      [2, 'place-rugg', 2, 52], [2, 'place-ogmnl', 3, 110], [2, 'place-state', 1, 19],
      [3, 'place-hymnl', 2, 61], [3, 'place-sdmnl', 4, 128],
      [4, 'place-prmnl', 1, 24], [4, 'place-river', 5, 165], [4, 'place-asmnl', 2, 77],
      [5, 'place-bmmnl', 3, 90], [5, 'place-chmnl', 1, 29],
    ],
    group: {
      name: 'Orange Line Hunters',
      members: [0, 2, 4, 5],
      chat: [[2, null, 'who found the State St key?? 👀'], [0, 'eyes'], [4, null, 'not me, still stuck on Ruggles 😩'], [5, 'trophy'], [2, 'fire'], [0, null, 'Forest Hills Impossible next 💪']],
    },
  },
  // Eggs only: 24 more live eggs, 6 per line, hidden by the demo players already in.
  3: {
    players: [],
    eggs: [
      ['place-portr', 1, 'Chipped tile next to the long escalator', '#f3dcd6', '#c92a2a'],
      ['place-knncl', 3, 'Kinetic sculpture handle on the platform', '#f8e0dc', '#a61e4d'],
      ['place-sstat', 2, 'Train-shaped sticker on a trash can', '#fde2e1', '#e03131'],
      ['place-cntsq', 4, 'Tiny painted mouse at the base of a column', '#f5dfe8', '#9c36b5'],
      ['place-andrw', 1, 'Faded "Andrew" mosaic letter A', '#ffe3e3', '#f03e3e'],
      ['place-qnctr', 5, 'Engraved granite block by the exit', '#eee1e1', '#862e2e'],
      ['place-sull', 2, 'Orange handprint on the overpass wall', '#ffe8cc', '#e8590c'],
      ['place-forhl', 1, 'Clock with a missing minute hand', '#fff0db', '#f08c00'],
      ['place-masta', 3, 'Jazz poster corner near the turnstiles', '#fde3c6', '#d9480f'],
      ['place-tumnl', 4, 'Small heart drawn on a railing', '#ffe6d5', '#c2410c'],
      ['place-chncl', 2, 'Red lantern sticker above the stairs', '#ffdcc2', '#e8590c'],
      ['place-welln', 5, 'Bronze plaque with a ship on it', '#f3e2cf', '#a35a00'],
      ['place-wondl', 2, 'Seashell glued to the beach-side sign', '#dbeafe', '#1c7ed6'],
      ['place-orhte', 1, 'Blue tile shaped like a wave', '#d0ebff', '#1971c2'],
      ['place-sdmnl', 3, 'Horseshoe painted on the fence', '#dfe9fb', '#364fc7'],
      ['place-wimnl', 4, 'Tree stencil on the platform shelter', '#d3f0f8', '#0b7285'],
      ['place-bomnl', 1, 'Old Bowdoin sign bolt with a smiley', '#e0ecfb', '#1864ab'],
      ['place-state', 3, 'Compass rose set into the floor', '#dce4fb', '#3b5bdb'],
      ['place-hymnl', 1, 'Music note sticker on the map board', '#d8f5dc', '#2f9e44'],
      ['place-prmnl', 3, 'Lego brick wedged in a bench gap', '#d3f9d8', '#37b24d'],
      ['place-boyls', 2, 'Historic tile with the year 1897', '#e6f4ea', '#2b8a3e'],
      ['place-symcl', 4, 'Violin doodle on the station wall', '#dff5e3', '#087f5b'],
      ['place-unsqu', 1, 'Painted fluff jar on a pillar', '#e3fae7', '#40c057'],
      ['place-mdftf', 5, 'Jumbo the elephant pin on a railing', '#e2f0d9', '#5c940d'],
    ],
    finds: [],
    group: null,
  },
};

const id = () => crypto.randomUUID();
const PALETTE = ['#c94f3d', '#e07b00', '#1f4e9c', '#2f7d4f', '#6d3fa0', '#0c8599', '#a17a1d', '#c2410c'];

async function savePhotoDoc(col, buf, tag, now) {
  const _id = id();
  await col.photos.insertOne({ _id, contentType: 'image/jpeg', data: buf, createdAt: now, ...tag });
  return _id;
}

// Redraws the pictures of every seeded egg (and the finds of retired ones) with the current
// art. New photo ids, because photos are served with an immutable cache header.
export async function refreshSeedPhotos(col, now = new Date()) {
  const colours = new Map();
  for (const b of Object.values(BATCHES)) for (const [st, lv, , , fg] of b.eggs) colours.set(`${st}:${lv}`, fg);
  const eggs = await col.eggs.find({ seed: true }).sort({ createdAt: 1 }).toArray();
  const old = [];
  let n = 0;
  for (const egg of eggs) {
    const tag = { seed: true, ...(egg.seedBatch && { seedBatch: egg.seedBatch }) };
    const hint = egg.hint ?? FIND_OBJECTS[n % FIND_OBJECTS.length];
    const colour = colours.get(`${egg.stationId}:${egg.level}`) ?? PALETTE[n % PALETTE.length];
    const key = `${egg.stationId}:${egg.level}:${n}`;
    n += 1;
    const buf = await scenePhoto({ hint, colour, key });
    const set = { photoId: await savePhotoDoc(col, buf, tag, now), ...(!egg.name && { name: nameFromHint(hint) }) };
    const sigma = game.levelInfo(egg.level).blur;
    if (egg.status !== 'retired' && sigma) set.displayPhotoId = await savePhotoDoc(col, await blurredCopy(buf, sigma), tag, now);
    old.push(egg.photoId, egg.displayPhotoId);
    await col.eggs.updateOne({ _id: egg._id }, { $set: set });
    for (const f of await col.finds.find({ eggId: egg._id, seed: true }).toArray()) {
      old.push(f.photoId);
      await col.finds.updateOne({ _id: f._id }, { $set: { photoId: await savePhotoDoc(col, await scenePhoto({ hint, colour, key, view: 1 }), tag, now) } });
    }
  }
  const removed = (await col.photos.deleteMany({ _id: { $in: old.filter(Boolean) }, seed: true })).deletedCount;
  return { eggs: eggs.length, oldPhotosRemoved: removed };
}

export async function removeSeed(col) {
  const out = {};
  for (const c of [col.users, col.photos, col.eggs, col.finds, col.groups, col.groupMembers, col.groupMessages]) {
    out[c.collectionName] = (await c.deleteMany({ seed: true })).deletedCount;
  }
  return out;
}

// Adds `batch`, or by default the first batch that isn't there yet. Returns counts,
// or { already: true } when every batch is already in.
export async function addSeed(col, now = new Date(), batch = null) {
  if (batch == null) {
    for (const b of Object.keys(BATCHES).map(Number)) {
      // Batch 1 predates the seedBatch tag: its documents only have seed: true.
      const there = await col.eggs.findOne(b === 1 ? { seed: true, $or: [{ seedBatch: 1 }, { seedBatch: { $exists: false } }] } : { seed: true, seedBatch: b });
      if (!there) {
        batch = b;
        break;
      }
    }
    if (batch == null) return { already: true };
  }
  const spec = BATCHES[batch] ?? (() => { throw new Error(`No seed batch ${batch}.`); })();
  const tag = { seed: true, seedBatch: batch };
  const ago = (min) => new Date(now.getTime() - min * 60_000);
  const log = { batch };

  const savePhoto = (buf) => savePhotoDoc(col, buf, tag, now);

  // Players (a name a real player already has is skipped). Random passwords: nobody can sign in.
  const players = [];
  for (const [i, [username, chatName]] of spec.players.entries()) {
    const taken = await col.users.findOne({ $or: [{ usernameLower: username.toLowerCase() }, { chatNameLower: chatName.toLowerCase() }, { usernameLower: chatName.toLowerCase() }] });
    if (taken) continue;
    const u = {
      _id: id(),
      username,
      usernameLower: username.toLowerCase(),
      chatName,
      chatNameLower: chatName.toLowerCase(),
      passwordHash: await hashPassword(crypto.randomBytes(24).toString('hex')),
      createdAt: ago(60 * 24 * (7 - i)),
      ...tag,
    };
    await col.users.insertOne(u);
    players.push(u);
  }
  // A batch with no players of its own uses the demo players already in the database.
  if (!spec.players.length) players.push(...(await col.users.find({ seed: true }).sort({ createdAt: 1 }).toArray()));
  if (players.length < 3) throw new Error(spec.players.length ? 'Not enough free demo usernames.' : 'Add the first seed batch before this one.');
  log.users = spec.players.length ? players.length : 0;
  const who = (i) => players[i % players.length];

  // Live eggs, only in empty slots.
  let placed = 0;
  for (const [n, [stationId, level, hint, bg, fg]] of spec.eggs.entries()) {
    if (await col.eggs.findOne({ stationId, level, status: 'active' })) continue;
    const buf = await scenePhoto({ hint, colour: fg, key: `${stationId}:${level}` });
    const photoId = await savePhoto(buf);
    const sigma = game.levelInfo(level).blur;
    const displayPhotoId = sigma ? await savePhoto(await blurredCopy(buf, sigma)) : null;
    const createdAt = ago(60 * (40 - n * 3));
    await col.eggs.insertOne({
      _id: id(),
      stationId,
      level,
      photoId,
      ...(displayPhotoId && { displayPhotoId }),
      hint,
      name: nameFromHint(hint), // what it is, shown to finders
      createdBy: who(n)._id,
      createdAt,
      status: 'active',
      activatedAt: createdAt,
      timesFound: 0,
      avgFindSeconds: null,
      ...tag,
    });
    placed += 1;
  }
  log.liveEggs = placed;

  // Past finds of older eggs that have since been retired, so no live egg is spoiled.
  const month = game.monthKey(now);
  for (const [n, [p, stationId, level, secondsTaken]] of spec.finds.entries()) {
    const finder = who(p);
    const hider = who(p + 1);
    const object = FIND_OBJECTS[n % FIND_OBJECTS.length];
    const colour = PALETTE[n % PALETTE.length];
    const eggPhotoId = await savePhoto(await scenePhoto({ hint: object, colour, key: `${stationId}:${level}:${n}` }));
    const photoId = await savePhoto(await scenePhoto({ hint: object, colour, key: `${stationId}:${level}:${n}`, view: 1 })); // the finder's photo
    const foundAt = ago(60 * (30 - n * 1.5));
    const eggId = id();
    await col.eggs.insertOne({ _id: eggId, stationId, level, photoId: eggPhotoId, hint: null, name: nameFromHint(object), createdBy: hider._id, createdAt: ago(60 * 48), status: 'retired', retiredAt: foundAt, activatedAt: ago(60 * 48), timesFound: 1, avgFindSeconds: secondsTaken, ...tag });
    const score = game.scoreFind(level, secondsTaken, game.ROUND_SECONDS);
    await col.finds.insertOne({
      _id: id(),
      eggId,
      userId: finder._id,
      stationId,
      level,
      foundAt,
      month,
      secondsTaken,
      points: score.total,
      base: score.base,
      bonus: score.bonus,
      bounty: 0,
      photoId,
      verified: false,
      canHide: false,
      ...tag,
    });
  }
  log.finds = spec.finds.length;

  if (!spec.group) return log;
  // One friend group with some chat.
  const members = [...new Set(spec.group.members.map((i) => who(i)))];
  const g = { _id: id(), name: spec.group.name, ownerId: members[0]._id, inviteCode: `DEMO${crypto.randomBytes(3).toString('hex').toUpperCase()}`.slice(0, 8), memberCount: members.length, msgSeq: 0, createdAt: ago(60 * 24 * 3), ...tag };
  await col.groups.insertOne(g);
  await col.groupMembers.insertMany(members.map((m, i) => ({ _id: id(), groupId: g._id, userId: m._id, joinedAt: ago(60 * 24 * 3 - i * 30), ...tag })));
  for (const [i, [m, sticker, text]] of spec.group.chat.entries()) {
    g.msgSeq += 1;
    const content = sticker ? { sticker } : { text };
    await col.groupMessages.insertOne({ _id: id(), groupId: g._id, seq: g.msgSeq, userId: members[m % members.length]._id, ...content, createdAt: ago(90 - i * 12), ...tag });
  }
  await col.groups.updateOne({ _id: g._id }, { $set: { msgSeq: g.msgSeq } });
  log.group = { name: g.name, members: members.length, messages: spec.group.chat.length };
  return log;
}
