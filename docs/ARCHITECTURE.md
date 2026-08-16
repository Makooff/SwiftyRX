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
EVENT DETECTION      ← Phase 2 (built)
     ↓
SOURCE VERIFICATION  ← Phase 2 (built)
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

### 3b. Verification is arithmetic you can audit, not a vibe

Phase 2 assigns a confidence that a claim is *true* (not that it is tradeable) from
deterministic rules, and records every adjustment in `verification.reasons`. Three
properties are structural rather than advisory:

- **Corroboration means independent reporting.** Documents flagged as near-duplicates count
  once. Ten outlets running one wire story is one newsroom.
- **Social sources cannot self-promote.** A cluster of nothing but posts is capped at 0.35
  and can never be marked confirmed, however many accounts repeat it.
- **Market reaction cannot vouch for an unverified claim.** A price move is only scored when
  the claim is already independently established — otherwise a rumour moves the price and
  the move then "confirms" the rumour.

### 4. Near-duplicates are linked, not collapsed

Exact duplicates are dropped. Near-duplicates are kept and linked via `duplicateOf`, because
several independent outlets carrying the same claim *is* the corroboration signal Phase 2
needs. Collapsing them into one document would delete the evidence.

Scope limit: this matches text, not meaning. Two outlets describing one event in their own
words will not match, and should not — semantic clustering is event detection's job, and is
where Phase 2 picks the work up.

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
| `intelligence/entity_resolution/` | Curated registry + deterministic resolver |
| `intelligence/event_detector/rules.ts` | SEC item/form tables, keyword rules, denial patterns |
| `intelligence/event_detector/classifier.ts` | Document → event type + materiality |
| `intelligence/event_detector/clustering.ts` | Documents → one event per real-world occurrence |
| `intelligence/verification/verifier.ts` | Reliability → corroboration → official → confidence |
| `intelligence/verification/market-reaction.ts` | Post-publication price/volume move (weak evidence) |
| `intelligence/pipeline.ts` | Orchestration, event store, Phase 3 gate |

## Concurrency and failure isolation

Adapters run concurrently via `Promise.allSettled`, at three levels: feeds within an
adapter, adapters within a cycle, and providers within the market-data service. A failure at
any level degrades coverage and is recorded; it never aborts the cycle. Which missing
coverage is disqualifying is a Risk Engine decision, not an ingestion one.

## Why Phase 2 is rule-based

No LLM is involved in event detection or verification, and that is deliberate rather than a
staging accident. A rule layer gives a reproducible answer to "why did the system think
this?" that does not vary with a model's temperature, and it stays as a check underneath
Phase 3: when the model and the rules disagree, that disagreement is itself information.
Filing metadata is treated as near-ground-truth (an 8-K item code is the issuer's own
statement of what the filing is about); keyword rules over prose carry lower weights,
because they are genuinely fuzzy.

Over-merging is the failure mode clustering guards against hardest. Two distinct events
fused into one produce a single event carrying the combined apparent corroboration of both
— manufactured confidence, which is exactly what verification exists to prevent. One
deliberate exception: a document using denial language attaches to an event it shares
entities with even when its own type does not match, because "X denies the report" carries
none of the vocabulary that classified the claim, and filing it separately would leave the
refuted claim looking unchallenged.

## What Phases 1–2 deliberately do not do

- No sentiment scoring (see docs/SPEC_ADAPTATIONS.md §8)
- No LLM calls of any kind
- No signals, direction, sizing, or portfolio state
- No broker connection, paper or live
- No persistence — everything is in memory
- No dashboard

`npm run paper` and `npm run backtest` exist as commands and **refuse to run**. A stub
printing a plausible P&L, or a backtest metric nobody computed, would be the most dangerous
artefact this project could produce.
