// Wx Now alert server. Every 5 minutes it runs the app's own rain-in-the-wx-now forecast for each
// subscriber's saved places and last-known location, and sends a Web Push notification when
// rain is about to start. It also serves a small JSON API the app uses to subscribe.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import webpush from 'web-push';
import { decodePng } from './png.js';
import { setPngDecoder } from '../radar.js';
import { fetchModel } from '../model.js';
import { radarCoverage, runRadar, blend, summarize, precipNoun, cap } from '../forecast.js';
import { decide, newState } from './decide.js';
import { activeStorms } from '../storms.js';
import { stormAlerts } from './stormalerts.js';
import { tropicalOutlook } from '../outlook.js';
import { outlookAreas, outlookEvents, outlookSends } from './outlookalerts.js';
import { gaugeFor, gaugeNow, decideHighWater, highWaterMessage } from './highwater.js';
import { initWaterLevels, sweepWaterLevels, waterLevelSnapshot } from './waterlevels.js';
import { refreshBuoys, buoySnapshot } from './buoys.js';
import { buoyFor, decideWaterTemp, waterTempMessage } from './watertemp.js';
import { windForecast, windEvent, decideWind, windMessage } from './windalerts.js';
import { zoneOf } from './zones.js';
import { tideStationFor, predictedExtremes, findExtremes, decideTides, tideMessage } from './tidealerts.js';
import { floodLevels } from './highwater.js';
import { THUNDER_EVENTS, refreshLightning, lightningNear, decideLightning, lightningMessage } from './thunder.js';
import { FOG_EVENTS, visibilityForecast, fogEvent, decideFog, fogMessage, pointAlerts } from './fogalerts.js';
import { marineZones, marineAlertSends, fetchMarineAlerts, fetchOffshoreAlerts, what, localTime } from './marinealerts.js';
import { MARINE_ZONES } from '../data.js';
import { navyMeta, navyPoint, navyFile } from './navy.js';
import { passageMeta, passageStep } from './passage.js';

const PORT = +(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const NAVY_DIR = process.env.NAVY_DIR || path.join(DATA_DIR, 'navy');
const PASSAGE_DIR = process.env.PASSAGE_DIR || path.join(DATA_DIR, 'passage');
const ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://jlblan2.github.io,http://localhost:8430').split(',');
const CHECK_MS = 5 * 60000;
const LAST_LOCATION_MAX_H = 72;   // ignore a last location older than this
const MAX_SUBS = 20;

setPngDecoder(async (bytes) => decodePng(bytes).data);

// ---------- storage ----------

fs.mkdirSync(DATA_DIR, { recursive: true });
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const OUTLOOK_FILE = path.join(DATA_DIR, 'outlook.json');   // last outlook areas seen

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}

let vapid = readJson(VAPID_FILE, null);
if (!vapid) {
  vapid = webpush.generateVAPIDKeys();
  writeJson(VAPID_FILE, vapid);
  console.log('Generated new VAPID keys');
}
webpush.setVapidDetails('https://github.com/jlblan2/wx-now', vapid.publicKey, vapid.privateKey);

// subs: { [endpoint]: { subscription, places: [{name, lat, lon}], last: {lat, lon, at}, units, state: {} } }
let subs = readJson(SUBS_FILE, {});
const saveSubs = () => writeJson(SUBS_FILE, subs);

const status = { started: new Date().toISOString(), lastCheck: null, lastError: null, sent: 0 };

// ---------- push ----------

async function push(endpoint, payload) {
  const sub = subs[endpoint];
  if (!sub) return false;
  try {
    await webpush.sendNotification(sub.subscription, JSON.stringify(payload), { TTL: 900, urgency: 'high' });
    status.sent++;
    return true;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) {
      console.log('Subscription expired, removing');
      delete subs[endpoint];
      saveSubs();
    } else {
      console.error('Push failed:', e.statusCode || '', e.body || e.message);
    }
    return false;
  }
}

// ---------- forecasting ----------

const validPoint = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon) &&
  Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

