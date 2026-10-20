// Tornado alerts for saved places and the last location, every 2 minutes:
// - NWS Tornado Warnings: the warning polygon covers the place (take shelter), or lies within
//   NEAR_MI of it (be ready), with how the storm is moving and whether it is heading that way.
//   Tornado emergencies and "particularly dangerous situation" warnings say so, and an
//   upgrade alerts again. Warnings are tracked by their VTEC event number, so the NWS
//   follow-up statements for the same warning don't repeat the alert.
// - NWS Tornado Watches for the place.
// - The Storm Prediction Center's Day 1 tornado outlook: a heads-up at 5% or more.
import { distKm, bearing } from '../storms.js';

const UA = { 'User-Agent': 'WxNow alert server (github.com/jlblan2/wx-now)', Accept: 'application/geo+json' };
export const NEAR_MI = 15;
const MI = 1.609344;
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

export async function tornadoWarnings() {
  const r = await fetch('https://api.weather.gov/alerts/active?event=Tornado%20Warning', { headers: UA });
  if (!r.ok) throw new Error(`NWS ${r.status}`);
  return (await r.json()).features || [];
}

// Distance in miles from a place to a (Multi)Polygon: 0 inside, else to the nearest edge.
export function distanceToPolygon(place, g) {
  if (!g) return Infinity;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  const kx = 69.17 * Math.cos(place.lat * Math.PI / 180), ky = 69.05;   // miles per degree
  let best = Infinity;
  for (const [ring] of polys) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > place.lat) !== (yj > place.lat) && place.lon < (xj - xi) * (place.lat - yi) / (yj - yi) + xi) inside = !inside;
      // distance to segment, in a local flat frame centred on the place
      const ax = (xj - place.lon) * kx, ay = (yj - place.lat) * ky, bx = (xi - place.lon) * kx, by = (yi - place.lat) * ky;
      const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
    if (inside) return 0;
  }
  return best;
}

// Details of a warning from its NWS parameters.
export function warningInfo(p) {
  const par = p.parameters || {};
  const text = `${p.headline || ''} ${p.description || ''}`;
  const damage = ((par.tornadoDamageThreat || [])[0] || '').toUpperCase();
  const level = /TORNADO EMERGENCY/i.test(text) || damage === 'CATASTROPHIC' ? 3
    : damage === 'CONSIDERABLE' || /PARTICULARLY DANGEROUS SITUATION/i.test(text) ? 2 : 1;
  const vtec = ((par.VTEC || [])[0] || '').match(/\/[OTEX]\.\w+\.(\w{4})\.(\w\w)\.(\w)\.(\d{4})\./);
  const motion = ((par.eventMotionDescription || [])[0] || '').match(/(\d{1,3})DEG\.\.\.(\d{1,3})KT\.\.\.(-?[\d.]+),(-?[\d.]+)/);
  return {
    ended: /\/O\.(CAN|EXP)\./.test((par.VTEC || [])[0] || '') || p.messageType === 'Cancel',
    key: vtec ? `${vtec[1]}.${vtec[2]}.${vtec[3]}.${vtec[4]}` : p.id,
    level,
    observed: /OBSERVED/i.test((par.tornadoDetection || [])[0] || ''),
    hail: parseFloat((par.maxHailSize || [])[0]) || 0,
    // the NWS gives the direction the storm comes FROM; it moves the other way
    motion: motion ? { toward: (+motion[1] + 180) % 360, mph: Math.round(+motion[2] * 1.15078), lat: +motion[3], lon: -Math.abs(+motion[4]) } : null,
    ends: p.ends || p.expires,
  };
}

// Is the storm heading toward the place (within 45 degrees of its track)?
export function headingToward(info, place) {
  if (!info.motion || info.motion.mph < 3) return false;
  const b = bearing({ lat: info.motion.lat, lon: info.motion.lon }, place);
  const diff = Math.abs(((b - info.motion.toward) + 540) % 360 - 180);
  return diff <= 45;
}

// `sent` maps warning key -> { stage: 1 nearby | 2 covering, level, until }. Returns 'in',
// 'near', 'upgrade' or null, and records the send.
// Also used for flash flood warnings, with their own nearby distance.
export function decideWarning(sent, info, distMi, now = Date.now(), nearMi = NEAR_MI) {
  for (const [k, v] of Object.entries(sent)) if (v.until < now) delete sent[k];
  const stage = distMi === 0 ? 2 : distMi <= nearMi ? 1 : 0;
  if (!stage) return null;
  const prev = sent[info.key];
  const until = (Date.parse(info.ends) || now + 3600000) + 3600000;
  if (!prev) { sent[info.key] = { stage, level: info.level, until }; return stage === 2 ? 'in' : 'near'; }
  if (stage > prev.stage) { Object.assign(prev, { stage, level: Math.max(prev.level, info.level), until }); return 'in'; }
  if (info.level > prev.level) { Object.assign(prev, { level: info.level, until }); return 'upgrade'; }
  return null;
}

export function warningMessage(kind, info, place, placeName, distMi, untilText, metric) {
  const until = untilText ? ` In effect${untilText}.` : '';
  const what = info.level === 3 ? 'TORNADO EMERGENCY' : info.level === 2 ? 'Particularly dangerous tornado warning' : 'Tornado warning';
  const seen = info.observed ? 'Tornado observed' : 'Tornado indicated by radar';
  const move = info.motion && info.motion.mph >= 3
    ? `, moving ${compass(info.motion.toward)} at ${metric ? `${Math.round(info.motion.mph * MI)} km/h` : `${info.motion.mph} mph`}` : '';
  const hail = info.hail ? ` Hail up to ${info.hail} in.` : '';
  if (kind === 'near') {
    const dir = info.motion ? compass(bearing(place, { lat: info.motion.lat, lon: info.motion.lon })) : '';
    const toward = headingToward(info, place) ? `, heading toward ${placeName === 'your location' ? 'you' : placeName}` : '';
    return {
      title: `Tornado warning nearby · ${placeName}`,
      body: `${what} ${Math.round(distMi)} mi${dir ? ` ${dir}` : ''} of ${placeName === 'your location' ? 'you' : placeName}. ${seen}${move}${toward}. Be ready to take shelter.${hail}${until}`,
    };
  }
  return {
    title: `${info.level === 3 ? 'TORNADO EMERGENCY' : 'TORNADO WARNING'} · ${placeName}`,
    body: `${kind === 'upgrade' ? `Upgraded to ${what.toLowerCase().replace('tornado emergency', 'a TORNADO EMERGENCY')}. ` : ''}Take shelter now: lowest floor, small interior room, away from windows. On the water, get to shore and shelter. ${seen}${move}.${hail}${until}`,
  };
}

export function watchMessage(p, placeName, untilText) {
  const pds = /PARTICULARLY DANGEROUS SITUATION/i.test(`${p.headline || ''} ${p.description || ''}`);
  return {
    title: `${pds ? 'PDS ' : ''}Tornado Watch · ${placeName}`,
    body: `${pds ? 'A particularly dangerous situation: ' : ''}Conditions favor tornadoes${untilText}. Know where you would shelter and keep alerts on.`,
  };
}

export function tornadoOutlookMessage(o, placeName, timeZone) {
  const until = o.expire ? new Date(o.expire).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', timeZone }).replace(',', '') : '';
  return {
    title: `Tornadoes possible today · ${placeName}`,
    body: `The Storm Prediction Center gives a ${o.prob}% chance of a tornado within 25 miles${o.big ? ', and some could be strong (EF2 or stronger)' : ''}${until ? `, through ${until}` : ''}. Know where you would shelter.`,
  };
}
