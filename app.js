import { advectField, velocity } from './nowcast.js';
import { toLatLon, toPixel, velocityImage } from './radar.js';
import { NEXRAD_SITES } from './data.js';
import { dopplerWinds } from './doppler.js';
import { activeStorms, category, threatTo, threatText, WARNING_NAMES } from './storms.js';
import { SURGE_CLASSES, riskExport, liveExport, surgeRiskAt, riskSummary } from './surge.js';
import { tropicalOutlook, RISK_COLORS } from './outlook.js';
import { zonesByDistance, zoneFor, marineForecast, zoneGeometry } from './marine.js';
import { fetchModel, describe } from './model.js';
import {
  P_ON, intensityWord, precipNoun, cap, radarCoverage, runRadar, blend, summarize,
} from './forecast.js';
import { initPush, reportLocation, pushEnabled, syncMarine, syncWaterTemp, alertServerUrl } from './push.js';
import { secondOpinion } from './compare.js';
import { initPassage, passageUnitsChanged, passageShown } from './passage.js';

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
  velocity: false,
  stormMap: store.get('stormMap', true),
  storms: [],
  surge: store.get('surge', ''),
  marineZone: store.get('marineZone', 'auto'),
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
    loadStorms();
    loadOutlook();
    loadMarine(loc);
    if (state.tab === 'seas') { loadTides(loc); loadWaterTemp(loc); }
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
  $('place').textContent = `${state.picked ? state.picked.name || 'Selected point' : 'Your location'} · ${fmtCoord(r.loc)}`;
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
  if (r.surgeRisk) {
    const sr = riskSummary(r.surgeRisk);
    if (sr) lines.push(['Storm surge risk (NHC)', sr]);
  }
  lines.push(['Updated', fmtTime(new Date(state.lastRefresh))]);
  $('details').innerHTML = lines.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  if (r.radar && r.radar.doppler) showDopplerDetail(r);
  setStatus('');

  drawChart(r.series, r.noun);
  renderOutlook(r.model);
  loadSurgeRisk(r);
  if (r.second) renderSecondOpinion(r); else loadSecondOpinion(r);
  if (state.storms.length) renderStorms();
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

let map, overlay, userMarker, trackLine, arrowLayer, dopplerLayer, velLayer, stormLayer;

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
      L.polyline(lines, { pane: 'tabLocal', color: '#0a1220', weight: 5, opacity: 0.5, interactive: false }),
      L.polyline(lines, { pane: 'tabLocal', color: '#3ee6c1', weight: 2.5, opacity: 1 }).bindTooltip(tip),
      L.circleMarker([w.lat, w.lon], { pane: 'tabLocal', radius: 4, color: '#0a1220', weight: 1, fillColor: '#3ee6c1', fillOpacity: 1 }).bindTooltip(tip),
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
    L.polyline(lines, { pane: 'tabLocal', color: '#0a1220', weight: 3.5, opacity: 0.45, interactive: false }),
    L.polyline(lines, { pane: 'tabLocal', color: '#f4f8ff', weight: 1.6, opacity: 0.95, interactive: false }),
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
  map.createPane('surge').style.zIndex = 350;   // Hurricanes tab: storm surge, under the storm drawing
  map.createPane('tabSeas').style.zIndex = 350;
  map.createPane('tabLocal').style.zIndex = 400;
  map.createPane('tabStorms').style.zIndex = 420;
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 16, attribution: 'Basemap &copy; Esri',
  }).addTo(map);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 16, pane: 'shadowPane',
  }).addTo(map);
  map.attributionControl.addAttribution('Radar: NOAA NEXRAD via Iowa Environmental Mesonet');
  map.on('click', (e) => {
    if (state.tab !== 'local') return;   // on other tabs taps are for the map's own details
    state.picked = { lat: e.latlng.lat, lon: e.latlng.lng };
    store.set('activePlace', null);
    renderPlaceBar();
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
    if (!state.mapCentred && state.tab === 'local') map.setView([loc.lat, loc.lon], 8);
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
    trackLine = L.polyline(pts, { pane: 'tabLocal', color: '#ff9f1c', weight: 2, dashArray: '4 6', opacity: 0.9 }).addTo(map);
  }
  if (dopplerFor !== r.radar) loadDoppler(r);
  r.radar.images = frames.map((f) => frameImage(f.rate, grid.w, grid.h));
  const nowIdx = frames.findIndex((f) => f.forecast) - 1;
  const slider = $('frameSlider');
  slider.max = frames.length - 1;
  slider.value = nowIdx;
  if (overlay) overlay.remove();
  overlay = L.imageOverlay(r.radar.images[nowIdx], grid.bounds, { pane: 'tabLocal', opacity: 0.85, className: 'radar-img' }).addTo(map);
  state.frameIdx = nowIdx;
  showFrame(nowIdx);
  drawVelocity();
}

// Doppler velocity mode: the nearest radar's red/green radial-velocity image replaces the
// rain layer (the loop and slider pause while it is shown).
function drawVelocity() {
  const r = state.result;
  if (velLayer) { velLayer.remove(); velLayer = null; }
  $('velBtn').classList.toggle('on', state.velocity);
  $('velLegend').hidden = !state.velocity;
  const rainShown = !state.velocity;
  if (overlay) overlay.setOpacity(rainShown ? 0.85 : 0);
  $('frameSlider').disabled = !rainShown;
  $('playBtn').disabled = !rainShown;
  if (!r || !r.site) return;
  if (!state.velocity) { if (r.radar) showFrame(state.frameIdx); return; }
  stopPlay();
  const site = r.site;
  const [, slat, slon] = NEXRAD_SITES.find(([id]) => id === site.id) || [];
  if (slat === undefined) return;
  const img = velocityImage(site.id, slat, slon);
  velLayer = L.imageOverlay(img.url, img.bounds, { pane: 'tabLocal', opacity: 0.8, className: 'radar-img' }).addTo(map);
  velLayer.on('error', () => { $('frameLabel').textContent = `${site.id} velocity unavailable`; });
  $('frameLabel').textContent = `${site.id} Doppler velocity · latest scan`;
  $('frameLabel').classList.remove('fc');
  $('velSite').textContent = site.id;
}

