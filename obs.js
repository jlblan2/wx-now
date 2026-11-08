// What the nearest airport weather station is reporting right now (U.S. only): visibility and
// the weather it sees falling (rain, snow, sleet, freezing rain). These are measured, so they
// win over the weather model when they are recent.
// Reports come from the Iowa Environmental Mesonet's live METAR feed (one request for the
// nearest stations, minutes old); the NWS API is the fallback (it sometimes lags 2+ hours).

import { getJson } from './compare.js';
import { stationsNear } from './history.js';

const MAX_AGE_MIN = 90;   // older reports are not "now"

// NWS present-weather codes -> the precipitation it is.
const PHASE = {
  snow: 'snow', snow_grains: 'snow', snow_pellets: 'snow', ice_crystals: 'snow', snow_showers: 'snow',
  ice_pellets: 'sleet', hail: null, small_hail: null,
  freezing_rain: 'freezing rain', freezing_drizzle: 'freezing rain',
  rain: 'rain', drizzle: 'rain', rain_showers: 'rain', showers: 'rain', thunderstorms: null,
};

// The kind of precipitation in a list of NWS presentWeather entries, or null when none is falling.
export function obsPhase(present) {
  const kinds = new Set();
  for (const w of present || []) {
    const k = PHASE[w.weather];
    if (k) kinds.add(k);
  }
  if (kinds.has('freezing rain')) return 'freezing rain';
  if (kinds.has('sleet')) return 'sleet';
  if (kinds.has('snow') && kinds.has('rain')) return 'rain and snow';
  if (kinds.has('snow')) return 'snow';
  if (kinds.has('rain')) return 'rain';
  return null;
}

// What reduces visibility, from the station's report (fog, mist, haze, smoke, dust, ...).
const OBSCURE = { fog: 'fog', fog_mist: 'mist', mist: 'mist', haze: 'haze', smoke: 'smoke', dust: 'dust', sand: 'sand', spray: 'spray' };
function obscuration(present) {
  for (const w of present || []) if (OBSCURE[w.weather]) return OBSCURE[w.weather];
  return null;
}

// METAR weather codes ("-SN BR", "TSRA", "FZDZ") -> precipitation type and obscuration.
export function metarPhase(codes) {
  const c = (codes || []).join(' ');
  if (/FZ(RA|DZ)/.test(c)) return 'freezing rain';
  if (/PL/.test(c)) return 'sleet';
  const snow = /SN|SG/.test(c), rain = /(?<!FZ)(RA|DZ)/.test(c);
  if (snow && rain) return 'rain and snow';
  if (snow) return 'snow';
  if (rain) return 'rain';
  return null;
}
export function metarObscured(codes) {
  const c = (codes || []).join(' ');
  for (const [k, w] of [['FG', 'fog'], ['FU', 'smoke'], ['HZ', 'haze'], ['BR', 'mist'], ['DU', 'dust'], ['SA', 'sand']]) if (c.includes(k)) return w;
  return null;
}

async function fromIem(list) {
  const q = list.map((s) => `station=${s.id.slice(1)}`).join('&');
  const j = await getJson(`https://mesonet.agron.iastate.edu/api/1/currents.json?${q}`, 10000);
  const byId = new Map();
  for (const d of j.data || []) {
    if (!/_(ASOS|AWOS)$/.test(d.network) || d.vsby === null || d.vsby === undefined) continue;
    const time = Date.parse(d.utc_valid);
    if (!(Date.now() - time < MAX_AGE_MIN * 60000)) continue;
    const codes = d.wxcodes || [];
    byId.set(`K${d.station}`, {
      time, text: d.raw || '', visM: d.vsby * 1609.344, phase: metarPhase(codes), obscured: metarObscured(codes),
    });
  }
  const s = list.find((x) => byId.has(x.id));
  return s ? { station: s, ...byId.get(s.id) } : null;
}

// Latest report from the nearest station that has one less than 90 minutes old.
export async function latestObs(lat, lon) {
  const { list } = await stationsNear(lat, lon);
  const near = list.slice(0, 4);
  try {
    const o = await fromIem(near);
    if (o) return o;
  } catch { /* fall back to the NWS API */ }
  for (const s of near.slice(0, 3)) {
    try {
      const j = await getJson(`https://api.weather.gov/stations/${s.id}/observations/latest`, 10000);
      const p = j.properties;
      const time = Date.parse(p.timestamp);
      if (!(Date.now() - time < MAX_AGE_MIN * 60000)) continue;
      const vis = p.visibility && Number.isFinite(p.visibility.value) ? p.visibility.value : null;
      return {
        station: s, time, text: p.textDescription || '',
        visM: vis, phase: obsPhase(p.presentWeather), obscured: obscuration(p.presentWeather),
      };
    } catch { /* try the next station */ }
  }
  return null;
}

// Visibility categories (metres): what a boater or driver needs to know.
export function visClass(m) {
  if (m < 400) return { cls: 'bad', word: 'Very poor' };     // under 1/4 mile (dense fog)
  if (m < 1600) return { cls: 'poor', word: 'Poor' };        // under 1 mile
  if (m < 5000) return { cls: 'fair', word: 'Reduced' };     // under 3 miles
  return { cls: 'good', word: 'Good' };
}
