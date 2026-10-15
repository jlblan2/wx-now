// Hurricane alerts: for each subscriber's watched places, alert when a storm's threat gets
// worse — inside the forecast cone, a coastal watch/warning nearby (and each upgrade), then
// tropical-storm- or hurricane-force winds arriving. Never the same level twice per storm.
import { threatTo, threatText } from '../storms.js';

const MI_PER_KM = 0.621371;

function inWords(ms) {
  const h = Math.round(ms / 3600000);
  if (h <= 1) return 'now';
  if (h < 48) return `in about ${h} hours`;
  return `in about ${Math.round(h / 24)} days`;
}

// Returns [{ endpoint, payload }] to send, updating each subscriber's `stormState`.
export function stormAlerts(subs, storms, watchList, now = Date.now()) {
  const out = [];
  const live = new Set(storms.map((s) => `${s.bin}:${s.name}`));
  for (const [endpoint, sub] of Object.entries(subs)) {
    const st = sub.stormState = sub.stormState || {};
    for (const key of Object.keys(st)) if (!live.has(key.split('|')[0])) delete st[key];   // storm has ended
    for (const s of storms) {
      for (const place of watchList(sub)) {
        const key = `${s.bin}:${s.name}|${place.key}`;
        const t = threatTo(s, place);
        if (t.level <= (st[key] || 0)) continue;
        st[key] = t.level;
        const miles = Math.round(t.closest.km * MI_PER_KM);
        out.push({
          endpoint,
          payload: {
            title: `${s.title} · ${place.name}`,
            body: `${threatText(s, t)} Closest approach about ${miles} mi ${inWords(t.closest.time - now)}.`,
            tag: `storm-${s.bin}-${place.key}`,
            url: `./?lat=${place.lat.toFixed(4)}&lon=${place.lon.toFixed(4)}&tab=storms`,
          },
        });
      }
    }
  }
  return out;
}
