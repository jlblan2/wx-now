// Gulf marine forecasts from the National Weather Service (api.weather.gov): the zone
// forecast for one marine zone, active marine advisories/warnings, and the zone outline.

import { GULF_ZONES } from './data.js';

const API = 'https://api.weather.gov';
const CACHE_MS = 15 * 60000;
const cache = new Map();

async function getJson(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const headers = { Accept: 'application/geo+json' };
    // NWS asks servers to identify themselves; browsers send their own User-Agent.
    if (typeof window === 'undefined') headers['User-Agent'] = 'NextHour alert server (github.com/jlblan2/next-hour)';
    const resp = await fetch(url, { signal: ctl.signal, headers });
    if (!resp.ok) throw new Error(`NWS ${resp.status}`);
    const data = await resp.json();
    cache.set(url, { at: Date.now(), data });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function km(a, b) {
  const r = Math.PI / 180;
  const x = (b.lon - a.lon) * Math.cos((a.lat + b.lat) / 2 * r), y = b.lat - a.lat;
  return Math.hypot(x, y) * 111.2;
}

// Gulf zones nearest first: [{ id, name, km }].
export function zonesByDistance(loc) {
  return GULF_ZONES.map(([id, name, lat, lon]) => ({ id, name, km: loc ? km(loc, { lat, lon }) : 0 }))
    .sort((a, b) => a.km - b.km);
}

// The zone containing the point if there is one, otherwise the nearest.
export async function zoneFor(loc) {
  try {
    const j = await getJson(`${API}/zones?type=marine&point=${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`);
    const f = (j.features || []).find((z) => /^GMZ/.test(z.properties.id));
    if (f) return f.properties.id;
  } catch { /* fall back to nearest */ }
  return zonesByDistance(loc)[0].id;
}

// Splits a period's text into wind / seas summaries; the full text stays available.
function summarize(text) {
  const sentences = text.split(/(?<=\.)\s+/);
  const wind = sentences.find((s) => /knots|winds? (light|variable)/i.test(s)) || '';
  const seas = sentences.find((s) => /^(seas|waves)\b/i.test(s)) || sentences.find((s) => /\bseas\b|\bfeet\b|\bfoot\b/i.test(s)) || '';
  const water = sentences.find((s) => /bay and inland waters|chop/i.test(s)) || '';
  return { wind: wind.replace(/\.$/, ''), seas: seas.replace(/\.$/, ''), water: water.replace(/\.$/, '') };
}

export async function marineForecast(zoneId) {
  const [fc, alerts] = await Promise.all([
    getJson(`${API}/zones/marine/${zoneId}/forecast`),
    getJson(`${API}/alerts/active?zone=${zoneId}`).catch(() => ({ features: [] })),
  ]);
  const p = fc.properties || {};
  return {
    zone: zoneId,
    name: (GULF_ZONES.find(([id]) => id === zoneId) || [])[1] || zoneId,
    updated: p.updated,
    periods: (p.periods || []).map((x) => ({ name: x.name, text: x.detailedForecast, ...summarize(x.detailedForecast) })),
    alerts: (alerts.features || []).map((a) => ({
      event: a.properties.event, headline: a.properties.headline, ends: a.properties.ends || a.properties.expires,
    })),
  };
}

export async function zoneGeometry(zoneId) {
  const j = await getJson(`${API}/zones/marine/${zoneId}`);
  return j.geometry;
}
