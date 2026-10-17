// Sailing weather grids for the app's map: NOAA (GFS + GFS-Wave) files written by
// passage/fetch_gfs.py, and the Navy run (NAVGEM + WAVEWATCH III) re-cut on request
// to the same region and variable layout.
import fs from 'node:fs';
import path from 'node:path';

// Same order and scales as fetch_gfs.py writes.
const VARS = [
  ['u10', 0.1], ['v10', 0.1], ['gust', 0.1], ['mslp', 10], ['prate', 0.01],
  ['vis', 10], ['swh', 0.01], ['per', 0.1], ['dir', 1], ['sst', 0.01],
];
const REGION = { lat0: 8, lat1: 47, lon0: -100, lon1: -58 };   // must match fetch_gfs.py
const MISSING = -32768;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function noaaMeta(root) {
  const latest = readJson(path.join(root, 'latest.json'));
  return latest && readJson(path.join(root, latest.cycle, 'meta.json'));
}

let navyCache = { cycle: null, meta: null, data: null };

function navySource(navyRoot) {
  const latest = readJson(path.join(navyRoot, 'latest.json'));
  if (!latest) return null;
  if (navyCache.cycle !== latest.cycle) {
    const meta = readJson(path.join(navyRoot, latest.cycle, 'meta.json'));
    const buf = fs.readFileSync(path.join(navyRoot, latest.cycle, 'data.bin'));
    navyCache = { cycle: latest.cycle, meta, data: new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2) };
  }
  return navyCache;
}

function navyMetaOut(src) {
  const m = src.meta;
  return {
    model: 'navy', cycle: m.cycle, base: m.base, steps: m.steps,
    lat0: REGION.lat0, lon0: REGION.lon0, res: m.res,
    nlat: Math.round((REGION.lat1 - REGION.lat0) / m.res) + 1,
    nlon: Math.round((REGION.lon1 - REGION.lon0) / m.res) + 1,
    missing: MISSING, vars: VARS.map(([name, scale]) => ({ name, scale })),
    source: m.source,
  };
}

export function passageMeta(passageRoot, navyRoot) {
  let navy = null;
  try { const s = navySource(navyRoot); navy = s && navyMetaOut(s); } catch { /* none yet */ }
  return { noaa: noaaMeta(passageRoot), navy };
}

// One time step for one model, as int16 [var][row][col] bytes (null if unavailable).
export function passageStep(passageRoot, navyRoot, model, cycle, hour) {
  if (!/^\d{10}$/.test(cycle) || !/^\d{3}$/.test(hour)) return null;
  if (model === 'noaa') {
    const file = path.join(passageRoot, cycle, `s_${hour}.bin`);
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  }
  if (model !== 'navy') return null;
  const src = navySource(navyRoot);
  if (!src || src.cycle !== cycle) return null;
  const m = src.meta, out = navyMetaOut(src);
  const si = m.steps.indexOf(+hour);
  if (si < 0) return null;
  const ns = m.steps.length, plane = m.nlat * m.nlon;
  const r0 = Math.round((REGION.lat0 - m.lat0) / m.res), c0 = Math.round((REGION.lon0 - m.lon0) / m.res);
  const navyVar = Object.fromEntries(m.vars.map((v, i) => [v.name, { i, scale: v.scale }]));
  const result = new Int16Array(VARS.length * out.nlat * out.nlon).fill(MISSING);
  VARS.forEach(([name, scale], k) => {
    // Navy rain is a 6-hour total; show it as an average rate like GFS.
    const from = name === 'prate' ? navyVar.apcp : navyVar[name];
    if (!from) return;
    const factor = from.scale / scale / (name === 'prate' ? 6 : 1);
    for (let r = 0; r < out.nlat; r++) {
      for (let c = 0; c < out.nlon; c++) {
        const raw = src.data[(from.i * ns + si) * plane + (r0 + r) * m.nlon + (c0 + c)];
        if (raw !== m.missing) result[(k * out.nlat + r) * out.nlon + c] = Math.max(-32767, Math.min(32767, Math.round(raw * factor)));
      }
    }
  });
  return Buffer.from(result.buffer);
}
