// Effects on people: what the forecast's cold, heat, humidity, wind, sunshine/UV and cloud cover
// will do to a person outdoors, for each of the 7 days. Everything is worked out from the
// Open-Meteo forecast the app already fetches (model.js); nothing else is downloaded.
// Inputs are metric (°C, km/h, %, W/m²); the UI converts for display.

import { wetBulb } from './forecast.js';

const toF = (c) => c * 9 / 5 + 32;
const toC = (f) => (f - 32) * 5 / 9;
const mph = (kmh) => kmh * 0.621371;

// NWS heat index (Rothfusz regression with the NWS adjustments), °F in and out.
export function heatIndexF(tf, rh) {
  const simple = 0.5 * (tf + 61 + (tf - 68) * 1.2 + rh * 0.094);
  if ((simple + tf) / 2 < 80) return simple;
  let hi = -42.379 + 2.04901523 * tf + 10.14333127 * rh - 0.22475541 * tf * rh - 0.00683783 * tf * tf -
    0.05481717 * rh * rh + 0.00122874 * tf * tf * rh + 0.00085282 * tf * rh * rh - 0.00000199 * tf * tf * rh * rh;
  if (rh < 13 && tf >= 80 && tf <= 112) hi -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(tf - 95)) / 17);
  else if (rh > 85 && tf >= 80 && tf <= 87) hi += ((rh - 85) / 10) * ((87 - tf) / 5);
  return hi;
}

// NWS wind chill, °F and mph. Defined only at or below 50 °F with at least 3 mph of wind.
export function windChillF(tf, v) {
  if (tf > 50 || v < 3) return tf;
  const p = v ** 0.16;
  return Math.min(tf, 35.74 + 0.6215 * tf - 35.75 * p + 0.4275 * tf * p);
}

// What the air feels like on skin in the shade, °C: wind chill when cold, heat index when hot.
export function feelsLikeC(t, rh, kmh) {
  const tf = toF(t);
  if (tf <= 50) return toC(windChillF(tf, mph(kmh)));
  if (tf >= 80 && rh !== null) return toC(heatIndexF(tf, rh));
  return t;
}

// Wet Bulb Globe Temperature estimate, °C, for a person in the open (in the sun by day).
// WBGT = 0.7·natural wet bulb + 0.2·black globe + 0.1·air. The globe is warmed by sunshine
// and cooled by wind; the natural wet bulb sits a little above the psychrometric wet bulb in sun.
// A rough estimate from forecast data, not a measurement.
export function wbgtC(t, rh, kmh, solar = 0) {
  if (rh === null || rh === undefined) return null;
  const v = Math.max(0.5, kmh / 3.6);                     // m/s
  const s = Math.max(0, solar || 0);
  const globe = t + 0.0175 * s / (1 + 0.15 * v);
  const nwb = wetBulb(t, Math.min(99, Math.max(5, rh))) + 0.15 * (globe - t);
  return 0.7 * nwb + 0.2 * globe + 0.1 * t;
}

// Minutes until exposed skin freezes (Environment Canada, Tikuisis & Osczevski), null when
// frostbite is not a risk. t in °C, wind in km/h at 10 m.
export function frostbiteMin(t, kmh) {
  if (t > -4.8) return null;
  const min = (-24.5 * (0.667 * kmh + 4.8) + 2111) * (-4.8 - t) ** -1.668;
  return min > 0 && min <= 30 ? min : null;   // beyond 30 min the risk is low
}

// Minutes to a first sunburn on unprotected skin: fair skin that always burns, and medium skin
// that sometimes burns (minimal erythema doses of about 200 and 300 J/m²; UV index 1 = 25 mW/m²).
export function burnMin(uv) {
  if (!(uv >= 1)) return null;
  return { fair: 133 / uv, medium: 200 / uv };
}

const HEAT_WORDS = ['', 'Caution', 'Extreme caution', 'Danger', 'Extreme danger'];
const COLD_WORDS = ['', 'Cold', 'Very cold', 'Frostbite danger', 'Extreme cold'];
const UV_WORDS = ['Low', 'Moderate', 'High', 'Very high', 'Extreme'];
const WIND_WORDS = ['', 'Breezy', 'Strong wind', 'Damaging wind', 'Violent wind'];
const LEVEL_WORDS = ['Low risk', 'Take care', 'High risk', 'Dangerous', 'Extreme'];

