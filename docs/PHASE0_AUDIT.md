# Phase 0 — repository audit and stack decision

## What was in the repository

The audit found a repository that was, in practice, empty:

```
SwiftyRX/
├── .git/          single commit, "Initial commit"
└── README.md      one line: "# SwiftyRX"
```

No `package.json`, no source, no CI, no infrastructure, no environment files, no
dependencies. Branches: `main` and `claude/ai-market-agent-xifvq9`.

**Consequence: nothing to preserve, nothing to break.** The instruction "do not break the
existing project" is satisfied trivially, and the stack could be chosen on merit rather
than inherited.

The repository name `SwiftyRX` is a leftover from repository creation and carries no
earlier intent — this is a greenfield project, confirmed by the owner. The package is named
`ai-market-agent`; renaming the GitHub repository to match is a one-click change in the
repository settings and is the owner's call, not something this branch should force.

The brief for this project was drafted with an LLM's help and is treated as a specification
to *adapt*, not to transcribe. Where following it literally would produce a worse or
internally inconsistent system, the deviation and its reasoning are recorded in
[`SPEC_ADAPTATIONS.md`](./SPEC_ADAPTATIONS.md).

## Environment as found

| Component | Version |
|---|---|
| Node.js | 22.22.2 |
| npm | 10.9.7 (pnpm 10.33.0 and yarn 1.22.22 also present) |
| Python | 3.11.15 |
| Docker | 29.3.1 |
| PostgreSQL client | 16.13 |

## Branch

Work is on **`claude/ai-market-agent-xifvq9`**, not `feature/ai-market-agent` as the brief
requested. This session is bound to that branch by its operating configuration and cannot
push elsewhere. The branch name is the only deviation; rename or rebase onto
`feature/ai-market-agent` at any time if you prefer that convention.

## Stack decision

**TypeScript on Node 22, single package, npm.**

Reasoning:

- **TypeScript over Python.** The deliverable criteria specify `npm run dev`,
  `npm run paper`, `npm run backtest`, `npm run test`, `npm run lint` — a Node project.
  More substantively, this system is I/O-bound (many concurrent HTTP sources, streaming,
  a web dashboard), which is Node's strength, and the type system is genuinely valuable
  for financial domain modelling: making `Freshness` a mandatory field on every price
  means "price without provenance" fails to compile rather than failing in production.
  Python would win if this were numerically heavy; a numerical component (the backtest
  statistics) can still be added in Python later behind a process boundary if it earns it.
- **Single package, not a monorepo.** The brief sketches `apps/api`, `apps/worker`,
  `apps/dashboard`. Those arrive in Phases 7–8. Setting up workspace tooling now, for
  packages that do not exist, is overhead with no user. The `src/` layout already matches
  the requested architecture, and npm workspaces can be introduced when the dashboard
  actually needs its own dependency tree.
- **Four runtime dependencies:** `zod` (config and payload validation), `pino` (structured
  logging), `fast-xml-parser` (RSS/Atom). Node 22's built-in `fetch` replaces axios; its
  built-in `process.loadEnvFile` replaces dotenv. Fewer dependencies is fewer supply-chain
  surfaces in a program that will eventually hold API credentials.
- **PostgreSQL + Redis via `docker-compose.yml`**, not yet wired. Phase 1 ingestion runs
  entirely in memory. Persistence lands with the decision journal in Phase 2.

## Architecture as built

Mapped onto the requested layout, with the deviations noted:

```
src/
├── config/           env schema + safety invariants (the live-trading gate)
├── core/             http, rate limiting, circuit breaker, clock, cache, redaction
├── domain/           shared types: documents, quotes, bars, freshness, health
├── ingestion/
│   ├── news/         generic RSS/Atom adapter
│   ├── official_sources/  SEC EDGAR
│   ├── macro/        FRED (vintage-aware), ECB Data Portal
│   ├── market_data/  Alpaca, Finnhub, Alpha Vantage, synthetic fixture
│   ├── social/       X — disabled by default, budget-capped
│   ├── normalize.ts  raw payload -> NormalizedDocument
│   ├── dedup.ts      exact drop / near-duplicate link
│   └── pipeline.ts   wiring + one ingestion cycle
├── monitoring/       counters and latency histograms
scripts/              CLI entry points
tests/                107 tests, zero network access
docs/                 this file, API research, architecture, risks
```

Deviations from the brief's tree, each deliberate:

- `src/core/` added — the brief has no home for cross-cutting infrastructure (HTTP,
  rate limiting, redaction), and burying it inside `ingestion/` would make it unavailable
  to `execution/` later.
- `apps/` omitted until Phase 7 (see above).
- `intelligence/`, `strategy/`, `risk/`, `execution/`, `backtesting/`, `database/` not
  created. Empty directories full of placeholder interfaces would suggest progress that
  does not exist. They arrive with their phases.

## Technical and financial risks identified

Detailed in [`RISKS.md`](./RISKS.md). The four that most shape the design:

1. **Free-tier data is not market-wide.** Alpaca's free plan is IEX-only — a single venue.
   Volume-based signals built on it measure that venue, not the market.
2. **Licence terms, not technical limits, are the binding constraint.** Finnhub's free
   tier prohibits commercial use outright. No code change makes that data commercially
   usable.
3. **X reads are billed per post since February 2026.** A naive polling loop is a
   four-figure monthly bill. Hence a hard daily budget defaulting to zero.
4. **€300 of capital is dominated by costs.** At a typical per-trade commission and spread,
   frequent trading of a €300 account loses to fees regardless of signal quality. Phase 6
   must report net-of-cost results, and the honest answer may well be that the edge does
   not survive them.

## Verification status

- 107 tests pass; typecheck and lint are clean.
- **No live API call has been verified from this environment.** Outbound HTTPS to
  `sec.gov`, `ecb.europa.eu`, `data-api.ecb.europa.eu` and others is blocked at the network
  layer here. Adapters are implemented against provider documentation and exercised against
  recorded fixtures. `npm run ingest:once` runs end to end and degrades correctly — every
  feed returned 403 from the sandbox proxy, each failure was isolated and logged, and the
  cycle completed rather than crashing, which is the behaviour that matters.
- **First thing to do on your machine: `npm run sources:check`.** That is what will tell
  you which adapters genuinely work from Belgium.