function showFrame(i) {
  const r = state.result;
  if (!r || !r.radar || !overlay || state.velocity) return;
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

// ---------- Navy (FNMOC) waves on the map + second-opinion card ----------

let navyMeta = null, wavesImg = null, wavesArrows = null;
const WAVE_KEY = [[0, '#285ac8'], [2, '#3c96e6'], [4, '#28c8c8'], [6, '#5ad25a'], [8, '#f0dc3c'], [12, '#fa8c28'], [16, '#e63228'], [25, '#be28be']];

async function loadNavyMeta() {
  const server = alertServerUrl();
  if (!server) throw new Error('No alert server');
  const resp = await fetch(`${server}/api/navy/meta`);
  const j = await resp.json();
  if (!resp.ok) throw new Error(j.error || 'Navy data unavailable');
  navyMeta = j;
  return j;
}

async function setWaves(on) {
  if (wavesImg) { wavesImg.remove(); wavesImg = null; }
  if (wavesArrows) { wavesArrows.remove(); wavesArrows = null; }
  $('wavesCtl').hidden = $('wavesLegend').hidden = !on;
  if (!on) return;
  try {
    const m = await loadNavyMeta();
    const base = Date.parse(m.base);
    const slider = $('wavesSlider');
    slider.max = m.steps.length - 1;
    let now = 0;
    m.steps.forEach((h, i) => { if (base + h * 3600000 <= Date.now()) now = i; });
    slider.value = now;
    $('wavesLegend').innerHTML = WAVE_KEY.map(([ft, c], i) =>
      `<span><i style="background:${c}"></i>${metric() ? `${Math.round(ft * 0.3048 * 10) / 10}` : ft}${i === WAVE_KEY.length - 1 ? '+' : ''}</span>`).join('') +
      `<span>${metric() ? 'm' : 'ft'} · Navy WAVEWATCH III</span>`;
    showWaveStep(now);
  } catch (e) {
    $('wavesCtl').hidden = false;
    $('wavesLabel').textContent = `Navy waves unavailable: ${e.message}`;
  }
}

async function showWaveStep(i) {
  const m = navyMeta;
  if (!m) return;
  const h = m.steps[i], hh = String(h).padStart(3, '0');
  const files = `${alertServerUrl()}/api/navy/files/${m.cycle}`;
  if (!wavesImg) {
    wavesImg = L.imageOverlay(`${files}/waves_${hh}.png`, m.bounds, { pane: 'tabSeas', opacity: 0.8, interactive: false }).addTo(map);
  } else {
    wavesImg.setUrl(`${files}/waves_${hh}.png`);
  }
  const t = new Date(Date.parse(m.base) + h * 3600000);
  $('wavesLabel').textContent = `${t.toLocaleString([], { weekday: 'short', hour: 'numeric' })}`;
  try {
    const pts = await (await fetch(`${files}/arrows_${hh}.json`)).json();
    if (navyMeta !== m || +$('wavesSlider').value !== i) return;
    if (wavesArrows) wavesArrows.remove();
    // Arrows point the way the waves travel (the data gives where they come from).
    const lines = [];
    for (const [lat, lon, , from] of pts) {
      const to = (from + 180) * Math.PI / 180, len = 0.6, k = Math.cos(lat * Math.PI / 180);
      const dy = Math.cos(to) * len / 2, dx = Math.sin(to) * len / 2 / k;
      const head = [lat + dy, lon + dx];
      const wing = (a) => [head[0] - Math.cos(to + a) * len * 0.3, head[1] - Math.sin(to + a) * len * 0.3 / k];
      lines.push([[lat - dy, lon - dx], head], [wing(0.5), head, wing(-0.5)]);
    }
    wavesArrows = L.layerGroup([
      L.polyline(lines, { pane: 'tabSeas', color: '#0a1220', weight: 3, opacity: 0.4, interactive: false }),
      L.polyline(lines, { pane: 'tabSeas', color: '#ffffff', weight: 1.2, opacity: 0.85, interactive: false }),
    ]).addTo(map);
  } catch { /* arrows are optional */ }
}

const cToF = (c) => c * 9 / 5 + 32;
const fmtT = (c) => `${Math.round(metric() ? c : cToF(c))}°`;
const fmtRain = (mm) => (mm === null || mm === undefined ? '—' : metric() ? `${mm.toFixed(mm < 10 ? 1 : 0)}` : (mm / 25.4).toFixed(2));
const fmtWindN = (kmh) => (kmh === null || kmh === undefined ? '—' : `${Math.round(metric() ? kmh : kmh * 0.621371)}`);
const fmtWave = (m) => (m === null || m === undefined ? '—' : metric() ? m.toFixed(1) : `${Math.round(m * 3.28084)}`);

async function loadSecondOpinion(r) {
  const card = $('secondCard');
  const server = alertServerUrl();
  if (!server) { card.hidden = true; return; }
  if (r.second !== undefined) return;
  r.second = null;
  try {
    r.second = await secondOpinion(server, r.loc.lat, r.loc.lon);
  } catch (e) {
    r.second = { error: e.message };
  }
  if (state.result === r) renderSecondOpinion(r);
}

function renderSecondOpinion(r) {
  const card = $('secondCard'), s = r.second;
  if (!s) return;
  card.hidden = false;
  if (s.error || !s.rows.length) {
    $('secondBody').innerHTML = `<p class="note">${esc(s.error ? (/outside/i.test(s.error) ? 'This spot is outside the Navy forecast area (0–60°N, 130–50°W).' : `Navy forecast unavailable: ${s.error}`) : 'No overlapping days yet.')}</p>`;
    $('secondNote').textContent = '';
    return;
  }
  const names = { hi: 'high', lo: 'low', rain: metric() ? 'rain' : 'rain', wind: 'wind', wave: 'waves' };
  const flagged = s.rows.filter((x) => x.flags.length);
  const dayName = (d) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short' });
  const summary = flagged.length
    ? `The models disagree on ${flagged.map((x) => `${dayName(x.date)} (${x.flags.map((f) => names[f]).join(', ')})`).join('; ')} — lower confidence there.`
    : 'NOAA and the Navy agree closely for the next few days — higher confidence in the forecast.';
  const cell = (row, k, fmt) => `<td class="${row.flags.includes(k) ? 'flag' : ''}">${fmt(row.noaa[k])}<small>${fmt(row.navy[k])}</small></td>`;
  const temp = (v) => (v === null || v === undefined ? '—' : fmtT(v));
  $('secondBody').innerHTML = `<p class="summary">${esc(summary)}</p>
    <table><thead><tr><th>Day</th><th>High</th><th>Low</th><th>Rain ${metric() ? 'mm' : 'in'}</th><th>Wind ${metric() ? 'km/h' : 'mph'}</th>${s.coastal ? `<th>Waves ${metric() ? 'm' : 'ft'}</th>` : ''}</tr></thead>
    <tbody>${s.rows.map((row) => `<tr><td>${dayName(row.date)}<small>NOAA / Navy</small></td>
      ${cell(row, 'hi', temp)}${cell(row, 'lo', temp)}${cell(row, 'rain', fmtRain)}${cell(row, 'wind', fmtWindN)}${s.coastal ? cell(row, 'wave', fmtWave) : ''}</tr>`).join('')}</tbody></table>
    <p class="key">Top: NOAA (GFS${s.coastal ? ', GFS-Wave' : ''}). Below: Navy (NAVGEM${s.coastal ? ', WAVEWATCH III' : ''}). Orange = the two disagree. Wind is the day's strongest sustained wind.</p>`;
  $('secondNote').textContent = `Navy run ${new Date(s.navyRun).toLocaleString([], { weekday: 'short', hour: 'numeric' })}. Navy highs and lows come from 3- to 6-hourly values, so they can run slightly milder than NOAA's.`;
}

// ---------- marine forecast (Gulf and Atlantic) ----------

let marineLayer = null, marineLoc = null, marineZoneShown = null;
const NM_PER_KM = 0.539957;

// Advisory colours, roughly following NWS hazard colours.
function alertColor(event) {
  if (/hurricane|typhoon/i.test(event)) return '#ff6060';
  if (/storm|gale|special marine/i.test(event)) return '#ff9a3d';
  if (/small craft|hazardous seas|brisk/i.test(event)) return '#ffd34d';
  return '#9fd3ff';
}

function fillZoneOptions(loc) {
  const sel = $('marineZone');
  const zones = zonesByDistance(loc);
  sel.innerHTML = `<option value="auto">Nearest to ${state.picked ? 'this spot' : 'you'} (automatic)</option>` +
    zones.map((z) => `<option value="${z.id}">${loc ? `${Math.round(z.km * NM_PER_KM)} nm · ` : ''}${esc(z.name)} (${z.id})</option>`).join('');
  sel.value = state.marineZone;
  if (sel.value !== state.marineZone) { state.marineZone = 'auto'; sel.value = 'auto'; }
}

async function loadMarine(loc) {
  marineLoc = loc;
  fillZoneOptions(loc);
  const body = $('marineBody');
  try {
    const zone = state.marineZone === 'auto' ? await zoneFor(loc) : state.marineZone;
    const f = await marineForecast(zone);
    if (marineLoc !== loc) return;   // a newer location took over
    marineZoneShown = zone;
    $('marineAlerts').innerHTML = f.alerts.map((a) =>
      `<span style="background:${alertColor(a.event)}" title="${esc(a.headline || '')}">${esc(a.event)}</span>`).join('');
    // Far from any NWS zone (e.g. Bermuda), say so; Bermuda's own waters are the Bermuda Weather Service's.
    const nearestNm = zonesByDistance(loc)[0].km * NM_PER_KM;
    const nearBermuda = Math.hypot(loc.lat - 32.3, (loc.lon + 64.8) * Math.cos(32.3 * Math.PI / 180)) * 60 < 150;
    const farNote = state.marineZone === 'auto' && nearestNm > 60
      ? `<p class="note">No NWS marine zone covers this spot; showing the nearest, ${Math.round(nearestNm)} nm away.${nearBermuda
        ? ' For Bermuda\'s local waters see the <a href="https://www.weather.bm/" target="_blank" rel="noopener">Bermuda Weather Service</a>.' : ''}</p>`
      : '';
    body.innerHTML = `${farNote}<p><strong>${esc(f.name)}</strong></p>` + (f.periods.slice(0, 6).map((p) => `
      <div class="marine-period">
        <h4>${esc(p.name)}</h4>
        ${p.wind ? `<p><span class="lbl">Wind</span> ${esc(p.wind)}</p>` : ''}
        ${p.seas ? `<p><span class="lbl">Seas</span> ${esc(p.seas)}</p>` : ''}
        ${p.water ? `<p><span class="lbl">Bays</span> ${esc(p.water.replace(/^Bay and inland waters\s*/i, ''))}</p>` : ''}
        <p class="full" hidden>${esc(p.text)}</p>
      </div>`).join('') || '<p class="note">No forecast available for this zone right now.</p>');
    const upd = f.updated ? new Date(f.updated) : null;
    $('marineMeta').textContent = `${f.source ? `${f.source}, zone` : 'NWS zone'} ${zone}${upd ? ` · updated ${upd.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''} · tap a period for the full text ·`;
    if (marineLayer) showMarineZone(false);
  } catch (e) {
    body.innerHTML = `<p class="note">Marine forecast unavailable: ${esc(e.message)}</p>`;
  }
}

async function showMarineZone(fit = true) {
  if (!marineZoneShown) return;
  try {
    const g = await zoneGeometry(marineZoneShown);
    if (marineLayer) marineLayer.remove();
    marineLayer = L.geoJSON(g, { pane: 'tabSeas', interactive: false, style: { color: '#3ee6c1', weight: 2, fillColor: '#3ee6c1', fillOpacity: 0.08 } }).addTo(map);
    if (fit) {
      map.fitBounds(marineLayer.getBounds().pad(0.15));
      $('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } catch { /* outline unavailable: nothing to draw */ }
}

// ---------- storm surge ----------

let surgeOverlays = [], surgeUpdate = null, surgeToken = 0;
const BLANK_IMG = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

// Map images from an ArcGIS export, redrawn for the current view after each pan or zoom.
async function setSurge(value) {
  const token = ++surgeToken;
  surgeOverlays.forEach((o) => o.remove());
  surgeOverlays = [];
  if (surgeUpdate) { map.off('moveend', surgeUpdate); surgeUpdate = null; }
  $('surgeLegend').hidden = $('surgeNote').hidden = !value;
  if (!value) return;
  let build, note;
  try {
    if (value.startsWith('live:')) {
      const bin = value.slice(5);
      const s = state.storms.find((x) => x.bin === bin);
      const b = await liveExport(bin);
      build = b && ((...a) => b(...a));
      note = `NHC's potential storm surge flooding for ${s ? esc(s.title) : bin}: a reasonable worst case (about a 1-in-10 chance of being exceeded), with the peak surge ranges NHC gives for each stretch of coast. NHC publishes this only when storm surge watches or warnings are in effect for the US.`;
    } else {
      const b = await riskExport(+value);
      build = (...a) => [b(...a)];
      note = `Planning map, not a forecast: the worst flooding NHC expects anywhere here if a Category ${value} hurricane hits. Depth is above ground. Leveed areas are not shown.`;
    }
  } catch {
    note = 'Storm surge map unavailable right now.';
  }
  if (token !== surgeToken) return;
  $('surgeNote').innerHTML = note;
  $('surgeLegend').innerHTML = SURGE_CLASSES.map((c) => `<span><i style="background:${c.color}"></i>${c.label}</span>`).join('');
  if (!build) return;
  surgeUpdate = () => {
    const b = map.getBounds(), size = map.getSize(), k = Math.min(2, window.devicePixelRatio || 1);
    const sw = L.CRS.EPSG3857.project(b.getSouthWest()), ne = L.CRS.EPSG3857.project(b.getNorthEast());
    const urls = build(sw.x, sw.y, ne.x, ne.y, Math.round(size.x * k), Math.round(size.y * k));
    while (surgeOverlays.length < urls.length) {
      surgeOverlays.push(L.imageOverlay(BLANK_IMG, b, { pane: 'surge', opacity: 0.75, interactive: false }).addTo(map));
    }
    urls.forEach((u, i) => { surgeOverlays[i].setBounds(b); surgeOverlays[i].setUrl(u); });
  };
  map.on('moveend', surgeUpdate);
  surgeUpdate();
}

