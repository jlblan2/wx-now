// Extreme tide alerts for saved places: NOAA's predicted highs and lows for the next 48 hours
// at the nearest tide station, compared with that station's normal range. Alerts ahead of
// time when a high is predicted to run the chosen amount above Mean Higher-High Water (or
// to reach NOAA's minor flood level), or a low the chosen amount below Mean Lower-Low Water.
import { TIDE_STATIONS } from '../tidestations.js';
import { distKm } from '../storms.js';
import { floodLevels } from './highwater.js';

const API = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const MDAPI = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations';
const UA = { 'User-Agent': 'WxNow alert server (github.com/jlblan2/wx-now)' };
const NEAR_KM = 56;              // about 30 nautical miles
const AHEAD_H = 48;
const REPEAT_GAP_MS = 20 * 3600000;   // at most one alert of each kind per station per ~day
const getJson = (url) => fetch(url, { headers: UA }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
const ymd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;

// MHHW in feet above MLLW, or null when NOAA has no datums for the station. Cached 30 days.
const rangeCache = new Map();
async function normalRange(id) {
  const hit = rangeCache.get(id);
  if (hit && Date.now() - hit.at < 30 * 86400000) return hit.mhhw;
  let mhhw = null;
  try {
    const d = await getJson(`${MDAPI}/${id}/datums.json?units=english`);
    const v = (n) => (d.datums || []).find((x) => x.name === n)?.value;
    if (Number.isFinite(v('MHHW')) && Number.isFinite(v('MLLW'))) mhhw = Math.round((v('MHHW') - v('MLLW')) * 100) / 100;
  } catch { /* no datums */ }
  rangeCache.set(id, { at: Date.now(), mhhw });
  return mhhw;
}

// Nearest station within 30 nm that has a known normal range (subordinate stations often don't).
export async function tideStationFor(place) {
  const near = TIDE_STATIONS
    .map(([id, name, state, lat, lon]) => ({ id, name, state, lat, lon, km: distKm(place, { lat, lon }) }))
    .filter((s) => s.km <= NEAR_KM).sort((a, b) => a.km - b.km).slice(0, 3);
  for (const s of near) {
    const mhhw = await normalRange(s.id);
    if (mhhw !== null) return { ...s, mhhw };
  }
  return null;
}

export async function predictedExtremes(id) {
  const q = new URLSearchParams({
    product: 'predictions', station: id, begin_date: ymd(new Date()), range: String(AHEAD_H + 24), datum: 'MLLW',
    interval: 'hilo', units: 'english', time_zone: 'gmt', format: 'json', application: 'WxNow',
  });
  const j = await getJson(`${API}?${q}`);
  if (j.error) throw new Error(j.error.message || 'No predictions');
  return (j.predictions || []).map((x) => ({ t: Date.parse(`${x.t.replace(' ', 'T')}:00Z`), v: +x.v, high: x.type.startsWith('H') }));
}

// The predicted tides in the next 48 h that count as extreme. `flood` = { minor } ft above MLLW.
export function findExtremes(tides, mhhw, marginFt, flood, now = Date.now()) {
  const soon = tides.filter((x) => x.t > now && x.t <= now + AHEAD_H * 3600000);
  const highs = soon.filter((x) => x.high && (x.v >= mhhw + marginFt || (flood?.minor !== undefined && x.v >= flood.minor)));
  const lows = soon.filter((x) => !x.high && x.v <= -marginFt);
  return { highs, lows };
}

// `st` is this subscriber's state for the station and is updated. Returns the alerts to send:
// [{ kind: 'high' | 'low', list }], each list being the extremes not alerted before.
export function decideTides(st, ex, now = Date.now()) {
  st.sent = (st.sent || []).filter((t) => t > now - 3 * 86400000);
  const out = [];
  for (const kind of ['high', 'low']) {
    const fresh = ex[`${kind}s`].filter((x) => !st.sent.includes(x.t));
    if (!fresh.length) continue;
    if (st[`last_${kind}`] && now - st[`last_${kind}`] < REPEAT_GAP_MS) continue;
    st[`last_${kind}`] = now;
    st.sent.push(...ex[`${kind}s`].map((x) => x.t));
    out.push({ kind, list: ex[`${kind}s`] });
  }
  return out;
}

export function tideMessage(kind, list, station, mhhw, flood, placeName, metric, timeZone) {
  const len = (ft) => (metric ? `${(ft * 0.3048).toFixed(2)} m` : `${ft.toFixed(1)} ft`);
  const when = (t) => new Date(t).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone });
  const top = list.reduce((a, b) => ((kind === 'high' ? b.v > a.v : b.v < a.v) ? b : a));
  const more = list.length > 1 ? ` (${list.length} ${kind === 'high' ? 'highs' : 'lows'} like this in the next 2 days)` : '';
  const where = `${station.name}${placeName ? ` (${placeName})` : ''}`;
  if (kind === 'high') {
    const floodNote = flood?.minor !== undefined
      ? (top.v >= flood.minor ? ' At or above the minor flooding level.' : ` Minor flooding begins at ${len(flood.minor)}.`) : '';
    return {
      title: `Extreme high tide · ${where}`,
      body: `${len(top.v)} at ${when(top.t)}, ${len(Math.max(0, top.v - mhhw))} above a normal high (${len(mhhw)})${more}.${floodNote} Wind and storms can push it higher.`,
    };
  }
  return {
    title: `Extreme low tide · ${where}`,
    body: `${len(top.v)} at ${when(top.t)}, ${len(-top.v)} below a normal low${more}. Watch depths at docks, channels and inlets.`,
  };
}

