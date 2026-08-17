import { describe, expect, it } from 'vitest';
import { DiscordApprover, DiscordNotifier } from '../src/monitoring/discord.js';
import { ConfigError, loadConfig } from '../src/config/env.js';
import { FixedClock } from '../src/core/clock.js';
import { createFakeFetch } from './helpers/fake-fetch.js';
import type { Signal } from '../src/strategy/signals/types.js';
import type { RiskDecision } from '../src/risk/types.js';

/**
 * Discord notifications and approval.
 *
 * The two halves have opposite failure requirements, and that asymmetry is
 * what these tests are really about:
 *
 *  - a notification that fails must not disturb trading;
 *  - an approval that fails must stop it.
 */

const clock = FixedClock.at('2026-08-17T22:00:00Z');
const WEBHOOK = 'https://discord.com/api/webhooks/123456789/tOkEn-VaLuE-SeCrEt';
const BOT_TOKEN = 'bot-token-value-secret';
const CHANNEL = '987654321';

const signal: Signal = {
  id: 'sig-1',
  eventId: 'evt-1',
  asset: 'AAPL',
  action: 'BUY',
  score: 0.72,
  modelConfidence: 0.81,
  catalyst: 'Q3 earnings above consensus',
  reason: 'Results beat expectations.',
  uncertainties: ['Guidance not yet published'],
  sources: ['sec_edgar', 'outlet_a'],
  createdAt: '2026-08-17T21:59:00Z',
  horizon: '1-5d',
  components: [],
  provenance: { model: 'test', latencyMs: 12 },
} as unknown as Signal;

const approvedDecision: RiskDecision = {
  verdict: 'approved',
  symbol: 'AAPL',
  side: 'buy',
  quantity: 10,
  notional: 2000,
  rejections: [],
  checks: [],
} as unknown as RiskDecision;

describe('DiscordNotifier', () => {
  it('does nothing when no webhook is configured', async () => {
    const notifier = new DiscordNotifier({ clock });
    expect(notifier.isConfigured).toBe(false);
    await expect(notifier.signal(signal)).resolves.toBeUndefined();
  });

  it('posts an embed to the webhook', async () => {
    const fake = createFakeFetch([{ match: '/webhooks/', status: 204, text: '' }]);
    const notifier = new DiscordNotifier({ webhookUrl: WEBHOOK, clock, fetchImpl: fake.impl });

    await notifier.signal(signal, approvedDecision);

    expect(fake.calls).toHaveLength(1);
    const body = JSON.parse(String(fake.calls[0]!.init?.body));
    expect(body.embeds[0].title).toContain('BUY AAPL');
    expect(body.embeds[0].fields.some((f: { name: string }) => f.name === 'Risk engine')).toBe(true);
  });

  it('swallows a Discord outage instead of breaking the cycle', async () => {
    // A missed notification costs a message. An exception thrown into the
    // agent loop costs the run.
    const fake = createFakeFetch([{ match: '/webhooks/', networkError: true }]);
    const notifier = new DiscordNotifier({ webhookUrl: WEBHOOK, clock, fetchImpl: fake.impl });

    await expect(notifier.signal(signal)).resolves.toBeUndefined();
    await expect(notifier.halted(['daily loss limit'])).resolves.toBeUndefined();
  });

  it('reports a refusal as a refusal, with the rules that fired', async () => {
    const fake = createFakeFetch([{ match: '/webhooks/', status: 204, text: '' }]);
    const notifier = new DiscordNotifier({ webhookUrl: WEBHOOK, clock, fetchImpl: fake.impl });

    await notifier.signal(signal, {
      ...approvedDecision,
      verdict: 'rejected',
      rejections: [{ rule: 'max_position', message: 'too large' }],
    } as unknown as RiskDecision);

    const body = JSON.parse(String(fake.calls[0]!.init?.body));
    const fields = body.embeds[0].fields as Array<{ name: string; value: string }>;
    expect(fields.find((f) => f.name === 'Risk engine')?.value).toBe('REFUSED');
    expect(fields.find((f) => f.name === 'Why refused')?.value).toContain('max_position');
  });

  it('marks paper orders as paper', async () => {
    const fake = createFakeFetch([{ match: '/webhooks/', status: 204, text: '' }]);
    const notifier = new DiscordNotifier({ webhookUrl: WEBHOOK, clock, fetchImpl: fake.impl });

    await notifier.order({
      id: 'o1',
      clientOrderId: 'c1',
      symbol: 'AAPL',
      side: 'buy',
      type: 'market',
      quantity: 10,
      filledQuantity: 10,
      filledPrice: 200,
      status: 'filled',
      submittedAt: '2026-08-17T22:00:00Z',
    });

    const body = JSON.parse(String(fake.calls[0]!.init?.body));
    expect(body.embeds[0].footer.text).toMatch(/no real money/i);
  });
});

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

