// The most local radar data: each radar's own lowest-tilt reflectivity scans, from NOAA's
// public NEXRAD Level III feed on AWS, instead of the national 5-minute mosaic.
//   - TDWR (Terminal Doppler Weather Radar, at major airports): product TZ0, a 0.3 degree scan
//     every minute, 150 m gates out to 89 km. Lower beam and much fresher than NEXRAD.
//   - NEXRAD: product N0B (super-resolution base reflectivity), 0.5 degree scan every 4-6
//     minutes, 250 m gates.
// Scans are put onto the app's map grid so the same tracking runs on them.

import { bunzip2 } from './bzip2.js';
import { NEXRAD_SITES, TDWR_SITES } from './data.js';
import { toLatLon, toPixel } from './radar.js';

const BUCKET = 'https://unidata-nexrad-level3.s3.amazonaws.com';
const GATE_KM = { 94: 1, 153: 0.25, 180: 0.15, 186: 0.3 };
// How far each kind of radar is used from its site (km). Beyond that, a farther source fills in.
export const SOURCES = {
  tdwr: { product: 'TZ0', rangeKm: 80, label: 'airport TDWR', every: 1 },
  nexrad: { product: 'N0B', rangeKm: 230, label: 'NEXRAD', every: 5 },
};
let TDWR_MAX_KM = 60;   // use an airport TDWR for a place within this distance of it
export const setTdwrMaxKm = (km) => { TDWR_MAX_KM = km; };   // 0 = never (for tests)

const dist = (lat1, lon1, lat2, lon2) => {
  const r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
};
const bearing = (lat1, lon1, lat2, lon2) => {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
};

// The radars to use for a place, most local first: the nearest airport TDWR if it is close,
// then the nearest NEXRAD. Each: { kind, id, lat, lon, km (from the place), product, rangeKm }.
export function localSources(lat, lon) {
  const near = (list) => list.map(([id, a, b]) => ({ id, lat: a, lon: b, km: dist(lat, lon, a, b) })).sort((x, y) => x.km - y.km)[0];
  const out = [];
  const t = near(TDWR_SITES), n = near(NEXRAD_SITES);
  if (t && t.km <= TDWR_MAX_KM && t.km < n.km) out.push({ kind: 'tdwr', ...t, ...SOURCES.tdwr });
  if (n && n.km <= SOURCES.nexrad.rangeKm) out.push({ kind: 'nexrad', ...n, ...SOURCES.nexrad });
  return out;
}

// ---------- reading a Level III product ----------

// { lat, lon, product, elevDeg, time (ms, scan start), gateKm, nbins, min, inc, radials: [{ az, daz, data }] }
export function parseLevel3(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = -1;
  for (let o = 0; o < 80; o++) {   // skip the WMO/AWIPS text header
    const code = dv.getInt16(o);
    if (code >= 16 && code <= 211 && dv.getInt16(o + 18) === -1) { off = o; break; }
  }
  if (off < 0) throw new Error('not a Level III product');
  const p = off + 18;                                  // product description block (halfword 10)
  const hw = (n) => p + 2 * (n - 10);
  const product = dv.getInt16(hw(16));
  const volDate = dv.getUint16(hw(21)), volSec = dv.getUint32(hw(22));
  const info = {
    lat: dv.getInt32(hw(11)) / 1000, lon: dv.getInt32(hw(13)) / 1000, product,
    elevDeg: dv.getInt16(hw(30)) / 10,
    time: (volDate - 1) * 86400000 + volSec * 1000,
    min: dv.getInt16(hw(31)) / 10, inc: dv.getInt16(hw(32)) / 10,
    gateKm: GATE_KM[product],
  };
  if (!info.gateKm) throw new Error(`unsupported product ${product}`);
  let body = bytes.subarray(off + 120);
  if (dv.getUint16(hw(51)) === 1) body = bunzip2(body, (dv.getUint16(hw(52)) << 16) | dv.getUint16(hw(53)));
  const bv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  // symbology block: divider, id, length, layers; layer divider, length; packet 16
  const k = 16;
  if (bv.getInt16(k) !== 16) throw new Error(`unexpected packet ${bv.getInt16(k)}`);
  info.nbins = bv.getInt16(k + 4);
  const nrad = bv.getInt16(k + 12);
  let q = k + 14;
  info.radials = [];
  for (let r = 0; r < nrad; r++) {
    const n = bv.getInt16(q), az = bv.getInt16(q + 2) / 10, daz = bv.getInt16(q + 4) / 10;
    info.radials.push({ az, daz, data: body.subarray(q + 6, q + 6 + n) });
    q += 6 + n + (n % 2);   // radials are padded to whole halfwords
  }
  return info;
}

// ---------- fetching ----------

async function fetchTimeout(url, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r;
  } finally { clearTimeout(timer); }
}

