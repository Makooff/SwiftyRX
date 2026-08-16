#!/usr/bin/env tsx
import { loadConfig } from '../src/config/env.js';
import { loadEnvFile } from '../src/config/load-env.js';
import type { HealthState } from '../src/domain/types.js';
import { buildIngestionStack, checkStackHealth } from '../src/ingestion/pipeline.js';

/**
 * Live health check against every configured data source.
 *
 * This is the honest answer to "what can this system actually see right now?".
 * It makes real network calls (except for providers whose health probe would
 * spend a metered quota — those report configuration state instead).
 */

loadEnvFile();
const config = loadConfig();

const ICON: Record<HealthState, string> = {
  healthy: 'OK  ',
  degraded: 'WARN',
  unavailable: 'FAIL',
  disabled: 'OFF ',
};

const stack = buildIngestionStack(config, { includeFixtureMarketData: true });

console.log('\n=== Data source health ===\n');

const reports = await checkStackHealth(stack);
reports.sort((a, b) => a.kind.localeCompare(b.kind) || a.adapter.localeCompare(b.adapter));

for (const report of reports) {
  const latency = report.latencyMs === undefined ? '' : ` (${report.latencyMs}ms)`;
  console.log(`[${ICON[report.state]}] ${report.kind.padEnd(12)} ${report.adapter}${latency}`);
  if (report.detail) console.log(`         ${report.detail}`);
}

const unavailable = reports.filter((r) => r.state === 'unavailable');
const healthy = reports.filter((r) => r.state === 'healthy');

console.log(
  `\n${healthy.length} healthy, ${reports.filter((r) => r.state === 'degraded').length} degraded, ` +
    `${unavailable.length} unavailable, ${reports.filter((r) => r.state === 'disabled').length} disabled.`,
);
console.log(`Market data providers configured: ${stack.marketData.configuredProviders.join(', ') || 'none'}`);
console.log('');

// A non-zero exit means at least one configured source is broken, which is
// exactly the condition that must block trading later on.
process.exit(unavailable.length > 0 ? 1 : 0);