// Live surge options for active Atlantic storms.
function updateSurgeOptions() {
  const sel = $('surgeSel');
  [...sel.querySelectorAll('option[value^="live:"]')].forEach((o) => o.remove());
  for (const s of state.storms.filter((x) => /^AT/.test(x.bin))) {
    const o = document.createElement('option');
    o.value = `live:${s.bin}`;
    o.textContent = `Live forecast: ${s.title}`;
    sel.appendChild(o);
  }
  if (state.surge && ![...sel.options].some((o) => o.value === state.surge)) state.surge = '';
  sel.value = state.surge;
}

// NHC planning-map surge risk at the forecast location, shown in the details.
async function loadSurgeRisk(r) {
  if (r.surgeRisk !== undefined) return;
  r.surgeRisk = null;
  try {
    r.surgeRisk = await surgeRiskAt(r.loc.lat, r.loc.lon);
  } catch {
    return;
  }
  if (state.result === r) render();
}

// ---------- NHC tropical weather outlook ----------

let outlookLayer = null;

async function loadOutlook() {
  try {
    state.outlook = await tropicalOutlook();
  } catch (e) {
    $('outlookBody').innerHTML = `<p class="note">Outlook unavailable: ${esc(e.message)}</p>`;
    return;
  }
  renderOutlookCard();
  drawOutlookLayers();
}

