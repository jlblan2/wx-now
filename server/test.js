// Alert-decision tests: node test.js
import assert from 'node:assert/strict';
import { decide, newState, REALERT_MIN } from './decide.js';

const series = (p) => Array.from({ length: 61 }, (_, m) => ({ m, prob: typeof p === 'function' ? p(m) : p, intensity: 1 }));
const dry = { summary: { raining: false, start: null }, series: series(0) };
const maybe = { summary: { raining: false, start: null }, series: series(0.3) };
const soon = (start) => ({ summary: { raining: false, start }, series: series((m) => (m >= start ? 0.8 : 0)) });
const raining = { summary: { raining: true, start: 0 }, series: series(0.9) };

let t = Date.UTC(2026, 0, 1);
const step = (st, f) => { t += 5 * 60000; return decide(st, f.summary, f.series, t); };
const run = (name, fn) => { fn(); console.log(`PASS ${name}`); };

run('alerts once when rain is 12 min away, not again while it keeps raining', () => {
  const st = newState();
  assert.equal(step(st, dry), false);
  assert.equal(step(st, soon(30)), false);
  assert.equal(step(st, soon(12)), true);
  assert.equal(step(st, soon(7)), false);
  assert.equal(step(st, raining), false);
  assert.equal(step(st, raining), false);
});

run('re-arms only after two dry checks and the minimum gap', () => {
  const st = newState();
  assert.equal(step(st, raining), true);
  assert.equal(step(st, dry), false);
  assert.equal(step(st, soon(10)), false, 'one dry check is not enough');
  assert.equal(step(st, dry), false);
  assert.equal(step(st, dry), false);
  t += REALERT_MIN * 60000;
  assert.equal(step(st, soon(10)), true);
});

run('a "possible" forecast does not count as dry', () => {
  const st = newState();
  assert.equal(step(st, raining), true);
  assert.equal(step(st, maybe), false);
  assert.equal(step(st, maybe), false);
  t += REALERT_MIN * 60000;
  assert.equal(step(st, soon(5)), false, 'never went fully dry, so stays disarmed');
});

run('rain 20 min out is not yet alerted', () => {
  const st = newState();
  assert.equal(step(st, soon(20)), false);
  assert.equal(step(st, soon(16)), false);
  assert.equal(step(st, soon(15)), true);
});

console.log('All alert tests passed');

// ---------- storm alerts ----------
import { stormAlerts } from './stormalerts.js';

const ring = (lat, lon, r) => ({ type: 'Polygon', coordinates: [[[lon - r, lat - r], [lon + r, lat - r], [lon + r, lat + r], [lon - r, lat + r], [lon - r, lat - r]]] });
const storm = (extra) => ({
  bin: 'AT1', name: 'Test', title: 'Hurricane Test', kt: 90, lat: 25, lon: -80,
  points: [{ lat: 25, lon: -80, tau: 0, kt: 90, time: Date.now() }, { lat: 27, lon: -80, tau: 24, kt: 100, time: Date.now() + 86400000 }],
  track: [], pastTrack: [], cone: [], warnings: [], wind: [], ...extra,
});
const home = { name: 'Home', lat: 27, lon: -80.1 };
const wl = (sub) => sub.places.map((p) => ({ key: `p:${p.name}`, ...p }));

run('storm alerts escalate once per level and reset when the storm ends', () => {
  const subs = { e1: { places: [home] } };
  assert.equal(stormAlerts(subs, [storm()], wl).length, 0, 'far outside everything');
  const inCone = storm({ cone: [ring(26.5, -80, 1)] });
  const a = stormAlerts(subs, [inCone], wl);
  assert.equal(a.length, 1);
  assert.match(a[0].payload.body, /inside the forecast cone/);
  assert.equal(stormAlerts(subs, [inCone], wl).length, 0, 'same level is not repeated');
  const warned = storm({ cone: [ring(26.5, -80, 1)], warnings: [{ code: 'HWR', geometry: { type: 'LineString', coordinates: [[-80.3, 26.8], [-80.3, 27.3]] } }] });
  const b = stormAlerts(subs, [warned], wl);
  assert.equal(b.length, 1);
  assert.match(b[0].payload.body, /Hurricane Warning/);
  const winds = storm({ ...warned, wind: [{ kt: 34, geometry: ring(27, -80, 0.5) }] });
  assert.match(stormAlerts(subs, [winds], wl)[0].payload.body, /Tropical-storm-force winds/);
  assert.equal(stormAlerts(subs, [], wl).length, 0);
  assert.deepEqual(subs.e1.stormState, {}, 'state cleared after the storm ends');
});