const uvLevel = (uv) => (uv >= 11 ? 4 : uv >= 8 ? 3 : uv >= 6 ? 2 : uv >= 3 ? 1 : 0);

function heatLevel(hiF, wbgtF) {
  const a = hiF >= 125 ? 4 : hiF >= 103 ? 3 : hiF >= 90 ? 2 : hiF >= 80 ? 1 : 0;
  const b = wbgtF >= 90 ? 4 : wbgtF >= 88 ? 3 : wbgtF >= 85 ? 2 : wbgtF >= 80 ? 1 : 0;
  return Math.max(a, b);
}

function coldLevel(wcF, frost) {
  if (frost !== null && frost <= 10) return 4;
  if (frost !== null || wcF <= -18) return 3;
  if (wcF <= 0) return 2;
  if (wcF <= 32) return 1;
  return 0;
}

// Dew point comfort (°F): how sticky the air feels, whatever the temperature.
const DEW_WORDS = ['Dry', 'Comfortable', 'Sticky', 'Muggy', 'Oppressive', 'Miserable'];
export const dewLevel = (dF) => (dF >= 75 ? 5 : dF >= 70 ? 4 : dF >= 65 ? 3 : dF >= 60 ? 2 : dF >= 50 ? 1 : 0);

// Lightning: 2 = thunderstorms likely, 1 = possible, 0 = unlikely. From the model's thunderstorm
// codes (95-99), the chance of rain and CAPE (the energy available to storms).
export function lightningLevel(thunderHours, pop, cape) {
  if (thunderHours >= 1 && pop >= 50) return 2;
  if (thunderHours >= 1 || (cape >= 1000 && pop >= 30)) return 1;
  return 0;
}

// The night after each day (8 pm to 7 am): -2/-1 cold, 0 fine, 1-3 too warm to sleep well.
export function nightLevel(minT, minFeels) {
  const tf = toF(minT), ff = toF(minFeels);
  if (tf >= 80 || ff >= 85) return 3;
  if (tf >= 75) return 2;
  if (tf >= 70 && ff >= 72) return 1;
  if (tf <= 10) return -2;
  if (tf <= 32) return -1;
  return 0;
}
const NIGHT_WORDS = { '-2': 'Bitter cold night', '-1': 'Freezing night', 0: 'Comfortable for sleeping', 1: 'Warm, sticky night', 2: 'Too warm to sleep well without A/C', 3: 'No relief from the heat overnight' };

const lowerFirst = (t) => t.charAt(0).toLowerCase() + t.slice(1);

const windLevel = (gMph) => (gMph >= 75 ? 4 : gMph >= 58 ? 3 : gMph >= 40 ? 2 : gMph >= 25 ? 1 : 0);