function renderOutlookCard() {
  const o = state.outlook;
  if (!o) return;
  const riskBadge = (r) => (RISK_COLORS[r] ? `<span class="risk" style="background:${RISK_COLORS[r]}">${esc(r)}</span>` : '');
  if (!o.text) {
    $('outlookBody').innerHTML = '<p class="note">The outlook text is unavailable right now.</p>';
  } else {
    $('outlookBody').innerHTML = o.text.paras.map((p) => {
      const m = p.match(/^\* Formation chance through (48 hours|7 days)\.\.\.(\w+)\.\.\.(.+?)\.?$/i);
      if (m) {
        return `<span class="chance">${m[1] === '48 hours' ? '2-day' : '7-day'} chance: ${esc(m[3].replace(/^near /, '').trim())}${riskBadge(m[2][0].toUpperCase() + m[2].slice(1).toLowerCase())}</span>`;
      }
      if (/formation is not expected/i.test(p)) return `<p class="none">${esc(p)}</p>`;
      if (/:$/.test(p) && p.length < 70) return `<p><strong>${esc(p)}</strong></p>`;
      return `<p>${esc(p).replace(/^(\d\.\s)/, '<strong>$1</strong>')}</p>`;
    }).join('');
  }
  const when = o.textTime ? new Date(o.textTime).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  $('outlookMeta').innerHTML = `National Hurricane Center${when ? `, issued ${esc(when)}` : ''}${o.text && o.text.forecaster ? ` · ${esc(o.text.forecaster)}` : ''}` +
    `${o.areas.length ? ` · ${o.areas.length} area${o.areas.length > 1 ? 's' : ''} on the map` : ''} · ` +
    '<a href="https://www.nhc.noaa.gov/gtwo.php?basin=atlc" target="_blank" rel="noopener">NHC outlook page</a>';
}

