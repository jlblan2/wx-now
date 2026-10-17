#!/usr/bin/env python3
"""Lightning flashes from NOAA's GOES-19 Geostationary Lightning Mapper (GLM), for Wx Now.

Reads the 20-second GLM L2 flash files on the public noaa-goes19 S3 bucket that are newer
than the last file processed, and prints JSON: {"last": <newest file key>, "flashes":
[[time_ms, lat, lon], ...]} for good-quality flashes in the app's area (8-47N, 100-58W).
Usage: glm.py [last-key]   (no key = the last 10 minutes)
"""
import io, json, sys, time, urllib.request, re
from datetime import datetime, timedelta, timezone
import h5py
import numpy as np

BUCKET = 'https://noaa-goes19.s3.amazonaws.com'
PREFIX = 'GLM-L2-LCFA'
LAT0, LAT1, LON0, LON1 = 8, 47, -100, -58
UA = {'User-Agent': 'WxNow alert server (github.com/jlblan2/wx-now)'}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        return r.read()


def keys(hour):
    prefix = f'{PREFIX}/{hour:%Y/%j/%H}/'
    xml = get(f'{BUCKET}/?list-type=2&prefix={prefix}').decode()
    return re.findall(r'<Key>([^<]+\.nc)</Key>', xml)


def start_ms(key):
    m = re.search(r'_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)', key)
    y, j, h, mi, s, t = (int(x) for x in m.groups())
    d = datetime(y, 1, 1, tzinfo=timezone.utc) + timedelta(days=j - 1, hours=h, minutes=mi, seconds=s + t / 10)
    return int(d.timestamp() * 1000)


def main():
    last = sys.argv[1] if len(sys.argv) > 1 else ''
    now = datetime.now(timezone.utc)
    todo = sorted(set(keys(now - timedelta(hours=1)) + keys(now)))
    if last:
        todo = [k for k in todo if k.rsplit('/', 1)[-1] > last.rsplit('/', 1)[-1]]
    else:
        cutoff = int(time.time() * 1000) - 10 * 60000
        todo = [k for k in todo if start_ms(k) >= cutoff]
    todo = todo[-45:]   # never more than 15 minutes in one go
    flashes = []
    for k in todo:
        try:
            with h5py.File(io.BytesIO(get(f'{BUCKET}/{k}')), 'r') as f:
                lat = f['flash_lat'][:].astype(float)
                lon = f['flash_lon'][:].astype(float)
                q = f['flash_quality_flag'][:] if 'flash_quality_flag' in f else np.zeros(len(lat))
        except Exception as e:   # a bad or half-written file: skip it
            print(f'skip {k}: {e}', file=sys.stderr)
            continue
        t = start_ms(k)
        keep = (q == 0) & (lat >= LAT0) & (lat <= LAT1) & (lon >= LON0) & (lon <= LON1)
        flashes += [[t, round(a, 3), round(b, 3)] for a, b in zip(lat[keep], lon[keep])]
    print(json.dumps({'last': todo[-1] if todo else last, 'files': len(todo), 'flashes': flashes}))


if __name__ == '__main__':
    main()
