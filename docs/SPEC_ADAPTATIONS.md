# Adaptations to the original brief

The project brief was drafted with an LLM's help. It is a good brief — the safety posture,
the phase ordering and the insistence on verifying APIs are all right. But parts of it are
internally inconsistent or specify work that would cost effort and return nothing. This
document records every deviation and the reasoning, so the decisions can be argued with
rather than discovered later in the code.

Two categories: **already applied**, and **recommendations** that were subsequently resolved
one way or the other as the phases landed. Each resolved item carries a note saying what was
actually done.

---

## Already applied

### 1. `src/core/` added; `apps/` and empty phase directories omitted

The brief's tree has no home for cross-cutting infrastructure (HTTP, rate limiting, secret
redaction). Burying it in `ingestion/` would make it unavailable to `execution/` later.

`apps/api`, `apps/worker` and `apps/dashboard` were created in Phases 7–8, when they had
something to serve — not up front as empty packages. Same for `intelligence/`, `strategy/`,
`risk/`, `execution/` and `backtesting/`: each directory appeared with its phase. Directories
full of placeholder interfaces suggest progress that has not happened.

### 2. One language, not "TypeScript or Python per component"

Per-component language choice sounds flexible and buys a permanent serialisation boundary,
two toolchains and two test runners. TypeScript throughout, with the option to add a Python
process later for the backtest statistics if they ever justify it.

### 3. `npm run paper` and `npm run backtest` refused to run until they were real

Through Phases 1–4 these commands existed, printed what was and was not built, and exited
non-zero. A stub emitting a plausible-looking P&L, or a backtest metric nobody computed, is
the most dangerous artefact this project could produce.

Both now run for real (Phases 5–6). The same principle carried forward: `npm run backtest`
labels fixture runs as synthetic and warns when the trade count is too low to conclude
anything, rather than presenting a number that looks like a result.

### 4. Near-duplicates are linked, not collapsed

The brief lists "DÉDUPLICATION" as a single step. Implemented as two: exact duplicates are
dropped, near-duplicates are kept and linked. Several outlets carrying the same claim *is*
the corroboration evidence the verification stage needs — deduplicating it away would
destroy the signal the next stage exists to measure.

### 5. "Never tweet → BUY" made structural rather than procedural

The brief states the rule in prose. In the code it is a property of the data: social
documents carry `canTriggerOrderDirectly: false` and `requiresCorroboration: true`, at the
lowest reliability tier. A rule written only in a prompt or a README is a rule that gets
forgotten; a field on the document travels with it.

---

## Recommendations and how they were resolved

### 6. The €300 portfolio cannot answer the question the project is asking

This is the most important item here.

> **Decided: adopted.** Paper and backtest now run at `PAPER_CAPITAL_EUR=10000`;
> `LIVE_CAPITAL_EUR=300` remains the real-money target. `config.initialCapital` resolves to
> whichever applies to the active mode. At 10k, a 1% single-trade risk budget is €100 rather
> than €3, so commission and spread stop dominating the result and `MAX_TRADES_PER_DAY=10`
> is no longer self-defeating — it is left at 10.
>
> The measurement problem below is **not** solved by this change: more capital per trade
> improves the signal-to-cost ratio, not the number of observations. Judging whether the
> signals work still needs years of returns or hundreds of trades.

The brief sets `INITIAL_CAPITAL_EUR=300`, `MAX_TRADES_PER_DAY=10`,
`MAX_DAILY_LOSS_PERCENT=2` and `MAX_SINGLE_TRADE_RISK_PERCENT=1`. Worked through:

- Risk budget per trade: **€3**. A round-trip commission plus spread on a single US equity
  can easily consume most of that before the strategy is right or wrong about anything.
- Daily loss limit: **€6**. Normal intraday movement of one €60 position routinely exceeds
  that, so the circuit breaker would trip on noise, not on failure.
- 10 trades/day at this size is a cost-generation machine regardless of signal quality.

Worse, there is a measurement problem no configuration fixes. The t-statistic on a
strategy's Sharpe ratio grows roughly as `Sharpe × √years`. To distinguish a genuinely good
strategy (Sharpe ≈ 1.0) from luck at conventional significance takes about **4 years** of
daily returns; a more realistic Sharpe of 0.5 takes around **16 years**. A few months of
paper trading a €300 account cannot tell you whether the signals work. It can only tell you
whether the system executes without crashing — which is worth knowing, but is a different
question.

**Recommendation:** separate the two purposes.

- Keep **€300 as the live-money target** — it is a sensible amount to risk on an
  experiment, and the risk limits should be sized for it when Phase 9 is ever reached.
- Run **paper trading at a larger notional** (€10,000–50,000, configurable) so that
  position sizes are not swamped by costs and the statistics mean something.
- Lower the default `MAX_TRADES_PER_DAY` to **2–3**. Fewer, higher-conviction trades is
  already the stated intent; the current default contradicts it.
- Require **fractional-share support** from any broker adapter, or a €60 position cannot
  buy a single share of many US names.

Costs must be modelled explicitly in both paper and backtest. A strategy that is profitable
gross and unprofitable net is unprofitable.

### 7. The Benner cycle: test it once, then stop

> **Decided: built as an off-by-default overlay with a comparison harness.**
> `src/strategy/signals/benner.ts` implements the tilt; `npm run backtest -- --benner` runs
> the same strategy on the same bars with and without it. It is never on unless asked for.
> The deletion clause stands: if a run on real data shows no out-of-sample improvement, the
> file goes, rather than sitting at weight zero waiting to be re-enabled on a hopeful
> afternoon. No such run has happened — no real bars have been available.

