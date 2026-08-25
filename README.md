# AI Market Agent

An experimental market intelligence system. It ingests official filings, central-bank
releases, macro data and market prices, detects and verifies events, asks Claude for a
structured hypothesis about each one, scores that hypothesis against evidence quality, and
lets an independent Risk Engine decide whether anything is allowed to become an order.

> **Status: all nine phases built.** The loop runs end to end: ingest → detect → verify →
> analyse → score → risk → order → portfolio → journal → dashboard. A live Alpaca adapter
> exists behind a multi-part gate that is **off by default and never opens on its own**.
>
> Built is not the same as proven. No adapter here has ever been executed against its live
> API, and no strategy has been backtested on real market data. See
> [Known limitations](#known-limitations) before connecting anything.

> **No real money is at risk.** The system defaults to `MODE=paper` with `LIVE_TRADING=false`,
> and live trading requires an explicit, multi-part configuration that the process validates
> at startup. There is no code path anywhere in this repository to withdraw funds, transfer
> money, change bank details or open an account — and there must never be one. The
> `BrokerAdapter` interface has six methods and none of them moves money.

---

## Contents

1. [Architecture](#architecture)
2. [Installation](#installation)
3. [Configuration](#configuration)
4. [APIs required](#apis-required)
5. [Estimated costs](#estimated-costs)
6. [Event detection and verification](#event-detection-and-verification)
7. [Signals and scoring](#signals-and-scoring)
8. [Risk engine](#risk-engine)
9. [Paper trading](#paper-trading)
10. [Backtesting](#backtesting)
11. [Dashboard](#dashboard)
12. [Security](#security)
13. [Going live](#going-live)
14. [Known limitations](#known-limitations)
15. [Risks](#risks)
16. [Adding a source / broker / strategy](#extending)
17. [Development phases](#development-phases)

---

## Architecture

```
DATA SOURCES → INGESTION → NORMALISATION → DEDUPLICATION → EVENT DETECTION
    → SOURCE VERIFICATION → MARKET CONTEXT → LLM ANALYSIS → SIGNAL SCORING
    → RISK ENGINE → PAPER ORDER → PORTFOLIO → DECISION JOURNAL → MONITORING
```

Every stage may only *reduce* conviction. Full detail in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

Five principles shape everything:

- **The Risk Engine is independent of the LLM.** The model proposes; separate code with its
  own inputs disposes, and can veto any signal regardless of the model's confidence. The
  model never sees position sizes, cash, or exposure, and never chooses them.
- **Missing or stale data means DO NOT TRADE.** Every price carries provenance and an age.
  A quote past its staleness limit raises an error instead of being served with a warning.
- **No source is trusted on its own.** Every document enters as `unverified`, including SEC
  filings. Confidence comes from independent corroboration and official confirmation, with
  every adjustment recorded. Ten outlets running one wire story count as one report, and a
  cluster of social posts is capped no matter how many accounts repeat it.
- **The model's output is data, not instruction.** Untrusted document text is fenced,
  the system prompt is the only instruction channel, and the response is schema-validated
  before anything reads it. A tweet cannot become a BUY.
- **Failures are loud.** Adapters throw rather than returning empty results, because an
  empty array reads downstream as "nothing happened".

```
src/
├── config/        environment schema + live-trading safety gate
├── core/          http, rate limiting, circuit breaker, clock, cache, secret redaction
├── domain/        shared types (documents, quotes, bars, freshness, health)
├── ingestion/     news · official_sources · macro · market_data · social
├── intelligence/  entity_resolution · event_detector · verification · llm
├── strategy/      signal generation · scoring · regime · Benner (experimental)
├── risk/          independent risk engine + position sizing
├── execution/     broker interface · paper broker · portfolio · cost model · live (disabled)
├── backtesting/   event-driven engine · metrics · walk-forward
├── database/      append-only decision journal + agent state persistence
└── monitoring/    counters and latency histograms
apps/
├── worker/        the trading agent loop
├── dashboard/     server-rendered HTML
└── api/           read-only localhost JSON API
scripts/           CLI entry points
tests/             303 tests, zero network access
docs/              audit, API research, architecture, risks, spec adaptations
```

## Installation

Requires **Node.js ≥ 20.12** (developed on 22).

```bash
git clone <this repo>
cd ai-market-agent
npm install
cp .env.example .env      # works as-is; no credentials needed to start
npm test                  # 303 tests, no network required
npm run doctor            # what works, what doesn't, and what to do — start here
npm run config:check      # shows the effective safety posture
npm run sources:check     # probes every configured data source
npm run backtest -- --fixture   # a full backtest with no API keys
npm run paper             # paper trading loop + dashboard on :3000
```

Optional local infrastructure (nothing uses it yet — state and the journal are files under
`data/`):

```bash
docker compose up -d      # PostgreSQL + Redis
```

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Continuous ingestion loop (no trading) |
| `npm run paper` | Full paper-trading agent + dashboard, resuming saved state. `-- --once`, `-- --no-server`, `-- --fresh` |
| `npm run backtest` | Historical backtest. `-- --symbol NVDA --years 5 --walk-forward --benner --fixture` |
| `npm run study` | Does a class of filing carry any information at all? `-- --years 5 --benchmark SPY --out --symbols-file universe.txt`. Needs no LLM |
| `npm run correlations` | Which of the names traded are the same bet? Writes the groups the correlated-exposure limit needs. `-- --days 500 --threshold 0.8 --out`. Needs no LLM |
| `npm run snapshot` | One text file with everything needed to diagnose a running agent from outside it |
| `npm run dashboard` | Dashboard only, against a fresh agent state |
| `npm run doctor` | What works, what is degraded, what blocks trading — with the fix and the URL for each. Exits non-zero only when something blocks trading |
| `npm run config:check` | Effective configuration and safety posture; never prints secrets |
| `npm run sources:check` | Live health probe of every configured source; non-zero exit if any is broken |
| `npm run ingest:once` | Single ingestion cycle with a summary |
| `npm run events:detect` | Ingest, then detect, cluster and verify events |
| `npm test` | Full test suite |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript |

## Configuration

Everything lives in `.env` (gitignored). `.env.example` documents every variable, and every
default is the safe option — an empty `.env` produces a system that cannot touch real money.

The safety-critical settings:

| Variable | Default | Meaning |
|---|---|---|
| `MODE` | `paper` | `backtest` \| `paper` \| `live` |
| `PAPER_TRADING` | `true` | Simulated portfolio |
| `LIVE_TRADING` | `false` | Real money — requires the full live configuration |
| `ALLOWED_ASSETS` | *(empty)* | The only instruments an order may ever target |
| `ALLOW_CRYPTO/OPTIONS/DERIVATIVES/MARGIN/SHORT_SELLING` | `false` | All off |
| `MAX_LEVERAGE` | `1` | >1 requires `ALLOW_MARGIN=true` |
| `PAPER_CAPITAL_EUR` | `10000` | Paper/backtest portfolio — sized so costs don't dominate |
| `LIVE_CAPITAL_EUR` | `300` | Real money at risk if live is ever enabled |
| `MAX_POSITION_PERCENT` | `20` | Per-position cap |
| `MAX_DAILY_LOSS_PERCENT` | `2` | Daily circuit breaker |
| `MAX_SINGLE_TRADE_RISK_PERCENT` | `1` | Risk budget per trade, drives position size |
| `MAX_CORRELATED_EXPOSURE_PERCENT` | `35` | Cap per correlation group |
| `MAX_TRADES_PER_DAY` | `10` | Runaway protection |
| `CONSECUTIVE_LOSS_COOLDOWN_MINUTES` | `120` | Forced pause after repeated losses |
| `MAX_QUOTE_STALENESS_SECONDS` | `120` | Past this, refuse to trade |
| `MIN_SIGNAL_SCORE` | `0.55` | Composite score a signal must reach to be considered at all |
| `ALLOW_MODEL_CHOSEN_ASSET` | `false` | Let the model pick the symbol when the event names no ticker |

### When the agent analyses but never trades

Two settings decide whether a good analysis can become an order at all, and both
are the usual reason a paper run fills its journal without ever filling a trade.

`MIN_SIGNAL_SCORE` is the bar. The dashboard funnel prints each refused score
against it, so start there. The right value is an empirical question rather than
a safety one — a paper run that never fills measures nothing — and `0.30`–`0.35`
is a reasonable place to begin. Lowering it weakens no other limit, and live mode
refuses to boot below `0.5`.

`ALLOW_MODEL_CHOSEN_ASSET` covers the other case. Detection extracts tickers from
the text, so a macro, policy or sanctions story carries none, and the analysis
has no symbol to price or trade however good it is. With this on, the model is
shown `WATCHLIST` + `ALLOWED_ASSETS` and its pick becomes the symbol — but only
if the pick is already in that list. The model selects from your universe; it
cannot extend it, and the Risk Engine still decides.

`npm run config:check` prints both, along with the universe in force.

`CONTACT_EMAIL` is required for any SEC request — the SEC rejects requests whose
`User-Agent` lacks a contact address, and the adapter refuses to send one without it rather
than risk your IP being blocked.

Without `ANTHROPIC_API_KEY` and `LLM_PROVIDER=anthropic` the system still ingests, detects
and verifies events; it simply produces no signals and places no orders. That is the
intended degraded mode, not a failure.

## APIs required

**None to start.** The default configuration uses only free, key-less official sources.

| Provider | Key | Free tier | Notes |
|---|---|---|---|
| SEC EDGAR | No | Free | 10 req/s; contact `User-Agent` mandatory |
| ECB Data Portal | No | Free | No published limit |
| Central bank / gov RSS | No | Free | Headlines and summaries only |
| FRED | Free key | 120 req/min | Point-in-time vintages — important for backtests |
| Alpaca | Yes | IEX feed, ~200 req/min | Paper worldwide; **live from Belgium unverified** |
| Finnhub | Yes | 60 calls/min | **Personal, non-commercial use only** |
| Alpha Vantage | Yes | **25 requests/day** | Historical fallback only |
| X (Twitter) | Yes | **None since Feb 2026** | Billed per post read; off by default |
| Anthropic | Yes | Usage-based | Only used to analyse detected events |

Limits, licences, endpoints and sources: [`docs/API_RESEARCH.md`](docs/API_RESEARCH.md).
Nothing was implemented against a guessed endpoint.

## Estimated costs

| Setup | Monthly |
|---|---|
| Official sources only (default) | **€0** |
| + FRED, Alpaca free, Finnhub free, Alpha Vantage free | €0 |
| + Claude API | usage-based — one call per *detected event*, not per document |
| + X ingestion | ~$0.005 per post read — trivially reaches four figures if unbounded |
| + Alpaca SIP consolidated data | paid |

The LLM is only invoked for events that already passed detection and verification, so cost
scales with genuine news volume rather than with feed chatter. Token usage and an estimated
cost are recorded per call and shown on the dashboard.

X is disabled by default with a daily read budget of zero. Also set a spending cap in the X
developer console; do not rely on this code alone to protect your card.

## Event detection and verification

`npm run events:detect` runs the rule layer: ingest, classify, cluster, verify.

Documents are classified by deterministic rules — SEC 8-K item codes and form types first
(an item code is the issuer's own statement of what a filing is about), keyword rules over
prose second, with lower weights. Anything unmatched stays `unclassified` rather than being
guessed at. Documents are then clustered into one event per real-world occurrence, and each
event gets a confidence that its claim is **true** — which is not the same as tradeable.

Every adjustment is recorded in `verification.reasons`:

```
[earnings] materiality=0.819 confidence=1.0 status=officially_confirmed
  why: confirmed by authoritative source(s): sec_edgar; base = best source reliability (0.97);
       +0.05 for 2 independent reports; +0.10 official confirmation

[m_and_a] materiality=0.636 confidence=0.4 status=contradicted
  why: denial language found in 1 document(s); base = 0.70; -0.35 contradiction detected
```

Three guarantees are structural, not advisory:

- Syndicated republication counts once — ten outlets running one wire story is one newsroom.
- A cluster of only social posts is capped at 0.35 and can never be marked confirmed.
- An abnormal price move is only scored once a claim is independently established, so a
  rumour cannot move a price and then have that move "confirm" the rumour.

## Signals and scoring

Claude receives the event, its verification record and market context, and returns a
**hypothesis** — direction, confidence, horizon, impact strength, catalyst, uncertainties,
plus explicit `likely_priced_in` and `manipulation_suspected` flags. The response is
constrained by a JSON schema and validated with Zod before anything reads it; a malformed
or refused response produces no signal rather than a neutral-looking one.

The hypothesis is one input among many. `src/strategy/scoring/scorer.ts` computes the final
score as a weighted sum over source quality, corroboration, event materiality, sentiment
strength, fundamental impact, price reaction, volume confirmation, volatility, macro
context, market regime, model confidence (weight capped at 0.16) and historical hit rate for
that event type — then applies multiplicative vetoes:

| Condition | Multiplier |
|---|---|
| Event contradicted | ×0.10 |
| Manipulation suspected | ×0.15 |
| Social-only sourcing | ×0.30 |
| Model says likely priced in | ×0.60 |
| Non-directional event | score capped at 0.20 |

Historical hit rate is held neutral below 30 observations, because a strategy that trusts a
3-for-4 record is fitting noise. Sentiment alone can never produce a trade: it is one
bounded term in a sum that a veto can zero.

An experimental Benner-cycle overlay exists in `src/strategy/signals/benner.ts` and is
**off unless explicitly enabled**. It is treated as a hypothesis to be tested, never as
truth — `npm run backtest -- --benner` runs the same strategy with and without it so you can
see the difference rather than assume one.

## Evidence

The backtester measures a *strategy*, and its only strategies are a moving-average crossover
and buy & hold — neither of which is what this project built. So nothing had ever measured
the premise underneath the whole thing: **is an SEC filing of a given type followed by an
abnormal move at all?**

```bash
npm run study -- --years 5 --benchmark SPY --out
```

Entry at the open of the session *after* the filing. Returns to +1, +5 and +20 sessions,
with the benchmark's move over the identical window subtracted. Two things it does that the
usual version of this does not:

- **Standard errors clustered by symbol.** 2,700 Form 4 filings across 40 tickers are not
  2,700 independent observations — one company's filings share that company's history, and
  at +20d their windows physically overlap. The naive t-statistic treats them as independent
  and is inflated, often threefold. Both are printed; only the clustered one can support a
  verdict, and a category carried by fewer than 10 distinct symbols gets none at all.
- **Net of costs.** A mean of +0.29% is not an edge when the round trip costs 0.30%. Every
  mean is shown alongside what survives the cost model for the position size this account
  would actually trade.
- **A threshold set for the number of tests actually run.** Forty categories at three
  horizons is over a hundred hypotheses in one run; at a 5% per-test cutoff, five or six
  cross it from noise before a single real effect exists. The first full run produced
  exactly seven "findings", every one with a t between 2.0 and 2.9 — the signature of a
  threshold crossed by chance. Benjamini-Hochberg control at q=0.10 across the whole run
  replaces the per-test cutoff, and the family it corrects over is every test that met the
  sample and cluster bars, not just the ones that looked good. Selecting the family on the
  outcome is the same bias one level up.

Under that standard, the first 40-symbol run reports **no findings at all**: 7 categories
crossed |t|=1.96, none survived. That is the honest result, and it is the one the agent acts
on.

`--out` writes the result to `data/evidence.json`, which the agent reads at startup. What it
does with it is deliberately one-sided:

- A category measured drifting **against** a long — real sample, real spread of symbols —
  is **refused**, before the LLM call rather than after it. There is no argument for buying
  into a measured adverse drift.
- A category measured drifting **for** a long licenses nothing. It is one sample of one
  regime, tested alongside a dozen other categories, where one crossing |t|=1.96 by chance
  is expected. Support is recorded and displayed; it never lowers a gate.

No file means no opinion, and the agent behaves exactly as it did before one existed.

## Risk engine

`src/risk/engine.ts` reads no LLM output beyond a single numeric score. It first evaluates
halting conditions for the whole session, then per-order checks:

**Halts:** daily loss limit, max trades per day, consecutive-loss cooldown.

**Per order:** trading mode, asset allowlist, direction permitted (shorting off by default),
price freshness, price sanity, minimum score, actionable direction, duplicate order,
position sizeable, minimum notional, max position, max portfolio exposure, max correlated
exposure, sufficient cash.

Position size comes from the risk budget and a volatility-derived stop distance, not from
the model's enthusiasm. Every rejection is recorded with its reason and appears in the
journal and on the dashboard — a signal that was refused is as informative as one that
traded.

## Paper trading

```bash
npm run paper                 # continuous, dashboard on http://127.0.0.1:3000
npm run paper -- --once       # a single cycle, then exit
npm run paper -- --no-server  # no dashboard
npm run paper -- --fresh      # ignore saved state and start a new run
```

Each cycle marks open positions to market, ingests, detects and verifies events, asks the
model about the ones that clear the gate, scores them, runs the Risk Engine, and places
paper orders through `PaperBroker`. Fills go through the same cost model as the backtester:
€1 commission per order, 2.5 bps half-spread, 2.5 bps slippage. Losses and drawdowns are
displayed as prominently as gains.

Every decision is appended to `data/decisions.jsonl` — including decisions that produced no
order. A journal of executed trades only is survivorship-biased and cannot answer whether
the signals work.

State persists to `data/agent-state.json` and is checkpointed after every cycle, so a
restart resumes the same experiment: portfolio, drawdown history, counters, and the order
ids that duplicate protection depends on. Without it a run could never accumulate more
history than its longest uptime, which for a question needing months of observations is the
difference between a track record and a demo.

The state file is **refused, never reconciled**, when the mode, currency or starting capital
does not match the running configuration — those numbers describe a different experiment,
and adopting them would produce a P&L that is arithmetic on unrelated figures. Use
`--fresh` to start over without touching the saved run.

Paper runs at `PAPER_CAPITAL_EUR=10000` while `LIVE_CAPITAL_EUR=300` stays the real-money
target. The reason is measurement: at a few hundred euros, a 1% per-trade risk budget is €3,
most of which commission and spread consume, so results would measure costs rather than
signal quality. More capital per trade improves the signal-to-cost ratio but not the number
of observations — judging whether the signals actually work still needs years of returns or
hundreds of trades. See [`docs/SPEC_ADAPTATIONS.md`](docs/SPEC_ADAPTATIONS.md) §6.

## Backtesting

```bash
npm run backtest -- --symbol AAPL --years 5
npm run backtest -- --fixture            # synthetic bars, no API key needed
npm run backtest -- --walk-forward       # train/test windows, not one fitted period
npm run backtest -- --benner             # with vs without the Benner overlay
```

The engine is event-driven and structurally anti-look-ahead: a decision made on bar *i* is
filled at the **open of bar _i+1_**, never at the close it was decided on. Costs are applied
to every fill. Reported metrics: total and annualised return, volatility, Sharpe, Sortino,
maximum drawdown, win rate, profit factor, average trade, number of trades, total costs, and
comparison against buy & hold over the *same* period with the same warm-up.

It also prints a Sharpe t-statistic (Sharpe × √years) and warns when the trade count is too
low to support a conclusion:

```
  number of trades       9
  buy & hold             -34.01%
  excess over buy & hold 31.289%
  Sharpe t-stat          -1.348

  !! Only 9 trades — far too few to support any conclusion about the strategy.
```

`--fixture` bars are a synthetic random walk. They exercise the machinery; they say nothing
about any strategy. Walk-forward validation trains on one window and tests on the next,
carrying capital forward, so an in-sample fit cannot be reported as a result.

## Dashboard

`npm run dashboard` (or `npm run paper`) serves a server-rendered page on
`http://127.0.0.1:3000` — bound to localhost, no build step, no external assets.

It shows the portfolio (cash, positions, unrealised and realised P&L, drawdown), recent
signals with their scores, detected events with verification status, orders with fills and
rejections, and system health per data source.

The AI reasoning panel shows the model's **summary, factors used, sources, uncertainties and
justification** — not private chain-of-thought. All responses pass through the redaction
chokepoint before rendering.

The API is read-only. `POST /api/order`, `/api/orders/place`, `/api/trade` and `/api/cancel`
return 404 because no such endpoint exists; there is a test asserting this. The dashboard
observes, it does not act.

### Reaching it from elsewhere

Read-only is not the same as safe to publish: the page shows a live portfolio, its open
positions and every signal.

Preferred — publish nothing, tunnel instead:

```bash
ssh -N -L 3000:127.0.0.1:3000 you@your-server
```

Otherwise set `DASHBOARD_HOST` and a password:

```bash
DASHBOARD_HOST=0.0.0.0
DASHBOARD_USER=you
DASHBOARD_PASSWORD=<at least 12 characters>
```

Startup **refuses** a non-loopback host without a password, or one under 12 characters, and
there is no override flag — an override becomes the thing everyone sets. Authentication is
HTTP Basic, checked before anything is read or rendered, and it covers the JSON API as well
as the page: protecting only the HTML would be theatre. Unknown paths answer `401` rather
than `404` before authentication, so the surface cannot be mapped anonymously.

Basic auth over plain HTTP is base64, which is encoding rather than encryption — put it
behind HTTPS. Deployment recipes, including Docker and systemd:
[`docs/DEPLOY.md`](docs/DEPLOY.md).

## Security

- Secrets only ever come from environment variables. `.env` is gitignored.
- `src/core/redact.ts` is the single scrubbing chokepoint: registered secret literals,
  credential-shaped keys, and credential-bearing URL parameters are removed before anything
  reaches a log, an API response, or the dashboard. There is a test asserting an API key
  never appears in rendered HTML.
- No credential is ever placed in an LLM prompt.
- Untrusted document text is fenced in `<untrusted_document>` blocks with fence markers
  stripped from the content, and the system prompt is the only instruction channel. Model
  output is schema-validated before use.
- Broker credentials, when you create them, should carry trading permissions only.
- The startup validator refuses to boot an unsafe live configuration.
- The dashboard binds to `127.0.0.1`, not `0.0.0.0`.

## Going live

An Alpaca adapter exists and speaks both endpoints:

| Endpoint | Base URL | Money | Gate |
|---|---|---|---|
| `paper` | `paper-api.alpaca.markets` | None | API keys only |
| `live` | `api.alpaca.markets` | **Real** | Full live configuration below |

**Use the paper endpoint first.** It is the same API and the same code with nothing at
stake, and it is the only honest way to find out whether the request shapes in this
repository are correct — see [Known limitations](#known-limitations), because they have
never been sent to Alpaca from here.

Live requires **all** of:

```bash
MODE=live
LIVE_TRADING=true
PAPER_TRADING=false
LIVE_TRADING_CONFIRMATION=I_UNDERSTAND_REAL_MONEY_RISK
ALLOWED_ASSETS=AAPL,MSFT          # non-empty
```

plus risk limits within sane bounds. Any missing piece aborts startup, and the gate is
checked twice: once by the config loader, once by the adapter constructor.

Even then, the `BrokerAdapter` interface exposes only `getAccount`, `getPositions`,
`getQuote`, `placeOrder`, `cancelOrder` and `getOrderStatus`. Alpaca's API has endpoints for
transfers, ACH relationships and account configuration; none is reachable from this code,
and a test asserts the adapter has no such method. The bot cannot move money because there
is no method through which to do so.

Three further properties of the live path:

- The asset allowlist is enforced **in the adapter**, not only in the Risk Engine. A symbol
  outside it is refused before any request leaves the process.
- Order submission is **never retried automatically**. A timeout does not mean the order was
  rejected, and a blind retry is how one decision becomes two positions. Every order carries
  a `client_order_id`, which Alpaca rejects on duplicate — so a *deliberate* retry is safe.
- Orders are `time_in_force: day`. An order that outlives the session it was reasoned about
  is an order nobody decided to place today.

**Do not enable live trading because the code exists.** It has never been run against
Alpaca, and no strategy in this repository has been backtested on real market data. Those
are two separate reasons to wait, and neither is fixed by adding credentials.

## Known limitations

- **No adapter has been executed against its live API.** The build environment blocks
  outbound HTTPS to these hosts, so adapters were implemented against documentation and
  tested against recorded fixtures. Run `npm run sources:check` first; expect to fix at
  least one payload mismatch.
- **No live LLM call has been made either** — the Anthropic provider is tested against a
  stubbed `messages.create`. The request shape follows current documentation
  (`output_config.format`, no `temperature`), but verify it with a real key before trusting a
  run.
- **The Alpaca broker adapter has never sent a request to Alpaca.** Endpoints and payloads
  come from Alpaca's published Trading API documentation and are tested against recorded
  fixtures. Run it against the `paper` endpoint and read every response before considering
  the `live` one.
- **The strategy has not been shown to work.** No backtest in this repository used real
  market data. The numbers you can produce today measure the machinery, not an edge.
- Alpaca's free feed is IEX-only — a single venue, not the consolidated tape. Volume
  signals built on it measure that venue.
- Finnhub's free tier forbids commercial use. Alpha Vantage's free tier is 25 requests/day.
- The X daily budget is per-process and in memory: two instances double the spend, and a
  restart resets it.
- Event classification is rule-based: precise on SEC filings (item codes), fuzzy on prose.
- The entity registry is a curated list of ~30 companies, countries and institutions, not
  open-world entity recognition. Unlisted companies resolve to nothing.
- Contradiction detection is keyword-based: it spots denial language, it cannot tell which
  claim is denied.
- Correlation groups are estimated from past returns by `npm run correlations`, over one
  window. Correlations rise toward one in a sell-off — exactly when the limit matters — so
  the groups are a floor on how concentrated the book is, not the whole of it. Without a
  run, the fallback is a hand-maintained sector map covering a dozen companies.
- No database. State is a JSON file and the journal an append-only JSONL file; both survive
  restarts, but neither supports concurrent writers. Two agents sharing a `data/` directory
  will corrupt each other's history.
- Reaction time is seconds-to-minutes. This system does not compete on speed.

## Risks

Read [`docs/RISKS.md`](docs/RISKS.md) before considering live trading. Summary: the strategy
has not been shown to work and may not; €300 is dominated by costs; free data is not
market-wide; LLMs produce confident analyses of events they have misunderstood; and Belgian
tax treatment of frequent algorithmic trading may differ from ordinary investing.

## Extending

[`docs/EXTENDING.md`](docs/EXTENDING.md) covers adding a source, a broker or a strategy.
[`docs/SPEC_ADAPTATIONS.md`](docs/SPEC_ADAPTATIONS.md) records where this implementation
departs from the original brief, and why.
The short version: verify the API before writing code, implement the relevant interface,
use `HttpClient`, stamp honest freshness metadata, fail loudly, and test against fixtures.

## Development phases

| Phase | Scope | Status |
|---|---|---|
| 0 | Repository audit, stack decision, API verification | **Done** |
| 1 | Data adapters, normalisation, deduplication, health | **Done** |
| 2 | Event detection and source verification | **Done** |
| 3 | LLM analysis and structured signals | **Done** |
| 4 | Risk engine | **Done** |
| 5 | Paper broker, portfolio, decision journal | **Done** |
| 6 | Backtesting and walk-forward validation | **Done** |
| 7 | Dashboard and read-only API | **Done** |
| 8 | Continuous paper trading agent | **Done** |
| 9 | Live Alpaca adapter behind the safety gate | **Built, unproven, off by default** |

Phase 0 findings: [`docs/PHASE0_AUDIT.md`](docs/PHASE0_AUDIT.md).

---

## The point of this project

Not to build a bot that always wins. To build a system that can answer honestly:

> **Does this information create a statistically exploitable edge after fees, slippage and
> risk?**

If the answer is uncertain, the answer is HOLD. Capital preservation ranks above trade
count.
