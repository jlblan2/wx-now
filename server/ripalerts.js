// Rip current alerts for saved places and the last location, from the NWS Surf Zone Forecast
// (SRF): each beach zone's rip current risk (Low / Moderate / High) for today and tomorrow.
// Alerts once when the risk reaches the chosen level, again if it rises from Moderate to
// High, and re-arms once it has dropped back on two checks in a row. NWS High Surf and Beach
// Hazards alerts for the place come too, and Rip Current Statements where no SRF covers it.
import { ugcZones } from '../marine.js';

const UA = { 'User-Agent': 'WxNow alert server (github.com/jlblan2/wx-now)', Accept: 'application/geo+json' };
const getJson = (url) => fetch(url, { headers: UA }).then((r) => { if (!r.ok) throw new Error(`NWS ${r.status}`); return r.json(); });
export const RISK = { Low: 1, Moderate: 2, High: 3 };
export const SURF_EVENTS = new Set(['High Surf Advisory', 'High Surf Warning', 'Beach Hazards Statement']);

// NWS forecast zone and office for a place (cached for good: zones don't move).
const pointCache = new Map();
export async function beachZoneOf(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (!pointCache.has(key)) {
    const j = await getJson(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
    const p = j.properties || {};
    pointCache.set(key, { zone: (p.forecastZone || '').split('/').pop(), county: (p.county || '').split('/').pop(), cwa: p.cwa });
  }
  return pointCache.get(key);
}

// Parses an SRF product into [{ zones, periods: [{ name, risk, surf }] }].
export function parseSrf(text) {
  const out = [];
  for (const seg of text.split(/^\$\$/m)) {
    const lines = seg.split('\n');
    const at = lines.findIndex((l) => /^[A-Z]{2}[ZC]\d{3}[->].*\d{6}-\s*$/.test(l.trim()));
    if (at < 0) continue;
    let ugc = lines[at];
    for (let i = at + 1; i < lines.length && !/\d{6}-\s*$/.test(ugc); i++) ugc += lines[i];
    const periods = [];
    const re = /^\.([A-Z][A-Za-z ]+?)\.\.\.\s*$([\s\S]*?)(?=^\.[A-Z][A-Za-z ]+?\.\.\.|^&&|(?![\s\S]))/gm;
    for (const m of seg.matchAll(re)) {
      const risk = m[2].match(/Rip Current Risk\*?\.+\s*(Low|Moderate|High)/i);
      if (!risk) continue;
      const surf = m[2].match(/Surf Height\.+\s*([^\n]+?)\.?\s*$/m);
      const cap = (s) => s[0].toUpperCase() + s.slice(1).toLowerCase();
      periods.push({ name: m[1].replace(/\b\w+/g, cap), risk: cap(risk[1]), surf: surf ? surf[1].trim() : '' });
    }
    if (periods.length) out.push({ zones: new Set(ugcZones(ugc)), periods });
  }
  return out;
}

// Latest SRF for an NWS office, parsed; cached 30 minutes. null when the office issues none.
const srfCache = new Map();
export async function surfForecast(cwa) {
  const hit = srfCache.get(cwa);
  if (hit && Date.now() - hit.at < 30 * 60000) return hit.data;
  let data = null;
  try {
    const list = await getJson(`https://api.weather.gov/products/types/SRF/locations/${cwa}`);
    const first = (list['@graph'] || [])[0];
    if (first && Date.now() - Date.parse(first.issuanceTime) < 36 * 3600000) {
      const p = await getJson(first['@id']);
      data = { issued: first.issuanceTime, segments: parseSrf(p.productText || '') };
    }
  } catch { /* none */ }
  srfCache.set(cwa, { at: Date.now(), data });
  return data;
}

export function zoneRisk(srf, zone, county) {
  const seg = srf && srf.segments.find((s) => s.zones.has(zone) || (county && s.zones.has(county)));
  return seg ? seg.periods.slice(0, 3) : null;
}

// `st` is the subscriber's state for the place and is updated. Returns 'risk', 'higher' or null.
export function decideRip(st, periods, minLevel) {
  const top = Math.max(0, ...periods.map((p) => RISK[p.risk] || 0));
  if (top < minLevel) {
    if (++st.low >= 2) { st.armed = true; st.level = 0; }
    return null;
  }
  st.low = 0;
  if (st.armed !== false) { st.armed = false; st.level = top; return 'risk'; }
  if (top > (st.level || 0)) { st.level = top; return 'higher'; }
  return null;
}

export function ripMessage(periods, placeName, minLevel) {
  const top = Math.max(...periods.map((p) => RISK[p.risk] || 0));
  const word = top === 3 ? 'High' : 'Moderate';
  const when = periods.filter((p) => RISK[p.risk] >= minLevel)
    .map((p) => `${p.name.replace(/^Rest Of /, '')}: ${p.risk.toLowerCase()}${p.surf ? `, surf ${p.surf}` : ''}`);
  return {
    title: `${word} rip current risk · ${placeName}`,
    body: `${when.join('. ')}. ${top === 3 ? 'Life-threatening rip currents are likely. Stay out of the water or swim near a lifeguard.' : 'Rip currents are possible; swim near a lifeguard.'} If caught, swim parallel to the shore.`,
  };
}
