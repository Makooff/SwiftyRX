import type { AppConfig } from '../../src/config/env.js';
import { ageSeconds, type Clock, systemClock } from '../../src/core/clock.js';
import { sha256 } from '../../src/core/hash.js';
import { createLogger, type Logger } from '../../src/core/logger.js';
import type { HealthReport, NormalizedDocument } from '../../src/domain/types.js';
import {
  AgentStateStore,
  fingerprintOf,
  type StateFingerprint,
} from '../../src/database/agent-state-store.js';
import { DecisionJournal } from '../../src/database/decision-journal.js';
import { PaperBroker } from '../../src/execution/paper/paper-broker.js';
import { Portfolio } from '../../src/execution/paper/portfolio.js';
import type { Order } from '../../src/execution/broker/types.js';
import {
  buildIngestionStack,
  checkStackHealth,
  runIngestionCycle,
  type IngestionStack,
} from '../../src/ingestion/pipeline.js';
import { MemoryEventStore } from '../../src/intelligence/event-store.js';
import { AnthropicProvider } from '../../src/intelligence/llm/anthropic.js';
import { NullLLMProvider } from '../../src/intelligence/llm/null.js';
import type { LLMProvider } from '../../src/intelligence/llm/types.js';
import { detectEvents, eventsWorthAnalysing } from '../../src/intelligence/pipeline.js';
import type { MarketEvent } from '../../src/intelligence/types.js';
import {
  DiscordApprover,
  DiscordNotifier,
  type ApprovalOutcome,
} from '../../src/monitoring/discord.js';
import { metrics } from '../../src/monitoring/metrics.js';
import { RiskEngine } from '../../src/risk/engine.js';
import type { RiskDecision } from '../../src/risk/types.js';
import { detectRegime, type MarketRegime } from '../../src/strategy/regime.js';
import { SignalGenerator } from '../../src/strategy/signals/generator.js';
import type { Signal } from '../../src/strategy/signals/types.js';

/**
 * The paper-trading agent.
 *
 * Runs the full pipeline on a loop:
 *
 *   ingest -> detect events -> verify -> analyse -> score -> risk -> order -> journal
 *
 * Every stage can stop the flow, and most cycles are expected to produce no
 * trade at all. That is the intended behaviour, not a fault: a system that
 * finds a tradeable edge in every 60-second window is not finding edges.
 *
 * The agent never constructs a live broker. It holds a PaperBroker, and the
 * type it holds has no method that could move real money.
 */

export interface AgentState {
  startedAt: string;
  lastCycleAt?: string;
  cycles: number;
  documentsIngested: number;
  eventsDetected: number;
  signalsGenerated: number;
  ordersPlaced: number;
  ordersRejectedByRisk: number;
  /** Refused by a human on Discord, or by nobody answering. */
  ordersRejectedByApproval: number;
  errors: Array<{ at: string; stage: string; message: string }>;
  halted: boolean;
  haltReasons: string[];
}

export interface AgentOptions {
  config: AppConfig;
  clock?: Clock;
  logger?: Logger;
  /** Injected for tests; built from config otherwise. */
  stack?: IngestionStack;
  llm?: LLMProvider;
  journalPath?: string;
  /** Minimum composite score before the Risk Engine is consulted. */
  minScoreForOrder?: number;
  /**
   * Where to persist portfolio and counters between runs. Omit for an
   * in-memory agent that starts fresh — which is what the tests want, and what
   * a one-shot `--once` run does not need.
   */
  stateStore?: AgentStateStore;
  /** Injected for tests; built from config otherwise. */
  discord?: DiscordNotifier;
  approver?: DiscordApprover;
}

export class TradingAgent {
  readonly portfolio: Portfolio;
  readonly broker: PaperBroker;
  readonly journal: DecisionJournal;
  readonly riskEngine: RiskEngine;

  private readonly config: AppConfig;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly stack: IngestionStack;
  private readonly llm: LLMProvider;
  private readonly generator: SignalGenerator;
  private readonly eventStore = new MemoryEventStore();

