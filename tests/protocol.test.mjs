import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKET, META } from '../dist/data/market.js';
import { Lumen } from '../dist/engine/lumen.js';
import { parseLines, parsePlan, parseVerdict, researchPrompt, verdictPrompt, MODEL } from '../dist/engine/protocol.js';

test('model id is Claude Opus 5.5', () => assert.equal(MODEL, 'claude-opus-5-5'));

test('parser tolerates markdown, bullets, dashes and wrapped lines', () => {
  const text = `Here is my analysis.
**OBSERVE:** SOL funding flipped negative
- THINK - shorts are crowded
HYPOTHESIS · long SOL
  on the reclaim of the mean
COUNTER: BTC is weak
PLAN: {"candidate": "c2", "geometry": "wide", "regime": "calm"}`;
  const lines = parseLines(text);
  assert.deepEqual(lines.map((l) => l.tag), ['OBSERVE', 'THINK', 'HYPOTHESIS', 'COUNTER', 'PLAN']);
  assert.equal(lines[2].text, 'long SOL on the reclaim of the mean');
  assert.deepEqual(parsePlan(lines, 3), { index: 1, geom: 'wide', regime: 'calm' });
});

test('invalid plans are rejected instead of guessed', () => {
  const p = (s, n = 3) => parsePlan(parseLines(`PLAN: ${s}`), n);
  assert.equal(p('{"candidate": "c9", "geometry": "wide", "regime": "any"}'), null);
  assert.equal(p('{"candidate": "c1", "geometry": "huge", "regime": "any"}'), null);
  assert.equal(p('not json'), null);
  assert.equal(parsePlan([], 3), null);
});

test('verdict parsing', () => {
  const v = parseVerdict(parseLines('TEST: weak\nVERDICT: KILL · no edge after fees\nCONVICTION: 22\nLESSON: calm downtrend kills fades'));
  assert.deepEqual(v, { verdict: 'KILL', conviction: 22, reason: 'no edge after fees', lesson: 'calm downtrend kills fades' });
  assert.equal(parseVerdict(parseLines('VERDICT: MAYBE\nCONVICTION: 50')), null);
  assert.equal(parseVerdict(parseLines('VERDICT: SHIP')), null);
});

test('prompts carry real numbers from the engine', () => {
  const L = new Lumen(MARKET, META);
  let ctx = null;
  while (!ctx && !L.done) { ctx = L.beginCycle(); if (!ctx) L.tick(); }
  const p1 = researchPrompt(ctx);
  assert.match(p1, /TRIGGERED CANDIDATES/);
  assert.match(p1, /c1: (LONG|SHORT) /);
  for (const a of META.assets) assert.ok(p1.includes(a));
  const t = L.test(ctx, { index: 0, geom: 'wide', regime: 'any' });
  const p2 = verdictPrompt(t.h, t.g);
  assert.ok(p2.includes(`${t.h.all.n} trades`));
  assert.match(p2, /GATE: (PASSED|FAILED)/);
});
