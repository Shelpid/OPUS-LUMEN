// The idea catalog. Each setup is a causal trigger on bar i plus a direction. A full hypothesis
// adds an exit geometry and an optional regime filter (see GEOMS / REGIMES). The reasoning layer
// decides which triggered idea is worth researching; the backtest decides whether it has earned it.

export const GEOMS = {
  tight: { tpAtr: 3.5, slAtr: 1.8, horizon: 48, label: 'tight · 3.5/1.8 ATR · 48h' },
  wide: { tpAtr: 6, slAtr: 3, horizon: 72, label: 'wide · 6/3 ATR · 72h' },
  swing: { tpAtr: 8, slAtr: 4, horizon: 96, label: 'swing · 8/4 ATR · 96h' },
};
export const REGIMES = ['any', 'calm', 'high-vol'];

const pct = (x, d = 1) => (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(d) + '%';
const fnd = (x) => (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(4) + '%';

export const SETUPS = [
  {
    id: 'FUNDING_SQUEEZE', name: 'funding squeeze', dir: 1,
    detect(s, i) {
      const f = s.f;
      if (!(f.fundZ[i] < -1.3 && s.close[i] > f.sma24[i] && f.ret24[i] > -0.03)) return 0;
      return Math.min(1, 0.35 + (-f.fundZ[i] - 1.3) / 2);
    },
    observe: (s, i) => `funding ${fnd(s.funding[i])} (z ${s.f.fundZ[i].toFixed(1)}) while price holds above its 24h mean`,
    think: 'shorts are paying to stay short into a market that refuses to drop',
  },
  {
    id: 'CROWDED_LONG_FADE', name: 'crowded long fade', dir: -1,
    detect(s, i) {
      const f = s.f;
      if (!(f.fundZ[i] > 1.6 && f.z24[i] > 1.2)) return 0;
      return Math.min(1, 0.35 + (f.fundZ[i] - 1.6) / 2.5 + (f.z24[i] - 1.2) / 4);
    },
    observe: (s, i) => `funding ${fnd(s.funding[i])} (z +${s.f.fundZ[i].toFixed(1)}) after a ${pct(s.f.ret24[i])} day`,
    think: 'longs are paying a premium to chase; a crowded side usually pays for it',
  },
  {
    id: 'COMPRESSION_BREAK', name: 'compression breakout', dir: 1,
    detect(s, i) {
      const f = s.f;
      if (!(f.widthPct[i - 1] < 0.12 && s.close[i] > f.hi24[i])) return 0;
      return Math.min(1, 0.45 + (0.12 - f.widthPct[i - 1]) * 3);
    },
    observe: (s, i) => `24h range ${(s.f.width[i - 1] * 100).toFixed(1)}% · tighter than ${Math.round((1 - s.f.widthPct[i - 1]) * 100)}% of the last 30 days · now breaking up`,
    think: 'compression stores energy; the first clean break usually picks the direction',
  },
  {
    id: 'CAPITULATION_BOUNCE', name: 'capitulation bounce', dir: 1,
    detect(s, i) {
      const z = s.f.z24[i];
      if (!(z < -2.2 && s.close[i] > s.low[i] + (s.high[i] - s.low[i]) * 0.4)) return 0;
      return Math.min(1, 0.4 + (-z - 2.2) / 3);
    },
    observe: (s, i) => `${pct(s.f.ret24[i])} in 24h · a ${Math.abs(s.f.z24[i]).toFixed(1)}σ move · last candle closed off the lows`,
    think: 'forced sellers exhaust themselves; the snap-back is often fast',
  },
  {
    id: 'TREND_PULLBACK', name: 'trend pullback', dir: 1,
    detect(s, i) {
      const f = s.f;
      const up = f.sma50[i] > f.sma200[i] * 1.004;
      if (!(up && s.close[i - 1] < f.sma24[i - 1] && s.close[i] > f.sma24[i] && f.ret24[i] < 0.01)) return 0;
      return Math.min(1, 0.4 + (f.sma50[i] / f.sma200[i] - 1) * 20);
    },
    observe: (s, i) => `uptrend intact (SMA50 ${pct(s.f.sma50[i] / s.f.sma200[i] - 1)} over SMA200) · price just reclaimed its 24h mean`,
    think: 'dips inside an uptrend get bought; the reclaim is the first sign they are',
  },
  {
    id: 'VOLUME_BREAKOUT', name: 'volume breakout', dir: 1,
    detect(s, i) {
      const f = s.f;
      if (!(s.close[i] > f.hi168[i] && f.volZ[i] > 1.8)) return 0;
      return Math.min(1, 0.4 + (f.volZ[i] - 1.8) / 5);
    },
    observe: (s, i) => `closed above the 7-day high on ${s.f.volZ[i].toFixed(1)}σ volume`,
    think: 'a new high on real volume means new buyers, not just thin air',
  },
  {
    id: 'RELATIVE_STRENGTH', name: 'relative strength', dir: 1,
    detect(s, i, m) {
      if (s.name === 'BTC') return 0;
      const b = m.A.BTC.f.ret24[i];
      if (!(s.f.relZ[i] > 1.8 && b > -0.01 && b < 0.02)) return 0;
      return Math.min(1, 0.35 + (s.f.relZ[i] - 1.8) / 3);
    },
    observe: (s, i, m) => `${pct(s.f.ret24[i])} in 24h vs BTC ${pct(m.A.BTC.f.ret24[i])} · outperforming by ${s.f.relZ[i].toFixed(1)}σ`,
    think: 'money is rotating into it while the market sits still',
  },
  {
    id: 'TREND_RALLY_FADE', name: 'downtrend rally fade', dir: -1,
    detect(s, i) {
      const f = s.f;
      const down = f.sma50[i] < f.sma200[i] * 0.996;
      if (!(down && s.close[i - 1] > f.sma24[i - 1] && s.close[i] < f.sma24[i] && f.ret24[i] > -0.01)) return 0;
      return Math.min(1, 0.4 + (1 - f.sma50[i] / f.sma200[i]) * 20);
    },
    observe: (s, i) => `downtrend intact (SMA50 ${pct(s.f.sma50[i] / s.f.sma200[i] - 1)} under SMA200) · the bounce just lost its 24h mean`,
    think: 'rallies inside a downtrend get sold; losing the mean is the first sign they are',
  },
  {
    id: 'VOLUME_BREAKDOWN', name: 'volume breakdown', dir: -1,
    detect(s, i) {
      const f = s.f, lo168 = f.lo168[i];
      if (!(s.close[i] < lo168 && f.volZ[i] > 1.8)) return 0;
      return Math.min(1, 0.4 + (f.volZ[i] - 1.8) / 5);
    },
    observe: (s, i) => `closed below the 7-day low on ${s.f.volZ[i].toFixed(1)}σ volume`,
    think: 'a new low on heavy volume means real sellers, not a stop hunt',
  },
  {
    id: 'COMPRESSION_BREAKDOWN', name: 'compression breakdown', dir: -1,
    detect(s, i) {
      const f = s.f;
      if (!(f.widthPct[i - 1] < 0.12 && s.close[i] < f.lo24[i])) return 0;
      return Math.min(1, 0.45 + (0.12 - f.widthPct[i - 1]) * 3);
    },
    observe: (s, i) => `24h range ${(s.f.width[i - 1] * 100).toFixed(1)}% · tighter than ${Math.round((1 - s.f.widthPct[i - 1]) * 100)}% of the last 30 days · now breaking down`,
    think: 'compression stores energy; this time it is releasing to the downside',
  },
  {
    id: 'RELATIVE_WEAKNESS', name: 'relative weakness', dir: -1,
    detect(s, i, m) {
      if (s.name === 'BTC') return 0;
      const b = m.A.BTC.f.ret24[i];
      if (!(s.f.relZ[i] < -1.8 && b > -0.02 && b < 0.01)) return 0;
      return Math.min(1, 0.35 + (-s.f.relZ[i] - 1.8) / 3);
    },
    observe: (s, i, m) => `${pct(s.f.ret24[i])} in 24h vs BTC ${pct(m.A.BTC.f.ret24[i])} · lagging by ${Math.abs(s.f.relZ[i]).toFixed(1)}σ`,
    think: 'money is leaving it while the market sits still',
  },
];

export const SETUP = Object.fromEntries(SETUPS.map((x) => [x.id, x]));

// Every setup that fires on bar i across the universe.
export function triggersAt(m, i) {
  const out = [];
  for (const name of m.names) {
    const s = m.A[name];
    for (const st of SETUPS) {
      const v = i >= 2 ? st.detect(s, i, m) : 0;
      if (v > 0) out.push({ setup: st.id, asset: name, i, strength: v, dir: st.dir });
    }
  }
  return out.sort((a, b) => b.strength - a.strength);
}
