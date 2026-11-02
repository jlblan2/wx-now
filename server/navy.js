// Serves the Navy (FNMOC) forecasts that navy/fetch_navy.py prepares: point forecasts
// for the "second opinion" card, and wave-height map images and arrows for the map.
import fs from 'node:fs';
import path from 'node:path';

let loaded = null;   // { cycle, meta, data: Int16Array, dir, checked }

function load(root) {
  if (loaded && Date.now() - loaded.checked < 60000) return loaded;
  try {
    const { cycle } = JSON.parse(fs.readFileSync(path.join(root, 'latest.json'), 'utf8'));
    if (!loaded || loaded.cycle !== cycle) {
      const dir = path.join(root, cycle);
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      const buf = fs.readFileSync(path.join(dir, 'data.bin'));
      const data = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
      loaded = { cycle, meta, data, dir };
    }
    loaded.checked = Date.now();
  } catch {
    if (loaded) loaded.checked = Date.now();
  }
  return loaded;
}

export function navyMeta(root) {
  const n = load(root);
  if (!n) throw new Error('Navy forecast not available yet');
  const { cycle, base, steps, bounds, source } = n.meta;
  return { cycle, base, steps, bounds, source };
}

// Time series at the grid point nearest (lat, lon). Waves use the nearest sea point
// within about 1 degree, since coastal cells are often land in a 0.5 degree grid.
export function navyPoint(root, lat, lon) {
  const n = load(root);
  if (!n) throw new Error('Navy forecast not available yet');
  const m = n.meta;
  const ns = m.steps.length, plane = m.nlat * m.nlon;
  const i = Math.round((lat - m.lat0) / m.res), j = Math.round((lon - m.lon0) / m.res);
  if (i < 0 || j < 0 || i >= m.nlat || j >= m.nlon) throw new Error('Outside the Navy forecast area');
  const at = (vi, si, ii, jj) => n.data[(vi * ns + si) * plane + ii * m.nlon + jj];
  const series = {};
  m.vars.forEach((v, vi) => {
    let ii = i, jj = j;
    if (['swh', 'per', 'dir'].includes(v.name) && at(vi, 0, i, j) === m.missing) {
      let best = null;
      for (let di = -2; di <= 2; di++) {
        for (let dj = -2; dj <= 2; dj++) {
          const a = i + di, b = j + dj;
          if (a < 0 || b < 0 || a >= m.nlat || b >= m.nlon || at(vi, 0, a, b) === m.missing) continue;
          const d = di * di + dj * dj;
          if (!best || d < best.d) best = { d, a, b };
        }
      }
      if (best) { ii = best.a; jj = best.b; } else { ii = -1; }
    }
    series[v.name] = m.steps.map((_, si) => {
      if (ii < 0) return null;
      const raw = at(vi, si, ii, jj);
      return raw === m.missing ? null : Math.round(raw * v.scale * 100) / 100;
    });
  });
  return { cycle: m.cycle, base: m.base, steps: m.steps, units: m.units, series };
}

// Past day-ahead forecasts at the grid point nearest (lat, lon): one entry per saved run,
// oldest first, for the History part of the card. Reads only the values it needs.
export function navyHistory(root, lat, lon) {
  const dir = path.join(root, 'hist');
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { throw new Error('Navy history not collected yet'); }
  const i = Math.round((lat - m.lat0) / m.res), j = Math.round((lon - m.lon0) / m.res);
  if (i < 0 || j < 0 || i >= m.nlat || j >= m.nlon) throw new Error('Outside the Navy forecast area');
  const ns = m.steps.length, plane = m.nlat * m.nlon;
  const cell = Buffer.alloc(2);
  const runs = fs.readdirSync(dir).filter((f) => /^\d{10}\.bin$/.test(f)).sort().map((f) => {
    const fd = fs.openSync(path.join(dir, f), 'r');
    try {
      const series = {};
      m.vars.forEach((v, vi) => {
        series[v.name] = m.steps.map((_, si) => {
          fs.readSync(fd, cell, 0, 2, ((vi * ns + si) * plane + i * m.nlon + j) * 2);
          const raw = cell.readInt16LE(0);
          return raw === m.missing ? null : Math.round(raw * v.scale * 100) / 100;
        });
      });
      const c = f.slice(0, 10);
      return { base: `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}T${c.slice(8)}:00:00Z`, series };
    } finally {
      fs.closeSync(fd);
    }
  });
  return { steps: m.steps, units: m.units, runs };
}

// Map files: waves_NNN.png and arrows_NNN.json of the current or previous cycle.
export function navyFile(root, cycle, name) {
  if (!/^\d{10}$/.test(cycle) || !/^(waves_\d{3}\.png|arrows_\d{3}\.json)$/.test(name)) return null;
  const file = path.join(root, cycle, name);
  return fs.existsSync(file) ? file : null;
}
