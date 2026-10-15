#!/usr/bin/env python3
"""Navy (FNMOC) forecasts for Next Hour, from NOAA NOMADS.

Downloads the latest complete run (0-120 h: 3-hourly to 24 h, then 6-hourly) of
  - NAVGEM, the Navy's global weather model (temperature, wind, rain, pressure), and
  - the Navy WAVEWATCH III wave ensemble control member (wave height, period, direction),
cuts out the US region, and writes for the alert server:
  OUT/<cycle>/data.bin      int16 grids [var][step][row][col] (see meta.json for scales)
  OUT/<cycle>/meta.json     grid, steps, variables
  OUT/<cycle>/waves_<h>.png wave height in Web Mercator for the map
  OUT/<cycle>/arrows_<h>.json wave direction samples
  OUT/latest.json           which cycle is current
Runs from a timer; does nothing if the newest run is already processed.
"""
import datetime as dt
import json
import math
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.request

import eccodes as ec
import numpy as np
from PIL import Image

NOMADS = 'https://nomads.ncep.noaa.gov/pub/data/nccf/com/fnmoc/prod'
OUT = os.environ.get('NAVY_DIR', '/var/lib/next-hour/navy')
UA = {'User-Agent': 'NextHour alert server (github.com/jlblan2/next-hour)'}
STEPS = [int(x) for x in os.environ['NAVY_STEPS'].split(',')] if os.environ.get('NAVY_STEPS') else list(range(0, 24, 3)) + list(range(24, 121, 6))   # NAVGEM is 3-hourly to 24 h, then 6-hourly
LAT0, LAT1, LON0, LON1 = 0.0, 60.0, -130.0, -50.0   # region (0.5 degree grid)
RES = 0.5
KEEP_CYCLES = 2

# name: (source, match, scale) — values are stored as round(value / scale) in int16
VARS = {
    't2m':  ('navgem', {'shortName': '2t'}, 0.1),
    'u10':  ('navgem', {'shortName': '10u'}, 0.1),
    'v10':  ('navgem', {'shortName': '10v'}, 0.1),
    'mslp': ('navgem', {'shortName': 'prmsl'}, 10.0),
    'apcp': ('navgem', {'discipline': 0, 'parameterCategory': 1, 'parameterNumber': 8}, 0.1),
    'swh':  ('wave', {'discipline': 10, 'parameterCategory': 0, 'parameterNumber': 3}, 0.01),
    'per':  ('wave', {'discipline': 10, 'parameterCategory': 0, 'parameterNumber': 34}, 0.1),
    'dir':  ('wave', {'discipline': 10, 'parameterCategory': 0, 'parameterNumber': 10}, 1.0),
}
MISSING = -32768


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def get(url, dest=None, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=120) as r:
                if dest is None:
                    return r.read()
                with open(dest, 'wb') as f:
                    shutil.copyfileobj(r, f, 1 << 20)
                return dest
        except Exception as e:  # noqa: BLE001 - retry any network failure
            if i == tries - 1:
                raise
            log('retry', url, e)
            time.sleep(10 * (i + 1))


def listing(url):
    return set(re.findall(r'href="([^"?/][^"]*)"', get(url).decode('latin1')))


def nav_url(cycle, h):
    return f'{NOMADS}/navgem.{cycle[:8]}/navgem_{cycle}f{h:03d}.grib2'


def wave_url(cycle, h):
    return f'{NOMADS}/fens_wave.{cycle[:8]}/{cycle[8:]}/ENSEMBLE.halfDegree.OCN.fcst_et000.{h:03d}.{cycle}'


def latest_complete_cycle():
    """Newest cycle whose last NAVGEM and wave files are both posted."""
    now = dt.datetime.now(dt.timezone.utc)
    for back in range(0, 4):
        day = (now - dt.timedelta(days=back)).strftime('%Y%m%d')
        try:
            nav = listing(f'{NOMADS}/navgem.{day}/')
        except Exception:  # noqa: BLE001
            continue
        for hh in ('12', '00'):
            cycle = day + hh
            if f'navgem_{cycle}f{STEPS[-1]:03d}.grib2' not in nav:
                continue
            try:
                waves = listing(f'{NOMADS}/fens_wave.{day}/{hh}/')
            except Exception:  # noqa: BLE001
                continue
            if f'ENSEMBLE.halfDegree.OCN.fcst_et000.{STEPS[-1]:03d}.{cycle}' in waves:
                return cycle
    return None


