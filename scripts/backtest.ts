#!/usr/bin/env tsx
/**
 * Backtesting entry point — not yet implemented.
 *
 * Refuses to run rather than emit metrics from a non-existent engine. A
 * backtest number that nobody computed is the single most dangerous artefact
 * this project could produce.
 *
 * Arrives in Phase 6, with point-in-time data, transaction costs, slippage,
 * and walk-forward evaluation.
 */
console.error(`
'npm run backtest' is not available yet.

The backtesting engine lands in Phase 6. When it does, it will report total and
annualised return, volatility, Sharpe, Sortino, maximum drawdown, win rate,
profit factor, average trade, trade count, transaction costs, slippage, and
performance against buy & hold — with walk-forward validation and point-in-time
data so results are not inflated by look-ahead bias.

Phase 1 groundwork already in place:
  - every data point carries an as-of timestamp and a feed delay class
  - FRED observations can be queried by vintage (FredAdapter.getSeriesAsOf)
  - all timestamps flow through an injectable Clock, so a backtest cannot
    accidentally read the wall clock

Available today:
  npm run config:check    show the effective configuration and safety posture
  npm run sources:check   probe every configured data source
  npm run ingest:once     run a single ingestion cycle
`);
process.exit(1);
