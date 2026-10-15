// Tropical outlook alerts: tell subscribers when NHC starts watching a new Atlantic area, or
// when an area's chance of becoming a tropical cyclone goes up (7-day risk rises, or the
// 2-day risk reaches high). Outlook areas carry no id from one issuance to the next, so
// areas are matched by position.
import { distKm, bearing } from '../storms.js';

const MATCH_KM = 600;
const LEVEL = { Low: 1, Medium: 2, High: 3 };
const MI_PER_KM = 0.621371;
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

function centre(geometry) {
  const rings = geometry.type === 'Polygon' ? [geometry.coordinates[0]] : geometry.type === 'MultiPolygon' ? geometry.coordinates.map((p) => p[0]) : [];
  const pts = rings.flat();
  if (!pts.length) return null;
  return { lat: pts.reduce((s, p) => s + p[1], 0) / pts.length, lon: pts.reduce((s, p) => s + p[0], 0) / pts.length };
}

// Outlook map areas -> compact records.
export function outlookAreas(features) {
  return features.map((f) => {
    const c = centre(f.geometry || {});
    const p = f.properties || {};
    return c && { ...c, prob2: p.prob2day || '', prob7: p.prob7day || '', risk2: p.risk2day || '', risk7: p.risk7day || '' };
  }).filter(Boolean);
}

// Compares this outlook's areas with the previous ones. Returns the events to announce and
// the area list to remember. With no previous list (first run) nothing is announced.
export function outlookEvents(prev, areas) {
  const events = [];
  for (const a of areas) {
    let best = null;
    for (const p of prev || []) {
      const d = distKm(a, p);
      if (d <= MATCH_KM && (!best || d < best.d)) best = { d, p };
    }
    if (!best) {
      if (prev) events.push({ kind: 'new', area: a });
    } else {
      const was = best.p;
      if ((LEVEL[a.risk7] || 0) > (LEVEL[was.risk7] || 0) || (a.risk2 === 'High' && was.risk2 !== 'High')) {
        events.push({ kind: 'up', area: a, was });
      }
    }
  }
  return { events, next: areas };
}

function where(area, places) {
  let best = null;
  for (const pl of places) {
    const d = distKm(pl, area);
    if (!best || d < best.d) best = { d, pl };
  }
  if (!best) return '';
  const dir = COMPASS[Math.round(bearing(best.pl, area) / 22.5) % 16];
  return ` About ${(Math.round(best.d * MI_PER_KM / 50) * 50).toLocaleString('en-US')} mi ${dir} of ${best.pl.name === 'Your last location' ? 'your last location' : best.pl.name}.`;
}

// One notification per event per subscriber.
export function outlookSends(subs, events, watchList) {
  const out = [];
  for (const [endpoint, sub] of Object.entries(subs)) {
    if (sub.outlookOn === false) continue;
    const places = watchList(sub);
    for (const e of events) {
      const a = e.area;
      const chances = `${a.prob7 || '?'} chance of forming in 7 days (${(a.risk7 || 'low').toLowerCase()}), ${a.prob2 || '?'} in 2 days.`;
      out.push({
        endpoint,
        payload: {
          title: e.kind === 'new'
            ? `Tropical outlook: NHC is watching a new area (${a.prob7} in 7 days)`
            : `Tropical outlook: chances up to ${a.prob7} in 7 days`,
          body: `${e.kind === 'up' ? `Up from ${e.was.prob7}. ` : ''}${chances}${where(a, places)}`,
          tag: `outlook-${a.lat.toFixed(0)}-${a.lon.toFixed(0)}`,
          url: './?tab=storms',
        },
      });
    }
  }
  return out;
}
