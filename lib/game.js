// Game rules: levels, scoring, and how eggs rotate through a station's slots.
// Each station has one slot per level. A slot holds at most one "active" egg.
// Egg status: active (playable) | pool (backup for its slot) | retired (gone).

export const LEVELS = [
  { level: 1, name: 'Easy', points: 10, seconds: 120 },
  { level: 2, name: 'Medium', points: 20, seconds: 180 },
  { level: 3, name: 'Hard', points: 30, seconds: 240 },
  { level: 4, name: 'Extreme', points: 40, seconds: 300 },
  { level: 5, name: 'Impossible', points: 60, seconds: 360 },
];

export const GRACE_SECONDS = 15; // upload time allowance after the clock hits zero
export const MAX_TIME_BONUS = 0.5; // up to +50% of the level's points
export const RETIRE_AFTER_DAYS = 7;
export const REPORTS_TO_RETIRE = 3;
export const HIDE_WINDOW_MINUTES = 30; // how long after a find you can hide the next egg
// "Race the next train" mode uses the next train only if it's in this range.
export const TRAIN_MIN_SECONDS = 90;
export const TRAIN_MAX_SECONDS = 900;

export function levelInfo(level) {
  const info = LEVELS.find((l) => l.level === Number(level));
  if (!info) throw new Error(`Unknown level ${level}`);
  return info;
}

export function scoreFind(level, secondsTaken, limitSeconds) {
  const base = levelInfo(level).points;
  const fractionLeft = Math.max(0, limitSeconds - secondsTaken) / limitSeconds;
  const bonus = Math.round(base * MAX_TIME_BONUS * Math.min(1, fractionLeft));
  return { base, bonus, total: base + bonus };
}

// "2026-11" in Boston time, so the monthly board flips at local midnight.
export function monthKey(date, timeZone = 'America/New_York') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).format(
    new Date(date),
  );
}

export function activeEgg(db, stationId, level) {
  return db.eggs.find((e) => e.stationId === stationId && e.level === level && e.status === 'active');
}

export function hasFound(db, userId, eggId) {
  return db.finds.some((f) => f.userId === userId && f.eggId === eggId);
}

function poolCandidates(db, egg, userId) {
  return db.eggs
    .filter(
      (e) =>
        e.id !== egg.id &&
        e.stationId === egg.stationId &&
        e.level === egg.level &&
        e.status === 'pool',
    )
    .sort((a, b) => {
      // Prefer eggs this player didn't make and hasn't found, then least-found.
      const seen = (e) => (userId && (e.createdBy === userId || hasFound(db, userId, e.id)) ? 1 : 0);
      return seen(a) - seen(b) || a.timesFound - b.timesFound;
    });
}

function activate(egg, now) {
  egg.status = 'active';
  egg.activatedAt = now.toISOString();
}

// After a find, swap in a different egg from the pool if there is one.
// If the pool is empty the found egg stays up so the slot is never blank.
export function rotateAfterFind(db, egg, finderId, now) {
  const [next] = poolCandidates(db, egg, finderId);
  if (!next) return egg;
  egg.status = 'pool';
  activate(next, now);
  return next;
}

export function retireEgg(db, egg, now) {
  const wasActive = egg.status === 'active';
  egg.status = 'retired';
  egg.retiredAt = now.toISOString();
  if (wasActive) {
    const [next] = poolCandidates(db, egg, null);
    if (next) activate(next, now);
  }
}

// A newly hidden egg takes the slot; whatever was there goes to the pool.
export function placeEgg(db, newEgg, now) {
  const current = activeEgg(db, newEgg.stationId, newEgg.level);
  if (current) current.status = 'pool';
  activate(newEgg, now);
  db.eggs.push(newEgg);
}

// Eggs nobody has found within RETIRE_AFTER_DAYS of going live are retired.
export function retireStale(db, now) {
  const cutoff = now.getTime() - RETIRE_AFTER_DAYS * 86400_000;
  let changed = false;
  for (const egg of db.eggs) {
    if (egg.status !== 'active') continue;
    const foundSince = db.finds.some((f) => f.eggId === egg.id && f.foundAt >= egg.activatedAt);
    if (!foundSince && Date.parse(egg.activatedAt) < cutoff) {
      retireEgg(db, egg, now);
      changed = true;
    }
  }
  return changed;
}

// Green-B/C/D/E roll up to "Green" for the line-vs-line board.
export function lineFamily(routeId) {
  if (routeId.startsWith('Green')) return 'Green';
  if (routeId === 'Mattapan') return 'Red';
  return routeId;
}