console.log('All storm alert tests passed');

// ---------- marine alerts ----------
import { marineAlertSends } from './marinealerts.js';

run('marine alerts: once per NWS alert, only for my zones and qualifying events', () => {
  const subs = { e1: {} };
  const alert = (id, event, zones, ends = '2099-01-01T13:00:00-05:00') => ({ properties: {
    id, event, geocode: { UGC: zones }, ends, headline: event,
    description: '* WHAT...North winds 20 to 30 kt and seas 5 to 8 ft expected.\n\n* WHERE...Somewhere.',
  } });
  const zoneName = (z) => `Zone ${z}`;
  const mine = { e1: ['GMZ853'] };
  const a = marineAlertSends(subs, mine, [alert('x1', 'Small Craft Advisory', ['GMZ853', 'GMZ856'])], zoneName);
  assert.equal(a.length, 1);
  assert.equal(a[0].payload.title, 'Small Craft Advisory · Zone GMZ853');
  assert.match(a[0].payload.body, /^North winds 20 to 30 kt and seas 5 to 8 ft expected\. until Thu 1:00 PM$/);
  assert.equal(marineAlertSends(subs, mine, [alert('x1', 'Small Craft Advisory', ['GMZ853'])], zoneName).length, 0, 'not repeated');
  assert.equal(marineAlertSends(subs, mine, [alert('x2', 'Gale Warning', ['GMZ853'])], zoneName).length, 1, 'upgrade is a new alert');
  assert.equal(marineAlertSends(subs, mine, [alert('x3', 'Marine Weather Statement', ['GMZ853'])], zoneName).length, 0, 'statements skipped');
  assert.equal(marineAlertSends(subs, mine, [alert('x4', 'Small Craft Advisory', ['GMZ830'])], zoneName).length, 0, 'other zones skipped');
  marineAlertSends(subs, mine, [], zoneName, Date.parse('2100-01-01'));
  assert.deepEqual(subs.e1.marineSent, {}, 'expired alerts forgotten');
});

console.log('All marine alert tests passed');

// ---------- offshore headline alerts ----------
run('offshore headlines alert once while present, again only after they drop out', () => {
  const subs = { e1: {} };
  const mine = { e1: ['AMZ066'] };
  const zoneName = (z) => z;
  const off = (headline) => ({ offshore: true, properties: {
    id: `off:AMZ066:${headline}`, event: headline, headline, geocode: { UGC: ['AMZ066'] },
    description: '* WHAT...Sun Night: NE winds 25 to 35 kt. Seas 8 to 12 ft.' } });
  let t0 = Date.UTC(2026, 9, 15);
  const a = marineAlertSends(subs, mine, [off('GALE CONDITIONS POSSIBLE SUN NIGHT')], zoneName, t0);
  assert.equal(a.length, 1);
  assert.equal(a[0].payload.body, 'Sun Night: NE winds 25 to 35 kt. Seas 8 to 12 ft.');
  t0 += 5 * 3600000;
  assert.equal(marineAlertSends(subs, mine, [off('GALE CONDITIONS POSSIBLE SUN NIGHT')], zoneName, t0).length, 0, 'still there: no repeat');
  t0 += 5 * 3600000;
  assert.equal(marineAlertSends(subs, mine, [off('GALE CONDITIONS POSSIBLE SUN NIGHT')], zoneName, t0).length, 0, 'kept alive while present');
  assert.equal(marineAlertSends(subs, mine, [off('GALE WARNING')], zoneName, t0).length, 1, 'upgrade alerts');
  t0 += 7 * 3600000;
  marineAlertSends(subs, mine, [], zoneName, t0);
  assert.equal(marineAlertSends(subs, mine, [off('GALE WARNING')], zoneName, t0).length, 1, 'returns after dropping out');
});

console.log('All offshore alert tests passed');

