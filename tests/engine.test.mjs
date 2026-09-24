import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKET, META } from '../dist/data/market.js';
import { buildMarket, regimeAt, WARMUP } from '../dist/engine/market.js';
import { simulate, stats, pValue, history, gate, buildEvents, FEE, SLIP } from '../dist/engine/backtest.js';
import { SETUPS, triggersAt } from '../dist/engine/setups.js';
import { Memory, MEMORY_WINDOW } from '../dist/engine/memory.js';
import { Book } from '../dist/engine/book.js';
import { Lumen } from '../dist/engine/lumen.js';
import { localResearch, localVerdict } from '../dist/engine/reasoner.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const M = buildMarket(MARKET, META);

test('bundled data: 8 aligned hourly series with funding', () => {
  assert.deepEqual(META.assets, ['SOL', 'BTC', 'ETH', 'JUP', 'BONK', 'WIF', 'JTO', 'PYTH']);
  for (const a of META.assets) {
    const c = MARKET[a].candles;
    assert.equal(c.length, META.hours, a);
    for (let i = 1; i < c.length; i++) assert.equal(c[i][0] - c[i - 1][0], 3600, `${a} gap at ${i}`);
    for (const [, o, h, l, cl] of c) assert.ok(h >= Math.max(o, cl) - 1e-12 && l <= Math.min(o, cl) + 1e-12 && l > 0, a);
    assert.ok(MARKET[a].funding.length > 100, `${a} funding`);
    assert.equal(c[0][0], MARKET.SOL.candles[0][0], `${a} aligned`);
  }
});

test('features are causal: changing the future does not change the past', () => {
  const i = 3000, m2 = clone(MARKET);
  for (const a of META.assets) for (let k = i + 1; k < m2[a].candles.length; k++) { const r = m2[a].candles[k]; r[1] *= 3; r[2] *= 3; r[3] *= 3; r[4] *= 3; r[5] *= 9; }
  const B = buildMarket(m2, META);
  for (const a of META.assets) for (const f of ['sma24', 'atr24', 'z24', 'fundZ', 'volZ', 'widthPct', 'relZ', 'hi24', 'lo168', 'volPct']) {
    const x = M.A[a].f[f][i], y = B.A[a].f[f][i];
    assert.ok((Number.isNaN(x) && Number.isNaN(y)) || Math.abs(x - y) < 1e-9, `${a}.${f}`);
  }
  assert.deepEqual(triggersAt(B, i), triggersAt(M, i));
});

test('simulate: entry at next open with slippage, stop checked before target, fees on both sides', () => {
  const s = { n: 6, open: [100, 100, 100, 100, 100, 100], high: [100, 100, 106, 100, 100, 100], low: [100, 100, 97, 100, 100, 100], close: [100, 100, 100, 100, 100, 100] };
  // bar 2 touches both target (+5%) and stop (-2%): the stop wins
  const r = simulate(s, 0, 1, 0.05, 0.02, 10);
  assert.equal(r.outcome, 'STOP');
  const entry = 100 * (1 + SLIP), exit = entry * 0.98 * (1 - SLIP);
  assert.ok(Math.abs(r.ret - (exit / entry - 1 - 2 * FEE)) < 1e-12);
  // short that hits its target
  const s2 = { n: 5, open: [100, 100, 100, 100, 100], high: [100, 100, 100.5, 100, 100], low: [100, 100, 94, 100, 100], close: [100, 100, 95, 95, 95] };
  const r2 = simulate(s2, 0, -1, 0.05, 0.02, 10);
  assert.equal(r2.outcome, 'TARGET');
  assert.ok(r2.ret > 0.045 && r2.ret < 0.05);
  // unresolved before the limit returns null
  assert.equal(simulate(s2, 0, -1, 0.5, 0.5, 10, 3), null);
});

test('statistics: t-test p-values behave', () => {
  assert.ok(Math.abs(pValue(0, 10) - 0.5) < 1e-9);
  assert.ok(Math.abs(pValue(1.812, 10) - 0.05) < 0.002);   // t table: one-sided 5%, df 10
  assert.ok(Math.abs(pValue(-1.812, 10) - 0.95) < 0.002);
  const s = stats([0.01, 0.02, -0.005, 0.015]);
  assert.equal(s.n, 4); assert.equal(s.hit, 0.75); assert.ok(s.avg > 0 && s.p < 0.2);
});

test('history only sees trades that had closed by decision time', () => {
  const ev = buildEvents(M), now = 3000;
  const h = history(M, ev, { setup: 'TREND_RALLY_FADE', asset: 'SOL', geom: 'swing', regime: 'any' }, now);
  const visible = ev['TREND_RALLY_FADE:swing'].filter((e) => e.exitIdx <= now).length;
  assert.equal(h.all.n, visible);
  assert.ok(ev['TREND_RALLY_FADE:swing'].some((e) => e.exitIdx > now), 'there are later trades that must stay hidden');
  // Bonferroni: the same evidence tested as one of 6 variants needs 6x the p-value margin
  const h6 = history(M, ev, { setup: 'TREND_RALLY_FADE', asset: 'SOL', geom: 'swing', regime: 'any' }, now, 6);
  assert.equal(h6.pAdj, Math.min(1, h.all.p * 6));
});

