import { advectField, velocity } from './nowcast.js';
import { toLatLon, toPixel } from './radar.js';
import { NEXRAD_SITES } from './data.js';
import { dopplerWinds } from './doppler.js';
import { fetchModel, describe } from './model.js';
import {
  P_ON, intensityWord, precipNoun, cap, radarCoverage, runRadar, blend, summarize,
} from './forecast.js';
import { initPush, reportLocation, pushEnabled } from './push.js';

const REFRESH_MS = 5 * 60000;

const $ = (id) => document.getElementById(id);

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const state = {
  gps: null,
  picked: null,
  units: store.get('units', 'us'),
  alerts: store.get('alerts', false),
  busy: false,
  lastRefresh: 0,
  lastAlert: null,
  result: null,
  frameIdx: 0,
  playing: null,
  arrows: store.get('arrows', true),
};

// ---------- formatting ----------

const metric = () => state.units === 'metric';
const fmtRate = (mm) => metric() ? `${mm.toFixed(mm < 10 ? 1 : 0)} mm/h` : `${(mm / 25.4).toFixed(2)} in/h`;
const fmtDist = (km) => metric() ? `${Math.round(km)} km` : `${Math.round(km * 0.621371)} mi`;
const fmtSpeed = (kmh) => metric() ? `${Math.round(kmh)} km/h` : `${Math.round(kmh * 0.621371)} mph`;
const fmtTemp = (c) => metric() ? `${Math.round(c)}°C` : `${Math.round(c * 9 / 5 + 32)}°F`;
const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtCoord = (p) =>
  `${Math.abs(p.lat).toFixed(3)}°${p.lat >= 0 ? 'N' : 'S'} ${Math.abs(p.lon).toFixed(3)}°${p.lon >= 0 ? 'E' : 'W'}`;
const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((deg % 360) + 360) % 360 / 45) % 8];

// ---------- location ----------

function getGps() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 120000 },
    );
  });
}

