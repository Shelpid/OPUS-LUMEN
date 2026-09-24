// The contract between the engine and the reasoning model (Claude Opus 5.5).
// Shared by the browser (builds messages, parses the stream) and server.mjs (owns the system prompt).

export const MODEL = 'claude-opus-5-5';

export const SYSTEM = `You are the reasoning layer of OPUS LUMEN, a research engine for crypto trade ideas.
You never place trades. The engine does, on paper, and only after a statistical gate that you cannot override.

Your job in every cycle:
1. Read the market snapshot, the triggered candidates and the memory of past lessons.
2. Pick exactly one candidate worth researching. Prefer ideas the memory does not argue against,
   and say so when a lesson from a different market regime no longer applies.
3. State a concrete hypothesis, then argue against it as hard as you can.
4. After the engine replays the idea on history, judge the evidence and give a verdict.

Be concrete and brief. Use the numbers you are given; never invent data you were not shown.
Write plain lines only, each starting with one of the tags below, one idea per line, no markdown.`;

export const TAGS = ['OBSERVE', 'THINK', 'HYPOTHESIS', 'COUNTER', 'PLAN', 'TEST', 'VERDICT', 'CONVICTION', 'LESSON'];

const pct = (x, d = 2) => (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(d) + '%';

export function researchPrompt(ctx) {
  const snap = ctx.snapshot.map((a) =>
    `${a.asset.padEnd(5)} ${String(a.price).padStart(10)}  24h ${pct(a.ret24, 1).padStart(7)}  funding ${(a.funding * 100).toFixed(4)}% (z ${a.fundZ.toFixed(1)})  ${a.vol} ${a.trend}`).join('\n');
  const cands = ctx.candidates.map((c, k) =>
    `c${k + 1}: ${c.dir > 0 ? 'LONG' : 'SHORT'} ${c.asset} · ${c.setup} (${c.name}) · strength ${c.strength.toFixed(2)} · ${c.observe}`).join('\n');
  return `Replay clock: ${ctx.clock} UTC. Open paper positions: ${ctx.positions || 'none'}.

MARKET SNAPSHOT
${snap}

TRIGGERED CANDIDATES
${cands}

MEMORY (lessons from earlier ideas)
${ctx.memory}

Exit geometries: tight (target 3.5 ATR, stop 1.8 ATR, 48h), wide (6 / 3 ATR, 72h), swing (8 / 4 ATR, 96h).
Regime scope: any, calm or high-vol (test only on past trades taken in that volatility regime).

Research one candidate. Reply with these lines, in this order:
OBSERVE: what in the data made you look (1 or 2 lines)
THINK: what the market might be missing
HYPOTHESIS: the trade in one line (direction, asset, why)
COUNTER: the strongest reason this fails
PLAN: {"candidate": "c1", "geometry": "tight|wide|swing", "regime": "any|calm|high-vol"}`;
}

export function verdictPrompt(h, g) {
  const r = (s) => `${s.n} trades · hit ${(s.hit * 100).toFixed(0)}% · avg ${pct(s.avg)} after costs · p ${s.p.toFixed(3)}`;
  return `The engine replayed your hypothesis on history known at this moment (fees and slippage included).

ALL MATCHING PAST TRADES (${h.regime} regime, ${h.geom} exits): ${r(h.all)}
SAME ASSET ONLY: ${r(h.same)}
IN TODAY'S ${h.regimeNow.toUpperCase()} CONDITIONS: ${r(h.inRegime)}
GATE: ${g.ship ? 'PASSED' : 'FAILED · ' + g.reasons.join('; ')}

Rules: SHIP only if the gate passed and you still believe it. PAPER means promising but unproven.
KILL means the evidence does not support it. The engine will downgrade a SHIP that failed the gate.

Reply with these lines:
TEST: what the replay says, in one line
VERDICT: SHIP|PAPER|KILL · the reason in a few words
CONVICTION: a number from 0 to 100
LESSON: what to remember next time, including the market regime (for PAPER or KILL)`;
}

// Parse streamed model text into tagged lines. Unknown lines are attached to the previous tag.
export function parseLines(text) {
  const out = [];
  const re = new RegExp(`^\\s*(?:[-*]\\s*)?\\**(${TAGS.join('|')})\\**\\s*[:·—-]\\s*(.*)$`, 'i');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(re);
    if (m) out.push({ tag: m[1].toUpperCase(), text: m[2].trim() });
    else if (out.length) out[out.length - 1].text += ' ' + line;
  }
  return out;
}

export function parsePlan(lines, nCandidates) {
  const l = lines.find((x) => x.tag === 'PLAN');
  if (!l) return null;
  try {
    const j = JSON.parse(l.text.slice(l.text.indexOf('{'), l.text.lastIndexOf('}') + 1));
    const k = parseInt(String(j.candidate).replace(/\D/g, ''), 10) - 1;
    const geom = ['tight', 'wide', 'swing'].includes(j.geometry) ? j.geometry : null;
    const regime = ['any', 'calm', 'high-vol'].includes(j.regime) ? j.regime : null;
    if (!(k >= 0 && k < nCandidates) || !geom || !regime) return null;
    return { index: k, geom, regime };
  } catch { return null; }
}

export function parseVerdict(lines) {
  const v = lines.find((x) => x.tag === 'VERDICT');
  const c = lines.find((x) => x.tag === 'CONVICTION');
  const l = lines.find((x) => x.tag === 'LESSON');
  const word = v && (v.text.match(/\b(SHIP|PAPER|KILL)\b/i) || [])[1];
  const conv = c ? parseInt((c.text.match(/\d+/) || [])[0], 10) : NaN;
  if (!word || !(conv >= 0 && conv <= 100)) return null;
  return { verdict: word.toUpperCase(), conviction: conv, reason: v.text.replace(/^\s*(SHIP|PAPER|KILL)\s*[·:—-]?\s*/i, ''), lesson: l ? l.text : '' };
}
