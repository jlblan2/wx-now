// "Second opinion": NOAA's GFS weather and GFS-Wave models side by side with the Navy's
// NAVGEM and WAVEWATCH III (served by the alert server from FNMOC data), day by day, with
// the days where they disagree flagged as lower confidence.

const DAYS = 5;

async function getJson(url, ms = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const resp = await fetch(url, { signal: ctl.signal });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(j.error || j.reason || `HTTP ${resp.status}`);
    return j;
  } finally {
    clearTimeout(timer);
  }
}

async function noaa(lat, lon) {
  const q = `latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&timezone=auto&forecast_days=${DAYS + 1}`;
  const [wx, sea] = await Promise.all([
    getJson(`https://api.open-meteo.com/v1/forecast?${q}&models=gfs_seamless` +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max'),
    getJson(`https://marine-api.open-meteo.com/v1/marine?${q}&models=ncep_gfswave025&daily=wave_height_max`).catch(() => null),
  ]);
  return { wx, sea };
}

// Navy series (3-hourly to 24 h, then 6-hourly) -> per local day: high/low (C), rain (mm), max wind (km/h), max waves (m).
function navyDaily(navy, offsetSec) {
  const base = Date.parse(navy.base);
  const days = new Map();
  const day = (ms) => new Date(ms + offsetSec * 1000).toISOString().slice(0, 10);
  const get = (d) => days.get(d) || days.set(d, { t: [], rain: 0, rainSteps: 0, wind: [], wave: [] }).get(d);
  const s = navy.series;
  navy.steps.forEach((h, i) => {
    const t = base + h * 3600000;
    const d = get(day(t));
    if (s.t2m[i] !== null) d.t.push(s.t2m[i] - 273.15);
    if (s.u10[i] !== null && s.v10[i] !== null) d.wind.push(Math.hypot(s.u10[i], s.v10[i]) * 3.6);
    if (s.swh[i] !== null) d.wave.push(s.swh[i]);
    // Rain is a 6-hour total ending at this step; credit it to the day of its midpoint.
    if (h > 0 && h % 6 === 0 && s.apcp[i] !== null) {
      const r = get(day(t - 3 * 3600000));
      r.rain += s.apcp[i];
      r.rainSteps++;
    }
  });
  const out = {};
  for (const [d, v] of days) {
    if (v.t.length < 4) continue;   // need samples across the day to call a high and low
    out[d] = {
      hi: Math.max(...v.t), lo: Math.min(...v.t),
      rain: v.rainSteps >= 3 ? v.rain : null,
      wind: v.wind.length ? Math.max(...v.wind) : null,
      wave: v.wave.length ? Math.max(...v.wave) : null,
    };
  }
  return out;
}

// Disagreement thresholds (metric): beyond these a day is flagged.
const LIMITS = { hi: 3, lo: 3, rain: 6, wind: 16, wave: 0.6 };

export async function secondOpinion(server, lat, lon) {
  const [n, navy] = await Promise.all([
    noaa(lat, lon),
    getJson(`${server}/api/navy/point?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`),
  ]);
  const off = n.wx.utc_offset_seconds || 0;
  const nd = navyDaily(navy, off);
  const w = n.wx.daily, waves = n.sea && n.sea.daily;
  const rows = [];
  w.time.forEach((date, i) => {
    const v = nd[date];
    if (!v || rows.length >= DAYS) return;
    const noaaDay = {
      hi: w.temperature_2m_max[i], lo: w.temperature_2m_min[i], rain: w.precipitation_sum[i],
      wind: w.wind_speed_10m_max[i], wave: waves ? waves.wave_height_max[waves.time.indexOf(date)] ?? null : null,
    };
    const flags = Object.keys(LIMITS).filter((k) => {
      const a = noaaDay[k], b = v[k];
      if (a === null || a === undefined || b === null || b === undefined) return false;
      if (k === 'rain') return Math.abs(a - b) >= LIMITS.rain && Math.max(a, b) >= 5;
      return Math.abs(a - b) >= LIMITS[k];
    });
    rows.push({ date, noaa: noaaDay, navy: v, flags });
  });
  const coastal = rows.some((r) => r.navy.wave !== null && r.noaa.wave !== null);
  return { rows, coastal, navyRun: navy.base };
}