function urlLocation() {
  const q = new URLSearchParams(location.search);
  const lat = parseFloat(q.get('lat')), lon = parseFloat(q.get('lon'));
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

// Radar frames for the map: the last 30 minutes, then forecasts every 10 minutes.
function mapFrames(radar) {
  const { fields, now, mf } = radar;
  const frames = fields.filter((f) => f.time >= now.time - 30 * 60000)
    .map((f) => ({ time: new Date(f.time), rate: f.rate, forecast: false }));
  for (let lead = 10; lead <= 60; lead += 10) {
    frames.push({ time: new Date(now.time + lead * 60000), rate: advectField(now, mf, lead), forecast: true });
  }
  return frames;
}

async function refresh() {
  if (state.busy) return;
  const loc = state.picked || state.gps;
  if (!loc) {
    setStatus('Waiting for your location… or tap the map to choose a spot.');
    return;
  }
  state.busy = true;
  $('refreshBtn').classList.add('spin');
  setStatus('Updating…');
  try {
    const { site, quality } = radarCoverage(loc);
    const modelP = fetchModel(loc.lat, loc.lon).then((m) => m, () => null);
    let radar = null, radarErr = null;
    if (quality > 0) {
      try {
        radar = await runRadar(loc);
        radar.map = mapFrames(radar);
      } catch (e) { radarErr = e; }
    }
    const show = (model) => {
      const q = radar ? quality : 0;
      const series = blend(radar, model, q);
      const noun = precipNoun(model ? model.tempC : null);
      const summary = summarize(series, noun, radar && radar.echo === 0);
      state.result = { loc, radar, model, series, summary, site, quality: q, noun };
      state.lastRefresh = Date.now();
      render();
      return summary;
    };
    // Radar is usually ready first: show it, then fold in the model when it arrives.
    if (radar) show(null);
    const model = await modelP;
    if (!radar && !model) throw radarErr || new Error('No forecast data available');
    if (model) show(model);
    maybeAlert(state.result.summary, state.result.noun);
    if (!state.picked) reportLocation(state.gps);
  } catch (e) {
    setStatus(`Could not update: ${e.message}`);
  } finally {
    state.busy = false;
    $('refreshBtn').classList.remove('spin');
  }
}

// ---------- rendering ----------

function setStatus(t) { $('status').textContent = t; }

function render() {
  const r = state.result;
  if (!r) return;
  $('summary').textContent = r.summary.text;
  $('place').textContent = `${state.picked ? 'Selected point' : 'Your location'} · ${fmtCoord(r.loc)}`;
  $('gpsBtn').hidden = !state.picked;

  let src;
  if (!r.radar) {
    src = r.quality === 0 && r.site
      ? `Weather model only — no radar coverage here (nearest radar ${r.site.id} is ${fmtDist(r.site.km)} away)`
      : 'Weather model only — radar unavailable right now';
  } else if (r.quality < 1) {
    src = `Radar + weather model (edge of radar range, ${r.site.id} ${fmtDist(r.site.km)} away)`;
  } else {
    src = `Radar nowcast (${r.site.id}, ${fmtDist(r.site.km)} away)`;
  }
  $('source').textContent = src;

  const lines = [];
  if (r.model && r.model.tempC !== null) {
    const c = r.model.current;
    lines.push(['Temperature', `${fmtTemp(r.model.tempC)} (feels like ${fmtTemp(c.feels)}), humidity ${Math.round(c.humidity)}%`]);
    lines.push(['Wind', `From ${compass(c.windDir)} at ${fmtSpeed(c.wind)}, gusts ${fmtSpeed(c.gust)}`]);
  }
  const now = r.series[0];
  lines.push(['Right now', now.prob >= P_ON ? `${cap(intensityWord(now.intensity))} ${r.noun}, ${fmtRate(now.intensity)}` : `No ${r.noun}`]);
  if (r.radar) {
    const { vel, mf, grid } = r.radar;
    if (mf.count) {
      const kmh = Math.hypot(vel.u, vel.v) * grid.dx * 60;
      const toward = compass(Math.atan2(vel.u, -vel.v) * 180 / Math.PI);
      lines.push(['Storm motion (tracked)', kmh < 3 ? 'Nearly stationary' : `Toward ${toward} at ${fmtSpeed(kmh)}`]);
    } else {
      lines.push(['Storm motion', r.radar.echo ? 'Not enough rain nearby to track' : 'No rain on radar nearby']);
    }
    lines.push(['Doppler wind', '<span id="dopplerVal">Loading…</span>']);
    const age = Math.round(r.radar.age);
    lines.push(['Radar time', `${fmtTime(new Date(r.radar.now.time))} (${age} min ago)`]);
    const c = r.radar.check;
    if (c && c.events >= 15 && Number.isFinite(c.tracked)) {
      const pct = (x) => `${Math.round(x * 100)}%`;
      lines.push([`${c.lead}-min self-check`,
        `tracking matched ${pct(c.tracked)} of rain areas (standing still: ${pct(c.persistence)})`]);
    } else {
      lines.push(['Self-check', 'Not enough rain nearby in the last hour to score']);
    }
  }
  lines.push(['Updated', fmtTime(new Date(state.lastRefresh))]);
  $('details').innerHTML = lines.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  if (r.radar && r.radar.doppler) showDopplerDetail(r);
  setStatus('');

  drawChart(r.series, r.noun);
  renderOutlook(r.model);
  renderMap(r);
}

// ---------- hourly and 7-day ----------

// Wind arrow pointing the way the wind blows (direction is where it comes from).
const windArrow = (from) => `<span class="arrow" style="transform:rotate(${Math.round(from + 180)}deg)">↑</span>`;

function renderOutlook(model) {
  const hourly = $('hourly'), daily = $('daily');
  if (!model || !model.hours.length) {
    $('hourlyCard').hidden = $('dailyCard').hidden = !model;
    return;
  }
  $('hourlyCard').hidden = $('dailyCard').hidden = false;
  const tz = model.timezone;
  const hourFmt = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', timeZone: tz });
  const dayFmt = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short', timeZone: tz });
  const pop = (p) => (p !== null && p >= 10 ? `<span class="pop">${Math.round(p)}%</span>` : '<span class="pop"></span>');

  $('hourlyUnits').textContent = `· wind ${metric() ? 'km/h' : 'mph'}`;
  hourly.innerHTML = model.hours.map((h, i) => {
    const d = describe(h.code, h.day);
    return `<div class="hour" title="${d.label}">
      <span class="h-time">${i === 0 ? 'Now' : hourFmt(h.time)}</span>
      <span class="h-icon">${d.icon}</span>
      <span class="h-temp">${fmtTemp(h.temp)}</span>
      ${pop(h.pop)}
      <span class="h-wind">${windArrow(h.windDir)}${Math.round(metric() ? h.wind : h.wind * 0.621371)}</span>
    </div>`;
  }).join('');

  const lo = Math.min(...model.days.map((d) => d.lo)), hi = Math.max(...model.days.map((d) => d.hi));
  const span = Math.max(1, hi - lo);
  daily.innerHTML = model.days.map((d, i) => {
    const w = describe(d.code, true);
    const left = (d.lo - lo) / span * 100, width = Math.max(4, (d.hi - d.lo) / span * 100);
    return `<div class="day">
      <span class="d-name">${i === 0 ? 'Today' : dayFmt(d.time)}</span>
      <span class="d-icon" title="${w.label}">${w.icon}</span>
      ${pop(d.pop)}
      <span class="d-lo">${fmtTemp(d.lo)}</span>
      <span class="d-bar"><span style="left:${left}%;width:${width}%"></span></span>
      <span class="d-hi">${fmtTemp(d.hi)}</span>
      <span class="d-wind">${windArrow(d.windDir)}${fmtSpeed(d.wind)}<small> g${Math.round(metric() ? d.gust : d.gust * 0.621371)}</small></span>
      <span class="d-label">${w.label}${d.precip >= 0.25 ? ` · ${metric() ? `${d.precip.toFixed(1)} mm` : `${(d.precip / 25.4).toFixed(2)} in`}` : ''}</span>
    </div>`;
  }).join('');
}

function rateToHeight(mm) {
  // Light / moderate / heavy bands each take a third of the chart, log scale inside each.
  const stops = [[0.3, 0], [2.5, 1 / 3], [7.6, 2 / 3], [40, 1]];
  if (mm <= stops[0][0]) return 0;
  for (let i = 1; i < stops.length; i++) {
    const [r1, h1] = stops[i - 1], [r2, h2] = stops[i];
    if (mm <= r2) return h1 + (h2 - h1) * Math.log(mm / r1) / Math.log(r2 / r1);
  }
  return 1;
}

function drawChart(series) {
  const cv = $('chart');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const left = 54, right = 8, top = 8, bottom = 22;
  const pw = W - left - right, ph = H - top - bottom;
  const css = getComputedStyle(document.documentElement);
  const muted = css.getPropertyValue('--muted').trim();
  const grid = css.getPropertyValue('--border').trim();
  const bar = css.getPropertyValue('--rain').trim();

  ctx.font = '11px -apple-system, system-ui, sans-serif';
  ctx.fillStyle = muted; ctx.strokeStyle = grid; ctx.lineWidth = 1;
  [['Heavy', 1], ['Moderate', 2 / 3], ['Light', 1 / 3]].forEach(([label, h]) => {
    const y = top + ph * (1 - h);
    ctx.beginPath(); ctx.moveTo(left, y + 0.5); ctx.lineTo(left + pw, y + 0.5); ctx.stroke();
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText(label, left - 6, y + 2);
  });
  ctx.beginPath(); ctx.moveTo(left, top + ph + 0.5); ctx.lineTo(left + pw, top + ph + 0.5); ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let m = 0; m <= 60; m += 10) {
    ctx.fillText(m === 0 ? 'Now' : `${m}m`, left + pw * m / 60, top + ph + 6);
  }

  const bw = pw / 61;
  ctx.fillStyle = bar;
  series.forEach((s) => {
    if (s.prob < 0.05) return;
    const h = Math.max(2, rateToHeight(Math.max(s.intensity, 0.35)) * ph);
    ctx.globalAlpha = 0.25 + 0.75 * Math.min(1, s.prob);
    ctx.fillRect(left + s.m * bw + 0.5, top + ph - h, Math.max(1, bw - 1), h);
  });
  ctx.globalAlpha = 1;

  // Probability line
  ctx.strokeStyle = css.getPropertyValue('--accent').trim();
  ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
  ctx.beginPath();
  series.forEach((s, i) => {
    const x = left + (s.m + 0.5) * bw, y = top + ph * (1 - s.prob);
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  });
  ctx.stroke(); ctx.setLineDash([]);
}

