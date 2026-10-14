// When to alert. One state object per subscriber per watched place.
import { P_MAYBE } from '../forecast.js';

export const ALERT_LEAD_MIN = 15;   // alert when rain is due within this many minutes
export const REALERT_MIN = 45;      // never alert the same place more often than this

export const newState = () => ({ armed: true, dry: 0, lastAlert: 0 });

// Returns true when an alert should go out now, updating `st`.
export function decide(st, summary, series, now = Date.now()) {
  const soon = summary.raining || (summary.start !== null && summary.start <= ALERT_LEAD_MIN);
  const clear = !summary.raining && summary.start === null && Math.max(...series.map((x) => x.prob)) < P_MAYBE;
  if (clear) {
    // Re-arm only after two dry checks in a row, so a flickering forecast doesn't repeat alerts.
    if (++st.dry >= 2) st.armed = true;
  } else {
    st.dry = 0;
  }
  if (soon && st.armed && now - st.lastAlert > REALERT_MIN * 60000) {
    st.armed = false;
    st.lastAlert = now;
    return true;
  }
  return false;
}
