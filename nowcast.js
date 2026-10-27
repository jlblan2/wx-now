// Radar nowcasting: the Dark Sky approach.
//  1. Clean each radar frame and convert reflectivity to rain rate.
//  2. Track how echoes moved between frames (block-matching correlation, "TREC").
//  3. Build a smooth motion field from the tracked vectors.
//  4. Trace backwards along the motion field from the forecast point to find which
//     rain will arrive there, minute by minute (semi-Lagrangian extrapolation).
//  5. Sample a neighbourhood that widens with lead time to turn that into a
//     probability and an intensity.
// All positions are grid pixels (x east, y south); velocities are pixels per minute.

export const MIN_DBZ = 15;          // weaker echoes are mostly noise, clear-air return or virga
export const RAIN_DBZ = 18;         // echo strong enough that precipitation is likely reaching the ground
export const RAIN_RATE = dbzToRate(RAIN_DBZ);
export const MAX_SPEED_KMH = 160;   // fastest storm motion searched for

const COARSE = 4;            // downsampling factor for the first motion search
const MIN_CORR = 0.5;        // weakest block correlation accepted as a real match
const MOTION_SIGMA_KM = 35;  // smoothing length of the motion field
const R0_KM = 2;             // neighbourhood radius at lead 0 ...
const RGROW_KM = 0.22;       // ... growing by this much per minute of lead time

// Marshall-Palmer Z = 200 R^1.6, capped at 55 dBZ so hail does not imply absurd rain rates.
export function dbzToRate(dbz) {
  if (!(dbz >= MIN_DBZ)) return 0;
  return Math.pow(Math.pow(10, Math.min(dbz, 55) / 10) / 200, 1 / 1.6);
}

// Turns a reflectivity grid into a cleaned field. Isolated echo pixels (fewer than two
// echo neighbours) are removed as speckle.
export function makeField(dbz, w, h, dx, time) {
  const n = w * h;
  const rate = new Float32Array(n);
  const z = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d = dbz[i];
      if (!(d >= MIN_DBZ)) continue;
      let nb = 0;
      for (let oy = -1; oy <= 1; oy++) {
        const yy = y + oy;
        if (yy < 0 || yy >= h) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const xx = x + ox;
          if ((ox || oy) && xx >= 0 && xx < w && dbz[yy * w + xx] >= MIN_DBZ) nb++;
        }
      }
      if (nb < 2) continue;
      rate[i] = dbzToRate(d);
      z[i] = Math.min(d, 60) - MIN_DBZ + 1;
    }
  }
  return { w, h, dx, time, rate, z };
}

function downsample(a, w, h, f) {
  const w2 = Math.floor(w / f), h2 = Math.floor(h / f);
  const out = new Float32Array(w2 * h2);
  const k = 1 / (f * f);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      let s = 0;
      for (let yy = 0; yy < f; yy++) {
        const row = (y * f + yy) * w + x * f;
        for (let xx = 0; xx < f; xx++) s += a[row + xx];
      }
      out[y * w2 + x] = s * k;
    }
  }
  return { a: out, w: w2, h: h2 };
}

// Pearson correlation between the block of A centred on (cx, cy) and the block of B
// centred on (cx + ox, cy + oy). The caller keeps both blocks inside the grid.
function blockCorr(A, B, w, cx, cy, ox, oy, hb) {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = -hb; y <= hb; y++) {
    const ia = (cy + y) * w + cx;
    const ib = (cy + y + oy) * w + cx + ox;
    for (let x = -hb; x <= hb; x++) {
      const a = A[ia + x], b = B[ib + x];
      sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; n++;
    }
  }
  const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
  if (va <= 1e-6 || vb <= 1e-6) return NaN;
  return (sab - sa * sb / n) / Math.sqrt(va * vb);
}

function blockFits(w, h, cx, cy, ox, oy, hb) {
  return cx - hb >= 0 && cy - hb >= 0 && cx + hb < w && cy + hb < h &&
    cx + ox - hb >= 0 && cy + oy - hb >= 0 && cx + ox + hb < w && cy + oy + hb < h;
}