// ---------- map ----------

let map, overlay, userMarker, trackLine, arrowLayer, dopplerLayer;

const ARROW_STEP_KM = 36;      // spacing of the motion arrows
const ARROW_MINUTES = 15;      // arrow length = distance moved in this many minutes

// An arrow centred on grid point (x, y) for a motion of (u east, v south) pixels per minute,
// as [shaft, head] polylines in lat/lon.
function arrowAt(grid, x, y, u, v) {
  const ll = (px, py) => { const p = toLatLon(grid, px, py); return [p.lat, p.lon]; };
  const dx = u * ARROW_MINUTES / 2, dy = v * ARROW_MINUTES / 2;
  const hx = x + dx, hy = y + dy, len = Math.hypot(dx, dy) * 2;
  const head = Math.min(len * 0.35, 8 / grid.dx), ang = Math.atan2(dy, dx);
  const wing = (a) => ll(hx - head * Math.cos(ang + a), hy - head * Math.sin(ang + a));
  return [[ll(x - dx, y - dy), ll(hx, hy)], [wing(0.45), ll(hx, hy), wing(-0.45)]];
}

// Storm-motion arrows from the tracked motion field, only where rain was actually tracked
// and there is rain nearby now. Each arrow shows the distance moved in 15 minutes.
function motionArrows(radar) {
  const { grid, mf, now } = radar;
  const lines = [];
  if (!mf.count) return lines;
  const step = Math.round(ARROW_STEP_KM / grid.dx), near = Math.round(14 / grid.dx);
  for (let y = step / 2; y < grid.h; y += step) {
    for (let x = step / 2; x < grid.w; x += step) {
      const ni = Math.round(y / mf.step) * mf.gw + Math.round(x / mf.step);
      if (!(mf.S[ni] > 0.3)) continue;
      let rain = false;
      for (let yy = Math.max(0, y - near); yy < Math.min(grid.h, y + near) && !rain; yy += 2) {
        for (let xx = Math.max(0, x - near); xx < Math.min(grid.w, x + near); xx += 2) {
          if (now.rate[Math.floor(yy) * grid.w + Math.floor(xx)] > 0) { rain = true; break; }
        }
      }
      if (!rain) continue;
      const v = velocity(mf, x, y);
      if (Math.hypot(v.u, v.v) * grid.dx * 60 < 5) continue;   // nearly stationary
      lines.push(...arrowAt(grid, x, y, v.u, v.v));
    }
  }
  return lines;
}