// One day's effects from its hours (local midnight to midnight) and the daily values.
export function dayEffects(day, hours, night = []) {
  const hs = hours.filter((h) => Number.isFinite(h.temp));
  let maxFeels = -Infinity, minFeels = Infinity, maxWbgt = -Infinity, frost = null, minRh = Infinity;
  let wetCold = 0, uvHour = 0, cloudSum = 0, cloudN = 0, maxHotWind = false;
  let maxDew = -Infinity, thunder = 0, maxCape = 0;
  for (const h of hs) {
    const f = feelsLikeC(h.temp, h.rh, h.wind);
    maxFeels = Math.max(maxFeels, f);
    minFeels = Math.min(minFeels, f);
    const w = wbgtC(h.temp, h.rh, h.wind, h.day ? h.sun : 0);
    if (w !== null) maxWbgt = Math.max(maxWbgt, w);
    const fb = frostbiteMin(h.temp, h.wind);
    if (fb !== null) frost = frost === null ? fb : Math.min(frost, fb);
    if (h.day && h.rh !== null) minRh = Math.min(minRh, h.rh);
    if ((h.precip || 0) >= 0.2 && h.temp > -2 && h.temp <= 10) wetCold++;
    if (h.uv > uvHour) uvHour = h.uv;
    if (h.day && h.cloud !== null && h.cloud !== undefined) { cloudSum += h.cloud; cloudN++; }
    if (toF(h.temp) >= 99 && mph(h.wind) >= 10) maxHotWind = true;
    if (Number.isFinite(h.dew)) maxDew = Math.max(maxDew, h.dew);
    if (h.code >= 95) thunder++;
    if (h.cape > maxCape) maxCape = h.cape;
  }
  const nt = night.filter((h) => Number.isFinite(h.temp));
  const nightMin = nt.length ? Math.min(...nt.map((h) => h.temp)) : null;
  const nightFeels = nt.length ? Math.min(...nt.map((h) => feelsLikeC(h.temp, h.rh, h.wind))) : null;
  const nightL = nightMin === null ? null : nightLevel(nightMin, nightFeels);
  if (!hs.length) return null;
  const uv = day.uvMax ?? uvHour;
  const hiF = toF(maxFeels), wcF = toF(minFeels), wbgtF = Number.isFinite(maxWbgt) ? toF(maxWbgt) : -99;
  const gustMph = mph(day.gust ?? day.wind ?? 0);
  const heat = heatLevel(hiF, wbgtF);
  const cold = Math.max(coldLevel(wcF, frost), wetCold >= 2 ? 1 : 0);
  const uvL = uvLevel(uv), wind = windLevel(gustMph);
  const dry = Number.isFinite(minRh) && minRh < 25;
  const dewL = Number.isFinite(maxDew) ? dewLevel(toF(maxDew)) : null;
  const lightning = lightningLevel(thunder, day.pop ?? 0, maxCape);
  const dehyd = heat >= 2 ? 2 : (heat === 1 || dry || (cold >= 2 && mph(day.wind) >= 15)) ? 1 : 0;
  return {
    maxFeels, minFeels, wbgt: Number.isFinite(maxWbgt) ? maxWbgt : null, frost, uv, burn: burnMin(uv),
    minRh: Number.isFinite(minRh) ? minRh : null, wetCold, cloud: cloudN ? cloudSum / cloudN : null,
    sunHours: day.sunHours, dayHours: day.dayHours, gust: day.gust, wind: day.wind, hotWind: maxHotWind,
    heat, cold, uvL, windL: wind, dehyd, dry,
    dew: Number.isFinite(maxDew) ? maxDew : null, dewL, lightning, thunderHours: thunder, cape: maxCape,
    nightMin, nightL,
    // Moderate UV and a breeze alone don't make a day risky; high UV, strong wind, likely
    // lightning and nights too hot to cool off do.
    level: Math.max(heat, cold, Math.max(0, uvL - 1), Math.max(0, wind - 1), lightning,
      nightL > 0 ? nightL - 1 : 0, nightL === -2 ? 1 : 0),
  };
}

// Split the week's hours into the 7 local days and work out each one.
export function weekEffects(model) {
  if (!model || !model.days || !model.week) return [];
  return model.days.map((d, i) => {
    const end = i + 1 < model.days.length ? model.days[i + 1].time : d.time + 86400000;
    const night = model.week.filter((h) => h.time >= d.time + 20 * 3600000 && h.time < d.time + 31 * 3600000);
    return { day: d, fx: dayEffects(d, model.week.filter((h) => h.time >= d.time && h.time < end), night) };
  }).filter((x) => x.fx);
}

// ---------- plain-language advice ----------

