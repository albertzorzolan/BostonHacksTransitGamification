// Train lobbies: deciding a player is on a train, and the rules for pledging found eggs.
//
// On-train check. One GPS fix next to a train proves little: you could be on the platform
// beside it. So a player counts as on a train when two fixes, 20 s to 5 min apart, both sit
// next to the SAME trip, and between them the train moved and the player moved with it
// (similar distance). Standing still while a train leaves, or walking beside a stopped one,
// doesn't pass.
//
// Limits: phones get poor or no GPS in tunnels, so this works best on surface and elevated
// track (Green Line branches, Red over the Longfellow, Orange and Red above ground, Blue to
// Wonderland). Underground the check simply won't verify; nothing breaks.

export const NEAR_M = 150; // fix within this of the train (plus some of the fix's own error)
export const MAX_ACCURACY_M = 250; // fixes vaguer than this are ignored
export const PAIR_MIN_MS = 20_000;
export const PAIR_MAX_MS = 5 * 60_000;
export const MIN_MOVE_M = 120; // the train has to have moved at least this far between fixes
export const ON_TRAIN_FOR_MS = 10 * 60_000; // how long one verification lasts (to join a lobby)
export const LOBBY_GONE_MS = 3 * 60_000; // trip missing from the live feed this long = journey over
export const LOBBY_MAX_MS = 3 * 3600_000; // no journey runs longer than this
export const PLEDGE_TARGET = 100; // points of found eggs every rider needs pledged in their name
export const BONUS_POINTS = 50; // every rider, when all riders reach the target
export const DONOR_BONUS_PER_EGG = 10; // extra, per egg a rider donated to someone else
export const MIN_RIDERS = 2; // a lobby is a team effort: one rider alone can't reach the goal
export const TEXT_MAX = 140;

const M_PER_LAT = 110_540;
export function distanceM(a, b) {
  const mPerLng = 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((a.lat - b.lat) * M_PER_LAT, (a.lng - b.lng) * mPerLng);
}

// The live train nearest to a fix, if close enough to count.
export function nearestTrain(fix, vehicles) {
  const reach = NEAR_M + Math.min(fix.accuracy ?? 0, MAX_ACCURACY_M) * 0.5;
  let best = null;
  for (const v of vehicles) {
    if (!v.tripId) continue;
    const m = distanceM(fix, v);
    if (m <= reach && (!best || m < best.m)) best = { vehicle: v, m };
  }
  return best;
}

// Two sightings of the same trip, in time order -> did the player ride along?
export function rodeAlong(a, b) {
  if (a.tripId !== b.tripId) return false;
  const dt = b.at - a.at;
  if (dt < PAIR_MIN_MS || dt > PAIR_MAX_MS) return false;
  const trainMoved = distanceM(a.train, b.train);
  const playerMoved = distanceM(a.user, b.user);
  if (trainMoved < MIN_MOVE_M) return false;
  // Moved together: the player's distance is within half (plus GPS slack) of the train's.
  return Math.abs(trainMoved - playerMoved) <= trainMoved * 0.5 + NEAR_M;
}

// A small word filter for typed chat messages (train lobbies and friend groups). Rejects rather
// than masking, and also rejects links, so the chat can't be used for spam.
const BLOCKED = ['fuck', 'shit', 'bitch', 'cunt', 'nigg', 'fag', 'retard', 'whore', 'slut', 'rape', 'kill yourself', 'kys'];
// Used by group chats too.
export function cleanText(raw) {
  const text = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return { error: 'Type a message.' };
  if (text.length > TEXT_MAX) return { error: `Keep it under ${TEXT_MAX} characters.` };
  if (/https?:\/\/|www\.|\.(com|net|org|io|ly)\b/i.test(text)) return { error: 'No links in chat.' };
  const flat = text.toLowerCase().replace(/[^a-z ]/g, '');
  if (BLOCKED.some((w) => flat.includes(w))) return { error: 'Keep it friendly.' };
  return { text };
}
