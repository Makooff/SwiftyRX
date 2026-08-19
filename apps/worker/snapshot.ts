import { execFileSync } from 'node:child_process';
import type { AppConfig } from '../../src/config/env.js';
import { diagnose, summarise, type Diagnostic, type DoctorSummary } from '../../src/config/doctor.js';
import type { HealthReport } from '../../src/domain/types.js';
import { FUNNEL_STAGE_LABELS, type CycleFunnel } from '../../src/monitoring/cycle-funnel.js';
import type { ActivityEntry } from '../../src/monitoring/activity-log.js';
import { isMeasurable } from '../../src/strategy/evidence.js';
import type { AgentState, TradingAgent } from './agent.js';

/**
 * One flat snapshot of everything an operator needs to diagnose the live
 * process from outside it — the answer to "paste me the snapshot".
 *
 * Built once here and reused by both `/api/diagnostic` and `npm run
 * snapshot` (which fetches it from there): one place decides what a
 * diagnostic contains, so the two can never show something different for the
 * same running process.
 */

export interface GitInfo {
  branch?: string;
  commit?: string;
  dirty?: boolean;
}

export interface AgentSnapshot {
  generatedAt: string;
  git: GitInfo;
  posture: { diagnostics: Diagnostic[]; summary: DoctorSummary };
  health: HealthReport[];
  agentState: AgentState;
  cycleAgeSeconds?: number;
  /** Last cycle first, then earlier ones. */
  funnels: CycleFunnel[];
  activity: ActivityEntry[];
  portfolio: {
    totalValue: number;
    cash: number;
    currency: string;
    totalReturnPct: number;
    drawdownPct: number;
    positions: Array<{
      symbol: string;
      quantity: number;
      averagePrice: number;
      marketValue: number;
      unrealisedPnl: number;
      exitPlan?: { stopPrice: number; takeProfitPrice: number; expiresAt: string };
    }>;
  };
  evidence?: {
    generatedAt: string;
    windowYears: number;
    symbols: number;
    categoriesMeasured: number;
    categoriesSupported: number;
  };
  /** What the decisions actually did, once their horizons elapsed. */
  outcomes: {
    rates: Record<string, { hitRate: number; sampleSize: number }>;
    /** Horizon passed, price not published yet. */
    pending: number;
  };
  /**
   * Recent event types no study can ever measure, so the evidence gate can
   * never have an opinion on them however they perform.
   */
  unmeasurableEventTypes: Array<{ type: string; recentEvents: number }>;
  /** Sources watched but not traded on, and whether each can be promoted yet. */
  observation: {
    sources: string[];
    /** Event types seen from those sources that no study has measured yet. */
    unmeasuredTypes: string[];
  };
  /** Whether the correlated-exposure limit has groups to apply to at all. */
  correlation: {
    source: 'estimated' | 'sector_map';
    generatedAt?: string;
    windowDays?: number;
    symbols?: number;
    /** Held positions the limit currently cannot constrain. */
    ungroupedPositions: string[];
  };
}

function gitInfo(): GitInfo {
  const run = (args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  try {
    return {
      branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
      commit: run(['rev-parse', '--short', 'HEAD']),
      dirty: run(['status', '--porcelain']).length > 0,
    };
  } catch {
    // Not a git checkout — e.g. deployed from a tarball. Not worth failing
    // the whole snapshot over.
    return {};
  }
}

/**
 * Recent event types the evidence gate structurally cannot reach, counted.
 *
 * Reported even when empty is not useful, so the caller drops empties — but a
 * non-empty list means the agent is acting on events no study result could
 * ever veto, which is worth seeing rather than inferring.
 */
export function unmeasurableFrom(agent: TradingAgent): AgentSnapshot['unmeasurableEventTypes'] {
  const counts = new Map<string, number>();
  for (const event of agent.getEvents()) {
    if (isMeasurable(event.type)) continue;
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, recentEvents]) => ({ type, recentEvents }))
    .sort((a, b) => b.recentEvents - a.recentEvents);
}

