#!/usr/bin/env tsx
import { mkdir, writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config/env.js';
import { loadEnvFile } from '../src/config/load-env.js';
import { redact } from '../src/core/redact.js';
import { formatSnapshotText, type AgentSnapshot } from '../apps/worker/snapshot.js';

/**
 * `npm run snapshot` — one text file with everything needed to diagnose the
 * live process from outside it, so a diagnosis is "paste me the snapshot"
 * rather than a round trip of "can you also run...".
 *
 * A thin HTTP client, not a second implementation: it reads the same
 * /api/diagnostic the dashboard exposes, from the already-running process —
 * a freshly started, unrelated agent instance has no cycle history or
 * activity feed of its own to report.
 */

loadEnvFile();
const config = loadConfig();
const OUT_PATH = 'data/snapshot.txt';

const url = `http://127.0.0.1:${config.DASHBOARD_PORT}/api/diagnostic`;
const headers: Record<string, string> = config.DASHBOARD_PASSWORD
  ? { authorization: `Basic ${Buffer.from(`${config.DASHBOARD_USER}:${config.DASHBOARD_PASSWORD}`).toString('base64')}` }
  : {};

try {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    console.error(`${url} returned ${response.status}. Is "npm run paper" or "npm run dashboard" running?`);
    process.exit(1);
  }
  // Already redacted once server-side, on the way out of /api/diagnostic.
  // Redacted again here because a leaked secret is the one mistake this file
  // exists to never make twice.
  const snapshot = redact(await response.json()) as AgentSnapshot;
  await mkdir('data', { recursive: true });
  await writeFile(OUT_PATH, formatSnapshotText(snapshot), 'utf8');
  console.log(`Snapshot written to ${OUT_PATH}`);
} catch (err) {
  console.error(`Could not reach ${url}: ${(err as Error).message}`);
  console.error('Start it first with "npm run paper" or "npm run dashboard".');
  process.exit(1);
}
