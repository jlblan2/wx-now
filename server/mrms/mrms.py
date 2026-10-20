#!/usr/bin/env python3
"""Latest NOAA MRMS grid for Wx Now, from the public noaa-mrms-pds S3 bucket (CONUS, every
2 minutes), reduced to the cells at or above a threshold.

Prints JSON: {"file": <key>, "time": <ms>, "cells": [[lat, lon, value], ...]} for every grid
cell (0.01 deg) in the app's area with a value of at least MIN.
Usage: mrms.py PRODUCT MIN
  e.g. mrms.py MESH_Max_30min_00.50 15     (hail size, mm, largest in the last 30 minutes)
       mrms.py FLASH_QPE_FFGMAX_00.00 100  (rain as % of flash flood guidance, largest of 1-6 h)

MRMS packs the 7000 x 3500 grid as a PNG inside the GRIB2 message (data template 5.41). This
reads the GRIB2 sections directly and decodes the PNG one row at a time (zlib stream + PNG
row filters), so memory stays small (a few MB) instead of the 120-340 MB a whole-grid decode
needs on the 1 GB server.
"""
import gzip, json, re, struct, sys, urllib.parse, urllib.request, zlib
from datetime import datetime, timedelta, timezone
import numpy as np

BUCKET = 'https://noaa-mrms-pds.s3.amazonaws.com'
LAT0, LAT1, LON0, LON1 = 8, 47, -100, -58
UA = {'User-Agent': 'WxNow alert server (github.com/jlblan2/wx-now)'}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read()


def latest_key(product):
    now = datetime.now(timezone.utc)
    for day in (now, now - timedelta(days=1)):
        base = f'{BUCKET}/?list-type=2&prefix=CONUS/{product}/{day:%Y%m%d}/'
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


def unfilter(ft, line, prior, bpp):
    """Undo one PNG row filter. line/prior are uint8 arrays; returns the raw row."""
    if ft == 0:
        return line
    if ft == 2:
        return line + prior   # uint8 arithmetic wraps mod 256, as PNG requires
    if ft == 1:
        out = line.reshape(-1, bpp)
        return np.cumsum(out, axis=0, dtype=np.uint8).reshape(-1)
    out = bytearray(line.tobytes())
    up = prior.tobytes()
    n = len(out)
    if ft == 3:
        for i in range(n):
            a = out[i - bpp] if i >= bpp else 0
            out[i] = (out[i] + ((a + up[i]) >> 1)) & 255
    elif ft == 4:
        for i in range(n):
            if i >= bpp:
                a, c = out[i - bpp], up[i - bpp]
            else:
                a = c = 0
            b = up[i]
            p = a + b - c
            pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
            out[i] = (out[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
    else:
        raise ValueError(f'bad PNG filter {ft}')
    return np.frombuffer(bytes(out), dtype=np.uint8)


def png_rows(png):
    """Yields (row index, row of integer pixel values) from an 8/16-bit gray or 8-bit RGB PNG."""
    pos, idat, ihdr = 8, [], None
    while pos < len(png):
        n = struct.unpack('>I', png[pos:pos + 4])[0]
        kind = png[pos + 4:pos + 8]
        if kind == b'IHDR':
            ihdr = struct.unpack('>IIBBBBB', png[pos + 8:pos + 21])
        elif kind == b'IDAT':
            idat.append(png[pos + 8:pos + 8 + n])
        pos += 12 + n
    w, h, depth, ctype, _, _, interlace = ihdr
    if interlace or (ctype, depth) not in ((0, 8), (0, 16), (2, 8)):
        raise ValueError(f'unsupported PNG: color type {ctype}, depth {depth}, interlace {interlace}')
    bpp = (3 if ctype == 2 else 1) * depth // 8
    stride = 1 + w * bpp
    z = zlib.decompressobj()
    buf = bytearray()
    prior = np.zeros(w * bpp, dtype=np.uint8)
    row = 0
    for chunk in idat + [None]:
        buf += z.decompress(chunk) if chunk is not None else z.flush()
        while len(buf) >= stride and row < h:
            line = np.frombuffer(bytes(buf[1:stride]), dtype=np.uint8)
            raw = unfilter(buf[0], line, prior, bpp)
            del buf[:stride]
            prior = raw
            if ctype == 2:
                px = raw.reshape(-1, 3).astype(np.uint32)
                vals = (px[:, 0] << 16) | (px[:, 1] << 8) | px[:, 2]
            elif depth == 16:
                vals = raw.view('>u2').astype(np.uint32)
            else:
                vals = raw.astype(np.uint32)
            yield row, vals
            row += 1


def main():
    product, min_v = sys.argv[1], float(sys.argv[2])
    key = latest_key(product)
    if not key:
        print(json.dumps({'file': None, 'time': None, 'cells': []}))
        return
    msg = gzip.decompress(get(f'{BUCKET}/{key}'))
    s = {num: body for num, body in sections(msg)}
    g = s[3]
    ni, nj = struct.unpack('>II', g[30:38])
    la1 = signed(struct.unpack('>I', g[46:50])[0], 32) / 1e6
    lo1 = (struct.unpack('>I', g[50:54])[0] / 1e6 + 180) % 360 - 180
    di, dj = (x / 1e6 for x in struct.unpack('>II', g[63:71]))
    r5 = s[5]
    if struct.unpack('>H', r5[9:11])[0] != 41:
        raise ValueError('expected PNG packing (template 5.41)')
    ref = struct.unpack('>f', r5[11:15])[0]
    e = signed(struct.unpack('>H', r5[15:17])[0], 16)
    d = signed(struct.unpack('>H', r5[17:19])[0], 16)
    if s[6][5] != 255:
        raise ValueError('bitmaps are not supported')
    # value = (ref + raw * 2^e) / 10^d; compare raw integers, convert only the hits.
    raw_min = max(1, int(np.ceil((min_v * 10 ** d - ref) / 2 ** e)))
    c0 = max(0, int(np.floor((LON0 - lo1) / di))); c1 = min(ni, int(np.ceil((LON1 - lo1) / di)) + 1)
    cells = []
    for r, vals in png_rows(s[7][5:]):
        lat = la1 - r * dj
        if lat > LAT1 or lat < LAT0:
            continue
        hits = np.nonzero(vals[c0:c1] >= raw_min)[0]
        for c in hits:
            v = (ref + float(vals[c0 + c]) * 2 ** e) / 10 ** d
            if v >= min_v:
                cells.append([round(lat, 3), round(lo1 + (c0 + c) * di, 3), round(v, 2)])
    m = re.search(r'_(\d{8})-(\d{6})\.grib2', key)
    t = int(datetime.strptime(m.group(1) + m.group(2), '%Y%m%d%H%M%S').replace(tzinfo=timezone.utc).timestamp() * 1000)
    print(json.dumps({'file': key, 'time': t, 'cells': cells}))


if __name__ == '__main__':
    main()
