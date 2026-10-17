// Tropical storms from the National Hurricane Center, via NOAA's NHC_tropical_weather map
// service (ArcGIS REST, GeoJSON). Shared by the app (map + storm card) and the alert server.
// The service has fixed "bins" per basin (AT1-5, EP1-5, CP1-5), each with forecast points,
// track, cone, coastal watches/warnings, past track and wind radii layers. Wx Now covers
// the Atlantic side only, so just the Atlantic bins (AT1-5) are read.

const SERVICE = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';
const CACHE_MS = 10 * 60000;
const KT_TO_MPH = 1.15078;

let layerIds = null;   // { 'EP1': { points: 136, track: 137, ... } }
let cached = null;     // { at, storms }

async function getJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const resp = await fetch(url, { signal: ctl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const j = await resp.json();
    if (j.error) throw new Error(j.error.message || 'Map service error');
    return j;
  } finally {
    clearTimeout(timer);
  }
}

// Finds each bin's layer ids by name, so a reshuffle of the service doesn't break us.
async function loadLayerIds() {
  if (layerIds) return layerIds;
  const j = await getJson(`${SERVICE}?f=json`);
  const want = {
    points: 'Forecast Points', track: 'Forecast Track', cone: 'Forecast Cone',
    ww: 'Watch-Warning', pastTrack: 'Past Track', wind: 'Advisory Wind Field',
  };
  const ids = {};
  for (const l of j.layers || []) {
    const m = l.name.match(/^(AT\d) (.+)$/);
    if (!m) continue;
    for (const [key, name] of Object.entries(want)) {
      if (m[2] === name) (ids[m[1]] = ids[m[1]] || {})[key] = l.id;
    }
  }
  layerIds = ids;
  return ids;
}

const query = (id) => getJson(`${SERVICE}/${id}/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson`)
  .then((j) => j.features || []);

export function category(kt) {
  if (kt < 34) return { short: 'TD', name: 'Tropical Depression', level: 0 };
  if (kt < 64) return { short: 'TS', name: 'Tropical Storm', level: 0 };
  if (kt < 83) return { short: '1', name: 'Category 1 Hurricane', level: 1 };
  if (kt < 96) return { short: '2', name: 'Category 2 Hurricane', level: 2 };
  if (kt < 113) return { short: '3', name: 'Category 3 Hurricane', level: 3 };
  if (kt < 137) return { short: '4', name: 'Category 4 Hurricane', level: 4 };
  return { short: '5', name: 'Category 5 Hurricane', level: 5 };
}

// "DD/HHMM" valid time (UTC) near a reference time.
function validTime(label, ref) {
  const m = String(label || '').match(/^(\d{2})\/(\d{2})(\d{2})$/);
  if (!m) return NaN;
  const r = new Date(ref);
  let t = Date.UTC(r.getUTCFullYear(), r.getUTCMonth(), +m[1], +m[2], +m[3]);
  if (t - ref > 15 * 86400000) t = Date.UTC(r.getUTCFullYear(), r.getUTCMonth() - 1, +m[1], +m[2], +m[3]);
  if (ref - t > 15 * 86400000) t = Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, +m[1], +m[2], +m[3]);
  return t;
}

async function loadBin(bin, ids) {
  const points = await query(ids.points);
  if (!points.length) return null;
  const [track, cone, ww, pastTrack, wind] = await Promise.all(
    ['track', 'cone', 'ww', 'pastTrack', 'wind'].map((k) => (ids[k] === undefined ? [] : query(ids[k]).catch(() => []))),
  );
  const pts = points.map((f) => ({
    lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
    tau: f.properties.tau, label: f.properties.datelbl, kt: f.properties.maxwind,
    time: validTime(f.properties.validtime, Date.now()),
  })).sort((a, b) => a.tau - b.tau);
  const p0 = points.find((f) => f.properties.tau === 0) || points[0];
  const pr = p0.properties;
  return {
    bin,
    name: String(pr.stormname || '').replace(/^(Hurricane|Tropical Storm|Tropical Depression|Post-Tropical Cyclone|Potential Tropical Cyclone|Subtropical Storm|Remnants of)\s+/i, ''),
    title: pr.stormname,
    type: pr.tcdvlp,
    kt: pr.maxwind, gustKt: pr.gust,
    mph: Math.round(pr.maxwind * KT_TO_MPH / 5) * 5,
    pressure: pr.mslp < 9000 ? pr.mslp : null,
    headingTo: pr.tcdir < 999 ? pr.tcdir : null,
    speedMph: pr.tcspd < 999 ? Math.round(pr.tcspd * KT_TO_MPH) : null,
    advisory: pr.advisnum, advisoryTime: pr.advdate,
    lat: pts[0].lat, lon: pts[0].lon,
    points: pts,
    track: track.map((f) => f.geometry),
    cone: cone.map((f) => f.geometry),
    pastTrack: pastTrack.map((f) => f.geometry),
    warnings: ww.map((f) => ({ code: f.properties.tcww, geometry: f.geometry })),
    wind: wind.map((f) => ({ kt: f.properties.radii, geometry: f.geometry })),
  };
}

