// Historical replay of a setup. Decisions happen at the close of bar i, fills at the open of i + 1.
// Inside a bar the stop is checked before the target (adverse first). Every trade pays fees and
// slippage on both sides. At decision time `now`, only trades that had already closed are visible.

import { SETUPS, SETUP, GEOMS } from './setups.js';
import { regimeAt, WARMUP } from './market.js';

export const FEE = 0.0005;   // per side, taker-like on perps
export const SLIP = 0.0005;  // per side

export function exits(s, i, geom) {
  const a = s.f.atr24[i] / s.close[i];
  return { tp: a * geom.tpAtr, sl: a * geom.slAtr };
}

// Simulate one trade. Returns null if it cannot be resolved using bars <= limit.
export function simulate(s, i, dir, tp, sl, horizon, limit = s.n - 1) {
  if (i + 1 > limit) return null;
  const entry = s.open[i + 1] * (1 + dir * SLIP);
  const target = entry * (1 + dir * tp), stop = entry * (1 - dir * sl);
  const last = i + horizon;
  for (let k = i + 1; k <= Math.min(last, limit); k++) {
    const hitStop = dir > 0 ? s.low[k] <= stop : s.high[k] >= stop;
    const hitTarget = dir > 0 ? s.high[k] >= target : s.low[k] <= target;
    let px = null, outcome = null;
    if (hitStop) { px = stop; outcome = 'STOP'; }
    else if (hitTarget) { px = target; outcome = 'TARGET'; }
    else if (k === last) { px = s.close[k]; outcome = 'TIME'; }
    if (px !== null) {
      const exitPx = px * (1 - dir * SLIP);
      return { entry, exit: exitPx, exitIdx: k, outcome, ret: dir * (exitPx / entry - 1) - 2 * FEE, target, stop };
    }
  }
  return null;
}

// All non-overlapping historical trades of every setup x exit geometry on every asset, resolved on
// the full data. A trade only becomes visible to the engine once exitIdx <= now (see history()).
export function buildEvents(m) {
  const ev = {};
  for (const st of SETUPS) {
    for (const [gk, geom] of Object.entries(GEOMS)) {
      const list = (ev[st.id + ':' + gk] = []);
      for (const name of m.names) {
        const s = m.A[name];
        let busyUntil = -1;
        for (let i = WARMUP; i < s.n - 1; i++) {
          if (i <= busyUntil || !(st.detect(s, i, m) > 0)) continue;
          const { tp, sl } = exits(s, i, geom);
          const r = simulate(s, i, st.dir, tp, sl, geom.horizon);
          if (!r) continue;
          const reg = regimeAt(s, i);
          list.push({ asset: name, i, exitIdx: r.exitIdx, ret: r.ret, outcome: r.outcome, vol: reg.vol, trend: reg.trend });
          busyUntil = r.exitIdx;
        }
      }
      list.sort((a, b) => a.exitIdx - b.exitIdx);
    }
  }
  return ev;
}

// --- statistics -----------------------------------------------------------------------------------
function betacf(a, b, x) {
  let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d; let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30; c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30; d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30; c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30; d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}
function lgamma(z) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z, y = z, tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015; for (const c of g) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
export function incBeta(a, b, x) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
// one-sided p-value for H1: mean > 0
export function pValue(t, df) {
  if (!(df > 0) || !Number.isFinite(t)) return 1;
  const tail = 0.5 * incBeta(df / 2, 0.5, df / (df + t * t));
  return t > 0 ? tail : 1 - tail;
}

export function stats(rets) {
  const n = rets.length;
  if (!n) return { n: 0, hit: 0, avg: 0, t: 0, p: 1, best: 0, worst: 0 };
  const avg = rets.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(rets.reduce((a, r) => a + (r - avg) ** 2, 0) / (n - 1)) : 0;
  const t = sd > 0 ? avg / (sd / Math.sqrt(n)) : 0;
  return { n, hit: rets.filter((r) => r > 0).length / n, avg, t, p: n > 1 ? pValue(t, n - 1) : 1, best: Math.max(...rets), worst: Math.min(...rets) };
}

// Evidence for a hypothesis at decision time `now`.
// hyp = { setup, asset, geom: 'tight'|'wide'|'swing', regime: 'any'|'calm'|'high-vol' }
// `tried` = how many variants were compared before choosing this one (Bonferroni correction).
export function history(m, events, hyp, now, tried = 1) {
  const s = m.A[hyp.asset], reg = regimeAt(s, now);
  const known = events[hyp.setup + ':' + hyp.geom].filter((e) => e.exitIdx <= now);
  const scoped = hyp.regime === 'any' ? known : known.filter((e) => e.vol === hyp.regime);
  const all = stats(scoped.map((e) => e.ret));
  const same = stats(scoped.filter((e) => e.asset === hyp.asset).map((e) => e.ret));
  const inRegime = stats(known.filter((e) => e.vol === reg.vol).map((e) => e.ret));
  const since = scoped.length ? m.time[scoped.reduce((a, e) => Math.min(a, e.i), Infinity)] : m.time[now];
  return { ...hyp, dir: SETUP[hyp.setup].dir, all, same, inRegime, regimeNow: reg.vol, trendNow: reg.trend, since, tried, pAdj: Math.min(1, all.p * tried) };
}

// The hard gate. The reasoning layer can argue, but it cannot ship what fails here.
export const GATE = { minN: 20, minAvg: 0.0015, maxP: 0.1, minRegimeN: 8 };
export function gate(h) {
  const reasons = [];
  if (h.all.n < GATE.minN) reasons.push(`only ${h.all.n} past trades (need ${GATE.minN})`);
  if (h.all.avg < GATE.minAvg) reasons.push(`expectancy ${(h.all.avg * 100).toFixed(2)}% per trade after costs (need +${(GATE.minAvg * 100).toFixed(2)}%)`);
  if (h.pAdj > GATE.maxP) reasons.push(`p = ${h.pAdj.toFixed(2)}${h.tried > 1 ? ` after ${h.tried}-variant correction` : ''} (need < ${GATE.maxP})`);
  if (h.regime === 'any' && h.inRegime.n >= GATE.minRegimeN && h.inRegime.avg <= 0) reasons.push(`loses in ${h.regimeNow} conditions (${(h.inRegime.avg * 100).toFixed(2)}% over ${h.inRegime.n})`);
  const ship = reasons.length === 0;
  const paper = !ship && h.all.avg > 0 && h.pAdj < 0.35;
  return { ship, paper, reasons };
}
