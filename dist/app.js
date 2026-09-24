// OPUS LUMEN controller: drives the replay clock and the research cycle, streams Claude Opus 5.5
// (through server.mjs) or runs the local reasoner, and renders every panel.

import { MARKET, META } from './data/market.js';
import { Lumen, SHIP_LINE, fmtPx, pct, clockOf } from './engine/lumen.js';
import { localResearch, localVerdict, evidence, convictionOf } from './engine/reasoner.js';
import { researchPrompt, verdictPrompt, parseLines, parsePlan, parseVerdict, MODEL } from './engine/protocol.js';
import { triggersAt, SETUP } from './engine/setups.js';
import * as D from './ui/draw.js';

const $ = (id) => document.getElementById(id);
const setText = (el, s) => { if (el.textContent !== s) el.textContent = s; };
const setHTML = (el, s) => { if (el.__h !== s) { el.innerHTML = s; el.__h = s; } };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const q = new URLSearchParams(location.search);

const HOUR_T = 0.45;   // seconds per replay hour at 1x
const CPS = 75;        // typing speed of the local reasoner, chars per second at 1x
const COLS = ['SPARK', 'RESEARCH', 'BACKTEST', 'PAPER', 'LIVE'];
const COL_OF = { spark: 0, research: 1, backtest: 2, killed: 2, paper: 3, live: 4, closed: 4 };
const COL_COLOR = ['#bbf7d0', '#86efac', '#4ade80', '#22d3ee', '#15803d'];

const cv = {};
['logo', 'gauge', 'heat', 'mini', 'eq'].forEach((id) => { cv[id] = D.sized($(id)); });

let L, cycle = null, feed = [], hourAcc = 0, glow = 0.25, t = 0;
let running = !q.has('paused'), speed = [1, 2, 4, 8].includes(+q.get('speed')) ? +q.get('speed') : 1;
let brain = 'local';
const opus = { available: false, fake: false, effort: 'medium', calls: 0, inTok: 0, outTok: 0 };
const trigCache = new Map();
let last = performance.now();

// ------------------------------------------------------------------ setup
function restart() {
  L = new Lumen(MARKET, META);
  cycle = null; feed = []; hourAcc = 0; trigCache.clear();
  const skip = Math.max(0, parseInt(q.get('skip'), 10) || 0);
  for (let k = 0; k < skip && !L.done; k++) fastCycle() || tickHour();
  const until = Date.parse((q.get('until') || '') + ':00Z') / 1000;   // e.g. ?until=2026-08-10T12
  while (until && L.m.time[L.now] + 3600 < until && !L.done) fastCycle() || tickHour();
  feed.push({ tag: 'sep', text: `${L.now === L.start ? 'REPLAY STARTS' : 'FAST-FORWARDED TO'} ${L.clock()} UTC · ${L.m.n - 1 - L.now} HOURS OF REAL DATA AHEAD` });
  buildTicker();
}

function triggers(i) {
  if (!trigCache.has(i)) trigCache.set(i, triggersAt(L.m, i));
  return trigCache.get(i);
}

function tickHour() {
  for (const e of L.tick()) {
    if (e.type === 'CLOSE') feed.push({ tag: 'CLOSE', text: `#${e.idea.id} ${e.idea.asset} closed at ${e.trade.outcome.toLowerCase()} · ${pct(e.trade.ret, 2)} · ${e.trade.pnl >= 0 ? '+' : '−'}$${Math.abs(e.trade.pnl).toFixed(2)}`, cls: e.trade.pnl >= 0 ? 'pos' : 'neg' });
    if (e.type === 'PAPER_DONE') feed.push({ tag: 'PAPER', text: `#${e.idea.id} ${e.idea.asset} paper result ${pct(e.idea.paperRet, 2)} (${e.idea.paperOutcome.toLowerCase()}) · saved to memory` });
  }
  if (L.now % 6 === 0) buildTicker();
  if (L.done) { running = false; syncPlay(); feed.push({ tag: 'sep', text: 'END OF DATA · RUN tools/fetch_data.py FOR FRESH CANDLES, THEN RESTART' }); }
}

