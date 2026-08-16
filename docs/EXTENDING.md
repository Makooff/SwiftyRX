# Extending the system

## Adding a new data source

### An RSS/Atom feed (no code required)

Add an entry to `OFFICIAL_FEEDS` or `NEWS_FEEDS` in `src/ingestion/feeds.ts`:

```ts
{
  id: 'boe_news',                                  // stable, unique
  name: 'Bank of England — News',
  url: 'https://www.bankofengland.co.uk/rss/news',
  tier: 'official',                                // drives the reliability prior
  category: 'official',
  jurisdiction: 'UK',
  licenceNote: 'Check the publisher terms before storing full text.',
}
```

Then enable it with `ENABLED_SOURCES=boe_news,...` and confirm it responds:

```bash
npm run sources:check
```

Pick `tier` honestly. It sets the prior the verification stage starts from, and inflating a
blog to `official` corrupts every downstream decision that reads it.

### A new API-backed source

1. **Verify the API first.** Confirm the endpoint, auth, rate limit, cost, licence terms
   and availability from your jurisdiction. Add a section to `docs/API_RESEARCH.md` with
   links. Never implement against a guessed endpoint.
2. **Implement `DocumentSource`, `MarketDataSource` or `MacroSource`** from
   `src/ingestion/types.ts`.
3. **Use `HttpClient`** rather than calling `fetch` directly — it provides the rate
   limiting, retries, circuit breaking and stats the health page depends on. Configure
   `TokenBucket` from the provider's *published* limit, with headroom.
4. **Register secrets** with `registerSecret()` so they are scrubbed from logs.
5. **Stamp `Freshness` on every price**: `asOf`, `retrievedAt`, and an honest `delayClass`.
   If a feed is single-venue or delayed, do not label it `realtime`.
6. **Fail loudly on missing data.** Throw rather than returning `[]` when data was expected
   but the plan does not include it — an empty array is read downstream as "nothing
   happened".
7. **Implement `health()` so it never throws.** Return `unavailable` with a detail message.
   If probing costs money or quota, report configuration state instead and say so.
8. **Wire it into `buildIngestionStack()`** in `src/ingestion/pipeline.ts`.
9. **Test it against fixtures** in `tests/adapters.test.ts` using `createFakeFetch`. No test
   may touch the network.

Worked examples: `src/ingestion/macro/ecb.ts` (no credentials, CSV),
`src/ingestion/market_data/alpaca.ts` (header auth, JSON),
`src/ingestion/social/x.ts` (metered, budget-capped, low-trust).

## Adding an entity or a classification rule

**A company, country or institution** — add an entry to
`src/intelligence/entity_resolution/registry.ts`:

```ts
{ id: 'SAP', type: 'company', name: 'SAP SE', aliases: ['SAP'],
  sector: 'technology', country: 'DE', tickers: ['SAP'] }
```

Aliases are matched case-insensitively on word boundaries, so keep them distinctive. A
two-letter alias, or one that is also an ordinary English word, will fire on unrelated prose
and attribute events to the wrong issuer. Precision matters far more than recall here: a
miss leaves an event unattributed and harmless, a false match propagates into a signal about
the wrong asset.

**A classification rule** — add to `KEYWORD_RULES` in
`src/intelligence/event_detector/rules.ts`:

```ts
{ id: 'kw:buyback', type: 'guidance', weight: 0.6,
  pattern: /\b(share (?:buyback|repurchase) programme?)\b/i }
```

Weights accumulate per event type, so several corroborating rules beat one strong outlier.
Keep prose rules below filing rules: an SEC item code states what a filing is; a keyword
only suggests what a sentence is about. Every rule needs an `id`, because it appears in
`classification.matched` and is how a classification gets audited later.

**A new event type** — extend `EventType` and give it an entry in
`EVENT_TYPE_MATERIALITY`. TypeScript will point out every table needing an update.

## Adding a new broker

Brokers implement:

