// The rain-in-the-wx-now forecast pipeline, shared by the app and the alert server: radar nowcast,
// blending with the weather model, and the plain-English summary.

import {
  RAIN_RATE, makeField, estimateMotion, pointForecast, hindcast, velocity,
} from './nowcast.js';
import {
  FRAME_MIN, makeGrid, toPixel, fetchFrame, latestFrameTime, pruneCache,
  inDomain, nearestRadar, radarQuality,
} from './radar.js';
import { modelRateAt } from './model.js';
import { localSources, listScans, fetchScan, scanToGrid } from './level3.js';

const HISTORY_MIN = 60;       // radar history fetched (motion uses the last 30 min, the self-check the rest)
export const P_ON = 0.5, P_MAYBE = 0.25, P_OFF = 0.35;

const nextTick = () => new Promise((r) => setTimeout(r, 0));

export function intensityWord(mm) {
  if (mm < 0.5) return 'very light';
  if (mm < 2.5) return 'light';
  if (mm < 7.6) return 'moderate';
  return 'heavy';
}

export function precipNoun(tempC) {
  if (tempC === null || tempC === undefined) return 'rain';
  if (tempC <= 0.5) return 'snow';
  if (tempC <= 2.5) return 'rain and snow';
  return 'rain';
}

export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// How far radar can be trusted at this location (0 = not at all).
export function radarCoverage(loc) {
  const site = nearestRadar(loc.lat, loc.lon);
  return { site, quality: inDomain(loc.lat, loc.lon) ? radarQuality(site.km) : 0 };
}

// Frames from the national 5-minute mosaic (IEM N0Q), oldest first. `at` replays a past time.
async function mosaicFields(grid, at) {
  const latest = at ? Math.floor((at - 2 * 60000) / 300000) * 300000 : (await latestFrameTime()).getTime();
  const times = [];
  for (let m = HISTORY_MIN; m >= 0; m -= FRAME_MIN) times.push(new Date(latest - m * 60000));
  const got = await Promise.allSettled(times.map((t) => fetchFrame(grid, t)));
  if (!at) pruneCache(latest - (HISTORY_MIN + 10) * 60000);
  const fields = [];
  got.forEach((g, i) => {
    if (g.status === 'fulfilled') fields.push(makeField(g.value, grid.w, grid.h, grid.dx, times[i].getTime()));
  });
  return fields;
}

// Frames from the most local radars (level3.js): the place's own radar scans, newest first
// choice, about every 5 minutes back through the history; pixels beyond that radar's range
// come from the next source, then from the mosaic at the nearest earlier 5-minute time.
const SKEW_MS = 150000;
async function localFields(grid, srcs, at) {
  const to = at || Date.now(), from = to - (HISTORY_MIN + 8) * 60000;
  const lists = await Promise.all(srcs.map((s) => listScans(s, from, to)));
  const primary = lists[0];
  if (!primary.length || to - primary[primary.length - 1].t > 15 * 60000) throw new Error(`no recent scans from ${srcs[0].id}`);
  const newest = primary[primary.length - 1].t;
  const pick = (list, t, skew) => {
    let best = null;
    for (const k of list) if (Math.abs(k.t - t) <= skew && (!best || Math.abs(k.t - t) < Math.abs(best.t - t))) best = k;
    return best;
  };
  const plan = [];
  for (let m = HISTORY_MIN; m >= 0; m -= FRAME_MIN) {
    const k = pick(primary, newest - m * 60000, SKEW_MS);
    if (k && !plan.some((p) => p.key === k.key)) plan.push({ key: k.key, t: k.t });
  }
  const mosaicLatest = at ? Math.floor((to - 2 * 60000) / 300000) * 300000 : (await latestFrameTime().catch(() => new Date(to))).getTime();
  const frames = await Promise.all(plan.map(async (p) => {
    const dbz = new Float32Array(grid.w * grid.h).fill(NaN), covered = new Uint8Array(grid.w * grid.h);
    let time = p.t;
    for (let s = 0; s < srcs.length; s++) {
      const k = s === 0 ? p : pick(lists[s], p.t, 4 * 60000);
      if (!k) continue;
      const scan = await fetchScan(k.key).catch(() => null);
      if (!scan) { if (s === 0) return null; continue; }
      if (s === 0) time = scan.time;
      // Inside a TDWR's range the NEXRAD reading is merged in (stronger wins): the TDWR's short
      // wavelength loses signal behind heavy rain, which made it miss rain starts in testing.
      scanToGrid(grid, srcs[s], scan, dbz, covered, 'max', s > 0 && srcs[0].kind === 'tdwr');
    }
    if (covered.some((c) => !c)) {   // fill the rest from the national mosaic
      const mt = Math.min(mosaicLatest, Math.floor(time / 300000) * 300000);
      const m = await fetchFrame(grid, new Date(mt)).catch(() => null);
      if (m) for (let i = 0; i < dbz.length; i++) if (!covered[i]) dbz[i] = m[i];
    }
    return makeField(dbz, grid.w, grid.h, grid.dx, time);
  }));
  const fields = frames.filter(Boolean).sort((a, b) => a.time - b.time);
  const scan = await fetchScan(primary[primary.length - 1].key);
  return { fields, source: { kind: srcs[0].kind, id: srcs[0].id, km: srcs[0].km, elevDeg: scan.elevDeg, label: srcs[0].label, every: srcs[0].every } };
}