// instant local cycle, used for ?skip= and for NEXT IDEA when paused
function fastCycle() {
  const ctx = L.beginCycle();
  if (!ctx) return false;
  const r = localResearch(L, ctx);
  if (r.skip) { L.skip(ctx, 'memory'); return true; }
  const tt = L.test(ctx, r.pick, r.tried);
  L.decide(ctx, tt, localVerdict(L, ctx, tt));
  return true;
}

// ------------------------------------------------------------------ research cycle
function startCycle() {
  const ctx = L.beginCycle();
  if (!ctx) return;
  // memory rule: if every triggered idea already died in today's regime, skip without a model call
  if (ctx.candidates.every((c) => c.blocked.length)) {
    L.skip(ctx, 'memory');
    const c = ctx.candidates[0], n = ctx.candidates.length;
    const line = { tag: 'MEMORY', text: `${L.clock().slice(5)} · skipped ${n} idea${n > 1 ? 's' : ''} (${c.asset} ${c.name}${n > 1 ? ' …' : ''}): died in ${c.vol} conditions ${L.now - c.blocked[0].i}h ago · retry when the regime changes` };
    if (feed.length && feed[feed.length - 1].tag === 'MEMORY') feed[feed.length - 1] = line; else feed.push(line);
    return;
  }
  cycle = { ctx, mode: brain, phase: 'research', queue: [], shown: [], partial: null, raw: '', checks: null, revealed: 0, conv: null, verdict: '', hold: 0, idea: null, thinking: false };
  cycle.header = `── ${L.clock()} UTC · ${ctx.candidates.length} TRIGGERED · ${brain === 'opus' ? (opus.fake ? 'OPUS (FAKE)' : 'CLAUDE OPUS 5.5') : 'LOCAL REASONER'} ──`;
  if (brain === 'opus') runOpus(cycle).catch((err) => opusFailed(cycle, err));
  else {
    const r = localResearch(L, ctx);
    cycle.r = r;
    if (!r.skip) markResearch(cycle, r.pick);
    cycle.queue.push(...r.lines.map((l) => ({ ...l })));
  }
}

function markResearch(c, pick) {
  const cand = c.ctx.candidates[pick.index];
  const sp = c.ctx.sparks.find((x) => x.asset === cand.asset && x.setup === cand.setup);
  if (sp) { sp.state = 'research'; c.idea = sp; }
  c.focus = { asset: cand.asset, dir: cand.dir, name: cand.name };
}

function runTest(c, pick, tried) {
  const tt = L.test(c.ctx, pick, tried);
  c.t = tt; c.idea = tt.idea;
  c.checks = evidence(L, c.ctx, tt);
  c.revealed = 0; c.revealT = 0;
  return tt;
}

function finishDecision(c, v) {
  const d = L.decide(c.ctx, c.t, v);
  c.verdict = d.final; c.conv = v.conviction;
  if (d.overruled === 'gate') c.shown.push({ tag: 'GATE', text: `engine downgraded ${v.verdict} → ${d.final}: ${c.t.g.reasons[0]}` });
  if (d.overruled === 'conviction') c.shown.push({ tag: 'GATE', text: `conviction ${v.conviction} is under the ship line (${SHIP_LINE}) → PAPER` });
  if (d.overruled === 'capacity') c.shown.push({ tag: 'GATE', text: 'book is full or already holds this asset → PAPER' });
  if (d.final === 'SHIP') glow = 1;
  c.phase = 'hold'; c.hold = 1.6;
}

