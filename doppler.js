// Doppler winds: each NEXRAD radar's VAD Wind Profile (Level III product NVW), from NOAA's
// public Level III archive on AWS. The radar derives a true wind direction and speed at
// each height from the Doppler shift around a full scan. We use the average of the levels
// from 10,000 to 20,000 ft (roughly 700-500 hPa), the steering layer that carries rain.

const BUCKET = 'https://unidata-nexrad-level3.s3.amazonaws.com';
const MIN_FT = 10000, MAX_FT = 20000;
const MAX_AGE_MIN = 60;
const cache = new Map();   // site -> { at, wind }

const ymd = (d) => `${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}_${String(d.getUTCDate()).padStart(2, '0')}`;

async function getText(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const resp = await fetch(url, { signal: ctl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

// Key of the newest wind profile for a site (today's list, or yesterday's just after midnight UTC).
async function latestKey(site) {
  for (const back of [0, 1]) {
    const day = ymd(new Date(Date.now() - back * 86400000));
    const xml = await (await getText(`${BUCKET}/?list-type=2&prefix=${site}_NVW_${day}`)).text();
    const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]).sort();
    if (keys.length) return keys[keys.length - 1];
  }
  return null;
}

function keyTime(key) {
  const m = key.match(/_(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})$/);
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

// Reads the "VAD Algorithm Output" table: ALT(100 ft) U(m/s) V(m/s) W DIR(deg) SPD(kt) RMS(kt) ...
export function parseVad(bytes) {
  const text = new TextDecoder('latin1').decode(bytes);
  const rows = new Map();
  for (const line of text.split(/[^\x20-\x7e]+/)) {
    // Each row starts after a one-byte length that may print as a letter, so don't anchor.
    const m = line.match(/(?:^|\s)(\d{3})\s+(-?\d+\.\d)\s+(-?\d+\.\d)\s+\S+\s+(\d{3})\s+(\d{3})\s+(\d+\.\d|NA)/);
    if (m) rows.set(+m[1] * 100, { ft: +m[1] * 100, u: +m[2], v: +m[3], rms: m[6] === 'NA' ? 0 : +m[6] });
  }
  return [...rows.values()].sort((a, b) => a.ft - b.ft);
}

// Mean steering-level wind from the profile, ignoring noisy levels; null if none usable.
export function steeringWind(levels) {
  const use = levels.filter((l) => l.ft >= MIN_FT && l.ft <= MAX_FT && l.rms <= 6);
  if (!use.length) return null;
  const u = use.reduce((s, l) => s + l.u, 0) / use.length;
  const v = use.reduce((s, l) => s + l.v, 0) / use.length;
  return { u, v, levels: use.length };
}

async function siteWind(site) {
  const hit = cache.get(site);
  if (hit && Date.now() - hit.at < 5 * 60000) return hit.wind;
  let wind = null;
  try {
    const key = await latestKey(site);
    if (key && Date.now() - keyTime(key) < MAX_AGE_MIN * 60000) {
      const bytes = new Uint8Array(await (await getText(`${BUCKET}/${key}`)).arrayBuffer());
      const w = steeringWind(parseVad(bytes));
      if (w) wind = { ...w, time: keyTime(key) };
    }
  } catch { /* site unavailable: just skip it */ }
  cache.set(site, { at: Date.now(), wind });
  return wind;
}

// Doppler steering winds for the given radar sites ([id, lat, lon]). u is east, v is north, m/s.
export async function dopplerWinds(sites) {
  const out = await Promise.all(sites.map(async ([id, lat, lon]) => {
    const w = await siteWind(id);
    return w && { id, lat, lon, ...w };
  }));
  return out.filter(Boolean);
}
