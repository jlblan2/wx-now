// Weather model data from Open-Meteo (NOAA HRRR/NBM/GFS blend in the US). One request gives:
//  - 15-minute precipitation, the backup where radar cannot see (well offshore, far from a
//    radar site), plus the temperature that decides whether it is rain or snow;
//  - the hourly forecast for the next 24 hours and the 7-day forecast.
// Values arrive in metric units; the UI converts them.

const API = 'https://api.open-meteo.com/v1/forecast';

export async function fetchModel(lat, lon) {
  const p = new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,' +
      'wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    minutely_15: 'precipitation',
    forecast_minutely_15: '6', past_minutely_15: '1',
    hourly: 'temperature_2m,precipitation_probability,precipitation,weather_code,is_day,' +
      'wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,' +
      'precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant',
    forecast_days: '7',
    timeformat: 'unixtime', timezone: 'auto',
  });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const resp = await fetch(`${API}?${p}`, { signal: ctl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const j = await resp.json();
    const m = j.minutely_15 || {}, h = j.hourly || {}, d = j.daily || {}, c = j.current || {};
    const now = Date.now();
    const hours = (h.time || []).map((t, i) => ({
      time: t * 1000,
      temp: h.temperature_2m[i],
      pop: h.precipitation_probability ? h.precipitation_probability[i] : null,
      precip: h.precipitation[i],
      code: h.weather_code[i],
      day: h.is_day[i] === 1,
      wind: h.wind_speed_10m[i],
      windDir: h.wind_direction_10m[i],
      gust: h.wind_gusts_10m[i],
    })).filter((x) => x.time > now - 3600000).slice(0, 25);
    const days = (d.time || []).map((t, i) => ({
      time: t * 1000,
      code: d.weather_code[i],
      hi: d.temperature_2m_max[i],
      lo: d.temperature_2m_min[i],
      pop: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null,
      precip: d.precipitation_sum[i],
      wind: d.wind_speed_10m_max[i],
      gust: d.wind_gusts_10m_max[i],
      windDir: d.wind_direction_10m_dominant[i],
    }));
    return {
      timezone: j.timezone,
      tempC: c.temperature_2m ?? null,
      code: c.weather_code ?? null,
      current: {
        feels: c.apparent_temperature, humidity: c.relative_humidity_2m, day: c.is_day === 1,
        wind: c.wind_speed_10m, windDir: c.wind_direction_10m, gust: c.wind_gusts_10m,
      },
      // Each value is the total for the 15 minutes ending at that time.
      steps: (m.time || []).map((t, i) => ({ end: t * 1000, rate: (m.precipitation[i] || 0) * 4 })),
      hours,
      days,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Model rain rate (mm/h) at a moment in time. Each 15-minute total is placed at the middle of
// its period and the rate is interpolated between them, so the forecast does not jump in
// quarter-hour steps.
export function modelRateAt(model, ms) {
  const st = model.steps, mid = (s) => s.end - 7.5 * 60000;
  if (!st.length || ms <= st[0].end - 15 * 60000 || ms > st[st.length - 1].end) return 0;
  if (ms <= mid(st[0])) return st[0].rate;
  for (let i = 1; i < st.length; i++) {
    if (ms <= mid(st[i])) {
      const f = (ms - mid(st[i - 1])) / (mid(st[i]) - mid(st[i - 1]));
      return st[i - 1].rate + (st[i].rate - st[i - 1].rate) * f;
    }
  }
  return st[st.length - 1].rate;
}

// WMO weather codes -> [label, day icon, night icon]
const CODES = {
  0: ['Clear', '☀️', '🌙'],
  1: ['Mostly clear', '🌤️', '🌙'],
  2: ['Partly cloudy', '⛅', '☁️'],
  3: ['Cloudy', '☁️', '☁️'],
  45: ['Fog', '🌫️', '🌫️'],
  48: ['Freezing fog', '🌫️', '🌫️'],
  51: ['Light drizzle', '🌦️', '🌧️'],
  53: ['Drizzle', '🌦️', '🌧️'],
  55: ['Heavy drizzle', '🌧️', '🌧️'],
  56: ['Freezing drizzle', '🌧️', '🌧️'],
  57: ['Freezing drizzle', '🌧️', '🌧️'],
  61: ['Light rain', '🌦️', '🌧️'],
  63: ['Rain', '🌧️', '🌧️'],
  65: ['Heavy rain', '🌧️', '🌧️'],
  66: ['Freezing rain', '🌧️', '🌧️'],
  67: ['Freezing rain', '🌧️', '🌧️'],
  71: ['Light snow', '🌨️', '🌨️'],
  73: ['Snow', '🌨️', '🌨️'],
  75: ['Heavy snow', '❄️', '❄️'],
  77: ['Snow grains', '🌨️', '🌨️'],
  80: ['Showers', '🌦️', '🌧️'],
  81: ['Showers', '🌧️', '🌧️'],
  82: ['Heavy showers', '🌧️', '🌧️'],
  85: ['Snow showers', '🌨️', '🌨️'],
  86: ['Snow showers', '🌨️', '🌨️'],
  95: ['Thunderstorms', '⛈️', '⛈️'],
  96: ['Thunderstorms, hail', '⛈️', '⛈️'],
  99: ['Thunderstorms, hail', '⛈️', '⛈️'],
};

export function describe(code, day = true) {
  const c = CODES[code] || ['—', '·', '·'];
  return { label: c[0], icon: day ? c[1] : c[2] };
}