function advanceLocal(c, sdt) {
  if (c.phase === 'testing') { c.hold -= sdt; if (c.hold <= 0) { c.phase = 'verdict'; c.queue.push(...c.v.lines); } return; }
  // typing
  let budget = CPS * sdt;
  while (budget > 0 && (c.partial || c.queue.length)) {
    if (!c.partial) c.partial = { ...c.queue.shift(), n: 0 };
    const need = c.partial.text.length - c.partial.n;
    const take = Math.min(need, budget);
    c.partial.n += take; budget -= take;
    if (c.partial.n >= c.partial.text.length) { c.shown.push({ tag: c.partial.tag, text: c.partial.text }); c.partial = null; }
  }
  if (c.partial || c.queue.length) return;
  if (c.phase === 'research') {
    if (c.r.skip) { L.skip(c.ctx, 'memory'); c.phase = 'hold'; c.hold = 1; c.verdict = 'WAIT'; return; }
    runTest(c, c.r.pick, c.r.tried);
    c.v = localVerdict(L, c.ctx, c.t);
    c.phase = 'testing'; c.hold = 0.9;
  } else if (c.phase === 'verdict') finishDecision(c, c.v);
}

// ------------------------------------------------------------------ Claude Opus 5.5 (via server.mjs)
async function streamReason(messages, c) {
  const res = await fetch('/api/reason', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages }) });
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', done = null;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let k;
    while ((k = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, k); buf = buf.slice(k + 2);
      const line = chunk.split('\n').find((x) => x.startsWith('data: '));
      if (!line) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.type === 'thinking') c.thinking = true;
      else if (ev.type === 'text') { c.thinking = false; c.raw += ev.text; }
      else if (ev.type === 'done') done = ev;
      else if (ev.type === 'error') throw new Error(ev.message);
    }
  }
  if (!done) throw new Error('the stream ended early');
  opus.calls++;
  if (done.usage) { opus.inTok += done.usage.input_tokens || 0; opus.outTok += done.usage.output_tokens || 0; }
  if (done.stop_reason === 'refusal') throw new Error('the model declined this request');
  return done;
}

async function runOpus(c) {
  const ctx = c.ctx;
  const messages = [{ role: 'user', content: researchPrompt(ctx) }];
  const first = await streamReason(messages, c);
  let lines = parseLines(c.raw);
  let plan = parsePlan(lines, ctx.candidates.length), tried = 1;
  c.shown.push(...lines); c.raw = '';
  if (!plan) {
    const r = localResearch(L, ctx);
    if (r.skip) { c.shown.push({ tag: 'ERROR', text: 'PLAN unreadable and memory blocks every candidate · waiting' }); L.skip(ctx, 'memory'); c.phase = 'hold'; c.hold = 1; return; }
    plan = r.pick; tried = r.tried;
    c.shown.push({ tag: 'ERROR', text: `PLAN unreadable · local reasoner picks c${plan.index + 1} instead` });
  }
  markResearch(c, plan);
  c.phase = 'testing';
  const tt = runTest(c, plan, tried);
  messages.push({ role: 'assistant', content: first.content }, { role: 'user', content: verdictPrompt(tt.h, tt.g) });
  c.phase = 'verdict';
  await streamReason(messages, c);
  lines = parseLines(c.raw);
  c.shown.push(...lines); c.raw = '';
  let v = parseVerdict(lines);
  if (!v) { v = localVerdict(L, ctx, tt); c.shown.push({ tag: 'ERROR', text: 'verdict unreadable · local reasoner decides this one' }); }
  finishDecision(c, v);
}

function opusFailed(c, err) {
  c.shown.push({ tag: 'ERROR', text: `${err.message} · switching this cycle to the local reasoner` });
  c.raw = ''; c.mode = 'local';
  if (!c.t) {
    const r = localResearch(L, c.ctx);
    c.r = r;
    if (!r.skip) markResearch(c, r.pick);
    c.queue.push(...r.lines); c.phase = 'research';
  } else {
    c.v = localVerdict(L, c.ctx, c.t);
    c.queue.push(...c.v.lines); c.phase = 'verdict';
  }
}