  private readonly recentSignals: Signal[] = [];
  private readonly recentEvents: MarketEvent[] = [];
  private readonly recentOrders: Order[] = [];
  private lastHealth: HealthReport[] = [];
  private regimeBySymbol = new Map<string, MarketRegime>();

  private readonly discord: DiscordNotifier | undefined;
  private readonly approver: DiscordApprover | undefined;
  private readonly stateStore: AgentStateStore | undefined;
  private readonly fingerprint: StateFingerprint;
  /** When this experiment began, carried across restarts. */
  private readonly firstStartedAt: string;

  private state: AgentState;

  constructor(options: AgentOptions) {
    this.config = options.config;
    this.clock = options.clock ?? systemClock;
    this.log = options.logger ?? createLogger('agent');
    this.stack = options.stack ?? buildIngestionStack(options.config);

    this.llm =
      options.llm ??
      (options.config.LLM_PROVIDER === 'anthropic' && options.config.ANTHROPIC_API_KEY
        ? new AnthropicProvider({
            apiKey: options.config.ANTHROPIC_API_KEY,
            model: options.config.LLM_MODEL,
            clock: this.clock,
          })
        : new NullLLMProvider());

    this.generator = new SignalGenerator(this.llm, this.log);

    this.discord =
      options.discord ??
      (options.config.DISCORD_WEBHOOK_URL
        ? new DiscordNotifier({
            webhookUrl: options.config.DISCORD_WEBHOOK_URL,
            clock: this.clock,
            logger: this.log,
          })
        : undefined);

    // Built only when approval is actually required: a configured bot that
    // nobody asked to gate trades should not silently start gating them.
    this.approver =
      options.approver ??
      (options.config.REQUIRE_APPROVAL
        ? new DiscordApprover({
            ...(options.config.DISCORD_BOT_TOKEN ? { botToken: options.config.DISCORD_BOT_TOKEN } : {}),
            ...(options.config.DISCORD_CHANNEL_ID ? { channelId: options.config.DISCORD_CHANNEL_ID } : {}),
            timeoutSeconds: options.config.APPROVAL_TIMEOUT_SECONDS,
            clock: this.clock,
            logger: this.log,
          })
        : undefined);

    this.stateStore = options.stateStore;
    this.fingerprint = fingerprintOf(options.config);
    // Throws on a mismatched or corrupt state file. Failing at startup is the
    // point: a run that silently discards its own history cannot be trusted to
    // report on itself.
    const restored = this.stateStore?.load(this.fingerprint);

    this.portfolio = restored
      ? Portfolio.restore(restored.portfolio, { clock: this.clock })
      : new Portfolio({
          // Paper mode by construction: this is `initialCapital`, which resolves
          // to PAPER_CAPITAL_EUR outside live mode.
          initialCash: options.config.initialCapital,
          currency: options.config.BASE_CURRENCY,
          clock: this.clock,
        });

    this.broker = new PaperBroker({
      portfolio: this.portfolio,
      marketData: this.stack.marketData,
      clock: this.clock,
      logger: this.log,
      maxQuoteAgeSeconds: options.config.MAX_QUOTE_STALENESS_SECONDS,
    });

    this.journal = new DecisionJournal({
      ...(options.journalPath ? { path: options.journalPath } : {}),
      clock: this.clock,
    });

    this.riskEngine = new RiskEngine({
      config: options.config,
      clock: this.clock,
      logger: this.log,
      ...(options.minScoreForOrder !== undefined ? { minScore: options.minScoreForOrder } : {}),
    });

    if (restored) {
      this.riskEngine.rememberOrderIds(restored.consumedOrderIds);
    }

    this.firstStartedAt = restored?.firstStartedAt ?? this.clock.now().toISOString();

    this.state = {
      startedAt: this.clock.now().toISOString(),
      cycles: restored?.counters.cycles ?? 0,
      documentsIngested: restored?.counters.documentsIngested ?? 0,
      eventsDetected: restored?.counters.eventsDetected ?? 0,
      signalsGenerated: restored?.counters.signalsGenerated ?? 0,
      ordersPlaced: restored?.counters.ordersPlaced ?? 0,
      ordersRejectedByRisk: restored?.counters.ordersRejectedByRisk ?? 0,
      ordersRejectedByApproval: 0,
      errors: [],
      halted: false,
      haltReasons: [],
    };

    if (restored) {
      this.log.info(
        {
          savedAt: restored.savedAt,
          cycles: this.state.cycles,
          totalValue: this.portfolio.totalValue,
          openPositions: this.portfolio.openPositions.length,
        },
        'resumed from persisted state',
      );
    }
  }