function approver(routes: Parameters<typeof createFakeFetch>[0], timeoutSeconds = 30) {
  const fake = createFakeFetch(routes);
  return {
    fake,
    approver: new DiscordApprover({
      botToken: BOT_TOKEN,
      channelId: CHANNEL,
      timeoutSeconds,
      pollSeconds: 1,
      clock,
      fetchImpl: fake.impl,
    }),
  };
}

const postOk = { match: `/channels/${CHANNEL}/messages`, body: { id: 'msg-1' } };
const reactionPutOk = { match: '/@me', status: 204, text: '' };

describe('DiscordApprover', () => {
  it('is unavailable — and therefore a refusal — without a bot token', async () => {
    const bare = new DiscordApprover({ clock });
    expect(bare.isConfigured).toBe(false);
    expect(await bare.requestApproval(signal, approvedDecision)).toBe('unavailable');
  });

  it('approves on a human ✅', async () => {
    const { approver: a } = approver([
      reactionPutOk,
      { match: encodeURIComponent('✅'), body: [{ id: 'u1' }] },
      { match: encodeURIComponent('❌'), body: [] },
      postOk,
    ]);
    expect(await a.requestApproval(signal, approvedDecision)).toBe('approved');
  });

  it('rejects on a human ❌', async () => {
    const { approver: a } = approver([
      reactionPutOk,
      { match: encodeURIComponent('✅'), body: [] },
      { match: encodeURIComponent('❌'), body: [{ id: 'u1' }] },
      postOk,
    ]);
    expect(await a.requestApproval(signal, approvedDecision)).toBe('rejected');
  });

  it('lets rejection win when both are reacted', async () => {
    // Disagreement resolves to no. The asymmetry is deliberate: the cost of a
    // missed trade is an opportunity, the cost of an unwanted one is money.
    const { approver: a } = approver([
      reactionPutOk,
      { match: encodeURIComponent('✅'), body: [{ id: 'u1' }] },
      { match: encodeURIComponent('❌'), body: [{ id: 'u2' }] },
      postOk,
    ]);
    expect(await a.requestApproval(signal, approvedDecision)).toBe('rejected');
  });

  it('ignores its own pre-added reactions', async () => {
    // The bot reacts first so the buttons are one tap. If those counted, every
    // trade would self-approve.
    const { approver: a } = approver(
      [
        reactionPutOk,
        { match: encodeURIComponent('✅'), body: [{ id: 'bot', bot: true }] },
        { match: encodeURIComponent('❌'), body: [{ id: 'bot', bot: true }] },
        postOk,
      ],
      3,
    );
    expect(await a.requestApproval(signal, approvedDecision)).toBe('timeout');
  });

  it('treats silence as a refusal, never as consent', async () => {
    const { approver: a } = approver(
      [reactionPutOk, { match: '/reactions/', body: [] }, postOk],
      3,
    );
    expect(await a.requestApproval(signal, approvedDecision)).toBe('timeout');
  });

  it('treats an unaskable question as a refusal', async () => {
    const { approver: a } = approver([
      { match: `/channels/${CHANNEL}/messages`, networkError: true },
    ]);
    expect(await a.requestApproval(signal, approvedDecision)).toBe('unavailable');
  });

  it('keeps waiting rather than inventing a verdict when a poll fails', async () => {
    const { approver: a } = approver(
      [reactionPutOk, { match: '/reactions/', networkError: true }, postOk],
      3,
    );
    // A failed read is not an answer, so the deadline decides — and refuses.
    expect(await a.requestApproval(signal, approvedDecision)).toBe('timeout');
  });

  it('authenticates as a bot, and never puts the token in the URL', async () => {
    const { approver: a, fake } = approver([
      reactionPutOk,
      { match: encodeURIComponent('✅'), body: [{ id: 'u1' }] },
      { match: encodeURIComponent('❌'), body: [] },
      postOk,
    ]);
    await a.requestApproval(signal, approvedDecision);

    const headers = fake.calls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bot ${BOT_TOKEN}`);
    for (const url of fake.urls()) expect(url).not.toContain(BOT_TOKEN);
  });
});

describe('approval configuration', () => {
  it('refuses to boot with approval required but nobody to ask', () => {
    // A gate that cannot ask anyone refuses every trade, which looks exactly
    // like a strategy that never fires.
    expect(() => loadConfig({ REQUIRE_APPROVAL: 'true' })).toThrow(ConfigError);
  });

  it('boots when the bot is fully configured', () => {
    expect(() =>
      loadConfig({
        REQUIRE_APPROVAL: 'true',
        DISCORD_BOT_TOKEN: BOT_TOKEN,
        DISCORD_CHANNEL_ID: CHANNEL,
      }),
    ).not.toThrow();
  });

  it('is off by default', () => {
    expect(loadConfig({}).REQUIRE_APPROVAL).toBe(false);
  });
});
