// Wind forecast alerts for saved places: Open-Meteo's hourly forecast (best model for the
// spot) for the next 24 hours. Alerts once when sustained wind is forecast to reach the
// chosen speed, again if the forecast peak grows another 10 kt, and re-arms once the
// forecast has eased below the threshold on two checks in a row.

const API = 'https://api.open-meteo.com/v1/forecast';
const WINDOW_H = 24;
const STEP_KT = 10;        // alert again when the forecast peak grows this much
const REARM_MARGIN_KT = 3;
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];

// Hourly wind for the spot: [{ t (UTC ms), local (ms, local clock shown as UTC), kt, gust, dir }].
export async function windForecast(lat, lon) {
  const q = `latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
    '&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m&wind_speed_unit=kn&timezone=auto&forecast_days=2';
  const r = await fetch(`${API}?${q}`);
  if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
  const j = await r.json();
  const off = (j.utc_offset_seconds || 0) * 1000, h = j.hourly || {};
  return (h.time || []).map((t, i) => {
    const local = Date.parse(`${t}:00Z`);
    return { t: local - off, local, kt: h.wind_speed_10m[i], gust: h.wind_gusts_10m[i], dir: h.wind_direction_10m[i] };
  }).filter((x) => x.kt !== null);
}

// The stretch of the next 24 hours at or above the threshold, with its peak, or null.
export function windEvent(hours, thresholdKt, now = Date.now()) {
  const next = hours.filter((x) => x.t >= now - 3600000 && x.t <= now + WINDOW_H * 3600000);
  const over = next.filter((x) => x.kt >= thresholdKt);
  if (!over.length) return { event: null, max: Math.max(0, ...next.map((x) => x.kt)) };
  const peak = over.reduce((a, b) => (b.kt > a.kt ? b : a));
  const gust = Math.max(...over.map((x) => x.gust ?? 0));
  return { event: { start: over[0], end: over[over.length - 1], peak, gust }, max: peak.kt };
}

// `st` is this subscriber's state for the place and is updated. Returns 'new', 'stronger' or null.
export function decideWind(st, w, thresholdKt) {
  if (!w.event) {
    if (w.max < thresholdKt - REARM_MARGIN_KT && ++st.low >= 2) { st.armed = true; st.peak = 0; }
    return null;
  }
  st.low = 0;
  if (st.armed !== false) { st.armed = false; st.peak = w.event.peak.kt; return 'new'; }
  if (w.event.peak.kt >= (st.peak || 0) + STEP_KT) { st.peak = w.event.peak.kt; return 'stronger'; }
  return null;
}

export function windMessage(kind, ev, placeName, metric) {
  const sp = (kt) => `${Math.round(kt)} kt (${metric ? `${Math.round(kt * 1.852)} km/h` : `${Math.round(kt * 1.15078)} mph`})`;
  const when = (x) => {   // local clock time, e.g. "Sat 7 PM"
    const d = new Date(x.local), h = d.getUTCHours();
    return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
  };
  const span = ev.start === ev.end ? `around ${when(ev.start)}` : `${when(ev.start)} to ${when(ev.end)}`;
  const gust = ev.gust > ev.peak.kt + 2 ? `, gusts to ${Math.round(ev.gust)} kt` : '';
  return {
    title: `${kind === 'stronger' ? 'Stronger wind' : 'Wind'} forecast · ${placeName}`,
    body: `Up to ${sp(ev.peak.kt)} from the ${compass(ev.peak.dir)}${gust}, ${span}.${ev.start === ev.end ? '' : ` Strongest ${when(ev.peak)}.`}`,
  };
}
