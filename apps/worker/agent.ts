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
import {
  buildOutcome,
  DecisionJournal,
  hitRatesFrom,
  outcomeDueAt,
  pendingFrom,
  type JournalEntry,
} from '../../src/database/decision-journal.js';
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
import { detectEvents, evaluateAnalysisGate } from '../../src/intelligence/pipeline.js';
import type { MarketEvent } from '../../src/intelligence/types.js';
import {
  DiscordApprover,
  DiscordNotifier,
  type ApprovalOutcome,
} from '../../src/monitoring/discord.js';
import { ActivityLog, type ActivityEntry } from '../../src/monitoring/activity-log.js';
import { CycleFunnelBuilder, CycleFunnelHistory, type CycleFunnel } from '../../src/monitoring/cycle-funnel.js';
import { metrics } from '../../src/monitoring/metrics.js';
import { entityForTicker } from '../../src/intelligence/entity_resolution/registry.js';
import { RiskEngine } from '../../src/risk/engine.js';
import { CorrelationGroups } from '../../src/risk/correlation.js';
import { PositionManager } from '../../src/risk/position-manager.js';
import type { RiskDecision } from '../../src/risk/types.js';
import { EvidenceBook } from '../../src/strategy/evidence.js';
import { observationVerdict } from '../../src/strategy/observation.js';
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

/**
 * How many pending decisions to price per cycle. Each costs a historical-bars
 * call, and a backlog that clears one cycle later is no worse an answer.
 */
