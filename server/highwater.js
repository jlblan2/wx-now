// High water alerts: the measured water level at the NOAA gauge nearest each watched place,
// compared with the gauge's own tide prediction. Alerts when it runs a chosen amount above
// predicted, again if it climbs another foot, and when it reaches NOAA's coastal flood
// levels (minor, moderate, major). Quiet until the water drops back.
import { WL_STATIONS } from '../tidestations.js';
import { distKm } from '../storms.js';

const API = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const MDAPI = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations';
const NEAR_KM = 56;            // about 30 nautical miles
const STEP_FT = 1.0;           // alert again for each further foot
const REARM_MARGIN_FT = 0.3;   // must drop this far below the threshold to re-arm
const STAGES = ['minor', 'moderate', 'major'];

export function gaugeFor(place) {
  let best = null;
  for (const [id, name, lat, lon] of WL_STATIONS) {
    const d = distKm(place, { lat, lon });
    if (!best || d < best.km) best = { id, name, lat, lon, km: d };
  }
  return best && best.km <= NEAR_KM ? best : null;
}

const UA = { 'User-Agent': 'NextHour alert server (github.com/jlblan2/next-hour)' };
const getJson = (url) => fetch(url, { headers: UA }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
const ymd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
const parseT = (t) => Date.parse(`${t.replace(' ', 'T')}:00Z`);

const floodCache = new Map();   // id -> { at, levels }

// NOAA flood levels converted to feet above MLLW (NWS levels preferred, else NOS).
async function floodLevels(id) {
  const hit = floodCache.get(id);
  if (hit && Date.now() - hit.at < 24 * 3600000) return hit.levels;
  let levels = null;
  try {
    const [f, d] = await Promise.all([getJson(`${MDAPI}/${id}/floodlevels.json`), getJson(`${MDAPI}/${id}/datums.json`)]);
    const mllw = (d.datums || []).find((x) => x.name === 'MLLW');
    if (mllw && d.units === 'feet') {
      levels = {};
      for (const s of STAGES) {
        const v = f[`nws_${s}`] ?? f[`nos_${s}`];
        if (typeof v === 'number') levels[s] = Math.round((v - mllw.value) * 10) / 10;
      }
    }
  } catch { /* flood levels are optional */ }
  floodCache.set(id, { at: Date.now(), levels });
  return levels;
}

// Latest reading, the prediction at that moment, the trend and the flood levels.
export async function gaugeNow(id) {
  const common = `station=${id}&datum=MLLW&units=english&time_zone=gmt&format=json&application=NextHour`;
  const start = new Date(Date.now() - 3 * 3600000);
  const [obs, pred, flood] = await Promise.all([
    getJson(`${API}?product=water_level&date=recent&${common}`),
    getJson(`${API}?product=predictions&interval=6&begin_date=${ymd(start)}&range=48&${common}`),
    floodLevels(id),
  ]);
  const o = (obs.data || []).filter((x) => x.v !== '').map((x) => ({ t: parseT(x.t), v: +x.v }));
  const last = o[o.length - 1];
  if (!last || Date.now() - last.t > 90 * 60000) return null;   // no recent reading
  const p = (pred.predictions || []).map((x) => ({ t: parseT(x.t), v: +x.v }));
  let predicted = null;
  for (let i = 1; i < p.length; i++) {
    if (p[i].t >= last.t) {
      const f = (last.t - p[i - 1].t) / ((p[i].t - p[i - 1].t) || 1);
      predicted = p[i - 1].v + (p[i].v - p[i - 1].v) * f;
      break;
    }
  }
  if (predicted === null) return null;
  const ago = o.find((x) => x.t >= last.t - 30 * 60000);
  return {
    t: last.t, level: last.v, predicted, above: last.v - predicted,
    rising: ago ? last.v - ago.v > 0.03 : null, flood,
  };
}

const stageOf = (level, flood) => {
  let s = -1;
  STAGES.forEach((name, i) => { if (flood && flood[name] !== undefined && level >= flood[name]) s = i; });
  return s;
};

// Decides whether to alert for one gauge reading. `st` is this subscriber's state for the
// gauge and is updated. Returns 'above', 'higher', a flood stage name, or null.
export function decideHighWater(st, r, thresholdFt) {
  const stage = stageOf(r.level, r.flood);
  if (st.stage === undefined) st.stage = -1;
  if (stage > st.stage) { st.stage = stage; st.armed = false; st.lastAbove = Math.max(st.lastAbove || 0, r.above); return STAGES[stage]; }
  if (r.flood && st.stage >= 0 && r.level < r.flood[STAGES[st.stage]] - REARM_MARGIN_FT) st.stage = stage;
  if (r.above < thresholdFt - REARM_MARGIN_FT) {
    if (++st.low >= 2) { st.armed = true; st.lastAbove = 0; }
    return null;
  }
  st.low = 0;
  if (st.armed !== false && r.above >= thresholdFt) { st.armed = false; st.lastAbove = r.above; return 'above'; }
  if (st.armed === false && r.above >= (st.lastAbove || 0) + STEP_FT) { st.lastAbove = r.above; return 'higher'; }
  return null;
}

export function highWaterMessage(kind, r, gauge, placeName) {
  const ft = (v) => `${v.toFixed(1)} ft`;
  const flood = r.flood && r.flood.minor !== undefined ? ` Minor flooding begins at ${ft(r.flood.minor)}.` : '';
  const trend = r.rising === null ? '' : r.rising ? ', rising' : ', not rising';
  const where = `${gauge.name}${placeName ? ` (${placeName})` : ''}`;
  if (STAGES.includes(kind)) {
    return {
      title: `${kind[0].toUpperCase()}${kind.slice(1)} coastal flooding level reached · ${gauge.name}`,
      body: `Water ${ft(r.level)} above MLLW${trend}, ${ft(r.above)} above predicted, near ${placeName || gauge.name}.`,
    };
  }
  return {
    title: `High water · ${where}`,
    body: `${kind === 'higher' ? 'Still climbing: ' : ''}${ft(r.above)} above predicted. Water ${ft(r.level)} above MLLW${trend}.${flood}`,
  };
}
