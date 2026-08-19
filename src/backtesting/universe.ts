/**
 * Resolving the set of symbols a study runs over.
 *
 * Trivial at three tickers typed on a command line, and not trivial at three
 * hundred read from a file: the study calls the SEC adapter directly, bypassing
 * the ingestion deduplicator, so a symbol listed twice contributes its filings
 * twice. That inflates `sampleSize` and `clusters`, which are exactly the two
 * numbers the 30-observation and 10-symbol bars are checked against — a
 * duplicate does not merely add noise, it can carry a category over the bar
 * that decides whether it is tested at all.
 */

export interface UniverseResolution {
  symbols: string[];
  /** Symbols that appeared more than once, named so a bad list is fixable. */
  duplicates: string[];
}

/**
 * Parse a symbol list file: one ticker per line, or comma-separated, with `#`
 * comments. Blank lines are ignored.
 */
export function parseSymbolsFile(contents: string): string[] {
  return contents
    .split('\n')
    .map((line) => line.split('#')[0] ?? '')
    .flatMap((line) => line.split(','))
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
}

/** Order-preserving dedup, reporting what it removed rather than quietly fixing it. */
export function resolveUniverse(raw: string[]): UniverseResolution {
  const seen = new Set<string>();
  const symbols: string[] = [];
  const duplicates = new Set<string>();

  for (const entry of raw) {
    const symbol = entry.trim().toUpperCase();
    if (!symbol) continue;
    if (seen.has(symbol)) {
      duplicates.add(symbol);
      continue;
    }
    seen.add(symbol);
    symbols.push(symbol);
  }

  return { symbols, duplicates: [...duplicates] };
}

/**
 * SEC EDGAR requests the study will make, and the floor on how long they take.
 *
 * One submissions request per symbol, against the adapter's self-imposed 5
 * requests per second. A floor, not a prediction: it ignores the bars, which
 * come from a different provider on its own limit, and it assumes no retries.
 * Printed so that launching a three-hundred-symbol run is a decision rather
 * than a surprise.
 */
export function secFetchFloorSeconds(symbolCount: number, requestsPerSecond = 5): number {
  if (symbolCount <= 0) return 0;
  return symbolCount / requestsPerSecond;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.ceil(seconds % 60);
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}