const OUTCOMES_PER_CYCLE = 20;

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
  /**
   * What the event study measured. Loaded from EVIDENCE_FILE when absent; a
   * missing file means the agent has no opinion and gates nothing on it.
   */
  evidence?: EvidenceBook;
  /**
   * Correlation groups. Loaded from CORRELATION_FILE when absent; without
   * either, the correlated-exposure limit falls back to the curated sector map.
   */
  correlations?: CorrelationGroups;
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
  readonly activity: ActivityLog;
  /** Last cycles' funnels — how far each got, and why it stopped there. */
  readonly funnels: CycleFunnelHistory;
  /** Exit plans — the stops the sizing already assumed. */
  readonly positions: PositionManager;
  /** What the study measured, when a study has been run. */
  readonly evidence: EvidenceBook | undefined;
  /** Estimated correlation groups, when they have been computed. */
  readonly correlations: CorrelationGroups | undefined;
  /** Sources that may be watched but not traded on until measured. */
  readonly observationOnlySources: ReadonlySet<string>;

  private readonly recentSignals: Signal[] = [];
  private readonly recentEvents: MarketEvent[] = [];
  private readonly recentOrders: Order[] = [];
  private lastHealth: HealthReport[] = [];
  private regimeBySymbol = new Map<string, MarketRegime>();
  /** Measured hit rate per event type, refreshed once per cycle. */
  private hitRates: Record<string, { hitRate: number; sampleSize: number }> = {};
  /** Decisions whose horizon has passed but whose price is not published yet. */
  private pendingOutcomeCount = 0;

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
    this.activity = new ActivityLog({ clock: this.clock });
    this.funnels = new CycleFunnelHistory();
    this.positions = new PositionManager({ clock: this.clock });
    this.evidence = options.evidence ?? EvidenceBook.load(options.config.EVIDENCE_FILE);
    this.correlations =
      options.correlations ?? CorrelationGroups.load(options.config.CORRELATION_FILE);
    this.observationOnlySources = new Set(options.config.OBSERVATION_ONLY_SOURCES);

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

    // Resolved lazily through the agent, so a restored portfolio and a fresh
    // one label their positions the same way.
    const correlationGroupFor = (symbol: string) => this.correlationGroupFor(symbol);

    this.portfolio = restored
      ? Portfolio.restore(restored.portfolio, { clock: this.clock, correlationGroupFor })
      : new Portfolio({
          // Paper mode by construction: this is `initialCapital`, which resolves
          // to PAPER_CAPITAL_EUR outside live mode.
          initialCash: options.config.initialCapital,
          currency: options.config.BASE_CURRENCY,
          clock: this.clock,
          correlationGroupFor,
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
      this.positions.restore(restored.exitPlans ?? []);
      // Positions from a state file written before exits existed have no plan.
      // Adopting them with a default stop is the only honest option: leaving
      // them unmanaged would recreate the hole exits were built to close.
      for (const held of this.portfolio.openPositions) {
        this.positions.adoptIfUntracked(held, 5);
      }
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
        exitPlans: this.positions.serialize(),
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

  /** Recent activity, newest first — what the agent has been doing. */
  getActivity(limit = 100): ActivityEntry[] {
    return this.activity.recent(limit);
  }

  /** Recent cycle funnels, newest first — how far each cycle got, and why it stopped there. */
  getFunnels(limit?: number): CycleFunnel[] {
    return this.funnels.recent(limit);
  }

  getHealth(): HealthReport[] {
    return [...this.lastHealth];
  }

  /**
   * What the decisions actually did, per event type — empty until enough
   * horizons have elapsed for anything to be scored.
   */
  getHitRates(): { rates: Record<string, { hitRate: number; sampleSize: number }>; pending: number } {
    return { rates: { ...this.hitRates }, pending: this.pendingOutcomeCount };
  }

  getLlmProviderId(): string {
    return this.llm.id;
  }

  async refreshHealth(): Promise<HealthReport[]> {
    this.lastHealth = await checkStackHealth(this.stack);
    return this.lastHealth;
  }

  private recordError(stage: string, message: string): void {
    this.activity.error(stage, message);
    this.state.errors.unshift({ at: this.clock.now().toISOString(), stage, message });
    this.state.errors = this.state.errors.slice(0, 25);
  }

  /**
   * Refresh marks and return the prices used, so exits can be checked against
   * the same numbers the portfolio was valued with.
   */
  private async markPositions(): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    for (const position of this.portfolio.openPositions) {
      try {
        const quote = await this.stack.marketData.getQuote(position.symbol);
        const price = quote.quote.last ?? quote.quote.bid;
        if (price) {
          this.portfolio.mark(position.symbol, price);
          prices.set(position.symbol, price);
        }
      } catch (err) {
        // A position we cannot price is a reason to be careful, not a reason to
        // crash: the stale mark stays and the Risk Engine sees the same number.
        this.log.warn(
          { symbol: position.symbol, error: (err as Error).message },
          'could not refresh position mark',
        );
      }
    }
    return prices;
  }

  /**
   * Close positions whose stop, target or horizon says so.
   *
   * Exits deliberately do NOT go through the Risk Engine's per-order checks.
   * Those exist to gate *taking on* exposure; applying them to a close would
   * let a limit block the very action that reduces risk — a full portfolio
   * refusing to sell is how a bad position becomes a worse one. The engine
   * still sees the result, because the portfolio it reads next cycle reflects
   * it.
   */
  private async processExits(prices: Map<string, number>): Promise<void> {
    const positions = this.portfolio.openPositions;
    if (positions.length === 0) return;

    // A position whose price is unknown is one whose stop cannot be checked.
    // That is not a quiet state — it is the system being unable to enforce the
    // limit it sized the trade against.
    for (const symbol of this.positions.unpriceable(positions, prices)) {
      this.activity.warn('exit', `${symbol}: no usable price — stop could not be evaluated`);
    }

    for (const exit of this.positions.exitsDue(positions, prices)) {
      const held = positions.find((p) => p.symbol === exit.symbol);
      if (!held) continue;
      try {
        const order = await this.broker.placeOrder({
          symbol: exit.symbol,
          side: 'sell',
          quantity: held.quantity,
          type: 'market',
          clientOrderId: sha256(`exit|${exit.symbol}|${exit.reason}|${held.openedAt}`).slice(0, 24),
          reason: `${exit.reason}: ${exit.message}`.slice(0, 200),
        });
        this.positions.forget(exit.symbol);
        this.state.ordersPlaced += 1;
        this.recentOrders.unshift(order);
        this.recentOrders.splice(50);
        this.activity.record(
          exit.reason === 'take_profit' ? 'good' : 'warn',
          'exit',
          `${exit.symbol} closed — ${exit.message}`,
        );
        await this.discord?.order(order);
      } catch (err) {
        // A failed exit is the most dangerous failure in the system: the
        // position stays open with no working stop. It must be loud.
        this.recordError('exit', `${exit.symbol} (${exit.reason}): ${(err as Error).message}`);
      }
    }
  }

  /**
   * The price at the first session at or after a date, or undefined when that
   * session has not happened yet.
   *
   * A horizon that lands on a weekend or a holiday resolves to the next
   * trading day, which is why this asks for a window rather than a day.
   */
  private async priceAtOrAfter(symbol: string, at: Date): Promise<number | undefined> {
    const { bars } = await this.stack.marketData.getBars(symbol, '1Day', {
      start: at,
      // A week covers a weekend plus a holiday; beyond that the horizon is not
      // "just after" any more.
      end: new Date(at.getTime() + 7 * 86_400_000),
    });
    const bar = bars.find((candidate) => Date.parse(candidate.timestamp) >= at.getTime());
    return bar?.close;
  }

  /**
   * Fill in what actually happened to decisions whose horizon has run out.
   *
   * Without this the journal records what the system decided and never whether
   * it was right, which leaves `hitRateByEventType()` — fed to the model on
   * every subsequent signal — quoting a hit rate computed from nothing.
   *
   * Capped per cycle because each evaluation costs a historical-bars call. The
   * backlog is not urgent: an outcome that lands one cycle later is the same
   * outcome.
   */
  private async evaluateOutcomes(): Promise<void> {
    let entries: JournalEntry[];
    try {
      entries = await this.journal.readAll();
    } catch (err) {
      this.recordError('outcome', `could not read the journal: ${(err as Error).message}`);
      return;
    }

    const due = pendingFrom(entries, this.clock.now());
    let evaluated = 0;

    for (const entry of due.slice(0, OUTCOMES_PER_CYCLE)) {
      try {
        const priceAfter = await this.priceAtOrAfter(entry.asset, outcomeDueAt(entry));
        // No bar covering the horizon yet — the session has not closed, or the
        // provider has not published it. Not an error; try again next cycle.
        if (priceAfter === undefined) continue;

        const outcome = buildOutcome(entry, priceAfter, this.clock.now().toISOString());
        await this.journal.recordOutcome(entry.signalId!, outcome);
        // Keep the copy in hand current, so the rates computed below include
        // what this pass just learned.
        entry.outcome = outcome;
        evaluated += 1;
        this.activity.record(
          outcome.directionCorrect ? 'good' : 'warn',
          'outcome',
          `${entry.signal} ${entry.asset} after ${outcome.horizonDays}d: ${outcome.returnPct.toFixed(2)}% — ` +
            `${outcome.directionCorrect ? 'right' : 'wrong'}`,
        );
      } catch (err) {
        // A price we cannot fetch is a measurement we do not have, not a
        // failed cycle. It stays pending.
        this.log.debug(
          { asset: entry.asset, error: (err as Error).message },
          'could not evaluate outcome yet',
        );
      }
    }

    if (evaluated > 0 && due.length > evaluated) {
      this.activity.info('outcome', `${due.length - evaluated} decision(s) still awaiting a price`);
    }

    // Cached from the read already done, so the dashboard and the diagnostic
    // can report the real hit rate without touching the disk per request.
    this.hitRates = hitRatesFrom(entries);
    this.pendingOutcomeCount = due.length - evaluated;
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
    const funnel = new CycleFunnelBuilder(this.state.cycles, this.state.lastCycleAt);

    try {
      await this.runFunnelledCycle(options, cycleStart, funnel);
    } finally {
      // Recorded on every exit, early or not — a funnel that only appeared
      // after a full run would say nothing about the runs that stopped early,
      // which is exactly the cycles an operator most needs explained.
      this.funnels.record(funnel.finish(this.clock.now().toISOString()));
    }
  }

  private async runFunnelledCycle(
    options: { since?: Date },
    cycleStart: number,
    funnel: CycleFunnelBuilder,
  ): Promise<void> {
    const marks = await this.markPositions();
    // Before anything else, and regardless of halts: a halt stops new risk
    // being taken, never the closing of risk already on the books.
    await this.processExits(marks);

    // Scoring past decisions is independent of whether this cycle finds
    // anything, and a halt is no reason to stop learning what the last ones
    // were worth.
    await this.evaluateOutcomes();

    // Halting conditions are checked before any work: if trading is halted,
    // there is no point paying for LLM analysis this cycle.
    const halts = this.riskEngine.haltingConditions(this.portfolio.snapshot());
    const wasHalted = this.state.halted;
    this.state.halted = halts.length > 0;
    this.state.haltReasons = halts.map((h) => h.message);
    if (halts.length > 0) {
      this.log.warn({ reasons: this.state.haltReasons }, 'trading halted this cycle');
      this.activity.warn('halt', this.state.haltReasons.join(' · '));
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
      if (result.stats.kept > 0) {
        this.activity.info('ingest', `${result.stats.kept} new document(s)`);
      }
      const failuresByAdapter: Record<string, number> = {};
      for (const failure of result.stats.failures) {
        this.recordError('ingestion', `${failure.adapter}: ${failure.error}`);
        failuresByAdapter[failure.adapter] = (failuresByAdapter[failure.adapter] ?? 0) + 1;
      }
      funnel.step('ingest', documents.length, failuresByAdapter);
    } catch (err) {
      this.recordError('ingestion', (err as Error).message);
      funnel.step('ingest', 0, { 'ingestion failed': 1 });
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
      for (const detected of events.slice(0, 5)) {
        this.activity.info(
          'event',
          `${detected.type} · ${detected.verification.status} · materiality ${detected.materiality.toFixed(2)} — ${detected.headline.slice(0, 120)}`,
        );
      }
      this.recentEvents.unshift(...events.slice(0, 10));
      this.recentEvents.splice(50);
      funnel.step(
        'events',
        events.length,
        detection.stats.contradicted > 0 ? { contradicted: detection.stats.contradicted } : undefined,
      );
    } catch (err) {
      this.recordError('event_detection', (err as Error).message);
      funnel.step('events', 0, { 'detection failed': 1 });
      return;
    }

    const { kept: worthAnalysing, droppedByReason: gateDrops } = evaluateAnalysisGate(events, {
      // A watched source's events may cross the confidence floor, because
      // whether to believe it is precisely the question observation exists to
      // answer. The risk engine still refuses the order.
      observationSources: this.observationOnlySources,
      observationBudget: this.config.OBSERVATION_ANALYSIS_PER_CYCLE,
    });
    funnel.step('analysis_gate', worthAnalysing.length, gateDrops);
    if (events.length > 0 && worthAnalysing.length === 0) {
      // The most common reason nothing trades, and previously invisible: the
      // events were real but not worth spending an LLM call on.
      this.activity.info('gate', `${events.length} event(s), none cleared the analysis gate`);
    }

    // The study's one veto. A category it measured drifting against a long is
    // dropped here rather than analysed and then rejected downstream: paying
    // for an LLM call to interpret an event we have measured as a losing entry
    // is the most expensive way to reach the same "no".
    const evidenceDrops: Record<string, number> = {};
    const candidates = worthAnalysing.filter((candidate) => {
      const blocked = this.evidence?.blocks(candidate.type);
      if (!blocked) return true;
      evidenceDrops[blocked.category] = (evidenceDrops[blocked.category] ?? 0) + 1;
      this.activity.record(
        'warn',
        'evidence',
        `${candidate.type} skipped — ${blocked.category} measured ${blocked.horizon?.meanAbnormalPct}% abnormal ` +
          `at +${blocked.horizon?.sessions}d over ${blocked.sampleSize} filings (t=${blocked.horizon?.tStat})`,
      );
      return false;
    });
    funnel.step('evidence_gate', candidates.length, evidenceDrops);

    if (candidates.length === 0) return;

    // --- Analyse, score, decide -------------------------------------------
    const analysed = candidates.slice(0, 5);
    funnel.step(
      'analysed',
      analysed.length,
      candidates.length > analysed.length
        ? { 'not processed — top 5 only': candidates.length - analysed.length }
        : undefined,
    );

    // Signal/risk/order outcomes are read back from AgentState's own counters
    // rather than threaded through processEvent's return value: they are
    // already incremented in exactly the right places, and a second, parallel
    // way of counting the same thing is a second way for the two to disagree.
    const signalsBefore = this.state.signalsGenerated;
    const ordersBefore = this.state.ordersPlaced;
    const riskRejectedBefore = this.state.ordersRejectedByRisk;
    const approvalRejectedBefore = this.state.ordersRejectedByApproval;

    let observationBlocked = 0;
    for (const event of analysed) {
      try {
        const result = await this.processEvent(event, documents);
        if (result.observationBlocked) observationBlocked += 1;
      } catch (err) {
        this.recordError('analysis', `${event.id}: ${(err as Error).message}`);
      }
    }

    const signalsCount = this.state.signalsGenerated - signalsBefore;
    funnel.step(
      'signals',
      signalsCount,
      analysed.length > signalsCount ? { 'no signal': analysed.length - signalsCount } : undefined,
    );

    if (signalsCount > 0) {
      const riskRejected = this.state.ordersRejectedByRisk - riskRejectedBefore;
      const approvalRejected = this.state.ordersRejectedByApproval - approvalRejectedBefore;
      const ordersCount = this.state.ordersPlaced - ordersBefore;
      const riskApproved = ordersCount + approvalRejected;
      // Never reached the Risk Engine at all: no symbol/price to trade on, or
      // trading was halted this cycle.
      const notEvaluated = signalsCount - riskApproved - riskRejected;

      const riskReasons: Record<string, number> = {};
      if (riskRejected > 0) riskReasons['risk rejected'] = riskRejected;
      if (observationBlocked > 0) riskReasons['observation only'] = observationBlocked;
      // Whatever is left never reached the engine for a duller reason: no
      // symbol or price to trade on, or trading halted this cycle. Reported
      // apart from the observation gate, because "we chose not to trust this
      // source yet" and "there was no price" are different answers.
      const otherwiseUnevaluated = notEvaluated - observationBlocked;
      if (otherwiseUnevaluated > 0) riskReasons['not tradeable or halted'] = otherwiseUnevaluated;
      funnel.step('risk', riskApproved, riskReasons);

      if (riskApproved > 0) {
        funnel.step(
          'orders',
          ordersCount,
          approvalRejected > 0 ? { 'approval rejected': approvalRejected } : undefined,
        );
      }
    }

    metrics.observe('agent.cycle', this.clock.nowMs() - cycleStart);
  }

  /**
   * Analyse one event and, if everything allows it, act on it.
   *
   * Returns what the cycle needs to explain itself: whether the observation
   * gate is the reason no order followed. That is reported rather than folded
   * into "not tradeable", because "we chose not to trust this source yet" and
   * "there was no price" are different answers to the same silence.
   */
  private async processEvent(
    event: MarketEvent,
    documents: NormalizedDocument[],
  ): Promise<{ observationBlocked: boolean }> {
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

    // From the cache refreshed at the top of this cycle rather than a fresh
    // read per event: the journal is read once, and every event in the cycle
    // is shown the same numbers.
    const historical = this.hitRates[event.type];

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
      // The reason no signal came out is the most useful line in the feed: it
      // separates "the model failed" from "the model looked and declined".
      this.activity.record(
        skipped?.startsWith('llm error') ? 'error' : 'info',
        'no-signal',
        `${event.type}: ${skipped ?? 'no hypothesis'}`,
      );
      return { observationBlocked: false };
    }

    this.state.signalsGenerated += 1;
    this.recentSignals.unshift(signal);
    this.recentSignals.splice(50);
    this.activity.good(
      'signal',
      `${signal.action} ${signal.asset} · score ${signal.score.toFixed(3)} · ${signal.catalyst.slice(0, 100)}`,
    );

    // --- Risk ------------------------------------------------------------
    let riskDecision: RiskDecision | undefined;
    let order: Order | undefined;

    // Watched but not yet trusted: the analysis above has already been paid
    // for and journalled, which is the point — the decision is recorded and
    // will be scored — but a source the study has never measured does not get
    // to move money on the strength of it.
    const observation = observationVerdict(event, this.observationOnlySources, this.evidence);
    if (!observation.trades) {
      this.activity.warn('observation', `${signal.action} ${signal.asset} not placed — ${observation.reason}`);
    }

    const tradeable =
      observation.trades &&
      (signal.action === 'BUY' || signal.action === 'SELL') &&
      symbol !== undefined &&
      price !== undefined;

    if (tradeable && !this.state.halted) {
      // Without a group the engine skips the correlated-exposure check
      // entirely — the limit was configured, displayed, and inert.
      const correlationGroup = this.correlationGroupFor(symbol);
      riskDecision = this.riskEngine.evaluate(
        {
          symbol,
          action: signal.action,
          score: signal.score,
          price: price!,
          priceAgeSeconds,
          ...(regime ? { volatilityPct: regime.volatilityPct } : {}),
          ...(correlationGroup ? { correlationGroup } : {}),
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
          // The stop the sizing assumed is now a stop that will actually fire.
          if (riskDecision.side === 'buy' && riskDecision.stopPrice !== undefined) {
            const plan = this.positions.track({
              symbol: riskDecision.symbol,
              entryPrice: order.filledPrice ?? price!,
              stopPrice: riskDecision.stopPrice,
              ...(signal.expectedHorizon ? { horizon: signal.expectedHorizon } : {}),
              signalId: signal.id,
            });
            this.activity.info(
              'plan',
              `${plan.symbol}: stop ${plan.stopPrice} · target ${plan.takeProfitPrice} · expires ${plan.expiresAt.slice(0, 10)}`,
            );
          }
          this.activity.good(
            'order',
            `${order.side.toUpperCase()} ${order.filledQuantity} ${order.symbol} @ ${order.filledPrice?.toFixed(4) ?? '?'} — ${order.status}`,
          );
          this.recentOrders.unshift(order);
          this.recentOrders.splice(50);
          await this.discord?.order(order, signal);
        } catch (err) {
          this.recordError('execution', (err as Error).message);
        }
      } else if (riskDecision.verdict !== 'approved') {
        this.state.ordersRejectedByRisk += 1;
        // A refusal is the risk engine working, so it is logged as information
        // rather than as a fault — with the rule that fired, which is the part
        // worth reading.
        this.activity.warn(
          'risk',
          `refused ${signal.action} ${signal.asset}: ${riskDecision.rejections.map((r) => r.rule).join(', ')}`,
        );
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

    return { observationBlocked: !observation.trades };
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

  /**
   * The correlated-exposure group for a symbol.
   *
   * Estimated groups first, then the curated sector map, then nothing. The
   * order is deliberate: the estimate is measured and covers whatever universe
   * it was run over, while the sector map is a dozen hand-written companies
   * that happens to be all there is until a correlation run exists.
   *
   * Returning undefined means the Risk Engine skips the check for this order —
   * which is what it silently did for every order before this existed.
   */
  correlationGroupFor(symbol: string): string | undefined {
    return this.correlations?.groupFor(symbol) ?? entityForTicker(symbol)?.sector;
  }

  /**
   * Which source is deciding groups, for the diagnostic to report.
   *
   * Never "none": the curated sector map always exists, so the question is
   * only whether a measured estimate has superseded it. Whether any *given*
   * symbol has a group is a separate question — see `correlationGroupFor`.
   */
  correlationSource(): 'estimated' | 'sector_map' {
    return this.correlations ? 'estimated' : 'sector_map';
  }

  /** Age of the most recent successful cycle, in seconds. */
  cycleAgeSeconds(): number | undefined {
    return this.state.lastCycleAt ? ageSeconds(this.state.lastCycleAt, this.clock) : undefined;
  }
}