// ------------------------------------------------------------------ frame
function update(sdt, rdt) {
  t += rdt;
  glow = Math.max(0.25, glow - rdt * 0.35);
  if (cycle) {
    if (cycle.mode === 'local') advanceLocal(cycle, sdt);
    if (cycle.checks) { cycle.revealT += sdt; cycle.revealed = Math.min(cycle.checks.length, Math.floor(cycle.revealT / 0.3) + 1); }
    if (cycle.phase === 'hold') {
      cycle.hold -= sdt;
      if (cycle.hold <= 0) { commitCycle(); }
    }
    return;
  }
  if (L.done) return;
  hourAcc += sdt;
  while (hourAcc >= HOUR_T && !cycle && !L.done) {
    hourAcc -= HOUR_T;
    tickHour();
    if (L.ready()) startCycle();
  }
}

function commitCycle() {
  feed.push({ tag: 'sep', text: cycle.header });
  feed.push(...cycle.shown);
  if (feed.length > 60) feed = feed.slice(-60);
  lastCycle = cycle; cycle = null;
}
let lastCycle = null;

// ------------------------------------------------------------------ render
function renderStream() {
  const rows = feed.map((l) => ({ ...l, old: true }));
  if (cycle) {
    rows.push({ tag: 'sep', text: cycle.header });
    rows.push(...cycle.shown);
    if (cycle.mode === 'local' && cycle.partial) rows.push({ tag: cycle.partial.tag, text: cycle.partial.text.slice(0, Math.floor(cycle.partial.n)), caret: true });
    if (cycle.mode === 'opus') {
      const live = parseLines(cycle.raw);
      if (live.length) { rows.push(...live); rows[rows.length - 1] = { ...rows[rows.length - 1], caret: true }; }
      else rows.push({ tag: cycle.phase === 'verdict' ? 'TEST' : 'THINK', text: cycle.thinking || !cycle.raw ? 'Opus 5.5 is thinking…' : '', caret: true });
    }
  }
  const html = rows.slice(-18).map((l) => {
    if (l.tag === 'sep') return `<div class="ln sep${l.old ? ' old' : ''}">${esc(l.text)}</div>`;
    let cls = l.tag;
    if (l.tag === 'VERDICT') cls += ' ' + ((l.text.match(/^(SHIP|PAPER|KILL)/) || [])[1] || '');
    if (l.cls) cls += ' ' + l.cls;
    return `<div class="ln ${cls}${l.old ? ' old' : ''}"><span class="tg">${esc(l.tag)}</span><span class="tx">${esc(l.text)}${l.caret ? '<span class="caret"></span>' : ''}</span></div>`;
  }).join('');
  setHTML($('lines'), html);
  const c = cycle || lastCycle;
  setText($('ideaTag'), c && c.idea ? `IDEA #${c.idea.id} · ${c.idea.asset}` : c && c.focus ? c.focus.asset : 'SCANNING');
  setText($('brainInfo'), brain === 'opus' ? `${opus.fake ? 'FAKE REPLIES (LUMEN_FAKE=1)' : `${MODEL} · EFFORT ${opus.effort.toUpperCase()}`} · ${opus.calls} CALLS` : 'LOCAL REASONER · RULE-BASED, NO API KEY');
  setText($('memInfo'), `MEMORY · ${L.memory.lessons.length} LESSONS`);
}

