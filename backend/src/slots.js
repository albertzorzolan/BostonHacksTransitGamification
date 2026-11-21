// How eggs move through a station's slots. Each station has one slot per level,
// and a slot holds at most one "active" egg (a partial unique index enforces it).
// Egg status: active (playable) | pool (backup for its slot) | retired (gone).
//
// Every function runs inside db.tx and takes the transaction `session`.
// lockSlot() writes to one lock document per slot. Two transactions touching
// the same slot then conflict, and MongoDB retries the later one, so two
// players finishing the same egg at once can't both rotate it.
import { RETIRE_AFTER_DAYS } from './game.js';

export async function lockSlot(col, session, stationId, level) {
  await col.locks.updateOne({ _id: `slot:${stationId}:${level}` }, { $inc: { v: 1 } }, { upsert: true, session });
}

export function activeEgg(col, session, stationId, level) {
  return col.eggs.findOne({ stationId, level, status: 'active' }, { session });
}

// Prefer eggs this player didn't make and hasn't found, then the least-found.
async function nextFromPool(col, session, egg, userId) {
  const pool = await col.eggs
    .find({ stationId: egg.stationId, level: egg.level, status: 'pool', _id: { $ne: egg._id } }, { session })
    .sort({ timesFound: 1, createdAt: 1, _id: 1 })
    .toArray();
  if (!pool.length || !userId) return pool[0] ?? null;
  const found = new Set(
    (await col.finds.find({ userId, eggId: { $in: pool.map((e) => e._id) } }, { session, projection: { eggId: 1 } }).toArray()).map(
      (f) => f.eggId,
    ),
  );
  const seen = (e) => (e.createdBy === userId || found.has(e._id) ? 1 : 0);
  return pool.map((e, i) => [e, i]).sort(([a, i], [b, j]) => seen(a) - seen(b) || i - j)[0][0];
}

const activate = (col, session, id, now) =>
  col.eggs.updateOne({ _id: id }, { $set: { status: 'active', activatedAt: now } }, { session });

// After a find, swap in a different egg from the pool if there is one.
// If the pool is empty the found egg stays up so the slot is never blank.
export async function rotateAfterFind(col, session, egg, finderId, now) {
  const next = await nextFromPool(col, session, egg, finderId);
  if (!next) return;
  await col.eggs.updateOne({ _id: egg._id }, { $set: { status: 'pool' } }, { session });
  await activate(col, session, next._id, now);
}

export async function retireEgg(col, session, egg, now) {
  await col.eggs.updateOne({ _id: egg._id }, { $set: { status: 'retired', retiredAt: now } }, { session });
  if (egg.status === 'active') {
    const next = await nextFromPool(col, session, egg, null);
    if (next) await activate(col, session, next._id, now);
  }
}

// A newly hidden egg takes the slot; whatever was there goes to the pool.
export async function placeEgg(col, session, egg, now) {
  await col.eggs.updateMany({ stationId: egg.stationId, level: egg.level, status: 'active' }, { $set: { status: 'pool' } }, { session });
  await col.eggs.insertOne(
    { ...egg, createdAt: now, status: 'active', activatedAt: now, timesFound: 0, avgFindSeconds: null },
    { session },
  );
}

async function isStale(col, session, egg, cutoff) {
  if (egg.status !== 'active' || !(egg.activatedAt < cutoff)) return false;
  return !(await col.finds.findOne({ eggId: egg._id, foundAt: { $gte: egg.activatedAt } }, { session }));
}

// Eggs nobody has found within RETIRE_AFTER_DAYS of going live are retired.
export async function retireStale({ col, tx }, now) {
  const cutoff = new Date(now.getTime() - RETIRE_AFTER_DAYS * 86400_000);
  const candidates = await col.eggs.find({ status: 'active', activatedAt: { $lt: cutoff } }).toArray();
  let changed = false;
  for (const c of candidates) {
    if (!(await isStale(col, undefined, c, cutoff))) continue;
    changed = true;
    await tx(async (session) => {
      await lockSlot(col, session, c.stationId, c.level);
      // Re-check under the lock: another instance may have handled it.
      const egg = await col.eggs.findOne({ _id: c._id }, { session });
      if (egg && (await isStale(col, session, egg, cutoff))) await retireEgg(col, session, egg, now);
    });
  }
  return changed;
}
