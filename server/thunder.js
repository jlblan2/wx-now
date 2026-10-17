// Thunderstorm and lightning alerts.
// - Lightning: flashes seen by NOAA's GOES-19 Geostationary Lightning Mapper (lightning/glm.py,
//   every 5 minutes). Alerts when lightning comes within the chosen distance of a watched
//   place, again if it comes within 3 miles, and an all-clear after 30 minutes without any
//   lightning in range (the 30-30 rule).
// - NWS severe thunderstorm and tornado watches and warnings at the place.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { distKm, bearing } from '../storms.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEEP_MS = 40 * 60000;
const RECENT_MS = 15 * 60000;
const CLEAR_MS = 30 * 60000;
const CLOSE_MI = 3;
const MI = 1.609344;
export const THUNDER_EVENTS = new Set(['Severe Thunderstorm Warning', 'Severe Thunderstorm Watch', 'Tornado Warning', 'Tornado Watch']);
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

let flashes = [];   // [t, lat, lon]
let lastKey = '';

// Pulls the newest GLM files and keeps the last 40 minutes of flashes.
export function refreshLightning() {
  return new Promise((resolve, reject) => {
    execFile('python3', [path.join(HERE, 'lightning', 'glm.py'), lastKey], { maxBuffer: 64 * 1024 * 1024, timeout: 4 * 60000 }, (err, out) => {
      if (err) return reject(err);
      try {
        const j = JSON.parse(out);
        lastKey = j.last || lastKey;
        const cut = Date.now() - KEEP_MS;
        flashes = flashes.filter((f) => f[0] >= cut).concat(j.flashes.filter((f) => f[0] >= cut));
        resolve({ files: j.files, flashes: flashes.length });
      } catch (e) { reject(e); }
    });
  });
}

export const lightningSnapshot = () => flashes;

// Flashes within `mi` of a place in the last `ms`: { count, nearest: {mi, dir}, newest }.
export function lightningNear(place, mi, list = flashes, now = Date.now(), ms = RECENT_MS) {
  let count = 0, nearest = null, newest = 0;
  const box = mi * MI / 111 + 0.05;
  for (const [t, lat, lon] of list) {
    if (t < now - ms || Math.abs(lat - place.lat) > box || Math.abs(lon - place.lon) > box / Math.cos(place.lat * Math.PI / 180)) continue;
    const d = distKm(place, { lat, lon }) / MI;
    if (d > mi) continue;
    count++;
    newest = Math.max(newest, t);
    if (!nearest || d < nearest.mi) nearest = { mi: d, dir: compass(bearing(place, { lat, lon })) };
  }
  return { count, nearest, newest };
}

// `st` is this subscriber's state for the place and is updated. `near` is lightningNear over
// the last 15 minutes; `lastSeen` the newest flash in range over the last 40.
// Returns 'nearby', 'close', 'clear' or null.
export function decideLightning(st, near, lastSeen, now = Date.now()) {
  if (!st.active) {
    if (near.count >= 2) { Object.assign(st, { active: true, close: near.nearest.mi <= CLOSE_MI, since: now }); return 'nearby'; }
    return null;
  }
  if (near.count && near.nearest.mi <= CLOSE_MI && !st.close) { st.close = true; return 'close'; }
  if (!near.count && (!lastSeen || now - lastSeen >= CLEAR_MS) && now - st.since >= CLEAR_MS) {
    Object.assign(st, { active: false, close: false });
    return 'clear';
  }
  return null;
}

export function lightningMessage(kind, near, placeName, rangeMi) {
  const dist = (mi) => (mi < 1 ? 'under a mile' : `${Math.round(mi)} mi (${Math.round(mi / 1.15078)} nm)`);
  if (kind === 'clear') {
    return { title: `Lightning all clear · ${placeName}`, body: `No lightning within ${rangeMi} miles for 30 minutes.` };
  }
  const where = `${dist(near.nearest.mi)} ${near.nearest.dir}`;
  return {
    title: `${kind === 'close' ? 'Lightning very close' : 'Lightning nearby'} · ${placeName}`,
    body: `${near.count} flash${near.count === 1 ? '' : 'es'} within ${rangeMi} miles in the last 15 minutes, nearest ${where}. ` +
      (kind === 'close' ? 'Get indoors or below now.' : 'Head in: off the water, out of the open.') + ' You will get an all-clear after 30 minutes without lightning.',
  };
}
