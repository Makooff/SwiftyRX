# Architecture

## The pipeline

```
DATA SOURCES
     ↓
INGESTION            ← Phase 1 (built)
     ↓
NORMALISATION        ← Phase 1 (built)
     ↓
DEDUPLICATION        ← Phase 1 (built)
     ↓
EVENT DETECTION      ← Phase 2
     ↓
SOURCE VERIFICATION  ← Phase 2
     ↓
MARKET CONTEXT       ← Phase 2/3
     ↓
LLM ANALYSIS         ← Phase 3
     ↓
SIGNAL SCORING       ← Phase 3
     ↓
RISK ENGINE          ← Phase 4   (can veto anything above it)
     ↓
PAPER ORDER          ← Phase 5
     ↓
PORTFOLIO            ← Phase 5
     ↓
MONITORING           ← Phase 7
```

Each stage may only *reduce* conviction. An event with weak sourcing cannot become a
high-confidence signal because a model wrote persuasive prose about it, and a
high-confidence signal cannot become an order if the Risk Engine says no.

## Design rules

### 1. The Risk Engine is not downstream of the LLM's judgement

The model produces a structured signal. The Risk Engine is separate code with its own
inputs — position sizes, exposure, daily loss, data freshness — and an unconditional veto.
It never reads the model's confidence as permission. A language model is good at reading
a filing and bad at knowing how much of your account to bet, and those are different jobs.

### 2. Missing data means DO NOT TRADE

Every price carries a `Freshness` envelope: what instant it refers to, when we fetched it,
and the feed's documented delay class. `MarketDataService` refuses to return a quote older
than `MAX_QUOTE_STALENESS_SECONDS`, raising `StaleDataError` rather than serving a stale
price with a warning. Trading on a two-hour-old price is trading on a market that no longer
exists.

The same principle runs through the adapters: Finnhub's candles endpoint throws instead of
returning `[]` on the free tier, because an empty bar array reads downstream as "no trading
activity" — a silent lie is worse than a loud failure.

### 3. Trust is earned per claim, not granted per source

`SourceTier` assigns a *prior* (official 0.98 → social 0.25 → unknown 0.10). That prior is
one input to verification, never a substitute for it. Every document — including an SEC
filing — enters as `verification: 'unverified'`. Confirmation is something the verification
pipeline establishes in Phase 2, not something ingestion asserts.

### 4. Near-duplicates are linked, not collapsed

Exact duplicates are dropped. Near-duplicates are kept and linked via `duplicateOf`, because
several independent outlets carrying the same claim *is* the corroboration signal Phase 2
needs. Collapsing them into one document would delete the evidence.

Scope limit: this matches text, not meaning. Two outlets describing one event in their own
words will not match, and should not — semantic clustering is event detection's job.

### 5. Time is injected, never read from the wall clock

Every timestamp flows through a `Clock`. `FixedClock` drives tests and will drive
backtests. A backtest that calls `Date.now()` has a look-ahead bug waiting to happen, so
the ambient clock is simply not available to code that matters.

FRED's vintage support (`getSeriesAsOf`) is the same principle applied to data: macro series
get revised, and a backtest must see the number that was published on the decision date,
not today's corrected one.

### 6. Secrets have exactly one path

Credentials live in environment variables. `src/core/redact.ts` is the single chokepoint:
registered secret literals, credential-shaped object keys, and credential-bearing URL query
parameters are scrubbed before anything reaches a log. Alpaca credentials go in headers,
never in a URL. Nothing carrying a secret is ever put in an LLM prompt.

### 7. Adapters are replaceable

Every source implements `DocumentSource`, `MarketDataSource` or `MacroSource`. Nothing
downstream knows which vendor produced a document. Providers are ordered by priority and
fail over; each failover is logged, because silently degrading to a worse feed is a decision
the operator deserves to see.

## Module map

| Module | Responsibility |
|---|---|
| `config/env.ts` | Zod-validated environment; safety invariants that block unsafe boots |
| `core/http.ts` | Retries with jittered backoff, timeouts, rate limits, circuit breaking, stats |
| `core/rate-limiter.ts` | `TokenBucket` for published limits; `DailyQuota` for billed APIs |
| `core/circuit-breaker.ts` | Stops hammering a failing provider and reports it as unhealthy |
| `core/redact.ts` | Secret scrubbing for logs, errors and future prompts |
| `core/clock.ts` | Injectable time |
| `domain/types.ts` | `NormalizedDocument`, `Quote`, `Bar`, `Freshness`, `HealthReport` |
| `ingestion/normalize.ts` | Raw payload → `NormalizedDocument`; cleans, never interprets |
| `ingestion/dedup.ts` | Exact drop, near-duplicate link |
| `ingestion/source-registry.ts` | Source descriptors and reliability priors |
| `ingestion/pipeline.ts` | Config → adapters; one ingestion cycle; health aggregation |
| `monitoring/metrics.ts` | Counters and latency histograms |

## Concurrency and failure isolation

Adapters run concurrently via `Promise.allSettled`, at three levels: feeds within an
adapter, adapters within a cycle, and providers within the market-data service. A failure at
any level degrades coverage and is recorded; it never aborts the cycle. Which missing
coverage is disqualifying is a Risk Engine decision, not an ingestion one.

## What Phase 1 deliberately does not do

- No event detection, entity resolution, or sentiment analysis
- No LLM calls of any kind
- No signals, scoring, or portfolio state
- No broker connection, paper or live
- No persistence — everything is in memory
- No dashboard

`npm run paper` and `npm run backtest` exist as commands and **refuse to run**. A stub
printing a plausible P&L, or a backtest metric nobody computed, would be the most dangerous
artefact this project could produce.
