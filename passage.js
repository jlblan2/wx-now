import { loadBuoys, fmtTemp, cToF } from './seatemp.js';

// Sailing weather: forecast maps for the US East Coast, the Gulf
// of America, the Bahamas, the Caribbean and Bermuda. Wind (speed colours + barbs in knots), waves (height + direction), pressure
// (isobars + rain) and visibility, 3-hourly over 7 days, from NOAA GFS / GFS-Wave or the
// Navy's NAVGEM / WAVEWATCH III, served as compact grids by the alert server.

const REGIONS = {
  coast: { name: 'Whole area', bounds: [[8, -100], [47, -58]] },
  gulf: { name: 'Gulf of America', bounds: [[17.5, -98], [31, -80]] },
  florida: { name: 'Florida', bounds: [[24, -88], [31.5, -79]] },
  bahamas: { name: 'Bahamas', bounds: [[20.5, -80.8], [27.5, -72]] },
  caribbean: { name: 'Caribbean', bounds: [[8.5, -88], [23.5, -59]] },
  westcarib: { name: 'Western Caribbean', bounds: [[9, -88.5], [23, -74]] },
  eastcarib: { name: 'Eastern Caribbean', bounds: [[10, -75.5], [20.5, -58.5]] },
  bermuda: { name: 'Bermuda', bounds: [[29.8, -68.5], [34.8, -61]] },
  tobermuda: { name: 'East Coast → Bermuda', bounds: [[30.5, -77.5], [42, -61.5]] },
  bdacarib: { name: 'Bermuda → Caribbean', bounds: [[16, -71], [34, -59]] },
  southeast: { name: 'Southeast', bounds: [[28, -82], [36.5, -72]] },
  midatl: { name: 'Mid-Atlantic', bounds: [[34, -78.5], [42, -67]] },
  newengland: { name: 'New England', bounds: [[39, -75], [46.5, -63]] },
};

// Colour ramps: [value, [r, g, b, a]]
const RAMPS = {
  wind: [[0, [70, 110, 220, 150]], [5, [60, 160, 230, 165]], [10, [50, 200, 170, 180]], [15, [100, 210, 80, 190]],
    [20, [235, 225, 60, 200]], [25, [250, 165, 40, 210]], [30, [240, 80, 40, 215]], [35, [200, 30, 40, 220]],
    [45, [200, 40, 180, 225]], [60, [120, 40, 200, 230]]],                                     // knots
  waves: [[0, [40, 90, 200, 150]], [2, [60, 150, 230, 170]], [4, [40, 200, 200, 185]], [6, [90, 210, 90, 195]],
    [8, [240, 220, 60, 205]], [12, [250, 140, 40, 215]], [16, [230, 50, 40, 225]], [25, [190, 40, 190, 235]]], // feet
  rain: [[0.1, [120, 170, 255, 110]], [0.5, [70, 130, 245, 160]], [2, [40, 190, 90, 190]], [5, [240, 220, 50, 205]],
    [10, [245, 120, 30, 215]], [25, [220, 40, 160, 225]]],                                     // mm/h
  vis: [[0, [220, 40, 40, 200]], [0.5, [240, 120, 40, 185]], [1, [240, 200, 50, 160]], [3, [200, 200, 200, 90]], [5, [200, 200, 200, 0]]], // nm
  sst: [[-2, [120, 60, 200, 200]], [5, [60, 80, 220, 200]], [10, [40, 140, 230, 200]], [15, [40, 200, 200, 200]], [20, [90, 210, 90, 205]],
    [24, [235, 225, 60, 210]], [26, [250, 165, 40, 215]], [28, [240, 80, 40, 220]], [30, [200, 30, 60, 225]], [32, [190, 40, 190, 230]]], // deg C
};
const LEGENDS = {
  wind: { label: 'Wind, knots', stops: [0, 5, 10, 15, 20, 25, 30, 35, 45, 60] },
  waves: { label: 'Waves', stops: [0, 2, 4, 6, 8, 12, 16, 25] },
  pressure: { label: 'Rain, mm/h · white lines: pressure (mb)', stops: [0.1, 0.5, 2, 5, 10, 25], ramp: 'rain' },
  vis: { label: 'Visibility, nautical miles', stops: [0, 0.5, 1, 3, 5] },
  sst: { label: 'Sea temperature', stops: [5, 10, 15, 20, 24, 26, 28, 30] },
};

