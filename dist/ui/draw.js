// Canvas painters. Pure drawing from plain data; nothing here touches engine state.

export const C = { ink: '#062414', mute: '#5f7a6a', line: '#d4e6da', green: '#16a34a', deep: '#065f46', mint: '#4ade80', pale: '#dcfce7', grey: '#9db3a5', white: '#ffffff', amber: '#a16207' };
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
const path = (g, pts) => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); };

export function sized(el) {
  const o = { el, g: el.getContext('2d'), w: 1, h: 1 };
  const fit = () => {
    const r = el.getBoundingClientRect(), d = window.devicePixelRatio || 1;
    o.w = Math.max(1, r.width); o.h = Math.max(1, r.height);
    el.width = Math.round(o.w * d); el.height = Math.round(o.h * d);
    o.g.setTransform(d, 0, 0, d, 0, 0);
  };
  fit(); new ResizeObserver(fit).observe(el);
  return o;
}

// ---------------------------------------------------------------- pixel light bulb
const HW = [3, 5, 6, 7, 7, 8, 8, 8, 8, 8, 7, 7, 6, 5, 4, 3, 3];
function bulbGrid() {
  const grid = Array.from({ length: 25 }, () => Array(18).fill('.'));
  const inside = (x, y) => y >= 0 && y < HW.length && x >= 9 - HW[y] && x <= 8 + HW[y];
  for (let y = 0; y < HW.length; y++) for (let x = 0; x < 18; x++) {
    if (!inside(x, y)) continue;
    const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
    grid[y][x] = edge ? 'K' : x >= 8 + HW[y] - 2 && y > 5 ? 'D' : 'G';
  }
  [[12, 2], [13, 2], [13, 3], [14, 3], [14, 4]].forEach(([x, y]) => (grid[y][x] = 'W'));
  [[3, 5], [3, 6], [3, 7], [4, 4]].forEach(([x, y]) => (grid[y][x] = 'L'));
  [[6, 6], [6, 7], [7, 8], [11, 6], [11, 7], [10, 8], [8, 9], [9, 9], [8, 10], [9, 10], [8, 11], [9, 11], [8, 12], [9, 12], [8, 13], [9, 13], [8, 14], [9, 14], [8, 15], [9, 15]].forEach(([x, y]) => (grid[y][x] = 'F'));
  [[5, 12, 'K'], [5, 12, 'S'], [5, 12, 'T'], [5, 12, 'S'], [5, 12, 'T'], [6, 11, 'S'], [7, 10, 'K']].forEach(([a, b, c], k) => {
    for (let x = a; x <= b; x++) grid[17 + k][x] = x === a || x === b ? 'K' : c;
  });
  grid[24][8] = 'K'; grid[24][9] = 'K';
  return grid;
}
const GRID = bulbGrid();
export function drawBulb(g, x0, y0, s, glow) {
  const lit = glow > 0.5;
  const PAL = { K: '#062414', G: lit ? '#86efac' : '#4ade80', D: lit ? '#4ade80' : '#16a34a', L: '#dcfce7', W: '#ffffff', F: lit ? '#f0fdf4' : '#065f46', S: '#c9dccf', T: '#98b3a2' };
  GRID.forEach((row, j) => row.forEach((c, i) => { if (c !== '.') { g.fillStyle = PAL[c]; g.fillRect(x0 + i * s, y0 + j * s, s, s); } }));
}
export function drawLogo(cv, glow) {
  const { g, w, h } = cv; g.clearRect(0, 0, w, h);
  const gr = g.createRadialGradient(w / 2, h * 0.36, 2, w / 2, h * 0.36, w * 0.55);
  gr.addColorStop(0, hexA('#4ade80', 0.25 + 0.45 * glow)); gr.addColorStop(1, 'rgba(74,222,128,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  const d = window.devicePixelRatio || 1, s = Math.max(1, Math.floor((h / 26) * d)) / d;
  const x0 = (w - 18 * s) / 2, y0 = (h - 25 * s) / 2;
  if (glow > 0.6) {
    g.fillStyle = hexA('#16a34a', (glow - 0.6) / 0.4);
    [[-2, 6], [19, 6], [-1, 1], [18, 1], [8.5, -2]].forEach(([px, py]) => g.fillRect(x0 + px * s, y0 + py * s, s * 1.2, s * 1.2));
  }
  drawBulb(g, x0, y0, s, glow);
}

// ---------------------------------------------------------------- conviction gauge
export function drawGauge(cv, { value, verdict, label }) {
  const { g, w, h } = cv; g.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h * 0.66, r = Math.min(w * 0.36, h * 0.58);
  const a0 = Math.PI * 0.8, a1 = Math.PI * 2.2, A = (p) => a0 + (a1 - a0) * p;
  const dead = verdict === 'KILL';
  g.lineCap = 'round'; g.lineWidth = 14; g.strokeStyle = '#edf5ef'; g.beginPath(); g.arc(cx, cy, r, a0, a1); g.stroke();
  for (let i = 0; i <= 20; i++) {
    const a = A(i / 20), r1 = r + 12, r2 = r + (i % 5 ? 16 : 20);
    g.strokeStyle = i % 5 ? '#cfe2d5' : '#9db3a5'; g.lineWidth = 1.2;
    path(g, [[cx + Math.cos(a) * r1, cy + Math.sin(a) * r1], [cx + Math.cos(a) * r2, cy + Math.sin(a) * r2]]); g.stroke();
  }
  if (value !== null) {
    const grd = g.createLinearGradient(cx - r, 0, cx + r, 0); grd.addColorStop(0, '#bbf7d0'); grd.addColorStop(0.6, C.mint); grd.addColorStop(1, C.green);
    g.lineWidth = 14; g.strokeStyle = dead ? '#c7d4cb' : grd; g.beginPath(); g.arc(cx, cy, r, a0, A(value / 100)); g.stroke();
    const ah = A(value / 100), hx = cx + Math.cos(ah) * r, hy = cy + Math.sin(ah) * r;
    g.fillStyle = C.white; g.beginPath(); g.arc(hx, hy, 6, 0, Math.PI * 2); g.fill();
    g.strokeStyle = dead ? C.grey : C.green; g.lineWidth = 3; g.stroke();
  }
  const as = A(0.65);
  g.strokeStyle = C.deep; g.lineWidth = 2; g.lineCap = 'butt';
  path(g, [[cx + Math.cos(as) * (r - 11), cy + Math.sin(as) * (r - 11)], [cx + Math.cos(as) * (r + 11), cy + Math.sin(as) * (r + 11)]]); g.stroke();
  g.font = '700 8px Plex'; g.fillStyle = C.deep; g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillText('SHIP LINE 65', cx + Math.cos(as) * (r + 24) - 4, cy + Math.sin(as) * (r + 24) - 2);
  g.textAlign = 'center'; g.fillStyle = dead ? '#6b7f73' : C.ink; g.font = '700 38px Unbounded';
  g.fillText(value === null ? '—' : Math.round(value) + '%', cx, cy - 4);
  g.font = '500 8.5px Plex'; g.fillStyle = C.mute; g.fillText(label, cx, cy + 24);
}

// ---------------------------------------------------------------- signal matrix
const heatColor = (v) => {
  const stops = [[0, [244, 250, 246]], [0.3, [220, 252, 231]], [0.55, [134, 239, 172]], [0.8, [34, 197, 94]], [1, [6, 95, 70]]];
  for (let i = 0; i < stops.length - 1; i++) if (v <= stops[i + 1][0]) {
    const k = (v - stops[i][0]) / (stops[i + 1][0] - stops[i][0]), a = stops[i][1], b = stops[i + 1][1];
    return `rgb(${Math.round(a[0] + (b[0] - a[0]) * k)},${Math.round(a[1] + (b[1] - a[1]) * k)},${Math.round(a[2] + (b[2] - a[2]) * k)})`;
  }
  return 'rgb(6,95,70)';
};
// cells[r][j] = { v: 0..1, dir: 1|-1|0 }, rows = asset names, right = text per row
export function drawHeat(cv, { rows, cells, right, t }) {
  const { g, w, h } = cv; g.clearRect(0, 0, w, h);
  const padL = 46, padR = 58, padT = 14, padB = 16, N = cells[0] ? cells[0].length : 12, R = rows.length;
  const cw = (w - padL - padR) / N, ch = (h - padT - padB) / R;
  g.font = '700 9.5px Plex'; g.textBaseline = 'middle';
  for (let r = 0; r < R; r++) {
    const y = padT + r * ch;
    for (let j = 0; j < N; j++) {
      const c = cells[r][j], x = padL + j * cw;
      g.fillStyle = heatColor(c.v * 0.9 + (c.v > 0 ? 0.1 : 0));
      g.beginPath(); g.roundRect(x + 1.5, y + 1.5, cw - 3, ch - 3, 4); g.fill();
      if (c.v > 0 && cw > 16) {
        g.fillStyle = c.v > 0.55 ? '#ffffff' : C.deep; g.font = '700 8px Plex'; g.textAlign = 'center';
        g.fillText(c.dir > 0 ? '▲' : '▼', x + cw / 2, y + ch / 2 + 0.5);
      }
      if (c.v > 0.75 && j === N - 1) {
        const pul = 0.5 + 0.5 * Math.sin(t * 4 + r);
        g.strokeStyle = hexA('#16a34a', 0.4 + 0.5 * pul); g.lineWidth = 1.5;
        g.beginPath(); g.roundRect(x + 0.5, y + 0.5, cw - 1, ch - 1, 5); g.stroke();
      }
    }
    g.font = '700 9.5px Plex'; g.textAlign = 'left'; g.fillStyle = C.ink; g.fillText(rows[r], 0, y + ch / 2);
    g.textAlign = 'right'; g.fillStyle = right[r].c; g.fillText(right[r].s, w - 2, y + ch / 2);
  }
  g.font = '500 8px Plex'; g.fillStyle = C.grey; g.textAlign = 'center';
  ['−11H', '−8H', '−5H', '−2H', 'NOW'].forEach((s, i) => g.fillText(s, padL + cw * (i === 4 ? N - 0.5 : i * 3 + 0.5), h - 5));
  g.textAlign = 'right'; g.fillText('24H', w - 2, 5);
}

// ---------------------------------------------------------------- idea chart
// prices: [{i, c}], marks: {entry, target, stop, at (index into prices) }
export function drawMini(cv, { prices, entry, target, stop, at, dir }) {
  const { g, w, h } = cv; g.clearRect(0, 0, w, h);
  if (!prices.length) return;
  const padR = 56;
  let lo = Math.min(...prices.map((p) => p.c)), hi = Math.max(...prices.map((p) => p.c));
  for (const v of [entry, stop]) if (v) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const tgtIn = target && target <= hi + (hi - lo) * 0.8 && target >= lo - (hi - lo) * 0.8;
  if (tgtIn) { lo = Math.min(lo, target); hi = Math.max(hi, target); }
  const pad = (hi - lo) * 0.1 || hi * 0.01; lo -= pad; hi += pad;
  const X = (k) => (k / Math.max(1, prices.length - 1)) * (w - padR), Y = (v) => 8 + (1 - (v - lo) / (hi - lo)) * (h - 16);
  const lvl = (v, col, lab, dash) => { if (!v) return; g.strokeStyle = col; g.lineWidth = 1.2; g.setLineDash(dash); path(g, [[0, Y(v)], [w - padR + 4, Y(v)]]); g.stroke(); g.setLineDash([]); g.fillStyle = col; g.font = '700 8.5px Plex'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(lab, w - padR + 8, Y(v)); };
  lvl(entry, C.deep, 'ENTRY', []); lvl(stop, C.grey, 'INVALID', [2, 3]);
  if (target) {
    if (tgtIn) lvl(target, C.green, 'TARGET', [4, 3]);
    else { const y = target > hi ? 7 : h - 7; g.strokeStyle = C.green; g.setLineDash([4, 3]); path(g, [[0, y], [w - padR + 4, y]]); g.stroke(); g.setLineDash([]); g.fillStyle = C.green; g.font = '700 8.5px Plex'; g.textAlign = 'left'; g.fillText(target > hi ? 'TARGET ↑' : 'TARGET ↓', w - padR + 8, y); }
  }
  const pts = prices.map((p, k) => [X(k), Y(p.c)]);
  const ar = g.createLinearGradient(0, 0, 0, h); ar.addColorStop(0, 'rgba(74,222,128,.28)'); ar.addColorStop(1, 'rgba(74,222,128,0)');
  path(g, pts); g.lineTo(pts[pts.length - 1][0], h); g.lineTo(0, h); g.closePath(); g.fillStyle = ar; g.fill();
  path(g, pts); g.strokeStyle = C.green; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
  if (at >= 0 && at < pts.length && entry) {
    const x = pts[at][0], y = Y(entry), s = dir > 0 ? 1 : -1;
    g.fillStyle = C.deep; g.beginPath(); g.moveTo(x, y + 4 * s); g.lineTo(x - 6, y + 13 * s); g.lineTo(x + 6, y + 13 * s); g.closePath(); g.fill();
  }
  const [hx, hy] = pts[pts.length - 1];
  g.fillStyle = hexA('#4ade80', 0.3); g.beginPath(); g.arc(hx, hy, 8, 0, Math.PI * 2); g.fill();
  g.fillStyle = C.green; g.beginPath(); g.arc(hx, hy, 3.5, 0, Math.PI * 2); g.fill();
}

// ---------------------------------------------------------------- equity vs hodl
export function drawEquity(cv, { curve, initial, t, marks }) {
  const { g, w, h } = cv; g.clearRect(0, 0, w, h);
  const padL = 40, padR = 70, padT = 16, padB = 18;
  g.font = '500 8.5px Plex'; g.textBaseline = 'middle';
  if (curve.length < 2) { g.fillStyle = C.mute; g.textAlign = 'center'; g.fillText('THE BOOK STARTS WHEN THE REPLAY DOES', w / 2, h / 2); return; }
  const eq = curve.map((p) => p.equity / initial - 1), hd = curve.map((p) => p.hodl / initial - 1);
  let lo = Math.min(0, ...eq, ...hd), hi = Math.max(0, ...eq, ...hd);
  const pad = (hi - lo) * 0.12 || 0.01; lo -= pad; hi += pad;
  const X = (k) => padL + (k / (curve.length - 1)) * (w - padL - padR), Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  const step = (hi - lo) > 0.4 ? 0.2 : (hi - lo) > 0.15 ? 0.05 : 0.02;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    g.strokeStyle = Math.abs(v) < 1e-9 ? '#c6dccd' : '#eaf3ec'; g.lineWidth = 1; path(g, [[padL, Y(v)], [w - padR + 6, Y(v)]]); g.stroke();
    g.fillStyle = C.grey; g.textAlign = 'right'; g.fillText((v > 0 ? '+' : '') + Math.round(v * 100) + '%', padL - 6, Y(v));
  }
  const E = eq.map((v, k) => [X(k), Y(v)]), D = hd.map((v, k) => [X(k), Y(v)]);
  g.strokeStyle = '#a9bdb0'; g.lineWidth = 1.5; g.setLineDash([5, 4]); path(g, D); g.stroke(); g.setLineDash([]);
  const ar = g.createLinearGradient(0, padT, 0, h); ar.addColorStop(0, 'rgba(22,163,74,.22)'); ar.addColorStop(1, 'rgba(22,163,74,0)');
  path(g, E); g.lineTo(E[E.length - 1][0], Y(0)); g.lineTo(padL, Y(0)); g.closePath(); g.fillStyle = ar; g.fill();
  path(g, E); g.strokeStyle = C.green; g.lineWidth = 2.2; g.lineJoin = 'round'; g.stroke();
  for (const k of marks) if (k >= 0 && k < E.length) { g.fillStyle = C.white; g.strokeStyle = C.deep; g.lineWidth = 1.2; g.beginPath(); g.arc(E[k][0], E[k][1], 2.6, 0, Math.PI * 2); g.fill(); g.stroke(); }
  const [ex, ey] = E[E.length - 1], pul = 0.5 + 0.5 * Math.sin(t * 4);
  g.fillStyle = hexA('#4ade80', 0.25 + 0.2 * pul); g.beginPath(); g.arc(ex, ey, 8 + 3 * pul, 0, Math.PI * 2); g.fill();
  g.fillStyle = C.green; g.beginPath(); g.arc(ex, ey, 4, 0, Math.PI * 2); g.fill();
  const tag = (y, txt, bg, fg) => { g.font = '700 10px Plex'; const tw = g.measureText(txt).width + 14; g.fillStyle = bg; g.beginPath(); g.roundRect(w - padR + 10, y - 10, tw, 20, 6); g.fill(); g.fillStyle = fg; g.textAlign = 'left'; g.fillText(txt, w - padR + 17, y + 0.5); };
  const fm = (v) => (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(1) + '%';
  let ye = E[E.length - 1][1], yh = D[D.length - 1][1];
  if (Math.abs(ye - yh) < 22) { if (ye < yh) yh = ye + 22; else ye = yh + 22; }
  tag(yh, fm(hd[hd.length - 1]), '#e8efe9', '#5f7a6a');
  tag(ye, fm(eq[eq.length - 1]), C.green, C.white);
  g.font = '500 8.5px Plex'; g.textAlign = 'left'; g.fillStyle = C.green; g.fillRect(padL + 4, padT - 9, 14, 2.4); g.fillStyle = C.mute; g.fillText('PAPER BOOK', padL + 22, padT - 8);
  g.strokeStyle = '#a9bdb0'; g.setLineDash([5, 4]); g.lineWidth = 1.5; path(g, [[padL + 96, padT - 8], [padL + 110, padT - 8]]); g.stroke(); g.setLineDash([]);
  g.fillText('HODL BASKET (8 ASSETS)', padL + 114, padT - 8);
}