  /**
   * Persist portfolio and counters.
   *
   * A failure here is logged and swallowed: losing a checkpoint costs history,
   * whereas crashing the loop costs the run. The distinction matters because
   * this is called on every cycle.
   */
  saveState(): void {
    if (!this.stateStore) return;
    try {
      this.stateStore.save({
        fingerprint: this.fingerprint,
        portfolio: this.portfolio.serialize(),
        counters: {
          cycles: this.state.cycles,
          documentsIngested: this.state.documentsIngested,
          eventsDetected: this.state.eventsDetected,
          signalsGenerated: this.state.signalsGenerated,
          ordersPlaced: this.state.ordersPlaced,
          ordersRejectedByRisk: this.state.ordersRejectedByRisk,
        },
        consumedOrderIds: this.riskEngine.submittedOrderIds,
        firstStartedAt: this.firstStartedAt,
      });
    } catch (err) {
      this.recordError('state', `could not persist agent state: ${(err as Error).message}`);
    }
  }

  getState(): AgentState {
    return { ...this.state, errors: [...this.state.errors] };
  }

  getSignals(): Signal[] {
    return [...this.recentSignals];
  }

  getEvents(): MarketEvent[] {
    return [...this.recentEvents];
  }

  getOrders(): Order[] {
    return [...this.recentOrders];
  }

  getHealth(): HealthReport[] {
    return [...this.lastHealth];
  }

  getLlmProviderId(): string {
    return this.llm.id;
  }

  async refreshHealth(): Promise<HealthReport[]> {
    this.lastHealth = await checkStackHealth(this.stack);
    return this.lastHealth;
  }

  private recordError(stage: string, message: string): void {
    this.state.errors.unshift({ at: this.clock.now().toISOString(), stage, message });
    this.state.errors = this.state.errors.slice(0, 25);
  }

  /** Refresh marks so the portfolio's value reflects current prices. */
  private async markPositions(): Promise<void> {
    for (const position of this.portfolio.openPositions) {
      try {
        const quote = await this.stack.marketData.getQuote(position.symbol);
        const price = quote.quote.last ?? quote.quote.bid;
        if (price) this.portfolio.mark(position.symbol, price);
      } catch (err) {
        // A position we cannot price is a reason to be careful, not a reason to
        // crash: the stale mark stays and the Risk Engine sees the same number.
        this.log.warn(
          { symbol: position.symbol, error: (err as Error).message },
          'could not refresh position mark',
        );
      }
    }
  }

  /**
   * One complete pass through the pipeline, checkpointed however it ends.
   *
   * The cycle has several early exits — no documents, no events, an ingestion
   * failure — and a checkpoint has to happen on all of them. A `finally` is the
   * only way to say that once rather than at each return.
   */
  async runCycle(options: { since?: Date } = {}): Promise<void> {
    try {
      await this.runCycleInner(options);
    } finally {
      this.saveState();
    }
  }