// ---------- tropical outlook alerts ----------
import { outlookEvents, outlookSends } from './outlookalerts.js';

run('outlook: quiet first run, new areas, rising chances, no repeats', () => {
  const area = (lat, lon, risk7, prob7, risk2 = 'Low', prob2 = '0%') => ({ lat, lon, risk7, prob7, risk2, prob2 });
  let r = outlookEvents(null, [area(15, -40, 'Low', '20%')]);
  assert.equal(r.events.length, 0, 'first run only records');
  r = outlookEvents(r.next, [area(15.5, -41, 'Low', '30%')]);
  assert.equal(r.events.length, 0, 'same area moved, same risk level');
  r = outlookEvents(r.next, [area(16, -43, 'Medium', '50%'), area(25, -88, 'Low', '10%')]);
  assert.deepEqual(r.events.map((e) => e.kind).sort(), ['new', 'up']);
  r = outlookEvents(r.next, [area(16.5, -45, 'Medium', '60%', 'High', '70%'), area(25, -88, 'Low', '10%')]);
  assert.equal(r.events.length, 1, '2-day reaching high counts');
  const sends = outlookSends({ e1: { places: [{ name: 'Home', lat: 27.9, lon: -82.5 }] } }, r.events,
    (s) => s.places.map((p) => ({ key: 'p:' + p.name, ...p })));
  assert.equal(sends.length, 1);
  assert.match(sends[0].payload.title, /chances up to 60% in 7 days/);
  assert.match(sends[0].payload.body, /mi (E|ESE|SE) of Home\.$/);
  assert.equal(outlookSends({ e1: { outlookOn: false, places: [] } }, r.events, () => []).length, 0, 'opt-out respected');
});

console.log('All outlook alert tests passed');

// ---------- high water alerts ----------
import { decideHighWater, highWaterMessage } from './highwater.js';

run('high water: threshold, a further foot, flood stage, quiet until it drops', () => {
  const st = { armed: true, low: 0 };
  const flood = { minor: 5.0, moderate: 6.0, major: 7.0 };
  const r = (level, above) => ({ level, above, predicted: level - above, rising: true, flood });
  assert.equal(decideHighWater(st, r(2.0, 0.6), 1), null, 'below threshold');
  assert.equal(decideHighWater(st, r(2.5, 1.1), 1), 'above');
  assert.equal(decideHighWater(st, r(2.8, 1.5), 1), null, 'no repeat');
  assert.equal(decideHighWater(st, r(3.4, 2.1), 1), 'higher', 'another foot');
  assert.equal(decideHighWater(st, r(5.2, 2.6), 1), 'minor', 'flood level reached');
  assert.equal(decideHighWater(st, r(5.3, 2.7), 1), null);
  decideHighWater(st, r(2.0, 0.4), 1);
  decideHighWater(st, r(1.8, 0.3), 1);
  assert.equal(decideHighWater(st, r(2.4, 1.0), 1), 'above', 're-armed after dropping back');
  const m = highWaterMessage('above', { level: 3.1, above: 1.3, rising: true, flood }, { name: 'St. Petersburg' }, 'Home');
  assert.equal(m.title, 'High water · St. Petersburg (Home)');
  assert.equal(m.body, '1.3 ft above predicted. Water 3.1 ft above MLLW, rising. Minor flooding begins at 5.0 ft.');
});

console.log('All high water tests passed');

// ---------- water temperature alerts ----------
import { buoyFor, decideWaterTemp, waterTempMessage } from './watertemp.js';

