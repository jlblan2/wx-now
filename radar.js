// Radar data: NEXRAD base reflectivity mosaic (N0Q) from the Iowa Environmental Mesonet.
// Frames come from their time-enabled WMS in Web Mercator, so the grid lines up exactly
// with the map. Each pixel's colour maps back to a reflectivity through the N0Q palette.

import { N0Q_PALETTE, NEXRAD_SITES } from './data.js';

const WMS = 'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi';
const LATEST = 'https://mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP/n0q_0.json';
const R = 6378137;

export const GRID_PX = 300;
export const HALF_KM = 170;      // grid reaches this far from its centre in each direction
export const FRAME_MIN = 5;      // the mosaic is produced every 5 minutes
export const DOMAIN = { south: 23, north: 50, west: -126, east: -65 };

export function inDomain(lat, lon) {
  return lat >= DOMAIN.south && lat <= DOMAIN.north && lon >= DOMAIN.west && lon <= DOMAIN.east;
}

const toMercX = (lon) => R * lon * Math.PI / 180;
const toMercY = (lat) => R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
const fromMercX = (x) => x / R * 180 / Math.PI;
const fromMercY = (y) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;

// Grid centred near (lat, lon). The centre snaps to 0.05 degrees so small moves reuse
// cached frames.
export function makeGrid(lat, lon) {
  const clat = Math.round(lat * 20) / 20, clon = Math.round(lon * 20) / 20;
  const half = HALF_KM * 1000 / Math.cos(clat * Math.PI / 180);
  const mx = toMercX(clon), my = toMercY(clat);
  const g = {
    key: `${clat},${clon}`,
    w: GRID_PX, h: GRID_PX,
    dx: 2 * HALF_KM / GRID_PX,
    minX: mx - half, maxX: mx + half, minY: my - half, maxY: my + half,
  };
  g.bounds = [[fromMercY(g.minY), fromMercX(g.minX)], [fromMercY(g.maxY), fromMercX(g.maxX)]];
  return g;
}

export function toPixel(g, lat, lon) {
  return {
    x: (toMercX(lon) - g.minX) / (g.maxX - g.minX) * g.w - 0.5,
    y: (g.maxY - toMercY(lat)) / (g.maxY - g.minY) * g.h - 0.5,
  };
}

export function toLatLon(g, x, y) {
  return {
    lat: fromMercY(g.maxY - (y + 0.5) / g.h * (g.maxY - g.minY)),
    lon: fromMercX(g.minX + (x + 0.5) / g.w * (g.maxX - g.minX)),
  };
}

const colorIndex = new Map(N0Q_PALETTE.map((c, i) => [(c[0] << 16) | (c[1] << 8) | c[2], i]));

function indexOf(r, g, b) {
  const key = (r << 16) | (g << 8) | b;
  let i = colorIndex.get(key);
  if (i === undefined) {
    // Colour shifted slightly in decoding: use the nearest palette entry.
    let best = Infinity;
    N0Q_PALETTE.forEach((c, j) => {
      const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
      if (d < best) { best = d; i = j; }
    });
    colorIndex.set(key, i);
  }
  return i;
}

async function fetchWithTimeout(url, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const resp = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

export async function latestFrameTime() {
  const resp = await fetchWithTimeout(LATEST, 15000);
  const j = await resp.json();
  return new Date(j.meta.valid);
}

function frameUrl(g, time) {
  const p = new URLSearchParams({
    SERVICE: 'WMS', VERSION: '1.1.1', REQUEST: 'GetMap',
    LAYERS: 'nexrad-n0q-wmst', SRS: 'EPSG:3857', STYLES: '',
    BBOX: [g.minX, g.minY, g.maxX, g.maxY].map((v) => v.toFixed(1)).join(','),
    WIDTH: g.w, HEIGHT: g.h, FORMAT: 'image/png', TRANSPARENT: 'true',
    TIME: time.toISOString().replace('.000Z', 'Z'),
  });
  return `${WMS}?${p}`;
}

async function decodePng(blob, w, h) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('Radar image could not be decoded'));
      im.src = url;
    });
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const cache = new Map();

// Reflectivity (dBZ) for every grid pixel at `time`; NaN where there is no echo.
export async function fetchFrame(g, time) {
  const key = `${g.key}|${time.getTime()}`;
  if (cache.has(key)) return cache.get(key);
  const resp = await fetchWithTimeout(frameUrl(g, time), 20000);
  const px = await decodePng(await resp.blob(), g.w, g.h);
  const dbz = new Float32Array(g.w * g.h).fill(NaN);
  for (let i = 0, p = 0; i < dbz.length; i++, p += 4) {
    if (px[p + 3] < 128) continue;
    const idx = indexOf(px[p], px[p + 1], px[p + 2]);
    if (idx >= 1 && idx <= 244) dbz[i] = -32 + 0.5 * idx;
  }
  cache.set(key, dbz);
  return dbz;
}

export function pruneCache(olderThan) {
  for (const key of cache.keys()) {
    if (+key.split('|')[1] < olderThan) cache.delete(key);
  }
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

export function nearestRadar(lat, lon) {
  let best = null;
  for (const [id, slat, slon] of NEXRAD_SITES) {
    const d = haversineKm(lat, lon, slat, slon);
    if (!best || d < best.km) best = { id, km: d };
  }
  return best;
}

// How much to trust radar at this distance from the nearest site. Beyond ~150 km the
// beam passes over low-level rain; by ~350 km it sees little but tall storms.
export function radarQuality(km) {
  return Math.max(0, Math.min(1, (350 - km) / 200));
}