function renderConviction() {
  const c = cycle || lastCycle;
  let value = null, label = 'WAITING FOR AN IDEA', checks = c && c.checks ? c.checks : null, revealed = c ? c.revealed : 0;
  if (c && checks) {
    const part = checks.slice(0, revealed);
    value = convictionOf(part);
    label = 'ENGINE EVIDENCE';
    if (c.verdict && c.conv !== null && c.verdict !== 'WAIT') { value = c.conv; label = c.mode === 'opus' ? 'MODEL CONVICTION' : 'FINAL CONVICTION'; }
  } else if (c) label = 'GATHERING EVIDENCE';
  D.drawGauge(cv.gauge, { value, verdict: c ? c.verdict : '', label });
  const rows = (checks || Array.from({ length: 5 }, () => null)).map((k, i) => {
    if (!k || i >= revealed) return `<div class="ck"><i></i><span>${k ? '···' : '—'}</span><em>···</em></div>`;
    return `<div class="ck ${k.side}"><i>${k.side === 'for' ? '✓' : '✕'}</i><span>${esc(k.name)}</span><em>${k.side === 'for' ? 'FOR' : 'AGAINST'}</em></div>`;
  });
  setHTML($('checks'), rows.join(''));
  const vEl = $('verdict'), v = c ? c.verdict : '';
  vEl.className = 'verdict ' + (v || '');
  setText(vEl, v === 'SHIP' ? '✓ SHIP IT · PAPER TRADE OPENED' : v === 'PAPER' ? '◐ PAPER · WATCH, NO CAPITAL' : v === 'KILL' ? '✕ KILL IT · LESSON SAVED' : v === 'WAIT' ? 'MEMORY SAYS WAIT' : 'VERDICT PENDING');
  setText($('convId'), c && c.idea ? `#${c.idea.id}` : '');
}

const cardState = new Map(); // id -> { state, at }
function renderBoard() {
  const now = performance.now();
  const board = $('cards'), W = board.getBoundingClientRect().width;
  const colW = (W - 4 * 12) / 5, rowH = 64;
  const vis = [[], [], [], [], []];
  for (const idea of L.ideas) {
    let s = cardState.get(idea.id);
    if (!s || s.state !== idea.state) { s = { state: idea.state, at: now }; cardState.set(idea.id, s); }
    const age = (now - s.at) / 1000;
    if (idea.state === 'faded' || idea.state === 'paper-done') continue;
    if ((idea.state === 'killed' || idea.state === 'closed') && age > 2.6 / Math.sqrt(speed)) continue;
    vis[COL_OF[idea.state]].push({ idea, at: s.at, age });
  }
  const counts = COLS.map((_, k) => vis[k].length);
  setHTML($('cols'), COLS.map((n, k) => `<div class="col${k === 4 ? ' live' : ''}"><span>${n}</span><b>${counts[k]}</b></div>`).join(''));
  const html = [];
  vis.forEach((list, col) => {
    list.sort((a, b) => b.at - a.at);
    list.forEach((e, slot) => {
      if (slot > 2) return;
      const { idea } = e, dead = idea.state === 'killed' || (idea.state === 'closed' && idea.pnl <= 0);
      const prog = dead ? 15 : [Math.round(idea.strength * 40), 45, 65, 80, 100][col];
      const extra = idea.state === 'closed' ? ` · ${pct(idea.ret, 1)}` : idea.state === 'live' && idea.position ? ` · ${pct(liveRet(idea), 1)}` : '';
      const op = (idea.state === 'killed' || idea.state === 'closed') ? Math.max(0, 1 - Math.max(0, e.age - 1.6) / 1) : 1;
      html.push(`<div class="cd${dead ? ' dead' : ''}${col === 4 ? ' live' : ''}" style="left:${(col * (colW + 12)).toFixed(1)}px;top:${slot * rowH}px;width:${colW.toFixed(1)}px;opacity:${op.toFixed(2)};--c:${dead ? '#c7d4cb' : COL_COLOR[col]}">` +
        `<div class="t1"><span>#${idea.id}</span><b>${idea.dir > 0 ? '▲' : '▼'} ${esc(idea.asset)}</b></div><div class="t2">${esc(idea.name)}${extra}</div><div class="bar"><i style="width:${prog}%"></i></div></div>`);
    });
    if (list.length > 3) html.push(`<div class="more" style="left:${(col * (colW + 12)).toFixed(1)}px;top:${3 * rowH}px">+${list.length - 3} MORE</div>`);
  });
  setHTML(board, html.join(''));
}

function liveRet(idea) {
  const p = idea.position; if (!p || p.entry === null || L.now < p.fillIdx) return 0;
  return p.dir * (L.m.A[p.asset].close[L.now] / p.entry - 1);
}

