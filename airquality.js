// Air quality for the Local tab.
//   Now:   EPA AirNow monitors (measured, hourly NowCast AQI) from EPA's public ArcGIS layer,
//          the same readings behind the AQI on airnow.gov. U.S. only.
//   Ahead: Open-Meteo's air quality forecast (CAMS), hourly US AQI per pollutant, worldwide.
//          The forecast is nudged to match the measured reading now, with the nudge fading
//          out over 24 hours (the model often runs high or low for days at a time).

import { getJson } from './compare.js';
import { km } from './history.js';

const AIRNOW = 'https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/' +
  'Air%20Now%20Current%20Monitor%20Data%20Public/FeatureServer/0/query';
const MODEL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const MAX_KM = 50;             // a monitor further away is not "here"
const MAX_AGE_H = 3;

// EPA categories: upper AQI, name, colour, what to do.
export const AQI_CATS = [
  { max: 50, name: 'Good', color: '#00e400', ink: '#111', advice: 'Air quality is good. No need to change plans.' },
  { max: 100, name: 'Moderate', color: '#ffff00', ink: '#111', advice: 'Fine for almost everyone. People unusually sensitive to air pollution should consider shorter or lighter outdoor exertion.' },
  { max: 150, name: 'Unhealthy for sensitive groups', short: 'Unhealthy (sensitive)', color: '#ff7e00', ink: '#111', advice: 'People with asthma, heart or lung disease, older adults, children and teens: make outdoor exertion shorter and lighter, and keep rescue medicine handy.' },
  { max: 200, name: 'Unhealthy', color: '#ff0000', ink: '#fff', advice: 'Everyone: cut back on long or heavy outdoor exertion. Sensitive groups: avoid it.' },
  { max: 300, name: 'Very unhealthy', color: '#8f3f97', ink: '#fff', advice: 'Everyone: avoid long or heavy outdoor exertion. Sensitive groups: stay indoors.' },
  { max: Infinity, name: 'Hazardous', color: '#7e0023', ink: '#fff', advice: 'Everyone: stay indoors with windows closed and keep activity light.' },
];
export const aqiCat = (aqi) => AQI_CATS.findIndex((c) => aqi <= c.max);

export const POLLUTANTS = {
  pm25: 'fine particles (PM2.5: smoke, haze)',
  pm10: 'coarse particles (PM10: dust, pollen)',
  ozone: 'ozone (smog)',
  dust: 'Saharan dust',
};

const num = (v) => (v === null || v === undefined || v === '' || +v < 0 ? null : +v);

// Nearest monitor reporting each pollutant (many sites measure only one).
export function nearestReadings(features, lat, lon, now = Date.now()) {
  const best = {};
  for (const f of features) {
    const a = f.attributes;
    if (a.Status && a.Status !== 'Active') continue;
    if (!(now - a.ValidTime < MAX_AGE_H * 3600000)) continue;
    const d = km(lat, lon, a.Latitude, a.Longitude);
    if (d > MAX_KM) continue;
    for (const [k, field] of [['pm25', 'PM25_AQI'], ['pm10', 'PM10_AQI'], ['ozone', 'OZONE_AQI']]) {
      const v = num(a[field]);
      if (v === null || (best[k] && best[k].km <= d)) continue;
      best[k] = { aqi: Math.round(v), site: a.SiteName, agency: a.DataSource, km: d, time: a.ValidTime };
    }
  }
  return best;
}

async function monitors(lat, lon) {
  const q = new URLSearchParams({
    where: "Status='Active'", geometry: `${lon.toFixed(4)},${lat.toFixed(4)}`, geometryType: 'esriGeometryPoint',
    inSR: '4326', distance: String(MAX_KM), units: 'esriSRUnit_Kilometer',
    outFields: 'SiteName,DataSource,Latitude,Longitude,ValidTime,Status,PM25_AQI,PM10_AQI,OZONE_AQI',
    returnGeometry: 'false', f: 'json',
  });
  const j = await getJson(`${AIRNOW}?${q}`, 12000);
  if (j.error) throw new Error(j.error.message || 'AirNow error');
  return nearestReadings(j.features || [], lat, lon);
}

