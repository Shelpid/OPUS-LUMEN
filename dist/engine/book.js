// Paper portfolio. Positions are opened at the open of the bar after the decision and walked forward
// bar by bar with the same stop-first, fees-and-slippage rules as the backtest.

import { FEE, SLIP } from './backtest.js';

export const RISK_PER_TRADE = 0.01;   // of equity, scaled by conviction
export const MAX_POSITIONS = 4;

export class Book {
  constructor(m, startIdx, equity = 10000) {
    this.m = m; this.start = startIdx; this.cash = equity; this.initial = equity;
    this.positions = []; this.closed = []; this.curve = [];
    this.base = Object.fromEntries(m.names.map((n) => [n, m.A[n].close[startIdx]]));
  }

  hasAsset(asset) { return this.positions.some((p) => p.asset === asset); }
  full() { return this.positions.length >= MAX_POSITIONS; }

  // decision at the close of bar i; the fill happens at open[i + 1]
  open(idea, i, tp, sl, horizon, conviction) {
    const s = this.m.A[idea.asset];
    const eq = this.equity(i);
    const risk = eq * RISK_PER_TRADE * Math.min(1.4, conviction / 70);
    const notional = Math.min(eq * 0.6, risk / sl);
    const p = { idea, asset: idea.asset, dir: idea.dir, decided: i, fillIdx: i + 1, lastIdx: i + horizon, tp, sl, notional, entry: null, target: null, stop: null };
    if (i + 1 < s.n) {
      p.entry = s.open[i + 1] * (1 + p.dir * SLIP);
      p.target = p.entry * (1 + p.dir * tp);
      p.stop = p.entry * (1 - p.dir * sl);
    }
    this.positions.push(p);
    return p;
  }

  // process bar k; returns closed trades
  step(k) {
    const out = [];
    for (const p of [...this.positions]) {
      if (k < p.fillIdx || p.entry === null) continue;
      const s = this.m.A[p.asset];
      const hitStop = p.dir > 0 ? s.low[k] <= p.stop : s.high[k] >= p.stop;
      const hitTarget = p.dir > 0 ? s.high[k] >= p.target : s.low[k] <= p.target;
      let px = null, outcome = null;
      if (hitStop) { px = p.stop; outcome = 'STOP'; }
      else if (hitTarget) { px = p.target; outcome = 'TARGET'; }
      else if (k >= p.lastIdx || k === s.n - 1) { px = s.close[k]; outcome = 'TIME'; }
      if (px === null) continue;
      const exit = px * (1 - p.dir * SLIP);
      const ret = p.dir * (exit / p.entry - 1) - 2 * FEE;
      const pnl = p.notional * ret;
      this.cash += pnl;
      const trade = { ...p, exit, exitIdx: k, outcome, ret, pnl };
      this.positions.splice(this.positions.indexOf(p), 1);
      this.closed.push(trade);
      out.push(trade);
    }
    this.curve.push({ k, equity: this.equity(k), hodl: this.hodl(k) });
    return out;
  }

  unrealized(p, k) {
    if (p.entry === null || k < p.fillIdx) return 0;
    const px = this.m.A[p.asset].close[k];
    return p.notional * (p.dir * (px / p.entry - 1) - FEE);
  }

  equity(k) { return this.cash + this.positions.reduce((a, p) => a + this.unrealized(p, k), 0); }

  // equal-weight buy-and-hold of the whole universe from the replay start
  hodl(k) {
    const n = this.m.names;
    return this.initial * n.reduce((a, x) => a + this.m.A[x].close[k] / this.base[x], 0) / n.length;
  }

  maxDD() {
    let peak = this.initial, dd = 0;
    for (const p of this.curve) { peak = Math.max(peak, p.equity); dd = Math.max(dd, 1 - p.equity / peak); }
    return dd;
  }

  summary(k) {
    const c = this.closed, wins = c.filter((t) => t.pnl > 0);
    return {
      trades: c.length, wins: wins.length, hit: c.length ? wins.length / c.length : 0,
      equity: this.equity(k), ret: this.equity(k) / this.initial - 1, hodlRet: this.hodl(k) / this.initial - 1,
      maxDD: this.maxDD(),
    };
  }
}