The brief already hedges this correctly ("surtout pas comme vérité"). Going further: a
19th-century commodity-price cycle predicting 21st-century equity returns has an
extraordinarily low prior. Build it as a **one-off falsification test** in Phase 6 —
strategy with vs. without, out of sample — publish the result, and if it does not improve
out-of-sample performance, delete the code rather than leaving a zero-weighted feature
around to be re-enabled on a hopeful afternoon.

### 8. Drop the standalone sentiment module

> **Decided: cut.** There is no `intelligence/sentiment/`. Sentiment survives only as one
> bounded term inside `scoreSignal`, derived from the model's `impact` and
> `impact_strength` fields, weighted like every other factor and zeroable by the vetoes. It
> can never produce a trade on its own.

The brief lists `intelligence/sentiment/` beside event detection. Generic sentiment scoring
of financial text is a well-known source of false confidence: it correlates with what has
already happened to the price rather than with what will. Event detection plus impact
analysis covers the useful part. **Recommendation:** cut it, and revisit only if a specific
signal demonstrably needs it.

### 9. Abandon the latency race explicitly

> **Decided: adopted.** No WebSocket or streaming code exists. The agent polls on
> `INGEST_INTERVAL_SECONDS` and the constraint is stated in the README and in RISKS.md: any
> edge must come from interpretation over hours to days, not from being early.

The brief asks for WebSockets, streaming and parallel processing to "react quickly", then
correctly says never to sacrifice verification for milliseconds. These pull in opposite
directions, and the second one wins. Professional participants react to a filing in
microseconds; this system reacts in seconds to minutes and cannot close that gap.

**Recommendation:** state as a design constraint that any edge must come from
*interpretation over hours to days*, not from being early. WebSocket streaming then earns
its place only where it is also cheaper than polling — not as a speed play. If a candidate
strategy only works when you are first, this architecture cannot deliver it, and that should
disqualify the strategy rather than trigger an infrastructure project.

### 10. Keep X switched off until signals are shown to work

> **Still off.** `ENABLE_X_INGESTION=false` and `X_MAX_POSTS_READ_PER_DAY=0`. The condition
> for revisiting — evidence that the pipeline produces useful signals from free official
> sources — has not been met, because no run against real data has happened yet.

X reads are billed per post. Spending real money to ingest a source that can never trigger
an order on its own, before any evidence that the pipeline produces useful signals from free
official sources, is out of order. **Recommendation:** revisit at Phase 8, not before.

### 11. A modest dashboard, server-rendered

> **Decided: adopted.** `apps/dashboard/render.ts` emits a complete page from the agent's
> state — portfolio, signals, events, orders, health and structured reasoning — with no
> build step, no framework, no external assets and no client-side state. The API
> (`apps/api/server.ts`) is read-only and bound to 127.0.0.1; a test asserts that no
> order-placing endpoint exists.

The brief asks for "un dashboard moderne". For a single-operator monitoring surface, a
server-rendered page with a small amount of JavaScript delivers everything listed
(portfolio, signals, events, orders, health, reasoning) without a second build pipeline,
a client-side state library, or an API surface that exists only to feed a SPA.
**Recommendation:** defer any framework decision to Phase 7 and default to the simpler
option unless something specific demands more.

### 12. Note on data availability for walk-forward testing

> **Decided: daily bars only.** `src/backtesting/walk-forward.ts` runs rolling train/test
> windows on daily bars, carrying capital between windows. Intraday walk-forward remains a
> paid-data question and is not implemented.

The brief's walk-forward schedule (train 2020–22 → test 2023, and so on) is sound, but free
tiers constrain it: daily bars are available for the full window, **intraday history is
not** on free plans. Phase 6 should therefore be built on daily bars first, with intraday
walk-forward treated as a paid-data question to answer later.

---

## Decisions taken during Phases 3–8

### 13. Phase 9 is not "not started" — it is deliberately absent

The brief's phase list ends with live trading. `createLiveBroker()` exists and throws.
There is no live order path to review, disable or accidentally enable, and the safety gate
(`assertLiveTradingAllowed()`) sits in front of a function that refuses regardless.

This is stronger than a feature flag. A flag can be flipped; missing code has to be written,
which is a deliberate act with a diff attached. Enabling live trading should require exactly
that, and should not happen before paper results on real data exist and have been read
honestly.

### 14. The model's confidence is capped as an input, not trusted as a conclusion

The brief lists "confiance du modèle" among the scoring factors. It is there, with a weight
ceiling of 0.16 — deliberately smaller than source quality and corroboration combined.

The reason: model confidence is the one factor with no independent grounding. Source tier,
corroboration count, price reaction and volume are measurements; the model's confidence is a
self-report from a system that is fluent about things it has misunderstood. Letting it
dominate would make the score a restatement of the model's opinion rather than a check on it.

### 15. Every decision is journalled, including the ones that produced no order

The brief asks for a decision journal. Implemented as append-only JSONL covering *every*
decision — including signals the Risk Engine refused and events that scored too low.

A journal of executed trades only is survivorship-biased and cannot answer the project's
actual question. `hitRateByEventType()` reads that journal, and it is the same statistic the
scorer holds neutral below 30 observations, so the system will not start believing its own
early record.

### 16. One cost model, shared by paper and backtest

`src/execution/costs.ts` is used by both `PaperBroker` and the backtest engine. A separate,
gentler cost model in the backtester is how a strategy comes to look profitable in
simulation and lose money in paper for want of a fee that was modelled in one place and not
the other.

---

## What was not changed

The brief's safety architecture was adopted essentially as written, because it is correct:
paper-by-default, live behind an explicit multi-part gate, a risk engine independent of the
LLM with veto power, no withdrawal or transfer capability anywhere, missing data meaning
DO-NOT-TRADE, and the decision journal that makes "do the signals actually work?" an
answerable question. The phase ordering is also right — data before intelligence, risk
before execution, evidence before money.
