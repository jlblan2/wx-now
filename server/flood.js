// Flash flood alerts for saved places and the last location:
// - NWS Flash Flood Warnings whose polygon covers the place (move to higher ground) or lies
//   within NEAR_MI of it, tracked by VTEC event number like tornado warnings; flash flood
//   emergencies and "considerable" damage threats alert again as an upgrade;
// - NWS Flash Flood Watches for the place;
// - radar: MRMS rain over the last 1-6 hours as a percentage of NOAA's flash flood guidance
//   (the rain that causes flash flooding there), at 100% or more within NEAR_MI;
// - the Weather Prediction Center's Day 1 Excessive Rainfall Outlook, Slight risk or higher.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { distKm, bearing } from '../storms.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UA = { 'User-Agent': 'WxNow alert server (github.com/jlblan2/wx-now)', Accept: 'application/geo+json' };
export const NEAR_MI = 5;
const MI = 1.609344;
const QUIET_MS = 3 * 3600000;
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

export async function floodWarnings() {
  const r = await fetch('https://api.weather.gov/alerts/active?event=Flash%20Flood%20Warning', { headers: UA });
  if (!r.ok) throw new Error(`NWS ${r.status}`);
  return (await r.json()).features || [];
}

export function floodInfo(p) {
  const par = p.parameters || {};
  const text = `${p.headline || ''} ${p.description || ''}`;
  const damage = ((par.flashFloodDamageThreat || [])[0] || '').toUpperCase();
  const vtecText = (par.VTEC || [])[0] || '';
  const vtec = vtecText.match(/\/[OTEX]\.\w+\.(\w{4})\.(\w\w)\.(\w)\.(\d{4})\./);
  return {
    ended: /\/O\.(CAN|EXP)\./.test(vtecText) || p.messageType === 'Cancel',
    key: vtec ? `${vtec[1]}.${vtec[2]}.${vtec[3]}.${vtec[4]}` : p.id,
    level: /FLASH FLOOD EMERGENCY/i.test(text) || damage === 'CATASTROPHIC' ? 3 : damage === 'CONSIDERABLE' ? 2 : 1,
    observed: /OBSERVED/i.test((par.flashFloodDetection || [])[0] || ''),
  };
}

export function floodWarningMessage(kind, info, placeName, distMi, untilText) {
  const until = untilText ? ` In effect${untilText}.` : '';
  const seen = info.observed ? 'Flash flooding is happening' : 'Flash flooding is expected (radar indicated)';
  const you = placeName === 'your location' ? 'you' : placeName;
  if (kind === 'near') {
    return {
      title: `Flash flood warning nearby · ${placeName}`,
      body: `A flash flood warning covers an area ${Math.max(1, Math.round(distMi))} mi from ${you}. ${seen} there: avoid low roads, creeks and underpasses.${until}`,
    };
  }
  const what = info.level === 3 ? 'FLASH FLOOD EMERGENCY' : 'FLASH FLOOD WARNING';
  const threat = info.level === 3 ? ' This is a life-threatening situation.' : info.level === 2 ? ' Considerable flooding is expected.' : '';
  return {
    title: `${what} · ${placeName}`,
    body: `${kind === 'upgrade' ? `Upgraded${info.level === 3 ? ' to a FLASH FLOOD EMERGENCY' : ''}. ` : ''}${seen}.${threat} Move to higher ground now if you are in a low spot or near a stream. Never drive or walk into flood water: turn around, don't drown.${until}`,
  };
}

export function floodWatchMessage(placeName, untilText) {
  return {
    title: `Flash Flood Watch · ${placeName}`,
    body: `Heavy rain could cause flash flooding${untilText}. Know your way to higher ground and avoid flooded roads.`,
  };
}

// ---------- radar: rain as a percentage of flash flood guidance ----------

let cells = [];   // [lat, lon, percent]

export function refreshRadarFlood() {
  return new Promise((resolve, reject) => {
    execFile('python3', [path.join(HERE, 'mrms', 'mrms.py'), 'FLASH_QPE_FFGMAX_00.00', '100'], { maxBuffer: 64 * 1024 * 1024, timeout: 4 * 60000 }, (err, out) => {
      if (err) return reject(err);
      try { cells = JSON.parse(out).cells; resolve(cells.length); } catch (e) { reject(e); }
    });
  });
}

