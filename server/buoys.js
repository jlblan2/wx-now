// Latest buoy and coastal station observations from NOAA's National Data Buoy Center:
// one file (latest_obs.txt) holds every station's newest report, so a single request every
// 30 minutes covers them all. Kept: Atlantic-side stations (no Pacific) with water
// temperature, waves or wind; names come from NDBC's station table (refreshed daily).

const LATEST = 'https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt';
const TABLE = 'https://www.ndbc.noaa.gov/data/stations/station_table.txt';
const UA = { 'User-Agent': 'NextHour alert server (github.com/jlblan2/next-hour)' };
const AREA = { lat0: 8, lat1: 47, lon0: -100, lon1: -58 };

// Pacific side of Central America and Mexico, which falls inside the box above.
const PACIFIC = [[-100, 0], [-80.2, 0], [-77.6, 4], [-77.7, 6.6], [-78.3, 7.9], [-79.2, 8.3], [-80.1, 7.3], [-81.9, 8.1],
  [-83.4, 8.5], [-84.6, 9.4], [-85.9, 10.5], [-87.3, 12.4], [-88.6, 13.1], [-90.6, 13.8], [-92.5, 14.4], [-94.3, 16],
  [-96.6, 15.6], [-98.7, 16.3], [-100, 17.0]];
function inPacific(lat, lon) {
  let inside = false;
  for (let i = 0, j = PACIFIC.length - 1; i < PACIFIC.length; j = i++) {
    const [xi, yi] = PACIFIC[i], [xj, yj] = PACIFIC[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

let names = { at: 0, map: new Map() };
let snapshot = { at: null, stations: [] };

async function getText(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`NDBC ${r.status}`);
  return r.text();
}

async function stationNames() {
  if (Date.now() - names.at < 24 * 3600000 && names.map.size) return names.map;
  try {
    const map = new Map();
    for (const line of (await getText(TABLE)).split('\n')) {
      if (line.startsWith('#')) continue;
      const f = line.split('|');
      if (f.length > 4 && f[0].trim()) map.set(f[0].trim().toUpperCase(), f[4].trim());
    }
    names = { at: Date.now(), map };
  } catch { /* keep the old names */ }
  return names.map;
}

const num = (v) => (v === 'MM' || v === undefined ? null : +v);

export async function refreshBuoys() {
  const [text, nm] = await Promise.all([getText(LATEST), stationNames()]);
  const lines = text.split('\n');
  const hdr = lines[0].replace(/^#/, '').trim().split(/\s+/);
  const col = Object.fromEntries(hdr.map((h, i) => [h, i]));
  const out = [];
  for (const line of lines) {
    if (!line.trim() || line.startsWith('#')) continue;
    const f = line.trim().split(/\s+/);
    const lat = +f[col.LAT], lon = +f[col.LON];
    if (!(lat >= AREA.lat0 && lat <= AREA.lat1 && lon >= AREA.lon0 && lon <= AREA.lon1) || inPacific(lat, lon)) continue;
    const t = Date.UTC(+f[col.YYYY], +f[col.MM] - 1, +f[col.DD], +f[col.hh], +f[col.mm]);
    if (Date.now() - t > 6 * 3600000) continue;   // not reporting
    const s = {
      id: f[col.STN], name: nm.get(f[col.STN].toUpperCase()) || '', lat, lon, t,
      wtmp: num(f[col.WTMP]), atmp: num(f[col.ATMP]),
      wvht: num(f[col.WVHT]), dpd: num(f[col.DPD]), mwd: num(f[col.MWD]),
      wdir: num(f[col.WDIR]), wspd: num(f[col.WSPD]), gst: num(f[col.GST]), pres: num(f[col.PRES]),
    };
    if (s.wtmp !== null || s.wvht !== null || s.wspd !== null) out.push(s);
  }
  snapshot = { at: new Date().toISOString(), stations: out };
  return snapshot;
}

export const buoySnapshot = () => snapshot;
