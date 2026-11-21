// How eggs move through a station's slots. Each station has one slot per level,
// and a slot holds at most one "active" egg (a unique index enforces it).
// Egg status: active (playable) | pool (backup for its slot) | retired (gone).
//
// Every function takes a transaction client `c`. lockSlot() serializes changes
// to one slot across all server instances, so two players finishing the same
// egg at once can't both rotate it.
import { RETIRE_AFTER_DAYS } from './game.js';

export async function lockSlot(c, stationId, level) {
  await c.query('select pg_advisory_xact_lock(hashtext($1))', [`slot:${stationId}:${level}`]);
}

export function activeEgg(c, stationId, level) {
  return c.one(`select * from eggs where station_id = $1 and level = $2 and status = 'active'`, [stationId, level]);
}

// Prefer eggs this player didn't make and hasn't found, then the least-found.
function nextFromPool(c, egg, userId) {
  return c.one(
    `select e.* from eggs e
      where e.station_id = $1 and e.level = $2 and e.status = 'pool' and e.id <> $3
      order by (case when $4::uuid is not null and (e.created_by = $4::uuid or exists (
                  select 1 from finds f where f.egg_id = e.id and f.user_id = $4::uuid)) then 1 else 0 end),
               e.times_found, e.created_at, e.id
      limit 1`,
    [egg.station_id, egg.level, egg.id, userId],
  );
}

const activate = (c, id, now) =>
  c.query(`update eggs set status = 'active', activated_at = $2 where id = $1`, [id, now]);

// After a find, swap in a different egg from the pool if there is one.
// If the pool is empty the found egg stays up so the slot is never blank.
export async function rotateAfterFind(c, egg, finderId, now) {
  const next = await nextFromPool(c, egg, finderId);
  if (!next) return;
  await c.query(`update eggs set status = 'pool' where id = $1`, [egg.id]);
  await activate(c, next.id, now);
}

export async function retireEgg(c, egg, now) {
  await c.query(`update eggs set status = 'retired', retired_at = $2 where id = $1`, [egg.id, now]);
  if (egg.status === 'active') {
    const next = await nextFromPool(c, egg, null);
    if (next) await activate(c, next.id, now);
  }
}

// A newly hidden egg takes the slot; whatever was there goes to the pool.
export async function placeEgg(c, egg, now) {
  await c.query(
    `update eggs set status = 'pool' where station_id = $1 and level = $2 and status = 'active'`,
    [egg.stationId, egg.level],
  );
  await c.query(
    `insert into eggs (id, station_id, level, photo_id, hint, created_by, created_at, status, activated_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'active', $7)`,
    [egg.id, egg.stationId, egg.level, egg.photoId, egg.hint, egg.createdBy, now],
  );
}

// Eggs nobody has found within RETIRE_AFTER_DAYS of going live are retired.
export async function retireStale(db, now) {
  const cutoff = new Date(now.getTime() - RETIRE_AFTER_DAYS * 86400_000);
  const stale = await db.many(
    `select e.id, e.station_id, e.level from eggs e
      where e.status = 'active' and e.activated_at < $1
        and not exists (select 1 from finds f where f.egg_id = e.id and f.found_at >= e.activated_at)`,
    [cutoff],
  );
  for (const s of stale) {
    await db.tx(async (c) => {
      await lockSlot(c, s.station_id, s.level);
      // Re-check under the lock: another instance may have handled it.
      const egg = await c.one(
        `select * from eggs e where e.id = $1 and e.status = 'active' and e.activated_at < $2
           and not exists (select 1 from finds f where f.egg_id = e.id and f.found_at >= e.activated_at)`,
        [s.id, cutoff],
      );
      if (egg) await retireEgg(c, egg, now);
    });
  }
  return stale.length > 0;
}
