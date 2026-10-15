// Storm surge maps from NOAA/NHC map services:
//  - Storm Surge Risk (planning): worst-case flooding above ground for a hurricane of each
//    category, from NHC's SLOSH "maximum of maximums". Always available. Atlantic regions only.
//  - Potential Storm Surge Flooding (live): issued per Atlantic storm when storm surge
//    watches/warnings are in effect for the US, plus NHC's peak surge ranges for the coast.

const TROPICAL = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical';
const RISK = `${TROPICAL}/StormSurgeRisk/MapServer`;
const LIVE = `${TROPICAL}/NHC_tropical_weather/MapServer`;
const PEAK = `${TROPICAL}/NHC_PeakStormSurge/MapServer`;

// Depth classes as NHC colours them (pixel value -> label).
export const SURGE_CLASSES = [
  { color: '#0070ff', label: 'Up to 3 ft' },
  { color: '#ffff73', label: 'Over 3 ft' },
  { color: '#ffaa00', label: 'Over 6 ft' },
  { color: '#e60000', label: 'Over 9 ft' },
];

let riskIds = null;   // { 1: [image layer ids for every region], ... 5: [...] }

async function getJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const resp = await fetch(url, { signal: ctl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const j = await resp.json();
    if (j.error) throw new Error(j.error.message || 'Map service error');
    return j;
  } finally {
    clearTimeout(timer);
  }
}

// "Image" layer ids per category across all regions (US, Puerto Rico, Hawaii, Guam, ...).
async function loadRiskIds() {
  if (riskIds) return riskIds;
  const j = await getJson(`${RISK}?f=json`);
  const byId = new Map(j.layers.map((l) => [l.id, l]));
  const ids = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  const top = (l) => { while (l && l.parentLayerId !== -1) l = byId.get(l.parentLayerId); return l; };
  for (const l of j.layers) {
    if (l.name !== 'Image' || (top(l) || {}).name !== 'Atlantic') continue;   // Atlantic side only
    const m = (byId.get(l.parentLayerId) || {}).name?.match(/^Category (\d)$/);
    if (m) ids[m[1]].push(l.id);
  }
  riskIds = ids;
  return ids;
}

// URL builder for a planning map of one category: (xmin, ymin, xmax, ymax in EPSG:3857, w, h).
export async function riskExport(cat) {
  const ids = (await loadRiskIds())[cat] || [];
  return (x0, y0, x1, y1, w, h) => `${RISK}/export?${new URLSearchParams({
    bbox: [x0, y0, x1, y1].map((v) => v.toFixed(0)).join(','), bboxSR: 3857, imageSR: 3857,
    size: `${w},${h}`, format: 'png32', transparent: 'true', layers: `show:${ids.join(',')}`, f: 'image',
  })}`;
}

// URL builder for the live surge forecast of one Atlantic storm bin (e.g. 'AT1').
export async function liveExport(bin) {
  const j = await getJson(`${LIVE}?f=json`);
  const img = j.layers.find((l) => l.name === `Image_Inun_${bin}`);
  if (!img) return null;
  return (x0, y0, x1, y1, w, h) => {
    const p = {
      bbox: [x0, y0, x1, y1].map((v) => v.toFixed(0)).join(','), bboxSR: 3857, imageSR: 3857,
      size: `${w},${h}`, format: 'png32', transparent: 'true', f: 'image',
    };
    return [
      `${LIVE}/export?${new URLSearchParams({ ...p, layers: `show:${img.id}` })}`,
      `${PEAK}/export?${new URLSearchParams({ ...p, layers: 'show:1,2' })}`,
    ];
  };
}

// Surge risk at one point for categories 1-5: { 1: classIndex|-1, ... } (-1 = none mapped).
const riskCache = new Map();
export async function surgeRiskAt(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (riskCache.has(key)) return riskCache.get(key);
  const ids = await loadRiskIds();
  const all = Object.values(ids).flat();
  const d = 0.02;
  const j = await getJson(`${RISK}/identify?${new URLSearchParams({
    geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', sr: 4326,
    layers: `all:${all.join(',')}`, tolerance: 1,
    mapExtent: `${lon - d},${lat - d},${lon + d},${lat + d}`, imageDisplay: '400,400,96',
    returnGeometry: 'false', f: 'json',
  })}`);
  const out = { 1: -1, 2: -1, 3: -1, 4: -1, 5: -1 };
  for (const r of j.results || []) {
    const cat = Object.keys(ids).find((c) => ids[c].includes(r.layerId));
    const v = parseInt(r.attributes['Service Pixel Value'], 10);
    if (cat && v >= 1 && v <= 4) out[cat] = Math.max(out[cat], v - 1);
  }
  riskCache.set(key, out);
  return out;
}

// "Category 3: up to 3 ft · Category 4-5: over 3 ft", or '' when no category floods here.
export function riskSummary(risk) {
  const parts = [];
  let start = null;
  for (let c = 1; c <= 6; c++) {
    const v = c <= 5 ? risk[c] : -2;
    if (start !== null && v !== risk[start]) {
      if (risk[start] >= 0) {
        const range = start === c - 1 ? `Category ${start}` : `Category ${start}–${c - 1}`;
        parts.push(`${range}: ${SURGE_CLASSES[risk[start]].label.toLowerCase()}`);
      }
      start = null;
    }
    if (start === null && c <= 5) start = c;
  }
  return parts.join(' · ');
}