function advice(fx, o) {
  const { fmtTemp, fmtSpeed, metric } = o;
  const water = (oz, ml) => (metric() ? `${ml} ml` : `${oz} oz`);
  const out = [];
  if (fx.heat >= 3) out.push(`Heat illness is likely with long exposure or hard work. Do outdoor jobs before 10 am or after 6 pm, rest in shade or air conditioning every 20–30 minutes, and check on older neighbours, babies and anyone without A/C. Never leave children or pets in a car.`);
  else if (fx.heat === 2) out.push(`Heat cramps and heat exhaustion are possible with long exposure or work. Take breaks in the shade, wear light loose clothing, and ease into hard work.`);
  else if (fx.heat === 1) out.push(`Warm enough to tire you out with long exposure. Pace yourself in the afternoon.`);
  if (fx.hotWind) out.push(`Air above about ${fmtTemp(37)}: a fan or breeze no longer cools you and can add heat. Shade, water and cool water on the skin work better.`);
  if (fx.dehyd === 2) out.push(`Drink about 1 cup (${water(8, 250)}) of water every 15–20 minutes while working outdoors, even if you are not thirsty, but no more than about ${metric() ? '1.4 L' : '48 oz'} an hour. Add a sports drink or salty snack if you sweat for more than 2 hours.`);
  else if (fx.dehyd === 1) out.push(fx.dry && fx.heat === 0
    ? `Dry air${fx.cold ? ', cold and wind' : ''} pull water from your breath and skin without you feeling thirsty. Drink regularly, use lip balm and moisturiser.`
    : `Drink before you get thirsty, about 1 cup (${water(8, 250)}) every 20–30 minutes while active.`);
  if (fx.frost !== null) out.push(`Exposed skin can freeze in about ${Math.max(2, Math.round(fx.frost))} minutes. Cover your face, ears and fingers; mittens beat gloves. Numb, white or waxy skin is frostbite: warm it gently, don't rub it.`);
  else if (fx.cold >= 2) out.push(`Bitter cold: dress in layers with a hat and gloves, and limit time outside for children and older people. Shivering, confusion and slurred speech are signs of hypothermia.`);
  else if (fx.cold === 1 && toF(fx.minFeels) <= 32) out.push(`Feels below freezing at times: layers, a hat and gloves. Wet clothing loses most of its warmth.`);
  if (fx.wetCold >= 2) out.push(`Cold rain: being soaked at ${fmtTemp(2)}–${fmtTemp(10)} chills you faster than dry cold. Stay dry; hypothermia can happen well above freezing.`);
  if (fx.windL >= 3) out.push(`Gusts near ${fmtSpeed(fx.gust)} can knock people over and throw debris. Stay indoors away from windows and trees.`);
  else if (fx.windL === 2) out.push(`Gusts near ${fmtSpeed(fx.gust)}: walking is hard, falling branches are possible, and small boats should stay in.`);
  else if (fx.windL === 1 && fx.cold) out.push(`The wind makes it feel colder than the thermometer says.`);
  if (fx.burn && fx.uv >= 3) {
    const b = fx.burn;
    out.push(`${UV_WORDS[fx.uvL]} UV (${Math.round(fx.uv)}): fair skin can burn in about ${Math.round(b.fair)} minutes, medium skin in about ${Math.round(b.medium)}. Use SPF 30+ and reapply every 2 hours, wear a hat and sunglasses, and seek shade from 10 am to 4 pm.` +
      (fx.cloud !== null && fx.cloud >= 60 ? ' Clouds do not stop it: most UV gets through thin or broken cloud.' : '') +
      ' Water, sand and snow reflect more onto you.');
  }
  if (fx.sunHours !== null && fx.dayHours && fx.sunHours < 1.5 && fx.cold) out.push(`A grey day: little sun to warm you, so it will feel colder all day.`);
  if (fx.lightning === 2) out.push(`Thunderstorms likely: when thunder roars, go indoors (a building or a hard-topped car, not a porch, tent or tree), and wait 30 minutes after the last thunder. Boaters: get off the water before storms build, usually in the afternoon.`);
  else if (fx.lightning === 1) out.push(`Thunderstorms possible: keep an eye on the sky and the radar, and have a place to shelter. Lightning can strike 10 miles from a storm.`);
  if (fx.dewL >= 4 && fx.heat < 2) out.push(`Very humid (dew point ${fmtTemp(fx.dew)}): sweat barely evaporates, so you tire quickly. Take it easy in the afternoon.`);
  if (fx.nightL >= 2) out.push(`${NIGHT_WORDS[fx.nightL]} (low near ${fmtTemp(fx.nightMin)}): heat builds up in the body over several such nights. Use A/C or go somewhere cool for part of the day; older people and the sick are most at risk. A fan alone is not enough above about ${fmtTemp(32)}.`);
  else if (fx.nightL === 1) out.push(`A warm, sticky night (low near ${fmtTemp(fx.nightMin)}): a fan and light bedding help; the best bedroom temperature for sleep is about ${fmtTemp(16)}–${fmtTemp(19)}.`);
  else if (fx.nightL === -2) out.push(`Bitter cold night (low near ${fmtTemp(fx.nightMin)}): keep the heat on, let faucets drip, and never run a generator, grill or camp stove indoors (carbon monoxide).`);
  else if (fx.nightL === -1) out.push(`Freezing tonight (low near ${fmtTemp(fx.nightMin)}): extra blankets, keep space heaters 3 ft (1 m) from anything that burns, and cover tender plants and bring pets in.`);
  if (!out.length) out.push(`A comfortable day for most people outdoors.`);
  return out;
}

