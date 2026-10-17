// NHC Tropical Weather Outlook for the Atlantic: the text (api.weather.gov, product TWO,
// location AT) and the map areas NHC is watching, with 2- and 7-day formation chances and
// expected motion (NOAA's NHC_tropical_weather map service). Atlantic basin only.

const SERVICE = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';
const NWS = 'https://api.weather.gov';
const CACHE_MS = 15 * 60000;
const BASIN = 'Atlantic';
let cached = null;

async function getJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const headers = { Accept: 'application/geo+json, application/json' };
    // NWS asks servers to identify themselves; browsers send their own User-Agent.
    if (typeof window === 'undefined') headers['User-Agent'] = 'WxNow alert server (github.com/jlblan2/wx-now)';
    const resp = await fetch(url, { signal: ctl.signal, headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// Layer ids by name, so a reshuffle of the service doesn't break us.
async function layerIds() {
  const j = await getJson(`${SERVICE}?f=json`);
  const find = (name) => (j.layers.find((l) => l.name === name) || {}).id;
  return {
    now2: find('Two-Day: Current Location'),
    now7: find('Seven-Day: Current Location'),
    areas: find('Seven-Day: Potential Development Region'),
    motion: find('Seven-Day: Development Motion'),
  };
}

const query = (id) => (id === undefined ? Promise.resolve([])
  : getJson(`${SERVICE}/${id}/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson`).then((j) => j.features || []));

// The outlook text: issue time, the opening statement and each numbered disturbance.
function parseText(text) {
  const t = text.replace(/\r/g, '');
  const issued = (t.match(/^\d{3,4} [AP]M [A-Z]{3} \w{3} \w{3} \d{1,2} \d{4}$/m) || [''])[0];
  const start = t.search(/^For the North Atlantic/m);
  const end = t.indexOf('$$');
  const body = t.slice(start >= 0 ? start : 0, end > 0 ? end : undefined);
  // Paragraphs, with each area heading ("Eastern Tropical Atlantic:") and each
  // "* Formation chance..." line split out on its own.
  const paras = [];
  for (const block of body.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length > 1 && /:$/.test(lines[0]) && lines[0].length < 70) paras.push(lines.shift());
    let cur = [];
    for (const l of lines) {
      if (l.startsWith('* ')) { if (cur.length) paras.push(cur.join(' ')); cur = [l]; } else cur.push(l);
    }
    if (cur.length) paras.push(cur.join(' '));
  }
  const forecaster = (t.match(/^Forecaster (.+)$/m) || [, ''])[1];
  return { issued, paras, forecaster };
}

export async function tropicalOutlook() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;
  const [text, ids] = await Promise.all([
    getJson(`${NWS}/products/types/TWO/locations/AT`)
      .then((l) => (l['@graph'] && l['@graph'][0] ? getJson(`${NWS}/products/${l['@graph'][0].id}`) : null))
      .catch(() => null),
    layerIds(),
  ]);
  const [now2, now7, areas, motion] = await Promise.all([ids.now2, ids.now7, ids.areas, ids.motion].map((id) => query(id).catch(() => null)));
  const atl = (fs) => (fs || []).filter((f) => (f.properties.basin || '') === BASIN);
  const data = {
    text: text ? parseText(text.productText || '') : null,
    textTime: text ? text.issuanceTime : null,
    areas: atl(areas), motion: atl(motion), points: [...atl(now2), ...atl(now7)],
    areasOk: areas !== null && ids.areas !== undefined,   // false when the map service failed
  };
  cached = { at: Date.now(), data };
  return data;
}

export const RISK_COLORS = { Low: '#ffd23f', Medium: '#ff9a3c', High: '#ff4d4d' };
