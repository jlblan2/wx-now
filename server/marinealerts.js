// Marine alerts: Small Craft Advisories and stronger marine hazards for each subscriber's
// Gulf marine zones (the zone chosen in the app, plus the zone at each watched place that
// lies near the water). Each NWS alert is pushed once per subscriber.
import { zoneFor, zonesByDistance } from '../marine.js';

export const MARINE_EVENTS = new Set([
  'Small Craft Advisory',
  'Gale Watch', 'Gale Warning',
  'Storm Watch', 'Storm Warning',
  'Hurricane Force Wind Watch', 'Hurricane Force Wind Warning',
  'Hazardous Seas Watch', 'Hazardous Seas Warning',
  'Special Marine Warning',
]);
const NEAR_KM = 100;   // a watched place counts only if a Gulf zone is this close

// Zones to watch for one subscriber. Point lookups are cached on the subscriber.
export async function marineZones(sub, watchList) {
  if (sub.marine && sub.marine.on === false) return [];
  const zones = new Set();
  if (sub.marine && /^GMZ\d{3}$/.test(sub.marine.zone || '')) zones.add(sub.marine.zone);
  const cache = sub.zoneCache = sub.zoneCache || {};
  for (const place of watchList(sub)) {
    const key = `${place.lat.toFixed(3)},${place.lon.toFixed(3)}`;
    if (!(key in cache)) {
      cache[key] = zonesByDistance(place)[0].km <= NEAR_KM ? await zoneFor(place) : null;
    }
    if (cache[key]) zones.add(cache[key]);
  }
  for (const k of Object.keys(cache).slice(0, -50)) delete cache[k];   // keep it small
  return [...zones];
}

// "North winds 20 to 30 kt with gusts up to 35 kt expected." from the "* WHAT..." line.
function what(description) {
  const m = String(description || '').match(/\*\s*WHAT\.\.\.([\s\S]*?)(?:\n\s*\n|\*\s*WHERE|$)/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

// " until Sat 1:00 PM" in the alert area's own local time (from the timestamp's offset).
function localTime(iso) {
  const m = String(iso || '').match(/([+-])(\d{2}):(\d{2})$/);
  const t = Date.parse(iso);
  if (!m || !Number.isFinite(t)) return '';
  const off = (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]);
  return ` until ${new Date(t + off * 60000).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })}`;
}

// Active alerts for a list of zones, straight from the NWS.
export async function fetchMarineAlerts(zones) {
  const resp = await fetch(`https://api.weather.gov/alerts/active?zone=${zones.join(',')}`, {
    headers: { Accept: 'application/geo+json', 'User-Agent': 'NextHour alert server (github.com/jlblan2/next-hour)' },
  });
  if (!resp.ok) throw new Error(`NWS alerts ${resp.status}`);
  return (await resp.json()).features || [];
}

// alerts: GeoJSON features from /alerts/active. zonesBySub: { endpoint: [zone ids] }.
// Returns [{ endpoint, payload }] and records what was sent on each subscriber.
export function marineAlertSends(subs, zonesBySub, alerts, zoneName, now = Date.now()) {
  const out = [];
  for (const [endpoint, sub] of Object.entries(subs)) {
    const sent = sub.marineSent = sub.marineSent || {};
    for (const [id, until] of Object.entries(sent)) if (until < now) delete sent[id];
    const mine = new Set(zonesBySub[endpoint] || []);
    for (const f of alerts) {
      const p = f.properties || {};
      if (!MARINE_EVENTS.has(p.event) || sent[p.id]) continue;
      const hit = ((p.geocode && p.geocode.UGC) || []).filter((z) => mine.has(z));
      if (!hit.length) continue;
      sent[p.id] = Date.parse(p.ends || p.expires) || now + 2 * 86400000;
      const untilText = localTime(p.ends || p.expires);
      out.push({
        endpoint,
        payload: {
          title: `${p.event} · ${zoneName(hit[0])}`,
          body: `${what(p.description) || p.headline || ''}${untilText}`.trim(),
          tag: `marine-${p.id}`,
          url: './',
        },
      });
    }
  }
  return out;
}