// opts.at: replay a past time (ms); opts.mosaicOnly: skip the local radars (for comparison).
export async function runRadar(loc, opts = {}) {
  const grid = makeGrid(loc.lat, loc.lon);
  let fields = null, source = null;
  const srcs = opts.mosaicOnly ? [] : localSources(loc.lat, loc.lon);
  // Most local first; if a radar has no recent scans (outage, gaps in the feed), drop to the next.
  for (let k = 0; k < srcs.length && !fields; k++) {
    try {
      ({ fields, source } = await localFields(grid, srcs.slice(k), opts.at));
      if (fields.filter((f) => f.time >= fields[fields.length - 1].time - 30 * 60000).length < 4) fields = null;
    } catch { fields = null; }
  }
  if (!fields) {
    fields = await mosaicFields(grid, opts.at);
    const site = nearestRadar(loc.lat, loc.lon);
    source = { kind: 'mosaic', id: site.id, km: site.km, elevDeg: 0.5, label: 'national radar mosaic', every: 5 };
  }
  await nextTick();
  if (!fields.length) throw new Error('No radar frames could be loaded');
  const now = fields[fields.length - 1];
  const recent = fields.filter((f) => f.time >= now.time - 30 * 60000);
  if (recent.length < 4) throw new Error('Too few recent radar frames to track storms');

  await nextTick();
  const mf = estimateMotion(recent);
  const p = toPixel(grid, loc.lat, loc.lon);
  const age = Math.max(0, ((opts.at || Date.now()) - now.time) / 60000);
  const pf = pointForecast(now, mf, p.x, p.y, Math.ceil(age) + 60);

  await nextTick();
  const check = hindcast(fields, 30, p.x, p.y, 60 / grid.dx) || hindcast(fields, 15, p.x, p.y, 60 / grid.dx);

  let echo = 0;
  for (const r of now.rate) if (r >= RAIN_RATE) echo++;
  const vel = velocity(mf, p.x, p.y);
  return { grid, fields, now, mf, pf, age, check, echo, point: p, vel, source };
}

// Radar sees rain at the height of its lowest beam (0.5 degree tilt), which rises with
// distance from the radar as the Earth curves away (standard 4/3 Earth-radius refraction):
// about 0.6 km up at 50 km, 1.5 km at 100 km, 2.6 km at 150 km. The rain then has to fall
// that far, at about 6 m/s (snow 1.5, sleet 3), so it reaches the ground a few minutes after
// the radar shows it overhead. Returns { heightKm, minutes }.
export function fallDelay(km, tempC, elevDeg = 0.5) {
  const ka = (4 / 3) * 6371, th = elevDeg * Math.PI / 180;
  const heightKm = Math.sqrt(km * km + ka * ka + 2 * km * ka * Math.sin(th)) - ka;
  const speed = tempC === null || tempC === undefined ? 6 : tempC <= 0 ? 1.5 : tempC <= 2 ? 3 : 6;
  return { heightKm, minutes: Math.min(15, heightKm * 1000 / speed / 60) };
}

