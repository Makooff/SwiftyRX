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

## Adding a new broker (Phase 5+)

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

## Adding a new strategy (Phase 3+)

Strategies produce *signals*, never orders. A signal is a proposal; the Risk Engine decides.

```ts
interface Strategy {
  readonly id: string;
  evaluate(context: MarketContext): Promise<Signal[]>;
}
```

Requirements:

- Return `HOLD` when uncertain. Uncertainty is a valid, and usually correct, output.
- Cite sources on every signal. A signal without traceable sources cannot be audited later.
- Never read the wall clock — use the injected `Clock`, or backtests will leak the future.
- Every new strategy must be walk-forward tested before it is allowed to influence a paper
  portfolio, and its results must be reported net of costs and slippage.

### On the Benner cycle specifically

It is planned as an *experimental, configurable-weight* feature, tested as
`strategy WITHOUT benner` versus `strategy WITH benner` out of sample. If it does not
improve out-of-sample results, its weight goes to zero and it stays there. A 19th-century
commodity-price cycle predicting 21st-century equities is an extraordinary claim; treat it
as a hypothesis to falsify, never as a prior to build on.
