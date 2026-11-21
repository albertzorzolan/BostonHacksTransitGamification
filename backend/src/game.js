// Game rules: levels, scoring, timers. Pure functions, no database.
// How eggs rotate through a station's slots lives in slots.js (SQL).

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

// Green-B/C/D/E roll up to "Green" for the line-vs-line board.
export function lineFamily(routeId) {
  if (routeId.startsWith('Green')) return 'Green';
  if (routeId === 'Mattapan') return 'Red';
  return routeId;
}

// Group chat is stickers only (no typed messages): competitive trash talk from a fixed set.
// The server accepts only these ids; the client gets the list from /api/config.
export const STICKERS = [
  { id: 'crown', emoji: '👑', label: "Who's the king now" },
  { id: 'trophy', emoji: '🏆', label: 'Champion' },
  { id: 'goat', emoji: '🐐', label: 'GOAT' },
  { id: 'fire', emoji: '🔥', label: 'On fire' },
  { id: 'flex', emoji: '💪', label: 'Too easy' },
  { id: 'target', emoji: '🎯', label: 'Nailed it' },
  { id: 'rocket', emoji: '🚀', label: 'Speedrun' },
  { id: 'egg', emoji: '🥚', label: 'Found it first' },
  { id: 'challenge', emoji: '⚔️', label: 'Bring it on' },
  { id: 'eyes', emoji: '👀', label: 'Coming for you' },
  { id: 'snail', emoji: '🐌', label: 'Too slow' },
  { id: 'train', emoji: '🚇', label: 'Missed the train' },
  { id: 'sleep', emoji: '😴', label: 'Wake up' },
  { id: 'clown', emoji: '🤡', label: 'Clown move' },
  { id: 'salt', emoji: '🧂', label: 'Salty?' },
  { id: 'skull', emoji: '💀', label: "I'm dead" },
  { id: 'laugh', emoji: '😂', label: 'LOL' },
  { id: 'cry', emoji: '😭', label: 'Not fair' },
  { id: 'sweat', emoji: '😅', label: 'Close one' },
  { id: 'wave', emoji: '👋', label: 'See ya at the top' },
];
export const stickerById = new Map(STICKERS.map((s) => [s.id, s]));