// Areas NHC is watching (shaded by 7-day chance), their expected motion and present location.
function drawOutlookLayers() {
  if (outlookLayer) { outlookLayer.remove(); outlookLayer = null; }
  const o = state.outlook;
  if (!o || !state.stormMap || !map) return;
  const tip = (p) => `NHC outlook: ${p.prob2day || '?'} chance in 2 days, ${p.prob7day || '?'} in 7 days`;
  const layers = [];
  for (const f of o.areas) {
    const c = RISK_COLORS[f.properties.risk7day] || RISK_COLORS.Low;
    layers.push(L.geoJSON(f.geometry, { pane: 'tabStorms', style: { color: c, weight: 2, fillColor: c, fillOpacity: 0.25, dashArray: '6 4' } })
      .bindTooltip(tip(f.properties)));
  }
  for (const f of o.motion) {
    const c = RISK_COLORS[f.properties.risk7day] || '#ffffff';
    layers.push(L.geoJSON(f.geometry, { pane: 'tabStorms', interactive: false, style: { color: c, weight: 3 } }));
    // Arrowhead at the end of the motion line.
    const coords = f.geometry.type === 'LineString' ? f.geometry.coordinates : (f.geometry.coordinates || []).flat();
    if (coords.length >= 2) {
      const [x1, y1] = coords[coords.length - 2], [x2, y2] = coords[coords.length - 1];
      const ang = Math.atan2(y2 - y1, (x2 - x1) * Math.cos(y2 * Math.PI / 180)), len = 0.8;
      const wing = (a) => [y2 - Math.sin(ang + a) * len, x2 - Math.cos(ang + a) * len / Math.cos(y2 * Math.PI / 180)];
      layers.push(L.polyline([wing(0.45), [y2, x2], wing(-0.45)], { pane: 'tabStorms', color: c, weight: 3, interactive: false }));
    }
  }
  for (const f of o.points) {
    if (!f.geometry || f.geometry.type !== 'Point') continue;
    const [lon, lat] = f.geometry.coordinates;
    const c = RISK_COLORS[f.properties.risk7day] || RISK_COLORS.Low;
    layers.push(L.marker([lat, lon], {
      pane: 'tabStorms',
      icon: L.divIcon({ className: 'outlook-x', html: `<span style="color:${c}">✕</span>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
    }).bindTooltip(tip(f.properties)));
  }
  if (layers.length) outlookLayer = L.layerGroup(layers).addTo(map);
}

// ---------- tropical storms ----------

// Saffir-Simpson colours by category (TD, TS, 1-5), NHC watch/warning colours, wind radii.
const CAT_COLORS = { TD: '#5ebaff', TS: '#00faf4', 1: '#ffffcc', 2: '#ffe775', 3: '#ffc140', 4: '#ff8f20', 5: '#ff6060' };
const WARN_COLORS = { HWR: '#ff2020', HWA: '#ff8fd0', TWR: '#3d7dff', TWA: '#ffe600' };
const WIND_COLORS = { 34: '#ffe066', 50: '#ffa040', 64: '#ff4040' };
const KT_KMH = 1.852;
// Storm winds the way NHC states them: rounded to the nearest 5 mph (or km/h).
const fmtWind = (kt) => (metric() ? `${Math.round(kt * KT_KMH / 5) * 5} km/h` : `${Math.round(kt * 1.15078 / 5) * 5} mph`);
const catColor = (kt) => CAT_COLORS[category(kt).short];
const catBadge = (kt) => { const c = category(kt).short; return c === 'TD' || c === 'TS' ? c : `Cat ${c}`; };
const fmtWhen = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function advisoryUrl(bin) {
  return bin.startsWith('CP') ? `https://www.nhc.noaa.gov/text/HFOTCP${bin}.shtml` : `https://www.nhc.noaa.gov/text/MIATCP${bin}.shtml`;
}

async function loadStorms() {
  try {
    state.storms = await activeStorms();
  } catch {
    return;   // keep what we had; try again on the next refresh
  }
  const first = !state.stormsLoaded;
  state.stormsLoaded = true;
  renderStorms();
  if (first && state.tab === 'storms' && !tabViews.storms) setTab('storms', { remember: false });
}

function renderStorms() {
  const storms = state.storms;
  updateSurgeOptions();
  $('stormCard').hidden = !storms.length;
  $('noStormCard').hidden = !!storms.length;
  drawStormLayers();
  if (!storms.length) return;
  const loc = state.result ? state.result.loc : state.picked || state.gps;
  const where = state.picked ? 'this spot' : 'you';
  $('stormList').innerHTML = storms.map((s, i) => {
    const lines = [];
    const move = s.speedMph ? `moving ${compass(s.headingTo)} at ${fmtSpeed(s.speedMph / 0.621371)}` : 'nearly stationary';
    lines.push(`<p>${fmtWind(s.kt)} winds${s.pressure ? ` · ${s.pressure} mb` : ''} · ${move}</p>`);
    if (loc) {
      const t = threatTo(s, loc);
      lines.push(`<p>${fmtDist(t.km)} ${compass(t.bearingFrom)} of ${where}. Closest forecast approach: ${fmtDist(t.closest.km)}, ${t.closest.time - Date.now() < 3600000 ? 'now' : fmtWhen(t.closest.time)}.</p>`);
      const tt = threatText(s, t);
      lines.push(`<p class="threat${tt ? '' : ' none'}">${tt || `No cone, watch or warning for ${where}.`}</p>`);
      const risk = state.result && state.result.surgeRisk, c = category(t.closest.kt || s.kt).level;
      if (risk && t.closest.km < 150 && c >= 1 && risk[c] >= 0) {
        lines.push(`<p class="threat">NHC planning maps show storm surge ${SURGE_CLASSES[risk[c]].label.toLowerCase()} above ground possible here from a Category ${c} hurricane.</p>`);
      }
    }
    const peak = s.points.reduce((a, b) => (b.kt > a.kt ? b : a), s.points[0]);
    if (peak.kt > s.kt) lines.push(`<p>Forecast to strengthen to ${category(peak.kt).name}, ${fmtWind(peak.kt)}, by ${fmtWhen(peak.time)}.</p>`);
    if (s.warnings.length) lines.push(`<p class="meta">Coastal alerts: ${[...new Set(s.warnings.map((w) => WARNING_NAMES[w.code] || w.code))].join(', ')}</p>`);
    lines.push(`<p class="meta">NHC advisory ${esc(s.advisory)}, ${esc(s.advisoryTime)} · <a href="${advisoryUrl(s.bin)}" target="_blank" rel="noopener">Read advisory</a></p>`);
    lines.push(`<div class="row"><button class="btn ghost" data-storm="${i}">Show on map</button></div>`);
    return `<div class="storm"><div class="storm-head"><span class="cat" style="background:${catColor(s.kt)}">${catBadge(s.kt)}</span>
      <strong>${esc(s.title)}</strong></div>${lines.join('')}</div>`;
  }).join('');
}

function drawStormLayers() {
  if (stormLayer) { stormLayer.remove(); stormLayer = null; }
  if (!state.stormMap || !state.storms.length || !map) return;
  const shape = (g, style) => L.geoJSON(g, { pane: 'tabStorms', interactive: false, style });
  const layers = [];
  for (const s of state.storms) {
    for (const g of s.cone) layers.push(shape(g, { color: '#ffffff', weight: 1.5, dashArray: '5 5', fillColor: '#ffffff', fillOpacity: 0.12 }));
    for (const w of [...s.wind].sort((a, b) => a.kt - b.kt)) {
      const c = WIND_COLORS[w.kt] || WIND_COLORS[34];
      layers.push(shape(w.geometry, { color: c, weight: 1, fillColor: c, fillOpacity: 0.22 }));
    }
    for (const g of s.pastTrack) layers.push(shape(g, { color: '#cfd8e3', weight: 2, opacity: 0.8 }));
    for (const g of s.track) layers.push(shape(g, { color: '#ffffff', weight: 2, dashArray: '6 6' }));
    for (const w of s.warnings) {
      layers.push(L.geoJSON(w.geometry, { pane: 'tabStorms', style: { color: WARN_COLORS[w.code] || '#ffffff', weight: 6, opacity: 0.95 } })
        .bindTooltip(`${esc(s.name)}: ${WARNING_NAMES[w.code] || w.code}`));
    }
    for (const p of s.points.slice(1)) {
      layers.push(L.circleMarker([p.lat, p.lon], { pane: 'tabStorms', radius: 6, color: '#111111', weight: 1, fillColor: catColor(p.kt), fillOpacity: 1 })
        .bindTooltip(`${esc(s.name)} · ${fmtWhen(p.time)} · ${category(p.kt).name} · ${fmtWind(p.kt)}`));
    }
    layers.push(L.marker([s.lat, s.lon], {
      pane: 'tabStorms',
      icon: L.divIcon({
        className: 'storm-label', iconSize: [26, 26], iconAnchor: [13, 13],
        html: `<div style="background:${catColor(s.kt)}">${category(s.kt).short}</div><span>${esc(s.name)}</span>`,
      }),
    }).bindTooltip(`${esc(s.title)} · ${fmtWind(s.kt)}`));
  }
  stormLayer = L.layerGroup(layers).addTo(map);
}

function showStormOnMap(i) {
  const s = state.storms[i];
  if (!s) return;
  if (!state.stormMap) {
    state.stormMap = true;
    store.set('stormMap', true);
    $('stormMap').checked = true;
    drawStormLayers();
  }
  const shapes = [...s.cone, ...s.track, ...s.pastTrack].map((g) => L.geoJSON(g));
  const b = shapes.length ? L.featureGroup(shapes).getBounds() : L.latLngBounds([[s.lat, s.lon], [s.lat, s.lon]]);
  map.fitBounds(b.pad(0.1));
  $('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------- saved places switcher ----------

const savedPlaces = () => store.get('places', []);

function renderPlaceBar() {
  const list = savedPlaces();
  const p = state.picked;
  const isSaved = (pl) => p && p.name === pl.name && Math.abs(p.lat - pl.lat) < 1e-4 && Math.abs(p.lon - pl.lon) < 1e-4;
  const chips = [`<button class="chip${p ? '' : ' on'}" data-place="gps">📍 My location</button>`];
  list.forEach((pl, i) => chips.push(`<button class="chip${isSaved(pl) ? ' on' : ''}" data-place="${i}">${esc(pl.name)}</button>`));
  if (p && !list.some(isSaved)) chips.push(`<button class="chip on" data-place="here">${esc(p.name || 'Map point')}</button>`);
  chips.push('<button class="chip add" data-place="add" title="Save this spot as a place">＋</button>');
  $('placeBar').innerHTML = chips.join('');
}

// Switches the whole app to a place (null = GPS), re-centring the maps on it.
async function goToPlace(pl) {
  state.picked = pl ? { lat: pl.lat, lon: pl.lon, name: pl.name } : null;
  store.set('activePlace', pl ? pl.name : null);
  state.mapCentred = false;
  delete tabViews.local;
  delete tabViews.seas;
  renderPlaceBar();
  if (!pl) await locate();
  if (map && state.tab !== 'storms') {
    const loc = state.picked || state.gps;
    if (loc) map.setView([loc.lat, loc.lon], state.tab === 'seas' ? 6 : 8);
  }
  refresh();
}

// ---------- scroll slider ----------

function initScrollRail() {
  const rail = $('scrollRail'), thumb = $('scrollThumb');
  let drag = null;
  const metrics = () => {
    const top = $('topbar').getBoundingClientRect().bottom + 4;
    const h = window.innerHeight - top - 8;
    const doc = document.documentElement.scrollHeight, view = window.innerHeight;
    const th = Math.max(40, h * view / doc);
    return { top, h, doc, view, th, max: doc - view };
  };
  const update = () => {
    const m = metrics();
    rail.style.display = m.max > 40 ? '' : 'none';
    rail.style.top = `${m.top}px`;
    rail.style.height = `${m.h}px`;
    thumb.style.height = `${m.th}px`;
    thumb.style.top = `${(m.h - m.th) * (m.max > 0 ? window.scrollY / m.max : 0)}px`;
  };
  const scrollToY = (clientY, offset) => {
    const m = metrics();
    const f = (clientY - m.top - offset) / Math.max(1, m.h - m.th);
    window.scrollTo({ top: Math.max(0, Math.min(1, f)) * m.max });
  };
  rail.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    rail.setPointerCapture(e.pointerId);
    const t = thumb.getBoundingClientRect();
    // Grab the thumb where it was touched, or centre it under a tap on the track.
    drag = { offset: e.clientY >= t.top && e.clientY <= t.bottom ? e.clientY - t.top : t.height / 2 };
    rail.classList.add('dragging');
    scrollToY(e.clientY, drag.offset);
  });
  rail.addEventListener('pointermove', (e) => { if (drag) scrollToY(e.clientY, drag.offset); });
  const end = () => { drag = null; rail.classList.remove('dragging'); };
  rail.addEventListener('pointerup', end);
  rail.addEventListener('pointercancel', end);
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  new ResizeObserver(update).observe(document.body);
  update();
}

// ---------- tides (Seas & swell) ----------

let tidesMod = null;
async function loadTides(at) {
  const loc = at || state.picked || state.gps;   // the place being shown now, not the last result
  if (!loc) return;
  try {
    if (!tidesMod) {
      tidesMod = await import('./tides.js');
      tidesMod.initTides({ metric, esc, picked: () => !!state.picked });
    }
    tidesMod.showTides(loc);
  } catch (e) {
    $('tideNow').textContent = `Tides unavailable: ${e.message}`;
  }
}

let waterMod = null;
async function loadWaterTemp(at) {
  const loc = at || state.picked || state.gps;
  if (!loc) return;
  try {
    if (!waterMod) {
      waterMod = await import('./seatemp.js');
      waterMod.initWaterTemp({ metric, esc, server: alertServerUrl });
    }
    waterMod.showWaterTemp(loc);
  } catch (e) {
    $('wtNow').textContent = `Water temperature unavailable: ${e.message}`;
  }
}

// ---------- tabs ----------

const TAB_PANES = { local: ['tabLocal'], storms: ['tabStorms', 'surge'], seas: ['tabSeas'] };
const tabViews = {};   // map centre/zoom remembered per tab

function defaultView(tab) {
  const loc = (state.result && state.result.loc) || state.picked || state.gps;
  if (tab === 'storms') {
    const shapes = [...state.storms.flatMap((s) => [...s.cone, ...s.track]), ...((state.outlook && state.outlook.areas) || []).map((f) => f.geometry)]
      .map((g) => L.geoJSON(g));
    return shapes.length ? { bounds: L.featureGroup(shapes).getBounds().pad(0.1) } : { bounds: L.latLngBounds([[8, -100], [45, -50]]) };
  }
  if (tab === 'seas') return loc ? { center: [loc.lat, loc.lon], zoom: 6 } : { bounds: L.latLngBounds([[17, -98], [45, -60]]) };
  return loc ? { center: [loc.lat, loc.lon], zoom: 8 } : null;
}

function setTab(tab, { remember = true } = {}) {
  if (!TAB_PANES[tab]) tab = 'local';
  const prev = state.tab;
  if (map && prev && prev !== tab) tabViews[prev] = { center: map.getCenter(), zoom: map.getZoom() };
  state.tab = tab;
  if (remember) store.set('tab', tab);
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('[data-tab]').forEach((el) => {
    if (el.tagName === 'BUTTON') return;
    if (el.dataset.tab !== tab) { el.dataset.tabHidden = '1'; el.style.display = 'none'; } else { delete el.dataset.tabHidden; el.style.display = ''; }
  });
  const card = $('mapCard');
  document.querySelector(`.map-slot[data-slot="${tab}"]`).appendChild(card);
  card.dataset.tabMap = tab;
  if (map) {
    for (const [t, panes] of Object.entries(TAB_PANES)) {
      for (const p of panes) map.getPane(p).style.display = t === tab ? '' : 'none';
    }
    map.invalidateSize();
    const v = tabViews[tab] || defaultView(tab);
    if (v && v.bounds) map.fitBounds(v.bounds); else if (v) map.setView(v.center, v.zoom);
  }
  if (tab !== 'local') stopPlay();
  // Charts drawn while their tab was hidden have no size; redraw them now.
  if (tab === 'local' && state.result) drawChart(state.result.series);
  // Navy waves come on by themselves the first time Seas & swell is opened.
  if (tab === 'seas' && store.get('navyWaves', null) === null) {
    store.set('navyWaves', 'on');
    $('wavesSel').value = 'on';
    setWaves(true);
  }
  if (tab === 'seas') { passageShown(); loadTides(); loadWaterTemp(); }
  window.scrollTo({ top: 0 });
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
  $('gpsBtn').addEventListener('click', () => goToPlace(null));
  $('placeBar').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-place]');
    if (!b) return;
    const v = b.dataset.place;
    if (v === 'gps') goToPlace(null);
    else if (v === 'add') {
      $('settings').hidden = false;
      $('placeName').focus();
      $('placeName').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (v !== 'here') goToPlace(savedPlaces()[+v]);
  });
  window.addEventListener('places-changed', renderPlaceBar);
  $('frameSlider').addEventListener('input', (e) => { stopPlay(); showFrame(+e.target.value); });
  $('playBtn').addEventListener('click', togglePlay);
  $('marineZone').addEventListener('change', (e) => {
    state.marineZone = e.target.value;
    store.set('marineZone', state.marineZone);
    syncMarine();
    if (marineLoc) loadMarine(marineLoc);
  });
  $('marineMapBtn').addEventListener('click', () => showMarineZone(true));
  $('marineBody').addEventListener('click', (e) => {
    const p = e.target.closest('.marine-period');
    if (p) { const full = p.querySelector('.full'); full.hidden = !full.hidden; }
  });
  $('wavesSel').addEventListener('change', (e) => { store.set('navyWaves', e.target.value); setWaves(!!e.target.value); });
  $('wavesSlider').addEventListener('input', (e) => showWaveStep(+e.target.value));
  $('wavesSel').value = store.get('navyWaves', '');
  $('surgeSel').value = state.surge;
  $('surgeSel').addEventListener('change', (e) => {
    state.surge = e.target.value;
    store.set('surge', state.surge);
    setSurge(state.surge);
  });
  $('stormMap').checked = state.stormMap;
  $('stormMap').addEventListener('change', (e) => {
    state.stormMap = e.target.checked;
    store.set('stormMap', state.stormMap);
    drawStormLayers();
    drawOutlookLayers();
  });
  $('stormList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-storm]');
    if (b) showStormOnMap(+b.dataset.storm);
  });
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) setTab(b.dataset.tab);
  });
  $('velBtn').addEventListener('click', () => {
    state.velocity = !state.velocity;
    drawVelocity();
  });
  $('arrowBtn').addEventListener('click', () => {
    state.arrows = !state.arrows;
    store.set('arrows', state.arrows);
    drawArrows(state.result && state.result.radar);
  });
  $('settingsBtn').addEventListener('click', () => { $('settings').hidden = !$('settings').hidden; });
  $('units').value = state.units;
  $('units').addEventListener('change', (e) => { state.units = e.target.value; store.set('units', state.units); render(); passageUnitsChanged(); syncWaterTemp(); if (state.tab === 'seas') { loadTides(); loadWaterTemp(); } });
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
  initPassage({ server: alertServerUrl, loc: () => state.picked || state.gps, metric, compass });
  if (state.surge && !state.surge.startsWith('live:')) setSurge(state.surge);
  setTab(new URLSearchParams(location.search).get('tab') || store.get('tab', 'local'), { remember: false });
  if (store.get('navyWaves', '')) setWaves(true);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  initScrollRail();
  const fromUrl = urlLocation();
  const active = savedPlaces().find((p) => p.name === store.get('activePlace', null));
  if (fromUrl) state.picked = fromUrl;
  else if (active) state.picked = { lat: active.lat, lon: active.lon, name: active.name };
  renderPlaceBar();
  if (!state.picked) await locate();
  else locate();   // still learn GPS in the background for 'My location'
  refresh();
}

main();
