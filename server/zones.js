// Time zone of a place (Open-Meteo timezone=auto: real zones on land, nautical zones such as
// Etc/GMT+5 at sea), so alert messages give local time at that place. Cached per area.
const cache = new Map();

export async function zoneOf(lat, lon) {
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  if (cache.has(key)) return cache.get(key);
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}&timezone=auto&forecast_days=1&current=is_day`);
    const j = await r.json();
    if (j.timezone) { cache.set(key, j.timezone); return j.timezone; }
  } catch { /* fall through */ }
  return 'America/New_York';
}