// Motion vectors between two fields dt minutes apart: coarse search on a downsampled grid,
// then refinement and sub-pixel fitting at full resolution.
export function trackPair(A, B, dt) {
  const { w, h, dx } = A;
  const a4 = downsample(A.z, w, h, COARSE), b4 = downsample(B.z, w, h, COARSE);
  const w4 = a4.w, h4 = a4.h;
  const hb4 = 4, step = 3, hb = 12, refine = 2;
  const S = Math.ceil((MAX_SPEED_KMH / 60) * dt / (COARSE * dx));
  const vecs = [];
  for (let cy4 = hb4; cy4 < h4 - hb4; cy4 += step) {
    for (let cx4 = hb4; cx4 < w4 - hb4; cx4 += step) {
      let echo = 0;
      for (let y = -hb4; y <= hb4; y++) {
        for (let x = -hb4; x <= hb4; x++) if (a4.a[(cy4 + y) * w4 + cx4 + x] > 0) echo++;
      }
      if (echo < 0.15 * (2 * hb4 + 1) ** 2) continue;

      let best = -2, bx = 0, by = 0;
      for (let oy = -S; oy <= S; oy++) {
        for (let ox = -S; ox <= S; ox++) {
          if (!blockFits(w4, h4, cx4, cy4, ox, oy, hb4)) continue;
          const r = blockCorr(a4.a, b4.a, w4, cx4, cy4, ox, oy, hb4);
          if (r > best) { best = r; bx = ox; by = oy; }
        }
      }
      if (!(best >= MIN_CORR)) continue;

      const cx = cx4 * COARSE + (COARSE >> 1), cy = cy4 * COARSE + (COARSE >> 1);
      const ox0 = bx * COARSE, oy0 = by * COARSE;
      const grid = [];
      let fb = -2, fx = 0, fy = 0;
      for (let j = -refine; j <= refine; j++) {
        for (let i = -refine; i <= refine; i++) {
          const ox = ox0 + i, oy = oy0 + j;
          const r = blockFits(w, h, cx, cy, ox, oy, hb) ? blockCorr(A.z, B.z, w, cx, cy, ox, oy, hb) : NaN;
          grid.push(r);
          if (r > fb) { fb = r; fx = i; fy = j; }
        }
      }
      if (!(fb >= MIN_CORR)) continue;
      const g = (i, j) => grid[(j + refine) * (2 * refine + 1) + (i + refine)];
      let sx = 0, sy = 0;
      if (Math.abs(fx) < refine && Math.abs(fy) < refine) {
        sx = subpixel(g(fx - 1, fy), fb, g(fx + 1, fy));
        sy = subpixel(g(fx, fy - 1), fb, g(fx, fy + 1));
      }
      vecs.push({
        x: cx, y: cy,
        u: (ox0 + fx + sx) / dt, v: (oy0 + fy + sy) / dt,
        r: fb,
      });
    }
  }
  return vecs;
}

function subpixel(l, c, r) {
  const d = l - 2 * c + r;
  if (!(d < 0)) return 0;
  return Math.max(-0.5, Math.min(0.5, (l - r) / (2 * d)));
}

function weightedMedian(vals, wts) {
  const idx = vals.map((_, i) => i).sort((a, b) => vals[a] - vals[b]);
  const total = wts.reduce((s, x) => s + x, 0);
  let acc = 0;
  for (const i of idx) {
    acc += wts[i];
    if (acc >= total / 2) return vals[i];
  }
  return 0;
}

// Drops vectors that disagree with their neighbours (bad matches on changing echoes).
export function filterVectors(vecs, dx) {
  const rad = 45 / dx, tolAbs = (15 / 60) / dx;
  return vecs.filter((p) => {
    const us = [], vs = [];
    for (const q of vecs) {
      if (q !== p && (q.x - p.x) ** 2 + (q.y - p.y) ** 2 <= rad * rad) { us.push(q.u); vs.push(q.v); }
    }
    if (us.length < 3) return true;
    const ones = us.map(() => 1);
    const mu = weightedMedian(us, ones), mv = weightedMedian(vs, ones);
    const dev = Math.hypot(p.u - mu, p.v - mv);
    return dev <= Math.max(tolAbs, 0.35 * Math.hypot(mu, mv));
  });
}

