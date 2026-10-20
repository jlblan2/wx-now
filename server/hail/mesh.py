#!/usr/bin/env python3
"""Radar-estimated hail for Wx Now: NOAA MRMS MESH (Maximum Estimated Size of Hail), the
maximum over the last 30 minutes, from the public noaa-mrms-pds S3 bucket (every 2 minutes).

Prints JSON: {"file": <key>, "time": <ms>, "hail": [[lat, lon, size_mm], ...]} for every grid
cell (0.01 deg) in the app's area with hail of at least MIN_MM (default 15 mm, ~0.6 in).
Usage: mesh.py [min_mm]

MRMS packs the 7000 x 3500 grid as a 16-bit PNG inside the GRIB2 message (data template
5.41), so this reads the GRIB2 sections directly and decodes the PNG with Pillow: about a
quarter of the memory of unpacking the whole grid to doubles with eccodes.
"""
import gzip, io, json, re, struct, sys, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone
import numpy as np
from PIL import Image

BUCKET = 'https://noaa-mrms-pds.s3.amazonaws.com'
PREFIX = 'CONUS/MESH_Max_30min_00.50'
LAT0, LAT1, LON0, LON1 = 8, 47, -100, -58
UA = {'User-Agent': 'WxNow alert server (github.com/jlblan2/wx-now)'}
Image.MAX_IMAGE_PIXELS = None


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read()


def latest_key():
    now = datetime.now(timezone.utc)
    for day in (now, now - timedelta(days=1)):
        base = f'{BUCKET}/?list-type=2&prefix={PREFIX}/{day:%Y%m%d}/'
        xml = get(base).decode()
        keys = re.findall(r'<Key>([^<]+\.grib2\.gz)</Key>', xml)
        while '<IsTruncated>true</IsTruncated>' in xml:   # more than 1,000 files in a day
            token = re.search(r'<NextContinuationToken>([^<]+)<', xml).group(1)
            xml = get(f'{base}&continuation-token={urllib.parse.quote(token)}').decode()
            keys += re.findall(r'<Key>([^<]+\.grib2\.gz)</Key>', xml)
        if keys:
            return sorted(keys)[-1]
    return None


def signed(v, bits):
    """GRIB2 sign-and-magnitude integer."""
    return -(v & ((1 << (bits - 1)) - 1)) if v >> (bits - 1) else v


def sections(msg):
    pos = 16   # section 0
    while pos < len(msg) - 4:
        if msg[pos:pos + 4] == b'7777':
            return
        n = struct.unpack('>I', msg[pos:pos + 4])[0]
        yield msg[pos + 4], msg[pos:pos + n]
        pos += n


def decode(msg):
    s = {num: body for num, body in sections(msg)}
    g = s[3]
    ni, nj = struct.unpack('>II', g[30:38])
    la1 = signed(struct.unpack('>I', g[46:50])[0], 32) / 1e6
    lo1 = struct.unpack('>I', g[50:54])[0] / 1e6
    di, dj = struct.unpack('>II', g[63:71])
    r5 = s[5]
    template = struct.unpack('>H', r5[9:11])[0]
    if template != 41:
        raise ValueError(f'unexpected GRIB2 packing template {template}')
    ref = struct.unpack('>f', r5[11:15])[0]
    e = signed(struct.unpack('>H', r5[15:17])[0], 16)
    d = signed(struct.unpack('>H', r5[17:19])[0], 16)
    if s[6][5] != 255:
        raise ValueError('bitmaps are not supported')
    img = np.asarray(Image.open(io.BytesIO(s[7][5:])))
    return img.reshape(nj, ni), ref, e, d, la1, (lo1 + 180) % 360 - 180, di / 1e6, dj / 1e6


def main():
    min_mm = float(sys.argv[1]) if len(sys.argv) > 1 else 15.0
    key = latest_key()
    if not key:
        print(json.dumps({'file': None, 'time': None, 'hail': []}))
        return
    raw, ref, e, d, la1, lo1, di, dj = decode(gzip.decompress(get(f'{BUCKET}/{key}')))
    # value = (ref + raw * 2^e) / 10^d; find raw cells at or above min_mm without converting all.
    raw_min = int(np.ceil((min_mm * 10 ** d - ref) / 2 ** e))
    rows, cols = np.nonzero(raw >= max(raw_min, 1))
    vals = (ref + raw[rows, cols].astype(np.float64) * 2 ** e) / 10 ** d
    lats = la1 - rows * dj
    lons = lo1 + cols * di
    keep = (lats >= LAT0) & (lats <= LAT1) & (lons >= LON0) & (lons <= LON1) & (vals >= min_mm)
    m = re.search(r'_(\d{8})-(\d{6})\.grib2', key)
    t = int(datetime.strptime(m.group(1) + m.group(2), '%Y%m%d%H%M%S').replace(tzinfo=timezone.utc).timestamp() * 1000)
    hail = [[round(float(a), 3), round(float(b), 3), round(float(v), 1)] for a, b, v in zip(lats[keep], lons[keep], vals[keep])]
    print(json.dumps({'file': key, 'time': t, 'hail': hail}))


if __name__ == '__main__':
    main()
