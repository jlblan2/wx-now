// Gulf and Atlantic marine forecasts from the National Weather Service (api.weather.gov): the zone
// forecast for one marine zone, active marine advisories/warnings, and the zone outline.

import { MARINE_ZONES } from './data.js';

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
    if (typeof window === 'undefined') headers['User-Agent'] = 'WxNow alert server (github.com/jlblan2/wx-now)';
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

// Marine zones nearest first: [{ id, name, km }].
export function zonesByDistance(loc) {
  return MARINE_ZONES.map(([id, name, lat, lon]) => ({ id, name, km: loc ? km(loc, { lat, lon }) : 0 }))
    .sort((a, b) => a.km - b.km);
}

// The zone containing the point if there is one, otherwise the nearest.
export async function zoneFor(loc) {
  try {
    const j = await getJson(`${API}/zones?type=marine&point=${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`);
    const f = (j.features || []).find((z) => /^(GMZ|AMZ|ANZ)\d{3}$/.test(z.properties.id));
    if (f) return f.properties.id;
  } catch { /* fall back to nearest */ }
  return zonesByDistance(loc)[0].id;
}

// Splits a period's text into wind / seas summaries; the full text stays available.
function summarize(text) {
  const sentences = text.split(/(?<=\.)\s+/);
  const wind = sentences.find((s) => /knots|\bkts?\b|winds? (light|variable)/i.test(s)) || '';
  const seas = sentences.find((s) => /^(seas|waves)\b/i.test(s)) || sentences.find((s) => /\bseas\b|\bfeet\b|\bfoot\b/i.test(s)) || '';
  const water = sentences.find((s) => /bay and inland waters|chop/i.test(s)) || '';
  return { wind: wind.replace(/\.$/, ''), seas: seas.replace(/\.$/, ''), water: water.replace(/\.$/, '') };
}

// ---------- offshore zones ----------
// Offshore and open-ocean zones have no zone forecast in the API; NHC and the Ocean
// Prediction Center cover them in Offshore Waters Forecast text products instead.
const OFFSHORE = { GMZ: ['NT4'], AMZ: ['NT3', 'NT5'], ANZ: ['NT2', 'NT1'] };

// Zone ids in a UGC line such as "ANZ800-805-161000-" or "AMZ040>042-161000-".
export function ugcZones(line) {
  const out = [];
  let prefix = null, prev = null;
  for (const m of line.matchAll(/([A-Z]{2}Z)?(\d{3})([->])/g)) {
    if (m[1]) prefix = m[1];
    if (!prefix || m[2].length !== 3) continue;
    const n = +m[2];
    if (prev && prev.range) for (let k = prev.n + 1; k < n; k++) out.push(`${prefix}${String(k).padStart(3, '0')}`);
    out.push(`${prefix}${m[2]}`);
    prev = { n, range: m[3] === '>' };
  }
  return out;
}

const title = (s) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

function offshoreSection(text, zoneId) {
  for (const seg of text.split(/\n\$\$/)) {
    const lines = seg.replace(/\r/g, '').split('\n');
    const at = lines.findIndex((l) => /^[A-Z]{2}Z\d{3}[->].*\d{6}-\s*$/.test(l.trim()) && ugcZones(l).includes(zoneId));
    if (at < 0) continue;
    const body = lines.slice(at + 1).join('\n');
    const alerts = [...body.matchAll(/^\.\.\.(.+?)\.\.\.\s*$/gm)].map((m) => ({ event: title(m[1]), headline: m[1] }));
    const periods = [...body.matchAll(/^\.([A-Z][A-Z ]+?)\.\.\.([\s\S]*?)(?=^\.[A-Z][A-Z ]+?\.\.\.|\s*$(?![\s\S]))/gm)]
      .map((m) => {
        const t = m[2].replace(/\s+/g, ' ').trim();
        return { name: title(m[1]).replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) Night$/, '$1 Night'), text: t, ...summarize(t) };
      });
    if (periods.length) return { periods, alerts };
  }
  return null;
}

async function offshoreForecast(zoneId) {
  for (const loc of OFFSHORE[zoneId.slice(0, 3)] || []) {
    const list = await getJson(`${API}/products/types/OFF/locations/${loc}`);
    const latest = (list['@graph'] || [])[0];
    if (!latest) continue;
    const prod = await getJson(`${API}/products/${latest.id}`);
    const sec = offshoreSection(prod.productText || '', zoneId);
    if (sec) return { ...sec, updated: latest.issuanceTime, source: `NWS Offshore Waters Forecast (${loc})` };
  }
  return null;
}

// The offshore zones (no zone forecast in the API); others fall back here too on a 404.
const OFFSHORE_ZONE = /^(GMZ0[45]\d|AMZ0[4-8]\d|ANZ[89]\d\d)$/;

export async function marineForecast(zoneId) {
  const [fc, alerts] = await Promise.all([
    OFFSHORE_ZONE.test(zoneId)
      ? { error: new Error('Offshore zone') }
      : getJson(`${API}/zones/marine/${zoneId}/forecast`).catch((e) => ({ error: e })),
    getJson(`${API}/alerts/active?zone=${zoneId}`).catch(() => ({ features: [] })),
  ]);
  const name = (MARINE_ZONES.find(([id]) => id === zoneId) || [])[1] || zoneId;
  const cap = (alerts.features || []).map((a) => ({
    event: a.properties.event, headline: a.properties.headline, ends: a.properties.ends || a.properties.expires,
  }));
  if (fc.error) {
    const off = await offshoreForecast(zoneId);
    if (!off) throw fc.error;
    return { zone: zoneId, name, updated: off.updated, periods: off.periods, alerts: cap.length ? cap : off.alerts, source: off.source };
  }
  const p = fc.properties || {};
  return {
    zone: zoneId,
    name,
    updated: p.updated,
    periods: (p.periods || []).map((x) => ({ name: x.name, text: x.detailedForecast, ...summarize(x.detailedForecast) })),
    alerts: cap,
  };
}

export async function zoneGeometry(zoneId) {
  const j = await getJson(`${API}/zones/marine/${zoneId}`);
  return j.geometry;
}
