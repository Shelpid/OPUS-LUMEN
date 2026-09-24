// Exercises server.mjs end to end in --fake mode: no API key, no network, real HTTP + SSE.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.LUMEN_FAKE = '1';
const { server, validMessages, fakeReply } = await import('../server.mjs');
let base;

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function sse(messages) {
  const res = await fetch(`${base}/api/reason`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages }) });
  assert.equal(res.status, 200);
  const events = (await res.text()).split('\n\n').filter(Boolean).map((c) => JSON.parse(c.replace(/^data: /, '')));
  return events;
}

test('status reports fake mode and the model id', async () => {
  const s = await (await fetch(`${base}/api/status`)).json();
  assert.equal(s.opus, true); assert.equal(s.fake, true); assert.equal(s.model, 'claude-opus-5-5');
});

test('serves the app', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /OPUS <span>LUMEN<\/span>/);
  assert.equal((await fetch(`${base}/../server.mjs`)).status, 404);
});

test('streams text chunks and a final message', async () => {
  const ev = await sse([{ role: 'user', content: 'TRIGGERED CANDIDATES\nc1: LONG SOL · FUNDING_SQUEEZE (funding squeeze) · strength 0.70 · x' }]);
  const text = ev.filter((e) => e.type === 'text').map((e) => e.text).join('');
  const done = ev.find((e) => e.type === 'done');
  assert.ok(done, 'done event');
  assert.equal(text, done.content[0].text);
  assert.match(text, /PLAN: \{"candidate": "c1"/);
});

test('rejects malformed histories', async () => {
  assert.equal(validMessages([{ role: 'assistant', content: [] }]), false);
  assert.equal(validMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: [] }]), false);
  assert.equal(validMessages([{ role: 'user', content: 'x'.repeat(20001) }]), false);
  assert.equal(validMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: [] }, { role: 'user', content: 'b' }]), true);
  const r = await fetch(`${base}/api/reason`, { method: 'POST', body: '{"messages": "nope"}' });
  assert.equal(r.status, 400);
});

test('fake verdict follows the gate line', () => {
  assert.match(fakeReply([{ role: 'user', content: 'GATE: PASSED' }]), /VERDICT: SHIP/);
  assert.match(fakeReply([{ role: 'user', content: 'GATE: FAILED · x' }]), /VERDICT: KILL/);
});
