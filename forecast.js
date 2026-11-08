// The rain-in-the-wx-now forecast pipeline, shared by the app and the alert server: radar nowcast,
// blending with the weather model, and the plain-English summary.

import {
  RAIN_RATE, makeField, estimateMotion, pointForecast, hindcast, velocity, removeClutter,
} from './nowcast.js';
import {
  FRAME_MIN, makeGrid, toPixel, fetchFrame, latestFrameTime, pruneCache,
  inDomain, nearestRadar, radarQuality,
} from './radar.js';
import { modelRateAt } from './model.js';

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

export async function runRadar(loc) {
  const latest = await latestFrameTime();
  const times = [];
  for (let m = HISTORY_MIN; m >= 0; m -= FRAME_MIN) times.push(new Date(latest - m * 60000));
  const grid = makeGrid(loc.lat, loc.lon);
  const got = await Promise.allSettled(times.map((t) => fetchFrame(grid, t)));
  pruneCache(latest - (HISTORY_MIN + 10) * 60000);
  await nextTick();

  let fields = [];
  got.forEach((g, i) => {
    if (g.status === 'fulfilled') fields.push(makeField(g.value, grid.w, grid.h, grid.dx, times[i].getTime()));
  });
  if (!fields.length) throw new Error('No radar frames could be loaded');
  let now = fields[fields.length - 1];
  const recentOf = (fs) => fs.filter((f) => f.time >= now.time - 30 * 60000);
  if (recentOf(fields).length < 4) throw new Error('Too few recent radar frames to track storms');

  await nextTick();
  let mf = estimateMotion(recentOf(fields));
  // Drop still, persistent clutter, then track again without it (clutter drags motion to zero).
  const clean = removeClutter(fields, mf);
  let clutterKm2 = 0;
  if (clean) {
    fields = clean.fields;
    now = fields[fields.length - 1];
    clutterKm2 = Math.round(clean.removed * grid.dx * grid.dx);
    await nextTick();
    mf = estimateMotion(recentOf(fields));
  }
  const p = toPixel(grid, loc.lat, loc.lon);
  const age = Math.max(0, (Date.now() - now.time) / 60000);
  const pf = pointForecast(now, mf, p.x, p.y, Math.ceil(age) + 60);

  await nextTick();
  const check = hindcast(fields, 30, p.x, p.y, 60 / grid.dx) || hindcast(fields, 15, p.x, p.y, 60 / grid.dx);

  let echo = 0;
  for (const r of now.rate) if (r >= RAIN_RATE) echo++;
  const vel = velocity(mf, p.x, p.y);
  return { grid, fields, now, mf, pf, age, check, echo, point: p, vel, clutterKm2 };
}

export function blend(radar, model, quality) {
  const series = [];
  const t0 = Date.now();
  for (let m = 0; m <= 60; m++) {
    let pr = 0, ir = 0, q = 0;
    if (radar) {
      const lead = Math.min(radar.pf.prob.length - 1, Math.round(radar.age + m));
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
  return series;
}

// Rain "stops" at the first minute the chance drops below P_ON and stays below for 5 minutes.
// (Using the same 50% crossing as the start keeps stop times from running late.)
function endAfter(series, from) {
  for (let m = from; m <= 56; m++) {
    if (series.slice(m, m + 5).every((s) => s.prob < P_ON)) return m;
  }
  return null;
}

function typicalIntensity(series, a, b) {
  const xs = series.slice(a, b + 1).filter((s) => s.prob >= P_ON).map((s) => s.intensity).sort((x, y) => x - y);
  return xs.length ? xs[Math.floor(xs.length / 2)] : 0;
}

// Likely window around a start (rising) or stop at minute m: from where the chance of rain
// passes 25% to where it passes 75% (the forecast's own spread), never narrower than the
// typical error of radar rain timing, which grows with lead time (checked against airport
// "rain began" reports: about 10 minutes on average). Returns [from, to] in minutes.
export function changeWindow(series, m, rising) {
  const last = series.length - 1;
  const p = (k) => series[Math.max(0, Math.min(last, k))].prob;
  // Nearest minute at or after (step 1) / before (step -1) m, within 20 min, where test passes.
  const find = (step, test) => {
    for (let k = m; k >= 0 && k <= last && Math.abs(k - m) <= 20; k += step) if (test(p(k))) return k;
    return m;
  };
  const a = rising ? find(-1, (x) => x < P_MAYBE) + 1 : find(-1, (x) => x >= 0.75) + 1;
  const b = rising ? find(1, (x) => x >= 0.75) : find(1, (x) => x < P_MAYBE);
  const half = 3 + Math.round(m / 10);
  return [Math.max(0, Math.min(a, m - half)), Math.min(60, Math.max(b, m + half))];
}

// Clock-time range, e.g. "3:38–3:52 PM" (am/pm written once when both match).
function timeRange(t0, [a, b], timeOf) {
  const x = timeOf(t0 + a * 60000), y = timeOf(t0 + b * 60000);
  const ax = x.match(/^(.*?)\s*([AaPp]\.?[Mm]\.?)$/), by = y.match(/^(.*?)\s*([AaPp]\.?[Mm]\.?)$/);
  return ax && by && ax[2] === by[2] ? `${ax[1]}–${y}` : `${x}–${y}`;
}

// The headline as HTML: the change in plain words with a likely clock-time range, e.g.
// "Light rain starting in about 12 min (3:38–3:52 PM, ending 4:04–4:18 PM)".
// timeOf formats a time in the selected place's zone.
export function headline(s, noun, t0, timeOf) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const when = (t) => ` <span class="when">(${t})</span>`;
  const Word = s.word ? cap(s.word) : '';
  if (s.raining && s.stop) {
    return `${Word} ${noun} stopping in about ${s.stop} min${when(`likely ${timeRange(t0, s.stopWin, timeOf)}`)}`;
  }
  if (!s.raining && s.start > 0 && s.word) {
    const end = s.stop ? `, ending ${timeRange(t0, s.stopWin, timeOf)}` : '';
    return `${Word} ${noun} starting in about ${s.start} min${when(`likely ${timeRange(t0, s.startWin, timeOf)}${end}`)}`;
  }
  if (s.maybe) return `Possible ${noun} in about ${s.maybe} min${when(`${timeOf(t0 + s.maybe * 60000)}, ${s.chance}% chance`)}`;
  return esc(s.text);
}

export function summarize(series, noun, radarClear) {
  if (series[0].prob >= P_ON) {
    const stop = endAfter(series, 1);
    const word = intensityWord(typicalIntensity(series, 0, stop ?? 60));
    return {
      text: stop ? `${cap(word)} ${noun} stopping in about ${stop} min` : `${cap(word)} ${noun} for the hour`,
      start: 0, raining: true, word, stop, stopWin: stop ? changeWindow(series, stop, false) : null,
    };
  }
  const start = series.findIndex((s) => s.prob >= P_ON);
  if (start > 0) {
    const end = endAfter(series, start + 1);
    const word = intensityWord(typicalIntensity(series, start, Math.min(60, start + 15)));
    const tail = end ? `, stopping about ${end - start} min later` : '';
    return {
      text: `${cap(word)} ${noun} starting in about ${start} min${tail}`, start, raining: false, word,
      startWin: changeWindow(series, start, true), stop: end, stopWin: end ? changeWindow(series, end, false) : null,
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