// Smooth dense motion field from scattered vectors. Far from any vector it relaxes to the
// overall (median) motion, so storms entering from data-sparse areas still move sensibly.
export function buildMotionField(vecs, w, h, dx) {
  const step = 6;
  const gw = Math.ceil((w - 1) / step) + 1, gh = Math.ceil((h - 1) / step) + 1;
  const U = new Float32Array(gw * gh), V = new Float32Array(gw * gh);
  const S = new Float32Array(gw * gh);   // support: how much tracked evidence each node has
  const gu = vecs.length ? weightedMedian(vecs.map((p) => p.u), vecs.map((p) => p.r)) : 0;
  const gv = vecs.length ? weightedMedian(vecs.map((p) => p.v), vecs.map((p) => p.r)) : 0;
  const s = MOTION_SIGMA_KM / dx, k = 1 / (2 * s * s), prior = 0.02;
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const x = i * step, y = j * step;
      let sw = prior, su = prior * gu, sv = prior * gv;
      for (const p of vecs) {
        const wt = p.r * Math.exp(-((p.x - x) ** 2 + (p.y - y) ** 2) * k);
        sw += wt; su += wt * p.u; sv += wt * p.v;
      }
      U[j * gw + i] = su / sw;
      V[j * gw + i] = sv / sw;
      S[j * gw + i] = sw - prior;
    }
  }
  return { U, V, S, gw, gh, step, w, h, dx, global: { u: gu, v: gv }, count: vecs.length };
}

export function velocity(mf, x, y) {
  const fx = Math.max(0, Math.min(mf.gw - 1.001, x / mf.step));
  const fy = Math.max(0, Math.min(mf.gh - 1.001, y / mf.step));
  const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
  const a = j * mf.gw + i, b = a + mf.gw;
  return {
    u: (mf.U[a] * (1 - tx) + mf.U[a + 1] * tx) * (1 - ty) + (mf.U[b] * (1 - tx) + mf.U[b + 1] * tx) * ty,
    v: (mf.V[a] * (1 - tx) + mf.V[a + 1] * tx) * (1 - ty) + (mf.V[b] * (1 - tx) + mf.V[b + 1] * tx) * ty,
  };
}

// Tracks every pair of fields about `sep` minutes apart and returns a motion field.
// `fields` must be sorted oldest first.
export function estimateMotion(fields, sep = 15) {
  if (!fields.length) return null;
  const { w, h, dx } = fields[0];
  let vecs = [];
  for (let i = 0; i < fields.length; i++) {
    for (let j = i + 1; j < fields.length; j++) {
      const dt = (fields[j].time - fields[i].time) / 60000;
      if (Math.abs(dt - sep) <= 1) vecs = vecs.concat(trackPair(fields[i], fields[j], dt));
    }
  }
  return buildMotionField(filterVectors(vecs, dx), w, h, dx);
}

// Positions at each minute 0..minutes of the parcel that arrives at (x, y), traced
// backwards through the motion field (midpoint steps).
export function backTrajectory(mf, x, y, minutes) {
  const xs = [x], ys = [y];
  for (let t = 1; t <= minutes; t++) {
    const a = velocity(mf, x, y);
    const b = velocity(mf, x - a.u / 2, y - a.v / 2);
    x -= b.u; y -= b.v;
    xs.push(x); ys.push(y);
  }
  return { xs, ys };
}

