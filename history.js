// "History": how the NOAA and Navy forecasts for each of the last 7 days compared with what
// the nearest airport weather station actually measured, so the user can judge the models.
//   Observed: hourly ASOS reports from the Iowa Environmental Mesonet archive (station found
//             through the NWS points API).
//   NOAA:     GFS as forecast about a day ahead (Open-Meteo previous-runs API, "previous_day1").
//   Navy:     NAVGEM forecast 18-24 h ahead, saved by the alert server for every run.
// All values are metric: °C, mm, km/h.

import { getJson } from './compare.js';

export const HISTORY_DAYS = 7;
const MAX_STATION_KM = 60;

function km(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

// The place's calendar date of a UTC time.
export function localDate(ms, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}

// The last n complete days before today, oldest first.
export function pastDays(nowMs, timeZone, n = HISTORY_DAYS) {
  const today = Date.parse(`${localDate(nowMs, timeZone)}T00:00:00Z`);   // date arithmetic in UTC, so DST can't skip a day
  const out = [];
  for (let back = n; back >= 1; back--) out.push(new Date(today - back * 86400000).toISOString().slice(0, 10));
  return out;
}

// Airport stations (ICAO "Kxxx") near the spot, nearest first, plus the place's time zone.
async function stationsNear(lat, lon) {
  const pt = await getJson(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, 12000);
  const st = await getJson(pt.properties.observationStations, 12000);
  const list = st.features
    .filter((f) => /^K[A-Z0-9]{3}$/.test(f.properties.stationIdentifier))
    .map((f) => ({
      id: f.properties.stationIdentifier, name: f.properties.name,
      km: km(lat, lon, f.geometry.coordinates[1], f.geometry.coordinates[0]),
    }))
    .filter((s) => s.km <= MAX_STATION_KM)
    .sort((a, b) => a.km - b.km);
  return { list, timeZone: pt.properties.timeZone };
}

// IEM ASOS CSV (station,valid,tmpf,sknt,p01i; valid in local time) -> per local day.
// Routine hourly reports only, so each hour's rain total is counted once.
export function observedDaily(csv) {
  const days = {};
  const num = (s) => (s === undefined || s === 'M' || s === '' ? null : s === 'T' ? 0 : +s);
  for (const line of csv.trim().split('\n').slice(1)) {
    const [, valid, tmpf, sknt, p01i] = line.split(',');
    if (!valid) continue;
    const d = days[valid.slice(0, 10)] ||= { t: [], wind: [], rain: 0, rainN: 0, n: 0 };
    d.n++;
    const t = num(tmpf), w = num(sknt), p = num(p01i);
    if (t !== null) d.t.push((t - 32) * 5 / 9);
    if (w !== null) d.wind.push(w * 1.852);
    if (p !== null) { d.rain += p * 25.4; d.rainN++; }
  }
  const out = {};
  for (const [date, d] of Object.entries(days)) {
    if (d.t.length < 18) continue;   // too many missing reports to call the day
    out[date] = {
      hi: Math.max(...d.t), lo: Math.min(...d.t),
      rain: d.rainN >= 18 ? d.rain : null,
      wind: d.wind.length >= 18 ? Math.max(...d.wind) : null,
    };
  }
  return out;
}

async function observed(lat, lon, days) {
  const { list, timeZone } = await stationsNear(lat, lon);
  if (!list.length) throw new Error(`no airport weather station within ${MAX_STATION_KM} km`);
  const sts = new Date(Date.parse(`${days[0]}T00:00:00Z`) - 86400000).toISOString().slice(0, 16);
  const ets = new Date(Date.parse(`${days[days.length - 1]}T00:00:00Z`) + 2 * 86400000).toISOString().slice(0, 16);
  // Small AWOS sites are sometimes missing from the archive: try the next nearest.
  for (const s of list.slice(0, 3)) {
    const url = 'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?' +
      `station=${s.id.slice(1)}&data=tmpf&data=sknt&data=p01i&tz=${encodeURIComponent(timeZone)}` +
      `&format=onlycomma&report_type=3&sts=${sts}Z&ets=${ets}Z`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const resp = await fetch(url, { signal: ctl.signal });
      if (!resp.ok) continue;
      const daily = observedDaily(await resp.text());
      if (days.some((d) => daily[d])) return { station: s, timeZone, daily };
    } catch { /* try the next station */ } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('no reports from the nearest stations');
}

// Open-Meteo previous-runs hourly series (local times) -> per local day.
export function noaaDaily(h) {
  const days = {};
  h.time.forEach((t, i) => {
    const d = days[t.slice(0, 10)] ||= { t: [], rain: [], wind: [] };
    const a = h.temperature_2m_previous_day1[i], p = h.precipitation_previous_day1[i], w = h.wind_speed_10m_previous_day1[i];
    if (a !== null) d.t.push(a);
    if (p !== null) d.rain.push(p);
    if (w !== null) d.wind.push(w);
  });
  const out = {};
  for (const [date, d] of Object.entries(days)) {
    if (d.t.length < 20) continue;
    out[date] = {
      hi: Math.max(...d.t), lo: Math.min(...d.t),
      rain: d.rain.length >= 20 ? d.rain.reduce((s, x) => s + x, 0) : null,
      wind: d.wind.length >= 20 ? Math.max(...d.wind) : null,
    };
  }
  return out;
}

// The previous-runs service is sometimes overloaded: one retry, then a plain message.
async function noaaPast(lat, lon) {
  const url = 'https://previous-runs-api.open-meteo.com/v1/forecast?' +
    `latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&timezone=auto&past_days=${HISTORY_DAYS + 1}&forecast_days=1` +
    '&models=gfs_seamless&hourly=temperature_2m_previous_day1,precipitation_previous_day1,wind_speed_10m_previous_day1';
  let j;
  for (let attempt = 0; !j; attempt++) {
    try {
      j = await getJson(url, 15000);
    } catch (e) {
      if (attempt) throw new Error(e.name === 'AbortError' ? 'the Open-Meteo archive did not answer' : e.message);
    }
  }
  return { daily: noaaDaily(j.hourly), timeZone: j.timezone };
}

// Saved Navy runs -> per local day. Each 3-hourly time uses the newest run at least 18 h
// before it; rain is the 6-hour total ending 24 h (else 18 h) into a run, credited to the
// day of the period's midpoint.
export function navyHistDaily(hist, timeZone) {
  const at = new Map(), rain = new Map();
  for (const run of hist.runs) {
    const base = Date.parse(run.base), s = run.series;
    hist.steps.forEach((h, i) => {
      const t = base + h * 3600000;
      const cur = at.get(t);
      if (s.t2m[i] !== null && (!cur || h < cur.lead)) {
        at.set(t, { lead: h, t: s.t2m[i] - 273.15, wind: s.u10[i] !== null && s.v10[i] !== null ? Math.hypot(s.u10[i], s.v10[i]) * 3.6 : null });
      }
      if (h % 6 === 0 && s.apcp[i] !== null) {
        const r = rain.get(t);
        if (!r || h > r.lead) rain.set(t, { lead: h, mm: s.apcp[i] });
      }
    });
  }
  const days = {};
  const get = (d) => (days[d] ||= { t: [], wind: [], rain: 0, rainN: 0 });
  for (const [t, v] of at) {
    const d = get(localDate(t, timeZone));
    d.t.push(v.t);
    if (v.wind !== null) d.wind.push(v.wind);
  }
  for (const [t, v] of rain) {
    const d = get(localDate(t - 3 * 3600000, timeZone));
    d.rain += v.mm;
    d.rainN++;
  }
  const out = {};
  for (const [date, d] of Object.entries(days)) {
    if (d.t.length < 6) continue;   // need most of the day's 8 three-hourly times
    out[date] = {
      hi: Math.max(...d.t), lo: Math.min(...d.t),
      rain: d.rainN >= 4 ? d.rain : null,
      wind: d.wind.length ? Math.max(...d.wind) : null,
    };
  }
  return out;
}

export const KEYS = ['hi', 'lo', 'rain', 'wind'];

// Average miss of each model against the observations, per field, over the days both have.
export function scores(rows) {
  const out = {};
  for (const m of ['noaa', 'navy']) {
    out[m] = {};
    for (const k of KEYS) {
      const errs = rows.filter((r) => r.obs?.[k] != null && r[m]?.[k] != null).map((r) => Math.abs(r[m][k] - r.obs[k]));
      out[m][k] = errs.length ? { mae: errs.reduce((s, x) => s + x, 0) / errs.length, n: errs.length } : null;
    }
  }
  return out;
}

export async function forecastHistory(server, lat, lon, nowMs = Date.now()) {
  const [nRes, vRes] = await Promise.allSettled([
    noaaPast(lat, lon),
    server ? getJson(`${server}/api/navy/history?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`) : Promise.reject(new Error('no alert server')),
  ]);
  const tz0 = nRes.status === 'fulfilled' ? nRes.value.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const days = pastDays(nowMs, tz0);
  let oRes;
  try { oRes = { status: 'fulfilled', value: await observed(lat, lon, days) }; } catch (e) { oRes = { status: 'rejected', reason: e }; }
  const timeZone = oRes.status === 'fulfilled' ? oRes.value.timeZone : tz0;
  const noaa = nRes.status === 'fulfilled' ? nRes.value.daily : {};
  const navy = vRes.status === 'fulfilled' ? navyHistDaily(vRes.value, timeZone) : {};
  const obs = oRes.status === 'fulfilled' ? oRes.value.daily : {};
  const rows = days.map((date) => ({ date, obs: obs[date] || null, noaa: noaa[date] || null, navy: navy[date] || null }));
  const why = (r) => (r.status === 'rejected' ? r.reason?.message || String(r.reason) : null);
  return {
    rows, score: scores(rows),
    station: oRes.status === 'fulfilled' ? oRes.value.station : null,
    errors: { obs: why(oRes), noaa: why(nRes), navy: why(vRes) },
  };
}