run('water temperature: baseline, two reports past the change, new baseline', () => {
  const H = 3600000, t0 = Date.UTC(2026, 9, 13, 12);
  const b = (c, h) => ({ id: '42036', name: 'WEST TAMPA - 112 NM WNW of Tampa', lat: 28.5, lon: -84.5, wtmp: c, t: t0 + h * H });
  const st = {};
  assert.equal(decideWaterTemp(st, b(28.0, 0), 3), null, 'first reading is the baseline');
  assert.equal(decideWaterTemp(st, b(27.0, 1), 3), null, 'under 3 °F');
  assert.equal(decideWaterTemp(st, b(26.0, 2), 3), null, 'one report past the change is not enough');
  assert.equal(decideWaterTemp(st, b(26.0, 2), 3), null, 'same report again');
  assert.equal(decideWaterTemp(st, b(26.1, 3), 3), 'cooler');
  assert.equal(decideWaterTemp(st, b(26.0, 4), 3), null, 'new baseline');
  assert.equal(decideWaterTemp(st, b(28.0, 5), 3), null);
  assert.equal(decideWaterTemp(st, b(25.0, 6), 3), null, 'a spike back resets the count');
  const m = waterTempMessage('cooler', { from: 82.4, fromT: t0 }, b(26.1, 3), 'Home', false);
  assert.equal(m.title, 'Water cooler · WEST TAMPA (Home)');
  assert.equal(m.body, 'Water temperature 79 °F, down 3 °F since Tue, Oct 13 (82 °F). Measured at WEST TAMPA - 112 NM WNW of Tampa.');
  assert.equal(buoyFor({ lat: 28.4, lon: -84.4 }, [b(28, 0)]).id, '42036');
  assert.equal(buoyFor({ lat: 30.4, lon: -84.4 }, [b(28, 0)]), null, 'over 50 nm away');
});

console.log('All water temperature tests passed');

// ---------- wind forecast alerts ----------
import { windEvent, decideWind, windMessage } from './windalerts.js';

run('wind: event in the next 24 h, once, stronger by 10 kt, re-arm after easing', () => {
  const H = 3600000, now = Date.UTC(2026, 9, 17, 16), off = -4 * H;
  const fc = (peaks) => Array.from({ length: 30 }, (_, i) => {
    const kt = peaks[i] ?? 10;
    return { t: now + i * H, local: now + i * H + off, kt, gust: kt * 1.4, dir: 45 };
  });
  const st = { armed: true, low: 0 };
  assert.equal(decideWind(st, windEvent(fc({}), 25, now), 25), null, 'calm');
  const w = windEvent(fc({ 6: 22, 7: 26, 8: 28, 9: 25, 10: 20 }), 25, now);
  assert.equal(w.event.start.t, now + 7 * H);
  assert.equal(w.event.end.t, now + 9 * H);
  assert.equal(w.event.peak.kt, 28);
  assert.equal(decideWind(st, w, 25), 'new');
  assert.equal(decideWind(st, windEvent(fc({ 7: 30 }), 25, now), 25), null, 'no repeat');
  assert.equal(decideWind(st, windEvent(fc({ 7: 38 }), 25, now), 25), 'stronger');
  decideWind(st, windEvent(fc({}), 25, now), 25);
  assert.equal(decideWind(st, windEvent(fc({ 3: 26 }), 25, now), 25), null, 'one calm check is not enough to re-arm');
  assert.equal(decideWind(st, windEvent(fc({ 27: 40 }), 25, now), 25), null, 'beyond 24 h does not count');
  decideWind(st, windEvent(fc({}), 25, now), 25);
  assert.equal(decideWind(st, windEvent(fc({ 3: 26 }), 25, now), 25), 'new', 're-armed');
  const m = windMessage('new', w.event, 'Home', false);
  assert.equal(m.title, 'Wind forecast · Home');
  assert.equal(m.body, 'Up to 28 kt (32 mph) from the NE, gusts to 39 kt, Sat 7 PM to Sat 9 PM. Strongest Sat 8 PM.');
});

console.log('All wind tests passed');

// ---------- extreme tide alerts ----------
import { findExtremes, decideTides, tideMessage } from './tidealerts.js';

