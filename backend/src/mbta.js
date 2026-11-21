// MBTA V3 API: subway/light-rail stations and live predictions.
// Docs: https://api-v3.mbta.com/docs/swagger/index.html
import fs from 'node:fs';

const BASE = 'https://api-v3.mbta.com';

export const LINES = {
  Red: { name: 'Red Line', color: '#DA291C' },
  Mattapan: { name: 'Mattapan Trolley', color: '#DA291C' },
  Orange: { name: 'Orange Line', color: '#ED8B00' },
  Blue: { name: 'Blue Line', color: '#003DA5' },
  'Green-B': { name: 'Green Line B', color: '#00843D' },
  'Green-C': { name: 'Green Line C', color: '#00843D' },
  'Green-D': { name: 'Green Line D', color: '#00843D' },
  'Green-E': { name: 'Green Line E', color: '#00843D' },
};

const PREDICTION_CACHE_MS = 20_000;

export function createMbta({ apiKey, cacheFile } = {}) {
  const predCache = new Map();

  async function get(pathAndQuery) {
    const headers = { accept: 'application/vnd.api+json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    const res = await fetch(BASE + pathAndQuery, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`MBTA API returned ${res.status}`);
    return res.json();
  }

  // Station list is cached to a file after the first fetch (it rarely changes).
  async function loadStations() {
    if (cacheFile && fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const byId = new Map();
    for (const [routeId, line] of Object.entries(LINES)) {
      const json = await get(`/stops?filter[route]=${encodeURIComponent(routeId)}`);
      for (const s of json.data) {
        const station = byId.get(s.id) ?? {
          id: s.id,
          name: s.attributes.name,
          lat: s.attributes.latitude,
          lng: s.attributes.longitude,
          lines: [],
        };
        station.lines.push({ id: routeId, ...line });
        byId.set(s.id, station);
      }
    }
    const stations = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify(stations, null, 2));
    return stations;
  }

  // Next trains at a station (subway + light rail only, no buses).
  async function predictions(stopId) {
    const hit = predCache.get(stopId);
    if (hit && Date.now() - hit.at < PREDICTION_CACHE_MS) return withFreshSeconds(hit.trains);

    const json = await get(
      `/predictions?filter[stop]=${encodeURIComponent(stopId)}&filter[route_type]=0,1&include=trip`,
    );
    const headsigns = new Map(
      (json.included ?? []).filter((i) => i.type === 'trip').map((t) => [t.id, t.attributes.headsign]),
    );
    const trains = json.data
      .map((p) => {
        const time = p.attributes.arrival_time ?? p.attributes.departure_time;
        if (!time || p.attributes.schedule_relationship === 'CANCELLED') return null;
        const routeId = p.relationships?.route?.data?.id;
        const tripId = p.relationships?.trip?.data?.id;
        return {
          routeId,
          line: LINES[routeId]?.name ?? routeId,
          color: LINES[routeId]?.color ?? '#555555',
          headsign: headsigns.get(tripId) ?? '',
          directionId: p.attributes.direction_id,
          status: p.attributes.status,
          at: time,
        };
      })
      .filter(Boolean)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

    predCache.set(stopId, { at: Date.now(), trains });
    return withFreshSeconds(trains);
  }

  return { loadStations, predictions };
}

function withFreshSeconds(trains) {
  const now = Date.now();
  return trains
    .map((t) => ({ ...t, seconds: Math.round((Date.parse(t.at) - now) / 1000) }))
    .filter((t) => t.seconds > -30)
    .slice(0, 8);
}
