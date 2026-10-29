// Water clarity from NOAA VIIRS (GET /api/clarity?lat=&lon=). NOAA CoastWatch ERDDAP sends no
// CORS headers, so the app asks this server. Kd490 (diffuse attenuation at 490 nm, 1/m; lower is
// clearer) from NOAA-20 and NOAA-21 at 750 m, NIR-SWIR algorithm for coastal water, US sector.
// Days with cloud over the spot have no pixels, so the newest clear day in the last 10 is used.

const ERDDAP = 'https://coastwatch.noaa.gov/erddap/griddap';
const DATASETS = [
  { id: 'noaacwN20VIIRSkd490NSWUSDaily', sat: 'NOAA-20' },
  { id: 'noaacwN21VIIRSkd490NSWUSDaily', sat: 'NOAA-21' },
];
const BOX = 0.03;      // degrees each side of the spot (about 3 km)
const MAX_KM = 4;      // ignore pixels further than this from the spot
const NEAREST = 5;     // median of the nearest clear pixels
const DAYS = 10;
const cache = new Map();

function km(a, b) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const median = (v) => {
  const s = [...v].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// rows: [time, altitude, latitude, longitude, kd_490] from ERDDAP .json.
// Returns the newest day with clear pixels within MAX_KM: { t, kd, km, n } or null.
export function pickDay(rows, loc) {
  const days = new Map();
  for (const [t, , lat, lon, kd] of rows) {
    if (kd === null || !(kd > 0)) continue;
    const d = km(loc, { lat, lon });
    if (d > MAX_KM) continue;
    if (!days.has(t)) days.set(t, []);
    days.get(t).push({ kd, d });
  }
  const newest = [...days.keys()].sort().pop();
  if (!newest) return null;
  const near = days.get(newest).sort((a, b) => a.d - b.d).slice(0, NEAREST);
  return { t: newest, kd: median(near.map((p) => p.kd)), km: near[0].d, n: near.length };
}

async function fetchDataset(ds, loc) {
  const from = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
  const q = `kd_490[(${from}T00:00:00Z):(last)][(0.0)]` +
    `[(${(loc.lat + BOX).toFixed(4)}):(${(loc.lat - BOX).toFixed(4)})]` +
    `[(${(loc.lon - BOX).toFixed(4)}):(${(loc.lon + BOX).toFixed(4)})]`;
  const r = await fetch(`${ERDDAP}/${ds.id}.json?${encodeURI(q).replace(/\[/g, '%5B').replace(/\]/g, '%5D')}`,
    { signal: AbortSignal.timeout(60000) });
  if (r.status === 404) return null;   // ERDDAP: no data in that box (outside the US sector)
  if (!r.ok) throw new Error(`ERDDAP HTTP ${r.status}`);
  const j = await r.json();
  const day = pickDay(j.table.rows, loc);
  return day && { ...day, sat: ds.sat };
}

export async function viirsClarity(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('lat and lon required');
  const loc = { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
  const key = `${loc.lat},${loc.lon}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 3600000) return hit.out;
  const got = await Promise.allSettled(DATASETS.map((ds) => fetchDataset(ds, loc)));
  const found = got.filter((g) => g.status === 'fulfilled' && g.value).map((g) => g.value);
  if (!found.length && got.every((g) => g.status === 'rejected')) throw new Error(got[0].reason.message);
  found.sort((a, b) => (a.t < b.t ? 1 : -1));
  const out = { source: 'NOAA VIIRS 750 m', reading: found[0] || null, days: DAYS };
  cache.set(key, { at: Date.now(), out });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return out;
}
