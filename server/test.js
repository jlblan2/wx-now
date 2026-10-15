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
