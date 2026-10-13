// Weather-model backup from Open-Meteo (HRRR in the US at 15-minute steps). Used where
// radar cannot see (well offshore, far from a radar site) and for temperature, which
// decides whether precipitation is called rain or snow.

const API = 'https://api.open-meteo.com/v1/forecast';

export async function fetchModel(lat, lon) {
  const p = new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4),
    current: 'temperature_2m,weather_code',
    minutely_15: 'precipitation',
    forecast_minutely_15: '6', past_minutely_15: '1',
    timeformat: 'unixtime', timezone: 'GMT',
  });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const resp = await fetch(`${API}?${p}`, { signal: ctl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const j = await resp.json();
    const m = j.minutely_15 || {};
    return {
      tempC: j.current ? j.current.temperature_2m : null,
      code: j.current ? j.current.weather_code : null,
      // Each value is the total for the 15 minutes ending at that time.
      steps: (m.time || []).map((t, i) => ({ end: t * 1000, rate: (m.precipitation[i] || 0) * 4 })),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Model rain rate (mm/h) at a moment in time.
export function modelRateAt(model, ms) {
  for (const s of model.steps) {
    if (ms <= s.end && ms > s.end - 15 * 60000) return s.rate;
  }
  return 0;
}