function distKm(a, b) {
  const r = Math.PI / 180;
  const x = (b.lon - a.lon) * r * Math.cos((a.lat + b.lat) / 2 * r), y = (b.lat - a.lat) * r;
  return 6371 * Math.hypot(x, y);
}

// Places to watch for one subscriber: saved places, plus the last location unless it is
// stale or already covered by a saved place.
function watchList(sub) {
  const list = (sub.places || []).filter(validPoint).map((p) => ({ key: `p:${p.name}`, name: p.name, lat: p.lat, lon: p.lon }));
  const last = sub.last;
  if (validPoint(last) && Date.now() - last.at < LAST_LOCATION_MAX_H * 3600000 &&
      !list.some((p) => distKm(p, last) < 3)) {
    list.push({ key: 'last', name: 'Your last location', lat: last.lat, lon: last.lon });
  }
  return list;
}

async function forecastAt(loc) {
  const { quality } = radarCoverage(loc);
  const modelP = fetchModel(loc.lat, loc.lon).catch(() => null);
  let radar = null;
  if (quality > 0) {
    try { radar = await runRadar(loc); } catch (e) { console.error('Radar failed:', e.message); }
  }
  const model = await modelP;
  if (!radar && !model) return null;
  const series = blend(radar, model, radar ? quality : 0);
  const noun = precipNoun(model ? model.tempC : null);
  return { summary: summarize(series, noun, radar && radar.echo === 0), series, noun };
}

async function check() {
  const t0 = Date.now();
  const cache = new Map();   // forecasts shared between subscribers watching the same spot
  for (const [endpoint, sub] of Object.entries(subs)) {
    sub.state = sub.state || {};
    for (const place of watchList(sub)) {
      const key = `${place.lat.toFixed(2)},${place.lon.toFixed(2)}`;
      if (!cache.has(key)) cache.set(key, await forecastAt(place).catch((e) => { console.error(e); return null; }));
      const fc = cache.get(key);
      if (!fc) continue;
      const st = sub.state[place.key] || (sub.state[place.key] = newState());
      const s = fc.summary;
      if (decide(st, s, fc.series)) {
        console.log(`Alert ${place.name}: ${s.text}`);
        await push(endpoint, {
          title: `${cap(fc.noun)} · ${place.name}`,
          body: s.text,
          tag: place.key,
          url: `./?lat=${place.lat.toFixed(4)}&lon=${place.lon.toFixed(4)}`,
        });
      }
    }
  }
  saveSubs();
  status.lastCheck = new Date().toISOString();
  status.lastCheckSeconds = Math.round((Date.now() - t0) / 1000);
  status.watching = cache.size;
}

// Tropical storms: NHC issues advisories every 3-6 hours, so every 15 minutes is plenty.
const STORM_CHECK_MS = 15 * 60000;

async function stormLoop() {
  try {
    const storms = await activeStorms();
    const sends = stormAlerts(subs, storms, watchList);
    for (const { endpoint, payload } of sends) {
      console.log(`Storm alert: ${payload.title}: ${payload.body}`);
      await push(endpoint, payload);
    }
    saveSubs();
    status.storms = storms.map((s) => `${s.title} (${s.bin})`);
    // Tropical outlook: new areas and rising chances.
    const o = await tropicalOutlook();
    if (o.areasOk) {
      const saved = readJson(OUTLOOK_FILE, null);
      const { events, next } = outlookEvents(saved && saved.areas, outlookAreas(o.areas));
      writeJson(OUTLOOK_FILE, { areas: next, at: new Date().toISOString() });
      for (const { endpoint, payload } of outlookSends(subs, events, watchList)) {
        console.log(`Outlook alert: ${payload.title}: ${payload.body}`);
        await push(endpoint, payload);
      }
      status.outlookAreas = next.length;
    }
    status.lastStormCheck = new Date().toISOString();
  } catch (e) {
    status.lastStormError = e.message;
    console.error('Storm check failed:', e.message);
  }
  setTimeout(stormLoop, STORM_CHECK_MS);
}

