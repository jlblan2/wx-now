// Measured water levels at every Atlantic-side NOAA gauge, for the Sailing weather map.
// NOAA has no bulk feed and its API gateway blocks bursts (a few hundred requests in a few
// minutes earned a temporary 403), so this sweeps gently: one small "latest" request per
// gauge, 3 s apart, every 30 minutes. Predictions are refreshed twice a day and flood
// levels weekly (kept on disk). The app fetches the whole set in one request.
import fs from 'node:fs';
import path from 'node:path';
import { WL_STATIONS } from '../tidestations.js';

const API = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const MDAPI = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations';
const UA = { 'User-Agent': 'WxNow alert server (github.com/jlblan2/wx-now)' };
const PAUSE_MS = 3000;
const FLOOD_FETCHES_PER_SWEEP = 25;   // spread the one-off flood-level lookups over several sweeps
let floodBudget = 0;

const getJson = (url) => fetch(url, { headers: UA }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
const ymd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
const parseT = (t) => Date.parse(`${t.replace(' ', 'T')}:00Z`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const common = (id) => `station=${id}&datum=MLLW&units=english&time_zone=gmt&format=json&application=WxNow`;

const preds = new Map();    // id -> { at, points }
let floods = new Map();     // id -> { at, minor, moderate, major } (ft above MLLW)
let floodFile = null;
const prev = new Map();     // id -> last reading, for the trend
let snapshot = { at: null, gauges: [] };

async function predictions(id) {
  const hit = preds.get(id);
  if (hit && Date.now() - hit.at < 12 * 3600000) return hit.points;
  const start = new Date(Date.now() - 3 * 3600000);
  const j = await getJson(`${API}?product=predictions&interval=6&begin_date=${ymd(start)}&range=40&${common(id)}`);
  const points = (j.predictions || []).map((x) => ({ t: parseT(x.t), v: +x.v }));
  preds.set(id, { at: Date.now(), points });
  return points;
}

async function floodLevels(id) {
  const hit = floods.get(id);
  if (hit && Date.now() - hit.at < 7 * 86400000) return hit;
  if (floodBudget <= 0) return hit || {};
  floodBudget--;
  const out = { at: Date.now() };
  try {
    const [f, d] = await Promise.all([getJson(`${MDAPI}/${id}/floodlevels.json`), getJson(`${MDAPI}/${id}/datums.json`)]);
    const mllw = (d.datums || []).find((x) => x.name === 'MLLW');
    if (mllw && d.units === 'feet') {
      for (const s of ['minor', 'moderate', 'major']) {
        const v = f[`nws_${s}`] ?? f[`nos_${s}`];
        if (typeof v === 'number') out[s] = Math.round((v - mllw.value) * 10) / 10;
      }
    }
  } catch { /* optional */ }
  floods.set(id, out);
  if (floodFile) fs.writeFileSync(floodFile, JSON.stringify([...floods]));
  return out;
}

function predictedAt(points, t) {
  for (let i = 1; i < points.length; i++) {
    if (points[i].t >= t) {
      const a = points[i - 1], b = points[i], f = (t - a.t) / ((b.t - a.t) || 1);
      return a.v + (b.v - a.v) * f;
    }
  }
  return null;
}

async function readGauge([id, name, lat, lon]) {
  const j = await getJson(`${API}?product=water_level&date=latest&${common(id)}`);
  const x = (j.data || [])[0];
  if (!x || x.v === '') return null;
  const t = parseT(x.t), level = +x.v;
  if (Date.now() - t > 2 * 3600000) return null;   // stale
  const [points, flood] = await Promise.all([predictions(id).catch(() => []), floodLevels(id)]);
  const predicted = predictedAt(points, t);
  const before = prev.get(id);
  const rising = before && t - before.t >= 5 * 60000 && t - before.t <= 40 * 60000 ? (level - before.level > 0.03 ? 1 : before.level - level > 0.03 ? -1 : 0) : null;
  if (!before || before.t !== t) prev.set(id, { t, level });
  return {
    id, name, lat, lon, t,
    level: Math.round(level * 100) / 100,
    above: predicted === null ? null : Math.round((level - predicted) * 100) / 100,
    rising, minor: flood.minor ?? null, moderate: flood.moderate ?? null, major: flood.major ?? null,
  };
}

// Where to keep flood levels between restarts.
export function initWaterLevels(dataDir) {
  floodFile = path.join(dataDir, 'floodlevels.json');
  try { floods = new Map(JSON.parse(fs.readFileSync(floodFile, 'utf8'))); } catch { /* first run */ }
}

export async function sweepWaterLevels() {
  floodBudget = FLOOD_FETCHES_PER_SWEEP;
  const out = [];
  for (const g of WL_STATIONS) {
    try {
      const r = await readGauge(g);
      if (r) out.push(r);
    } catch (e) {
      if (/403/.test(e.message)) throw new Error('NOAA is rate-limiting this server; sweep stopped');
    }
    await sleep(PAUSE_MS);
  }
  snapshot = { at: new Date().toISOString(), gauges: out };
  return snapshot;
}

export const waterLevelSnapshot = () => snapshot;
