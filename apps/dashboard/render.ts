import type { HealthReport } from '../../src/domain/types.js';
import type { Order } from '../../src/execution/broker/types.js';
import type { MarketEvent } from '../../src/intelligence/types.js';
import type { Signal } from '../../src/strategy/signals/types.js';
import type { ActivityEntry } from '../../src/monitoring/activity-log.js';
import {
  FUNNEL_STAGE_LABELS_FR,
  funnelReasonFr,
  summariseFunnelFr,
  type CycleFunnel,
} from '../../src/monitoring/cycle-funnel.js';
import type { AgentState } from '../worker/agent.js';

/**
 * Server-rendered dashboard.
 *
 * One HTML file, no build step, no client framework. The operator needs to see
 * portfolio, signals, events, orders and system health — none of which needs a
 * SPA, and all of which needs to still work when something is broken.
 *
 * On the AI reasoning panel: it shows the model's *summary*, the factors that
 * fed the score, the sources and the stated uncertainties. It does not show
 * chain-of-thought, and there is none to show — the API is not asked for
 * reasoning content.
 */

export interface DashboardData {
  mode: string;
  paperTrading: boolean;
  liveTrading: boolean;
  currency: string;
  portfolio: {
    initialCapital: number;
    totalValue: number;
    cash: number;
    totalReturnPct: number;
    drawdownPct: number;
    maxDrawdownPct: number;
    exposurePct: number;
    positions: Array<{
      symbol: string;
      quantity: number;
      averagePrice: number;
      marketValue: number;
      unrealisedPnl: number;
    }>;
  };
  /** Last cycle's funnel first, then earlier ones — how far each got, and why it stopped there. */
  funnels: CycleFunnel[];
  /** Seconds since the last completed cycle. Absent when none has run yet. */
  cycleAgeSeconds?: number;
  signals: Signal[];
  /**
   * Which feeds are actually running.
   *
   * "Documents ingested: none" is the system's most common state and its most
   * ambiguous one: a broken fetch and a feed set that publishes nothing about
   * companies look identical from the funnel alone.
   */
  coverage: {
    official: number;
    news: number;
    unknownIds: string[];
    /**
     * Whether X ingestion is switched on.
     *
     * Read from the configuration rather than inferred from the health table,
     * because absence of an X adapter and a disabled one are different facts
     * and only one of them is a setting.
     */
    xIngestion: boolean;
  };
  events: MarketEvent[];
  orders: Order[];
  health: HealthReport[];
  agent: AgentState;
  activity: ActivityEntry[];
  /** Effective configuration, shown read-only. Never contains a credential. */
  settings: Array<{ label: string; value: string; note?: string }>;
  /** Stop, target and deadline for each open position. */
  exitPlans: Array<{ symbol: string; stopPrice: number; takeProfitPrice: number; expiresAt: string }>;
  /** What past decisions actually did, once their horizons elapsed. */
  outcomes: {
    rates: Record<string, { hitRate: number; sampleSize: number }>;
    pending: number;
  };
  /** Recent event types no study result could ever gate. */
  unmeasurableEventTypes: Array<{ type: string; recentEvents: number }>;
  /** What the event study measured, when one has been run. */
  evidence?: {
    generatedAt: string;
    windowYears: number;
    symbols: number;
    benchmark?: string;
    roundTripCostPct: number;
    categories: Array<{
      category: string;
      eventType?: string;
      status: string;
      sampleSize: number;
      clusters: number;
      horizon?: { sessions: number; meanAbnormalPct: number; meanNetOfCostsPct: number; tStat: number };
    }>;
  };
  llmProvider: string;
  /**
   * What analysis has cost today against its ceiling.
   *
   * Live state, not configuration: the settings panel already says what the
   * limit is, and the only question worth answering from a phone is how close
   * to it the day has got. Absent when no ceiling is configured.
   */
  budget?: { limitUsd: number; spentUsd: number; remainingUsd: number; exhausted: boolean };
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A URL safe to put in an href.
 *
 * These come from RSS feeds and provider payloads — text we did not write. A
 * `javascript:` or `data:` URL in a feed item would otherwise become a live
 * script the moment someone clicks a headline on their own dashboard. Only
 * http and https survive; anything else renders as unlinked text.
 */
function safeHref(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return escapeHtml(parsed.toString());
  } catch {
    // Not a URL at all. Nothing to link to.
    return undefined;
  }
}

function pnlClass(value: number): string {
  return value > 0 ? 'pos' : value < 0 ? 'neg' : '';
}

