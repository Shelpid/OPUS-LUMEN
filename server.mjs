// OPUS LUMEN local server: serves dist/ and streams Claude Opus 5.5 reasoning to the page.
// The API key stays here (ANTHROPIC_API_KEY); the browser never sees it.
//
//   ANTHROPIC_API_KEY=sk-ant-... node server.mjs      -> http://localhost:8787
//   node server.mjs --fake                            -> scripted replies, no key, for testing the wiring
//
// Optional: --port=8787 (or PORT), LUMEN_EFFORT (low|medium|high, default medium), LUMEN_MAX_CALLS (200).

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { MODEL, SYSTEM } from './dist/engine/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, 'dist');
const arg = (k) => (process.argv.find((x) => x.startsWith(`--${k}=`)) || '').split('=')[1];
const PORT = Number(arg('port') || process.env.PORT) || 8787;
const FAKE = process.env.LUMEN_FAKE === '1' || process.argv.includes('--fake');
const EFFORT = process.env.LUMEN_EFFORT || 'medium';
const MAX_CALLS = Number(process.env.LUMEN_MAX_CALLS) || 200;
const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY);
const client = HAS_KEY && !FAKE ? new Anthropic() : null;
let calls = 0;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
}

function readBody(req, limit = 400_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Only a short, alternating user/assistant history is accepted; the system prompt is ours.
export function validMessages(m) {
  if (!Array.isArray(m) || m.length < 1 || m.length > 4) return false;
  return m.every((x, i) => {
    if (x.role !== (i % 2 === 0 ? 'user' : 'assistant')) return false;
    if (x.role === 'user') return typeof x.content === 'string' && x.content.length <= 20_000;
    return Array.isArray(x.content);
  }) && m[m.length - 1].role === 'user';
}

// ---------------------------------------------------------------- scripted replies for LUMEN_FAKE=1
export function fakeReply(messages) {
  const last = messages[messages.length - 1].content;
  if (last.includes('TRIGGERED CANDIDATES')) {
    const c = last.match(/^c1: (LONG|SHORT) (\S+) · (\S+) \(([^)]+)\)/m) || [];
    return [
      `OBSERVE: [fake] ${c[2]} triggered ${c[4]}; strongest candidate on the board`,
      `THINK: [fake] scripted reply, no model was called`,
      `HYPOTHESIS: [fake] ${String(c[1] || '').toLowerCase()} ${c[2]} on the ${c[4]} trigger`,
      `COUNTER: [fake] a scripted counterargument`,
      `PLAN: {"candidate": "c1", "geometry": "wide", "regime": "any"}`,
    ].join('\n');
  }
  const passed = /GATE: PASSED/.test(last);
  return [
    `TEST: [fake] scripted reading of the replay`,
    `VERDICT: ${passed ? 'SHIP · [fake] gate passed' : 'KILL · [fake] gate failed'}`,
    `CONVICTION: ${passed ? 72 : 30}`,
    `LESSON: [fake] scripted lesson`,
  ].join('\n');
}

async function reason(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400).end('bad json'); return; }
  if (!validMessages(body.messages)) { res.writeHead(400).end('bad messages'); return; }
  if (!FAKE && !client) { res.writeHead(503).end('ANTHROPIC_API_KEY is not set on the server'); return; }
  if (calls >= MAX_CALLS) { res.writeHead(429).end(`call budget of ${MAX_CALLS} reached; restart the server or raise LUMEN_MAX_CALLS`); return; }
  calls++;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);

  if (FAKE) {
    const text = fakeReply(body.messages);
    for (let k = 0; k < text.length; k += 6) { send({ type: 'text', text: text.slice(k, k + 6) }); await new Promise((r) => setTimeout(r, 12)); }
    send({ type: 'done', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 }, fake: true });
    res.end();
    return;
  }

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: EFFORT }, // Opus 5.5 thinks adaptively; effort sets how much
    system: SYSTEM,
    messages: body.messages,
  });
  res.on('close', () => stream.abort());
  try {
    for await (const ev of stream) {
      if (ev.type === 'content_block_start' && ev.content_block.type === 'thinking') send({ type: 'thinking' });
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') send({ type: 'text', text: ev.delta.text });
    }
    const msg = await stream.finalMessage();
    // content goes back to the page so the next turn can append it unchanged (thinking blocks included)
    send({ type: 'done', content: msg.content, stop_reason: msg.stop_reason, stop_details: msg.stop_details ?? null, usage: msg.usage });
  } catch (err) {
    let message = String(err && err.message || err);
    if (err instanceof Anthropic.AuthenticationError) message = 'the API key was rejected';
    else if (err instanceof Anthropic.RateLimitError) message = 'rate limited, try again in a moment';
    else if (err instanceof Anthropic.BadRequestError) message = `bad request: ${err.message}`;
    else if (err instanceof Anthropic.APIError) message = `API error ${err.status}: ${err.message}`;
    send({ type: 'error', message });
  }
  res.end();
}

export const server = http.createServer(async (req, res) => {
  if (req.url === '/api/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ opus: Boolean(client) || FAKE, fake: FAKE, model: MODEL, effort: EFFORT, calls, maxCalls: MAX_CALLS }));
    return;
  }
  if (req.url === '/api/reason' && req.method === 'POST') { await reason(req, res); return; }
  if (req.method === 'GET') { await serveStatic(req, res); return; }
  res.writeHead(405).end();
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, '127.0.0.1', () => {
    const mode = FAKE ? 'FAKE (scripted replies)' : client ? `${MODEL} · effort ${EFFORT}` : 'local reasoner only (no ANTHROPIC_API_KEY)';
    console.log(`OPUS LUMEN on http://localhost:${PORT} · ${mode}`);
  });
}