run('tides: extreme highs and lows in the next 48 h, one alert each, no repeats', () => {
  const H = 3600000, now = Date.UTC(2026, 9, 17, 16);
  const tides = [
    { t: now + 2 * H, v: 7.2, high: true }, { t: now + 8 * H, v: 0.3, high: false },
    { t: now + 14 * H, v: 8.9, high: true }, { t: now + 20 * H, v: -1.3, high: false },
    { t: now + 27 * H, v: 9.4, high: true }, { t: now + 33 * H, v: -0.4, high: false },
    { t: now + 60 * H, v: 10.5, high: true },
  ];
  const ex = findExtremes(tides, 8.26, 0.5, { minor: 9.3 }, now);
  assert.deepEqual(ex.highs.map((x) => x.v), [8.9, 9.4], 'over MHHW + 0.5, within 48 h');
  assert.deepEqual(ex.lows.map((x) => x.v), [-1.3]);
  const st = {};
  const a = decideTides(st, ex, now);
  assert.deepEqual(a.map((x) => x.kind), ['high', 'low']);
  assert.equal(decideTides(st, ex, now + 3 * H).length, 0, 'same tides, no repeat');
  const ex2 = findExtremes([...tides, { t: now + 39 * H, v: 9.6, high: true }], 8.26, 0.5, { minor: 9.3 }, now + 3 * H);
  assert.equal(decideTides(st, ex2, now + 3 * H).length, 0, 'new extreme within a day waits');
  assert.equal(decideTides(st, ex2, now + 21 * H).length, 1, 'next day it alerts');
  const m = tideMessage('high', ex.highs, { name: 'Fernandina Beach' }, 8.26, { minor: 9.3 }, 'Home', false, 'America/New_York');
  assert.equal(m.title, 'Extreme high tide · Fernandina Beach (Home)');
  assert.equal(m.body, '9.4 ft at Sun 3:00 PM, 1.1 ft above a normal high (8.3 ft) (2 highs like this in the next 2 days). At or above the minor flooding level. Wind and storms can push it higher.');
  const l = tideMessage('low', ex.lows, { name: 'Fernandina Beach' }, 8.26, null, '', false, 'America/New_York');
  assert.equal(l.body, '-1.3 ft at Sun 8:00 AM, 1.3 ft below a normal low. Watch depths at docks, channels and inlets.');
});

console.log('All tide tests passed');

// ---------- fog alerts ----------
import { fogEvent, decideFog, fogMessage, distText } from './fogalerts.js';

run('fog: 2+ hours at or under the distance in the next 12 h, once, re-arm after clearing', () => {
  const H = 3600000, now = Date.UTC(2026, 9, 17, 4), off = -4 * H;
  const fc = (vis) => Array.from({ length: 24 }, (_, i) => ({ t: now + i * H, local: now + i * H + off, nm: vis[i] ?? 8 }));
  const st = { armed: true, low: 0 };
  assert.equal(decideFog(st, fogEvent(fc({ 3: 0.4 }), 1, now), 1), false, 'a single foggy hour does not count');
  const f = fogEvent(fc({ 3: 0.8, 4: 0.15, 5: 0.3, 6: 2 }), 1, now);
  assert.equal(f.event.start.t, now + 3 * H);
  assert.equal(f.event.low.nm, 0.15);
  assert.equal(decideFog(st, f, 1), true);
  assert.equal(decideFog(st, fogEvent(fc({ 4: 0.1, 5: 0.1 }), 1, now), 1), false, 'no repeat');
  assert.equal(decideFog(st, fogEvent(fc({ 15: 0.1, 16: 0.1 }), 1, now), 1), false, 'beyond 12 h does not count');
  decideFog(st, fogEvent(fc({}), 1, now), 1);
  assert.equal(decideFog(st, fogEvent(fc({ 4: 0.1, 5: 0.1 }), 1, now), 1), true, 're-armed after two clear checks');
  assert.equal(fogMessage(f.event, 'Home', false).body, 'Visibility down to 0.15 nm (300 yd), Sat 3 AM to Sat 5 AM. Lowest around Sat 4 AM.');
  assert.equal(distText(0.15, true), '300 m');
  assert.equal(distText(1.5, false), '1.5 nm (1.7 mi)');
});

console.log('All fog tests passed');

// ---------- lightning alerts ----------
import { lightningNear, decideLightning, lightningMessage } from './thunder.js';