const pad = (n) => String(n).padStart(2, '0');
const hourPrefix = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}_${pad(d.getUTCMonth() + 1)}_${pad(d.getUTCDate())}_${pad(d.getUTCHours())}`; };
const keyTime = (key) => {
  const m = key.match(/_(\d{4})_(\d\d)_(\d\d)_(\d\d)_(\d\d)_(\d\d)$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
};

const listCache = new Map();   // prefix -> { at, keys }
// Keys of a radar's product files between `from` and `to` (ms), oldest first.
export async function listScans(src, from, to = Date.now()) {
  const keys = [];
  for (let h = Math.floor(from / 3600000) * 3600000; h <= to; h += 3600000) {
    const prefix = `${src.id}_${src.product}_${hourPrefix(h)}`;
    const hit = listCache.get(prefix);
    const fresh = hit && (Date.now() - hit.at < 45000 || h + 3600000 < Date.now() - 600000);
    let list = fresh ? hit.keys : null;
    if (!list) {
      const xml = await (await fetchTimeout(`${BUCKET}/?list-type=2&prefix=${prefix}`, 15000)).text();
      list = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
      listCache.set(prefix, { at: Date.now(), keys: list });
      if (listCache.size > 300) listCache.delete(listCache.keys().next().value);
    }
    keys.push(...list);
  }
  return keys.map((key) => ({ key, t: keyTime(key) })).filter((k) => k.t >= from && k.t <= to).sort((a, b) => a.t - b.t);
}

const scanCache = new Map();   // key -> Promise<parsed>
export function fetchScan(key) {
  if (!scanCache.has(key)) {
    const p = fetchTimeout(`${BUCKET}/${key}`, 20000).then((r) => r.arrayBuffer()).then(parseLevel3);
    scanCache.set(key, p);
    p.catch(() => scanCache.delete(key));
    if (scanCache.size > 40) scanCache.delete(scanCache.keys().next().value);
  }
  return scanCache.get(key);
}

// ---------- onto the map grid ----------

const geomCache = new Map();   // grid key + site -> { az (0.1 deg), rangeKm } per pixel
function geometry(g, src) {
  const key = `${g.key}|${src.id}`;
  if (geomCache.has(key)) return geomCache.get(key);
  const az = new Int16Array(g.w * g.h), rng = new Float32Array(g.w * g.h);
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      const p = toLatLon(g, x, y), i = y * g.w + x;
      rng[i] = dist(src.lat, src.lon, p.lat, p.lon);
      az[i] = Math.round(bearing(src.lat, src.lon, p.lat, p.lon) * 10) % 3600;
    }
  }
  const out = { az, rng };
  if (geomCache.size > 8) geomCache.delete(geomCache.keys().next().value);
  geomCache.set(key, out);
  return out;
}

// Reflectivity on the grid from one scan: dbz (NaN = no echo) and covered (1 where the scan
// is used: within the source's range). Pixels not covered are left for a farther source.
// Every range gate is dropped into the map pixel it falls in and the pixel takes the
// strongest (agg 'max') or the average (agg 'mean', of linear Z) of its gates; pixels that no
// gate centre reaches (far out, where beams are wider than a pixel) take the nearest gate.
// Gates the radar could not measure (code 1: range folded, common on fast-scanning TDWRs)
// do not count, and a pixel with only such gates is left for the next source to fill.
// merge: where an earlier (more local) source already covers a pixel, keep the stronger of the
// two readings instead of skipping it (TDWR + NEXRAD: TDWR signal is weakened behind heavy rain).
export function scanToGrid(g, src, scan, dbz, covered, agg = 'max', merge = false) {
  const { az, rng } = geometry(g, src);
  const n = g.w * g.h;
  const maxKm = Math.min(src.rangeKm, scan.nbins * scan.gateKm);
  const acc = new Float32Array(n), cnt = new Uint16Array(n);
  const o = toPixel(g, src.lat, src.lon);
  const pxKm0 = g.dx / Math.cos(((g.bounds[0][0] + g.bounds[1][0]) / 2) * Math.PI / 180);   // km per pixel / cos(lat)
  const last = Math.min(scan.nbins, Math.ceil(maxKm / scan.gateKm));
  for (const r of scan.radials) {
    const sub = Math.max(1, Math.round(r.daz * 2));   // half-degree steps across wide beams
    for (let s2 = 0; s2 < sub; s2++) {
      const a = (r.az + (s2 + 0.5) * r.daz / sub) * Math.PI / 180, sa = Math.sin(a), ca = Math.cos(a);
      for (let k = 0; k < last; k++) {
        const v = r.data[k];
        const km = (k + 0.5) * scan.gateKm;
        const north = km * ca, east = km * sa;
        const scale = pxKm0 * Math.cos((src.lat + north / 111.2) * Math.PI / 180);
        const x = Math.round(o.x + east / scale), y = Math.round(o.y - north / scale);
        if (x < 0 || y < 0 || x >= g.w || y >= g.h) continue;
        const i = y * g.w + x;
        if (v === 1) continue;   // not measured
        cnt[i]++;
        if (v < 2) continue;
        const d = scan.min + (v - 2) * scan.inc;
        if (agg === 'max') { if (d > acc[i] || acc[i] === 0) acc[i] = d; } else acc[i] += 10 ** (d / 10);
      }
    }
  }
  const radialAt = new Int16Array(3600).fill(-1);
  scan.radials.forEach((r, idx) => {
    const a0 = Math.round(r.az * 10), m = Math.max(1, Math.round(r.daz * 10));
    for (let k = 0; k < m; k++) radialAt[(a0 + k) % 3600] = idx;
  });
  for (let i = 0; i < n; i++) {
    if ((covered[i] && !merge) || rng[i] > maxKm) continue;
    if (cnt[i]) {
      const v = agg === 'max' ? (acc[i] === 0 ? NaN : acc[i]) : (acc[i] > 0 ? 10 * Math.log10(acc[i] / cnt[i]) : NaN);
      if (covered[i]) { if (v > dbz[i] || (Number.isNaN(dbz[i]) && !Number.isNaN(v))) dbz[i] = v; continue; }
      covered[i] = 1;
      dbz[i] = v;
      continue;
    }
    if (covered[i]) continue;
    const ri = radialAt[az[i]];
    if (ri < 0) continue;
    const v = scan.radials[ri].data[Math.floor(rng[i] / scan.gateKm)];
    if (v === 1 || v === undefined) continue;   // not measured: leave for the next source
    covered[i] = 1;
    dbz[i] = v >= 2 ? scan.min + (v - 2) * scan.inc : NaN;
  }
}