// `fall` (from fallDelay) shifts the radar forecast later by the time the rain takes to
// reach the ground.
export function blend(radar, model, quality, fall = null) {
  const series = [];
  const t0 = Date.now();
  const delay = fall ? fall.minutes : 0;
  for (let m = 0; m <= 60; m++) {
    let pr = 0, ir = 0, q = 0;
    if (radar) {
      const lead = Math.max(0, Math.min(radar.pf.prob.length - 1, Math.round(radar.age + m - delay)));
      pr = radar.pf.prob[lead]; ir = radar.pf.intensity[lead];
      q = quality * radar.pf.coverage[lead];
    }
    let pm = 0, im = 0;
    if (model) {
      // The model only resolves 15-minute steps, so on its own it never claims minute-level
      // certainty: these stay under P_ON and read as "possible".
      im = modelRateAt(model, t0 + m * 60000);
      pm = im >= RAIN_RATE ? 0.45 : im >= 0.1 ? 0.25 : 0;
    } else if (radar) {
      q = 1; // nothing better to fall back on
    }
    const prob = q * pr + (1 - q) * pm;
    const wr = q * pr, wm = (1 - q) * pm;
    const intensity = wr + wm > 0 ? (wr * ir + wm * im) / (wr + wm) : 0;
    series.push({ m, prob, intensity });
  }
  series.t0 = t0;   // the clock time of minute 0
  series.fall = radar ? fall : null;
  return series;
}

function endAfter(series, from) {
  for (let m = from; m <= 56; m++) {
    if (series.slice(m, m + 5).every((s) => s.prob < P_OFF)) return m;
  }
  return null;
}

function typicalIntensity(series, a, b) {
  const xs = series.slice(a, b + 1).filter((s) => s.prob >= P_ON).map((s) => s.intensity).sort((x, y) => x - y);
  return xs.length ? xs[Math.floor(xs.length / 2)] : 0;
}

// Chance that rain starts (or stops) within TIMING_WINDOW minutes of the minute shown, read
// from the minute-by-minute probabilities: how much the chance of rain rises (or falls)
// across that window. Rounded to 5%.
export const TIMING_WINDOW = 5;
function timingConf(series, m, rising) {
  const at = (k) => series[Math.max(0, Math.min(series.length - 1, k))].prob;
  const d = rising ? at(m + TIMING_WINDOW) - at(m - TIMING_WINDOW - 1) : at(m - TIMING_WINDOW - 1) - at(m + TIMING_WINDOW);
  return Math.max(5, Math.min(95, Math.round(d * 20) * 5));
}

// The headline as HTML, with the local clock time of each change and how likely that time is
// to be right (within TIMING_WINDOW minutes), e.g.
// "Light rain starting in 12 min (3:42 PM · 70% on time)". timeOf formats a time in the
// selected place's zone.
export function headline(s, noun, t0, timeOf) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const at = (m, conf) => ` <span class="when">(${timeOf(t0 + m * 60000)}${conf ? ` · ${conf}% on time` : ''})</span>`;
  const Word = s.word ? cap(s.word) : '';
  if (s.raining && s.stop) return `${Word} ${noun} stopping in ${s.stop} min${at(s.stop, s.stopConf)}`;
  if (!s.raining && s.start > 0 && s.word) {
    const tail = s.stop ? `, stopping ${s.stop - s.start} min later${at(s.stop, s.stopConf)}` : '';
    return `${Word} ${noun} starting in ${s.start} min${at(s.start, s.startConf)}${tail}`;
  }
  if (s.maybe) return `Possible ${noun} in about ${s.maybe} min${at(s.maybe)}, ${s.chance}% chance`;
  return esc(s.text);
}

export function summarize(series, noun, radarClear) {
  if (series[0].prob >= P_ON) {
    const stop = endAfter(series, 1);
    const word = intensityWord(typicalIntensity(series, 0, stop ?? 60));
    return {
      text: stop ? `${cap(word)} ${noun} stopping in ${stop} min` : `${cap(word)} ${noun} for the hour`,
      start: 0, raining: true, word, stop, stopConf: stop ? timingConf(series, stop, false) : null,
    };
  }
  const start = series.findIndex((s) => s.prob >= P_ON);
  if (start > 0) {
    const end = endAfter(series, start + 1);
    const word = intensityWord(typicalIntensity(series, start, Math.min(60, start + 15)));
    const tail = end ? `, stopping ${end - start} min later` : '';
    return {
      text: `${cap(word)} ${noun} starting in ${start} min${tail}`, start, raining: false,
      word, startConf: timingConf(series, start, true), stop: end, stopConf: end ? timingConf(series, end, false) : null,
    };
  }
  const maybe = series.findIndex((s) => s.prob >= P_MAYBE);
  if (maybe > 0) {
    const pk = Math.max(...series.map((s) => s.prob));
    return { text: `Possible ${noun} in about ${maybe} min (${Math.round(pk * 100)}% chance)`, start: null, raining: false, maybe, chance: Math.round(pk * 100) };
  }
  return {
    text: radarClear ? `No ${noun} for the hour — radar is clear for 100 miles` : `No ${noun} for the hour`,
    start: null, raining: false,
  };
}
