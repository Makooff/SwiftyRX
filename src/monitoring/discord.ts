import { type Clock, systemClock } from '../core/clock.js';
import { type FetchImpl, HttpClient } from '../core/http.js';
import { createLogger, type Logger } from '../core/logger.js';
import { TokenBucket } from '../core/rate-limiter.js';
import { redact, registerSecret } from '../core/redact.js';
import type { Order } from '../execution/broker/types.js';
import type { RiskDecision } from '../risk/types.js';
import type { Signal } from '../strategy/signals/types.js';

/**
 * Discord notifications and trade approval.
 *
 * Two separate capabilities, deliberately not merged:
 *
 *  - **Notifier** (webhook): tells you what happened. Failure here must never
 *    affect trading — a missed message costs you a notification, whereas an
 *    exception thrown into the agent loop costs you the run. Every method
 *    swallows its errors and logs them.
 *
 *  - **Approver** (bot token): asks permission before an order. Failure here
 *    means the opposite: if the question cannot be asked, or nobody answers,
 *    the order is **refused**. Default-deny is the only safe reading of
 *    silence, and a timeout is silence.
 *
 * Implemented against the documented REST API rather than a gateway client:
 * one dependency fewer, and polling for a reaction is enough for a decision
 * measured in minutes.
 */

const DISCORD_API = 'https://discord.com/api/v10';

/** Discord's global limit is 50 req/s; nothing here needs to go near it. */
const SELF_IMPOSED_RPM = 60;

const APPROVE = '✅';
const REJECT = '❌';

/** Discord embed colours, as decimal ints. */
const COLOUR = {
  buy: 0x3fb950,
  sell: 0xf85149,
  neutral: 0x58a6ff,
  warn: 0xd29922,
  danger: 0xf85149,
} as const;

export interface DiscordNotifierOptions {
  webhookUrl?: string;
  clock?: Clock;
  logger?: Logger;
  fetchImpl?: FetchImpl;
}

interface Embed {
  title: string;
  description?: string;
  color: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp?: string;
  footer?: { text: string };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Discord rejects an embed field with an empty value, so never send one. */
function field(name: string, value: string, inline = true) {
  return { name, value: value.trim() === '' ? '—' : truncate(value, 1024), inline };
}

export class DiscordNotifier {
  private readonly http?: HttpClient;
  private readonly webhookPath?: string;
  private readonly log: Logger;

