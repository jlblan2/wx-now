// Radar outside the U.S. mosaic: RainViewer's free worldwide composite, drawn as map tiles.
// Their tiles carry colours rather than reflectivity values and the free tier serves a single
// palette up to zoom 7, so this layer is for looking at; the rain forecast does not use it.
// The index lists the last two hours at 10-minute steps (no forecast frames).

const INDEX = 'https://api.rainviewer.com/public/weather-maps.json';
const CACHE_MS = 90000;
export const MAX_NATIVE_ZOOM = 7;

let cached = null, cachedAt = 0, inflight = null;

async function load() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const resp = await fetch(INDEX, { signal: ctl.signal, cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const j = await resp.json();
    const past = (j.radar && j.radar.past) || [];
    if (!j.host || !past.length) throw new Error('No radar frames');
    return { host: j.host, frames: past.map((f) => ({ time: f.time * 1000, path: f.path })) };
  } finally {
    clearTimeout(timer);
  }
}

// { host, frames: [{ time (ms), path }] } oldest first. Concurrent callers share one request.
export async function intlFrames() {
  if (cached && Date.now() - cachedAt < CACHE_MS) return cached;
  if (!inflight) {
    inflight = load().then((d) => { cached = d; cachedAt = Date.now(); return d; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

// Leaflet tile URL template for one frame. Colour scheme is ignored by the free tier; the
// second digit group asks for smoothed tiles.
export const tileUrl = (host, path) => `${host}${path}/256/{z}/{x}/{y}/2/1_0.png`;
