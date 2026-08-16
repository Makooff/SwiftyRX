# AI Market Agent

An experimental market intelligence system: it ingests official filings, central bank
releases, macro data and market prices, and is being built toward analysing them with an
LLM to produce **BUY / SELL / HOLD / WATCH** signals with confidence scores, reasoning and
sources.

> **Status: Phase 1 of 9.** Data ingestion works. There are no signals, no LLM calls, no
> portfolio and no broker connection yet. `npm run paper` and `npm run backtest` exist and
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

Phase 1 implements the first three stages. Full detail in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

Four principles shape everything:

- **The Risk Engine is independent of the LLM.** The model proposes; separate code with its
  own inputs disposes, and can veto any signal regardless of the model's confidence.
- **Missing or stale data means DO NOT TRADE.** Every price carries provenance and an age.
  A quote past its staleness limit raises an error instead of being served with a warning.
- **No source is trusted on its own.** Every document enters as `unverified`, including SEC
  filings. A social post can never trigger an order — it is a lead to check against an
  official source.
- **Failures are loud.** Adapters throw rather than returning empty results, because an
  empty array reads downstream as "nothing happened".

```
src/
├── config/      environment schema + live-trading safety gate
├── core/        http, rate limiting, circuit breaker, clock, cache, secret redaction
├── domain/      shared types (documents, quotes, bars, freshness, health)
├── ingestion/   news · official_sources · macro · market_data · social
└── monitoring/  counters and latency histograms
scripts/         CLI entry points
tests/           107 tests, zero network access
docs/            audit, API research, architecture, risks, extension guide
```

## Installation

Requires **Node.js ≥ 20.12** (developed on 22). Docker is optional until Phase 2.

```bash
git clone <this repo>
cd ai-market-agent
npm install
cp .env.example .env      # works as-is; no credentials needed to start
npm test                  # 107 tests, no network required
npm run config:check      # shows the effective safety posture
npm run sources:check     # probes every configured data source — start here
npm run ingest:once       # one ingestion cycle
npm run dev               # continuous ingestion loop
```

Optional local infrastructure (not used until Phase 2):

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
| `INITIAL_CAPITAL_EUR` | `300` | Virtual portfolio size |
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

## Paper trading

Not yet implemented (Phase 5). When it lands: a €300 virtual portfolio, configurable, with
drawdowns and losses displayed as prominently as gains. There will be no attempt to make
€300 look like it compounds quickly — the point is to measure whether the signals work, and
a €300 account is dominated by transaction costs long before strategy quality matters.

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
- Deduplication matches text, not meaning. Same-event clustering is Phase 2.
- No persistence — Phase 1 runs entirely in memory.
- Reaction time is seconds-to-minutes. This system does not compete on speed.

## Risks

Read [`docs/RISKS.md`](docs/RISKS.md) before considering live trading. Summary: the strategy
has not been shown to work and may not; €300 is dominated by costs; free data is not
market-wide; LLMs produce confident analyses of events they have misunderstood; and Belgian
tax treatment of frequent algorithmic trading may differ from ordinary investing.

## Extending

[`docs/EXTENDING.md`](docs/EXTENDING.md) covers adding a source, a broker or a strategy.
The short version: verify the API before writing code, implement the relevant interface,
use `HttpClient`, stamp honest freshness metadata, fail loudly, and test against fixtures.

## Development phases

| Phase | Scope | Status |
|---|---|---|
| 0 | Repository audit, stack decision, API verification | **Done** |
| 1 | Data adapters, normalisation, deduplication, health | **Done** |
| 2 | Event detection and source verification | Not started |
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
