import { createServer, type Server } from 'node:http';
import type { AppConfig } from '../../src/config/env.js';
import { createLogger, type Logger } from '../../src/core/logger.js';
import { redact } from '../../src/core/redact.js';
import { metrics } from '../../src/monitoring/metrics.js';
import { renderDashboard, type DashboardData } from '../dashboard/render.js';
import type { TradingAgent } from '../worker/agent.js';
import { assertExposureIsSafe, authorise } from './auth.js';

/**
 * Dashboard and monitoring API.
 *
 * Local-first: binds to 127.0.0.1 by default, because this surface exposes
 * portfolio state and should not be reachable from the network without a
 * deliberate decision. Every response passes through the same redaction path
 * as the logs, so no credential can leave through this door either.
 *
 * Read-only by design: there is no endpoint that places, cancels or modifies an
 * order. The dashboard observes; it does not act.
 */

export interface ApiServerOptions {
  agent: TradingAgent;
  config: AppConfig;
  port?: number;
  host?: string;
  logger?: Logger;
}

function buildDashboardData(agent: TradingAgent, config: AppConfig): DashboardData {
  const portfolio = agent.portfolio;
  return {
    mode: config.MODE,
    paperTrading: config.PAPER_TRADING,
    liveTrading: config.LIVE_TRADING,
    currency: portfolio.currency,
    portfolio: {
      initialCapital: portfolio.initialCash,
      totalValue: portfolio.totalValue,
      cash: portfolio.availableCash,
      totalReturnPct: portfolio.totalReturnPct,
      drawdownPct: portfolio.drawdownPct,
      maxDrawdownPct: portfolio.maxDrawdown,
      exposurePct: portfolio.exposurePct,
      positions: portfolio.openPositions.map((position) => ({
        symbol: position.symbol,
        quantity: position.quantity,
        averagePrice: position.averagePrice,
        marketValue: position.marketValue,
        unrealisedPnl: position.unrealisedPnl,
      })),
    },
    signals: agent.getSignals(),
    events: agent.getEvents(),
    orders: agent.getOrders(),
    health: agent.getHealth(),
    agent: agent.getState(),
    llmProvider: agent.getLlmProviderId(),
  };
}

export function createApiServer(options: ApiServerOptions): Server {
  const log = options.logger ?? createLogger('api');
  const { agent, config } = options;

  return createServer((req, res) => {
    // Before anything is read, rendered or serialised.
    if (!authorise(req, res, { user: config.DASHBOARD_USER, password: config.DASHBOARD_PASSWORD })) {
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      // Redaction on the way out, for the same reason it exists on the way
      // into the logs: one chokepoint, no exceptions.
      res.end(JSON.stringify(redact(body), null, 2));
    };

    try {
      switch (url.pathname) {
        case '/':
        case '/dashboard': {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(renderDashboard(buildDashboardData(agent, config)));
          return;
        }
        case '/api/state':
          return json(200, buildDashboardData(agent, config));
        case '/api/portfolio':
          return json(200, buildDashboardData(agent, config).portfolio);
        case '/api/signals':
          return json(200, agent.getSignals());
        case '/api/events':
          return json(200, agent.getEvents());
        case '/api/orders':
          return json(200, agent.getOrders());
        case '/api/health': {
          const health = agent.getHealth();
          const unavailable = health.filter((h) => h.state === 'unavailable');
          return json(unavailable.length > 0 ? 503 : 200, {
            status: unavailable.length > 0 ? 'degraded' : 'ok',
            mode: config.MODE,
            liveTrading: config.LIVE_TRADING,
            agent: agent.getState(),
            lastCycleAgeSeconds: agent.cycleAgeSeconds(),
            sources: health,
          });
        }
        case '/api/metrics':
          return json(200, metrics.snapshot());
        default:
          return json(404, { error: 'not found' });
      }
    } catch (err) {
      log.error({ path: url.pathname, error: (err as Error).message }, 'request failed');
      json(500, { error: 'internal error' });
    }
  });
}

export async function startApiServer(options: ApiServerOptions): Promise<Server> {
  const port = options.port ?? options.config.DASHBOARD_PORT;
  // Loopback by default: portfolio state is not something to publish by
  // accident on a shared network.
  const host = options.host ?? options.config.DASHBOARD_HOST;

  // Second gate, after the config loader. Both must open, for the same reason
  // live trading has two: one check is one mistake away.
  assertExposureIsSafe(host, options.config.DASHBOARD_PASSWORD);

  const server = createApiServer(options);
  const log = options.logger ?? createLogger('api');

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  log.info(
    { url: `http://${host}:${port}`, authenticated: Boolean(options.config.DASHBOARD_PASSWORD) },
    'dashboard listening',
  );
  return server;
}
