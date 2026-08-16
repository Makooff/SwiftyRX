# API research — what actually exists, what it costs, what it forbids

**Research date: 16 August 2026.** API terms change often; re-verify before relying on
anything here. Every claim below comes from provider documentation or provider pricing
pages found through web search on that date, and each section links its sources.

**Verification limitation, stated plainly:** the environment this research was performed
in blocks outbound HTTPS to almost every host (`curl` to `sec.gov`, `ecb.europa.eu` and
`data-api.ecb.europa.eu` all fail at the network layer). Endpoint *shapes* below come from
provider documentation and are implemented against recorded fixtures in `tests/`. They have
**not** been executed against the live services from here. Run `npm run sources:check` on
your own machine — that is the first thing to do with this repository, and it will tell you
which of these adapters actually work from Belgium with your keys.

Nothing in this document is inferred from a provider's name or reputation. Where a
capability could not be confirmed, it is marked **unverified** rather than assumed.

---

## Summary table

| Provider | Key needed | Free tier | Published limit | Commercial use | Belgium |
|---|---|---|---|---|---|
| SEC EDGAR | No | Yes, fully free | 10 req/s (fair-access) | Public domain | Yes |
| ECB Data Portal | No | Yes, fully free | None published | Reuse with attribution | Yes |
| FRED | Yes (free) | Yes | 120 req/min | Mostly yes, some series restricted | Yes |
| Alpaca (market data) | Yes | IEX feed only | ~200 req/min | Per Alpaca agreement | Paper: yes. Live: verify |
| Finnhub | Yes | 60 calls/min | 60 calls/min | **No — personal use only** | Yes |
| Alpha Vantage | Yes | 25 req/**day** | 5 req/min, 25/day | Paid plan required | Yes |
| X (Twitter) | Yes | **None for new devs** | Pay-per-read | Per X agreement | Yes, billed |
| Anthropic | Yes | No | Tier-dependent | Yes | Yes |

---

## Official sources (highest tier)

### SEC EDGAR — `data.sec.gov` / `www.sec.gov`

- **Cost:** free, no registration, no key.
- **Rate limit:** 10 requests/second across all EDGAR endpoints, enforced per IP
  regardless of how many machines you spread requests over. Exceeding it gets the IP
  throttled temporarily. This adapter self-limits to **5 req/s** to leave headroom.
- **Mandatory header:** a `User-Agent` containing a real contact address, in the form
  `Sample Company Name AdminContact@example.com`. Requests without it are rejected.
  This is why `CONTACT_EMAIL` is required and why `SecEdgarAdapter` refuses to send a
  single request without one — a blocked IP is a self-inflicted outage.
- **Endpoints used:**
  - `https://www.sec.gov/files/company_tickers.json` — ticker → CIK mapping
  - `https://data.sec.gov/submissions/CIK##########.json` — a company's recent filings
- **Licence:** US federal government work, public domain.
- **Caveat:** covers US-listed issuers only. European-listed names are absent, which is
  why the adapter skips unmatched tickers instead of failing.

Sources: [Accessing EDGAR Data](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data),
[SEC EDGAR rate limits](https://tldrfiling.com/blog/sec-edgar-api-rate-limits-best-practices)

### ECB Data Portal — `data-api.ecb.europa.eu`

- **Cost:** free. No key, no registration, no contract.
- **Rate limit:** none published. The adapter self-imposes 60 req/min out of politeness;
  an undocumented limit is not the same as no limit.
- **Protocol:** SDMX 2.1 REST. `format=csvdata` is the most stable representation to parse;
  SDMX-JSON and XML are also offered.
- **Coverage:** 139,000+ time series — policy rates, HICP, euro FX reference rates.
- **Licence:** free reuse with attribution under the ECB copyright notice.
- **Why it matters here:** for a euro-area operator this is the most directly relevant
  macro source available, and it is the only one in this project that needs no credentials
  at all.

Sources: [ECB data services](https://www.ecb.europa.eu/stats/accessing-our-data/html/index.en.html),
[Getting data via web services (SDMX)](https://data.ecb.europa.eu/help/getting-data-web-services-sdmx)

### Central bank and government RSS feeds

ECB, Federal Reserve, SEC press releases, US BLS and the National Bank of Belgium all
publish RSS. Free, no key. `RssAdapter` reads **only what the feed publishes** — title,
summary, link, date. It never fetches article bodies, because retrieving full text a
publisher has not licensed for reuse is scraping, not ingestion.

Feed URLs are listed in `src/ingestion/feeds.ts`. Confirm each one responds with
`npm run sources:check` before depending on it; feed URLs are changed by publishers more
often than APIs are.

---

## Market data

### Alpaca

- **Paper trading:** available globally, including Belgium — a paper-only account needs
  just an email address.
- **Live trading:** eligibility depends on country of tax residence. Alpaca's supported
  countries page directs prospective users to contact support for confirmation, and as of
  the research date it did **not** clearly confirm Belgium. **Treat live eligibility from
  Belgium as unverified** and confirm with Alpaca directly before Phase 9.
- **Free data plan:** IEX feed only, ~200 requests/minute, 7+ years of history.
- **Paid plan:** SIP consolidated feed.
- **The IEX caveat that matters:** IEX is a single venue with a low share of US equity
  volume. Free-plan prints are a *subset* of consolidated activity, so volume from this
  feed is indicative, not market-wide. Any "unusual volume" signal built on the free tier
  is measuring one venue, not the market. The adapter therefore labels IEX quotes
  `delayed_other`, never `realtime`.
- **Endpoints used:** `GET /v2/stocks/{symbol}/quotes/latest`, `GET /v2/stocks/{symbol}/bars`.
  Auth via `APCA-API-KEY-ID` / `APCA-API-SECRET-KEY` headers.
- **Paper trading base URL:** `https://paper-api.alpaca.markets`. Not used: paper trading is
  simulated locally by `PaperBroker` against the shared cost model, so paper runs need no
  broker account at all. The URL is recorded here for whoever implements a live adapter.

Sources: [Alpaca countries](https://alpaca.markets/support/countries-alpaca-is-available),
[Alpaca data plans](https://alpaca.markets/data), [Market data API docs](https://docs.alpaca.markets/us/docs/about-market-data-api)

### Finnhub

- **Free tier:** 60 API calls/minute; real-time US quotes; company news; WebSocket
  streaming for up to 50 symbols.
- **Licence restriction — read this before deploying:** the free tier is **personal,
  non-commercial use only**. A monetised deployment requires a paid plan. This is a
  licensing decision for the operator; no amount of code makes free-tier data commercially
  usable.
- **Historical candles:** `/stock/candle` is a paid entitlement. On the free tier it
  returns 403. `FinnhubAdapter.getBars()` throws a clear error rather than returning an
  empty array — an empty bar list would be silently interpreted downstream as "no trading
  activity", which is a far worse failure than an exception.
- **Unknown symbols:** answered with HTTP 200 and an all-zero body, so the adapter
  validates the payload rather than trusting the status code.

Sources: [Finnhub pricing](https://finnhub.io/pricing), [Finnhub rate limits](https://finnhub.io/docs/api/rate-limit)

### Alpha Vantage

- **Free tier:** **25 requests per day** and 5 per minute. That is a hard ceiling, not a
  soft target — this provider is a historical-data fallback, never a polling source.
- **Paid:** from $49.99/month (75 req/min) up to $249.99/month (1,200 req/min); no daily
  cap on paid plans. Real-time US data requires the applicable entitlement.
- **Quota errors arrive as HTTP 200** with an explanatory JSON body (`Note` /
  `Information`), so the adapter inspects the body, not just the status code.
- The adapter also tracks its own daily budget locally and refuses the 26th call, so the
  quota is not discovered by burning it.
- Its `health()` deliberately does **not** make a request: a health check that consumes 4%
  of the daily quota is a bug, not a diagnostic.

Sources: [Alpha Vantage premium](https://www.alphavantage.co/premium/),
[Alpha Vantage API limits](https://www.macroption.com/alpha-vantage-api-limits/)

### FRED (Federal Reserve Bank of St. Louis)

- **Cost:** free key, instant self-service registration, available worldwide.
- **Rate limit:** 120 requests/minute per key.
- **Licence:** open, but redistribution of some third-party series (e.g. S&P/Case-Shiller,
  NAHB) carries obligations imposed by the originating provider.
- **Point-in-time support — the reason this provider earns its place:** FRED exposes data
  *vintages* through `realtime_start` / `realtime_end`. Macro series get revised, so the
  GDP figure visible today is not the figure that was visible on the day a decision would
  have been made. `FredAdapter.getSeriesAsOf()` requests the correct vintage.
  Using the default latest-vintage call inside a backtest is a look-ahead bug, and Phase 6
  must use the vintage-aware call.

Sources: [FRED API key](https://fred.stlouisfed.org/docs/api/api_key.html)

---

## Social

### X (Twitter) — enabled only by explicit opt-in

- **X discontinued the free tier for new developers on 6 February 2026** and moved to
  pay-per-use pricing.
- **Rates published mid-2026:** ~$0.005 per post read, ~$0.010 per user lookup,
  ~$0.015 per post created, capped at 2 million post reads per billing cycle. No monthly
  minimum. Above the cap, Enterprise (~$42,000/month) is the only option.
- **Legacy flat tiers** (Basic $200/month, Pro $5,000/month) still exist for existing
  subscribers but are closed to new signups.
- **Practical consequence:** polling 5 accounts every minute at 20 posts per poll would be
  roughly 144,000 reads/day — about **$720/day**. This is why the adapter enforces a hard
  `X_MAX_POSTS_READ_PER_DAY` budget that defaults to **0**, and why `health()` does not
  probe (a probe is a billed user lookup).
- **Availability:** accessible from Belgium; the constraint is cost, not geography.

Sources: [X API cost breakdown 2026](https://twitterapi.io/blog/x-api-cost-breakdown-2026),
[X API pricing tiers 2026](https://postproxy.dev/blog/x-api-pricing-2026/)

#### Why a post can never trigger an order

Independent of cost, X content enters the system at the lowest trust tier
(`reliability: 0.2`), with `verification: 'unverified'` and
`metadata.canTriggerOrderDirectly: false`. Accounts get compromised, parodied and
impersonated; a handle is a claim about identity, not evidence about the world. A post is
a lead to check against an official source. The 2013 AP hack — a single compromised
account, a fake White House explosion, roughly $136bn of S&P 500 value erased in minutes —
is the canonical demonstration of what tweet-to-order automation does when it is wrong.

---

## LLM

### Anthropic Messages API

- **Endpoint:** `POST https://api.anthropic.com/v1/messages`, called through the official
  `@anthropic-ai/sdk` rather than by hand.
- **Auth:** `x-api-key` header, supplied by the SDK from `ANTHROPIC_API_KEY`. The key is
  passed to `registerSecret()` at construction so it is scrubbed from every log line.
- **Model:** `LLM_MODEL`, default `claude-opus-5`.
- **Structured output:** requested via `output_config: { format: { type: 'json_schema',
  schema } }`. The response is still parsed and validated locally with Zod — a
  schema-constrained response is a strong guarantee, not a reason to skip validation.
- **Sampling parameters:** none sent. `temperature`, `top_p` and `top_k` are rejected by
  current models; steering is done through the system prompt.
- **Refusals:** a request can return HTTP 200 with `stop_reason: "refusal"` and no content.
  The provider surfaces this as `refused: true`. Reading `content[0]` without checking would
  throw, or worse, produce a neutral-looking verdict from an absent analysis.
- **Cost:** usage-based. Published list prices are recorded in `anthropic.ts`
  (`claude-opus-5`: $5/Mtok input, $25/Mtok output) and used to estimate a per-call cost from
  the returned token counts. Prices change; treat the table as a local estimate, not an
  invoice.
- **Rate limits:** per-account and tier-dependent, not a fixed published number. The agent
  makes at most one call per detected event, which in practice is far below any tier limit.
- **Availability from Belgium:** the API is available; no regional restriction was found.

**Not verified against the live API.** The build environment has no outbound access to
`api.anthropic.com`. The request shape follows current documentation and is tested against a
stubbed `messages.create`. Verify with a real key before trusting a run.

Sources: [Messages API](https://docs.claude.com/en/api/messages),
[Structured outputs](https://docs.claude.com/en/docs/build-with-claude/structured-outputs),
[Pricing](https://claude.com/pricing)

---

## Deliberately not used

- **Yahoo Finance** — the widely used endpoints are undocumented and unsanctioned. Using
  them means depending on an interface that has no stability guarantee and no licence.
- **Web scraping of news sites** — publishers licence headlines via RSS, not article
  bodies. This project reads feeds; it does not scrape.
- **"Free unlimited market data" aggregators** — every one examined either resells data it
  is not licensed to redistribute, or has terms that forbid the use this project makes.
- **Google News RSS** — present in `feeds.ts` but **disabled by default** and rated 0.45.
  It is undocumented as a public API and returns headlines only. Acceptable as a discovery
  hint; unacceptable as a source of record.

---

## What this costs to run

| Configuration | Monthly cost | What you get |
|---|---|---|
| Official sources only (default) | **€0** | SEC filings, ECB/Fed/BLS/NBB releases, ECB macro |
| + FRED | €0 | US macro with point-in-time vintages |
| + Alpaca free | €0 | IEX quotes and bars (single venue) |
| + Finnhub free | €0 | Real-time US quotes — **non-commercial use only** |
| + Alpha Vantage free | €0 | 25 requests/day of history |
| + Claude API | usage-based | One call per detected event, not per document |
| + X ingestion | ~$0.005/post read | Monitoring of named accounts |
| + Alpaca SIP data | paid | Consolidated US tape |

The default configuration costs nothing and requires no account beyond an email address in
`CONTACT_EMAIL`. That is deliberate: the free official sources are also the highest-quality
ones, and a system that needs a paid feed before it can tell you anything true is badly
designed.