test('gate: ships only with enough trades, positive expectancy and a small corrected p-value', () => {
  const base = { regime: 'any', regimeNow: 'calm', tried: 1, inRegime: { n: 0, avg: 0 } };
  assert.equal(gate({ ...base, all: { n: 40, avg: 0.01, p: 0.01 }, pAdj: 0.01 }).ship, true);
  assert.equal(gate({ ...base, all: { n: 12, avg: 0.01, p: 0.01 }, pAdj: 0.01 }).ship, false);
  assert.equal(gate({ ...base, all: { n: 40, avg: 0.001, p: 0.01 }, pAdj: 0.01 }).ship, false);
  assert.equal(gate({ ...base, tried: 6, all: { n: 40, avg: 0.01, p: 0.03 }, pAdj: 0.18 }).ship, false);
  const reg = gate({ ...base, inRegime: { n: 10, avg: -0.002 }, all: { n: 40, avg: 0.01, p: 0.01 }, pAdj: 0.01 });
  assert.equal(reg.ship, false); assert.match(reg.reasons[0], /loses in calm/);
});

test('memory blocks a setup in the regime it died in, and only there, and only for a while', () => {
  const mem = new Memory();
  mem.add({ i: 100, setup: 'X', asset: 'SOL', vol: 'calm', trend: 'uptrend', verdict: 'KILL', text: 't' });
  assert.equal(mem.blocking('X', 'calm', 150).length, 1);
  assert.equal(mem.blocking('X', 'high-vol', 150).length, 0);
  assert.equal(mem.blocking('Y', 'calm', 150).length, 0);
  assert.equal(mem.blocking('X', 'calm', 100 + MEMORY_WINDOW + 1).length, 0);
});

test('paper book: fills at next open, marks to market, books P&L on exit', () => {
  const start = 3000, b = new Book(M, start);
  const idea = { asset: 'BTC', dir: 1 };
  const p = b.open(idea, start, 0.5, 0.5, 5, 70);
  assert.ok(Math.abs(p.entry - M.A.BTC.open[start + 1] * (1 + SLIP)) < 1e-9);
  const closed = [];
  for (let k = start + 1; k <= start + 6; k++) closed.push(...b.step(k));
  assert.equal(closed.length, 1); assert.equal(closed[0].outcome, 'TIME');
  assert.ok(Math.abs(b.cash - (10000 + closed[0].pnl)) < 1e-9);
  assert.equal(b.positions.length, 0);
});

test('full local replay is deterministic and respects the gate', () => {
  const run = () => {
    const L = new Lumen(MARKET, META);
    const shipped = [];
    let guard = 0;
    while (!L.done && guard++ < 5000) {
      const ctx = L.beginCycle();
      if (ctx) {
        const r = localResearch(L, ctx);
        if (r.skip) L.skip(ctx, 'memory');
        else {
          const t = L.test(ctx, r.pick, r.tried), v = localVerdict(L, ctx, t), d = L.decide(ctx, t, v);
          if (d.final === 'SHIP') { assert.ok(t.g.ship, 'shipped only through the gate'); shipped.push(t.idea.id); }
        }
      }
      L.tick();
    }
    return { stats: L.stats, shipped, equity: Math.round(L.book.equity(L.now) * 100) };
  };
  const a = run(), b = run();
  assert.deepEqual(a, b);
  assert.ok(a.stats.researched > 20);
  assert.ok(a.stats.killed > a.stats.shipped, 'most ideas die');
});

test('the engine downgrades a SHIP that fails the gate, whatever the reasoner says', () => {
  const L = new Lumen(MARKET, META);
  let ctx = null;
  while (!ctx && !L.done) { ctx = L.beginCycle(); if (!ctx) L.tick(); }
  const t = L.test(ctx, { index: 0, geom: 'tight', regime: 'any' });
  t.g = { ship: false, paper: false, reasons: ['forced failure'] };
  const d = L.decide(ctx, t, { verdict: 'SHIP', conviction: 99, reason: 'model insists', lesson: '' });
  assert.equal(d.final, 'KILL'); assert.equal(d.overruled, 'gate');
  assert.equal(L.book.positions.length, 0);
});

test('regime labels are well formed', () => {
  for (const a of META.assets) {
    const r = regimeAt(M.A[a], WARMUP + 10);
    assert.ok(['calm', 'high-vol'].includes(r.vol) && ['uptrend', 'downtrend', 'flat'].includes(r.trend));
  }
  assert.ok(SETUPS.length >= 10);
});