function formatAge(seconds: number | undefined): string {
  if (seconds === undefined) return 'never run';
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function funnelReasonsText(reasons: Record<string, number> | undefined): string {
  if (!reasons) return '';
  return Object.entries(reasons)
    .map(([reason, n]) => `${n} ${escapeHtml(funnelReasonFr(reason))}`)
    .join(', ');
}

function funnelStepRows(steps: CycleFunnel['steps']): string {
  return steps
    .map(
      (step) => `<tr>
        <td>${escapeHtml(FUNNEL_STAGE_LABELS_FR[step.stage])}</td>
        <td class="count">${step.count}</td>
        <td class="muted">${funnelReasonsText(step.reasons)}</td>
      </tr>`,
    )
    .join('');
}

/**
 * The three sentences somebody who did not build this needs, in French.
 *
 * The funnel table below says the same thing precisely; this says it in the
 * order a person asks it — what did you read, what did you make of it, and why
 * is there nothing in my portfolio. Everything here is read from the cycle's
 * own steps, so it cannot claim a state the funnel contradicts.
 */
function briefingFr(
  funnel: CycleFunnel | undefined,
  coverage: DashboardData['coverage'],
  budget: DashboardData['budget'],
): string {
  if (!funnel) {
    return `<p class="say">Aucun cycle n’a encore tourné. Le bot vient de démarrer :
      laisse-lui une minute, la page se rafraîchit toute seule.</p>`;
  }

  const countAt = (stage: CycleFunnel['steps'][number]['stage']): number | undefined =>
    funnel.steps.find((step) => step.stage === stage)?.count;

  const read = countAt('ingest') ?? 0;
  const events = countAt('events') ?? 0;
  const analysed = countAt('analysed') ?? 0;
  const orders = countAt('orders') ?? 0;
  const lines: string[] = [];

  lines.push(
    read === 0
      ? 'Le bot n’a trouvé <strong>aucun article nouveau</strong> à ce cycle.'
      : `Le bot a lu <strong>${read}</strong> article(s).`,
  );

  // The single most common cause of a permanently empty funnel, and until now
  // it was only stated in English in a grey note below the table. An operator
  // watching "0 articles" cycle after cycle needs the cause here, next to the
  // symptom, with the line to change.
  if (read === 0 && coverage.news === 0) {
    lines.push(
      'C’est <strong>normal</strong> : seules les sources officielles sont activées ' +
        '(banques centrales, statistiques). Elles publient quelques fois par semaine, ' +
        'pas en continu. Pour ajouter les actualités d’entreprises — Reuters, CNBC, FT — ' +
        'mets <span class="mono">ENABLED_SOURCES=all</span> dans ton fichier ' +
        '<span class="mono">.env</span>, puis relance.',
    );
  }

  if (read > 0) {
    lines.push(
      events === 0
        ? 'Rien dedans ne ressemblait à un événement de marché.'
        : `Il y a repéré <strong>${events}</strong> événement(s), et en a analysé <strong>${analysed}</strong> en détail.`,
    );
  }

  // The last step reached is the one that explains the silence, and its own
  // reasons are the only honest answer to "why not".
  const last = funnel.steps[funnel.steps.length - 1];
  if (orders > 0) {
    lines.push(`Il a passé <strong>${orders}</strong> ordre(s) — visibles plus bas.`);
  } else if (last && last.reasons && Object.keys(last.reasons).length > 0) {
    const why = Object.entries(last.reasons)
      .map(([reason, n]) => `${n} ${funnelReasonFr(reason)}`)
      .join(', ');
    lines.push(`<strong>Aucun ordre passé</strong> — ${escapeHtml(why)}.`);
  } else if (analysed > 0) {
    lines.push('<strong>Aucun ordre passé</strong> : rien n’a paru assez solide pour agir.');
  } else {
    lines.push('<strong>Aucun ordre passé</strong> — il n’y avait rien à analyser.');
  }

  // The number an operator actually wants from a phone. Only shown when a
  // ceiling exists: "$0.42 spent" against nothing is trivia, whereas "$0.42 of
  // $5" is a decision about whether tomorrow needs a bigger budget.
  if (budget && budget.limitUsd > 0) {
    lines.push(
      budget.exhausted
        ? `<strong>Budget d’analyse épuisé</strong> : $${budget.spentUsd} dépensés sur ` +
            `$${budget.limitUsd} par jour. Le bot continue de lire les actualités mais ` +
            'n’analyse plus rien jusqu’à demain. Pour relever le plafond : ' +
            '<span class="mono">MAX_DAILY_LLM_COST_USD</span> dans le ' +
            '<span class="mono">.env</span>.'
        : `Analyse : <strong>$${budget.spentUsd}</strong> dépensés aujourd’hui sur ` +
            `un plafond de $${budget.limitUsd}.`,
    );
  }

  // Stated here because the alternative is that nobody reads it. The health
  // table already reports "disabled" for the x adapter, in English, in a list
  // of adapters — which is exactly how someone can run this for months
  // believing it watches Twitter. It does not, and that is a configuration
  // choice, not a fault.
  if (!coverage.xIngestion) {
    lines.push(
      '<strong>Twitter / X : éteint.</strong> Aucun tweet n’est lu. ' +
        'Les lectures X sont facturées au post, et surtout un tweet seul ne peut ' +
        'pas déclencher d’ordre : un événement dont toutes les sources sont ' +
        'sociales est écarté avant même d’être analysé. Un tweet ne compte que ' +
        's’il rejoint une dépêche ou un dépôt officiel disant la même chose.',
    );
  }

  return lines.map((line) => `<p class="say">${line}</p>`).join('');
}

/** A section folded away by default — present, not competing for attention. */
function foldable(title: string, body: string): string {
  return `<section class="fold">
    <details data-fold="${escapeHtml(title)}">
      <summary><span class="fold-title">${escapeHtml(title)}</span></summary>
      <div class="fold-body">${body}</div>
    </details>
  </section>`;
}

type VerdictTone = 'ok' | 'warn' | 'bad';

/**
 * The one thing worth reading first: is this working, and what is it doing?
 *
 * A dashboard of ten equal panels makes a person reconstruct that answer every
 * time, and the two states it most needs to separate — quietly working, and
 * stuck — look identical when reconstructed from a portfolio that has not
 * moved. So the answer is computed once, stated in a sentence, and given the
 * only large piece of colour on the page.
 */
function verdict(data: DashboardData): { tone: VerdictTone; headline: string; detail: string } {
  const age = data.cycleAgeSeconds;
  const unavailable = data.health.filter((report) => report.state === 'unavailable');

  if (data.agent.halted) {
    return {
      tone: 'bad',
      headline: 'Trading halted',
      detail: data.agent.haltReasons.join(' · '),
    };
  }

  if (data.agent.cycles === 0 || age === undefined) {
    return {
      tone: 'warn',
      headline: 'No cycle has run yet',
      detail: 'The agent has not completed a pass. If this persists, check the service logs.',
    };
  }

  // Cycles are paced by INGEST_INTERVAL_SECONDS, 60 by default. Five minutes
  // of silence is several missed cycles, not a slow one.
  if (age > 300) {
    return {
      tone: 'warn',
      headline: `Last cycle ${formatAge(age)} — the agent may be stuck`,
      detail: 'Cycles normally complete every minute.',
    };
  }

  if (unavailable.length > 0) {
    return {
      tone: 'warn',
      headline: `${unavailable.length} source(s) unavailable`,
      detail: unavailable.map((report) => report.adapter).join(', '),
    };
  }

  if (data.agent.errors.length > 0) {
    return {
      tone: 'warn',
      headline: `Running, with ${data.agent.errors.length} recent error(s)`,
      detail: data.agent.errors[0]?.message ?? '',
    };
  }

  return {
    tone: 'ok',
    headline: 'Running normally',
    // The funnel's own sentence, which already says whether the silence is the
    // system working or the system stuck.
    detail: data.funnels[0]?.summary ?? 'Waiting for the first cycle to complete.',
  };
}

const STYLES = `
:root {
  --bg: #0e1116; --panel: #161b22; --border: #2a313a; --text: #d5dae1;
  --muted: #8b949e; --pos: #3fb950; --neg: #f85149; --warn: #d29922; --accent: #58a6ff;
  /* Spacing scale. Every gap and pad below comes from here, so "a bit more
     room" is a change to one number rather than to thirty. */
  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px; --s7: 48px;
  --r1: 8px; --r2: 12px; --pill: 999px;
  --fs-xs: 12px; --fs-sm: 13px; --fs-base: 15px; --fs-lg: 18px; --fs-xl: 26px;
  /* Minimum comfortable target for anything a finger has to hit. */
  --tap: 44px;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: var(--fs-base)/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--r1); }
header { padding: var(--s4) var(--s5); border-bottom: 1px solid var(--border);
  display: flex; align-items: baseline; gap: var(--s4); flex-wrap: wrap; }
h1 { font-size: var(--fs-lg); margin: 0; font-weight: 600; letter-spacing: -0.01em; }
.badge { padding: var(--s1) var(--s3); border-radius: var(--pill); font-size: var(--fs-xs);
  font-weight: 600; border: 1px solid var(--border); }
.badge.paper { background: #1f2d3d; color: var(--accent); border-color: #2b4a6f; }
.badge.live { background: #4a1d1d; color: var(--neg); border-color: #6f2b2b; }
main { padding: var(--s5); display: grid; gap: var(--s5); max-width: 1500px; }
/* 380px, not 320: below that the Money panel is narrow enough that a
   five-figure total wraps its currency onto a second line. Stacking is the
   cheaper compromise — vertical room is free, a broken number is not. */
.grid { display: grid; gap: var(--s5);
  /* min() and not a bare 380px: minmax's floor outranks the container, so on
     a 375px phone a bare value would push the track wider than the screen. */
  grid-template-columns: repeat(auto-fit, minmax(min(380px, 100%), 1fr)); }
/* A grid item defaults to min-width:auto, so it refuses to shrink below its
   content's intrinsic width. One table with a min-width would widen its track,
   then the page, and the overflow-x:auto meant to contain it never engages.
   This is what makes .scroll actually scroll instead of stretching the layout. */
main > *, .grid > *, .verdict > * { min-width: 0; }
section { background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--r2); padding: var(--s5); }
h2 { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .07em;
  color: var(--muted); margin: 0 0 var(--s4); font-weight: 600; }

/* The verdict: the one dominant element. Everything else on the page is
   deliberately quieter than this. */
.verdict { display: flex; gap: var(--s4); align-items: flex-start; }
.verdict .lamp { width: 12px; height: 12px; border-radius: var(--pill);
  margin-top: calc(var(--s2) + 2px); flex: none; }
.verdict.ok .lamp { background: var(--pos); }
.verdict.warn .lamp { background: var(--warn); }
.verdict.bad .lamp { background: var(--neg); }
.verdict h2 { font-size: var(--fs-xl); text-transform: none; letter-spacing: -0.02em;
  color: var(--text); margin: 0 0 var(--s2); font-weight: 600; line-height: 1.25; }
.verdict .say { color: var(--muted); margin: 0; }
.verdict .meta { color: var(--muted); font-size: var(--fs-sm); margin: var(--s3) 0 0; }

/* Folded sections: present, and not competing for the eye. */
.fold { padding: 0; }
.fold summary { list-style: none; cursor: pointer; padding: 0 var(--s5);
  min-height: var(--tap); display: flex; align-items: center; gap: var(--s2);
  color: var(--muted); font-size: var(--fs-xs); text-transform: uppercase;
  letter-spacing: .07em; font-weight: 600;
  transition: color 160ms cubic-bezier(0.16, 1, 0.3, 1); }
.fold summary::-webkit-details-marker { display: none; }
.fold summary::before { content: "▸"; font-size: var(--fs-sm); }
.fold details[open] summary::before, .fold details[open] > summary::before { content: "▾"; }
.fold summary:hover { color: var(--text); }
.fold-body { padding: 0 var(--s5) var(--s5); }

.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: var(--s4); }
.stat .label { color: var(--muted); font-size: var(--fs-xs); }
.stat .value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em; }
.pos { color: var(--pos); } .neg { color: var(--neg); } .warn { color: var(--warn); }
/* Tables scroll inside their own box rather than stretching the page. A
   six-column table on a phone otherwise forces the whole layout sideways,
   which makes every other panel unreadable to fix one. */
.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums;
  min-width: 460px; }
th { text-align: left; color: var(--muted); font-weight: 500; font-size: var(--fs-xs);
  padding: var(--s2) var(--s2); border-bottom: 1px solid var(--border); }
td { padding: var(--s2); border-bottom: 1px solid #1d232b; vertical-align: top; }
tr:last-child td { border-bottom: none; }
.muted { color: var(--muted); }
.note { color: var(--muted); font-size: var(--fs-xs); margin: var(--s3) 0 0; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--fs-xs); }
/* The number a funnel row exists to report: same size as its label so the
   two share a baseline, heavier so the eye lands on it first. */
.count { font-weight: 600; }
.empty { color: var(--muted); font-style: italic; padding: var(--s2) 0; }
details { margin-top: var(--s2); }
summary { cursor: pointer; color: var(--accent); font-size: var(--fs-sm); }
.factors { display: flex; flex-wrap: wrap; gap: var(--s1); margin-top: var(--s2); }
.chip { background: #1d232b; border: 1px solid var(--border); border-radius: var(--r1);
  padding: var(--s1) var(--s2); font-size: 11px; }
/* Event list. One card per event, stacking naturally at any width — the
   alternative was a five-column table whose rightmost column, the link out to
   the source, is the first thing a phone hides. */
.events { display: flex; flex-direction: column; gap: var(--s4); }
.event { border: 1px solid var(--border); border-radius: var(--r1); padding: var(--s3) var(--s4); }
.event-meta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2);
  font-size: var(--fs-xs); }
/* The category is the field the evidence gate keys on, so it reads as a label
   and not as decoration. Colour stays reserved for the verification state,
   which is the part that changes a decision. */
.cat { background: #1d232b; border: 1px solid var(--border); border-radius: var(--pill);
  padding: 2px var(--s2); font-weight: 600; letter-spacing: .02em; }
.tick { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }
.event-head { margin: var(--s2) 0 0; font-size: var(--fs-base); line-height: 1.45; }
.event-links { display: flex; flex-wrap: wrap; gap: var(--s2); margin-top: var(--s3); }
/* 44px tall because a link you open on a phone is a tap target, not a word. */
.src { display: inline-flex; align-items: center; min-height: var(--tap);
  padding: 0 var(--s3); border: 1px solid var(--border); border-radius: var(--r1);
  color: var(--accent); text-decoration: none; font-size: var(--fs-sm);
  transition: border-color 160ms cubic-bezier(0.16, 1, 0.3, 1),
              color 160ms cubic-bezier(0.16, 1, 0.3, 1); }
.src:hover { border-color: var(--accent); }
.src:active { transform: scale(0.97); }
.src-dead { display: inline-flex; align-items: center; min-height: var(--tap);
  padding: 0 var(--s3); color: var(--muted); font-size: var(--fs-sm); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
.dot.healthy { background: var(--pos); } .dot.degraded { background: var(--warn); }
.dot.unavailable { background: var(--neg); } .dot.disabled { background: #4a5158; }
ul { margin: 6px 0 0; padding-left: 18px; }
.notice { border-left: 3px solid var(--warn); padding: 8px 12px; background: #21201a;
  border-radius: 4px; margin-bottom: 14px; }
/* Activity feed: monospace and dense, because it is read by scanning rather
   than by reading. Capped in height so it never pushes the portfolio off the
   screen — the log is context, not the headline. */
.feed { max-height: 460px; overflow-y: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; line-height: 1.7; }
.feed .row { display: flex; gap: 10px; padding: 3px 0; border-bottom: 1px solid #171c22; }
.feed .row:last-child { border-bottom: none; }
.feed time { color: var(--muted); flex: none; }
.feed .stage { flex: none; width: 62px; text-transform: uppercase; font-size: 10px;
  letter-spacing: .04em; padding-top: 1px; }
.feed .msg { flex: 1; word-break: break-word; }
.lv-info .stage { color: var(--accent); }
.lv-good .stage { color: var(--pos); }
.lv-warn .stage { color: var(--warn); }
.lv-error .stage { color: var(--neg); }

@media (max-width: 600px) {
  main, header { padding: var(--s4); }
  /* The funnel is the one table read to answer "why did nothing happen", so its
     reason column is exactly the part that must not scroll off a phone. Each
     row becomes two lines instead: what the stage kept, then what it dropped. */
  .funnel { min-width: 0; }
  .funnel thead { display: none; }
  .funnel tr { display: grid; grid-template-columns: 1fr auto; column-gap: var(--s3);
    padding: var(--s2) 0; border-bottom: 1px solid #1d232b; }
  .funnel tr:last-child { border-bottom: none; }
  .funnel td { border: none; padding: 0; }
  .funnel td:nth-child(3) { grid-column: 1 / -1; font-size: var(--fs-sm); margin-top: var(--s1); }
  .funnel td:nth-child(3):empty { display: none; }
  section { padding: var(--s4); }
  .fold summary { padding: 0 var(--s4); }
  .fold-body { padding: 0 var(--s4) var(--s4); }
  .verdict h2 { font-size: 21px; }
}

@media (prefers-reduced-motion: reduce) {
  * { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
`;

export function renderDashboard(data: DashboardData): string {
  const p = data.portfolio;

  const positionsRows =
    p.positions.length > 0
      ? p.positions
          .map(
            (pos) => `<tr>
        <td class="mono">${escapeHtml(pos.symbol)}</td>
        <td>${pos.quantity}</td>
        <td>${pos.averagePrice.toFixed(2)}</td>
        <td>${pos.marketValue.toFixed(2)}</td>
        <td class="${pnlClass(pos.unrealisedPnl)}">${pos.unrealisedPnl.toFixed(2)}</td>
      </tr>`,
          )
          .join('')
      : '<tr><td colspan="5" class="empty">No open positions</td></tr>';

  const signalRows =
    data.signals.length > 0
      ? data.signals
          .slice(0, 15)
          .map(
            (signal) => `<tr>
        <td class="mono muted">${escapeHtml(signal.createdAt.slice(11, 19))}</td>
        <td class="mono">${escapeHtml(signal.asset)}</td>
        <td><strong>${escapeHtml(signal.action)}</strong></td>
        <td>${signal.score.toFixed(3)}</td>
        <td class="muted">${signal.modelConfidence.toFixed(2)}</td>
        <td>
          ${escapeHtml(signal.catalyst.slice(0, 90))}
          <details>
            <summary>reasoning</summary>
            <p>${escapeHtml(signal.reason.slice(0, 900))}</p>
            <p class="muted">Sources: ${escapeHtml(signal.sources.join(', '))}</p>
            ${
              signal.uncertainties.length > 0
                ? `<p class="muted">Uncertainties:</p><ul>${signal.uncertainties
                    .map((u) => `<li class="muted">${escapeHtml(u)}</li>`)
                    .join('')}</ul>`
                : ''
            }
            <div class="factors">${signal.components
              .map(
                (c) =>
                  `<span class="chip">${escapeHtml(c.name)} ${c.value} &times; ${c.weight}</span>`,
              )
              .join('')}</div>
            <p class="muted mono">${escapeHtml(signal.provenance.model)} &middot; ${signal.provenance.latencyMs}ms${
              signal.provenance.estimatedCostUsd !== undefined
                ? ` &middot; $${signal.provenance.estimatedCostUsd.toFixed(4)}`
                : ''
            }</p>
          </details>
        </td>
      </tr>`,
          )
          .join('')
      : '<tr><td colspan="6" class="empty">No signals yet</td></tr>';

  // Cards rather than a table row. Five columns of event metadata force a
  // phone into horizontal scroll, and the one column that matters — the link
  // out to the thing itself — is the one that falls off the right edge.
  const eventCards =
    data.events.length > 0
      ? data.events
          .slice(0, 20)
          .map((event) => {
            const verificationClass =
              event.verification.status === 'contradicted'
                ? 'neg'
                : event.verification.status === 'officially_confirmed'
                  ? 'pos'
                  : 'muted';

            const links = event.links
              .map((link) => {
                const href = safeHref(link.url);
                // No href means the source gave us nothing openable. Say the
                // source name plainly rather than render a dead link.
                if (!href) return `<span class="src-dead">${escapeHtml(link.source)}</span>`;
                return `<a class="src" href="${href}" target="_blank" rel="noopener noreferrer"
                  title="${escapeHtml(link.title)}">${escapeHtml(link.source)}<span aria-hidden="true"> ↗</span></a>`;
              })
              .join('');

            return `<article class="event">
      <div class="event-meta">
        <span class="cat">${escapeHtml(event.type)}</span>
        ${event.tickers.length > 0 ? `<span class="tick">${escapeHtml(event.tickers.join(' '))}</span>` : ''}
        <span class="${verificationClass}">${escapeHtml(event.verification.status.replace(/_/g, ' '))}</span>
        <span class="muted">materiality ${event.materiality.toFixed(2)}</span>
        <span class="muted">${escapeHtml(event.firstSeenAt.slice(0, 16).replace('T', ' '))}</span>
      </div>
      <p class="event-head">${escapeHtml(event.headline)}</p>
      ${links ? `<div class="event-links">${links}</div>` : '<p class="note">No source link — this feed publishes none.</p>'}
    </article>`;
          })
          .join('')
      : '<div class="empty">No events detected yet.</div>';

  const orderRows =
    data.orders.length > 0
      ? data.orders
          .slice(0, 15)
          .map(
            (order) => `<tr>
        <td class="mono muted">${escapeHtml(order.submittedAt.slice(11, 19))}</td>
        <td class="mono">${escapeHtml(order.symbol)}</td>
        <td>${escapeHtml(order.side)}</td>
        <td>${order.quantity}</td>
        <td>${order.filledPrice?.toFixed(2) ?? '—'}</td>
        <td class="${order.status === 'filled' ? 'pos' : order.status === 'rejected' ? 'neg' : 'muted'}">${escapeHtml(order.status)}</td>
        <td class="muted">${order.commission !== undefined ? `${order.commission.toFixed(2)} + ${order.slippage?.toFixed(2) ?? '0'}` : '—'}</td>
      </tr>`,
          )
          .join('')
      : '<tr><td colspan="7" class="empty">No orders placed</td></tr>';

  const activityRows =
    data.activity.length > 0
      ? data.activity
          .slice(0, 120)
          .map(
            (entry) => `<div class="row lv-${escapeHtml(entry.level)}">
        <time>${escapeHtml(entry.at.slice(11, 19))}</time>
        <span class="stage">${escapeHtml(entry.stage)}</span>
        <span class="msg">${escapeHtml(entry.message)}</span>
      </div>`,
          )
          .join('')
      : '<div class="empty">Nothing yet. The first entries appear on the next cycle.</div>';

  const settingsRows = data.settings
    .map(
      (row) => `<tr>
        <td class="muted">${escapeHtml(row.label)}</td>
        <td class="mono">${escapeHtml(row.value)}</td>
        <td class="muted">${escapeHtml(row.note ?? '')}</td>
      </tr>`,
    )
    .join('');

  const exitRows =
    data.exitPlans.length > 0
      ? data.exitPlans
          .map(
            (plan) => `<tr>
        <td class="mono">${escapeHtml(plan.symbol)}</td>
        <td class="neg">${plan.stopPrice}</td>
        <td class="pos">${plan.takeProfitPrice}</td>
        <td class="muted">${escapeHtml(plan.expiresAt.slice(0, 10))}</td>
      </tr>`,
          )
          .join('')
      : '<tr><td colspan="4" class="empty">No open positions</td></tr>';

  const evidenceRows = (data.evidence?.categories ?? [])
    .map((entry) => {
      const tone =
        entry.status === 'adverse' ? 'neg' : entry.status === 'supported' ? 'pos' : 'muted';
      const drift = entry.horizon
        ? `${entry.horizon.meanAbnormalPct > 0 ? '+' : ''}${entry.horizon.meanAbnormalPct}% @+${entry.horizon.sessions}d (t=${entry.horizon.tStat})`
        : '—';
      const net = entry.horizon
        ? `${entry.horizon.meanNetOfCostsPct > 0 ? '+' : ''}${entry.horizon.meanNetOfCostsPct}%`
        : '—';
      return `<tr>
        <td class="mono">${escapeHtml(entry.category)}</td>
        <td class="muted">${escapeHtml(entry.eventType ?? 'not classified')}</td>
        <td class="${tone}">${escapeHtml(entry.status)}</td>
        <td class="mono">${escapeHtml(drift)}</td>
        <td class="mono ${entry.horizon && entry.horizon.meanNetOfCostsPct > 0 ? 'pos' : 'muted'}">${escapeHtml(net)}</td>
        <td class="muted">${entry.sampleSize} / ${entry.clusters} sym</td>
      </tr>`;
    })
    .join('');

  const state = verdict(data);
  const [latestFunnel, ...previousFunnels] = data.funnels;
  // The banner carries the cycle age unconditionally, and the funnel's own
  // sentence too whenever nothing is wrong. Reprinting either twelve pixels
  // lower reads as two facts when it is one — so this line exists only in the
  // states where the banner had something more urgent to say.
  // Derived here rather than read from `summary`: the stored sentence is
  // written once and kept in the state file, so translating it there would
  // leave every past cycle in the old language for as long as that file lives.
  const funnelLead = latestFunnel
    ? `<p class="muted" style="margin:0 0 12px">${escapeHtml(summariseFunnelFr(latestFunnel.steps))}</p>`
    : '';
  // The funnel says how many documents arrived. Only this says whether zero is
  // the expected answer for what the system is pointed at.
  const { official, news, unknownIds } = data.coverage;
  const coverageNote = `<p class="note">
    Watching <strong>${official}</strong> official feed(s) and <strong>${news}</strong> company-news feed(s).
    ${
      news === 0
        ? '<span class="warn">Macro only</span> — central bank and statistics releases produce ' +
          'market-wide events, not company catalysts, so a quiet funnel here is the feed set ' +
          'rather than a fault. <span class="mono">ENABLED_SOURCES=all</span> turns the rest on.'
        : 'Company news is on, so a quiet funnel means a quiet day.'
    }
    ${
      unknownIds.length > 0
        ? `<br><span class="neg">Not running:</span> <span class="mono">${escapeHtml(unknownIds.join(', '))}</span> — no feed has that id.`
        : ''
    }
  </p>`;

  const funnelSection = latestFunnel
    ? `${funnelLead}
    <div class="scroll"><table class="funnel">
      <thead><tr><th>Étape</th><th>Nombre</th><th>Écartés</th></tr></thead>
      <tbody>${funnelStepRows(latestFunnel.steps)}</tbody>
    </table></div>
    ${coverageNote}
    ${
      previousFunnels.length > 0
        ? `<details><summary>Cycles précédents (${previousFunnels.length})</summary><ul>${previousFunnels
            .map(
              (f) =>
                `<li class="muted mono">#${f.cycleId} ${escapeHtml(f.finishedAt.slice(11, 19))} — ${escapeHtml(summariseFunnelFr(f.steps))}</li>`,
            )
            .join('')}</ul></details>`
        : ''
    }`
    : `<div class="empty">Aucun cycle n’a encore tourné.</div>${coverageNote}`;

  const outcomeEntries = Object.entries(data.outcomes.rates).sort(
    (a, b) => b[1].sampleSize - a[1].sampleSize,
  );
  const outcomeRows =
    outcomeEntries.length > 0
      ? outcomeEntries
          .map(
            ([type, { hitRate, sampleSize }]) => `<tr>
        <td>${escapeHtml(type)}</td>
        <td class="count">${(hitRate * 100).toFixed(1)}%</td>
        <td class="muted">${sampleSize}</td>
        <td class="muted">${sampleSize < 30 ? 'too few to read' : ''}</td>
      </tr>`,
          )
          .join('')
      : '<tr><td colspan="4" class="empty">Nothing scored yet — no decision has passed its horizon with a published price.</td></tr>';

  const healthRows =
    data.health.length > 0
      ? data.health
          .map(
            (report) => `<tr>
        <td><span class="dot ${report.state}"></span>${escapeHtml(report.adapter)}</td>
        <td class="muted">${escapeHtml(report.kind)}</td>
        <td>${escapeHtml(report.state)}</td>
        <td class="muted">${escapeHtml(report.detail ?? '')}</td>
      </tr>`,
          )
          .join('')
      : '<tr><td colspan="4" class="empty">Health not yet checked</td></tr>';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Market Agent</title>
<style>${STYLES}</style>
<meta http-equiv="refresh" content="15">
</head><body>
<header>
  <h1>AI Market Agent</h1>
  <span class="badge ${data.liveTrading ? 'live' : 'paper'}">${data.liveTrading ? 'LIVE — REAL MONEY' : `${escapeHtml(data.mode.toUpperCase())} — NO REAL MONEY`}</span>
  <span class="muted">cycle ${data.agent.cycles} &middot; LLM: ${escapeHtml(data.llmProvider)}</span>
</header>
<main>
  <section class="verdict ${state.tone}">
    <span class="lamp" aria-hidden="true"></span>
    <div>
      <h2>${escapeHtml(state.headline)}</h2>
      <p class="say">${escapeHtml(state.detail)}</p>
      <p class="meta">Last cycle ${escapeHtml(formatAge(data.cycleAgeSeconds))} · ${data.agent.cycles} run in total · ${data.agent.errors.length} recent error(s)</p>
    </div>
  </section>

  <section>
    <h2>Où en est le bot</h2>
    ${briefingFr(latestFunnel, data.coverage, data.budget)}
  </section>

  <section>
    <h2>Ce qui s’est passé au dernier cycle</h2>
    ${funnelSection}
  </section>

  <div class="grid">
    <section>
      <h2>Money</h2>
      <div class="stats">
        <div class="stat"><div class="label">Total value</div><div class="value">${p.totalValue.toFixed(2)} ${escapeHtml(data.currency)}</div></div>
        <div class="stat"><div class="label">Cash</div><div class="value">${p.cash.toFixed(2)}</div></div>
        <div class="stat"><div class="label">Return</div><div class="value ${pnlClass(p.totalReturnPct)}">${p.totalReturnPct.toFixed(2)}%</div></div>
        <div class="stat"><div class="label">Drawdown</div><div class="value ${p.drawdownPct > 0 ? 'neg' : ''}">${p.drawdownPct.toFixed(2)}%</div></div>
      </div>
      <div class="scroll"><table style="margin-top:var(--s4)">
        <thead><tr><th>Symbol</th><th>Qty</th><th>Avg price</th><th>Value</th><th>Unrealised</th></tr></thead>
        <tbody>${positionsRows}</tbody>
      </table></div>
      <p class="note">Worst drawdown so far ${p.maxDrawdownPct.toFixed(2)}% &middot;
        ${p.exposurePct.toFixed(1)}% of the portfolio is currently in positions.</p>
    </section>

    <section>
      <h2>Was it right?</h2>
      <div class="scroll"><table>
        <thead><tr><th>Event type</th><th>Direction right</th><th>n</th><th></th></tr></thead>
        <tbody>${outcomeRows}</tbody>
      </table></div>
      <p class="note">
        Scored once the signal's own horizon has elapsed, against the first session at or after it.
        ${data.outcomes.pending > 0 ? `${data.outcomes.pending} decision(s) due but not yet priced. ` : ''}
        HOLD and WATCH are not scored: they predict no direction. Below n=30 the scorer refuses to use it.
      </p>
      ${
        data.unmeasurableEventTypes.length > 0
          ? `<p class="note"><span class="warn">No study can measure</span>
        ${data.unmeasurableEventTypes.map((e) => `${escapeHtml(e.type)} (${e.recentEvents})`).join(', ')}
        — no filing category maps onto these, so the evidence gate could never block them.</p>`
          : ''
      }
    </section>
  </div>

  <section>
    <h2>Recent signals</h2>
    <div class="scroll"><table>
      <thead><tr><th>Time</th><th>Asset</th><th>Action</th><th>Score</th><th>Model conf.</th><th>Catalyst &amp; reasoning</th></tr></thead>
      <tbody>${signalRows}</tbody>
    </table></div>
  </section>

  <section>
    <h2>Events detected</h2>
    <div class="events">${eventCards}</div>
    <p class="note">Every event links back to the document it came from. The
      category is what the evidence gate keys on — a category no study measures
      cannot be blocked by one, however it performs.</p>
  </section>

  ${foldable(
    'Orders',
    `<div class="scroll"><table>
      <thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Fill</th><th>Status</th><th>Costs</th></tr></thead>
      <tbody>${orderRows}</tbody>
    </table></div>`,
  )}

  ${foldable(
    'Exit plans',
    `<div class="scroll"><table>
      <thead><tr><th>Symbol</th><th>Stop</th><th>Target</th><th>Expires</th></tr></thead>
      <tbody>${exitRows}</tbody>
    </table></div>
    <p class="note">
      Checked once per cycle against our own marks — these are not resting orders at the
      broker, so a gap can fill worse than the stop.
    </p>`,
  )}

  ${foldable(
    'Evidence ledger',
    data.evidence
      ? `<div class="scroll"><table>
      <thead><tr><th>Filing</th><th>Event type</th><th>Status</th><th>Abnormal drift</th><th>Net of costs</th><th>n / symbols</th></tr></thead>
      <tbody>${evidenceRows}</tbody>
    </table></div>
    <p class="note">
      From <span class="mono">npm run study</span> over ${data.evidence.windowYears}y and
      ${data.evidence.symbols} symbols${data.evidence.benchmark ? `, abnormal vs ${escapeHtml(data.evidence.benchmark)}` : ', NOT market-adjusted'},
      net of a ${data.evidence.roundTripCostPct}% round trip. Generated
      ${escapeHtml(data.evidence.generatedAt.slice(0, 10))}.
      A red row is refused outright; a green one is <em>not</em> a licence — it is one
      sample of one regime, and the ordinary gates still decide it.
    </p>`
      : `<div class="empty">No study has been run. Nothing is being blocked on evidence.<br>
      <span class="mono">npm run study -- --years 5 --out</span> measures whether these filings
      are followed by any abnormal move at all, and writes what it finds here.</div>`,
  )}

  ${foldable(
    'Sources and totals',
    `<div class="stats" style="margin-bottom:var(--s4)">
      <div class="stat"><div class="label">Documents</div><div class="value">${data.agent.documentsIngested}</div></div>
      <div class="stat"><div class="label">Events</div><div class="value">${data.agent.eventsDetected}</div></div>
      <div class="stat"><div class="label">Signals</div><div class="value">${data.agent.signalsGenerated}</div></div>
      <div class="stat"><div class="label">Orders</div><div class="value">${data.agent.ordersPlaced}</div></div>
      <div class="stat"><div class="label">Risk rejections</div><div class="value">${data.agent.ordersRejectedByRisk}</div></div>
      <div class="stat"><div class="label">Errors</div><div class="value ${data.agent.errors.length > 0 ? 'warn' : ''}">${data.agent.errors.length}</div></div>
    </div>
    <div class="scroll"><table>
      <thead><tr><th>Source</th><th>Kind</th><th>State</th><th>Detail</th></tr></thead>
      <tbody>${healthRows}</tbody>
    </table></div>
    <p class="note">Totals are lifetime, across every cycle since this experiment began — not this cycle.</p>
    ${
      data.agent.errors.length > 0
        ? `<details><summary>Recent errors</summary><ul>${data.agent.errors
            .slice(0, 10)
            .map((e) => `<li class="muted mono">${escapeHtml(e.at.slice(11, 19))} [${escapeHtml(e.stage)}] ${escapeHtml(e.message)}</li>`)
            .join('')}</ul></details>`
        : ''
    }`,
  )}

  ${foldable('Activity log', `<div class="feed">${activityRows}</div>`)}

  ${foldable(
    'Settings',
    `<div class="scroll"><table>
      <thead><tr><th>Setting</th><th>Value</th><th></th></tr></thead>
      <tbody>${settingsRows}</tbody>
    </table></div>
    <p class="note">
      Read-only. Changing these means editing <span class="mono">.env</span> and restarting —
      deliberately: a dashboard that can retune risk limits is a dashboard that can remove them.
    </p>`,
  )}
</main>
<script>
  // The page reloads every 15s, which would close whatever you had just
  // opened to read. Remember the open sections for the session. No framework
  // and no build step: without JS the folds simply start closed, as they do
  // on a first visit.
  (function () {
    try {
      var open = JSON.parse(sessionStorage.getItem('openFolds') || '[]');
      document.querySelectorAll('details[data-fold]').forEach(function (el) {
        if (open.indexOf(el.dataset.fold) !== -1) el.open = true;
        el.addEventListener('toggle', function () {
          var now = [].slice
            .call(document.querySelectorAll('details[data-fold]'))
            .filter(function (d) { return d.open; })
            .map(function (d) { return d.dataset.fold; });
          sessionStorage.setItem('openFolds', JSON.stringify(now));
        });
      });
    } catch (e) { /* storage blocked — folds just start closed */ }
  })();
</script>
</body></html>`;
}