function renderHeat() {
  const N = 12, rows = L.m.names;
  const cells = rows.map(() => Array.from({ length: N }, () => ({ v: 0, dir: 0 })));
  for (let j = 0; j < N; j++) {
    const i = L.now - (N - 1 - j);
    for (const tr of triggers(i)) {
      const r = rows.indexOf(tr.asset), c = cells[r][j];
      if (tr.strength > c.v) { c.v = tr.strength; c.dir = tr.dir; }
    }
  }
  const right = rows.map((a) => { const x = L.m.A[a].f.ret24[L.now]; return { s: pct(x, 1), c: x >= 0 ? D.C.green : '#8aa093' }; });
  D.drawHeat(cv.heat, { rows, cells, right, t });
}

function focusIdea() {
  if (cycle && cycle.idea && cycle.phase !== 'hold') return cycle.idea;
  const live = L.ideas.filter((x) => x.state === 'live').sort((a, b) => b.updated - a.updated)[0];
  if (live) return live;
  return L.ideas.filter((x) => x.verdict).sort((a, b) => b.updated - a.updated)[0] || null;
}

function renderHour() {
  const idea = focusIdea();
  const st = $('hStatus');
  if (!idea) { setText($('hTitle'), '—'); setText($('hSub'), 'no idea has been researched yet'); st.className = 'status review'; setText(st, 'SCANNING'); D.drawMini(cv.mini, { prices: [] }); return; }
  const s = L.m.A[idea.asset], from = Math.max(0, L.now - 71);
  const prices = []; for (let i = from; i <= L.now; i++) prices.push({ i, c: s.close[i] });
  const entry = idea.position && idea.position.entry ? idea.position.entry : idea.entryRef;
  const at = idea.born - from;
  setText($('hTitle'), `${idea.dir > 0 ? 'LONG' : 'SHORT'} ${idea.asset}`);
  setText($('hSub'), `${idea.name} · #${idea.id}${idea.geom ? ` · ${idea.geom} exits` : ''}`);
  const map = { live: ['live', '● LIVE PAPER'], paper: ['paper', 'PAPER WATCH'], 'paper-done': ['paper', 'PAPER DONE'], killed: ['killed', 'KILLED'], closed: ['closed', 'CLOSED'] };
  const [cls, label] = map[idea.state] || ['review', 'IN REVIEW'];
  st.className = 'status ' + cls; setText(st, label);
  D.drawMini(cv.mini, { prices, entry, target: idea.target, stop: idea.stop, at, dir: idea.dir });
  setText($('hEntry'), entry ? fmtPx(entry) : '—');
  setText($('hTarget'), idea.target ? fmtPx(idea.target) : '—');
  setText($('hStop'), idea.stop ? fmtPx(idea.stop) : '—');
  setText($('hRR'), idea.target && entry ? (Math.abs(idea.target - entry) / Math.abs(entry - idea.stop)).toFixed(1) : '—');
  let pnl = null;
  if (idea.state === 'live') pnl = liveRet(idea);
  else if (idea.state === 'closed') pnl = idea.ret;
  else if (idea.state === 'paper-done') pnl = idea.paperRet;
  const el = $('hPnl'); setText(el, pnl === null ? '—' : pct(pnl, 2)); el.style.color = pnl === null ? D.C.ink : pnl >= 0 ? D.C.green : '#6b7f73';
}

