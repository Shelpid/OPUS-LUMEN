// The OPUS LUMEN engine: a replay clock over real hourly data, a research cycle
// (candidates -> hypothesis -> backtest -> verdict), the gate, the memory and the paper book.
// Reasoners (local rules or Claude Opus 5.5) plug into beginCycle() / test() / decide().

import { buildMarket, regimeAt } from './market.js';
import { SETUP, GEOMS, triggersAt } from './setups.js';
import { buildEvents, history, gate, exits, simulate } from './backtest.js';
import { Memory } from './memory.js';
import { Book } from './book.js';

export const CYCLE_GAP = 4;      // hours between research cycles
export const SHIP_LINE = 65;     // conviction needed to ship
export const SPARK_TTL = 6;      // hours an unresearched spark stays on the board

export const fmtPx = (x) => (x >= 1000 ? x.toFixed(0) : x >= 10 ? x.toFixed(2) : x >= 0.1 ? x.toFixed(4) : x.toPrecision(3));
export const pct = (x, d = 1) => (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(d) + '%';
export const clockOf = (sec) => new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ');

export class Lumen {
  constructor(MARKET, META, { startFrac = 0.7 } = {}) {
    this.m = buildMarket(MARKET, META);
    this.events = buildEvents(this.m);
    this.start = this.now = Math.floor(this.m.n * startFrac);
    this.memory = new Memory();
    this.book = new Book(this.m, this.start);
    this.ideas = [];
    this.nextId = 4801;
    this.lastCycle = -Infinity;
    this.stats = { researched: 0, shipped: 0, papered: 0, killed: 0, overruled: 0, sparks: 0, skipped: 0 };
  }

  get done() { return this.now >= this.m.n - 1; }
  clock(i = this.now) { return clockOf(this.m.time[i] + 3600); } // bar close time

  // ------------------------------------------------------------------ clock
  tick() {
    if (this.done) return [];
    this.now++;
    const ev = [];
    for (const t of this.book.step(this.now)) {
      const idea = t.idea;
      Object.assign(idea, { state: 'closed', updated: this.now, pnl: t.pnl, ret: t.ret, outcome: t.outcome });
      ev.push({ type: 'CLOSE', idea, trade: t });
      if (t.pnl <= 0) {
        const reg = regimeAt(this.m.A[idea.asset], idea.born);
        this.memory.add({ i: this.now, setup: idea.setup, asset: idea.asset, vol: reg.vol, trend: reg.trend, verdict: 'LOSS', text: `shipped trade lost ${pct(t.ret, 2)} (${t.outcome.toLowerCase()})` });
      }
    }
    for (const idea of this.ideas) {
      if (idea.state === 'paper' && this.now >= idea.resolveIdx) {
        idea.state = 'paper-done'; idea.updated = this.now;
        ev.push({ type: 'PAPER_DONE', idea });
        const reg = regimeAt(this.m.A[idea.asset], idea.born);
        this.memory.add({ i: this.now, setup: idea.setup, asset: idea.asset, vol: reg.vol, trend: reg.trend, verdict: 'PAPER', text: `paper result ${pct(idea.paperRet, 2)} (${idea.paperOutcome.toLowerCase()})` });
      }
      if (idea.state === 'spark' && this.now - idea.born > SPARK_TTL) { idea.state = 'faded'; idea.updated = this.now; }
    }
    return ev;
  }

  // ------------------------------------------------------------------ research cycle
  snapshot(i = this.now) {
    return this.m.names.map((asset) => {
      const s = this.m.A[asset], r = regimeAt(s, i);
      return { asset, price: fmtPx(s.close[i]), ret24: s.f.ret24[i], funding: s.funding[i], fundZ: s.f.fundZ[i] || 0, vol: r.vol, trend: r.trend };
    });
  }

  candidates(i = this.now) {
    return triggersAt(this.m, i)
      .filter((c) => !this.book.hasAsset(c.asset) && !this.ideas.some((x) => x.asset === c.asset && x.state === 'paper'))
      .map((c) => {
        const s = this.m.A[c.asset], st = SETUP[c.setup], reg = regimeAt(s, i);
        return { ...c, name: st.name, observe: st.observe(s, i, this.m), vol: reg.vol, trend: reg.trend, blocked: this.memory.blocking(c.setup, reg.vol, i) };
      });
  }

  ready() { return !this.done && this.now - this.lastCycle >= CYCLE_GAP && !this.book.full() && this.candidates().length > 0; }

  beginCycle() {
    if (!this.ready()) return null;
    const cands = this.candidates().slice(0, 6);
    this.lastCycle = this.now;
    const open = this.book.positions.map((p) => `${p.dir > 0 ? 'long' : 'short'} ${p.asset}`).join(', ');
    const ctx = { i: this.now, clock: this.clock(), candidates: cands, snapshot: this.snapshot(), memory: this.memory.toPrompt(this.now), positions: open };
    // the three strongest candidates appear on the board as sparks
    ctx.sparks = cands.slice(0, 3).map((c) => this.addIdea(c, 'spark'));
    this.stats.sparks += ctx.sparks.length;
    return ctx;
  }

  addIdea(c, state) {
    const idea = { id: this.nextId++, asset: c.asset, setup: c.setup, name: c.name, dir: c.dir, strength: c.strength, state, born: this.now, updated: this.now };
    this.ideas.push(idea);
    return idea;
  }

  // run the replay for the chosen hypothesis
  test(ctx, pick, tried = 1) {
    const cand = ctx.candidates[pick.index];
    let idea = ctx.sparks.find((x) => x.asset === cand.asset && x.setup === cand.setup) || this.addIdea(cand, 'research');
    Object.assign(idea, { state: 'backtest', updated: this.now, geom: pick.geom, regime: pick.regime });
    const h = history(this.m, this.events, { setup: cand.setup, asset: cand.asset, geom: pick.geom, regime: pick.regime }, ctx.i, tried);
    const g = gate(h);
    const s = this.m.A[cand.asset], geom = GEOMS[pick.geom], { tp, sl } = exits(s, ctx.i, geom);
    const px = s.close[ctx.i];
    const out = { cand, idea, h, g, geom, tp, sl, price: px, target: px * (1 + cand.dir * tp), stop: px * (1 - cand.dir * sl) };
    Object.assign(idea, { target: out.target, stop: out.stop, entryRef: px });
    return out;
  }

  decide(ctx, t, v) {
    let final = v.verdict, overruled = null;
    if (final === 'SHIP' && !t.g.ship) { final = t.g.paper ? 'PAPER' : 'KILL'; overruled = 'gate'; }
    if (final === 'SHIP' && v.conviction < SHIP_LINE) { final = 'PAPER'; overruled = 'conviction'; }
    if (final === 'SHIP' && (this.book.full() || this.book.hasAsset(t.cand.asset))) { final = 'PAPER'; overruled = 'capacity'; }
    const idea = t.idea, reg = regimeAt(this.m.A[t.cand.asset], ctx.i);
    Object.assign(idea, { verdict: final, conviction: v.conviction, reason: v.reason, updated: this.now, target: t.target, stop: t.stop, entryRef: t.price, h: t.h });
    this.stats.researched++;
    if (overruled) this.stats.overruled++;
    if (final === 'SHIP') {
      idea.state = 'live'; this.stats.shipped++;
      idea.position = this.book.open(idea, ctx.i, t.tp, t.sl, t.geom.horizon, v.conviction);
    } else if (final === 'PAPER') {
      idea.state = 'paper'; this.stats.papered++;
      const s = this.m.A[t.cand.asset], r = simulate(s, ctx.i, t.cand.dir, t.tp, t.sl, t.geom.horizon);
      idea.resolveIdx = r ? r.exitIdx : ctx.i + t.geom.horizon;
      idea.paperRet = r ? r.ret : 0; idea.paperOutcome = r ? r.outcome : 'TIME';
    } else {
      idea.state = 'killed'; this.stats.killed++;
    }
    if (final !== 'SHIP') {
      this.memory.add({ i: ctx.i, setup: t.cand.setup, asset: t.cand.asset, vol: reg.vol, trend: reg.trend, verdict: final, text: v.lesson || v.reason });
    }
    // sparks that were not researched fade out
    for (const sp of ctx.sparks) if (sp !== idea && sp.state === 'spark') { sp.state = 'faded'; sp.updated = this.now; }
    return { final, overruled };
  }

  skip(ctx, reason) {
    this.stats.skipped++;
    for (const sp of ctx.sparks) if (sp.state === 'spark') { sp.state = 'faded'; sp.updated = this.now; }
    return reason;
  }
}