```ts
interface BrokerAdapter {
  getAccount(): Promise<Account>;
  getPositions(): Promise<Position[]>;
  getQuote(symbol: string): Promise<Quote>;
  placeOrder(order: OrderRequest): Promise<Order>;
  cancelOrder(orderId: string): Promise<void>;
  getOrderStatus(orderId: string): Promise<Order>;
}
```

Non-negotiable constraints:

- **The interface has no withdrawal, transfer, or account-management method, and must never
  gain one.** If a broker SDK exposes such calls, do not surface them.
- `placeOrder` must reject any symbol outside `ALLOWED_ASSETS`.
- A live broker must refuse to instantiate unless `config().isLive` is true — which itself
  requires the full explicit live configuration.
- Every order needs an idempotency key. Duplicate-order protection is a broker-adapter
  responsibility as well as a risk-engine one.
- Broker rejections must surface as typed errors, not silent failures.

## Adding a new LLM provider

Implement `LLMProvider` from `src/intelligence/llm/types.ts`:

```ts
interface LLMProvider {
  readonly id: string;
  readonly model: string;
  isConfigured(): boolean;
  analyze<T>(options: AnalyzeOptions): Promise<StructuredResult<T>>;
  health(): Promise<{ state: 'healthy' | 'degraded' | 'unavailable' | 'disabled'; detail?: string }>;
}
```

Rules that are not optional:

- **Never put a credential in a prompt.** `AnalyzeOptions` carries `system`, `task` and
  `untrustedContent`; none of them should ever be built from configuration secrets.
- **Constrain the output at the API if the provider supports it, and validate it again
  locally regardless.** `analyze` returns raw parsed JSON; the caller applies the Zod schema.
- **A refusal is not an answer.** Return `refused: true` rather than fabricating a neutral
  verdict — the generator treats a refusal as "no signal", which is the safe reading.
- **Report usage.** Input/output tokens and, where pricing is known, an estimated cost. A
  provider that hides its cost cannot be budgeted.
- Do not probe the provider in `health()` if probing bills tokens. Report configuration
  state and say that is what you are reporting.

`src/intelligence/llm/anthropic.ts` is the worked example; `null.ts` shows the "no provider
configured" case, which throws rather than returning a placeholder verdict.

## Adding a new signal strategy

Signal strategies produce *signals*, never orders. A signal is a proposal; the Risk Engine
decides. See `src/strategy/signals/generator.ts`.

Requirements:

- Return `HOLD` when uncertain. Uncertainty is a valid, and usually correct, output.
- Cite sources on every signal. A signal without traceable sources cannot be audited later.
- Never read the wall clock — use the injected `Clock`, or backtests will leak the future.
- Add your factor to `scoreSignal` as a bounded term with an explicit weight rather than as
  a special case, so it stays visible in the score breakdown and subject to the vetoes.
- Every new strategy must be walk-forward tested before it is allowed to influence a paper
  portfolio, and its results must be reported net of costs and slippage.

## Adding a backtest strategy

```ts
interface BacktestStrategy {
  readonly id: string;
  readonly warmupBars: number;   // bars needed before the first decision
  decide(context: StrategyContext): StrategyDecision;
}
```

`StrategyContext.history` contains bars up to and including today and never the future; the
engine fills at the next bar's open. Two rules follow:

- **Only read `context.history` and `context.today`.** Reaching for the full bar array, or
  for `Date.now()`, reintroduces look-ahead — the property the engine exists to guarantee.
- **Set `warmupBars` honestly**, and compare against a buy & hold baseline using the *same*
  warm-up. A strategy that starts trading 50 bars later than its baseline is being compared
  over a different period, which is how a losing strategy comes to look like a winner.

Worked examples: `src/backtesting/strategies.ts`.

### On the Benner cycle specifically

`src/strategy/signals/benner.ts` implements the cycle as an *experimental,
configurable-weight* overlay that is **off by default**. `npm run backtest -- --benner` runs
the same strategy with and without the tilt on the same bars so the difference is measured
rather than assumed. If it does not improve out-of-sample results, its weight goes to zero
and stays there. A 19th-century commodity-price cycle predicting 21st-century equities is an
extraordinary claim; treat it as a hypothesis to falsify, never as a prior to build on.
