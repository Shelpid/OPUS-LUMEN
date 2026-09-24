// Headless replay with the local reasoner. Prints what the engine researched, shipped and killed,
// and how the paper book did against buy-and-hold over the out-of-sample window.
// Usage: node tools/replay.mjs [--verbose]
import { MARKET, META } from '../dist/data/market.js';
import { Lumen, pct } from '../dist/engine/lumen.js';
import { localResearch, localVerdict } from '../dist/engine/reasoner.js';

const verbose = process.argv.includes('--verbose');
const t0 = Date.now();
const L = new Lumen(MARKET, META);
const verdicts = [];
while (!L.done) {
  const ctx = L.beginCycle();
  if (ctx) {
    const r = localResearch(L, ctx);
    if (r.skip) L.skip(ctx, 'memory');
    else {
      const t = L.test(ctx, r.pick, r.tried);
      const v = localVerdict(L, ctx, t);
      const d = L.decide(ctx, t, v);
      verdicts.push({ at: L.clock(), idea: t.idea, final: d.final });
      if (verbose) console.log(`${L.clock()}  ${d.final.padEnd(5)} ${t.cand.dir > 0 ? 'LONG ' : 'SHORT'} ${t.cand.asset.padEnd(5)} ${t.cand.setup.padEnd(22)} ${t.h.geom}/${t.h.regime} n${t.h.all.n} avg ${pct(t.h.all.avg, 2)} p ${t.h.pAdj.toFixed(2)} conv ${v.conviction}`);
    }
  }
  for (const e of L.tick()) if (verbose && e.type === 'CLOSE') console.log(`${L.clock()}  CLOSE ${e.idea.asset} ${e.trade.outcome} ${pct(e.trade.ret, 2)} pnl ${e.trade.pnl.toFixed(2)}`);
}
const s = L.book.summary(L.now);
console.log(JSON.stringify({
  window: `${L.clock(L.start)} → ${L.clock()}`, hours: L.now - L.start,
  ...L.stats, lessons: L.memory.lessons.length,
  trades: s.trades, hit: +(s.hit * 100).toFixed(1), ret: +(s.ret * 100).toFixed(2), maxDD: +(s.maxDD * 100).toFixed(2), hodl: +(s.hodlRet * 100).toFixed(2),
  paperResolved: L.ideas.filter((x) => x.state === 'paper-done').length,
  ms: Date.now() - t0,
}, null, 1));
