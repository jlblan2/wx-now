// Tide predictions for the Seas & swell tab, from NOAA CO-OPS (api.tidesandcurrents.noaa.gov):
// high and low tides for the nearest Atlantic-side station, a 3-day tide curve and the
// tide right now. Heights are above MLLW (mean lower low water), the chart datum.
import { TIDE_STATIONS } from './tidestations.js';

const API = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const NM_PER_KM = 0.539957;
let opts, current = null, choice;
const cache = new Map();
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

function km(a, b) {
  const r = Math.PI / 180;
  return Math.hypot((b.lon - a.lon) * Math.cos((a.lat + b.lat) / 2 * r), b.lat - a.lat) * 111.2;
}

export function nearestStations(loc, n = 25) {
  return TIDE_STATIONS.map(([id, name, state, lat, lon, type]) => ({ id, name, state, lat, lon, type, km: km(loc, { lat, lon }) }))
    .sort((a, b) => a.km - b.km).slice(0, n);
}

const ymd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;

// Highs and lows from yesterday to 3 days ahead (UTC times), so the curve can start
// before the first tide of today.
async function highsLows(id, metric) {
  const start = new Date(Date.now() - 30 * 3600000);
  const key = `${id}|${metric}|${ymd(start)}`;
  if (!cache.has(key)) {
    const q = new URLSearchParams({
      product: 'predictions', station: id, begin_date: ymd(start), range: '120', datum: 'MLLW',
      interval: 'hilo', units: metric ? 'metric' : 'english', time_zone: 'gmt', format: 'json', application: 'NextHour',
    });
    const p = fetch(`${API}?${q}`).then((r) => r.json()).then((j) => {
      if (j.error) throw new Error(j.error.message || 'No predictions');
      return (j.predictions || []).map((x) => ({ t: Date.parse(`${x.t.replace(' ', 'T')}:00Z`), v: +x.v, type: x.type }));
    });
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return cache.get(key);
}

// Tide height at a moment, by cosine interpolation between the surrounding high and low
// (the standard way to draw tides between NOAA's predicted extremes).
function heightAt(ex, t) {
  for (let i = 1; i < ex.length; i++) {
    if (t <= ex[i].t) {
      const a = ex[i - 1], b = ex[i], f = (t - a.t) / (b.t - a.t);
      return a.v + (b.v - a.v) * (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, f)))) / 2;
    }
  }
  return NaN;
}

const time = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function drawChart(ex, unit) {
  const cv = $('tideChart'), dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const muted = css.getPropertyValue('--muted').trim(), grid = css.getPropertyValue('--border').trim();
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const t0 = day0.getTime(), t1 = t0 + 3 * 86400000;
  const shown = ex.filter((e) => e.t >= t0 - 86400000 && e.t <= t1 + 86400000);
  const vals = shown.map((e) => e.v);
  const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.15 || 0.5;
  const L0 = 34, R0 = 6, T0 = 16, B0 = 20, pw = W - L0 - R0, ph = H - T0 - B0;
  const X = (t) => L0 + (t - t0) / (t1 - t0) * pw;
  const Y = (v) => T0 + (1 - (v - (lo - pad)) / (hi - lo + 2 * pad)) * ph;
  ctx.font = '11px -apple-system, system-ui, sans-serif';
  ctx.strokeStyle = grid; ctx.fillStyle = muted; ctx.lineWidth = 1;
  for (let d = 0; d <= 3; d++) {
    const x = X(t0 + d * 86400000);
    ctx.beginPath(); ctx.moveTo(x + 0.5, T0); ctx.lineTo(x + 0.5, T0 + ph); ctx.stroke();
    if (d < 3) {
      ctx.textAlign = 'center';
      ctx.fillText(new Date(t0 + (d + 0.5) * 86400000).toLocaleDateString([], { weekday: 'short' }), x + pw / 6, H - 5);
    }
  }
  ctx.textAlign = 'right';
  const step = (hi - lo) > 4 ? 2 : 1;
  for (let v = Math.ceil(lo - pad); v <= hi + pad; v += step) {
    ctx.fillText(`${v}${unit}`, L0 - 4, Y(v) + 4);
    ctx.globalAlpha = 0.4; ctx.beginPath(); ctx.moveTo(L0, Y(v) + 0.5); ctx.lineTo(L0 + pw, Y(v) + 0.5); ctx.stroke(); ctx.globalAlpha = 1;
  }
  // Curve, filled below.
  ctx.beginPath();
  for (let px = 0; px <= pw; px += 2) {
    const t = t0 + px / pw * (t1 - t0), v = heightAt(ex, t);
    if (Number.isNaN(v)) continue;
    if (px === 0) ctx.moveTo(L0 + px, Y(v)); else ctx.lineTo(L0 + px, Y(v));
  }
  ctx.strokeStyle = '#4a8cff'; ctx.lineWidth = 2; ctx.stroke();
  ctx.lineTo(L0 + pw, T0 + ph); ctx.lineTo(L0, T0 + ph); ctx.closePath();
  ctx.fillStyle = 'rgba(74,140,255,0.15)'; ctx.fill();
  // Highs and lows.
  ctx.fillStyle = css.getPropertyValue('--text').trim(); ctx.textAlign = 'center';
  for (const e of ex) {
    if (e.t < t0 || e.t > t1) continue;
    const x = X(e.t), y = Y(e.v);
    ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 2 * Math.PI); ctx.fill();
    ctx.fillText(e.type === 'H' || e.type === 'HH' ? `${e.v.toFixed(1)}` : `${e.v.toFixed(1)}`, x, e.type.startsWith('H') ? y - 6 : y + 13);
  }
  // Now.
  const now = Date.now();
  if (now >= t0 && now <= t1) {
    ctx.strokeStyle = css.getPropertyValue('--accent').trim(); ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(X(now), T0); ctx.lineTo(X(now), T0 + ph); ctx.stroke(); ctx.setLineDash([]);
  }
}