export function buildSnapshot(agent: TradingAgent, config: AppConfig): AgentSnapshot {
  const portfolio = agent.portfolio;
  const exitPlans = new Map(agent.positions.serialize().map((plan) => [plan.symbol, plan]));
  const diagnostics = diagnose(config);
  const cycleAge = agent.cycleAgeSeconds();

  return {
    generatedAt: new Date().toISOString(),
    git: gitInfo(),
    posture: { diagnostics, summary: summarise(diagnostics) },
    health: agent.getHealth(),
    agentState: agent.getState(),
    ...(cycleAge !== undefined ? { cycleAgeSeconds: cycleAge } : {}),
    funnels: agent.getFunnels(),
    activity: agent.getActivity(50),
    portfolio: {
      totalValue: portfolio.totalValue,
      cash: portfolio.availableCash,
      currency: portfolio.currency,
      totalReturnPct: portfolio.totalReturnPct,
      drawdownPct: portfolio.drawdownPct,
      positions: portfolio.openPositions.map((position) => {
        const plan = exitPlans.get(position.symbol);
        return {
          symbol: position.symbol,
          quantity: position.quantity,
          averagePrice: position.averagePrice,
          marketValue: position.marketValue,
          unrealisedPnl: position.unrealisedPnl,
          ...(plan
            ? {
                exitPlan: {
                  stopPrice: plan.stopPrice,
                  takeProfitPrice: plan.takeProfitPrice,
                  expiresAt: plan.expiresAt,
                },
              }
            : {}),
        };
      }),
    },
    outcomes: agent.getHitRates(),
    unmeasurableEventTypes: unmeasurableFrom(agent),
    observation: {
      sources: [...agent.observationOnlySources].sort(),
      unmeasuredTypes: [
        ...new Set(
          agent
            .getEvents()
            .filter((event) =>
              event.sources.length > 0 &&
              event.sources.every((source) => agent.observationOnlySources.has(source)) &&
              agent.evidence?.forEventType(event.type)?.status === undefined,
            )
            .map((event) => event.type),
        ),
      ].sort(),
    },
    correlation: {
      source: agent.correlationSource(),
      ...(agent.correlations
        ? {
            generatedAt: agent.correlations.file.generatedAt,
            windowDays: agent.correlations.file.windowDays,
            symbols: agent.correlations.symbolCount,
          }
        : {}),
      ungroupedPositions: portfolio.openPositions
        .filter((position) => agent.correlationGroupFor(position.symbol) === undefined)
        .map((position) => position.symbol),
    },
    ...(agent.evidence
      ? {
          evidence: {
            generatedAt: agent.evidence.file.generatedAt,
            windowYears: agent.evidence.file.windowYears,
            symbols: agent.evidence.file.symbols,
            categoriesMeasured: agent.evidence.file.categories.length,
            categoriesSupported: agent.evidence.file.categories.filter((c) => c.status === 'supported').length,
          },
        }
      : {}),
  };
}