  private async runCycleInner(options: { since?: Date } = {}): Promise<void> {
    const cycleStart = this.clock.nowMs();
    this.state.cycles += 1;
    this.state.lastCycleAt = this.clock.now().toISOString();

    await this.markPositions();

    // Halting conditions are checked before any work: if trading is halted,
    // there is no point paying for LLM analysis this cycle.
    const halts = this.riskEngine.haltingConditions(this.portfolio.snapshot());
    const wasHalted = this.state.halted;
    this.state.halted = halts.length > 0;
    this.state.haltReasons = halts.map((h) => h.message);
    if (halts.length > 0) {
      this.log.warn({ reasons: this.state.haltReasons }, 'trading halted this cycle');
      // Announced on the transition only. A halt lasts the rest of the day, so
      // notifying every cycle would be one message a minute until midnight.
      if (!wasHalted) await this.announceHalt(this.state.haltReasons);
    }

    // --- Ingest ----------------------------------------------------------
    let documents: NormalizedDocument[] = [];
    try {
      const result = await runIngestionCycle(this.stack, {
        ...(options.since ? { since: options.since } : {}),
        limitPerSource: 50,
      });
      documents = result.documents;
      this.state.documentsIngested += result.stats.kept;
      for (const failure of result.stats.failures) {
        this.recordError('ingestion', `${failure.adapter}: ${failure.error}`);
      }
    } catch (err) {
      this.recordError('ingestion', (err as Error).message);
      return;
    }

    if (documents.length === 0) {
      metrics.observe('agent.cycle', this.clock.nowMs() - cycleStart);
      return;
    }

    // --- Detect and verify ------------------------------------------------
    let events: MarketEvent[] = [];
    try {
      const detection = await detectEvents(documents, this.eventStore, { clock: this.clock });
      events = detection.events;
      this.state.eventsDetected += detection.stats.newEvents;
      this.recentEvents.unshift(...events.slice(0, 10));
      this.recentEvents.splice(50);
    } catch (err) {
      this.recordError('event_detection', (err as Error).message);
      return;
    }

    const candidates = eventsWorthAnalysing(events);
    if (candidates.length === 0) return;

    // --- Analyse, score, decide -------------------------------------------
    for (const event of candidates.slice(0, 5)) {
      try {
        await this.processEvent(event, documents);
      } catch (err) {
        this.recordError('analysis', `${event.id}: ${(err as Error).message}`);
      }
    }

    metrics.observe('agent.cycle', this.clock.nowMs() - cycleStart);
  }