function render(st, ex) {
  const unit = opts.metric() ? ' m' : ' ft', u = opts.metric() ? 'm' : 'ft';
  const now = Date.now(), h = heightAt(ex, now), hSoon = heightAt(ex, now + 15 * 60000);
  const next = ex.filter((e) => e.t > now);
  const nh = next.find((e) => e.type.startsWith('H')), nl = next.find((e) => e.type.startsWith('L'));
  const trend = Number.isNaN(h) ? '' : hSoon > h ? 'Rising' : 'Falling';
  $('tideNow').innerHTML = Number.isNaN(h) ? '' :
    `<strong>${trend}, ${h.toFixed(1)}${unit} now</strong>` +
    `${nh ? ` · high ${nh.v.toFixed(1)}${unit} at ${time(nh.t)}` : ''}${nl ? ` · low ${nl.v.toFixed(1)}${unit} at ${time(nl.t)}` : ''}`;
  drawChart(ex, u);
  // Table: today and the next two days.
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const rows = [];
  for (let d = 0; d < 3; d++) {
    const a = day0.getTime() + d * 86400000, b = a + 86400000;
    const list = ex.filter((e) => e.t >= a && e.t < b);
    rows.push(`<tr><th>${new Date(a).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</th><td>${
      list.map((e) => `<span class="${e.type.startsWith('H') ? 'hi' : 'lo'}">${e.type.startsWith('H') ? 'High' : 'Low'} ${time(e.t)} · ${e.v.toFixed(1)}${unit}</span>`).join('')}</td></tr>`);
  }
  $('tideTable').innerHTML = `<table>${rows.join('')}</table>`;
  $('tideMeta').textContent = `NOAA tide predictions for ${st.name}${st.state ? `, ${st.state}` : ''} (station ${st.id}${st.type === 'S' ? ', subordinate' : ''}), ` +
    `${Math.round(st.km * NM_PER_KM)} nm away. Heights above mean lower low water (MLLW); times are your phone's time. Predictions only: wind and pressure change actual water levels.`;
}

export async function showTides(loc) {
  if (!loc) return;
  const near = nearestStations(loc);
  $('tideStation').innerHTML = `<option value="auto">Nearest to ${opts.picked() ? 'this spot' : 'you'} (automatic)</option>` +
    near.map((s) => `<option value="${s.id}">${Math.round(s.km * NM_PER_KM)} nm · ${opts.esc(s.name)}${s.state ? `, ${s.state}` : ''}</option>`).join('');
  const chosen = choice !== 'auto' && TIDE_STATIONS.find((s) => s[0] === choice);
  $('tideStation').value = chosen ? choice : 'auto';
  if (chosen && !near.some((s) => s.id === choice)) {
    $('tideStation').insertAdjacentHTML('beforeend', `<option value="${choice}">${opts.esc(chosen[1])}</option>`);
    $('tideStation').value = choice;
  }
  const st = chosen
    ? { id: chosen[0], name: chosen[1], state: chosen[2], lat: chosen[3], lon: chosen[4], type: chosen[5], km: km(loc, { lat: chosen[3], lon: chosen[4] }) }
    : near[0];
  if (!chosen && st.km > 150) {
    $('tideNow').textContent = 'No NOAA tide station within about 80 nautical miles of this spot.';
    $('tideChart').hidden = true; $('tideTable').innerHTML = ''; $('tideMeta').textContent = '';
    return;
  }
  $('tideChart').hidden = false;
  current = { st, loc };
  try {
    const ex = await highsLows(st.id, opts.metric());
    if (current.st !== st) return;
    render(st, ex);
  } catch (e) {
    $('tideNow').textContent = `Tide predictions unavailable: ${e.message}`;
  }
}

export function initTides(o) {
  opts = o;
  choice = store.get('tideStation', 'auto');
  $('tideStation').addEventListener('change', (e) => {
    choice = e.target.value;
    store.set('tideStation', choice);
    if (current) showTides(current.loc);
  });
  window.addEventListener('resize', () => { if (current) showTides(current.loc); });
}