const KT = 1.94384, FT = 3.28084, NM = 1 / 1852;
let buoyLayer = null;
let opts, map, field, vectors, meta = null, model = 'noaa', product = 'wind', stepIdx = 0, playing = null, inited = false;
const cache = new Map();
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const $ = (id) => document.getElementById(id);

function rgba(ramp, v) {
  if (!(v >= ramp[0][0])) return null;
  for (let i = 1; i < ramp.length; i++) {
    if (v <= ramp[i][0]) {
      const [a, ca] = ramp[i - 1], [b, cb] = ramp[i], t = (v - a) / (b - a);
      return ca.map((x, k) => x + (cb[k] - x) * t);
    }
  }
  return ramp[ramp.length - 1][1];
}

// ---------- data ----------

async function loadStep(m, i) {
  const key = `${m.model}/${m.cycle}/${m.steps[i]}`;
  if (!cache.has(key)) {
    // The grid size in the query keeps cached files from an older area layout from being reused.
    const p = fetch(`${opts.server()}/api/passage/${m.model}/${m.cycle}/${String(m.steps[i]).padStart(3, '0')}.bin?g=${m.lat0},${m.nlat}x${m.nlon}x${m.vars.length}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
      .then((b) => new Int16Array(b));
    cache.set(key, p);
    p.catch(() => cache.delete(key));
    if (cache.size > 40) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}

// Grid accessor: value of a variable at fractional row/col (bilinear, NaN-aware).
function grid(m, data) {
  const idx = Object.fromEntries(m.vars.map((v, i) => [v.name, i]));
  const plane = m.nlat * m.nlon;
  const raw = (vi, r, c) => {
    const x = data[vi * plane + r * m.nlon + c];
    return x === m.missing ? NaN : x * m.vars[vi].scale;
  };
  const at = (name, fr, fc) => {
    const vi = idx[name];
    if (vi === undefined || fr < 0 || fc < 0 || fr > m.nlat - 1 || fc > m.nlon - 1) return NaN;
    const r = Math.min(Math.floor(fr), m.nlat - 2), c = Math.min(Math.floor(fc), m.nlon - 2);
    const tr = fr - r, tc = fc - c;
    const v = [[raw(vi, r, c), (1 - tr) * (1 - tc)], [raw(vi, r, c + 1), (1 - tr) * tc], [raw(vi, r + 1, c), tr * (1 - tc)], [raw(vi, r + 1, c + 1), tr * tc]];
    let s = 0, w = 0;
    for (const [x, k] of v) if (!Number.isNaN(x)) { s += x * k; w += k; }
    return w > 0.5 ? s / w : NaN;
  };
  const rc = (lat, lon) => [(lat - m.lat0) / m.res, (lon - m.lon0) / m.res];
  return { at, rc, raw, idx };
}

// ---------- drawing ----------

const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
const fromMercY = (y) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;

function drawField(m, g) {
  const lat1 = m.lat0 + (m.nlat - 1) * m.res, lon1 = m.lon0 + (m.nlon - 1) * m.res;
  const W = 640, y0 = mercY(m.lat0), y1 = mercY(lat1);
  const H = Math.round(W * (y1 - y0) / ((lon1 - m.lon0) * Math.PI / 180));
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  const value = {
    wind: (fr, fc) => Math.hypot(g.at('u10', fr, fc), g.at('v10', fr, fc)) * KT,
    waves: (fr, fc) => g.at('swh', fr, fc) * FT,
    pressure: (fr, fc) => g.at('prate', fr, fc),
    vis: (fr, fc) => g.at('vis', fr, fc) * NM,
    sst: (fr, fc) => g.at('sst', fr, fc),
  }[product];
  const ramp = RAMPS[product === 'pressure' ? 'rain' : product];
  for (let py = 0; py < H; py++) {
    const lat = fromMercY(y1 - (py + 0.5) / H * (y1 - y0));
    const fr = (lat - m.lat0) / m.res;
    for (let px = 0; px < W; px++) {
      const fc = (px + 0.5) / W * (m.nlon - 1);
      const c = rgba(ramp, value(fr, fc));
      if (!c) continue;
      const o = (py * W + px) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = c[3];
    }
  }
  ctx.putImageData(img, 0, 0);
  const bounds = [[m.lat0, m.lon0], [lat1, lon1]];
  if (!field) field = L.imageOverlay(cv.toDataURL(), bounds, { opacity: 0.85, interactive: false }).addTo(map);
  else { field.setBounds(L.latLngBounds(bounds)); field.setUrl(cv.toDataURL()); }
}

// Wind barb at a container point: staff toward where the wind comes from, feathers in knots.
function barb(pt, from, kt, lines, flags) {
  const P = (x, y) => map.containerPointToLatLng([x, y]);
  if (kt < 2.5) {
    const ring = [];
    for (let a = 0; a <= 360; a += 45) ring.push(P(pt.x + 3 * Math.cos(a * Math.PI / 180), pt.y + 3 * Math.sin(a * Math.PI / 180)));
    lines.push(ring);
    return;
  }
  const ang = (from - 90) * Math.PI / 180;            // screen angle toward the source
  const ux = Math.cos(ang), uy = Math.sin(ang);
  const px = -uy, py = ux;                            // feathers on the clockwise side
  const L0 = 24, tip = [pt.x + ux * L0, pt.y + uy * L0];
  lines.push([P(pt.x, pt.y), P(tip[0], tip[1])]);
  let k = Math.round(kt / 5) * 5, pos = 0;
  const step = 4;
  while (k >= 50) {
    const a = [tip[0] - ux * pos, tip[1] - uy * pos], b = [a[0] - ux * step * 1.6, a[1] - uy * step * 1.6];
    flags.push([P(...a), P(a[0] + px * 10, a[1] + py * 10), P(...b)]);
    pos += step * 1.6 + 1; k -= 50;
  }
  while (k >= 10) {
    const a = [tip[0] - ux * pos, tip[1] - uy * pos];
    lines.push([P(...a), P(a[0] + px * 10 + ux * 3, a[1] + py * 10 + uy * 3)]);
    pos += step; k -= 10;
  }
  if (k >= 5) {
    if (pos === 0) pos = step;
    const a = [tip[0] - ux * pos, tip[1] - uy * pos];
    lines.push([P(...a), P(a[0] + px * 5 + ux * 1.5, a[1] + py * 5 + uy * 1.5)]);
  }
}

// Isobars by marching squares, every 4 mb, as line segments.
function isobars(m, g) {
  const segs = {};
  const P = (r, c) => [m.lat0 + r * m.res, m.lon0 + c * m.res];
  const mb = (r, c) => g.raw(g.idx.mslp, r, c) / 100;
  for (let r = 0; r < m.nlat - 1; r++) {
    for (let c = 0; c < m.nlon - 1; c++) {
      const v = [mb(r, c), mb(r, c + 1), mb(r + 1, c + 1), mb(r + 1, c)];
      if (v.some(Number.isNaN)) continue;
      const lo = Math.ceil(Math.min(...v) / 4) * 4, hi = Math.max(...v);
      for (let lvl = lo; lvl <= hi; lvl += 4) {
        const pts = [];
        const edge = (a, b, pa, pb) => {
          if ((v[a] < lvl) !== (v[b] < lvl)) {
            const t = (lvl - v[a]) / (v[b] - v[a]);
            pts.push([pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t]);
          }
        };
        const corners = [P(r, c), P(r, c + 1), P(r + 1, c + 1), P(r + 1, c)];
        edge(0, 1, corners[0], corners[1]); edge(1, 2, corners[1], corners[2]);
        edge(2, 3, corners[2], corners[3]); edge(3, 0, corners[3], corners[0]);
        if (pts.length >= 2) (segs[lvl] = segs[lvl] || []).push([pts[0], pts[1]]);
        if (pts.length === 4) segs[lvl].push([pts[2], pts[3]]);
      }
    }
  }
  return segs;
}

function drawVectors(m, g) {
  if (vectors) vectors.remove();
  const layers = [];
  const size = map.getSize(), b = map.getBounds();
  if (product === 'wind' || product === 'waves') {
    const lines = [], flags = [];
    const gap = 46;
    for (let y = gap / 2; y < size.y; y += gap) {
      for (let x = gap / 2; x < size.x; x += gap) {
        const ll = map.containerPointToLatLng([x, y]);
        const [fr, fc] = g.rc(ll.lat, ll.lng);
        if (product === 'wind') {
          const u = g.at('u10', fr, fc), v = g.at('v10', fr, fc);
          if (Number.isNaN(u)) continue;
          barb({ x, y }, (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360, Math.hypot(u, v) * KT, lines, flags);
        } else {
          const d = g.at('dir', fr, fc), h = g.at('swh', fr, fc);
          if (Number.isNaN(d) || Number.isNaN(h)) continue;
          const to = ((d + 180) - 90) * Math.PI / 180, len = 16, ux = Math.cos(to), uy = Math.sin(to);
          const P = (px, py) => map.containerPointToLatLng([px, py]);
          const head = [x + ux * len / 2, y + uy * len / 2];
          lines.push([P(x - ux * len / 2, y - uy * len / 2), P(...head)]);
          const w = (a) => P(head[0] - Math.cos(to + a) * 6, head[1] - Math.sin(to + a) * 6);
          lines.push([w(0.5), P(...head), w(-0.5)]);
        }
      }
    }
    layers.push(L.polyline(lines, { color: '#0a1220', weight: 3, opacity: 0.45, interactive: false }));
    layers.push(L.polyline(lines, { color: '#ffffff', weight: 1.3, interactive: false }));
    if (flags.length) layers.push(L.polygon(flags, { color: '#ffffff', weight: 1, fillColor: '#ffffff', fillOpacity: 1, interactive: false }));
  } else if (product === 'pressure' && g.idx.mslp !== undefined) {
    const segs = isobars(m, g);
    const all = Object.values(segs).flat();
    layers.push(L.polyline(all, { color: '#0a1220', weight: 3, opacity: 0.4, interactive: false }));
    layers.push(L.polyline(all, { color: '#ffffff', weight: 1.2, opacity: 0.9, interactive: false }));
    // One label per isobar level inside the view, near the middle.
    const mid = b.getCenter();
    for (const [lvl, list] of Object.entries(segs)) {
      let best = null;
      for (const s of list) {
        if (!b.contains(s[0])) continue;
        const d = (s[0][0] - mid.lat) ** 2 + (s[0][1] - mid.lng) ** 2;
        if (!best || d < best.d) best = { d, p: s[0] };
      }
      if (best) {
        layers.push(L.marker(best.p, {
          interactive: false,
          icon: L.divIcon({ className: 'isobar-label', html: lvl, iconSize: [34, 14], iconAnchor: [17, 7] }),
        }));
      }
    }
  }
  vectors = L.layerGroup(layers).addTo(map);
}

// ---------- buoy water temperatures on the sea-temperature chart ----------

function buoyText(b) {
  const metric = opts.metric();
  const bits = [`water ${fmtTemp(b.wtmp, metric)}`];
  if (b.atmp !== null) bits.push(`air ${fmtTemp(b.atmp, metric)}`);
  if (b.wvht !== null) bits.push(`waves ${metric ? `${b.wvht.toFixed(1)} m` : `${Math.round(b.wvht * FT)} ft`}${b.dpd !== null ? ` at ${Math.round(b.dpd)} s` : ''}`);
  if (b.wspd !== null) bits.push(`wind ${b.wdir !== null ? `${opts.compass(b.wdir)} ` : ''}${Math.round(b.wspd * KT)} kt`);
  const t = new Date(b.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${b.name || 'Station'} (${b.id}), measured ${t}: ${bits.join(' · ')}`;
}

async function drawBuoys() {
  let d;
  try { d = await loadBuoys(opts.server()); } catch { return; }
  if (product !== 'sst') return;
  if (buoyLayer) buoyLayer.remove();
  const metric = opts.metric(), labels = map.getZoom() >= 6, layers = [];
  for (const b of d.stations) {
    if (b.wtmp === null) continue;
    const c = rgba(RAMPS.sst, b.wtmp) || RAMPS.sst[0][1];
    const marker = L.circleMarker([b.lat, b.lon], {
      radius: 5, color: '#0a1220', weight: 1.5, fillColor: `rgb(${c[0]},${c[1]},${c[2]})`, fillOpacity: 1,
    });
    marker.on('click', (e) => { L.DomEvent.stopPropagation(e); $('pwInfo').textContent = buoyText(b); });
    layers.push(marker);
    if (labels) {
      layers.push(L.marker([b.lat, b.lon], {
        interactive: false,
        icon: L.divIcon({ className: 'level-label', html: `${Math.round(metric ? b.wtmp : cToF(b.wtmp))}°`, iconSize: [30, 14], iconAnchor: [-5, 7] }),
      }));
    }
  }
  buoyLayer = L.layerGroup(layers).addTo(map);
}

function clearBuoys() {
  if (buoyLayer) { buoyLayer.remove(); buoyLayer = null; }
}

// ---------- measured water levels (all gauges, from the alert server) ----------

// Colour by how far the water is above (+) or below (-) the predicted tide, in feet.
const LEVEL_STOPS = [[-2, '#2a5bd7'], [-1, '#4f8ff7'], [-0.5, '#9cc3ff'], [0.5, '#e8edf5'], [1, '#ffd23f'], [2, '#ff8f2a'], [3, '#e8413a']];
const levelColor = (ft) => (ft === null ? '#8195b0' : (LEVEL_STOPS.find(([v]) => ft <= v) || LEVEL_STOPS[LEVEL_STOPS.length - 1])[1]);
let levelsLayer = null, levelsData = null;

async function loadLevels() {
  if (levelsData && Date.now() - levelsData.fetched < 5 * 60000) return levelsData;
  const r = await fetch(`${opts.server()}/api/waterlevels`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  levelsData = { ...j, fetched: Date.now() };
  return levelsData;
}

function levelText(g) {
  const u = opts.metric() ? 0.3048 : 1, unit = opts.metric() ? ' m' : ' ft';
  const v = (x) => `${(x * u).toFixed(1)}${unit}`;
  const t = new Date(g.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const diff = g.above === null ? '' : Math.abs(g.above) < 0.15 ? ', close to predicted'
    : `, ${v(Math.abs(g.above))} ${g.above > 0 ? 'above' : 'below'} predicted`;
  const trend = g.rising === 1 ? ', rising' : g.rising === -1 ? ', falling' : '';
  let flood = '';
  if (g.minor !== null) {
    const stage = g.major !== null && g.level >= g.major ? 'MAJOR flooding level'
      : g.moderate !== null && g.level >= g.moderate ? 'MODERATE flooding level'
        : g.level >= g.minor ? 'MINOR flooding level' : null;
    flood = stage ? ` · at ${stage}` : ` · minor flooding at ${v(g.minor)}`;
  }
  return `${g.name}: ${v(g.level)} above MLLW at ${t}${diff}${trend}${flood}`;
}

async function drawLevels() {
  if (field) { field.remove(); field = null; }
  if (vectors) { vectors.remove(); vectors = null; }
  $('pwSlider').disabled = true;
  $('pwPlay').disabled = true;
  $('pwLabel').textContent = 'Measured now';
  let d;
  try { d = await loadLevels(); } catch (e) {
    $('pwInfo').textContent = `Water levels unavailable: ${e.message}`;
    return;
  }
  if (product !== 'levels') return;
  if (levelsLayer) levelsLayer.remove();
  const unit = opts.metric() ? 0.3048 : 1;
  const layers = [];
  for (const g of d.gauges) {
    const flooding = g.minor !== null && g.level >= g.minor;
    const marker = L.circleMarker([g.lat, g.lon], {
      radius: 7, color: flooding ? '#ff3b3b' : '#0a1220', weight: flooding ? 3 : 1.5,
      fillColor: levelColor(g.above), fillOpacity: 0.95,
    });
    marker.on('click', (e) => { L.DomEvent.stopPropagation(e); $('pwInfo').textContent = levelText(g); });
    layers.push(marker);
    // Zoomed out, label only the gauges a foot or more off prediction so labels don't pile up.
    const labelMin = map.getZoom() >= 7 ? 0.15 : 1.0;
    if (g.above !== null && Math.abs(g.above) >= labelMin) {
      const lbl = `${g.above > 0 ? '+' : '−'}${Math.abs(g.above * unit).toFixed(1)}`;
      layers.push(L.marker([g.lat, g.lon], {
        interactive: false,
        icon: L.divIcon({ className: 'level-label', html: lbl, iconSize: [36, 14], iconAnchor: [-6, 7] }),
      }));
    }
  }
  levelsLayer = L.layerGroup(layers).addTo(map);
  const age = d.at ? Math.round((Date.now() - Date.parse(d.at)) / 60000) : null;
  $('pwInfo').textContent = `${d.gauges.length} NOAA gauges, measured within the last 30 minutes${age !== null ? ` (collected ${age} min ago)` : ''}. ` +
    'Numbers are how far the water is above (+) or below (−) the predicted tide. A red ring means it is at or above minor flood level. Tap a gauge for details.';
}

function clearLevels() {
  if (levelsLayer) { levelsLayer.remove(); levelsLayer = null; }
  $('pwSlider').disabled = false;
  $('pwPlay').disabled = false;
}

// ---------- UI ----------

function legend() {
  if (product === 'levels') {
    const u = opts.metric() ? 'm' : 'ft', k = opts.metric() ? 0.3048 : 1;
    const fmt = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v * k * 10) / 10)}`;
    $('pwLegend').innerHTML = LEVEL_STOPS.map(([v, c], i) => `<span><i style="background:${c}"></i>${i === 3 ? '±0.5' : fmt(v)}</span>`).join('') +
      `<span>${u} vs predicted tide</span>`;
    return;
  }
  const l = LEGENDS[product], ramp = RAMPS[l.ramp || product];
  if (product === 'sst') {
    const metric = opts.metric();
    $('pwLegend').innerHTML = l.stops.map((s) => {
      const c = rgba(ramp, s);
      return `<span><i style="background:rgb(${c[0]},${c[1]},${c[2]})"></i>${metric ? s : Math.round(cToF(s))}</span>`;
    }).join('') + `<span>Sea temperature, ${metric ? '°C' : '°F'} · dots: buoys measured now</span>`;
    return;
  }
  const wavesUnit = opts.metric() ? 'm' : 'ft';
  $('pwLegend').innerHTML = l.stops.map((s, i) => {
    const c = rgba(ramp, s + 1e-6) || ramp[0][1];
    const shown = product === 'waves' && opts.metric() ? Math.round(s / FT * 10) / 10 : s;
    return `<span><i style="background:rgba(${c[0]},${c[1]},${c[2]},${Math.max(0.6, c[3] / 255)})"></i>${shown}${i === l.stops.length - 1 ? '+' : ''}</span>`;
  }).join('') + `<span>${product === 'waves' ? `Waves, ${wavesUnit}` : l.label}</span>`;
}

let drawToken = 0;
async function draw() {
  if (product === 'levels') { stopPlay(); return drawLevels(); }
  clearLevels();
  if (product === 'sst') drawBuoys(); else clearBuoys();
  if (!meta) return;
  // The Navy files carry no sea temperature, so that chart always uses NOAA GFS.
  const src = product === 'sst' ? 'noaa' : model;
  const m = meta[src];
  if (!m) { $('pwLabel').textContent = `${src === 'navy' ? 'Navy' : 'NOAA'} data not available yet`; return; }
  if (src === 'noaa' && !m.vars.some((v) => v.name === 'sst') && product === 'sst') { $('pwInfo').textContent = 'Sea temperature arrives with the next NOAA model run.'; }
  stepIdx = Math.max(0, Math.min(stepIdx, m.steps.length - 1));
  $('pwSlider').max = m.steps.length - 1;
  $('pwSlider').value = stepIdx;
  const h = m.steps[stepIdx], t = new Date(Date.parse(m.base) + h * 3600000);
  $('pwLabel').textContent = `${t.toLocaleString([], { weekday: 'short', hour: 'numeric' })}`;
  const token = ++drawToken;
  let data;
  try { data = await loadStep(m, stepIdx); } catch (e) {
    $('pwInfo').textContent = `Could not load this forecast time: ${e.message}`;
    return;
  }
  if (token !== drawToken) return;
  const g = grid(m, data);
  drawField(m, g);
  drawVectors(m, g);
  if (stepIdx + 1 < m.steps.length) loadStep(m, stepIdx + 1).catch(() => {});   // preload for play
  state.g = g; state.m = m;
  if (state.tap) showPoint(state.tap);
}
const state = {};

function showPoint(ll) {
  state.tap = ll;
  const { g, m } = state;
  if (!g) return;
  const [fr, fc] = g.rc(ll.lat, ll.lng);
  const u = g.at('u10', fr, fc), v = g.at('v10', fr, fc);
  const parts = [];
  if (!Number.isNaN(u)) {
    const from = (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
    const gust = g.at('gust', fr, fc);
    parts.push(`Wind ${opts.compass(from)} ${Math.round(Math.hypot(u, v) * KT)} kt${Number.isNaN(gust) ? '' : `, gusts ${Math.round(gust * KT)}`}`);
  }
  const h = g.at('swh', fr, fc);
  if (!Number.isNaN(h)) {
    const p = g.at('per', fr, fc), d = g.at('dir', fr, fc);
    parts.push(`Waves ${opts.metric() ? `${h.toFixed(1)} m` : `${Math.round(h * FT)} ft`}${Number.isNaN(p) ? '' : ` at ${Math.round(p)} s`}${Number.isNaN(d) ? '' : ` from ${opts.compass(d)}`}`);
  }
  const p = g.at('mslp', fr, fc);
  if (!Number.isNaN(p)) parts.push(`${Math.round(p / 100)} mb`);
  const r = g.at('prate', fr, fc);
  if (!Number.isNaN(r)) parts.push(r >= 0.1 ? `rain ${r.toFixed(1)} mm/h` : 'dry');
  const vis = g.at('vis', fr, fc);
  if (!Number.isNaN(vis)) parts.push(`visibility ${vis * NM >= 10 ? '10+' : (vis * NM).toFixed(1)} nm`);
  const sst = g.at('sst', fr, fc);
  if (!Number.isNaN(sst)) parts.push(`sea ${fmtTemp(sst, opts.metric())}`);
  $('pwInfo').textContent = parts.length
    ? `${ll.lat.toFixed(2)}°N ${Math.abs(ll.lng).toFixed(2)}°W, ${$('pwLabel').textContent} (${m.model === 'navy' ? 'Navy' : 'NOAA'}): ${parts.join(' · ')}`
    : 'Outside the forecast area (8–47°N, 100–58°W).';
}

function stopPlay() {
  if (playing) clearInterval(playing);
  playing = null;
  $('pwPlay').textContent = '▶';
}

async function start() {
  if (inited) return;
  inited = true;
  const server = opts.server();
  if (!server) { $('pwInfo').textContent = 'Sailing weather needs the alert server.'; return; }
  map = L.map('pwMap', { zoomControl: true, attributionControl: true, minZoom: 3 });
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 12, attribution: 'Basemap &copy; Esri',
  }).addTo(map);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 12, pane: 'shadowPane',
  }).addTo(map);
  map.attributionControl.addAttribution('NOAA GFS/GFS-Wave · U.S. Navy FNMOC');
  const loc = opts.loc();
  let region = store.get('pwRegion', null);
  if (!region || !REGIONS[region]) {
    region = 'coast';
    if (loc) {
      let best = Infinity;
      for (const [k, r] of Object.entries(REGIONS)) {
        if (k === 'coast' || k === 'tobermuda' || k === 'bdacarib') continue;
        const [[s, w], [n, e]] = r.bounds, d = ((s + n) / 2 - loc.lat) ** 2 + ((w + e) / 2 - loc.lon) ** 2;
        if (d < best) { best = d; region = k; }
      }
    }
  }
  selectRegion(region);
  map.on('moveend', () => { if (product !== 'levels' && state.g) drawVectors(state.m, state.g); });
  map.on('zoomend', () => { if (product === 'levels') drawLevels(); else if (product === 'sst') drawBuoys(); });
  map.on('click', (e) => { if (product !== 'levels') showPoint(e.latlng); });
  try {
    const r = await fetch(`${server}/api/passage/meta`);
    meta = await r.json();
  } catch (e) {
    $('pwInfo').textContent = `Sailing weather unavailable: ${e.message}`;
    return;
  }
  if (!meta[model]) model = meta.noaa ? 'noaa' : 'navy';
  $('pwModel').value = model;
  const m = meta[model];
  if (m) {
    const base = Date.parse(m.base);
    stepIdx = 0;
    m.steps.forEach((h, i) => { if (base + h * 3600000 <= Date.now() + 90 * 60000) stepIdx = i; });
  }
  legend();
  draw();
}

function selectRegion(key) {
  store.set('pwRegion', key);
  [...$('pwRegions').children].forEach((b) => b.classList.toggle('on', b.dataset.region === key));
  if (map) map.fitBounds(REGIONS[key].bounds);
}

export function initPassage(o) {
  opts = o;
  $('pwRegions').innerHTML = Object.entries(REGIONS)
    .map(([k, r]) => `<button class="chip" data-region="${k}">${r.name}</button>`).join('');
  $('pwRegions').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-region]');
    if (b) { if (!inited) start(); selectRegion(b.dataset.region); }
  });
  product = store.get('pwProduct', 'wind');
  model = store.get('pwModel', 'noaa');
  $('pwProduct').value = product;
  $('pwModel').value = model;
  $('pwProduct').addEventListener('change', (e) => { product = e.target.value; store.set('pwProduct', product); legend(); draw(); });
  $('pwModel').addEventListener('change', (e) => {
    const old = meta && meta[model];
    model = e.target.value;
    store.set('pwModel', model);
    const m = meta && meta[model];
    if (old && m) {   // keep the same forecast time when switching models
      const t = Date.parse(old.base) + old.steps[stepIdx] * 3600000;
      let best = 0;
      m.steps.forEach((h, i) => { if (Math.abs(Date.parse(m.base) + h * 3600000 - t) < Math.abs(Date.parse(m.base) + m.steps[best] * 3600000 - t)) best = i; });
      stepIdx = best;
    }
    draw();
  });
  $('pwSlider').addEventListener('input', (e) => { stopPlay(); stepIdx = +e.target.value; draw(); });
  $('pwPlay').addEventListener('click', () => {
    if (playing) return stopPlay();
    $('pwPlay').textContent = '❚❚';
    playing = setInterval(() => {
      const m = meta && meta[model];
      if (!m) return stopPlay();
      stepIdx = (stepIdx + 1) % m.steps.length;
      draw();
    }, 900);
  });
  // Load only when the card scrolls into view.
  const io = new IntersectionObserver((entries) => {
    if (entries.some((x) => x.isIntersecting)) { io.disconnect(); start(); }
  }, { rootMargin: '200px' });
  io.observe($('passageCard'));
}

// Leaflet needs its size re-read after its container was hidden.
export function passageShown() {
  if (map) setTimeout(() => map.invalidateSize(), 0);
}

export function passageUnitsChanged() {
  if (!inited) return;
  legend();
  if (product === 'sst') drawBuoys();
  if (state.tap) showPoint(state.tap);
}