  private async processEvent(event: MarketEvent, documents: NormalizedDocument[]): Promise<void> {
    const symbol = event.tickers[0];
    const eventDocuments = documents.filter((doc) => event.documentIds.includes(doc.id));

    // Market context, when a price is available. Its absence is not fatal —
    // the model simply gets less to work with, and the Risk Engine will refuse
    // any resulting order for lack of a fresh price.
    let context;
    let regime: MarketRegime | undefined;
    let priceAgeSeconds = Number.POSITIVE_INFINITY;
    let price: number | undefined;

    if (symbol) {
      try {
        const quote = await this.stack.marketData.getQuote(symbol);
        price = quote.quote.last ?? quote.quote.bid;
        priceAgeSeconds = quote.ageSeconds;
        regime = this.regimeBySymbol.get(symbol);

        if (!regime) {
          try {
            const history = await this.stack.marketData.getBars(symbol, '1Day', {
              start: new Date(this.clock.nowMs() - 200 * 86_400_000),
            });
            regime = detectRegime(history.bars);
            this.regimeBySymbol.set(symbol, regime);
          } catch {
            // No history: regime stays unknown, and the scorer treats an
            // unknown regime as neutral rather than assuming one.
          }
        }

        context = {
          symbol,
          ...(price !== undefined ? { lastPrice: price } : {}),
          currency: quote.quote.currency,
          ...(regime ? { volatilityPct: regime.volatilityPct, regime: regime.trend } : {}),
          dataNote: `${quote.quote.freshness.delayClass} feed, ${Math.round(quote.ageSeconds)}s old`,
        };
      } catch (err) {
        this.log.debug({ symbol, error: (err as Error).message }, 'no market context for event');
      }
    }

    const hitRates = await this.journal.hitRateByEventType();
    const historical = hitRates[event.type];

    const { signal, skipped } = await this.generator.generate({
      event,
      documents: eventDocuments,
      ...(context ? { context } : {}),
      ...(regime ? { regime } : {}),
      ...(historical ? { historicalHitRate: historical.hitRate, historicalSampleSize: historical.sampleSize } : {}),
      clock: this.clock,
      logger: this.log,
    });

    if (!signal) {
      this.log.debug({ eventId: event.id, skipped }, 'no signal produced');
      return;
    }

    this.state.signalsGenerated += 1;
    this.recentSignals.unshift(signal);
    this.recentSignals.splice(50);

    // --- Risk ------------------------------------------------------------
    let riskDecision: RiskDecision | undefined;
    let order: Order | undefined;

    const tradeable =
      (signal.action === 'BUY' || signal.action === 'SELL') && symbol !== undefined && price !== undefined;

    if (tradeable && !this.state.halted) {
      riskDecision = this.riskEngine.evaluate(
        {
          symbol,
          action: signal.action,
          score: signal.score,
          price: price!,
          priceAgeSeconds,
          ...(regime ? { volatilityPct: regime.volatilityPct } : {}),
          clientOrderId: sha256(`${signal.id}|${symbol}`).slice(0, 24),
        },
        this.portfolio.snapshot(),
      );

      // Human approval, when configured, sits *after* the Risk Engine and can
      // only subtract. A human cannot approve what risk refused — that would
      // make the engine advisory, which is the one thing it must never be.
      let approval: ApprovalOutcome | undefined;
      if (riskDecision.verdict === 'approved' && this.approver?.isConfigured) {
        approval = await this.approver.requestApproval(signal, riskDecision);
        if (approval !== 'approved') {
          this.state.ordersRejectedByApproval += 1;
          this.log.info({ asset: signal.asset, approval }, 'order not approved — skipping');
        }
      }

      const mayTrade = riskDecision.verdict === 'approved' && (approval ?? 'approved') === 'approved';

      if (mayTrade) {
        try {
          order = await this.broker.placeOrder({
            symbol: riskDecision.symbol,
            side: riskDecision.side,
            quantity: riskDecision.quantity,
            type: 'market',
            clientOrderId: sha256(`${signal.id}|${symbol}`).slice(0, 24),
            reason: `signal ${signal.id}: ${signal.catalyst}`.slice(0, 200),
          });
          this.state.ordersPlaced += 1;
          this.recentOrders.unshift(order);
          this.recentOrders.splice(50);
          await this.discord?.order(order, signal);
        } catch (err) {
          this.recordError('execution', (err as Error).message);
        }
      } else if (riskDecision.verdict !== 'approved') {
        this.state.ordersRejectedByRisk += 1;
      }
    }

    await this.discord?.signal(signal, riskDecision);

    // Every decision is journalled, including the ones that produced no order.
    // A journal of only executed trades cannot answer whether the signals work.
    await this.journal.record({
      signal,
      eventType: event.type,
      eventHeadline: event.headline,
      verificationStatus: event.verification.status,
      verificationConfidence: event.verification.confidence,
      ...(riskDecision ? { riskDecision } : {}),
      ...(order ? { order } : {}),
    });
  }

  /**
   * Post a portfolio summary to Discord.
   *
   * Called by the runner on a schedule rather than every cycle: a message per
   * minute is noise, and noise is what stops people reading notifications.
   */
  async postSummary(): Promise<void> {
    if (!this.discord) return;
    await this.discord.summary({
      totalValue: this.portfolio.totalValue,
      currency: this.portfolio.currency,
      returnPct: this.portfolio.totalReturnPct,
      drawdownPct: this.portfolio.drawdownPct,
      openPositions: this.portfolio.openPositions.length,
      cycles: this.state.cycles,
      signals: this.state.signalsGenerated,
      orders: this.state.ordersPlaced,
      riskRejections: this.state.ordersRejectedByRisk,
    });
  }

  /** Notify that trading halted, once per transition rather than per cycle. */
  private async announceHalt(reasons: string[]): Promise<void> {
    await this.discord?.halted(reasons);
  }

  /** Age of the most recent successful cycle, in seconds. */
  cycleAgeSeconds(): number | undefined {
    return this.state.lastCycleAt ? ageSeconds(this.state.lastCycleAt, this.clock) : undefined;
  }
}
