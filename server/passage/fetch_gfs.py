#!/usr/bin/env python3
"""NOAA GFS + GFS-Wave for the Sailing weather maps (US East Coast, Gulf of America,
Bahamas and Caribbean).

Uses the NOMADS grib filter to download only the fields and area needed (8-47N,
100-58W, 0.25 degree), 3-hourly to 168 h, and writes for the alert server:
  OUT/<cycle>/s_<hhh>.bin  int16 [var][row][col], south row first
  OUT/<cycle>/meta.json    grid, steps, variables and scales
  OUT/latest.json          the newest complete cycle
Runs from an hourly timer; does nothing when the newest run is already done.
"""
import datetime as dt
import json
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.parse
import urllib.request

import eccodes as ec
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pacific import pacific_mask  # noqa: E402 - Atlantic side only: Pacific cells are blanked

NOMADS = 'https://nomads.ncep.noaa.gov'
PROD = f'{NOMADS}/pub/data/nccf/com/gfs/prod'
OUT = os.environ.get('PASSAGE_DIR', '/var/lib/wx-now/passage')
UA = {'User-Agent': 'WxNow alert server (github.com/jlblan2/wx-now)'}
LAT0, LAT1, LON0, LON1 = 8.0, 47.0, -100.0, -58.0
RES = 0.25
STEPS = [int(x) for x in os.environ['PASSAGE_STEPS'].split(',')] if os.environ.get('PASSAGE_STEPS') else list(range(0, 169, 3))
KEEP = 2
MISSING = -32768
PAUSE = 0.7      # NOMADS asks for fewer than 120 requests a minute

# name: (source, shortName, stepType or None, scale)
VARS = [
    ('u10', 'gfs', '10u', None, 0.1),
    ('v10', 'gfs', '10v', None, 0.1),
    ('gust', 'gfs', 'gust', None, 0.1),
    ('mslp', 'gfs', 'prmsl', None, 10.0),
    ('prate', 'gfs', 'prate', 'avg', 0.01),     # stored as mm/h
    ('vis', 'gfs', 'vis', None, 10.0),          # m
    ('swh', 'wave', 'swh', None, 0.01),
    ('per', 'wave', 'perpw', None, 0.1),
    ('dir', 'wave', 'dirpw', None, 1.0),
    ('sst', 'gfs', 't', None, 0.01),         # surface temperature over water, deg C
]


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def fetch(url, dest=None, method='GET', tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA, method=method)
            with urllib.request.urlopen(req, timeout=120) as r:
                if dest is None:
                    return r.status
                with open(dest, 'wb') as f:
                    shutil.copyfileobj(r, f, 1 << 20)
                return dest
        except urllib.error.HTTPError as e:
            if e.code == 404 or i == tries - 1:
                raise
        except Exception:  # noqa: BLE001 - retry network trouble
            if i == tries - 1:
                raise
        time.sleep(10 * (i + 1))


def exists(url):
    try:
        return fetch(url, method='HEAD', tries=1) == 200
    except Exception:  # noqa: BLE001
        return False


def latest_complete_cycle():
    now = dt.datetime.now(dt.timezone.utc)
    for back in range(0, 36, 6):
        t = now - dt.timedelta(hours=back)
        day, hh = t.strftime('%Y%m%d'), f'{t.hour // 6 * 6:02d}'
        last = STEPS[-1]
        if (exists(f'{PROD}/gfs.{day}/{hh}/atmos/gfs.t{hh}z.pgrb2.0p25.f{last:03d}') and
                exists(f'{PROD}/gfs.{day}/{hh}/wave/gridded/gfswave.t{hh}z.global.0p25.f{last:03d}.grib2')):
            return day + hh
    return None


def filter_url(cycle, h, source):
    day, hh = cycle[:8], cycle[8:]
    box = {'subregion': '', 'toplat': LAT1, 'bottomlat': LAT0, 'leftlon': LON0 % 360, 'rightlon': LON1 % 360}
    if source == 'gfs':
        q = {'dir': f'/gfs.{day}/{hh}/atmos', 'file': f'gfs.t{hh}z.pgrb2.0p25.f{h:03d}',
             'var_UGRD': 'on', 'var_VGRD': 'on', 'var_GUST': 'on', 'var_PRMSL': 'on', 'var_PRATE': 'on', 'var_VIS': 'on', 'var_TMP': 'on',
             'lev_10_m_above_ground': 'on', 'lev_mean_sea_level': 'on', 'lev_surface': 'on', **box}
        return f'{NOMADS}/cgi-bin/filter_gfs_0p25.pl?{urllib.parse.urlencode(q)}'
    q = {'dir': f'/gfs.{day}/{hh}/wave/gridded', 'file': f'gfswave.t{hh}z.global.0p25.f{h:03d}.grib2',
         'var_HTSGW': 'on', 'var_PERPW': 'on', 'var_DIRPW': 'on', 'lev_surface': 'on', **box}
    return f'{NOMADS}/cgi-bin/filter_gfswave.pl?{urllib.parse.urlencode(q)}'


NLAT = int(round((LAT1 - LAT0) / RES)) + 1
NLON = int(round((LON1 - LON0) / RES)) + 1


