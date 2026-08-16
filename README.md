# AI Market Agent

An experimental market intelligence system: it ingests official filings, central bank
releases, macro data and market prices, and is being built toward analysing them with an
LLM to produce **BUY / SELL / HOLD / WATCH** signals with confidence scores, reasoning and
sources.

> **Status: Phase 2 of 9.** Data ingestion, event detection and source verification work.
> There are no signals, no LLM calls, no portfolio and no broker connection yet. `npm run paper` and `npm run backtest` exist and
> deliberately refuse to run — see [Development phases](#development-phases).

> **No real money is at risk.** The system defaults to `MODE=paper` with `LIVE_TRADING=false`,
> and live trading requires an explicit, multi-part configuration that the process validates
> at startup. There is no code path anywhere in this repository to withdraw funds, transfer
> money, change bank details or open an account — and there must never be one.

---

## Contents

1. [Architecture](#architecture)
2. [Installation](#installation)
3. [Configuration](#configuration)
4. [APIs required](#apis-required)
5. [Estimated costs](#estimated-costs)
6. [Paper trading](#paper-trading)
7. [Backtesting](#backtesting)
8. [Dashboard](#dashboard)
9. [Security](#security)
10. [Going live](#going-live)
11. [Known limitations](#known-limitations)
12. [Risks](#risks)
13. [Adding a source / broker / strategy](#extending)
14. [Development phases](#development-phases)

---

## Architecture

```
DATA SOURCES → INGESTION → NORMALISATION → DEDUPLICATION → EVENT DETECTION
    → SOURCE VERIFICATION → MARKET CONTEXT → LLM ANALYSIS → SIGNAL SCORING
    → RISK ENGINE → PAPER ORDER → PORTFOLIO → MONITORING
```

Phases 1–2 implement everything up to source verification. Full detail in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

Four principles shape everything:

- **The Risk Engine is independent of the LLM.** The model proposes; separate code with its
  own inputs disposes, and can veto any signal regardless of the model's confidence.
- **Missing or stale data means DO NOT TRADE.** Every price carries provenance and an age.
  A quote past its staleness limit raises an error instead of being served with a warning.
- **No source is trusted on its own.** Every document enters as `unverified`, including SEC
  filings. Confidence comes from independent corroboration and official confirmation, with
  every adjustment recorded. Ten outlets running one wire story count as one report, and a
  cluster of social posts is capped no matter how many accounts repeat it.
- **Failures are loud.** Adapters throw rather than returning empty results, because an
  empty array reads downstream as "nothing happened".

```
src/
├── config/      environment schema + live-trading safety gate
├── core/        http, rate limiting, circuit breaker, clock, cache, secret redaction
├── domain/      shared types (documents, quotes, bars, freshness, health)
├── ingestion/   news · official_sources · macro · market_data · social
├── intelligence/ entity_resolution · event_detector · verification
└── monitoring/  counters and latency histograms
scripts/         CLI entry points
tests/           149 tests, zero network access
docs/            audit, API research, architecture, risks, spec adaptations
```

## Installation

Requires **Node.js ≥ 20.12** (developed on 22). Docker is not needed yet.

```bash
git clone <this repo>
cd ai-market-agent
npm install
cp .env.example .env      # works as-is; no credentials needed to start
npm test                  # 149 tests, no network required
npm run config:check      # shows the effective safety posture
npm run sources:check     # probes every configured data source — start here
npm run ingest:once       # one ingestion cycle
npm run events:detect     # ingest, then detect and verify events
npm run dev               # continuous ingestion loop
```

Optional local infrastructure (nothing persists to it yet — Phase 3 onward):

```bash
docker compose up -d      # PostgreSQL + Redis
```

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Continuous ingestion loop |
| `npm run config:check` | Effective configuration and safety posture; never prints secrets |
| `npm run sources:check` | Live health probe of every configured source; non-zero exit if any is broken |
| `npm run ingest:once` | Single ingestion cycle with a summary |
| `npm run events:detect` | Ingest, then detect, cluster and verify events |
| `npm test` | Full test suite |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript |
| `npm run paper` | **Refuses to run** — Phase 5 |
| `npm run backtest` | **Refuses to run** — Phase 6 |

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
| `MAX_QUOTE_STALENESS_SECONDS` | `120` | Past this, refuse to trade |

`CONTACT_EMAIL` is required for any SEC request — the SEC rejects requests whose
`User-Agent` lacks a contact address, and the adapter refuses to send one without it rather
than risk your IP being blocked.

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

Limits, licences, endpoints and sources: [`docs/API_RESEARCH.md`](docs/API_RESEARCH.md).
Nothing was implemented against a guessed endpoint.

## Estimated costs

| Setup | Monthly |
|---|---|
| Official sources only (default) | **€0** |
| + FRED, Alpaca free, Finnhub free, Alpha Vantage free | €0 |
| + Claude API (Phase 3) | usage-based |
| + X ingestion | ~$0.005 per post read — trivially reaches four figures if unbounded |
| + Alpaca SIP consolidated data | paid |

X is disabled by default with a daily read budget of zero. Also set a spending cap in the X
developer console; do not rely on this code alone to protect your card.

## Event detection and verification

`npm run events:detect` runs the full built pipeline: ingest, classify, cluster, verify.

Documents are classified by deterministic rules — SEC 8-K item codes and form types first
(an item code is the issuer's own statement of what a filing is about), keyword rules over
prose second, with lower weights. Anything unmatched stays `unclassified` rather than being
guessed at. Documents are then clustered into one event per real-world occurrence, and each
event gets a confidence that its claim is **true** — which is not the same as tradeable.

Every adjustment is recorded in `verification.reasons`, so an event's confidence can always
be explained:

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

## Paper trading

Not yet implemented (Phase 5). When it lands: a virtual portfolio with drawdowns and losses
displayed as prominently as gains.

Paper runs at `PAPER_CAPITAL_EUR=10000` while `LIVE_CAPITAL_EUR=300` stays the real-money
target. The reason is measurement: at a few hundred euros, a 1% per-trade risk budget is €3,
most of which commission and spread consume, so results would measure costs rather than
signal quality. Note that more capital per trade improves the signal-to-cost ratio but not
the number of observations — judging whether the signals actually work still needs years of
returns or hundreds of trades. See [`docs/SPEC_ADAPTATIONS.md`](docs/SPEC_ADAPTATIONS.md) §6.

## Backtesting

Not yet implemented (Phase 6). When it lands it will report total and annualised return,
volatility, Sharpe, Sortino, maximum drawdown, win rate, profit factor, average trade, trade
count, transaction costs, slippage, and comparison against buy & hold — with walk-forward
validation (train 2020–22 → test 2023, train 2021–23 → test 2024, and so on) rather than
fitting and testing on the same period.

Phase 1 already lays the anti-look-ahead groundwork: every data point carries an as-of
timestamp and delay class, FRED observations can be queried by vintage, and all time flows
through an injectable `Clock` so a backtest cannot read the wall clock by accident.

## Dashboard

Not yet implemented (Phase 7): portfolio, signals, events, orders, system health, and
structured AI reasoning. The reasoning panel will show summary, factors used, sources,
uncertainties and a synthetic justification — not private chain-of-thought.

## Security

- Secrets only ever come from environment variables. `.env` is gitignored.
- `src/core/redact.ts` is the single scrubbing chokepoint: registered secret literals,
  credential-shaped keys, and credential-bearing URL parameters are removed before anything
  reaches a log. Credentials are never placed in an LLM prompt.
- Broker credentials, when you create them, should carry trading permissions only.
- The startup validator refuses to boot an unsafe live configuration.

## Going live

Not available yet, and not recommended until Phases 2–8 are complete and paper results have
been evaluated honestly. When it is possible it will require **all** of:

```bash
MODE=live
LIVE_TRADING=true
PAPER_TRADING=false
LIVE_TRADING_CONFIRMATION=I_UNDERSTAND_REAL_MONEY_RISK
ALLOWED_ASSETS=AAPL,MSFT          # non-empty
```

plus risk limits within sane bounds. Any missing piece aborts startup. Even then, the bot
can only place, cancel and query orders on allow-listed instruments — it cannot move money.

## Known limitations

- **No adapter has been executed against its live API.** The build environment blocks
  outbound HTTPS to these hosts, so adapters were implemented against documentation and
  tested against recorded fixtures. Run `npm run sources:check` first; expect to fix at
  least one payload mismatch.
- Alpaca's free feed is IEX-only — a single venue, not the consolidated tape. Volume
  signals built on it measure that venue.
- Finnhub's free tier forbids commercial use. Alpha Vantage's free tier is 25 requests/day.
- The X daily budget is per-process and in memory: two instances double the spend, and a
  restart resets it.
- Event classification is rule-based: precise on SEC filings (item codes), fuzzy on prose.
  Unmatched documents are `unclassified` rather than guessed at.
- The entity registry is a curated list of ~30 companies, countries and institutions, not
  open-world entity recognition. Unlisted companies resolve to nothing.
- Contradiction detection is keyword-based: it spots denial language, it cannot tell which
  claim is denied. Matches flag an event for review rather than resolving the disagreement.
- No persistence — Phase 1 runs entirely in memory.
- Reaction time is seconds-to-minutes. This system does not compete on speed.

## Risks

Read [`docs/RISKS.md`](docs/RISKS.md) before considering live trading. Summary: the strategy
has not been shown to work and may not; €300 is dominated by costs; free data is not
market-wide; LLMs produce confident analyses of events they have misunderstood; and Belgian
tax treatment of frequent algorithmic trading may differ from ordinary investing.

## Extending

[`docs/EXTENDING.md`](docs/EXTENDING.md) covers adding a source, a broker or a strategy.
[`docs/SPEC_ADAPTATIONS.md`](docs/SPEC_ADAPTATIONS.md) records where this implementation
departs from the original brief, and why — including the open question of whether a €300
paper portfolio can produce statistically meaningful results.
The short version: verify the API before writing code, implement the relevant interface,
use `HttpClient`, stamp honest freshness metadata, fail loudly, and test against fixtures.

## Development phases

| Phase | Scope | Status |
|---|---|---|
| 0 | Repository audit, stack decision, API verification | **Done** |
| 1 | Data adapters, normalisation, deduplication, health | **Done** |
| 2 | Event detection and source verification | **Done** |
| 3 | LLM analysis and structured signals | Not started |
| 4 | Risk engine | Not started |
| 5 | Paper broker and €300 portfolio | Not started |
| 6 | Backtesting and walk-forward validation | Not started |
| 7 | Dashboard | Not started |
| 8 | Continuous paper trading | Not started |
| 9 | Live — only after honest evaluation, never automatic | Not started |

Phase 0 findings: [`docs/PHASE0_AUDIT.md`](docs/PHASE0_AUDIT.md).

---

## The point of this project

Not to build a bot that always wins. To build a system that can answer honestly:

> **Does this information create a statistically exploitable edge after fees, slippage and
> risk?**

If the answer is uncertain, the answer is HOLD. Capital preservation ranks above trade
count.