// ---------- rendering ----------

const LEVEL_COLORS = ['#3fb950', '#facd28', '#ff9f1c', '#e5383b', '#b02ad9'];

let opts = null;
export function initPeople(o) { opts = o; }

function badge(level, text) {
  const dark = level === 1 || level === 2;
  return `<span class="fx-badge" style="background:${LEVEL_COLORS[level]};color:${dark ? '#111' : '#fff'}">${text}</span>`;
}

export function renderPeople(model) {
  const body = document.getElementById('fxDays');
  if (!body || !opts) return;
  const { fmtTemp, fmtSpeed, dayOf, esc, describe } = opts;
  const week = weekEffects(model);
  if (!week.length) {
    body.innerHTML = '<p class="note">The 7-day forecast is not available right now.</p>';
    document.getElementById('fxNow').textContent = '';
    return;
  }
  // Right now, from the current conditions and this hour's sunshine.
  const c = model.current || {}, now = Date.now();
  const hr = model.week.reduce((a, h) => (Math.abs(h.time - now) < Math.abs(a.time - now) ? h : a), model.week[0]);
  const t = model.tempC, ok = Number.isFinite(t) && Number.isFinite(c.humidity);
  const wbNow = ok ? wbgtC(t, c.humidity, c.wind || 0, c.day ? hr.sun : 0) : null;
  const nowBits = [];
  if (ok) nowBits.push(`Feels like <b>${fmtTemp(feelsLikeC(t, c.humidity, c.wind || 0))}</b>`);
  if (wbNow !== null && t >= 21) nowBits.push(`heat stress (WBGT) ${fmtTemp(wbNow)}`);
  if (hr && hr.uv !== null && c.day) nowBits.push(`UV ${Math.round(hr.uv)}`);
  if (Number.isFinite(c.humidity)) nowBits.push(`humidity ${Math.round(c.humidity)}%`);
  document.getElementById('fxNow').innerHTML = nowBits.length ? `Now: ${nowBits.join(' · ')}` : '';

  body.innerHTML = week.map(({ day, fx }, i) => {
    const w = describe(day.code, true);
    const rows = [];
    rows.push(['Feels like', `${fmtTemp(fx.minFeels)} to ${fmtTemp(fx.maxFeels)}${fx.heat ? ` · ${HEAT_WORDS[fx.heat].toLowerCase()} (heat index)` : ''}${fx.cold && !fx.heat ? ` · ${COLD_WORDS[fx.cold].toLowerCase()} (wind chill)` : ''}`]);
    if (fx.wbgt !== null && fx.maxFeels >= 21) rows.push(['Heat stress (WBGT)', `${fmtTemp(fx.wbgt)} in the open${fx.heat ? '' : ', low'}`]);
    if (fx.frost !== null) rows.push(['Frostbite', `exposed skin in about ${Math.max(2, Math.round(fx.frost))} min`]);
    if (fx.uv !== null) rows.push(['UV index', `${Math.round(fx.uv)} ${UV_WORDS[fx.uvL].toLowerCase()}${fx.burn && fx.uv >= 3 ? ` · burn in ~${Math.round(fx.burn.fair)} min (fair), ~${Math.round(fx.burn.medium)} min (medium skin)` : ''}`]);
    if (fx.dew !== null) rows.push(['Humidity', `dew point up to ${fmtTemp(fx.dew)} · ${DEW_WORDS[fx.dewL].toLowerCase()}`]);
    rows.push(['Lightning', ['unlikely', 'thunderstorms possible', 'thunderstorms likely'][fx.lightning] + (fx.cape >= 1000 ? ` · storm energy (CAPE) ${Math.round(fx.cape)} J/kg` : '')]);
    if (fx.nightL !== null) rows.push(['Tonight', `low near ${fmtTemp(fx.nightMin)} · ${lowerFirst(NIGHT_WORDS[fx.nightL])}`]);
    rows.push(['Dehydration', ['low', 'moderate', 'high'][fx.dehyd] + (fx.dry ? ` · dry air (${Math.round(fx.minRh)}% humidity)` : '')]);
    if (fx.sunHours !== null) rows.push(['Sunshine', `${fx.sunHours.toFixed(1)} of ${fx.dayHours ? fx.dayHours.toFixed(1) : '?'} daylight hours${fx.cloud !== null ? ` · average cloud ${Math.round(fx.cloud)}%` : ''}`]);
    if (fx.gust) rows.push(['Wind', `up to ${fmtSpeed(fx.wind)}, gusts ${fmtSpeed(fx.gust)}${fx.windL ? ` · ${WIND_WORDS[fx.windL].toLowerCase()}` : ''}`]);
    const tags = [];
    if (fx.heat) tags.push(HEAT_WORDS[fx.heat]);
    if (fx.cold) tags.push(COLD_WORDS[fx.cold]);
    if (fx.uvL >= 2) tags.push(`UV ${Math.round(fx.uv)}`);
    if (fx.windL) tags.push(WIND_WORDS[fx.windL]);
    if (fx.lightning) tags.push(fx.lightning === 2 ? 'Lightning likely' : 'Lightning possible');
    if (fx.dewL >= 3) tags.push(DEW_WORDS[fx.dewL]);
    if (fx.nightL >= 1 || fx.nightL === -2) tags.push(fx.nightL > 0 ? 'Warm night' : 'Bitter cold night');
    return `<details class="fx-day"${i === 0 ? ' open' : ''}>
      <summary>
        <span class="fx-name">${i === 0 ? 'Today' : dayOf(day.time)}</span>
        <span class="fx-icon" title="${esc(w.label)}">${w.icon}</span>
        <span class="fx-range">${fmtTemp(fx.minFeels)} – ${fmtTemp(fx.maxFeels)}</span>
        ${badge(fx.level, LEVEL_WORDS[fx.level])}
        <span class="fx-tags">${tags.map(esc).join(' · ') || 'Comfortable'}</span>
      </summary>
      <dl class="fx-rows">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      <ul class="fx-advice">${advice(fx, opts).map((a) => `<li>${a}</li>`).join('')}</ul>
    </details>`;
  }).join('');
}

