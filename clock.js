// Every time the app shows is local time at the selected place, not the phone's own time
// zone. The zone comes from Open-Meteo (timezone=auto) and is remembered per area.

const KEY = 'placeZones';
let zone;   // IANA name, e.g. 'America/New_York'; undefined = the phone's zone until known
let saved = {};
try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* storage unavailable */ }
const area = (lat, lon) => `${lat.toFixed(1)},${lon.toFixed(1)}`;

export const placeZone = () => zone;

function remember(lat, lon, tz) {
  saved[area(lat, lon)] = tz;
  try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* storage unavailable */ }
}

// Sets the zone for a place: instantly when it has been seen before, otherwise after a small
// Open-Meteo lookup (given up after 4 s, keeping the previous zone).
export async function useZoneFor(lat, lon) {
  const hit = saved[area(lat, lon)];
  if (hit) { zone = hit; return zone; }
  try {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}&timezone=auto&forecast_days=1&current=is_day`, { signal: ctl.signal });
    clearTimeout(timer);
    const j = await r.json();
    if (j.timezone) { remember(lat, lon, j.timezone); zone = j.timezone; }
  } catch { /* keep the previous zone */ }
  return zone;
}

// The forecast model also reports the zone; keep it in step.
export function confirmZone(lat, lon, tz) {
  if (!tz) return;
  zone = tz;
  remember(lat, lon, tz);
}

const fmt = (o) => (ms) => new Date(ms).toLocaleString([], { ...o, timeZone: zone });
export const timeOf = fmt({ hour: 'numeric', minute: '2-digit' });              // 3:45 PM
export const hourOf = fmt({ hour: 'numeric' });                                // 3 PM
export const dayOf = fmt({ weekday: 'short' });                                // Sat
export const dateOf = fmt({ weekday: 'short', month: 'short', day: 'numeric' }); // Sat, Oct 17
export const dayHourOf = fmt({ weekday: 'short', hour: 'numeric' });           // Sat 3 PM
export const whenOf = fmt({ weekday: 'short', hour: 'numeric', minute: '2-digit' }); // Sat 3:45 PM
export const zoneName = (ms = Date.now()) =>
  (new Intl.DateTimeFormat([], { timeZone: zone, timeZoneName: 'short' }).formatToParts(ms).find((p) => p.type === 'timeZoneName') || {}).value || '';

// Offset of the place's clock from UTC at an instant, in ms.
function offset(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(ms).map((x) => [x.type, +x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

// Midnight at the start of the place's day containing `ms`, plus `days` whole days.
export function dayStart(ms = Date.now(), days = 0) {
  const local = ms + offset(ms);
  const midnight = local - (((local % 86400000) + 86400000) % 86400000) + days * 86400000;
  return midnight - offset(midnight - offset(ms));
}

// True when the place keeps a different clock from the phone right now.
export function differsFromPhone(ms = Date.now()) {
  return zone !== undefined && offset(ms) !== -new Date(ms).getTimezoneOffset() * 60000;
}
