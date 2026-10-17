// Fog and low visibility alerts for saved places, from two sources:
// - the hourly visibility forecast (Open-Meteo, best model for the spot) for the next 12
//   hours: alerts once when visibility is forecast to drop to the chosen distance for 2 hours
//   or more, and re-arms once the forecast has cleared on two checks in a row;
// - NWS advisories at the place itself (Dense Fog, Freezing Fog, Dense Smoke).

const API = 'https://api.open-meteo.com/v1/forecast';
const UA = { 'User-Agent': 'WxNow alert server (github.com/jlblan2/wx-now)' };
const WINDOW_H = 12;
const MIN_HOURS = 2;
const NM = 1852;
export const FOG_EVENTS = new Set(['Dense Fog Advisory', 'Freezing Fog Advisory', 'Dense Smoke Advisory']);

// Hourly visibility: [{ t (UTC ms), local (ms, local clock shown as UTC), nm }].
export async function visibilityForecast(lat, lon) {
  const q = `latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&hourly=visibility&timezone=auto&forecast_days=2`;
  const r = await fetch(`${API}?${q}`);
  if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
  const j = await r.json();
  const off = (j.utc_offset_seconds || 0) * 1000, h = j.hourly || {};
  return (h.time || []).map((t, i) => {
    const local = Date.parse(`${t}:00Z`);
    return { t: local - off, local, nm: h.visibility[i] === null ? null : h.visibility[i] / NM };
  }).filter((x) => x.nm !== null);
}

// First stretch of 2+ hours in the next 12 at or below the threshold, with its lowest hour.
export function fogEvent(hours, thresholdNm, now = Date.now()) {
  const next = hours.filter((x) => x.t >= now - 3600000 && x.t <= now + WINDOW_H * 3600000);
  const min = next.length ? Math.min(...next.map((x) => x.nm)) : Infinity;
  let run = [];
  for (const x of [...next, null]) {
    if (x && x.nm <= thresholdNm) { run.push(x); continue; }
    if (run.length >= MIN_HOURS) {
      const low = run.reduce((a, b) => (b.nm < a.nm ? b : a));
      return { event: { start: run[0], end: run[run.length - 1], low }, min };
    }
    run = [];
  }
  return { event: null, min };
}

// `st` is this subscriber's state for the place and is updated. Returns true to alert.
export function decideFog(st, f, thresholdNm) {
  if (!f.event) {
    if (f.min > thresholdNm && ++st.low >= 2) st.armed = true;
    return false;
  }
  st.low = 0;
  if (st.armed === false) return false;
  st.armed = false;
  return true;
}

export function distText(nm, metric) {
  if (metric) {
    const m = nm * NM;
    return m < 1000 ? `${Math.max(50, Math.round(m / 50) * 50)} m` : `${(m / 1000).toFixed(1)} km`;
  }
  if (nm < 1) return `${nm.toFixed(nm < 0.5 ? 2 : 1)} nm (${Math.max(50, Math.round(nm * 2025.37 / 50) * 50)} yd)`;
  return `${nm.toFixed(1)} nm (${(nm * 1.15078).toFixed(1)} mi)`;
}

export function fogMessage(ev, placeName, metric) {
  const when = (x) => {   // local clock time, e.g. "Sun 4 AM"
    const d = new Date(x.local), h = d.getUTCHours();
    return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
  };
  return {
    title: `Fog forecast · ${placeName}`,
    body: `Visibility down to ${distText(ev.low.nm, metric)}, ${when(ev.start)} to ${when(ev.end)}. Lowest around ${when(ev.low)}.`,
  };
}

// Active NWS alerts covering a point (land or marine zone).
export async function pointAlerts(lat, lon) {
  const r = await fetch(`https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`, {
    headers: { ...UA, Accept: 'application/geo+json' },
  });
  if (!r.ok) throw new Error(`NWS alerts ${r.status}`);
  return (await r.json()).features || [];
}