// Marine alerts (Small Craft Advisory and stronger) for each subscriber's marine zones.
const MARINE_CHECK_MS = 5 * 60000;
const zoneName = (id) => (MARINE_ZONES.find(([z]) => z === id) || [id, id])[1];

async function marineLoop() {
  try {
    const zonesBySub = {};
    for (const [endpoint, sub] of Object.entries(subs)) zonesBySub[endpoint] = await marineZones(sub, watchList);
    const all = [...new Set(Object.values(zonesBySub).flat())];
    const alerts = all.length ? [...await fetchMarineAlerts(all), ...await fetchOffshoreAlerts(all)] : [];
    for (const { endpoint, payload } of marineAlertSends(subs, zonesBySub, alerts, zoneName)) {
      console.log(`Marine alert: ${payload.title}: ${payload.body}`);
      await push(endpoint, payload);
    }
    saveSubs();
    status.marineZones = all;
    status.lastMarineCheck = new Date().toISOString();
    status.lastMarineError = null;
  } catch (e) {
    status.lastMarineError = e.message;
    console.error('Marine check failed:', e.message);
  }
  setTimeout(marineLoop, MARINE_CHECK_MS);
}

// High water: measured level vs predicted at the gauge nearest each watched place.
const HIGHWATER_CHECK_MS = 6 * 60000;   // gauges report every 6 minutes

async function highWaterLoop() {
  try {
    const readings = new Map();   // gauge id -> reading (shared by subscribers)
    for (const [endpoint, sub] of Object.entries(subs)) {
      const threshold = sub.highWaterFt ?? 1.0;
      if (!(threshold > 0)) continue;
      const st = sub.highWater = sub.highWater || {};
      const seen = new Set();
      for (const place of watchList(sub)) {
        const g = gaugeFor(place);
        if (!g || seen.has(g.id)) continue;   // one alert per gauge even if two places share it
        seen.add(g.id);
        if (!readings.has(g.id)) readings.set(g.id, await gaugeNow(g.id).catch(() => null));
        const r = readings.get(g.id);
        if (!r) continue;
        const kind = decideHighWater(st[g.id] = st[g.id] || { armed: true, low: 0 }, r, threshold);
        if (!kind) continue;
        const msg = highWaterMessage(kind, r, g, place.name === 'Your last location' ? '' : place.name);
        console.log(`High water: ${msg.title}: ${msg.body}`);
        await push(endpoint, { ...msg, tag: `highwater-${g.id}`, url: `./?lat=${place.lat.toFixed(4)}&lon=${place.lon.toFixed(4)}&tab=seas` });
      }
    }
    saveSubs();
    status.gauges = readings.size;
    status.lastHighWaterCheck = new Date().toISOString();
    status.lastHighWaterError = null;
  } catch (e) {
    status.lastHighWaterError = e.message;
    console.error('High water check failed:', e.message);
  }
  setTimeout(highWaterLoop, HIGHWATER_CHECK_MS);
}

// Water levels at every gauge for the Sailing weather map (a gentle 30-minute sweep).
const WATERLEVEL_SWEEP_MS = 30 * 60000;
initWaterLevels(DATA_DIR);

async function waterLevelLoop() {
  try {
    const s = await sweepWaterLevels();
    status.waterLevelGauges = s.gauges.length;
    status.lastWaterLevelSweep = s.at;
    status.lastWaterLevelError = null;
  } catch (e) {
    status.lastWaterLevelError = e.message;
    console.error('Water level sweep failed:', e.message);
  }
  setTimeout(waterLevelLoop, WATERLEVEL_SWEEP_MS);
}

// Wind forecast alerts for saved places: the next 24 hours, checked hourly (the forecast
// updates hourly). Forecasts are shared between subscribers with the same place.
const WIND_CHECK_MS = 60 * 60000;