// Doppler wind arrows (teal) at each radar site on the map, from the radar's own VAD wind
// profile, drawn to the same scale as the white tracking arrows.
const KMH_PER_MS = 3.6;
let dopplerFor = null;

async function loadDoppler(r) {
  const radar = r.radar;
  dopplerFor = radar;
  radar.doppler = null;
  const g = radar.grid, margin = 30 / g.dx;
  const sites = NEXRAD_SITES.filter(([, lat, lon]) => {
    const p = toPixel(g, lat, lon);
    return p.x > -margin && p.y > -margin && p.x < g.w + margin && p.y < g.h + margin;
  });
  const winds = await dopplerWinds(sites);
  if (dopplerFor !== radar) return;   // a newer forecast replaced this one
  radar.doppler = winds;
  drawDoppler(radar);
  showDopplerDetail(r);
}

function drawDoppler(radar) {
  if (dopplerLayer) { dopplerLayer.remove(); dopplerLayer = null; }
  if (!radar || !radar.doppler || !state.arrows) return;
  const g = radar.grid, perMin = 60 / 1000 / g.dx;   // m/s -> grid pixels per minute
  const layers = [];
  for (const w of radar.doppler) {
    const p = toPixel(g, w.lat, w.lon);
    const lines = arrowAt(g, p.x, p.y, w.u * perMin, -w.v * perMin);
    const tip = `${w.id} Doppler wind, 10,000–20,000 ft: toward ${compass(Math.atan2(w.u, w.v) * 180 / Math.PI)} at ${fmtSpeed(Math.hypot(w.u, w.v) * KMH_PER_MS)}`;
    layers.push(
      L.polyline(lines, { color: '#0a1220', weight: 5, opacity: 0.5, interactive: false }),
      L.polyline(lines, { color: '#3ee6c1', weight: 2.5, opacity: 1 }).bindTooltip(tip),
      L.circleMarker([w.lat, w.lon], { radius: 4, color: '#0a1220', weight: 1, fillColor: '#3ee6c1', fillOpacity: 1 }).bindTooltip(tip),
    );
  }
  dopplerLayer = L.layerGroup(layers).addTo(map);
}

