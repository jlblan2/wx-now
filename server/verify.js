// Daily forecast check against airport reports. Airport weather stations log the minute rain
// began and ended ("RAB12", "RAE47" in METAR remarks). Each night this replays the rain
// forecast, as the app would have made it 15 minutes before each start and stop (same most-
// local radar pipeline, from archived scans), and records how far off it was. The rolling
// 30-day results give the score shown in the app and calibrate its "% on time".
import fs from 'node:fs';
import path from 'node:path';
import { runRadar, blend, summarize, fallDelay } from '../forecast.js';

export const STATIONS = 'JAX FHB CRG NIP VQQ SSI SAV BQK GNV DAB SFB MCO ORL MLB VRB FPR PBI FLL MIA TPA PIE SRQ RSW TLH PNS CHS MYR ILM VLD ABY'.split(' ');
const LEAD_MIN = 15;
const WINDOW_MIN = 5;          // "on time" = within this many minutes
const KEEP_DAYS = 60, SCORE_DAYS = 30;
const MAX_PER_DAY = 40;        // events replayed per day (spread over the day)
export const BINS = [[0, 30], [30, 50], [50, 70], [70, 101]];
const UA = { 'User-Agent': 'WxNow alert server (github.com/jlblan2/wx-now)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- airport rain begin / end times ----------

// METAR rows ({ station, valid 'YYYY-MM-DD HH:MM', lat, lon, metar }) -> begin/end events.
export function rainEvents(rows) {
  const marks = new Map(), pos = new Map();
  for (const r of rows) {
    pos.set(r.station, { lat: +r.lat, lon: +r.lon });
    const obs = Date.parse(`${r.valid.replace(' ', 'T')}:00Z`);
    const rmk = r.metar.includes(' RMK ') ? r.metar.split(' RMK ')[1] : '';
    // RAB11E33, SHRAB05, TSRAB1745E1810 ... liquid rain only
    for (const m of rmk.matchAll(/(?<![A-Z])(?:SH|TS)?RA((?:[BE]\d{2,4})+)/g)) {
      for (const [, kind, hhmm] of m[1].matchAll(/([BE])(\d{2,4})/g)) {
        const d = new Date(obs);
        let t;
        if (hhmm.length === 4) {
          t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), +hhmm.slice(0, 2), +hhmm.slice(2));
          if (t > obs) t -= 86400000;
        } else {
          t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), +hhmm);
          if (t > obs) t -= 3600000;
        }
        const list = marks.get(r.station) || [];
        if (!list.some((x) => x.t === t && x.kind === kind)) list.push({ t, kind });
        marks.set(r.station, list);
      }
    }
  }
  const out = [];
  for (const [station, list] of marks) {
    list.sort((a, b) => a.t - b.t);
    let lastEnd = null, began = null;
    list.forEach((m, i) => {
      if (m.kind === 'B') {
        // a start after 90+ dry minutes
        if (began === null && (lastEnd === null || m.t - lastEnd >= 90 * 60000)) out.push({ station, ...pos.get(station), kind: 'start', t: m.t });
        if (began === null) began = m.t;
      } else {
        // a stop after 10+ minutes of rain, followed by 30+ dry minutes
        const next = list.slice(i + 1).find((x) => x.kind === 'B');
        if (began !== null && m.t - began >= 10 * 60000 && (!next || next.t - m.t >= 30 * 60000)) out.push({ station, ...pos.get(station), kind: 'stop', t: m.t });
        began = null;
        lastEnd = m.t;
      }
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

async function metarRows(from, to) {
  const d1 = new Date(from), d2 = new Date(to + 86400000);
  const q = STATIONS.map((s) => `station=${s}`).join('&') +
    `&data=metar&year1=${d1.getUTCFullYear()}&month1=${d1.getUTCMonth() + 1}&day1=${d1.getUTCDate()}` +
    `&year2=${d2.getUTCFullYear()}&month2=${d2.getUTCMonth() + 1}&day2=${d2.getUTCDate()}` +
    '&tz=Etc/UTC&format=onlycomma&latlon=yes&missing=M&trace=T&direct=no&report_type=3&report_type=4';
  const r = await fetch(`https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?${q}`, { headers: UA });
  if (!r.ok) throw new Error(`IEM ASOS ${r.status}`);
  const [head, ...lines] = (await r.text()).trim().split('\n');
  const cols = head.split(',');
  return lines.map((line) => {
    const f = line.split(','), o = {};
    cols.forEach((c, i) => { o[c] = c === 'metar' ? f.slice(i).join(',') : f[i]; });
    return o;
  });
}

// ---------- replaying the forecast ----------

// Minutes the forecast was off (+ = later than the airport), 'early' when the forecast already
// had the change happening at issue time, or null when it did not foresee it within the hour.
export function scoreSummary(ev, s, issue) {
  if (ev.kind === 'start') {
    if (s.raining) return { err: 'early', conf: null };
    if (!s.start) return { err: null, conf: null };
    return { err: (issue + s.start * 60000 - ev.t) / 60000, conf: s.startConf ?? null };
  }
  if (!s.raining) return { err: 'early', conf: null };
  if (!s.stop) return { err: null, conf: null };
  return { err: (issue + s.stop * 60000 - ev.t) / 60000, conf: s.stopConf ?? null };
}

async function replay(ev) {
  const issue = ev.t - LEAD_MIN * 60000;
  const r = await runRadar({ lat: ev.lat, lon: ev.lon }, { at: issue });
  const s = summarize(blend(r, null, 1, fallDelay(r.source.km, 20, r.source.elevDeg)), 'rain', false);
  return { ...scoreSummary(ev, s, issue), source: r.source.kind };
}

// ---------- results ----------

export function summarizeResults(events, now = Date.now()) {
  const recent = events.filter((e) => e.t >= now - SCORE_DAYS * 86400000);
  const part = (kind) => {
    const rows = recent.filter((e) => e.kind === kind);
    const timed = rows.filter((e) => typeof e.err === 'number');
    const abs = timed.map((e) => Math.abs(e.err)).sort((a, b) => a - b);
    return {
      n: rows.length,
      forecast: timed.length,
      missed: rows.filter((e) => e.err === null).length,
      early: rows.filter((e) => e.err === 'early').length,
      within5: timed.length ? Math.round(100 * timed.filter((e) => Math.abs(e.err) <= WINDOW_MIN).length / timed.length) : null,
      within10: timed.length ? Math.round(100 * timed.filter((e) => Math.abs(e.err) <= 10).length / timed.length) : null,
      typicalMin: abs.length ? Math.round(abs[Math.floor(abs.length / 2)] * 10) / 10 : null,
    };
  };
  // calibration: of forecasts that said "x% on time", how many were within 5 minutes
  const calib = (kind) => BINS.map(([lo, hi]) => {
    const rows = recent.filter((e) => e.kind === kind && typeof e.err === 'number' && e.conf !== null && e.conf >= lo && e.conf < hi);
    return { lo, hi, n: rows.length, actual: rows.length ? Math.round(100 * rows.filter((e) => Math.abs(e.err) <= WINDOW_MIN).length / rows.length) : null };
  });
  const calibration = { start: calib('start'), stop: calib('stop') };
  return { updated: new Date(now).toISOString(), days: SCORE_DAYS, stations: STATIONS.length, starts: part('start'), stops: part('stop'), calibration };
}

let file = null, data = { events: [], done: [] };

export function initVerify(dataDir) {
  file = path.join(dataDir, 'verification.json');
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
}

export const verifySnapshot = () => summarizeResults(data.events);

const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

// Checks one UTC day (or several, for the first backfill). Already-checked days are skipped.
export async function verifyDays(fromDay, toDay, log = () => {}) {
  const days = [];
  for (let t = fromDay; t <= toDay; t += 86400000) if (!data.done.includes(dayKey(t))) days.push(t);
  if (!days.length) return 0;
  const rows = await metarRows(days[0], days[days.length - 1]);
  const all = rainEvents(rows);
  let count = 0;
  for (const day of days) {
    let evs = all.filter((e) => e.t >= day && e.t < day + 86400000);
    if (evs.length > MAX_PER_DAY) { const step = evs.length / MAX_PER_DAY; evs = Array.from({ length: MAX_PER_DAY }, (_, i) => evs[Math.floor(i * step)]); }
    for (const ev of evs) {
      try {
        const res = await replay(ev);
        data.events.push({ station: ev.station, kind: ev.kind, t: ev.t, ...res });
        count++;
      } catch (e) { log(`verify ${ev.station} ${new Date(ev.t).toISOString()}: ${e.message}`); }
      await sleep(300);
    }
    data.done.push(dayKey(day));
    data.events = data.events.filter((e) => e.t >= Date.now() - KEEP_DAYS * 86400000);
    data.done = data.done.filter((d) => Date.parse(d) >= Date.now() - KEEP_DAYS * 86400000);
    if (file) fs.writeFileSync(file, JSON.stringify(data));
  }
  return count;
}