/** Renders a snapshot as the one text file `npm run snapshot` writes. */
export function formatSnapshotText(snapshot: AgentSnapshot): string {
  const lines: string[] = [`AI Market Agent — snapshot generated ${snapshot.generatedAt}`];
  const section = (title: string) => lines.push('', `=== ${title} ===`, '');

  section('Git');
  lines.push(`  branch    ${snapshot.git.branch ?? 'unknown'}`);
  lines.push(`  commit    ${snapshot.git.commit ?? 'unknown'}`);
  lines.push(`  dirty     ${snapshot.git.dirty ?? 'unknown'}`);

  section('Configuration posture');
  lines.push(`  ${snapshot.posture.summary.headline}`);
  for (const d of snapshot.posture.diagnostics) {
    lines.push(`  ${d.status.padEnd(10)} ${d.label} — ${d.impact}`);
  }

  section('Source health');
  if (snapshot.health.length === 0) lines.push('  not yet checked');
  for (const source of snapshot.health) {
    lines.push(
      `  ${source.state.padEnd(12)} ${source.adapter} (${source.kind})${source.detail ? ` — ${source.detail}` : ''}`,
    );
  }

  section('Cycle funnel');
  lines.push(
    `  cycles run: ${snapshot.agentState.cycles} · last cycle ${
      snapshot.cycleAgeSeconds !== undefined ? `${Math.round(snapshot.cycleAgeSeconds)}s ago` : 'never'
    }`,
  );
  const [latest, ...previous] = snapshot.funnels;
  if (!latest) {
    lines.push('  no cycle has run yet');
  } else {
    lines.push(`  latest: ${latest.summary}`);
    for (const step of latest.steps) {
      const reasons = step.reasons
        ? ` (${Object.entries(step.reasons)
            .map(([reason, n]) => `${n} ${reason}`)
            .join(', ')})`
        : '';
      lines.push(`    ${FUNNEL_STAGE_LABELS[step.stage].padEnd(24)} ${step.count}${reasons}`);
    }
    if (previous.length > 0) {
      lines.push(`  previous ${previous.length} cycle(s):`);
      for (const f of previous) lines.push(`    #${f.cycleId} ${f.finishedAt} — ${f.summary}`);
    }
  }

  section('Recent activity');
  if (snapshot.activity.length === 0) lines.push('  nothing yet');
  for (const entry of snapshot.activity.slice(0, 30)) {
    lines.push(`  ${entry.at} [${entry.level}] ${entry.stage}: ${entry.message}`);
  }

  section('Portfolio');
  const p = snapshot.portfolio;
  lines.push(
    `  total value ${p.totalValue.toFixed(2)} ${p.currency} · cash ${p.cash.toFixed(2)} · ` +
      `return ${p.totalReturnPct.toFixed(2)}% · drawdown ${p.drawdownPct.toFixed(2)}%`,
  );
  if (p.positions.length === 0) lines.push('  no open positions');
  for (const pos of p.positions) {
    const exit = pos.exitPlan
      ? ` (stop ${pos.exitPlan.stopPrice}, target ${pos.exitPlan.takeProfitPrice}, expires ${pos.exitPlan.expiresAt.slice(0, 10)})`
      : ' (no exit plan)';
    lines.push(
      `  ${pos.symbol}: ${pos.quantity} @ ${pos.averagePrice.toFixed(2)}, value ${pos.marketValue.toFixed(2)}, ` +
        `unrealised ${pos.unrealisedPnl.toFixed(2)}${exit}`,
    );
  }

  section('Decision outcomes');
  const rates = Object.entries(snapshot.outcomes.rates);
  if (rates.length === 0) {
    lines.push('  nothing scored yet — no decision has passed its horizon with a published price');
  }
  for (const [type, { hitRate, sampleSize }] of rates.sort((a, b) => b[1].sampleSize - a[1].sampleSize)) {
    // n is printed beside every rate: 3 out of 4 is not a hit rate.
    lines.push(`  ${type.padEnd(22)} ${(hitRate * 100).toFixed(1)}% of n=${sampleSize}`);
  }
  if (snapshot.outcomes.pending > 0) {
    lines.push(`  ${snapshot.outcomes.pending} decision(s) due but not yet priced`);
  }

  if (snapshot.unmeasurableEventTypes.length > 0) {
    section('Event types no study can measure');
    lines.push('  These pass the evidence gate by default — no category maps onto them,');
    lines.push('  so a study result could never block them however they perform.');
    for (const { type, recentEvents } of snapshot.unmeasurableEventTypes) {
      lines.push(`  ${type.padEnd(22)} ${recentEvents} recent event(s)`);
    }
  }

  if (snapshot.observation.sources.length > 0) {
    section('Sources in observation');
    lines.push(`  watched but not traded on: ${snapshot.observation.sources.join(', ')}`);
    lines.push('  Their events are analysed and journalled; no order is placed until the');
    lines.push('  study measures the category. Promotion is automatic.');
    if (snapshot.observation.unmeasuredTypes.length > 0) {
      lines.push(`  still unmeasured: ${snapshot.observation.unmeasuredTypes.join(', ')}`);
    }
  }

  section('Correlated-exposure groups');
  if (snapshot.correlation.source === 'estimated') {
    lines.push(
      `  estimated over ${snapshot.correlation.windowDays}d across ${snapshot.correlation.symbols} symbol(s), ` +
        `generated ${snapshot.correlation.generatedAt?.slice(0, 10)}`,
    );
  } else {
    lines.push('  no estimate on record — falling back to the curated sector map (12 companies).');
    lines.push('  Run: npm run correlations -- --out');
  }
  if (snapshot.correlation.ungroupedPositions.length > 0) {
    // A held position with no group is one the limit cannot see, so the cap is
    // not being applied to it whatever the configured percentage says.
    lines.push(
      `  !! NOT constrained by the limit (no group): ${snapshot.correlation.ungroupedPositions.join(', ')}`,
    );
  }

  section('Evidence ledger');
  if (!snapshot.evidence) {
    lines.push('  no study has been run');
  } else {
    lines.push(
      `  ${snapshot.evidence.symbols} symbols over ${snapshot.evidence.windowYears}y, ` +
        `generated ${snapshot.evidence.generatedAt.slice(0, 10)}`,
    );
    lines.push(`  ${snapshot.evidence.categoriesSupported} of ${snapshot.evidence.categoriesMeasured} categories currently supported`);
  }

  section('Latest errors');
  if (snapshot.agentState.errors.length === 0) lines.push('  none');
  for (const err of snapshot.agentState.errors.slice(0, 15)) {
    lines.push(`  ${err.at} [${err.stage}] ${err.message}`);
  }

  return `${lines.join('\n')}\n`;
}