function showDopplerDetail(r) {
  const el = $('dopplerVal');
  if (!el) return;
  const ws = r.radar.doppler || [];
  if (!ws.length) { el.textContent = 'No recent wind profile from nearby radars'; return; }
  const near = ws.map((w) => ({ w, d: Math.hypot(w.lat - r.loc.lat, (w.lon - r.loc.lon) * Math.cos(r.loc.lat * Math.PI / 180)) }))
    .sort((a, b) => a.d - b.d)[0].w;
  el.textContent = `Toward ${compass(Math.atan2(near.u, near.v) * 180 / Math.PI)} at ${fmtSpeed(Math.hypot(near.u, near.v) * KMH_PER_MS)} (${near.id} radar, 10,000–20,000 ft)`;
}

function drawArrows(radar) {
  if (arrowLayer) { arrowLayer.remove(); arrowLayer = null; }
  $('arrowBtn').classList.toggle('on', state.arrows);
  drawDoppler(radar);
  if (!radar || !state.arrows) return;
  const lines = motionArrows(radar);
  if (!lines.length) return;
  arrowLayer = L.layerGroup([
    L.polyline(lines, { color: '#0a1220', weight: 3.5, opacity: 0.45, interactive: false }),
    L.polyline(lines, { color: '#f4f8ff', weight: 1.6, opacity: 0.95, interactive: false }),
  ]).addTo(map);
}

const RAIN_COLORS = [
  [0.3, [90, 150, 255, 0.35]], [1, [60, 120, 250, 0.6]], [2.5, [40, 90, 230, 0.75]],
  [7.6, [250, 205, 40, 0.85]], [20, [240, 70, 40, 0.9]], [60, [200, 30, 190, 0.95]],
];

function rainColor(mm) {
  if (mm < RAIN_COLORS[0][0]) return null;
  for (let i = 1; i < RAIN_COLORS.length; i++) {
    const [r1, c1] = RAIN_COLORS[i - 1], [r2, c2] = RAIN_COLORS[i];
    if (mm <= r2) {
      const t = Math.log(mm / r1) / Math.log(r2 / r1);
      return c1.map((v, k) => v + (c2[k] - v) * t);
    }
  }
  return RAIN_COLORS[RAIN_COLORS.length - 1][1];
}

function frameImage(rate, w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < rate.length; i++) {
    const c = rainColor(rate[i]);
    if (!c) continue;
    img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2];
    img.data[i * 4 + 3] = Math.round(c[3] * 255);
  }
  ctx.putImageData(img, 0, 0);
  return cv.toDataURL();
}

function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView([30, -90], 7);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 16, attribution: 'Basemap &copy; Esri',
  }).addTo(map);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 16, pane: 'shadowPane',
  }).addTo(map);
  map.attributionControl.addAttribution('Radar: NOAA NEXRAD via Iowa Environmental Mesonet');
  map.on('click', (e) => {
    state.picked = { lat: e.latlng.lat, lon: e.latlng.lng };
    refresh();
  });
}

