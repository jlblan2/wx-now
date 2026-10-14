// Next Hour alert server. Every 5 minutes it runs the app's own next-hour forecast for each
// subscriber's saved places and last-known location, and sends a Web Push notification when
// rain is about to start. It also serves a small JSON API the app uses to subscribe.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { decodePng } from './png.js';
import { setPngDecoder } from '../radar.js';
import { fetchModel } from '../model.js';
import { radarCoverage, runRadar, blend, summarize, precipNoun, cap } from '../forecast.js';
import { decide, newState } from './decide.js';

const PORT = +(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://jlblan2.github.io,http://localhost:8430').split(',');
const CHECK_MS = 5 * 60000;
const LAST_LOCATION_MAX_H = 72;   // ignore a last location older than this
const MAX_SUBS = 20;

setPngDecoder(async (bytes) => decodePng(bytes).data);

// ---------- storage ----------

fs.mkdirSync(DATA_DIR, { recursive: true });
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');

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
webpush.setVapidDetails('https://github.com/jlblan2/next-hour', vapid.publicKey, vapid.privateKey);

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

  'GET /api/status': async () => ({ ...status, subscribers: Object.keys(subs).length }),

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

  'POST /api/unsubscribe': async (b) => {
    delete subs[b.endpoint];
    saveSubs();
    return { ok: true };
  },

  'POST /api/test': async (b) => {
    if (!subs[b.endpoint]) throw new Error('Not subscribed');
    const ok = await push(b.endpoint, { title: 'Next Hour', body: 'Test alert — alerts are working.', tag: 'test', url: './' });
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
  const route = routes[`${req.method} ${req.url.split('?')[0]}`];
  if (!route) { res.writeHead(404); return res.end(); }
  try {
    const body = req.method === 'POST' ? await readBody(req) : null;
    const out = await route(body || {});
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Next Hour alert server on 127.0.0.1:${PORT}, ${Object.keys(subs).length} subscriber(s)`);
  loop();
});
