// Local, rule-based reasoner. It writes the same tagged lines as the model protocol, from real numbers,
// so the app works with no API key. It is labelled LOCAL everywhere in the UI.
// Because it compares several variants before choosing one, its p-values are Bonferroni-corrected.

import { SETUP, GEOMS } from './setups.js';
import { history } from './backtest.js';
import { SHIP_LINE, fmtPx, pct, clockOf } from './lumen.js';

const LONG = (d) => (d > 0 ? 'long' : 'short');

export function pickCandidate(L, ctx) {
  const free = ctx.candidates.findIndex((c) => !c.blocked.length);
  return free;
}

// evidence checklist shown in the CONVICTION panel (used by both reasoners)
export function evidence(L, ctx, t) {
  const { cand, h } = t, m = L.m, s = m.A[cand.asset], i = ctx.i;
  const out = [];
  out.push(cand.strength >= 0.5 ? { name: `Signal strength ${cand.strength.toFixed(2)}`, side: 'for', w: 6 } : { name: `Weak signal ${cand.strength.toFixed(2)}`, side: 'against', w: -4 });
  if (h.trendNow === 'flat') out.push({ name: 'No trend to lean on', side: 'against', w: -3 });
  else if ((h.trendNow === 'uptrend') === (cand.dir > 0)) out.push({ name: `Trades with the ${h.trendNow}`, side: 'for', w: 8 });
  else out.push({ name: `Fights the ${h.trendNow}`, side: 'against', w: -8 });
  if (cand.asset !== 'BTC') {
    const b = m.A.BTC.f.ret24[i];
    out.push(Math.sign(b) === cand.dir ? { name: `BTC backdrop ${pct(b)}`, side: 'for', w: 4 } : { name: `BTC backdrop ${pct(b)}`, side: 'against', w: -4 });
  }
  if (h.all.n < 5) out.push({ name: `Almost no history (${h.all.n})`, side: 'against', w: -12 });
  else if (h.all.avg > 0 && h.pAdj < 0.1) out.push({ name: `Replay ${pct(h.all.avg, 2)} over ${h.all.n}`, side: 'for', w: 16 });
  else if (h.all.avg > 0) out.push({ name: `Replay ${pct(h.all.avg, 2)}, not significant`, side: 'for', w: 5 });
  else out.push({ name: `Replay ${pct(h.all.avg, 2)} over ${h.all.n}`, side: 'against', w: -16 });
  if (h.inRegime.n >= 8) out.push(h.inRegime.avg > 0 ? { name: `Works in ${h.regimeNow} markets`, side: 'for', w: 6 } : { name: `Loses in ${h.regimeNow} markets`, side: 'against', w: -10 });
  const past = L.memory.about(cand.setup).filter((l) => l.verdict === 'KILL' || l.verdict === 'LOSS');
  if (past.length) out.push({ name: `Died ${past.length}× before (${past[0].vol})`, side: 'against', w: -Math.min(8, 3 * past.length) });
  return out.slice(0, 5);
}

export const convictionOf = (checks) => Math.max(5, Math.min(95, Math.round(50 + checks.reduce((a, c) => a + c.w, 0))));