// Minute-by-minute probability and intensity at grid point (x, y), for leads
// 0..maxLead minutes after the field's time. `coverage` is the share of the
// neighbourhood that lay inside the radar grid (1 = fully known).
export function pointForecast(field, mf, x, y, maxLead) {
  const { w, h, dx, rate } = field;
  const traj = backTrajectory(mf, x, y, maxLead);
  const prob = [], intensity = [], coverage = [];
  for (let t = 0; t <= maxLead; t++) {
    const px = traj.xs[t], py = traj.ys[t];
    const rkm = R0_KM + RGROW_KM * t, rpx = rkm / dx, sig = rpx / 2;
    const k = 1 / (2 * sig * sig);
    let wIn = 0, wOut = 0, wRain = 0, sR = 0;
    const x0 = Math.floor(px - rpx), x1 = Math.ceil(px + rpx);
    const y0 = Math.floor(py - rpx), y1 = Math.ceil(py + rpx);
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const d2 = (xx - px) ** 2 + (yy - py) ** 2;
        if (d2 > rpx * rpx) continue;
        const wt = Math.exp(-d2 * k);
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) { wOut += wt; continue; }
        wIn += wt;
        const r = rate[yy * w + xx];
        if (r >= RAIN_RATE) { wRain += wt; sR += wt * r; }
      }
    }
    prob.push(wIn > 0 ? wRain / wIn : 0);
    intensity.push(wRain > 0 ? sR / wRain : 0);
    coverage.push(wIn / (wIn + wOut || 1));
  }
  return { prob, intensity, coverage, traj };
}

function sample(rate, w, h, x, y) {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 0;
  const i = Math.min(Math.floor(x), w - 2), j = Math.min(Math.floor(y), h - 2);
  const tx = x - i, ty = y - j, a = j * w + i, b = a + w;
  return (rate[a] * (1 - tx) + rate[a + 1] * tx) * (1 - ty) + (rate[b] * (1 - tx) + rate[b + 1] * tx) * ty;
}

// Whole-grid rain-rate forecast `minutes` ahead (for the map animation and self-check).
// `mask(x, y)` can restrict the work to the pixels that are needed.
export function advectField(field, mf, minutes, mask) {
  const { w, h, rate } = field;
  const out = new Float32Array(w * h);
  const steps = Math.max(1, Math.round(minutes / 5)), dtm = minutes / steps;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask && !mask(x, y)) continue;
      let px = x, py = y;
      for (let s = 0; s < steps; s++) {
        const a = velocity(mf, px, py);
        const b = velocity(mf, px - a.u * dtm / 2, py - a.v * dtm / 2);
        px -= b.u * dtm; py -= b.v * dtm;
      }
      out[y * w + x] = sample(rate, w, h, px, py);
    }
  }
  return out;
}

// Critical success index of `fc` against `obs` within `radius` pixels of (cx, cy), on
// 4-pixel cells so near misses of a kilometre or two are not counted as failures.
export function csi(fc, obs, w, h, cx, cy, radius) {
  let hit = 0, miss = 0, fa = 0;
  const c = 4;
  for (let y = 0; y + c <= h; y += c) {
    for (let x = 0; x + c <= w; x += c) {
      if ((x + c / 2 - cx) ** 2 + (y + c / 2 - cy) ** 2 > radius * radius) continue;
      let f = false, o = false;
      for (let yy = y; yy < y + c; yy++) {
        for (let xx = x; xx < x + c; xx++) {
          const i = yy * w + xx;
          if (fc[i] >= RAIN_RATE) f = true;
          if (obs[i] >= RAIN_RATE) o = true;
        }
      }
      if (f && o) hit++; else if (o) miss++; else if (f) fa++;
    }
  }
  const n = hit + miss + fa;
  return { score: n ? hit / n : NaN, events: hit + miss };
}

// Self-check: forecast the latest frame from older frames and score it, alongside a
// "nothing moves" persistence forecast for comparison.
export function hindcast(fields, lead, cx, cy, radius) {
  const target = fields[fields.length - 1];
  const startTime = target.time - lead * 60000;
  const si = fields.findIndex((f) => Math.abs(f.time - startTime) < 90000);
  if (si < 0) return null;
  const history = fields.slice(0, si + 1);
  const mf = estimateMotion(history);
  if (!mf || !mf.count) return null;
  const r2 = radius * radius;
  const mask = (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r2 + 64;
  const fc = advectField(fields[si], mf, lead, mask);
  const tracked = csi(fc, target.rate, target.w, target.h, cx, cy, radius);
  const persist = csi(fields[si].rate, target.rate, target.w, target.h, cx, cy, radius);
  return { lead, tracked: tracked.score, persistence: persist.score, events: tracked.events };
}
