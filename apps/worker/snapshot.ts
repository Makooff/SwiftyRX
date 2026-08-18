import { execFileSync } from 'node:child_process';
import type { AppConfig } from '../../src/config/env.js';
import { diagnose, summarise, type Diagnostic, type DoctorSummary } from '../../src/config/doctor.js';
import type { HealthReport } from '../../src/domain/types.js';
import { FUNNEL_STAGE_LABELS, type CycleFunnel } from '../../src/monitoring/cycle-funnel.js';
import type { ActivityEntry } from '../../src/monitoring/activity-log.js';
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