function renderMap(r) {
  const loc = r.loc;
  if (!userMarker) {
    userMarker = L.circleMarker([loc.lat, loc.lon], {
      radius: 7, color: '#fff', weight: 2, fillColor: '#ff9f1c', fillOpacity: 1,
    }).addTo(map);
  } else {
    userMarker.setLatLng([loc.lat, loc.lon]);
  }
  if (!state.mapCentred || state.mapCentredOn !== `${loc.lat},${loc.lon}`) {
    if (!state.mapCentred) map.setView([loc.lat, loc.lon], 8);
    state.mapCentred = true;
    state.mapCentredOn = `${loc.lat},${loc.lon}`;
  }
  if (trackLine) { trackLine.remove(); trackLine = null; }
  stopPlay();
  drawArrows(r.radar);
  const bar = $('mapBar');
  if (!r.radar) {
    if (overlay) { overlay.remove(); overlay = null; }
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const { grid, map: frames, pf, mf } = r.radar;
  if (mf.count) {
    const pts = [];
    for (let t = 0; t < pf.traj.xs.length; t += 5) {
      const p = toLatLon(grid, pf.traj.xs[t], pf.traj.ys[t]);
      pts.push([p.lat, p.lon]);
    }
    trackLine = L.polyline(pts, { color: '#ff9f1c', weight: 2, dashArray: '4 6', opacity: 0.9 }).addTo(map);
  }
  if (dopplerFor !== r.radar) loadDoppler(r);
  r.radar.images = frames.map((f) => frameImage(f.rate, grid.w, grid.h));
  const nowIdx = frames.findIndex((f) => f.forecast) - 1;
  const slider = $('frameSlider');
  slider.max = frames.length - 1;
  slider.value = nowIdx;
  if (overlay) overlay.remove();
  overlay = L.imageOverlay(r.radar.images[nowIdx], grid.bounds, { opacity: 0.85, className: 'radar-img' }).addTo(map);
  showFrame(nowIdx);
}

function showFrame(i) {
  const r = state.result;
  if (!r || !r.radar || !overlay) return;
  const f = r.radar.map[i];
  overlay.setUrl(r.radar.images[i]);
  $('frameSlider').value = i;
  const mins = Math.round((f.time - r.radar.now.time) / 60000);
  $('frameLabel').textContent = `${fmtTime(f.time)} · ${mins === 0 ? 'now' : mins < 0 ? `${-mins} min ago` : `forecast +${mins} min`}`;
  $('frameLabel').classList.toggle('fc', f.forecast);
  state.frameIdx = i;
}

function stopPlay() {
  if (state.playing) clearInterval(state.playing);
  state.playing = null;
  $('playBtn').textContent = '▶';
}

function togglePlay() {
  if (state.playing) return stopPlay();
  const r = state.result;
  if (!r || !r.radar) return;
  $('playBtn').textContent = '❚❚';
  state.playing = setInterval(() => {
    showFrame((state.frameIdx + 1) % r.radar.map.length);
  }, 600);
}

// ---------- alerts ----------

function maybeAlert(summary, noun) {
  // With closed-app alerts on, the server sends them; don't double up.
  if (!state.alerts || pushEnabled()) return;
  const soon = summary.raining || (summary.start !== null && summary.start <= 15);
  if (!soon) { state.lastAlert = null; return; }
  if (state.lastAlert) return;
  state.lastAlert = Date.now();
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const title = `${cap(noun)} nearby`;
  const opts = { body: summary.text, icon: 'icons/icon-192.png', tag: 'nexthour' };
  // iPhone home-screen apps can only notify through the service worker.
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, opts)).catch(() => {});
  } else {
    try { new Notification(title, opts); } catch { /* not allowed outside a service worker */ }
  }
}

async function setAlerts(on) {
  state.alerts = on;
  store.set('alerts', on);
  if (on && 'Notification' in window && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch { /* ignore */ }
  }
}

// ---------- startup ----------

async function locate() {
  setStatus('Finding your location…');
  const gps = await getGps();
  if (gps) state.gps = gps;
  else if (!state.gps) state.gps = store.get('lastLoc', null);
  if (gps) store.set('lastLoc', gps);
  if (!state.gps && !state.picked) setStatus('Location unavailable. Tap the map to choose a spot.');
}

function bindUi() {
  $('refreshBtn').addEventListener('click', async () => {
    if (!state.picked) await locate();
    refresh();
  });
  $('gpsBtn').addEventListener('click', async () => {
    state.picked = null;
    state.mapCentred = false;
    await locate();
    refresh();
  });
  $('frameSlider').addEventListener('input', (e) => { stopPlay(); showFrame(+e.target.value); });
  $('playBtn').addEventListener('click', togglePlay);
  $('arrowBtn').addEventListener('click', () => {
    state.arrows = !state.arrows;
    store.set('arrows', state.arrows);
    drawArrows(state.result && state.result.radar);
  });
  $('settingsBtn').addEventListener('click', () => { $('settings').hidden = !$('settings').hidden; });
  $('units').value = state.units;
  $('units').addEventListener('change', (e) => { state.units = e.target.value; store.set('units', state.units); render(); });
  $('alerts').checked = state.alerts;
  $('alerts').addEventListener('change', (e) => setAlerts(e.target.checked));
  window.addEventListener('resize', () => state.result && drawChart(state.result.series));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - state.lastRefresh > 3 * 60000) refresh();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible' && Date.now() - state.lastRefresh > REFRESH_MS) refresh();
  }, 30000);
}

async function main() {
  bindUi();
  initPush(() => state.picked || state.gps);
  initMap();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  const fromUrl = urlLocation();
  if (fromUrl) state.picked = fromUrl;
  else await locate();
  refresh();
}

main();