function renderBook() {
  const b = L.book, s = b.summary(L.now);
  D.drawEquity(cv.eq, { curve: b.curve, initial: b.initial, t, marks: b.closed.map((x) => x.exitIdx - L.start - 1) });
  const r = $('eRet'); setText(r, pct(s.ret, 1)); r.style.color = s.ret >= 0 ? D.C.green : D.C.ink;
  setText($('eHodl'), pct(s.hodlRet, 1));
  setText($('eDD'), s.maxDD < 0.0005 ? '0.0%' : '−' + (s.maxDD * 100).toFixed(1) + '%');
  setText($('eTrades'), `${s.trades} · ${s.trades ? Math.round(s.hit * 100) + '% hit' : '—'}`);
  setText($('eOpen'), String(b.positions.length));
  setText($('eqSub'), `${L.clock(L.start).slice(0, 10)} → ${L.clock().slice(0, 10)} · $10 000 START`);
  const rows = [
    ...b.closed.map((x) => ({ at: x.exitIdx, id: x.idea.id, name: `${x.dir > 0 ? 'LONG' : 'SHORT'} ${x.asset} ${x.idea.name}`, meta: `${x.outcome.toLowerCase()} · ${((x.exitIdx - x.fillIdx + 1) / 24).toFixed(1)}d`, v: x.ret, tag: 'live' })),
    ...L.ideas.filter((x) => x.state === 'paper-done').map((x) => ({ at: x.resolveIdx, id: x.id, name: `${x.dir > 0 ? 'LONG' : 'SHORT'} ${x.asset} ${x.name}`, meta: `${x.paperOutcome.toLowerCase()} · no capital`, v: x.paperRet, tag: 'paper' })),
  ].sort((a, b2) => b2.at - a.at).slice(0, 7);
  const mx = Math.max(0.01, ...rows.map((x) => Math.abs(x.v)));
  setHTML($('lrows'), rows.length ? rows.map((x) => `<div class="lr"><div class="nm"><b>#${x.id} ${esc(x.name)}<span class="tag ${x.tag}">${x.tag === 'live' ? 'SHIPPED' : 'PAPER'}</span></b><span>${esc(x.meta)}</span><div class="bar"><i class="${x.v < 0 ? 'neg' : ''}" style="width:${(Math.abs(x.v) / mx * 100).toFixed(0)}%"></i></div></div><span class="v ${x.v < 0 ? 'neg' : 'pos'}">${pct(x.v, 2)}</span></div>`).join('')
    : '<div class="empty">Nothing has finished yet. Most ideas never get this far.</div>');
}

function renderMemory() {
  const rows = L.memory.recent(8);
  setHTML($('mrows'), rows.length ? rows.map((l) => `<div class="mr"><span class="v ${l.verdict}">${l.verdict}</span><span class="t"><em>${esc(l.vol)} ${esc(l.trend)}</em> · ${esc(l.asset)} ${esc(SETUP[l.setup].name)} · ${esc(l.text)} · ${L.now - l.i}h ago</span></div>`).join('')
    : '<div class="empty">Empty. Every killed idea will leave a lesson here.</div>');
}

function buildTicker() {
  const parts = L.m.names.map((a) => { const s = L.m.A[a]; const r = s.f.ret24[L.now]; return `<span><b>${a}</b> ${fmtPx(s.close[L.now])} <em>${pct(r, 1)}</em></span>`; });
  parts.push(`<span><b>●</b> ${L.stats.researched} researched · ${L.stats.killed} killed · ${L.stats.shipped} shipped</span>`);
  const el = $('tick'); el.innerHTML = parts.concat(parts).join(''); el.__w = el.scrollWidth / 2;
}

function renderHeader() {
  setText($('kIdeas'), String(L.stats.researched));
  setText($('kShip'), String(L.stats.shipped));
  setText($('kKill'), String(L.stats.killed));
  const s = L.book.summary(L.now);
  setText($('kHit'), s.trades ? Math.round(s.hit * 100) + '%' : '—');
  setText($('clock'), L.clock() + ' UTC');
  const phase = cycle ? (cycle.phase === 'research' ? 'REASONING' : cycle.phase === 'testing' ? 'BACKTESTING' : cycle.phase === 'verdict' ? 'JUDGING' : cycle.verdict === 'SHIP' ? 'SHIPPING' : cycle.verdict === 'KILL' ? 'KILLING' : 'DECIDED') : running ? 'SCANNING' : 'PAUSED';
  setText($('mode'), `${brain === 'opus' ? (opus.fake ? 'OPUS·FAKE' : 'OPUS 5.5') : 'LOCAL'} · ${phase}`);
  document.querySelector('.pill i').style.opacity = (0.4 + 0.6 * (0.5 + 0.5 * Math.cos(t * 6))).toFixed(2);
  const left = L.m.n - 1 - L.now;
  const cost = (opus.inTok * 4 + opus.outTok * 20) / 1e6;
  setText($('meta'), `BINANCE 1H · 8 ASSETS · ${left}H OF REPLAY LEFT${opus.calls ? ` · OPUS ${opus.calls} CALLS ≈ $${cost.toFixed(2)}` : ''}`);
  D.drawLogo(cv.logo, glow);
  const tk = $('tick'); if (tk.__w) tk.style.transform = `translateX(${(-((t * 40) % tk.__w) + 14).toFixed(1)}px)`;
}

