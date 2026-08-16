#!/usr/bin/env tsx
import { ConfigError, loadConfig } from '../src/config/env.js';
import { diagnose, summarise, type CheckStatus } from '../src/config/doctor.js';
import { loadEnvFile } from '../src/config/load-env.js';

/**
 * `npm run doctor` — what works, what does not, and what to do about it.
 *
 * Exits non-zero only when something blocks trading entirely, so it is usable
 * as a setup gate. A degraded capability is not a failure: running with no
 * credentials at all is a supported, documented state.
 */

loadEnvFile();

const MARK: Record<CheckStatus, string> = {
  ok: '  ok      ',
  blocking: '  BLOCKING',
  degraded: '  degraded',
  off: '  off     ',
};

try {
  const config = loadConfig();
  const diagnostics = diagnose(config);
  const summary = summarise(diagnostics);

  console.log('\n=== AI Market Agent — setup doctor ===\n');

  for (const check of diagnostics) {
    console.log(`${MARK[check.status]}  ${check.label}`);
    console.log(`              ${check.impact}`);
    if (check.remedy) console.log(`              -> ${check.remedy}`);
    if (check.url) console.log(`              ${check.url}`);
    console.log('');
  }

  console.log(`  ${summary.headline}\n`);

  if (summary.readiness !== 'blocked') {
    console.log('  Next, in order:');
    console.log('    npm run sources:check    probe every source — no adapter here has ever');
    console.log('                             run against its live API, so expect to fix one');
    console.log('    npm run backtest -- --symbol AAPL --years 5 --walk-forward');
    console.log('    npm run paper            leave it running for weeks, not hours\n');
  }

  process.exit(summary.readiness === 'blocked' ? 1 : 0);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error('\nConfiguration rejected before any check could run:\n');
    for (const problem of err.problems) console.error(`  - ${problem}`);
    console.error('');
    process.exit(1);
  }
  throw err;
}