// ---------- pollen (Open-Meteo / CAMS: Europe only) ----------

// Grains per m³ at which each kind turns moderate, high and very high (U.S. National Allergy
// Bureau scale: trees, grass, weeds).
const POLLEN = {
  alder: { name: 'Alder (tree)', at: [15, 90, 1500] },
  birch: { name: 'Birch (tree)', at: [15, 90, 1500] },
  olive: { name: 'Olive (tree)', at: [15, 90, 1500] },
  grass: { name: 'Grass', at: [5, 20, 200] },
  mugwort: { name: 'Mugwort (weed)', at: [10, 50, 500] },
  ragweed: { name: 'Ragweed (weed)', at: [10, 50, 500] },
};
const POLLEN_WORDS = ['None', 'Low', 'Moderate', 'High', 'Very high'];
const POLLEN_COLORS = ['transparent', '#3fb950', '#facd28', '#ff9f1c', '#e5383b'];
export function pollenLevel(kind, v) {
  if (!(v > 0.5)) return 0;
  const at = POLLEN[kind].at;
  return v >= at[2] ? 4 : v >= at[1] ? 3 : v >= at[0] ? 2 : 1;
}

// Local calendar date of a unixtime (s) given the place's UTC offset (ms).
const localDay = (t, off) => new Date(t * 1000 + off).toISOString().slice(0, 10);

