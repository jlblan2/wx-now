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

// Map files: waves_NNN.png and arrows_NNN.json of the current or previous cycle.
export function navyFile(root, cycle, name) {
  if (!/^\d{10}$/.test(cycle) || !/^(waves_\d{3}\.png|arrows_\d{3}\.json)$/.test(name)) return null;
  const file = path.join(root, cycle, name);
  return fs.existsSync(file) ? file : null;
}
