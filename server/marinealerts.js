// Marine alerts: Small Craft Advisories and stronger marine hazards for each subscriber's
// Gulf and Atlantic marine zones (the zone chosen in the app, plus the zone at each watched place that
// lies near the water). Each NWS alert is pushed once per subscriber.
import { zoneFor, zonesByDistance, marineForecast } from '../marine.js';

export const MARINE_EVENTS = new Set([
  'Small Craft Advisory',
  'Gale Watch', 'Gale Warning',
  'Storm Watch', 'Storm Warning',
  'Hurricane Force Wind Watch', 'Hurricane Force Wind Warning',
  'Hazardous Seas Watch', 'Hazardous Seas Warning',
  'Special Marine Warning',
  'Dense Fog Advisory',
]);
const NEAR_KM = 100;   // a watched place counts only if a marine zone is this close

// Zones to watch for one subscriber. Point lookups are cached on the subscriber.
export async function marineZones(sub, watchList) {
  if (sub.marine && sub.marine.on === false) return [];
  const zones = new Set();
  if (sub.marine && /^(GMZ|AMZ|ANZ)\d{3}$/.test(sub.marine.zone || '')) zones.add(sub.marine.zone);
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
export function what(description) {
  const m = String(description || '').match(/\*\s*WHAT\.\.\.([\s\S]*?)(?:\n\s*\n|\*\s*WHERE|$)/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

// " until Sat 1:00 PM" in the alert area's own local time (from the timestamp's offset).
export function localTime(iso) {
  const m = String(iso || '').match(/([+-])(\d{2}):(\d{2})$/);
  const t = Date.parse(iso);
  if (!m || !Number.isFinite(t)) return '';
  const off = (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]);
  return ` until ${new Date(t + off * 60000).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })}`;
}

// Active alerts for a list of zones, straight from the NWS.
export async function fetchMarineAlerts(zones) {
  const resp = await fetch(`https://api.weather.gov/alerts/active?zone=${zones.join(',')}`, {
    headers: { Accept: 'application/geo+json', 'User-Agent': 'WxNow alert server (github.com/jlblan2/wx-now)' },
  });
  if (!resp.ok) throw new Error(`NWS alerts ${resp.status}`);
  return (await resp.json()).features || [];
}

// Offshore and open-ocean zones get no NWS alerts feed: their gales and storms appear only
// as headlines ("...GALE WARNING...") in the Offshore Waters Forecasts. These turn them
// into alert-like features, keyed by zone and headline text.
const OFFSHORE_ZONE = /^(GMZ0[45]\d|AMZ0[4-8]\d|ANZ[89]\d\d)$/;
const OFFSHORE_HAZARD = /gale|storm|hurricane|tropical|hazardous seas/i;
const OFFSHORE_KEEP_MS = 6 * 3600000;   // forget a headline 6 h after it leaves the forecast

export async function fetchOffshoreAlerts(zones) {
  const out = [];
  for (const zone of zones.filter((z) => OFFSHORE_ZONE.test(z))) {
    let f;
    try { f = await marineForecast(zone); } catch { continue; }
    for (const a of f.alerts) {
      const text = a.headline || a.event || '';
      if (!OFFSHORE_HAZARD.test(text)) continue;
      // The period that carries the hazard, for the notification body: the one the headline
      // names ("...SUN NIGHT"), otherwise the period with the strongest winds.
      const named = [...f.periods].sort((x, y) => y.name.length - x.name.length)
        .find((x) => text.toUpperCase().includes(x.name.toUpperCase()));
      const maxKt = (x) => Math.max(0, ...[...x.text.matchAll(/(\d+) kt/g)].map((m) => +m[1]));
      const p = named || [...f.periods].sort((x, y) => maxKt(y) - maxKt(x))[0];
      out.push({
        offshore: true,
        properties: {
          id: `off:${zone}:${text.toUpperCase().replace(/\s+/g, ' ')}`,
          event: a.event,
          headline: text,
          geocode: { UGC: [zone] },
          description: p ? `* WHAT...${p.name}: ${[p.wind, p.seas].filter(Boolean).join('. ')}.` : '',
        },
      });
    }
  }
  return out;
}

// alerts: GeoJSON features from /alerts/active (plus fetchOffshoreAlerts items). zonesBySub: { endpoint: [zone ids] }.
// Returns [{ endpoint, payload }] and records what was sent on each subscriber.
export function marineAlertSends(subs, zonesBySub, alerts, zoneName, now = Date.now()) {
  const out = [];
  for (const [endpoint, sub] of Object.entries(subs)) {
    const sent = sub.marineSent = sub.marineSent || {};
    for (const [id, until] of Object.entries(sent)) if (until < now) delete sent[id];
    const mine = new Set(zonesBySub[endpoint] || []);
    for (const f of alerts) {
      const p = f.properties || {};
      if (!f.offshore && !MARINE_EVENTS.has(p.event)) continue;
      if (sent[p.id]) {
        if (f.offshore && (zonesBySub[endpoint] || []).some((z) => p.geocode.UGC.includes(z))) sent[p.id] = now + OFFSHORE_KEEP_MS;
        continue;
      }
      const hit = ((p.geocode && p.geocode.UGC) || []).filter((z) => mine.has(z));
      if (!hit.length) continue;
      sent[p.id] = f.offshore ? now + OFFSHORE_KEEP_MS : Date.parse(p.ends || p.expires) || now + 2 * 86400000;
      const untilText = localTime(p.ends || p.expires);
      out.push({
        endpoint,
        payload: {
          title: `${p.event} · ${zoneName(hit[0])}`,
          body: `${what(p.description) || p.headline || ''}${untilText}`.trim(),
          tag: `marine-${p.id}`,
          url: './?tab=seas',
        },
      });
    }
  }
  return out;
}
