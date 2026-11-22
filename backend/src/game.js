// Game rules: levels, scoring, timers. Pure functions, no database.
// How eggs rotate through a station's slots lives in slots.js (SQL).

// Every level gets the same 3-minute timer; harder levels show the finder a blurred photo instead.
// blur = Gaussian sigma in pixels, applied after scaling the photo to fit 1024 px (0 = sharp).
export const ROUND_SECONDS = 180;
export const LEVELS = [
  { level: 1, name: 'Easy', points: 10, seconds: ROUND_SECONDS, blur: 0 },
  { level: 2, name: 'Medium', points: 20, seconds: ROUND_SECONDS, blur: 0 },
  { level: 3, name: 'Hard', points: 30, seconds: ROUND_SECONDS, blur: 0 },
  { level: 4, name: 'Extreme', points: 40, seconds: ROUND_SECONDS, blur: 6 },
  { level: 5, name: 'Impossible', points: 60, seconds: ROUND_SECONDS, blur: 16 },
];

export const GRACE_SECONDS = 15; // upload time allowance after the clock hits zero
export const MAX_TIME_BONUS = 0.5; // up to +50% of the level's points
export const RETIRE_AFTER_DAYS = 7;
export const REPORTS_TO_RETIRE = 3;
export const HIDE_WINDOW_MINUTES = 30; // how long after a find you can hide the next egg

// One clock per player per egg. It runs in real time from the first start, so leaving and coming
// back resumes it instead of resetting it. Once it runs out (or you give up) you can retry right
// away with a fresh clock, but a retry earns no time bonus: you've already had a look around.

// Bounty: every player an egg beats (their clock ran out or they gave up) adds to its pot.
// The finder takes the pot, and the hider gets a share of it, paid only when the egg is found.
export const BOUNTY_PER_PLAYER = 0.25; // of the level's base points, per player beaten
export const BOUNTY_CAP = 2; // the pot tops out at 2x the level's base points
export const HIDER_SHARE = 0.5; // of the pot, paid to the hider when someone claims it

export function levelInfo(level) {
  const info = LEVELS.find((l) => l.level === Number(level));
  if (!info) throw new Error(`Unknown level ${level}`);
  return info;
}

export function scoreFind(level, secondsTaken, limitSeconds, { bounty = 0, retry = false } = {}) {
  const base = levelInfo(level).points;
  const fractionLeft = Math.max(0, limitSeconds - secondsTaken) / limitSeconds;
  const bonus = retry ? 0 : Math.round(base * MAX_TIME_BONUS * Math.min(1, fractionLeft));
  return { base, bonus, bounty, total: base + bonus + bounty };
}

export function bountyFor(level, playersBeaten) {
  const base = levelInfo(level).points;
  return Math.min(Math.round(base * BOUNTY_CAP), Math.round(base * BOUNTY_PER_PLAYER * playersBeaten));
}

export const hiderShare = (bounty) => Math.round(bounty * HIDER_SHARE);

// When a round's clock is over: when it was given up, or when its time plus the upload grace ran out.
export function roundEndsAt(attempt) {
  return attempt.endedAt ?? new Date(attempt.startedAt.getTime() + (attempt.limitSeconds + GRACE_SECONDS) * 1000);
}

// The longest a round can last, so queries can skip rounds that started too early to matter.
export const MAX_ROUND_MS = (ROUND_SECONDS + GRACE_SECONDS) * 1000;

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

// ---------- progress: rider levels, daily challenges, stamps ----------
// Everything below is derived from finds/attempts/eggs; nothing extra is stored.

// All-time points needed to reach each rider level (index 0 = level 1).
export const RIDER_LEVELS = [0, 50, 150, 300, 500, 800, 1200, 1700, 2300, 3000];

export function riderLevel(points) {
  let i = 0;
  while (i + 1 < RIDER_LEVELS.length && points >= RIDER_LEVELS[i + 1]) i++;
  return { level: i + 1, points, floor: RIDER_LEVELS[i], next: RIDER_LEVELS[i + 1] ?? null };
}

// "2026-11-21" in Boston time, so daily challenges flip at local midnight.
export function dayKey(date, timeZone = 'America/New_York') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(date),
  );
}

// One challenge a day, the same for everyone, rotating through this list.
export const CHALLENGES = [
  { id: 'transfer', title: 'Transfer', description: 'Find eggs on 2 different lines today.', target: 2 },
  { id: 'climber', title: 'Go hard', description: 'Find a Hard egg or harder today.', target: 1 },
  { id: 'triple', title: 'Hat trick', description: 'Find 3 eggs today.', target: 3 },
];

export function challengeFor(day) {
  const n = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
  return CHALLENGES[((n % CHALLENGES.length) + CHALLENGES.length) % CHALLENGES.length];
}

export const MAIN_LINES = ['Red', 'Orange', 'Blue', 'Green'];

// Anonymous chat names, e.g. "Sleepy Turnstile 27". Every player gets one at sign-up
// and can change it; the group chat shows only this name, never the username.
const CHAT_ADJECTIVES = ['Sleepy', 'Speedy', 'Sneaky', 'Lucky', 'Rusty', 'Shiny', 'Grumpy', 'Jolly', 'Quiet', 'Brave', 'Dizzy', 'Fuzzy', 'Mighty', 'Swift', 'Cosmic', 'Salty', 'Witty', 'Mystic', 'Bouncy', 'Stealthy'];
const CHAT_NOUNS = ['Turnstile', 'Trolley', 'Pigeon', 'Conductor', 'Platform', 'Railcar', 'Signal', 'Token', 'Tunnel', 'Switch', 'Bogie', 'Caboose', 'Lantern', 'Ticket', 'Whistle', 'Owl', 'Raccoon', 'Comet', 'Fox', 'Otter'];
export function randomChatName(rand = Math.random) {
  const pick = (a) => a[Math.floor(rand() * a.length)];
  return `${pick(CHAT_ADJECTIVES)} ${pick(CHAT_NOUNS)} ${10 + Math.floor(rand() * 90)}`;
}