// All active storms (empty array when none). Cached for 10 minutes.
export async function activeStorms() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.storms;
  const ids = await loadLayerIds();
  const bins = Object.keys(ids).filter((b) => ids[b].points !== undefined);
  const storms = (await Promise.all(bins.map((b) => loadBin(b, ids[b]).catch(() => null)))).filter(Boolean);
  cached = { at: Date.now(), storms };
  return storms;
}

// ---------- geometry (lat/lon, small-area approximations) ----------

const R = 6371;
export function distKm(a, b) {
  const r = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * r / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function bearing(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

function inRing(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function inGeometry(g, p) {
  if (!g) return false;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.some((rings) => inRing(rings[0], p.lon, p.lat) && !rings.slice(1).some((h) => inRing(h, p.lon, p.lat)));
}

// Shortest distance (km) from p to a LineString/MultiLineString.
export function distToLine(g, p) {
  if (!g) return Infinity;
  const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
  const k = Math.cos(p.lat * Math.PI / 180) * 111.32;
  let best = Infinity;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const ax = (line[i - 1][0] - p.lon) * k, ay = (line[i - 1][1] - p.lat) * 110.57;
      const bx = (line[i][0] - p.lon) * k, by = (line[i][1] - p.lat) * 110.57;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

export const WARNING_NAMES = {
  TWA: 'Tropical Storm Watch', TWR: 'Tropical Storm Warning',
  HWA: 'Hurricane Watch', HWR: 'Hurricane Warning',
};
const WARNING_RANK = { TWA: 2, HWA: 3, TWR: 4, HWR: 5 };
const WARNING_NEAR_KM = 60;

// What a storm means for one place: distance, closest forecast approach, cone, warnings,
// winds. `level` ranks the threat so alerts can fire only when it gets worse.
export function threatTo(storm, place) {
  const now = { lat: storm.lat, lon: storm.lon };
  const out = { km: distKm(place, now), bearingFrom: bearing(place, now), level: 0 };

  // Closest approach along the forecast track, sampled hourly between forecast points.
  // Only positions from now on count: the advisory's starting point is a few hours old.
  const nowMs = Date.now();
  let best = { km: out.km, time: nowMs, kt: storm.kt };
  const pts = storm.points;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], steps = Math.max(1, Math.round((b.tau - a.tau)));
    for (let s = 0; s <= steps; s++) {
      const f = s / steps, time = a.time + (b.time - a.time) * f;
      if (time < nowMs) continue;
      const q = { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
      const d = distKm(place, q);
      if (d < best.km) best = { km: d, time, kt: a.kt + (b.kt - a.kt) * f };
    }
  }
  out.closest = best;

  out.inCone = storm.cone.some((g) => inGeometry(g, place));
  if (out.inCone) out.level = 1;

  let warn = null;
  for (const w of storm.warnings) {
    if (WARNING_RANK[w.code] && distToLine(w.geometry, place) <= WARNING_NEAR_KM &&
        (!warn || WARNING_RANK[w.code] > WARNING_RANK[warn])) warn = w.code;
  }
  out.warning = warn;
  if (warn) out.level = Math.max(out.level, WARNING_RANK[warn]);

  const winds = storm.wind.filter((w) => inGeometry(w.geometry, place)).map((w) => w.kt);
  out.windKt = winds.length ? Math.max(...winds) : 0;
  if (out.windKt >= 64) out.level = Math.max(out.level, 7);
  else if (out.windKt >= 34) out.level = Math.max(out.level, 6);
  return out;
}

// One-line description of the threat for alerts and the storm card.
export function threatText(storm, t) {
  if (t.windKt >= 64) return `Hurricane-force winds are now reaching this location.`;
  if (t.windKt >= 34) return `Tropical-storm-force winds are now reaching this location.`;
  if (t.warning) return `${WARNING_NAMES[t.warning]} in effect on the nearby coast.`;
  if (t.inCone) return `This location is inside the forecast cone.`;
  return '';
}
