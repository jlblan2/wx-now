// Water clarity (Seas & swell), three satellite sources side by side for testing:
//  - NOAA VIIRS 750 m (NOAA-20/21), Kd490, via the alert server (ERDDAP has no CORS).
//  - Copernicus Marine 4 km gap-free daily analysis: Secchi depth (ZSD) and Kd490, straight
//    from its public WMTS (GetFeatureInfo); no account needed.
//  - Sentinel-2 10-20 m, Kd490 worked out from the blue/green ratio over water pixels, via the
//    Copernicus Data Space Sentinel Hub Statistical API with the user's own OAuth client
//    (kept on this phone, sent only to Copernicus).
// Kd490 (1/m) is diffuse attenuation at 490 nm; lower is clearer.

const $ = (id) => document.getElementById(id);
let opts;
let token = 0;

// Visibility (Secchi depth, m) from Kd490: fitted to Copernicus Marine's own ZSD and KD490 at 21
// points from Texas to Virginia, 27 Oct 2026 (Zsd*Kd 0.68-0.97, median 0.74).
export function visibilityM(kd) {
  return Math.min(40, Math.max(0.1, 0.534 * kd ** -1.171));
}

export function describe(m) {
  if (m >= 10) return 'very clear';
  if (m >= 5) return 'clear';
  if (m >= 2) return 'fair';
  if (m >= 1) return 'murky';
  return 'very murky';
}

const fmtDepth = (m, metric) => (metric ? `${m < 10 ? m.toFixed(1) : Math.round(m)} m` : `${Math.round(m * 3.28084)} ft`);

