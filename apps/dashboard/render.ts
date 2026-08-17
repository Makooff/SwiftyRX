import type { HealthReport } from '../../src/domain/types.js';
import type { Order } from '../../src/execution/broker/types.js';
import type { MarketEvent } from '../../src/intelligence/types.js';
import type { Signal } from '../../src/strategy/signals/types.js';
import type { ActivityEntry } from '../../src/monitoring/activity-log.js';
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
  signals: Signal[];
  events: MarketEvent[];
  orders: Order[];
  health: HealthReport[];
  agent: AgentState;
  activity: ActivityEntry[];
  /** Effective configuration, shown read-only. Never contains a credential. */
  settings: Array<{ label: string; value: string; note?: string }>;
  /** Stop, target and deadline for each open position. */
  exitPlans: Array<{ symbol: string; stopPrice: number; takeProfitPrice: number; expiresAt: string }>;
  llmProvider: string;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pnlClass(value: number): string {
  return value > 0 ? 'pos' : value < 0 ? 'neg' : '';
}

const STYLES = `
:root {
  --bg: #0e1116; --panel: #161b22; --border: #2a313a; --text: #d5dae1;
  --muted: #8b949e; --pos: #3fb950; --neg: #f85149; --warn: #d29922; --accent: #58a6ff;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
header { padding: 16px 24px; border-bottom: 1px solid var(--border);
  display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
h1 { font-size: 18px; margin: 0; font-weight: 600; }
.badge { padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600;
  border: 1px solid var(--border); }
.badge.paper { background: #1f2d3d; color: var(--accent); border-color: #2b4a6f; }
.badge.live { background: #4a1d1d; color: var(--neg); border-color: #6f2b2b; }
main { padding: 24px; display: grid; gap: 20px; max-width: 1500px; }
.grid { display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
section { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .07em;
  color: var(--muted); margin: 0 0 14px; font-weight: 600; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 14px; }
.stat .label { color: var(--muted); font-size: 12px; }
.stat .value { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.pos { color: var(--pos); } .neg { color: var(--neg); } .warn { color: var(--warn); }
/* Tables scroll inside their own box rather than stretching the page. A
   six-column table on a phone otherwise forces the whole layout sideways,
   which makes every other panel unreadable to fix one. */
.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums;
  min-width: 460px; }
th { text-align: left; color: var(--muted); font-weight: 500; font-size: 12px;
  padding: 6px 8px; border-bottom: 1px solid var(--border); }
td { padding: 7px 8px; border-bottom: 1px solid #1d232b; vertical-align: top; }
tr:last-child td { border-bottom: none; }
.muted { color: var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.empty { color: var(--muted); font-style: italic; padding: 8px 0; }
details { margin-top: 8px; }
summary { cursor: pointer; color: var(--accent); font-size: 13px; }
.factors { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.chip { background: #1d232b; border: 1px solid var(--border); border-radius: 6px;
  padding: 2px 8px; font-size: 11px; }
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

  const eventRows =
    data.events.length > 0
      ? data.events
          .slice(0, 15)
          .map(
            (event) => `<tr>
        <td>${escapeHtml(event.type)}</td>
        <td>${escapeHtml(event.headline.slice(0, 80))}</td>
        <td>${event.materiality.toFixed(2)}</td>
        <td class="${event.verification.status === 'contradicted' ? 'neg' : event.verification.status === 'officially_confirmed' ? 'pos' : 'muted'}">${escapeHtml(event.verification.status)}</td>
        <td class="mono">${escapeHtml(event.tickers.join(', ') || '—')}</td>
      </tr>`,
          )
          .join('')
      : '<tr><td colspan="5" class="empty">No events detected yet</td></tr>';

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
  <span class="muted">cycle ${data.agent.cycles} &middot; ${escapeHtml(data.agent.lastCycleAt?.slice(11, 19) ?? 'not run')} &middot; LLM: ${escapeHtml(data.llmProvider)}</span>
</header>
<main>
  ${
    data.agent.halted
      ? `<div class="notice"><strong>Trading halted.</strong><ul>${data.agent.haltReasons
          .map((r) => `<li>${escapeHtml(r)}</li>`)
          .join('')}</ul></div>`
      : ''
  }

  <section>
    <h2>Portfolio</h2>
    <div class="stats">
      <div class="stat"><div class="label">Total value</div><div class="value">${p.totalValue.toFixed(2)} ${escapeHtml(data.currency)}</div></div>
      <div class="stat"><div class="label">Cash</div><div class="value">${p.cash.toFixed(2)}</div></div>
      <div class="stat"><div class="label">Return</div><div class="value ${pnlClass(p.totalReturnPct)}">${p.totalReturnPct.toFixed(2)}%</div></div>
      <div class="stat"><div class="label">Drawdown</div><div class="value ${p.drawdownPct > 0 ? 'neg' : ''}">${p.drawdownPct.toFixed(2)}%</div></div>
      <div class="stat"><div class="label">Max drawdown</div><div class="value ${p.maxDrawdownPct > 0 ? 'neg' : ''}">${p.maxDrawdownPct.toFixed(2)}%</div></div>
      <div class="stat"><div class="label">Exposure</div><div class="value">${p.exposurePct.toFixed(1)}%</div></div>
    </div>
    <div class="scroll"><table style="margin-top:16px">
      <thead><tr><th>Symbol</th><th>Qty</th><th>Avg price</th><th>Value</th><th>Unrealised</th></tr></thead>
      <tbody>${positionsRows}</tbody>
    </table></div>
  </section>

  <section>
    <h2>Signals</h2>
    <div class="scroll"><table>
      <thead><tr><th>Time</th><th>Asset</th><th>Action</th><th>Score</th><th>Model conf.</th><th>Catalyst &amp; reasoning</th></tr></thead>
      <tbody>${signalRows}</tbody>
    </table></div>
  </section>

  <div class="grid">
    <section>
      <h2>Events</h2>
      <div class="scroll"><table>
        <thead><tr><th>Type</th><th>Headline</th><th>Materiality</th><th>Verification</th><th>Tickers</th></tr></thead>
        <tbody>${eventRows}</tbody>
      </table></div>
    </section>

    <section>
      <h2>Orders</h2>
      <div class="scroll"><table>
        <thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Fill</th><th>Status</th><th>Costs</th></tr></thead>
        <tbody>${orderRows}</tbody>
      </table></div>
    </section>
  </div>

  <section>
    <h2>Exit plans</h2>
    <div class="scroll"><table>
      <thead><tr><th>Symbol</th><th>Stop</th><th>Target</th><th>Expires</th></tr></thead>
      <tbody>${exitRows}</tbody>
    </table></div>
    <p class="muted" style="margin:10px 0 0;font-size:12px">
      Checked once per cycle against our own marks — these are not resting orders at the
      broker, so a gap can fill worse than the stop.
    </p>
  </section>

  <section>
    <h2>Settings</h2>
    <div class="scroll"><table>
      <thead><tr><th>Setting</th><th>Value</th><th></th></tr></thead>
      <tbody>${settingsRows}</tbody>
    </table></div>
    <p class="muted" style="margin:10px 0 0;font-size:12px">
      Read-only. Changing these means editing <span class="mono">.env</span> and restarting —
      deliberately: a dashboard that can retune risk limits is a dashboard that can remove them.
    </p>
  </section>

  <section>
    <h2>Activity</h2>
    <div class="feed">${activityRows}</div>
  </section>

  <section>
    <h2>System health</h2>
    <div class="stats" style="margin-bottom:14px">
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
    ${
      data.agent.errors.length > 0
        ? `<details><summary>Recent errors</summary><ul>${data.agent.errors
            .slice(0, 10)
            .map((e) => `<li class="muted mono">${escapeHtml(e.at.slice(11, 19))} [${escapeHtml(e.stage)}] ${escapeHtml(e.message)}</li>`)
            .join('')}</ul></details>`
        : ''
    }
  </section>
</main>
</body></html>`;
}
