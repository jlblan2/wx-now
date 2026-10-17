// Water temperature alerts: the NOAA buoy or coastal station nearest each watched place.
// The first reading becomes the baseline; when the water has warmed or cooled by the chosen
// amount from it (on two reports in a row, so one bad reading doesn't alert), an alert goes
// out and that reading becomes the new baseline.
import { distKm } from '../storms.js';

const NEAR_KM = 93;                     // about 50 nautical miles
const STALE_BASE_MS = 10 * 86400000;    // forget a baseline the station stopped updating

const toF = (c) => c * 9 / 5 + 32;
// "EDISTO - 41 NM Southeast of Charleston, SC" -> "EDISTO"; "8726724 - Clearwater Beach, FL" -> "Clearwater Beach, FL"
const shortName = (n) => (/^\w*\d\w* - /.test(n) ? n.replace(/^\S+ - /, '') : n.replace(/\s+-\s+.*$/, ''));

export function buoyFor(place, stations) {
  let best = null;
  for (const s of stations) {
    if (s.wtmp === null) continue;
    const km = distKm(place, s);
    if (!best || km < best.km) best = { ...s, km };
  }
  return best && best.km <= NEAR_KM ? best : null;
}

// `st` is this subscriber's state for the station and is updated. Returns 'warmer',
// 'cooler' or null. thresholdF is the change in °F.
export function decideWaterTemp(st, b, thresholdF) {
  const f = toF(b.wtmp);
  if (st.base === undefined || b.t - st.baseT > STALE_BASE_MS) {
    Object.assign(st, { base: f, baseT: b.t, pending: 0, lastT: b.t });
    return null;
  }
  if (b.t === st.lastT) return null;    // no new report since last check
  st.lastT = b.t;
  const change = f - st.base;
  if (Math.abs(change) < thresholdF) { st.pending = 0; return null; }
  if (++st.pending < 2) return null;
  const kind = change > 0 ? 'warmer' : 'cooler';
  st.from = st.base; st.fromT = st.baseT;
  Object.assign(st, { base: f, baseT: b.t, pending: 0 });
  return kind;
}

export function waterTempMessage(kind, st, b, placeName, metric) {
  const t = (f) => (metric ? `${((f - 32) * 5 / 9).toFixed(1)} °C` : `${Math.round(f)} °F`);
  const d = (f) => (metric ? `${(Math.abs(f) * 5 / 9).toFixed(1)} °C` : `${Math.round(Math.abs(f))} °F`);
  const now = toF(b.wtmp);
  const since = new Date(st.fromT).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  const where = b.name ? shortName(b.name) : `Station ${b.id}`;
  return {
    title: `Water ${kind} · ${where}${placeName ? ` (${placeName})` : ''}`,
    body: `Water temperature ${t(now)}, ${kind === 'warmer' ? 'up' : 'down'} ${d(now - st.from)} since ${since} (${t(st.from)}). Measured at ${b.name || b.id}.`,
  };
}