async function fetchPollen(loc) {
  const q = new URLSearchParams({
    latitude: loc.lat.toFixed(3), longitude: loc.lon.toFixed(3),
    hourly: Object.keys(POLLEN).map((k) => `${k}_pollen`).join(','),
    forecast_days: '4', timeformat: 'unixtime', timezone: 'auto',
  });
  const r = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json(), h = j.hourly || {}, off = (j.utc_offset_seconds || 0) * 1000;
  const days = new Map();
  let any = false;
  (h.time || []).forEach((t, i) => {
    const key = localDay(t, off);
    const row = days.get(key) || { time: t * 1000 };
    for (const k of Object.keys(POLLEN)) {
      const v = h[`${k}_pollen`] ? h[`${k}_pollen`][i] : null;
      if (v === null || v === undefined) continue;
      any = true;
      row[k] = Math.max(row[k] ?? 0, v);
    }
    days.set(key, row);
  });
  return { covered: any, days: [...days.values()] };
}

function renderPollen(p) {
  const el = document.getElementById('pollenBody');
  const { dayOf, esc } = opts;
  if (!p) { el.innerHTML = '<p class="note">Loading…</p>'; return; }
  if (p.error) { el.innerHTML = `<p class="note">Pollen forecast unavailable: ${esc(p.error)}</p>`; return; }
  if (!p.covered) {
    el.innerHTML = `<p class="fx-none">Pollen isn't available for this location. The free pollen forecast covers Europe only.</p>`;
    return;
  }
  const kinds = Object.keys(POLLEN).filter((k) => p.days.some((d) => d[k] !== undefined));
  const levels = p.days.map((d) => kinds.map((k) => pollenLevel(k, d[k])));
  if (levels.every((r) => r.every((l) => l === 0))) {
    el.innerHTML = '<p class="fx-none">Little or no pollen in the air for the next 4 days (out of season).</p>';
    return;
  }
  el.innerHTML = `<table class="pollen-table"><thead><tr><th></th>${p.days.map((d, i) => `<th>${i === 0 ? 'Today' : dayOf(d.time)}</th>`).join('')}</tr></thead>
    <tbody>${kinds.map((k, ki) => `<tr><th>${POLLEN[k].name}</th>${p.days.map((d, di) => {
      const l = levels[di][ki];
      return `<td><span class="pl" style="background:${POLLEN_COLORS[l]};color:${l === 4 ? '#fff' : l ? '#111' : 'var(--muted)'}">${POLLEN_WORDS[l]}</span></td>`;
    }).join('')}</tr>`).join('')}</tbody></table>
    <p class="note">Highest level each day, in grains per cubic metre against the U.S. National Allergy Bureau scale.
      High or very high: keep windows closed, take allergy medicine before going out, and shower after time outdoors.</p>`;
}

// ---------- cold water (boaters, swimmers) ----------

// Expected time to exhaustion or unconsciousness, and expected survival, in water below each
// temperature (°F), for an adult in ordinary clothes (U.S. Coast Guard table).
const SURVIVAL = [
  [32.5, 'under 15 min', '15–45 min'],
  [40, '15–30 min', '30–90 min'],
  [50, '30–60 min', '1–3 hours'],
  [60, '1–2 hours', '1–6 hours'],
  [70, '2–7 hours', '2–40 hours'],
  [80, '3–12 hours', '3 hours to indefinitely'],
  [Infinity, 'indefinitely', 'indefinitely'],
];
export const survival = (c) => SURVIVAL.find(([max]) => Math.round(toF(c)) < max);   // as displayed

