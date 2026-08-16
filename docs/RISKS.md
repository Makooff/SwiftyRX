# Known risks and limitations

Written to be read before, not after, you risk money.

## Financial risks

### The strategy has not been shown to work, and may not

The backtester runs, but no backtest in this repository has used real market data — the
build environment has no network access to any price API, so every run to date used
synthetic fixture bars. Those runs test the engine, not a strategy. Nothing here
constitutes evidence that anything built on it is profitable.

The correct prior for a retail news-reaction strategy is that it does **not** produce an
edge after costs, because the information is public and the participants who trade it
fastest have infrastructure you do not. The backtester exists to test that honestly,
including the possibility that the answer is "no edge — stop here", and it prints a Sharpe
t-statistic and a low-trade-count warning precisely so that a lucky nine-trade run cannot be
mistaken for a result.

### €300 is dominated by transaction costs

At a typical retail commission plus spread, a €300 account trading 10 times a day pays a
meaningful percentage of capital in costs before any strategy question arises. Consequences:

- Frequent trading of this account size is very likely a losing proposition on costs alone.
- Reported returns must be net of commission and slippage. Gross returns on a €300 account
  are a fiction.
- `MAX_TRADES_PER_DAY` defaults to 10, which is already probably too many for this size.
  Fewer, higher-conviction trades is the design intent; capital preservation outranks
  activity.

### Free market data is not market-wide

Alpaca's free plan is IEX-only — one venue with a modest share of US equity volume. Any
signal derived from "unusual volume" on this feed is measuring that venue, not the market.
Either accept the limitation explicitly or pay for the SIP consolidated feed. Do not build
a volume-based strategy on the free tier and assume it generalises.

### Latency

Professional participants react to a filing in microseconds. This system reacts in
seconds-to-minutes: poll interval, plus HTTP, plus LLM inference. It is therefore not
competing on speed and should not pretend to. Any edge must come from *interpretation* over
hours or days, not from being first. If a strategy only works when you are first, this
architecture cannot deliver it.

### Model risk

An LLM will produce a fluent, confident, structured analysis of an event it has
misunderstood. Fluency is not accuracy. This is why the Risk Engine is independent code and
why the decision journal records every signal with its outcome: the question "do Claude's
signals actually work?" is answerable only with logged predictions and realised results.

## Technical risks

### Data source fragility

- RSS feed URLs change without notice. `npm run sources:check` is the detector.
- Provider APIs change payload shapes and deprecate endpoints.
- Free tiers get reduced (Alpha Vantage went to 25 requests/day; X removed its free tier).
- **None of the adapters in this repository has been executed against its live API.** The
  research environment blocks outbound HTTPS to these hosts. Adapters are built to
  documentation and tested against recorded fixtures. Expect to fix at least one payload
  mismatch on first real run.

### Rate limits and bans

SEC EDGAR throttles by IP at 10 req/s regardless of how many machines you use, and rejects
requests without a contact `User-Agent`. This project self-limits to 5 req/s and refuses to
send any request without `CONTACT_EMAIL`. Getting the IP blocked is a self-inflicted outage.

### Cost overrun via X

X reads are billed per post. Polling 5 accounts each minute at 20 posts is roughly
144,000 reads/day — about $720/day at published rates. Mitigations: X is disabled by
default, `X_MAX_POSTS_READ_PER_DAY` defaults to 0, and the adapter stops when the budget is
spent. **The budget is enforced per process.** Running two instances doubles the spend, and
a restart resets the counter — the daily budget lives in memory, and moving it to Redis is
still open. Set a spending cap in the X developer console too; do not rely on
this code alone to protect your card.

### Licence violation

Finnhub's free tier is personal, non-commercial use only. Running this commercially on a
free key breaches those terms. Several news feeds licence headlines but not article bodies.
This is a legal exposure that no code change resolves — check the terms for your use.

## Security risks

### What the bot cannot do, by construction

There is no code path in this repository — and there must never be one — to withdraw funds,
transfer money, change bank details, open an account, or move assets off the trading
account. The `BrokerAdapter` interface is deliberately limited to
`getAccount`, `getPositions`, `getQuote`, `placeOrder`, `cancelOrder`, `getOrderStatus`.
`createLiveBroker()` throws: there is no live implementation of even that limited interface.
When you create live API keys, grant trading permissions only; if the broker offers
withdrawal scopes, do not enable them. Defence in depth: the code refuses, and the
credentials should not permit it either.

### Credential handling

Secrets live in environment variables and are scrubbed from logs by `core/redact.ts`.
`.env` is gitignored. Rotate any key that has ever appeared in a terminal you have shared.

### Prompt injection

Ingested documents are attacker-influenced text. A press release, a news headline or a post
can contain instructions aimed at the model that will read it. Four layers apply:

1. Document content is fenced in `<untrusted_document>` blocks, with embedded fence markers
   stripped so the fence cannot be closed from inside.
2. The system prompt is the only instruction channel, and states that fenced content is data
   to analyse rather than instructions to follow.
3. Output is schema-constrained at the API and re-validated with Zod; injected prose that
   does not match the schema produces no signal.
4. The Risk Engine reads a single number and never the model's text, so a successful
   injection still cannot bypass the allowlist, the sizing rules or the exposure caps.

None of this is a proof. Treat it as depth, not immunity — and note that the allowlist is
what makes an injection bounded: an order can only ever target an asset you explicitly
authorised.

### Compromised or fake accounts

An account handle is a claim about identity, not evidence about the world. Accounts get
hacked, parodied and impersonated. X content therefore enters at the lowest tier with
`canTriggerOrderDirectly: false`. The 2013 AP hack — one compromised account, a fake
explosion, roughly $136bn of S&P 500 value gone in minutes — is what tweet-to-order
automation does when it is wrong.

## Regulatory considerations (Belgium / EU)

Not legal advice; confirm with a qualified adviser before trading live.

- **Market abuse (MAR).** Trading on inside information is illegal. This system uses public
  sources only, which is necessary but not sufficient — how you use them matters too.
- **Tax.** Belgian tax treatment of trading gains depends on whether activity is considered
  normal management of private assets or speculative/professional. Frequent algorithmic
  trading can change that classification. Get advice before scaling up.
- **Broker eligibility.** Alpaca paper accounts are available worldwide. Live eligibility
  from Belgium was **not** confirmed during research and must be verified with Alpaca
  directly before Phase 9.
- **Data licensing.** Non-commercial free tiers cannot lawfully back a commercial service.

## The honest bottom line

The goal is not a bot that makes money. It is a system that can answer, with evidence:

> Does this information create a statistically exploitable edge after fees, slippage and
> risk?

If the answer is uncertain, the answer is HOLD. A system that trades rarely and preserves
capital has done its job; one that trades constantly and loses slowly has not, however
sophisticated it looks.