def region_index():
    rows = np.arange(int(round((LAT0 + 90) / RES)), int(round((LAT1 + 90) / RES)) + 1)
    cols = np.arange(int(round((LON0 % 360) / RES)), int(round((LON1 % 360) / RES)) + 1)
    return rows, cols


def matches(h, want):
    for k, v in want.items():
        if not ec.codes_is_defined(h, k) or ec.codes_get(h, k) != v:
            return False
    return True


def extract(path, source, rows, cols):
    """Region grids for every variable of this source found in the GRIB file."""
    found = {}
    with open(path, 'rb') as f:
        while True:
            h = ec.codes_grib_new_from_file(f)
            if h is None:
                break
            try:
                for name, (src, want, _) in VARS.items():
                    if src != source or name in found or not matches(h, want):
                        continue
                    ni, nj = ec.codes_get(h, 'Ni'), ec.codes_get(h, 'Nj')
                    vals = ec.codes_get_values(h).reshape(nj, ni)
                    if ec.codes_get(h, 'jScansPositively') == 0:   # north to south: flip to south-first
                        vals = vals[::-1]
                    miss = ec.codes_get(h, 'missingValue') if ec.codes_is_defined(h, 'missingValue') else None
                    grid = vals[np.ix_(rows, cols)].astype(np.float64)
                    if miss is not None:
                        grid[grid == miss] = np.nan
                    found[name] = grid
            finally:
                ec.codes_release(h)
    return found


# ---------- map products ----------

WAVE_COLORS = [   # (feet, rgba)
    (0, (40, 90, 200, 150)), (2, (60, 150, 230, 170)), (4, (40, 200, 200, 185)),
    (6, (90, 210, 90, 195)), (8, (240, 220, 60, 205)), (12, (250, 140, 40, 215)),
    (16, (230, 50, 40, 225)), (25, (190, 40, 190, 235)),
]


def colorize(ft):
    out = np.zeros(ft.shape + (4,), np.uint8)
    xs = np.array([c[0] for c in WAVE_COLORS], float)
    for ch in range(4):
        ys = np.array([c[1][ch] for c in WAVE_COLORS], float)
        out[..., ch] = np.interp(np.nan_to_num(ft, nan=0), xs, ys)
    out[np.isnan(ft)] = 0
    return out


def mercator_y(lat):
    return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def wave_png(swh_m, path, width=640):
    """Wave height, reprojected to Web Mercator so it lines up with the map."""
    nlat, nlon = swh_m.shape
    y0, y1 = mercator_y(LAT0), mercator_y(LAT1)
    height = int(round(width * (y1 - y0) / math.radians(LON1 - LON0)))
    ys = y1 - (np.arange(height) + 0.5) / height * (y1 - y0)          # top row first
    lats = np.degrees(2 * np.arctan(np.exp(ys)) - math.pi / 2)
    lons = LON0 + (np.arange(width) + 0.5) / width * (LON1 - LON0)
    fi = (lats - LAT0) / RES
    fj = (lons - LON0) / RES
    i0 = np.clip(np.floor(fi).astype(int), 0, nlat - 2)
    j0 = np.clip(np.floor(fj).astype(int), 0, nlon - 2)
    ti, tj = (fi - i0)[:, None], (fj - j0)[None, :]
    g = swh_m
    a, b = g[i0][:, j0], g[i0][:, j0 + 1]
    c, d = g[i0 + 1][:, j0], g[i0 + 1][:, j0 + 1]
    stack = np.stack([a, b, c, d])
    w = np.stack([(1 - ti) * (1 - tj), (1 - ti) * tj, ti * (1 - tj), ti * tj])
    valid = ~np.isnan(stack)
    wsum = (w * valid).sum(0)
    val = np.where(wsum > 0.5, np.nansum(np.where(valid, stack, 0) * w, 0) / np.maximum(wsum, 1e-9), np.nan)
    Image.fromarray(colorize(val * 3.28084), 'RGBA').save(path, optimize=True)


