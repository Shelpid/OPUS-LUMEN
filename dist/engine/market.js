// Hourly market series and causal features. The value of any feature at bar i uses bars 0..i only;
// "prev" features (breakout highs, compression) use bars before i.

const H_DAY = 24, H_MONTH = 720;

function sma(x, L) {
  const out = new Float64Array(x.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i]; if (i >= L) s -= x[i - L];
    if (i >= L - 1) out[i] = s / L;
  }
  return out;
}

function rollingStd(x, L) {
  const out = new Float64Array(x.length).fill(NaN);
  let s = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i]; s2 += x[i] * x[i];
    if (i >= L) { s -= x[i - L]; s2 -= x[i - L] * x[i - L]; }
    if (i >= L - 1) { const m = s / L; out[i] = Math.sqrt(Math.max(0, s2 / L - m * m)); }
  }
  return out;
}

// max / min over [i-L, i-1]
function prevMax(x, L) {
  const out = new Float64Array(x.length).fill(NaN);
  for (let i = L; i < x.length; i++) { let m = -Infinity; for (let j = i - L; j < i; j++) if (x[j] > m) m = x[j]; out[i] = m; }
  return out;
}
function prevMin(x, L) {
  const out = new Float64Array(x.length).fill(NaN);
  for (let i = L; i < x.length; i++) { let m = Infinity; for (let j = i - L; j < i; j++) if (x[j] < m) m = x[j]; out[i] = m; }
  return out;
}

// share of the previous L values (ending at i) that are below x[i]
function rollingPct(x, L) {
  const out = new Float64Array(x.length).fill(NaN);
  for (let i = L; i < x.length; i++) {
    if (!Number.isFinite(x[i])) continue;
    let below = 0, k = 0;
    for (let j = i - L; j < i; j++) { if (!Number.isFinite(x[j])) continue; k++; if (x[j] < x[i]) below++; }
    if (k > L / 2) out[i] = below / k;
  }
  return out;
}

function makeSeries(name, rows, funding) {
  const n = rows.length, s = { name, n };
  for (const k of ['time', 'open', 'high', 'low', 'close', 'vol']) s[k] = new Float64Array(n);
  rows.forEach((r, i) => { s.time[i] = r[0]; s.open[i] = r[1]; s.high[i] = r[2]; s.low[i] = r[3]; s.close[i] = r[4]; s.vol[i] = r[5]; });
  // funding known at the close of bar i: the last print at or before open time + 1h
  s.funding = new Float64Array(n).fill(0);
  let j = -1;
  for (let i = 0; i < n; i++) {
    while (j + 1 < funding.length && funding[j + 1][0] <= s.time[i] + 3600) j++;
    s.funding[i] = j >= 0 ? funding[j][1] : 0;
  }
  return s;
}

function features(s) {
  const { n, close, high, low, vol } = s;
  const lr = new Float64Array(n);
  for (let i = 1; i < n; i++) lr[i] = Math.log(close[i] / close[i - 1]);
  const tr = new Float64Array(n);
  for (let i = 0; i < n; i++) tr[i] = i ? Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])) : high[i] - low[i];
  const f = {
    sma24: sma(close, 24), sma50: sma(close, 50), sma200: sma(close, 200),
    atr24: sma(tr, 24),
    vol24: rollingStd(lr, 24), vol30d: rollingStd(lr, H_MONTH),
    hi24: prevMax(high, 24), lo24: prevMin(low, 24), hi168: prevMax(high, 168), lo168: prevMin(low, 168),
    fundMean: sma(s.funding, H_MONTH), fundStd: rollingStd(s.funding, H_MONTH),
    volMean: sma(vol, 168), volStd: rollingStd(vol, 168),
  };
  f.volPct = rollingPct(f.vol24, H_MONTH);
  const width = new Float64Array(n).fill(NaN);
  for (let i = 24; i < n; i++) width[i] = (f.hi24[i] - Math.min(f.lo24[i], low[i])) / close[i];
  f.width = width;
  f.widthPct = rollingPct(width, H_MONTH);
  f.ret24 = new Float64Array(n).fill(NaN);
  f.z24 = new Float64Array(n).fill(NaN);
  f.fundZ = new Float64Array(n).fill(NaN);
  f.volZ = new Float64Array(n).fill(NaN);
  for (let i = 24; i < n; i++) {
    f.ret24[i] = close[i] / close[i - 24] - 1;
    const sd = f.vol30d[i] * Math.sqrt(24);
    if (sd > 0) f.z24[i] = Math.log(close[i] / close[i - 24]) / sd;
    if (f.fundStd[i] > 1e-9) f.fundZ[i] = (s.funding[i] - f.fundMean[i]) / f.fundStd[i];
    if (f.volStd[i] > 0) f.volZ[i] = (vol[i] - f.volMean[i]) / f.volStd[i];
  }
  return f;
}

export function regimeAt(s, i) {
  const f = s.f;
  const vol = f.volPct[i] >= 0.6 ? 'high-vol' : 'calm';
  const a = f.sma50[i], b = f.sma200[i];
  const trend = !(a > 0 && b > 0) ? 'flat' : a > b * 1.004 ? 'uptrend' : a < b * 0.996 ? 'downtrend' : 'flat';
  return { vol, trend, tag: `${vol} ${trend}` };
}

export function buildMarket(MARKET, META) {
  const names = META.assets;
  const A = {};
  for (const name of names) {
    const s = makeSeries(name, MARKET[name].candles, MARKET[name].funding);
    s.f = features(s);
    A[name] = s;
  }
  // relative strength vs BTC, in units of the asset's own 24h sigma
  const btc = A.BTC;
  for (const name of names) {
    const s = A[name]; s.f.relZ = new Float64Array(s.n).fill(NaN);
    if (name === 'BTC') continue;
    for (let i = 24; i < s.n; i++) {
      const sd = s.f.vol30d[i] * Math.sqrt(24);
      if (sd > 0) s.f.relZ[i] = (Math.log(s.close[i] / s.close[i - 24]) - Math.log(btc.close[i] / btc.close[i - 24])) / sd;
    }
  }
  return { names, A, n: A[names[0]].n, time: A[names[0]].time, meta: META };
}

export const WARMUP = 720 + 24;