run('lightning: nearby, very close, all clear after 30 minutes', () => {
  const M = 60000, now = Date.UTC(2026, 9, 17, 20);
  const home = { lat: 30.0, lon: -81.5 };
  const at = (mi, t, dLat = 1) => [t, home.lat + dLat * mi / 69.05, home.lon];   // north or south of home
  const st = {};
  const look = (list, t) => [lightningNear(home, 10, list, t), lightningNear(home, 10, list, t, 40 * M).newest];
  let list = [at(25, now - 2 * M), at(9, now - 3 * M)];
  assert.equal(decideLightning(st, ...look(list, now), now), null, 'one flash in range is not enough');
  list.push(at(7, now - M, -1));
  let [near, seen] = look(list, now);
  assert.equal(near.count, 2);
  assert.equal(Math.round(near.nearest.mi), 7);
  assert.equal(near.nearest.dir, 'S');
  assert.equal(decideLightning(st, near, seen, now), 'nearby');
  assert.equal(decideLightning(st, ...look(list, now + 5 * M), now + 5 * M), null, 'no repeat');
  list.push(at(2, now + 9 * M));
  assert.equal(decideLightning(st, ...look(list, now + 10 * M), now + 10 * M), 'close');
  assert.equal(decideLightning(st, ...look(list, now + 30 * M), now + 30 * M), null, 'only 21 minutes since the last flash');
  assert.equal(decideLightning(st, ...look(list, now + 40 * M), now + 40 * M), 'clear');
  assert.equal(decideLightning(st, ...look([], now + 45 * M), now + 45 * M), null, 'quiet after all clear');
  const m = lightningMessage('nearby', near, 'Home', 10);
  assert.equal(m.title, 'Lightning nearby · Home');
  assert.equal(m.body, '2 flashes within 10 miles in the last 15 minutes, nearest 7 mi (6 nm) S. Head in: off the water, out of the open. You will get an all-clear after 30 minutes without lightning.');
});

console.log('All lightning tests passed');

// ---------- rip current alerts ----------
import { parseSrf, decideRip, ripMessage } from './ripalerts.js';

run('rip currents: Surf Zone Forecast parsing, alert once, higher, re-arm', () => {
  const srf = [
    'FLZ124-125-138-233-333-180600-', 'Nassau-Duval-Flagler-St. Johns-', '',
    '...HIGH RIP CURRENT RISK IN EFFECT THROUGH LATE MONDAY NIGHT...', '',
    '.REST OF TODAY...', 'Rip Current Risk*...........Moderate. ', 'Surf Height.................3 to 4 feet. ',
    'Winds.......................North winds 15 to 20 mph.', '',
    '.SUNDAY...', 'Rip Current Risk*...........High. ', 'Surf Height.................9 to 11 feet. ', '',
    '.EXTENDED...', '.MONDAY...Surf height 9 to 11 feet.', '', '&&', '', '$$', '',
    'GAZ154-180600-', 'Coastal Glynn-', '', '.TODAY...', 'Rip Current Risk*...........Low.', '', '$$',
  ].join('\n');
  const segs = parseSrf(srf);
  assert.equal(segs.length, 2);
  assert.ok(segs[0].zones.has('FLZ125') && segs[0].zones.has('FLZ333'));
  assert.deepEqual(segs[0].periods, [{ name: 'Rest Of Today', risk: 'Moderate', surf: '3 to 4 feet' }, { name: 'Sunday', risk: 'High', surf: '9 to 11 feet' }]);
  assert.equal(segs[1].periods[0].risk, 'Low');
  const st = { armed: true, low: 0 };
  const mod = [{ name: 'Today', risk: 'Moderate', surf: '' }], high = [{ name: 'Today', risk: 'High', surf: '' }], low = [{ name: 'Today', risk: 'Low', surf: '' }];
  assert.equal(decideRip(st, low, 2), null);
  assert.equal(decideRip(st, mod, 2), 'risk');
  assert.equal(decideRip(st, mod, 2), null, 'no repeat');
  assert.equal(decideRip(st, high, 2), 'higher');
  decideRip(st, low, 2); decideRip(st, low, 2);
  assert.equal(decideRip(st, high, 3), 'risk', 're-armed after two lower checks');
  assert.equal(decideRip({ armed: true, low: 0 }, mod, 3), null, 'high-only ignores moderate');
  const m = ripMessage(segs[0].periods, 'Home', 3);
  assert.equal(m.title, 'High rip current risk · Home');
  assert.equal(m.body, 'Sunday: high, surf 9 to 11 feet. Life-threatening rip currents are likely. Stay out of the water or swim near a lifeguard. If caught, swim parallel to the shore.');
});

console.log('All rip current tests passed');
