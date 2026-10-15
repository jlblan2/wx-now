// Alerts when the app is closed: subscribes this device to Web Push with the alert server,
// keeps the server's list of saved places and your last location up to date, and drives
// the "Alerts when the app is closed" settings.

import { ALERT_SERVER } from './config.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

let currentSpot = () => null;   // set by initPush: the location shown in the app right now
let lastSent = store.get('pushLastSent', null);

const server = () => (store.get('alertServer', '') || ALERT_SERVER).replace(/\/+$/, '');
export const alertServerUrl = server;
const places = () => store.get('places', []);
export const pushEnabled = () => !!store.get('pushOn', false);

async function api(path, body) {
  const resp = await fetch(server() + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(j.error || `Server error ${resp.status}`);
  return j;
}

function keyBytes(b64) {
  const s = atob((b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function supported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function subscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

function setMsg(text, bad) {
  const el = $('pushMsg');
  el.textContent = text;
  el.classList.toggle('bad', !!bad);
}

async function enable() {
  if (!server()) return setMsg('No alert server is set up yet.', true);
  if (!supported()) {
    return setMsg(/iPhone|iPad/.test(navigator.userAgent)
      ? 'On iPhone, open the app from its Home Screen icon (Share → Add to Home Screen first), then try again.'
      : 'This browser does not support push notifications.', true);
  }
  setMsg('Turning on…');
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return setMsg('Notifications are blocked. Allow them in Settings → Notifications → Next Hour.', true);
    const { key } = await api('/api/vapid');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub && store.get('pushKey', '') !== key) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
    const here = currentSpot();
    await api('/api/subscribe', { subscription: sub.toJSON(), places: places(), last: here, marine: marinePrefs(), outlook: store.get('pushOutlook', true) });
    store.set('pushKey', key);
    store.set('pushOn', true);
    lastSent = here ? { ...here, at: Date.now() } : null;
    store.set('pushLastSent', lastSent);
    setMsg('On. You will get an alert about 15 minutes before rain at your saved places and where you last opened the app.');
  } catch (e) {
    setMsg(`Could not turn on alerts: ${e.message}`, true);
  }
  renderPush();
}

async function disable() {
  try {
    const sub = await subscription();
    if (sub) {
      await api('/api/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch { /* already gone */ }
  store.set('pushOn', false);
  setMsg('Off.');
  renderPush();
}

async function test() {
  setMsg('Sending a test alert…');
  try {
    const sub = await subscription();
    if (!sub) throw new Error('This device is not subscribed; turn alerts off and on again');
    await api('/api/test', { endpoint: sub.endpoint });
    setMsg('Test alert sent. It should arrive within a few seconds.');
  } catch (e) {
    setMsg(`Test failed: ${e.message}`, true);
  }
}

// Marine alerts: on/off, plus the zone picked in the marine card ('auto' = follow places).
const marinePrefs = () => ({ on: store.get('pushMarine', true), zone: store.get('marineZone', 'auto') });

export async function syncMarine() {
  if (!pushEnabled()) return;
  try {
    const sub = await subscription();
    if (sub) await api('/api/marine', { endpoint: sub.endpoint, ...marinePrefs() });
  } catch (e) {
    setMsg(`Could not update marine alerts on the alert server: ${e.message}`, true);
  }
}

async function syncOutlook() {
  if (!pushEnabled()) return;
  try {
    const sub = await subscription();
    if (sub) await api('/api/outlook', { endpoint: sub.endpoint, on: store.get('pushOutlook', true) });
  } catch (e) {
    setMsg(`Could not update tropical outlook alerts on the alert server: ${e.message}`, true);
  }
}

async function syncPlaces() {
  if (!pushEnabled()) return;
  try {
    const sub = await subscription();
    if (sub) await api('/api/places', { endpoint: sub.endpoint, places: places() });
  } catch (e) {
    setMsg(`Could not update saved places on the alert server: ${e.message}`, true);
  }
}

function addPlace() {
  const spot = currentSpot();
  if (!spot) return setMsg('No location yet — wait for the forecast to load, or tap the map.', true);
  const name = $('placeName').value.trim() || `Place ${places().length + 1}`;
  const list = places().filter((p) => p.name !== name);
  list.push({ name, lat: +spot.lat.toFixed(4), lon: +spot.lon.toFixed(4) });
  store.set('places', list.slice(-10));
  $('placeName').value = '';
  renderPush();
  syncPlaces();
}

function removePlace(name) {
  store.set('places', places().filter((p) => p.name !== name));
  renderPush();
  syncPlaces();
}

function renderPush() {
  const on = pushEnabled();
  $('pushToggle').textContent = on ? 'Turn off' : 'Turn on';
  $('pushTest').hidden = !on;
  $('pushState').textContent = on ? 'On' : 'Off';
  const list = places();
  $('placeList').innerHTML = list.length
    ? list.map((p) => `<li><span>${p.name.replace(/</g, '&lt;')}</span>
        <small>${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}</small>
        <button class="link-btn" data-name="${encodeURIComponent(p.name)}">Remove</button></li>`).join('')
    : '<li class="none">No saved places yet.</li>';
}

// Tells the alert server where you are, at most every 15 minutes unless you moved over 2 km.
export async function reportLocation(loc) {
  if (!pushEnabled() || !loc) return;
  const moved = !lastSent || Math.hypot(loc.lat - lastSent.lat, (loc.lon - lastSent.lon) * Math.cos(loc.lat * Math.PI / 180)) * 111 > 2;
  if (!moved && Date.now() - lastSent.at < 15 * 60000) return;
  try {
    const sub = await subscription();
    if (!sub) return;
    await api('/api/location', { endpoint: sub.endpoint, lat: loc.lat, lon: loc.lon });
    lastSent = { lat: loc.lat, lon: loc.lon, at: Date.now() };
    store.set('pushLastSent', lastSent);
  } catch { /* try again next refresh */ }
}

export function initPush(getSpot) {
  currentSpot = getSpot;
  $('pushToggle').addEventListener('click', () => (pushEnabled() ? disable() : enable()));
  $('pushTest').addEventListener('click', test);
  $('placeAdd').addEventListener('click', addPlace);
  $('placeList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-name]');
    if (b) removePlace(decodeURIComponent(b.dataset.name));
  });
  $('pushOutlook').checked = store.get('pushOutlook', true);
  $('pushOutlook').addEventListener('change', (e) => { store.set('pushOutlook', e.target.checked); syncOutlook(); });
  $('pushMarine').checked = store.get('pushMarine', true);
  $('pushMarine').addEventListener('change', (e) => { store.set('pushMarine', e.target.checked); syncMarine(); });
  $('alertServer').value = store.get('alertServer', '');
  $('alertServer').placeholder = ALERT_SERVER || 'https://…';
  $('alertServer').addEventListener('change', (e) => store.set('alertServer', e.target.value.trim()));
  renderPush();
  syncMarine();   // phones subscribed before marine alerts existed send their choice once
}