async function fetchWater(loc) {
  const q = new URLSearchParams({
    latitude: loc.lat.toFixed(3), longitude: loc.lon.toFixed(3),
    current: 'sea_surface_temperature', hourly: 'sea_surface_temperature',
    forecast_days: '7', timeformat: 'unixtime', timezone: 'auto',
  });
  const r = await fetch(`https://marine-api.open-meteo.com/v1/marine?${q}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json(), h = j.hourly || {}, off = (j.utc_offset_seconds || 0) * 1000;
  const days = new Map();
  (h.time || []).forEach((t, i) => {
    const v = h.sea_surface_temperature ? h.sea_surface_temperature[i] : null;
    if (v === null || v === undefined) return;
    const key = localDay(t, off);
    const x = days.get(key) || { time: t * 1000, lo: v, hi: v };
    days.set(key, { time: x.time, lo: Math.min(x.lo, v), hi: Math.max(x.hi, v) });
  });
  return { now: j.current ? j.current.sea_surface_temperature ?? null : null, days: [...days.values()] };
}

const COLD_SHOCK = 'Cold shock: the first minute in cold water makes you gasp and breathe fast, and many cold-water ' +
  'deaths happen then, before hypothermia. Remember <b>1-10-1</b>: 1 minute to get your breathing under control, about ' +
  '10 minutes of useful movement to get out or hold on to something, and about 1 hour before hypothermia knocks you out. ' +
  'Wear your life jacket, keep your head out of the water, and do not try to swim far: hold your knees to your chest ' +
  '(the HELP position), huddle with others, and stay with the boat.';
const COOL_TIP = 'Water below about 70 °F (21 °C) still drains body heat far faster than air: wear a life jacket so you can ' +
  'float without using energy, and climb onto anything that floats.';
const WARM_TIP = 'Warm water: hypothermia comes slowly, but exhaustion and drowning do not. Wear a life jacket and stay with the boat.';

function renderWater(w) {
  const el = document.getElementById('waterBody');
  const { fmtTemp, dayOf, esc } = opts;
  if (!w) { el.innerHTML = '<p class="note">Loading…</p>'; return; }
  if (w.error) { el.innerHTML = `<p class="note">Water temperature unavailable: ${esc(w.error)}</p>`; return; }
  const now = w.now ?? (w.days[0] ? w.days[0].lo : null);
  if (now === null || now === undefined) {
    el.innerHTML = `<p class="fx-none">No sea temperature for this spot: it is inland, or on a lake, river or bay the
      ocean model does not cover. Pick a spot on open water, or check a nearby buoy in Seas &amp; swell.</p>`;
    return;
  }
  const f = Math.round(toF(now)), s = survival(now);
  const lvl = f < 50 ? 3 : f < 60 ? 2 : f < 70 ? 1 : 0;
  el.innerHTML = `<p class="fx-water-now">${badge(lvl, ['Warm water', 'Cool water', 'Cold water', 'Very cold water'][lvl])}
      Water about <b>${fmtTemp(now)}</b>. ${f >= 80
        ? 'Warm enough that hypothermia is unlikely; exhaustion and drowning are the dangers.'
        : `If you fall in: exhaustion or unconsciousness in <b>${s[1]}</b>, expected survival <b>${s[2]}</b>.`}</p>
    <p class="fx-water-tip">${f < 60 ? COLD_SHOCK : f < 70 ? COOL_TIP : WARM_TIP}</p>
    <table class="pollen-table"><thead><tr><th></th><th>Water</th><th>Survival if you fall in</th></tr></thead><tbody>
    ${w.days.map((d, i) => `<tr><th>${i === 0 ? 'Today' : dayOf(d.time)}</th><td>${fmtTemp(d.lo)}${Math.round(toF(d.hi)) !== Math.round(toF(d.lo)) ? ` – ${fmtTemp(d.hi)}` : ''}</td><td>${toF(d.lo) >= 80 ? 'hypothermia unlikely' : survival(d.lo)[2]}</td></tr>`).join('')}
    </tbody></table>
    <p class="note">Sea surface temperature from Open-Meteo's marine model at this spot. Survival times are the U.S. Coast
      Guard's for an adult in ordinary clothes; a life jacket, wetsuit or dry suit lengthens them a lot, and
      thin people and children cool faster.</p>`;
}

// Pollen and water temperature for the place being shown, fetched at most every 30 minutes.
const extras = { key: null, time: 0, pollen: null, water: null };
export async function loadPeopleExtras(loc) {
  if (!opts || !loc) return;
  const key = `${loc.lat.toFixed(2)},${loc.lon.toFixed(2)}`;
  if (extras.key === key && Date.now() - extras.time < 30 * 60000) { rerenderPeopleExtras(); return; }
  Object.assign(extras, { key, time: Date.now(), pollen: null, water: null });
  rerenderPeopleExtras();
  const [p, w] = await Promise.allSettled([fetchPollen(loc), fetchWater(loc)]);
  if (extras.key !== key) return;   // a newer place took over
  extras.pollen = p.status === 'fulfilled' ? p.value : { error: p.reason.message };
  extras.water = w.status === 'fulfilled' ? w.value : { error: w.reason.message };
  rerenderPeopleExtras();
}

// Draw again, e.g. after the units change.
export function rerenderPeopleExtras() {
  renderPollen(extras.pollen);
  renderWater(extras.water);
}