async function windLoop() {
  try {
    const cache = new Map();
    let places = 0;
    for (const [endpoint, sub] of Object.entries(subs)) {
      const threshold = sub.windKt ?? 25;
      if (!(threshold > 0)) continue;
      const st = sub.wind = sub.wind || {};
      for (const p of (sub.places || []).filter(validPoint)) {
        const key = `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;
        if (!cache.has(key)) cache.set(key, await windForecast(p.lat, p.lon).catch(() => null));
        const hours = cache.get(key);
        if (!hours) continue;
        places++;
        const s = st[p.name] = st[p.name] || { armed: true, low: 0 };
        const w = windEvent(hours, threshold);
        const kind = decideWind(s, w, threshold);
        if (!kind) continue;
        const msg = windMessage(kind, w.event, p.name, sub.metric);
        console.log(`Wind: ${msg.title}: ${msg.body}`);
        await push(endpoint, { ...msg, tag: `wind-${p.name}`, url: `./?lat=${p.lat.toFixed(4)}&lon=${p.lon.toFixed(4)}` });
      }
    }
    saveSubs();
    status.windPlaces = places;
    status.lastWindCheck = new Date().toISOString();
    status.lastWindError = null;
  } catch (e) {
    status.lastWindError = e.message;
    console.error('Wind check failed:', e.message);
  }
  setTimeout(windLoop, WIND_CHECK_MS);
}

// Thunderstorms and lightning for saved places and the last location, every 5 minutes:
// GOES-19 GLM lightning near each place, and NWS severe thunderstorm / tornado watches and
// warnings there (sharing the marine "sent" record so nothing is sent twice).
const THUNDER_CHECK_MS = 5 * 60000;

async function thunderLoop() {
  try {
    const got = await refreshLightning();
    status.lightningFlashes = got.flashes;
    const nws = new Map();
    let places = 0;
    for (const [endpoint, sub] of Object.entries(subs)) {
      const mi = sub.lightningMi ?? 10;
      if (!(mi > 0)) continue;
      const st = sub.thunder = sub.thunder || {};
      const sent = sub.marineSent = sub.marineSent || {};
      for (const place of watchList(sub)) {
        places++;
        const name = place.name === 'Your last location' ? 'your location' : place.name;
        const near = lightningNear(place, mi);
        const lastSeen = lightningNear(place, mi, undefined, Date.now(), 40 * 60000).newest;
        const kind = decideLightning(st[place.key] = st[place.key] || {}, near, lastSeen);
        if (kind) {
          const msg = lightningMessage(kind, near, name, mi);
          console.log(`Lightning: ${msg.title}: ${msg.body}`);
          await push(endpoint, { ...msg, tag: `lightning-${place.key}`, url: `./?lat=${place.lat.toFixed(4)}&lon=${place.lon.toFixed(4)}` });
        }
        const key = `${place.lat.toFixed(2)},${place.lon.toFixed(2)}`;
        if (!nws.has(key)) nws.set(key, await pointAlerts(place.lat, place.lon).catch(() => []));
        for (const a of nws.get(key)) {
          const q = a.properties || {};
          if (!THUNDER_EVENTS.has(q.event) || sent[q.id]) continue;
          sent[q.id] = Date.parse(q.ends || q.expires) || Date.now() + 86400000;
          const msg = { title: `${q.event} · ${name}`, body: `${what(q.description) || q.headline || ''}${localTime(q.ends || q.expires)}`.trim() };
          console.log(`Thunder: ${msg.title}: ${msg.body}`);
          await push(endpoint, { ...msg, tag: `nws-${q.id}`, url: `./?lat=${place.lat.toFixed(4)}&lon=${place.lon.toFixed(4)}` });
        }
      }
    }
    saveSubs();
    status.thunderPlaces = places;
    status.lastThunderCheck = new Date().toISOString();
    status.lastThunderError = null;
  } catch (e) {
    status.lastThunderError = e.message;
    console.error('Thunder check failed:', e.message);
  }
  setTimeout(thunderLoop, THUNDER_CHECK_MS);
}

// Fog and low visibility for saved places, every 30 minutes: the 12-hour visibility forecast
// and NWS fog/smoke advisories at each place. NWS alerts share the marine "sent" record, so an
// advisory that also reaches the subscriber through a marine zone is only sent once.
const FOG_CHECK_MS = 30 * 60000;

async function fogLoop() {
  try {
    const fc = new Map(), nws = new Map();
    let places = 0;
    for (const [endpoint, sub] of Object.entries(subs)) {
      const threshold = sub.fogNm ?? 1;
      if (!(threshold > 0)) continue;
      const st = sub.fog = sub.fog || {};
      const sent = sub.marineSent = sub.marineSent || {};
      for (const p of (sub.places || []).filter(validPoint)) {
        const key = `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;
        if (!fc.has(key)) fc.set(key, await visibilityForecast(p.lat, p.lon).catch(() => null));
        if (!nws.has(key)) nws.set(key, await pointAlerts(p.lat, p.lon).catch(() => []));
        places++;
        const hours = fc.get(key);
        if (hours) {
          const s = st[p.name] = st[p.name] || { armed: true, low: 0 };
          const f = fogEvent(hours, threshold);
          if (decideFog(s, f, threshold)) {
            const msg = fogMessage(f.event, p.name, sub.metric);
            console.log(`Fog: ${msg.title}: ${msg.body}`);
            await push(endpoint, { ...msg, tag: `fog-${p.name}`, url: `./?lat=${p.lat.toFixed(4)}&lon=${p.lon.toFixed(4)}` });
          }
        }
        for (const a of nws.get(key)) {
          const q = a.properties || {};
          if (!FOG_EVENTS.has(q.event) || sent[q.id]) continue;
          sent[q.id] = Date.parse(q.ends || q.expires) || Date.now() + 86400000;
          const msg = { title: `${q.event} · ${p.name}`, body: `${what(q.description) || q.headline || ''}${localTime(q.ends || q.expires)}`.trim() };
          console.log(`Fog: ${msg.title}: ${msg.body}`);
          await push(endpoint, { ...msg, tag: `nws-${q.id}`, url: `./?lat=${p.lat.toFixed(4)}&lon=${p.lon.toFixed(4)}` });
        }
      }
    }
    saveSubs();
    status.fogPlaces = places;
    status.lastFogCheck = new Date().toISOString();
    status.lastFogError = null;
  } catch (e) {
    status.lastFogError = e.message;
    console.error('Fog check failed:', e.message);
  }
  setTimeout(fogLoop, FOG_CHECK_MS);
}