function render() {
  renderHeader(); renderStream(); renderConviction(); renderBoard(); renderHeat(); renderHour(); renderBook(); renderMemory();
}

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (running) update(dt * speed, dt); else t += dt;
  render();
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ controls
function syncPlay() { const b = $('bPlay'); b.textContent = running ? '❚❚ PAUSE' : '▶ RUN'; }
function setSpeed(v) { speed = v; document.querySelectorAll('[data-speed]').forEach((b) => b.classList.toggle('on', +b.dataset.speed === v)); }
function setBrain(v) {
  if (v === 'opus' && !opus.available) return;
  brain = v; document.querySelectorAll('[data-brain]').forEach((b) => b.classList.toggle('on', b.dataset.brain === v));
}
function nextIdea() {
  if (cycle) {
    if (cycle.mode === 'local') { while (cycle && cycle.mode === 'local' && cycle.phase !== 'hold') advanceLocal(cycle, 1e6); if (cycle && cycle.phase === 'hold') commitCycle(); }
    return;
  }
  let guard = 0;
  while (!L.ready() && !L.done && guard++ < 2000) tickHour();
  if (L.ready()) startCycle();
  running = true; syncPlay();
}

$('bPlay').onclick = () => { running = !running; syncPlay(); };
$('bStep').onclick = nextIdea;
$('bRestart').onclick = () => { if (!cycle || cycle.mode === 'local') restart(); };
document.querySelectorAll('[data-speed]').forEach((b) => { b.onclick = () => setSpeed(+b.dataset.speed); });
document.querySelectorAll('[data-brain]').forEach((b) => { b.onclick = () => setBrain(b.dataset.brain); });
addEventListener('keydown', (e) => {
  if (e.key === ' ') { e.preventDefault(); running = !running; syncPlay(); }
  else if (e.key === 'ArrowRight') nextIdea();
  else if ('1234'.includes(e.key)) setSpeed([1, 2, 4, 8][+e.key - 1]);
});

async function probeServer() {
  try {
    if (location.hostname.endsWith('github.io') || location.protocol === 'file:') throw new Error('static hosting');
    const r = await fetch('/api/status', { cache: 'no-store' });
    if (!r.ok) throw new Error();
    const s = await r.json();
    Object.assign(opus, { available: !!s.opus, fake: !!s.fake, effort: s.effort || 'medium' });
  } catch { opus.available = false; }
  const b = $('bOpus');
  b.disabled = !opus.available;
  b.title = opus.available ? (opus.fake ? 'Scripted replies (LUMEN_FAKE=1)' : 'Claude Opus 5.5 via server.mjs') : 'Start server.mjs with ANTHROPIC_API_KEY to enable';
  if (opus.fake) b.textContent = 'OPUS (FAKE)';
  if (q.get('brain') === 'opus') setBrain('opus');
}

setSpeed(speed); setBrain('local'); syncPlay();
restart();
probeServer();
requestAnimationFrame(frame);
window.LUMEN = { get engine() { return L; }, get cycle() { return cycle; }, nextIdea, restart, setBrain, setSpeed, pause: () => { running = false; syncPlay(); } };