  constructor(options: DiscordNotifierOptions = {}) {
    this.log = options.logger ?? createLogger('discord');

    if (options.webhookUrl) {
      // The webhook URL contains its own token — it is a credential, and it
      // must never reach a log line.
      registerSecret(options.webhookUrl);
      const match = /\/api(?:\/v\d+)?\/webhooks\/(.+)$/.exec(options.webhookUrl);
      if (!match) {
        this.log.warn(
          {},
          'DISCORD_WEBHOOK_URL is not a recognisable webhook URL — notifications disabled',
        );
        return;
      }
      this.webhookPath = `webhooks/${match[1]}`;
      this.http = new HttpClient({
        name: 'discord',
        baseUrl: `${DISCORD_API}/`,
        rateLimit: TokenBucket.perMinute(SELF_IMPOSED_RPM, options.clock ?? systemClock),
        maxRetries: 1,
        ...(options.clock ? { clock: options.clock } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        logger: this.log,
      });
    }
  }

  get isConfigured(): boolean {
    return this.http !== undefined;
  }

  /**
   * Post an embed. Never throws.
   *
   * A notification is a side effect of trading, not a step in it. Letting a
   * Discord outage propagate into the cycle would mean the agent stops
   * trading because a chat server is down.
   */
  private async post(embed: Embed): Promise<void> {
    if (!this.http || !this.webhookPath) return;
    try {
      await this.http.getText(this.webhookPath, {
        method: 'POST',
        // Redacted on the way out, same chokepoint as the logs: a signal's
        // text is model output, and model output is not trusted to be free of
        // anything that shouldn't leave the process.
        body: redact({ embeds: [embed] }),
      });
    } catch (err) {
      this.log.warn({ error: (err as Error).message }, 'could not post to Discord');
    }
  }

  async signal(signal: Signal, decision?: RiskDecision): Promise<void> {
    const approved = decision?.verdict === 'approved';
    await this.post({
      title: `${signal.action} ${signal.asset} · score ${signal.score.toFixed(3)}`,
      description: truncate(signal.catalyst, 300),
      color: signal.action === 'BUY' ? COLOUR.buy : signal.action === 'SELL' ? COLOUR.sell : COLOUR.neutral,
      fields: [
        field('Model confidence', signal.modelConfidence.toFixed(2)),
        field('Sources', signal.sources.join(', ')),
        ...(decision
          ? [
              field('Risk engine', approved ? 'approved' : 'REFUSED'),
              field(
                approved ? 'Size' : 'Why refused',
                approved
                  ? `${decision.quantity} @ ~${decision.notional?.toFixed(2) ?? '?'}`
                  : decision.rejections.map((r) => r.rule).join(', '),
              ),
            ]
          : []),
        ...(signal.uncertainties.length > 0
          ? [field('Uncertainties', signal.uncertainties.join(' · '), false)]
          : []),
      ],
      timestamp: signal.createdAt,
    });
  }

  async order(order: Order, signal?: Signal): Promise<void> {
    await this.post({
      title: `Order ${order.status}: ${order.side.toUpperCase()} ${order.filledQuantity} ${order.symbol}`,
      color: order.side === 'buy' ? COLOUR.buy : COLOUR.sell,
      fields: [
        field('Fill', order.filledPrice?.toFixed(4) ?? 'pending'),
        ...(signal ? [field('Because', truncate(signal.catalyst, 200), false)] : []),
      ],
      timestamp: order.submittedAt,
      footer: { text: 'PAPER — no real money' },
    });
  }

  async halted(reasons: string[]): Promise<void> {
    await this.post({
      title: 'Trading halted',
      description: reasons.map((r) => `• ${r}`).join('\n'),
      color: COLOUR.danger,
    });
  }

  async summary(input: {
    totalValue: number;
    currency: string;
    returnPct: number;
    drawdownPct: number;
    openPositions: number;
    cycles: number;
    signals: number;
    orders: number;
    riskRejections: number;
  }): Promise<void> {
    await this.post({
      title: 'Daily summary',
      color: input.returnPct >= 0 ? COLOUR.buy : COLOUR.sell,
      fields: [
        field('Value', `${input.totalValue.toFixed(2)} ${input.currency}`),
        field('Return', `${input.returnPct.toFixed(2)}%`),
        field('Drawdown', `${input.drawdownPct.toFixed(2)}%`),
        field('Open positions', String(input.openPositions)),
        field('Cycles', String(input.cycles)),
        field('Signals', String(input.signals)),
        field('Orders', String(input.orders)),
        // Shown deliberately: refusals are most of what the risk engine does,
        // and a rising count is information rather than a fault.
        field('Refused by risk', String(input.riskRejections)),
      ],
    });
  }
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export type ApprovalOutcome = 'approved' | 'rejected' | 'timeout' | 'unavailable';

export interface DiscordApproverOptions {
  botToken?: string;
  channelId?: string;
  /** How long to wait for a reaction before refusing. */
  timeoutSeconds?: number;
  pollSeconds?: number;
  clock?: Clock;
  logger?: Logger;
  fetchImpl?: FetchImpl;
}

interface DiscordMessage {
  id: string;
}

interface DiscordUser {
  id: string;
  bot?: boolean;
}

export class DiscordApprover {
  private readonly http?: HttpClient;
  private readonly channelId?: string;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly clock: Clock;
  private readonly log: Logger;

  constructor(options: DiscordApproverOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.log = options.logger ?? createLogger('discord-approval');
    this.timeoutMs = (options.timeoutSeconds ?? 300) * 1000;
    this.pollMs = (options.pollSeconds ?? 10) * 1000;

    if (options.botToken && options.channelId) {
      registerSecret(options.botToken);
      this.channelId = options.channelId;
      this.http = new HttpClient({
        name: 'discord-bot',
        baseUrl: `${DISCORD_API}/`,
        defaultHeaders: { authorization: `Bot ${options.botToken}` },
        rateLimit: TokenBucket.perMinute(SELF_IMPOSED_RPM, this.clock),
        maxRetries: 1,
        clock: this.clock,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        logger: this.log,
      });
    }
  }

  get isConfigured(): boolean {
    return this.http !== undefined && this.channelId !== undefined;
  }

  /**
   * Ask for a trade to be approved, and wait.
   *
   * Returns `rejected` on ❌, `timeout` when nobody answers, and `unavailable`
   * when the question could not be asked at all. The caller must treat every
   * outcome except `approved` as "do not trade" — which is why no outcome is
   * named "unknown". There is no ambiguous case: an unanswered question is a
   * refusal.
   */
  async requestApproval(signal: Signal, decision: RiskDecision): Promise<ApprovalOutcome> {
    if (!this.http || !this.channelId) return 'unavailable';

    let message: DiscordMessage;
    try {
      message = await this.http.getJson<DiscordMessage>(`channels/${this.channelId}/messages`, {
        method: 'POST',
        body: redact({
          content: `**Approve this trade?** ${APPROVE} yes · ${REJECT} no — no answer within ${Math.round(this.timeoutMs / 60000)} min means **no**.`,
          embeds: [
            {
              title: `${signal.action} ${decision.quantity} ${signal.asset}`,
              description: truncate(signal.catalyst, 300),
              color: signal.action === 'BUY' ? COLOUR.buy : COLOUR.sell,
              fields: [
                field('Score', signal.score.toFixed(3)),
                field('Notional', decision.notional?.toFixed(2) ?? '?'),
                field('Model confidence', signal.modelConfidence.toFixed(2)),
                field('Sources', signal.sources.join(', ')),
              ],
            },
          ],
        }),
      });
    } catch (err) {
      // Could not ask. Not trading is the safe response to not being able to
      // ask — never assume yes.
      this.log.error({ error: (err as Error).message }, 'could not post approval request — treating as refusal');
      return 'unavailable';
    }

    for (const emoji of [APPROVE, REJECT]) {
      try {
        // getText, not getJson: this endpoint answers 204 with no body, and
        // JSON.parse('') throws.
        await this.http.getText(
          `channels/${this.channelId}/messages/${message.id}/reactions/${encodeURIComponent(emoji)}/@me`,
          { method: 'PUT' },
        );
      } catch (err) {
        // The buttons are a convenience; a human can still react manually.
        this.log.warn({ error: (err as Error).message }, 'could not pre-add a reaction');
      }
    }

    const deadline = this.clock.nowMs() + this.timeoutMs;
    while (this.clock.nowMs() < deadline) {
      await this.clock.sleep(this.pollMs);

      const [approvers, rejecters] = await Promise.all([
        this.humansWhoReacted(message.id, APPROVE),
        this.humansWhoReacted(message.id, REJECT),
      ]);

      // Rejection wins a tie: when the humans disagree, the safe reading is no.
      if (rejecters > 0) {
        this.log.info({ asset: signal.asset }, 'trade rejected on Discord');
        return 'rejected';
      }
      if (approvers > 0) {
        this.log.info({ asset: signal.asset }, 'trade approved on Discord');
        return 'approved';
      }
    }

    this.log.warn({ asset: signal.asset }, 'no answer before the deadline — treating as refusal');
    return 'timeout';
  }

  /** Reactors excluding this bot's own pre-added ones. */
  private async humansWhoReacted(messageId: string, emoji: string): Promise<number> {
    if (!this.http || !this.channelId) return 0;
    try {
      const users = await this.http.getJson<DiscordUser[]>(
        `channels/${this.channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
        { query: { limit: 100 } },
      );
      return users.filter((u) => !u.bot).length;
    } catch (err) {
      // A failed poll is not an answer. Returning 0 keeps waiting rather than
      // inventing a verdict from a network error.
      this.log.warn({ error: (err as Error).message }, 'could not read reactions');
      return 0;
    }
  }
}
