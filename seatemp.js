// Water temperature (Seas & swell): the sea-surface temperature at the spot and its 5-day
// range from Open-Meteo's marine model, plus what the nearest NOAA buoys and coastal
// stations measure right now (water temperature, waves, wind), from the alert server.

const $ = (id) => document.getElementById(id);
let opts;
let buoys = null;
let token = 0;

// The buoy set is shared with the Sailing weather sea-temperature map.
export async function loadBuoys(server) {
  if (buoys && Date.now() - buoys.fetched < 10 * 60000) return buoys;
  const r = await fetch(`${server}/api/buoys`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  buoys = { ...j, fetched: Date.now() };
  return buoys;
}

export const cToF = (c) => c * 9 / 5 + 32;
export function fmtTemp(c, metric) {
  return metric ? `${c.toFixed(1)} °C` : `${Math.round(cToF(c))} °F`;
}

function distNm(a, b) {
  const R = 3440.065, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const toR = Math.PI / 180, y = Math.sin((b.lon - a.lon) * toR) * Math.cos(b.lat * toR);
  const x = Math.cos(a.lat * toR) * Math.sin(b.lat * toR) - Math.sin(a.lat * toR) * Math.cos(b.lat * toR) * Math.cos((b.lon - a.lon) * toR);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];

function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

async function modelSst(loc) {
  const q = `latitude=${loc.lat.toFixed(3)}&longitude=${loc.lon.toFixed(3)}&current=sea_surface_temperature` +
    '&hourly=sea_surface_temperature&forecast_days=5&timezone=auto';
  const r = await fetch(`https://marine-api.open-meteo.com/v1/marine?${q}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const days = new Map();
  (j.hourly?.time || []).forEach((t, i) => {
    const v = j.hourly.sea_surface_temperature[i];
    if (v === null || v === undefined) return;
    const d = t.slice(0, 10), x = days.get(d) || { lo: v, hi: v };
    days.set(d, { lo: Math.min(x.lo, v), hi: Math.max(x.hi, v) });
  });
  return { now: j.current?.sea_surface_temperature ?? null, days: [...days].map(([d, x]) => ({ d, ...x })) };
}

function buoyRow(b, loc, metric) {
  const d = distNm(loc, b);
  const where = d < 1 ? 'here' : `${Math.round(d)} nm ${compass(bearing(loc, b))}`;
  const bits = [];
  if (b.wtmp !== null) bits.push(`<b>water ${fmtTemp(b.wtmp, metric)}</b>`);
  if (b.atmp !== null) bits.push(`air ${fmtTemp(b.atmp, metric)}`);
  if (b.wvht !== null) {
    bits.push(`waves ${metric ? `${b.wvht.toFixed(1)} m` : `${Math.round(b.wvht * 3.28084)} ft`}` +
      `${b.dpd !== null ? ` at ${Math.round(b.dpd)} s` : ''}${b.mwd !== null ? ` from ${compass(b.mwd)}` : ''}`);
  }
  if (b.wspd !== null) {
    bits.push(`wind ${b.wdir !== null ? `${compass(b.wdir)} ` : ''}${Math.round(b.wspd * 1.94384)} kt` +
      `${b.gst !== null ? `, gusts ${Math.round(b.gst * 1.94384)}` : ''}`);
  }
  const name = b.name ? `${opts.esc(b.name)} ` : '';
  return `<tr><th>${name}<span class="wt-id">${opts.esc(b.id)}</span><br><span class="wt-where">${where} · ${ago(b.t)}</span></th>` +
    `<td>${bits.map((x) => `<span>${x}</span>`).join('')}</td></tr>`;
}

export async function showWaterTemp(loc) {
  const my = ++token, metric = opts.metric();
  $('wtNow').textContent = 'Loading…';
  const [sst, near] = await Promise.all([
    modelSst(loc).catch(() => null),
    opts.server() ? loadBuoys(opts.server()).catch((e) => ({ error: e.message })) : Promise.resolve({ error: 'needs the alert server' }),
  ]);
  if (my !== token) return;

  if (sst && sst.now !== null) {
    const lo = Math.min(...sst.days.map((x) => x.lo)), hi = Math.max(...sst.days.map((x) => x.hi));
    $('wtNow').innerHTML = `Sea surface here: <b>${fmtTemp(sst.now, metric)}</b>` +
      (sst.days.length ? ` · next 5 days ${fmtTemp(lo, metric)} to ${fmtTemp(hi, metric)}` : '');
  } else {
    $('wtNow').textContent = sst ? 'No sea temperature for this spot (it is on land); nearest stations below.'
      : 'Sea temperature forecast unavailable right now.';
  }

  if (near.error) {
    $('wtTable').innerHTML = '';
    $('wtMeta').textContent = `Buoy reports unavailable: ${near.error}`;
    return;
  }
  const list = near.stations
    .filter((b) => b.wtmp !== null)
    .map((b) => ({ b, d: distNm(loc, b) }))
    .filter((x) => x.d <= 250)
    .sort((a, b) => a.d - b.d)
    .slice(0, 6);
  $('wtTable').innerHTML = list.length
    ? `<table>${list.map((x) => buoyRow(x.b, loc, metric)).join('')}</table>`
    : '<p class="note">No buoy or station measuring water temperature within 250 nm.</p>';
  $('wtMeta').textContent = 'Measured by NOAA buoys and coastal stations (National Data Buoy Center), reports from the last 6 hours. ' +
    'Sea surface forecast: Open-Meteo marine model. The Sailing weather map has a sea-temperature chart too.';
}

export function initWaterTemp(o) { opts = o; }
