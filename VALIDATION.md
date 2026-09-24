# Verification

## Automated tests

`node --test tests/*.test.mjs` runs 21 tests with no network and no API key:

- **Data:** 8 assets × 4 320 hourly candles, exactly one hour apart, aligned across assets, valid OHLC, funding history present.
- **Causality:** every future candle is rewritten (prices ×3, volume ×9) after a decision bar; no feature and no trigger at that bar changes.
- **Fills:** entry at the next open with slippage; when a bar touches both levels the stop wins; fees on both sides; unresolved trades stay hidden.
- **Statistics:** one-sided t-test p-values match table values (t = 1.812, df 10 → p ≈ 0.05).
- **Decision-time history:** only trades that had exited before the decision are counted; the Bonferroni-corrected p-value is exactly p × variants.
- **Gate:** refuses too few trades, too little expectancy, an insignificant corrected p-value, and ideas that lose in today's regime.
- **Memory:** blocks a setup only in the regime it died in, only for 14 days.
- **Paper book:** fills, time exit and cash accounting.
- **Full replay:** two local runs produce identical results; every SHIP passed the gate; most ideas die.
- **Override:** a reasoner that insists on SHIP for an idea that failed the gate is downgraded to KILL and no position opens.
- **Protocol:** the parser survives markdown, bullets and wrapped lines; invalid plans and verdicts are rejected, not guessed; prompts carry the engine's real numbers.
- **Server:** in `--fake` mode, real HTTP + SSE: status, static files, streamed text equals the final message, malformed histories rejected.

## Browser checks

- Desktop 1280 × 900 in headless Chrome: replay, research cycles, SHIP moment with gate passed, pipeline, signal matrix, idea chart, paper book, memory and ticker all render with no page errors.
- OPUS mode wired end to end against `server.mjs --fake`: 43 streamed calls, plans parsed, verdicts applied, no errors.
- Static hosting (`python -m http.server --directory dist`): the app runs on the local reasoner; the OPUS button is disabled.
- Phone 390 × 844: panels stack, `scrollWidth` equals the viewport.

## What was not tested

- **No real Claude Opus 5.5 call was made while building this repository** (no API key was used). The live path uses the official `@anthropic-ai/sdk` streaming API with model `claude-opus-5-5` and is exercised in tests through the scripted `--fake` mode, which shares the same HTTP, SSE and parsing code. Run it with your key and watch the first cycles.
- Results in OPUS mode will vary between runs; the README results table comes from the deterministic local reasoner only.
- No exchange connectivity exists. Everything is paper trading on historical data.
