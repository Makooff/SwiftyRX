#!/usr/bin/env tsx
import { loadConfig } from '../src/config/env.js';
import { loadEnvFile } from '../src/config/load-env.js';
import { startApiServer } from '../apps/api/server.js';
import { TradingAgent } from '../apps/worker/agent.js';

/**
 * Dashboard only — serves the monitoring UI without running trading cycles.
 * Useful for inspecting configuration and source health without spending
 * LLM tokens or advancing the portfolio.
 */

loadEnvFile();
const config = loadConfig();
const agent = new TradingAgent({ config });

await agent.refreshHealth();
const port = Number(process.env.DASHBOARD_PORT ?? 3000);
await startApiServer({ agent, config, port });

console.log(`\nDashboard: http://127.0.0.1:${port}`);
console.log('No trading cycles are running — start those with `npm run paper`.\n');