def arrows(swh, per, dirs, every=4):
    out = []
    for i in range(0, swh.shape[0], every):
        for j in range(0, swh.shape[1], every):
            if np.isnan(swh[i, j]) or np.isnan(dirs[i, j]):
                continue
            out.append([round(LAT0 + i * RES, 2), round(LON0 + j * RES, 2), round(float(swh[i, j]), 2),
                        int(dirs[i, j]) % 360, None if np.isnan(per[i, j]) else round(float(per[i, j]), 1)])
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    cycle = latest_complete_cycle()
    if not cycle:
        log('no complete cycle found')
        return 0
    latest = os.path.join(OUT, 'latest.json')
    if os.path.exists(latest) and json.load(open(latest)).get('cycle') == cycle:
        log('already have', cycle)
        return 0
    log('processing', cycle)
    rows, cols = region_index()
    shape = (len(VARS), len(STEPS), len(rows), len(cols))
    data = np.full(shape, MISSING, np.int16)
    names = list(VARS)
    work = tempfile.mkdtemp(prefix='navy-')
    final = os.path.join(OUT, cycle)
    tmp_out = final + '.part'
    shutil.rmtree(tmp_out, ignore_errors=True)
    os.makedirs(tmp_out)
    try:
        for si, h in enumerate(STEPS):
            grids = {}
            for source, url in (('navgem', nav_url(cycle, h)), ('wave', wave_url(cycle, h))):
                try:
                    path = get(url, os.path.join(work, source))
                except Exception as e:  # noqa: BLE001 - one missing file leaves a gap, not a failed run
                    log('skip', url, e)
                    continue
                grids.update(extract(path, source, rows, cols))
                os.remove(path)
            for vi, name in enumerate(names):
                g = grids.get(name)
                if g is None:
                    continue
                scaled = np.clip(np.round(g / VARS[name][2]), -32767, 32767)
                scaled[np.isnan(scaled)] = MISSING
                data[vi, si] = scaled.astype(np.int16)
            if 'swh' in grids:
                wave_png(grids['swh'], os.path.join(tmp_out, f'waves_{h:03d}.png'))
                if 'dir' in grids:
                    json.dump(arrows(grids['swh'], grids.get('per', grids['swh'] * np.nan), grids['dir']),
                              open(os.path.join(tmp_out, f'arrows_{h:03d}.json'), 'w'), separators=(',', ':'))
            log(f'f{h:03d}', 'vars', sorted(grids))
        data.tofile(os.path.join(tmp_out, 'data.bin'))
        base = dt.datetime.strptime(cycle, '%Y%m%d%H').replace(tzinfo=dt.timezone.utc)
        meta = {
            'cycle': cycle,
            'base': base.isoformat().replace('+00:00', 'Z'),
            'steps': STEPS,
            'lat0': LAT0, 'lon0': LON0, 'res': RES, 'nlat': len(rows), 'nlon': len(cols),
            'vars': [{'name': n, 'scale': VARS[n][2]} for n in names],
            'missing': MISSING,
            'units': {'t2m': 'K', 'u10': 'm/s', 'v10': 'm/s', 'mslp': 'Pa', 'apcp': 'mm per 6 h ending at step',
                      'swh': 'm', 'per': 's peak period', 'dir': 'deg, waves coming from'},
            'bounds': [[LAT0, LON0], [LAT1, LON1]],
            'source': 'FNMOC NAVGEM and Navy WAVEWATCH III ensemble control (et000), via NOAA NOMADS',
        }
        json.dump(meta, open(os.path.join(tmp_out, 'meta.json'), 'w'))
        shutil.rmtree(final, ignore_errors=True)
        os.rename(tmp_out, final)
        json.dump({'cycle': cycle}, open(latest + '.tmp', 'w'))
        os.replace(latest + '.tmp', latest)
        cycles = sorted(d for d in os.listdir(OUT) if re.fullmatch(r'\d{10}', d))
        for old in cycles[:-KEEP_CYCLES]:
            shutil.rmtree(os.path.join(OUT, old), ignore_errors=True)
        log('done', cycle)
    finally:
        shutil.rmtree(work, ignore_errors=True)
        shutil.rmtree(tmp_out, ignore_errors=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
