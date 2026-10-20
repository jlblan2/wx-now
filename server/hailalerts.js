// Hail alerts for saved places and the last location, from three sources:
// - radar: NOAA MRMS MESH (largest hail size estimated by radar in the last 30 minutes, every
//   2 minutes; mrms/mrms.py). Alerts when hail of the chosen size is within 10 miles, again if
//   much bigger hail appears, and goes quiet until an hour passes without any;
// - NWS Severe Thunderstorm Warnings whose hail size reaches the chosen size (tornado warnings
//   come with the tornado alerts, hail size included);
// - the Storm Prediction Center's Day 1 hail outlook: a heads-up when a place is in a 15%+
//   hail area (again if the risk goes up).
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { distKm, bearing } from '../storms.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MM = 25.4;
const MI = 1.609344;
export const RADIUS_MI = 10;
const QUIET_MS = 60 * 60000;
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
// NWS hail size names (inches).
const SIZES = [[4.5, 'softball'], [4, 'grapefruit'], [3, 'teacup'], [2.75, 'baseball'], [2.5, 'tennis ball'], [2, 'hen egg'],
  [1.75, 'golf ball'], [1.5, 'ping pong ball'], [1.25, 'half dollar'], [1, 'quarter'], [0.88, 'nickel'], [0.75, 'penny'], [0.5, 'marble'], [0.25, 'pea']];
export const sizeName = (inch) => (SIZES.find(([s]) => inch >= s - 0.005) || [0, 'small'])[1];
export function hailText(inch, metric) {
  const q = Math.max(0.25, Math.round(inch * 4) / 4);   // nearest quarter inch
  return `${metric ? `${Math.round(inch * MM)} mm` : `${q} in`} (${sizeName(q)})`;
}

let cells = [];   // [lat, lon, mm]
let gridTime = null;

export function refreshHail(minMm = 15) {
  return new Promise((resolve, reject) => {
    execFile('python3', [path.join(HERE, 'mrms', 'mrms.py'), 'MESH_Max_30min_00.50', String(minMm)], { maxBuffer: 64 * 1024 * 1024, timeout: 3 * 60000 }, (err, out) => {
      if (err) return reject(err);
      try {
        const j = JSON.parse(out);
        cells = j.cells; gridTime = j.time;
        resolve({ cells: cells.length, time: gridTime });
      } catch (e) { reject(e); }
    });
  });
}

// Largest radar hail within RADIUS_MI of a place: { inch, mi, dir } or null.
export function hailNear(place, list = cells, mi = RADIUS_MI) {
  let best = null;
  const box = mi * MI / 111 + 0.02;
  for (const [lat, lon, mm] of list) {
    if (Math.abs(lat - place.lat) > box || Math.abs(lon - place.lon) > box / Math.cos(place.lat * Math.PI / 180)) continue;
    const d = distKm(place, { lat, lon }) / MI;
    if (d > mi) continue;
    if (!best || mm > best.mm || (mm === best.mm && d < best.mi)) best = { mm, mi: d, dir: compass(bearing(place, { lat, lon })) };
  }
  return best && { inch: best.mm / MM, mi: best.mi, dir: best.dir };
}

// `st` is this subscriber's state for the place and is updated. Returns 'hail', 'bigger' or null.
export function decideHail(st, near, minInch, now = Date.now()) {
  if (near && near.inch >= minInch) {
    st.seen = now;
    if (!st.active) { Object.assign(st, { active: true, inch: near.inch }); return 'hail'; }
    if (near.inch >= st.inch + 0.75) { st.inch = near.inch; return 'bigger'; }
    return null;
  }
  if (st.active && now - st.seen >= QUIET_MS) st.active = false;
  return null;
}

export function radarHailMessage(kind, near, placeName, metric) {
  const where = near.mi < 1 ? 'right at' : `${Math.round(near.mi)} mi ${near.dir} of`;
  return {
    title: `${kind === 'bigger' ? 'Larger hail' : 'Hail'} detected · ${placeName}`,
    body: `Radar estimates hail up to ${hailText(near.inch, metric)} ${where} ${placeName === 'your location' ? 'you' : placeName} in the last 30 minutes. Move cars and boats under cover if you can, and stay indoors away from windows.`,
  };
}

// NWS warning hail size in inches (parameters.maxHailSize), or 0.
export function warningHail(props) {
  const v = parseFloat(((props.parameters || {}).maxHailSize || [])[0]);
  return Number.isFinite(v) ? v : 0;
}

// ---------- SPC Day 1 hail outlook ----------

// SPC Day 1 probabilistic outlooks: 'hail' or 'torn'. Cached 15 minutes each.
const outlooks = new Map();
export async function spcOutlook(type) {
  const hit = outlooks.get(type);
  if (hit && Date.now() - hit.at < 15 * 60000) return hit.data;
  const r = await fetch(`https://www.spc.noaa.gov/products/outlook/day1otlk_${type}.nolyr.geojson`, { headers: { 'User-Agent': 'WxNow alert server (github.com/jlblan2/wx-now)' } });
  if (!r.ok) throw new Error(`SPC ${r.status}`);
  const data = await r.json();
  outlooks.set(type, { at: Date.now(), data });
  return data;
}
export const hailOutlook = () => spcOutlook('hail');

function inRing(ring, lat, lon) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inGeometry(g, lat, lon) {
  if (!g) return false;
  if (g.type === 'GeometryCollection') return g.geometries.some((x) => inGeometry(x, lat, lon));
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.some(([outer, ...holes]) => inRing(outer, lat, lon) && !holes.some((h) => inRing(h, lat, lon)));
}

// The outlook at a place: { prob (%), big (true when SPC expects very large hail), valid, expire }.
export function outlookAt(fc, place) {
  let prob = 0, big = false, valid = null, expire = null;
  for (const f of (fc && fc.features) || []) {
    const p = f.properties || {};
    valid = p.VALID_ISO || valid; expire = p.EXPIRE_ISO || expire;
    if (!inGeometry(f.geometry, place.lat, place.lon)) continue;
    const v = parseFloat(p.LABEL);
    if (Number.isFinite(v)) prob = Math.max(prob, Math.round(v * 100));
    else if (/^CIG|^SIGN/.test(p.LABEL || '')) big = true;
  }
  return { prob, big, valid, expire };
}

// Returns true to send. One alert per outlook day per place, again if the risk goes up.
export function decideOutlook(st, o, minProb = 15) {
  if (o.prob < minProb) return false;
  const level = o.prob + (o.big ? 1 : 0);
  if (st.valid === o.expire && level <= st.level) return false;
  st.valid = o.expire; st.level = level;
  return true;
}

export function outlookMessage(o, placeName, timeZone) {
  const until = o.expire ? new Date(o.expire).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', timeZone }).replace(',', '') : '';
  return {
    title: `Hail possible today · ${placeName}`,
    body: `The Storm Prediction Center gives a ${o.prob}% chance of hail 1 inch or larger within 25 miles${o.big ? ', and some storms could bring hail 2 inches or larger' : ''}${until ? `, through ${until}` : ''}. Plan to keep cars and boats under cover.`,
  };
}