export function localResearch(L, ctx) {
  const k = pickCandidate(L, ctx);
  if (k < 0) {
    const c = ctx.candidates[0];
    return { skip: true, lines: [
      { tag: 'OBSERVE', text: `${ctx.candidates.length} idea${ctx.candidates.length > 1 ? 's' : ''} triggered · strongest: ${LONG(c.dir)} ${c.asset} ${c.name}` },
      { tag: 'THINK', text: `memory: every one of them died in ${c.vol} conditions in the last 14 days · waiting for the regime to change` },
    ] };
  }
  const cand = ctx.candidates[k], s = L.m.A[cand.asset], i = ctx.i, st = SETUP[cand.setup];
  // compare exit geometries and regime scopes, keep the best t-stat
  const variants = [];
  for (const geom of Object.keys(GEOMS)) for (const regime of ['any', cand.vol]) {
    const h = history(L.m, L.events, { setup: cand.setup, asset: cand.asset, geom, regime }, i);
    if (h.all.n >= 5) variants.push({ geom, regime, t: h.all.t });
  }
  variants.sort((a, b) => b.t - a.t);
  const best = variants[0] || { geom: 'tight', regime: 'any' };
  const tried = Math.max(1, variants.length);
  const g = GEOMS[best.geom], a = s.f.atr24[i] / s.close[i], px = s.close[i];
  const tgt = px * (1 + cand.dir * a * g.tpAtr), stp = px * (1 - cand.dir * a * g.slAtr);
  const b = L.m.A.BTC.f.ret24[i];
  const skipped = ctx.candidates.slice(0, k).filter((c) => c.blocked.length);
  const lines = [
    { tag: 'OBSERVE', text: `${cand.asset} ${cand.observe}` },
    { tag: 'OBSERVE', text: `${cand.asset} is in a ${cand.vol} ${cand.trend} · BTC ${pct(b)} over 24h` },
    { tag: 'THINK', text: st.think },
    { tag: 'HYPOTHESIS', text: `${LONG(cand.dir)} ${cand.asset} near ${fmtPx(px)} · target ${fmtPx(tgt)} (${pct(cand.dir * a * g.tpAtr)}) · invalid ${fmtPx(stp)} (${pct(-cand.dir * a * g.slAtr)})` },
  ];
  if (skipped.length) lines.splice(1, 0, { tag: 'THINK', text: `skipping ${skipped[0].asset} ${skipped[0].name}: it died in ${skipped[0].vol} conditions ${i - skipped[0].blocked[0].i}h ago` });
  const other = L.memory.about(cand.setup).find((l) => l.verdict === 'KILL' && l.vol !== cand.vol);
  const against = (cand.trend === 'uptrend' && cand.dir < 0) || (cand.trend === 'downtrend' && cand.dir > 0);
  lines.push({ tag: 'COUNTER', text: other ? `this setup died in ${other.vol} conditions ${i - other.i}h ago · conditions are ${cand.vol} now, so it gets one more look`
    : against ? `it fights the ${cand.trend}; counter-trend ideas need much better evidence`
    : Math.sign(b) !== cand.dir && cand.asset !== 'BTC' ? `BTC is moving the other way (${pct(b)}); alt beta can swamp the signal`
    : cand.vol === 'high-vol' ? 'volatility is high; stops get hit by noise more often' : 'a clean-looking setup is exactly what everyone else sees too' });
  lines.push({ tag: 'PLAN', text: JSON.stringify({ candidate: `c${k + 1}`, geometry: best.geom, regime: best.regime }) });
  return { pick: { index: k, geom: best.geom, regime: best.regime }, tried, lines };
}

export function localVerdict(L, ctx, t) {
  const { h, g } = t;
  const checks = evidence(L, ctx, t);
  const conviction = convictionOf(checks);
  const since = clockOf(h.since).slice(0, 10);
  const lines = [{ tag: 'TEST', text: `${h.all.n} past ${SETUP[h.setup].name} trades since ${since} · hit ${(h.all.hit * 100).toFixed(0)}% · avg ${pct(h.all.avg, 2)} after costs · p ${h.pAdj.toFixed(2)}${h.tried > 1 ? ` (${h.tried} variants)` : ''}` }];
  if (h.inRegime.n >= 3) lines.push({ tag: 'TEST', text: `in ${h.regimeNow} conditions: ${h.inRegime.n} trades · avg ${pct(h.inRegime.avg, 2)}` });
  let verdict, reason, lesson = '';
  if (g.ship && conviction >= SHIP_LINE) { verdict = 'SHIP'; reason = `edge survived the gate · conviction ${conviction}`; }
  else if (g.ship || g.paper) { verdict = 'PAPER'; reason = g.ship ? `passed the gate but conviction ${conviction} is under ${SHIP_LINE}` : `promising, unproven: ${g.reasons[0]}`; lesson = `${h.setup} ${h.dir > 0 ? 'long' : 'short'} in ${h.regimeNow} ${h.trendNow}: ${reason}`; }
  else { verdict = 'KILL'; reason = g.reasons[0]; lesson = `${h.setup} in ${h.regimeNow} ${h.trendNow}: ${g.reasons.join('; ')}`; }
  lines.push({ tag: 'VERDICT', text: `${verdict} · ${reason}` });
  lines.push({ tag: 'CONVICTION', text: String(conviction) });
  if (lesson) lines.push({ tag: 'LESSON', text: lesson });
  return { verdict, conviction, reason, lesson, lines, checks };
}