async function forecast(lat, lon) {
  const q = new URLSearchParams({
    latitude: lat.toFixed(3), longitude: lon.toFixed(3),
    hourly: 'us_aqi_pm2_5,us_aqi_pm10,us_aqi_ozone,dust',
    past_hours: '1', forecast_hours: '25', timeformat: 'unixtime', timezone: 'auto',
  });
  const j = await getJson(`${MODEL}?${q}`, 12000);
  const h = j.hourly || {};
  return (h.time || []).map((t, i) => ({
    time: t * 1000,
    pm25: num(h.us_aqi_pm2_5[i]), pm10: num(h.us_aqi_pm10[i]), ozone: num(h.us_aqi_ozone[i]),
    dust: num(h.dust[i]),
  }));
}

// The worst pollutant of one hour -> { aqi, pollutant }.
function overall(x) {
  let aqi = -1, pollutant = null;
  for (const k of ['pm25', 'pm10', 'ozone']) if (x[k] !== null && x[k] > aqi) { aqi = x[k]; pollutant = k; }
  // Particles that are mostly Saharan dust (µg/m³) are named for it.
  if ((pollutant === 'pm10' || pollutant === 'pm25') && x.dust !== null && x.dust >= 25) pollutant = 'dust';
  return aqi < 0 ? null : { aqi: Math.round(aqi), pollutant };
}

// Combine the measured readings and the model forecast.
export function combine(measured, hours, now = Date.now()) {
  const fc = (hours || []).filter((h) => h.time > now - 3600000);
  // Nudge each pollutant's forecast to the measured value, fading out over 24 h.
  if (fc.length) {
    const first = fc[0];
    for (const k of ['pm25', 'pm10', 'ozone']) {
      const m = measured[k];
      if (!m || first[k] === null) continue;
      const diff = m.aqi - first[k];
      for (const h of fc) {
        if (h[k] === null) continue;
        const fade = Math.max(0, 1 - (h.time - first.time) / (24 * 3600000));
        h[k] = Math.max(0, h[k] + diff * fade);
      }
    }
  }
  const series = fc.map((h) => ({ time: h.time, ...overall(h) })).filter((h) => h.aqi !== undefined);

  const kinds = Object.keys(measured);
  let current;
  if (kinds.length) {
    const k = kinds.reduce((a, b) => (measured[b].aqi > measured[a].aqi ? b : a));
    const r = measured[k];
    const dust = fc.length && fc[0].dust >= 25 && k !== 'ozone';
    current = { aqi: r.aqi, pollutant: dust ? 'dust' : k, measured: true, site: r.site, agency: r.agency, km: r.km, time: r.time };
  } else if (series.length) {
    current = { ...series[0], measured: false };
  } else {
    return null;
  }
  return { current, series, outlook: outlook(current, series) };
}

// What changes in the next 24 hours, in words, or null when nothing does.
//   { kind: 'worse', cat, time } | { kind: 'better', cat, time } | { kind: 'steady' }
export function outlook(current, series) {
  const c0 = aqiCat(current.aqi);
  const ahead = series.slice(1);
  if (!ahead.length) return null;
  const worst = ahead.reduce((a, b) => (b.aqi > a.aqi ? b : a));
  const cw = aqiCat(worst.aqi);
  if (cw > c0) {
    const first = ahead.find((h) => aqiCat(h.aqi) === cw);
    return { kind: 'worse', cat: cw, time: first.time, peak: worst };
  }
  if (c0 > 0) {
    const better = ahead.find((h) => aqiCat(h.aqi) < c0);
    if (better) return { kind: 'better', cat: aqiCat(better.aqi), time: better.time };
  }
  return { kind: 'steady' };
}

export async function airQuality(lat, lon, { us = true } = {}) {
  const [m, f] = await Promise.allSettled([us ? monitors(lat, lon) : Promise.resolve({}), forecast(lat, lon)]);
  const measured = m.status === 'fulfilled' ? m.value : {};
  const hours = f.status === 'fulfilled' ? f.value : [];
  const out = combine(measured, hours);
  if (!out) throw new Error(f.status === 'rejected' ? f.reason.message : 'no air quality data here');
  return out;
}