function daysAgo(t) {
  const d = Math.floor((Date.now() - Date.parse(t)) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
}
const shortDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// ---------- NOAA VIIRS (through the alert server) ----------
async function viirs(loc) {
  const server = opts.server();
  if (!server) throw new Error('needs the alert server');
  const r = await fetch(`${server}/api/clarity?lat=${loc.lat.toFixed(3)}&lon=${loc.lon.toFixed(3)}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  if (!j.reading) return { none: `no clear view of the water within 4 km in the last ${j.days} days` };
  const x = j.reading;
  return { kd: x.kd, t: x.t, km: x.km, note: `${x.sat}, median of ${x.n} nearest pixels` };
}

// ---------- Copernicus Marine (public WMTS) ----------
const CMEMS_WMTS = 'https://wmts.marine.copernicus.eu/teroWmts';
const CMEMS_LAYER = 'OCEANCOLOUR_GLO_BGC_L4_NRT_009_102/cmems_obs-oc_glo_bgc-transp_nrt_l4-gapfree-multi-4km_P1D_202311';
const CMEMS_STEP = 1 / 24;   // grid spacing, degrees (4 km)

async function cmemsValue(lat, lon, variable, day) {
  const z = 8, span = 180 / 2 ** z;
  const x = (lon + 180) / span, y = (90 - lat) / span;
  const col = Math.floor(x), row = Math.floor(y);
  const q = new URLSearchParams({
    SERVICE: 'WMTS', VERSION: '1.0.0', REQUEST: 'GetFeatureInfo', LAYER: `${CMEMS_LAYER}/${variable}`, STYLE: '',
    TILEMATRIXSET: 'EPSG:4326', TILEMATRIX: String(z), TILEROW: String(row), TILECOL: String(col),
    I: String(Math.floor((x - col) * 256)), J: String(Math.floor((y - row) * 256)),
    INFOFORMAT: 'application/json', time: `${day}T00:00:00Z`,
  });
  const r = await fetch(`${CMEMS_WMTS}?${q}`);
  if (r.status === 400) return undefined;   // that day isn't published yet
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const p = (await r.json()).features?.[0]?.properties;
  return p ? { value: p.value, lat: p.lat, lon: p.lon } : undefined;
}

async function cmems(loc) {
  // Newest published day: ask for the last five at once (usually 2 days behind).
  const days = [1, 2, 3, 4, 5].map((n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10));
  const tries = await Promise.all(days.map((d) => cmemsValue(loc.lat, loc.lon, 'ZSD', d).catch(() => undefined)));
  const i = tries.findIndex((x) => x !== undefined);
  if (i < 0) throw new Error('Copernicus Marine did not answer');
  const day = days[i];
  let hit = tries[i];
  // The gap-free analysis has no cloud gaps, so no value means land: look one and two cells out.
  for (let ring = 1; hit.value === null && ring <= 2; ring++) {
    const d = ring * CMEMS_STEP, around = [];
    for (const dy of [-d, 0, d]) for (const dx of [-d, 0, d]) if (dx || dy) around.push([loc.lat + dy, loc.lon + dx]);
    const got = (await Promise.all(around.map(([la, lo]) => cmemsValue(la, lo, 'ZSD', day).catch(() => undefined))))
      .filter((g) => g && g.value !== null)
      .sort((a, b) => dist(loc, a) - dist(loc, b));
    if (got.length) hit = got[0];
  }
  if (hit.value === null) return { none: 'no ocean cell within about 8 km (land or inland water)' };
  const kd = await cmemsValue(hit.lat, hit.lon, 'KD490', day).catch(() => null);
  return { zsd: hit.value, kd: kd?.value ?? null, t: `${day}T12:00:00Z`, km: dist(loc, hit), note: 'gap-free daily analysis (clouds filled from nearby days)' };
}

function dist(a, b) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------- Sentinel-2 (Copernicus Data Space, user's OAuth client) ----------
const S2_TOKEN = 'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';
const S2_STATS = 'https://sh.dataspace.copernicus.eu/api/v1/statistics';
const S2_BOX = 0.006;   // degrees each side (about 650 m)
const S2_DAYS = 20;
let s2Token = null;

const get = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const put = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* not saved */ } };
export const s2Creds = () => ({ id: get('clarity.s2id'), secret: get('clarity.s2secret') });
export function setS2Creds(id, secret) { put('clarity.s2id', id.trim()); put('clarity.s2secret', secret.trim()); s2Token = null; }

async function s2AccessToken() {
  if (s2Token && Date.now() < s2Token.until) return s2Token.value;
  const { id, secret } = s2Creds();
  const r = await fetch(S2_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || `sign-in HTTP ${r.status}`);
  s2Token = { value: j.access_token, until: Date.now() + (j.expires_in - 60) * 1000 };
  return s2Token.value;
}

// Water pixels only (scene classification 6), clear of cloud. Kd490 from the NASA KD2S
// blue/green band-ratio polynomial (490 nm ~ B02, 555 nm ~ B03).
const S2_EVALSCRIPT = `//VERSION=3
function setup() {
  return { input: [{ bands: ["B02", "B03", "SCL", "dataMask"] }],
           output: [{ id: "kd", bands: 1, sampleType: "FLOAT32" }, { id: "dataMask", bands: 1 }] };
}
function evaluatePixel(s) {
  var ok = s.dataMask === 1 && s.SCL === 6 && s.B02 > 0 && s.B03 > 0;
  if (!ok) return { kd: [0], dataMask: [0] };
  var x = Math.log(s.B02 / s.B03) / Math.LN10;
  var lg = -0.8515 - 1.8263 * x + 1.8714 * x * x - 2.4414 * x * x * x - 1.0690 * x * x * x * x;
  return { kd: [0.0166 + Math.pow(10, lg)], dataMask: [1] };
}`;

async function sentinel2(loc) {
  const { id, secret } = s2Creds();
  if (!id || !secret) return { none: 'add your Copernicus Data Space OAuth client in Settings to try it' };
  const access = await s2Step('sign-in', s2AccessToken);
  const to = new Date(), from = new Date(Date.now() - S2_DAYS * 86400000);
  const body = {
    input: {
      bounds: {
        bbox: [loc.lon - S2_BOX, loc.lat - S2_BOX, loc.lon + S2_BOX, loc.lat + S2_BOX],
        properties: { crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84' },
      },
      data: [{ type: 'sentinel-2-l2a', dataFilter: { maxCloudCoverage: 70 } }],
    },
    aggregation: {
      timeRange: { from: from.toISOString(), to: to.toISOString() },
      aggregationInterval: { of: 'P1D' },
      evalscript: S2_EVALSCRIPT,
      resx: 0.0002, resy: 0.0002,   // about 20 m, the resolution of the scene classification
    },
    calculations: { default: { statistics: { default: { percentiles: { k: [50] } } } } },
  };
  return s2Step('data request', async () => {
    const r = await fetch(S2_STATS, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error?.message || j.message || `HTTP ${r.status}`);
    return pickS2(j.data || []);
  });
}

// Safari reports any blocked or dropped request only as "Load failed", so say which step it
// was and how long it ran (a gateway timeout comes back without CORS headers).
async function s2Step(name, fn) {
  const t0 = Date.now();
  try {
    return await fn();
  } catch (e) {
    const s = Math.round((Date.now() - t0) / 1000);
    const dropped = e instanceof TypeError;
    throw new Error(`${name} ${dropped ? 'got no answer' : 'failed'} after ${s} s` +
      `${dropped ? ' (blocked or timed out)' : ''}: ${e.message}`);
  }
}

// Newest day with at least 20 clear water pixels.
export function pickS2(data) {
  const days = data
    .map((d) => {
      const s = d.outputs?.kd?.bands?.B0?.stats;
      const n = s ? s.sampleCount - s.noDataCount : 0;
      return { t: d.interval.from, n, kd: s?.percentiles?.['50.0'] ?? s?.mean };
    })
    .filter((d) => d.n >= 20 && d.kd > 0)
    .sort((a, b) => (a.t < b.t ? 1 : -1));
  if (!days.length) return { none: `no cloud-free pass over water near here in the last ${S2_DAYS} days` };
  const x = days[0];
  return { kd: x.kd, t: x.t, km: 0, note: `median of ${x.n} water pixels within about 650 m` };
}

// ---------- card ----------
const SOURCES = [
  { key: 'viirs', name: 'NOAA VIIRS', res: '750 m, daily', run: viirs },
  { key: 'cmems', name: 'Copernicus Marine', res: '4 km, daily', run: cmems },
  { key: 's2', name: 'Sentinel-2', res: '10–20 m, every ~5 days', run: sentinel2 },
];

function row(src, res, metric) {
  const head = `<th>${src.name}<br><span class="wt-where">${src.res}</span></th>`;
  if (!res) return `<tr>${head}<td><span>Loading…</span></td></tr>`;
  if (res.error) return `<tr>${head}<td><span class="cl-none">Unavailable: ${opts.esc(res.error)}</span></td></tr>`;
  if (res.none) return `<tr>${head}<td><span class="cl-none">No reading: ${opts.esc(res.none)}</span></td></tr>`;
  const vis = res.zsd ?? visibilityM(res.kd);
  const bits = [
    `<b>see about ${fmtDepth(vis, metric)}</b> (${describe(vis)})`,
    res.kd !== null && res.kd !== undefined ? `Kd490 ${res.kd.toFixed(3)} /m` : null,
    `${shortDate(res.t)}, ${daysAgo(res.t)}`,
    res.km >= 1 ? `${Math.round(res.km)} km from here` : null,
    opts.esc(res.note),
  ].filter(Boolean);
  return `<tr>${head}<td>${bits.map((b) => `<span>${b}</span>`).join('')}</td></tr>`;
}

export async function showClarity(loc) {
  const my = ++token, metric = opts.metric();
  const results = {};
  const draw = () => {
    if (my !== token) return;
    $('clarityTable').innerHTML = `<table>${SOURCES.map((s) => row(s, results[s.key], metric)).join('')}</table>`;
  };
  draw();
  await Promise.all(SOURCES.map(async (s) => {
    try { results[s.key] = await s.run(loc); } catch (e) { results[s.key] = { error: e.message }; }
    draw();
  }));
}

export function initClarity(o) { opts = o; }
