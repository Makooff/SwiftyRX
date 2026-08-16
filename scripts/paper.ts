#!/usr/bin/env tsx
/**
 * Paper trading entry point — not yet implemented.
 *
 * The command exists so the interface is stable, but it refuses to run rather
 * than simulate a portfolio that does not exist. A stub that printed a
 * plausible-looking P&L would be worse than no command at all.
 *
 * Arrives in Phase 5 (paper broker) on top of Phase 4 (risk engine).
 */
console.error(`
'npm run paper' is not available yet.

Delivered so far:
  Phase 0  repository audit, stack decision, API verification   (done)
  Phase 1  data ingestion adapters + normalisation + dedup      (done)

Required before paper trading can run:
  Phase 2  event detection and source verification
  Phase 3  LLM analysis and structured signal generation
  Phase 4  risk engine (independent veto over every signal)
  Phase 5  paper broker and the ${'€'}300 virtual portfolio

Available today:
  npm run config:check    show the effective configuration and safety posture
  npm run sources:check   probe every configured data source
  npm run ingest:once     run a single ingestion cycle
  npm run dev             continuous ingestion loop
`);
process.exit(1);
