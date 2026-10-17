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
