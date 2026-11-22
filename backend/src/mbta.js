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
const VEHICLE_CACHE_MS = 15_000;

export function createMbta({ apiKey, cacheFile, shapesFile } = {}) {
  const predCache = new Map();
  let vehicleCache = null;

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

  // Route shapes for drawing the lines on the map. Cached to a file after the first fetch.
  // Keeps the longest shape per route, plus Red's second branch (Ashmont and Braintree).
  async function shapes() {
    if (shapesFile && fs.existsSync(shapesFile)) return JSON.parse(fs.readFileSync(shapesFile, 'utf8'));
    const out = [];
    for (const [routeId, line] of Object.entries(LINES)) {
      const json = await get(`/shapes?filter[route]=${encodeURIComponent(routeId)}`);
      const decoded = json.data
        .map((s) => ({ id: s.id, points: decodePolyline(s.attributes.polyline ?? '') }))
        .filter((s) => s.points.length > 1)
        .sort((a, b) => b.points.length - a.points.length);
      // The same track runs both ways, so keep one shape per pair of end points (Red has two: Ashmont and Braintree).
      const seen = new Set();
      const distinct = decoded.filter((s) => {
        const ends = [s.points[0], s.points[s.points.length - 1]].map((p) => p.map((v) => v.toFixed(2)).join(',')).sort().join('|');
        if (seen.has(ends)) return false;
        seen.add(ends);
        return true;
      });
      const keep = routeId === 'Red' ? distinct.slice(0, 2) : distinct.slice(0, 1);
      for (const s of keep) out.push({ routeId, color: line.color, points: s.points });
    }
    if (shapesFile) fs.writeFileSync(shapesFile, JSON.stringify(out));
    return out;
  }

  // Direction names and end points per route ("South" toward "Ashmont/Braintree"). Fetched once.
  let directionsCache = null;
  async function directions() {
    if (directionsCache) return directionsCache;
    const json = await get(`/routes?filter[id]=${encodeURIComponent(Object.keys(LINES).join(','))}`);
    directionsCache = Object.fromEntries(
      json.data.map((r) => [r.id, { names: r.attributes.direction_names ?? [], destinations: r.attributes.direction_destinations ?? [] }]),
    );
    return directionsCache;
  }

  // Where every subway and light-rail train is right now, with where it's headed and the stop it's at.
  // Cached briefly so many players share one request.
  async function vehicles() {
    if (vehicleCache && Date.now() - vehicleCache.at < VEHICLE_CACHE_MS) return vehicleCache.list;
    const routes = Object.keys(LINES).join(',');
    const [json, dirs] = await Promise.all([
      get(`/vehicles?filter[route]=${encodeURIComponent(routes)}&include=trip,stop`),
      directions().catch(() => ({})),
    ]);
    const included = new Map((json.included ?? []).map((i) => [`${i.type}:${i.id}`, i.attributes]));
    const list = json.data
      .map((v) => {
        const a = v.attributes;
        const routeId = v.relationships?.route?.data?.id;
        if (a.latitude == null || a.longitude == null || !LINES[routeId]) return null;
        const trip = included.get(`trip:${v.relationships?.trip?.data?.id}`);
        const stop = included.get(`stop:${v.relationships?.stop?.data?.id}`);
        const dir = dirs[routeId];
        return {
          id: v.id,
          tripId: v.relationships?.trip?.data?.id ?? null, // one journey: train lobbies are keyed by it
          routeId,
          color: LINES[routeId].color,
          lat: a.latitude,
          lng: a.longitude,
          bearing: a.bearing ?? 0,
          label: a.label ?? '',
          status: a.current_status ?? '',
          directionId: a.direction_id,
          stopId: v.relationships?.stop?.data?.id ?? null,
          stopName: stop?.name ?? null,
          headsign: trip?.headsign ?? null,
          directionName: dir?.names?.[a.direction_id] ?? null,
          destination: dir?.destinations?.[a.direction_id] ?? null,
          line: LINES[routeId].name,
          carriages: (a.carriages ?? []).map((c) => ({
            label: c.label,
            occupancy: c.occupancy_status && c.occupancy_status !== 'NO_DATA_AVAILABLE' ? c.occupancy_status : null,
          })),
          occupancy: a.occupancy_status ?? null,
          speed: a.speed ?? null,
          updatedAt: a.updated_at ?? null,
        };
      })
      .filter(Boolean);
    vehicleCache = { at: Date.now(), list };
    return list;
  }

  return { loadStations, predictions, shapes, vehicles };
}

// Google encoded polyline -> [[lat, lng], ...], rounded to 5 decimals.
export function decodePolyline(str) {
  const points = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, byte;
      do {
        byte = str.charCodeAt(i++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && i < str.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta; else lng += delta;
    }
    points.push([Math.round(lat) / 1e5, Math.round(lng) / 1e5]);
  }
  return points;
}

function withFreshSeconds(trains) {
  const now = Date.now();
  return trains
    .map((t) => ({ ...t, seconds: Math.round((Date.parse(t.at) - now) / 1000) }))
    .filter((t) => t.seconds > -30)
    .slice(0, 8);
}