// Extreme tide alerts for saved places: predicted highs and lows for the next 48 hours,
// checked every 3 hours. Predictions are shared between subscribers using the same station.
const TIDE_CHECK_MS = 3 * 3600000;

async function tideLoop() {
  try {
    const stations = new Map(), preds = new Map();
    let places = 0;
    for (const [endpoint, sub] of Object.entries(subs)) {
      const margin = sub.tideFt ?? 1.0;
      if (!(margin > 0)) continue;
      const st = sub.tides = sub.tides || {};
      const seen = new Set();
      for (const p of (sub.places || []).filter(validPoint)) {
        const key = `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;
        if (!stations.has(key)) stations.set(key, await tideStationFor(p).catch(() => null));
        const s = stations.get(key);
        if (!s || seen.has(s.id)) continue;   // one alert per station even if two places share it
        seen.add(s.id);
        if (!preds.has(s.id)) {
          preds.set(s.id, await predictedExtremes(s.id).then(async (tides) => ({ tides, flood: await floodLevels(s.id).catch(() => null) })).catch(() => null));
        }
        const pr = preds.get(s.id);
        if (!pr) continue;
        places++;
        const ex = findExtremes(pr.tides, s.mhhw, margin, pr.flood);
        for (const a of decideTides(st[s.id] = st[s.id] || {}, ex)) {
          const msg = tideMessage(a.kind, a.list, s, s.mhhw, pr.flood, p.name, sub.metric, await zoneOf(p.lat, p.lon));
          console.log(`Tide: ${msg.title}: ${msg.body}`);
          await push(endpoint, { ...msg, tag: `tide-${a.kind}-${s.id}`, url: `./?lat=${p.lat.toFixed(4)}&lon=${p.lon.toFixed(4)}&tab=seas` });
        }
      }
    }
    saveSubs();
    status.tidePlaces = places;
    status.lastTideCheck = new Date().toISOString();
    status.lastTideError = null;
  } catch (e) {
    status.lastTideError = e.message;
    console.error('Tide check failed:', e.message);
  }
  setTimeout(tideLoop, TIDE_CHECK_MS);
}

// Water temperature alerts: change at the buoy nearest each watched place, checked after
// every buoy refresh.
async function waterTempAlerts(stations) {
  for (const [endpoint, sub] of Object.entries(subs)) {
    const threshold = sub.waterTempF ?? 3;
    if (!(threshold > 0)) continue;
    const st = sub.waterTemp = sub.waterTemp || {};
    const seen = new Set();
    for (const place of watchList(sub)) {
      const b = buoyFor(place, stations);
      if (!b || seen.has(b.id)) continue;   // one alert per station even if two places share it
      seen.add(b.id);
      const s = st[b.id] = st[b.id] || {};
      const kind = decideWaterTemp(s, b, threshold);
      if (!kind) continue;
      const msg = waterTempMessage(kind, s, b, place.name === 'Your last location' ? '' : place.name, sub.metric, await zoneOf(place.lat, place.lon));
      console.log(`Water temperature: ${msg.title}: ${msg.body}`);
      await push(endpoint, { ...msg, tag: `watertemp-${b.id}`, url: `./?lat=${place.lat.toFixed(4)}&lon=${place.lon.toFixed(4)}&tab=seas` });
    }
  }
  saveSubs();
}

// NDBC buoys: one file with every station's latest report, every 30 minutes.
async function buoyLoop() {
  try {
    const s = await refreshBuoys();
    status.buoys = s.stations.length;
    status.lastBuoyError = null;
    await waterTempAlerts(s.stations);
  } catch (e) {
    status.lastBuoyError = e.message;
    console.error('Buoy refresh failed:', e.message);
  }
  setTimeout(buoyLoop, 30 * 60000);
}

async function loop() {
  try {
    await check();
    status.lastError = null;
  } catch (e) {
    status.lastError = e.message;
    console.error('Check failed:', e);
  }
  setTimeout(loop, CHECK_MS);
}

// ---------- HTTP API ----------

function cleanPlaces(places) {
  if (!Array.isArray(places)) return [];
  return places.filter(validPoint).slice(0, 10).map((p) => ({
    name: String(p.name || 'Saved place').slice(0, 40), lat: +p.lat, lon: +p.lon,
  }));
}

const cleanFt = (v) => (Number.isFinite(+v) ? Math.max(0, Math.min(5, +v)) : 1.0);
const cleanMi = (v) => (Number.isFinite(+v) ? Math.max(0, Math.min(50, +v)) : 10);
const cleanNm = (v) => (Number.isFinite(+v) ? Math.max(0, Math.min(5, +v)) : 1);
const cleanKt = (v) => (Number.isFinite(+v) ? Math.max(0, Math.min(80, +v)) : 25);
const cleanDegF = (v) => (Number.isFinite(+v) ? Math.max(0, Math.min(15, +v)) : 3);

function cleanMarine(m) {
  return { on: m.on !== false, zone: /^(GMZ|AMZ|ANZ)\d{3}$/.test(m.zone || '') ? m.zone : 'auto' };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 16384) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('Bad JSON')); }
    });
    req.on('error', reject);
  });
}

const routes = {
  'GET /api/vapid': async () => ({ key: vapid.publicKey }),

  'GET /api/status': async () => {
    let navy = null;
    try { navy = navyMeta(NAVY_DIR).cycle; } catch { /* not fetched yet */ }
    return { ...status, navy, subscribers: Object.keys(subs).length };
  },

  // Navy (FNMOC) forecasts: run info, and the series at one point.
  'GET /api/navy/meta': async () => navyMeta(NAVY_DIR),
  // Latest NDBC buoy / coastal station reports (water temperature, waves, wind).
  'GET /api/buoys': async () => buoySnapshot(),

  // Latest measured water level at every Atlantic-side gauge.
  'GET /api/waterlevels': async () => waterLevelSnapshot(),

  // Sailing weather maps: which NOAA and Navy runs are available.
  'GET /api/passage/meta': async () => passageMeta(PASSAGE_DIR, NAVY_DIR),
  'GET /api/navy/point': async (_, q) => navyPoint(NAVY_DIR, +q.get('lat'), +q.get('lon')),

  // { subscription, places, last: {lat, lon} } — creates or replaces a subscriber.
  'POST /api/subscribe': async (b) => {
    const s = b.subscription;
    if (!s || typeof s.endpoint !== 'string' || !s.endpoint.startsWith('https://') || !s.keys) throw new Error('Bad subscription');
    if (!subs[s.endpoint] && Object.keys(subs).length >= MAX_SUBS) throw new Error('Server is full');
    const prev = subs[s.endpoint] || {};
    subs[s.endpoint] = {
      subscription: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } },
      places: b.places ? cleanPlaces(b.places) : prev.places || [],
      last: validPoint(b.last) ? { lat: +b.last.lat, lon: +b.last.lon, at: Date.now() } : prev.last || null,
      marine: b.marine ? cleanMarine(b.marine) : prev.marine || { on: true, zone: 'auto' },
      outlookOn: b.outlook === undefined ? prev.outlookOn !== false : b.outlook !== false,
      highWaterFt: b.highWaterFt === undefined ? prev.highWaterFt ?? 1.0 : cleanFt(b.highWaterFt),
      highWater: prev.highWater || {},
      waterTempF: b.waterTempF === undefined ? prev.waterTempF ?? 3 : cleanDegF(b.waterTempF),
      metric: b.metric === undefined ? !!prev.metric : !!b.metric,
      waterTemp: prev.waterTemp || {},
      windKt: b.windKt === undefined ? prev.windKt ?? 25 : cleanKt(b.windKt),
      wind: prev.wind || {},
      tideFt: b.tideFt === undefined ? prev.tideFt ?? 1.0 : cleanFt(b.tideFt),
      tides: prev.tides || {},
      fogNm: b.fogNm === undefined ? prev.fogNm ?? 1 : cleanNm(b.fogNm),
      fog: prev.fog || {},
      lightningMi: b.lightningMi === undefined ? prev.lightningMi ?? 10 : cleanMi(b.lightningMi),
      thunder: prev.thunder || {},
      marineSent: prev.marineSent || {},
      stormState: prev.stormState || {},
      state: prev.state || {},
    };
    saveSubs();
    return { ok: true };
  },

  'POST /api/location': async (b) => {
    const sub = subs[b.endpoint];
    if (!sub) throw new Error('Not subscribed');
    if (!validPoint(b)) throw new Error('Bad location');
    sub.last = { lat: +b.lat, lon: +b.lon, at: Date.now() };
    saveSubs();
    return { ok: true };
  },

  'POST /api/places': async (b) => {
    const sub = subs[b.endpoint];
    if (!sub) throw new Error('Not subscribed');
    sub.places = cleanPlaces(b.places);
    saveSubs();
    return { ok: true };
  },

  // { endpoint, ft } — high water alert threshold in feet above predicted (0 = off).
  'POST /api/highwater': async (b) => {
    const sub = subs[b.endpoint];
    if (!sub) throw new Error('Not subscribed');
    sub.highWaterFt = cleanFt(b.ft);
    saveSubs();
    return { ok: true };
  },

  // { endpoint, mi } — lightning alert distance in miles (0 = off, also stops NWS thunderstorm alerts).
  'POST /api/lightning': async (b) => {
    const sub = subs[b.endpoint];
    if (!sub) throw new Error('Not subscribed');
    sub.lightningMi = cleanMi(b.mi);
    saveSubs();
    return { ok: true };
  },

  // { endpoint, nm } — fog / low visibility alert distance in nautical miles (0 = off).
  'POST /api/fog': async (b) => {
    const sub = subs[b.endpoint];
    if (!sub) throw new Error('Not subscribed');
    sub.fogNm = cleanNm(b.nm);
    saveSubs();
    return { ok: true };
  },

  // { endpoint, ft } — extreme tide margin in feet beyond the normal range (0 = off).
  'POST /api/tides': async (b) => {
    const sub = subs[b.endpoint];
    if (!sub) throw new Error('Not subscribed');
    sub.tideFt = cleanFt(b.ft);
    saveSubs();
    return { ok: true };
  },

  // { endpoint, kt } — wind forecast alert threshold in knots (0 = off).
  'POST /api/wind': async (b) => {
    const sub = subs[b.endpoint];
    if (!sub) throw new Error('Not subscribed');
    sub.windKt = cleanKt(b.kt);
    saveSubs();
    return { ok: true };
  },

  // { endpoint, f, metric } — water temperature change alert, in °F (0 = off), and units.
  'POST /api/watertemp': async (b) => {
    const sub = subs[b.endpoint];
    if (!sub) throw new Error('Not subscribed');
    sub.waterTempF = cleanDegF(b.f);
    sub.metric = !!b.metric;
    saveSubs();
    return { ok: true };
  },

  // { endpoint, on } — tropical outlook alerts on/off.
  'POST /api/outlook': async (b) => {
    const sub = subs[b.endpoint];
    if (!sub) throw new Error('Not subscribed');
    sub.outlookOn = b.on !== false;
    saveSubs();
    return { ok: true };
  },

  // { endpoint, on, zone } — marine alerts on/off and the zone chosen in the app.
  'POST /api/marine': async (b) => {
    const sub = subs[b.endpoint];
    if (!sub) throw new Error('Not subscribed');
    sub.marine = cleanMarine(b);
    saveSubs();
    return { ok: true };
  },

  'POST /api/unsubscribe': async (b) => {
    delete subs[b.endpoint];
    saveSubs();
    return { ok: true };
  },

  'POST /api/test': async (b) => {
    if (!subs[b.endpoint]) throw new Error('Not subscribed');
    const ok = await push(b.endpoint, { title: 'Wx Now', body: 'Test alert — alerts are working.', tag: 'test', url: './' });
    if (!ok) throw new Error('Push service rejected the test alert');
    return { ok: true };
  },
};

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://local');
  const file = req.method === 'GET' && url.pathname.match(/^\/api\/navy\/files\/(\d{10})\/([\w.]+)$/);
  if (file) {
    const p = navyFile(NAVY_DIR, file[1], file[2]);
    if (!p) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {
      'Content-Type': p.endsWith('.png') ? 'image/png' : 'application/json',
      'Cache-Control': 'public, max-age=21600',
    });
    return fs.createReadStream(p).pipe(res);
  }
  const step = req.method === 'GET' && url.pathname.match(/^\/api\/passage\/(noaa|navy)\/(\d{10})\/(\d{3})\.bin$/);
  if (step) {
    let buf = null;
    try { buf = passageStep(PASSAGE_DIR, NAVY_DIR, step[1], step[2], step[3]); } catch { /* fall through to 404 */ }
    if (!buf) { res.writeHead(404); return res.end(); }
    // Caddy only compresses text types, so gzip these grids here (about 4x smaller).
    const gz = /gzip/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=21600',
      Vary: 'Origin, Accept-Encoding', ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
    });
    return res.end(gz ? zlib.gzipSync(buf, { level: 6 }) : buf);
  }
  const route = routes[`${req.method} ${url.pathname}`];
  if (!route) { res.writeHead(404); return res.end(); }
  try {
    const body = req.method === 'POST' ? await readBody(req) : null;
    const out = await route(body || {}, url.searchParams);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Wx Now alert server on 127.0.0.1:${PORT}, ${Object.keys(subs).length} subscriber(s)`);
  loop();
  stormLoop();
  marineLoop();
  highWaterLoop();
  buoyLoop();
  windLoop();
  fogLoop();
  thunderLoop();
  setTimeout(tideLoop, 90 * 1000);   // after the start-up NOAA requests
  setTimeout(waterLevelLoop, 60000);   // after start-up checks
});