// Highest percentage within NEAR_MI of a place: { pct, mi, dir } or null.
export function radarFloodNear(place, list = cells, mi = NEAR_MI) {
  let best = null;
  const box = mi * MI / 111 + 0.02;
  for (const [lat, lon, pct] of list) {
    if (Math.abs(lat - place.lat) > box || Math.abs(lon - place.lon) > box / Math.cos(place.lat * Math.PI / 180)) continue;
    const d = distKm(place, { lat, lon }) / MI;
    if (d > mi) continue;
    if (!best || pct > best.pct || (pct === best.pct && d < best.mi)) best = { pct, mi: d, dir: compass(bearing(place, { lat, lon })) };
  }
  return best;
}

// `st` is updated. Returns 'flood' once per episode; quiet until 3 hours below 100%.
export function decideRadarFlood(st, near, now = Date.now()) {
  if (near && near.pct >= 100) {
    st.seen = now;
    if (!st.active) { st.active = true; return 'flood'; }
    return null;
  }
  if (st.active && now - st.seen >= QUIET_MS) st.active = false;
  return null;
}

export function radarFloodMessage(near, placeName) {
  const you = placeName === 'your location' ? 'you' : placeName;
  const where = near.mi < 1 ? `right at ${you}` : `${Math.round(near.mi)} mi ${near.dir} of ${you}`;
  return {
    title: `Rain at flash flood levels · ${placeName}`,
    body: `Radar shows rain at ${Math.round(near.pct)}% of the amount that causes flash flooding, ${where}, over the last 1 to 6 hours. Streams and low roads may already be flooding: avoid them and be ready to move to higher ground.`,
  };
}

// ---------- WPC Excessive Rainfall Outlook, Day 1 ----------

const ERO = 'https://mapservices.weather.noaa.gov/vector/rest/services/hazards/wpc_precip_hazards/MapServer/0/query';
const LEVELS = { 1: ['Marginal', 5], 2: ['Slight', 15], 3: ['Moderate', 40], 4: ['High', 70] };
const eroCache = new Map();

// { level 0-4, name, pct, end } for a place; cached 30 minutes per area.
export async function rainOutlookAt(place) {
  const key = `${place.lat.toFixed(2)},${place.lon.toFixed(2)}`, hit = eroCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60000) return hit.o;
  const q = new URLSearchParams({
    geometry: `${place.lon},${place.lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    outFields: 'dn,outlook,end_time', returnGeometry: 'false', f: 'json',
  });
  const r = await fetch(`${ERO}?${q}`, { headers: { 'User-Agent': UA['User-Agent'] } });
  if (!r.ok) throw new Error(`WPC ${r.status}`);
  const j = await r.json();
  let o = { level: 0 };
  for (const f of j.features || []) {
    const a = f.attributes || {};
    if (a.dn > o.level && LEVELS[a.dn]) o = { level: a.dn, name: LEVELS[a.dn][0], pct: LEVELS[a.dn][1], end: a.end_time };
  }
  eroCache.set(key, { at: Date.now(), o });
  return o;
}

// One alert per outlook day per place at Slight or higher, again if the level goes up.
export function decideRainOutlook(st, o) {
  if (o.level < 2) return false;
  if (st.end === o.end && o.level <= st.level) return false;
  st.end = o.end; st.level = o.level;
  return true;
}

export function rainOutlookMessage(o, placeName, timeZone) {
  const t = o.end ? Date.parse(`${o.end.replace(' ', 'T')}Z`) : NaN;
  const until = Number.isFinite(t) ? `, through ${new Date(t).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', timeZone }).replace(',', '')}` : '';
  return {
    title: `Flash flooding possible today · ${placeName}`,
    body: `The Weather Prediction Center rates the risk of excessive rain ${o.name} (at least a ${o.pct}% chance of flash flooding within 25 miles)${until}. Avoid low roads and creeks if heavy rain sets in.`,
  };
}