def read(path, source):
    """Fields of one source placed on the common grid (south row first)."""
    out = {}
    with open(path, 'rb') as f:
        while True:
            h = ec.codes_grib_new_from_file(f)
            if h is None:
                break
            try:
                short = ec.codes_get(h, 'shortName')
                stype = ec.codes_get(h, 'stepType') if ec.codes_is_defined(h, 'stepType') else None
                for name, src, want, wtype, _ in VARS:
                    if src != source or short != want or name in out:
                        continue
                    if wtype and stype != wtype:
                        continue
                    if not wtype and short == 'prate':
                        continue
                    ni, nj = ec.codes_get(h, 'Ni'), ec.codes_get(h, 'Nj')
                    vals = ec.codes_get_values(h).reshape(nj, ni).astype(np.float64)
                    if ec.codes_get(h, 'jScansPositively') == 0:
                        vals = vals[::-1]
                    if ec.codes_is_defined(h, 'missingValue'):
                        vals[vals == ec.codes_get(h, 'missingValue')] = np.nan
                    lat0 = ec.codes_get(h, 'latitudeOfFirstGridPointInDegrees')
                    lat0 = min(lat0, ec.codes_get(h, 'latitudeOfLastGridPointInDegrees'))
                    lon0 = ec.codes_get(h, 'longitudeOfFirstGridPointInDegrees')
                    lon0 = lon0 - 360 if lon0 > 180 else lon0
                    grid = np.full((NLAT, NLON), np.nan)
                    r0, c0 = int(round((lat0 - LAT0) / RES)), int(round((lon0 - LON0) / RES))
                    rr, cc = min(nj, NLAT - r0), min(ni, NLON - c0)
                    grid[r0:r0 + rr, c0:c0 + cc] = vals[:rr, :cc]
                    if name == 'prate':
                        grid *= 3600.0        # kg m-2 s-1 -> mm/h
                    if name == 'sst':
                        grid -= 273.15        # K -> deg C
                    out[name] = grid
            finally:
                ec.codes_release(h)
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    force = os.environ.get('PASSAGE_FORCE') == '1'   # rebuild even if this run is done
    cycle = latest_complete_cycle()
    if not cycle:
        log('no complete cycle found')
        return 0
    latest = os.path.join(OUT, 'latest.json')
    if not force and os.path.exists(latest) and json.load(open(latest)).get('cycle') == cycle:
        log('already have', cycle)
        return 0
    log('processing', cycle)
    final = os.path.join(OUT, cycle)
    part = final + '.part'
    shutil.rmtree(part, ignore_errors=True)
    os.makedirs(part)
    work = tempfile.mkdtemp(prefix='passage-')
    done = []
    lats, lons = LAT0 + np.arange(NLAT) * RES, LON0 + np.arange(NLON) * RES
    pac = None   # built from the first wave field, so it follows the model's coastline
    try:
        for h in STEPS:
            fields = {}
            for source in ('gfs', 'wave'):
                path = os.path.join(work, source)
                try:
                    fetch(filter_url(cycle, h, source), path)
                    fields.update(read(path, source))
                except Exception as e:  # noqa: BLE001 - a gap, not a failed run
                    log('skip', source, h, e)
                time.sleep(PAUSE)
            if not fields:
                continue
            if pac is None and 'swh' in fields:
                pac = pacific_mask(lats, lons, ~np.isnan(fields['swh']))
            for g in fields.values():
                g[pac if pac is not None else pacific_mask(lats, lons)] = np.nan
            if 'sst' in fields and 'swh' in fields:
                fields['sst'][np.isnan(fields['swh'])] = np.nan   # water only
            data = np.full((len(VARS), NLAT, NLON), MISSING, np.int16)
            for vi, (name, *_rest, scale) in enumerate(VARS):
                g = fields.get(name)
                if g is None:
                    continue
                s = np.clip(np.round(g / scale), -32767, 32767)
                s[np.isnan(s)] = MISSING
                data[vi] = s.astype(np.int16)
            data.tofile(os.path.join(part, f's_{h:03d}.bin'))
            done.append(h)
            if h % 24 == 0:
                log(f'f{h:03d}', sorted(fields))
        base = dt.datetime.strptime(cycle, '%Y%m%d%H').replace(tzinfo=dt.timezone.utc)
        json.dump({
            'model': 'noaa', 'cycle': cycle, 'base': base.isoformat().replace('+00:00', 'Z'), 'steps': done,
            'lat0': LAT0, 'lon0': LON0, 'res': RES, 'nlat': NLAT, 'nlon': NLON, 'missing': MISSING,
            'vars': [{'name': v[0], 'scale': v[4]} for v in VARS],
            'source': 'NOAA GFS 0.25 deg and GFS-Wave (WAVEWATCH III) via NOMADS',
        }, open(os.path.join(part, 'meta.json'), 'w'))
        shutil.rmtree(final, ignore_errors=True)
        os.rename(part, final)
        json.dump({'cycle': cycle}, open(latest + '.tmp', 'w'))
        os.replace(latest + '.tmp', latest)
        for old in sorted(d for d in os.listdir(OUT) if re.fullmatch(r'\d{10}', d))[:-KEEP]:
            shutil.rmtree(os.path.join(OUT, old), ignore_errors=True)
        log('done', cycle, len(done), 'steps')
    finally:
        shutil.rmtree(work, ignore_errors=True)
        shutil.rmtree(part, ignore_errors=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
