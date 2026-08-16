import { type Clock, systemClock } from '../../core/clock.js';
import { HttpClient, type FetchImpl } from '../../core/http.js';
import { createLogger, type Logger } from '../../core/logger.js';
import { TokenBucket } from '../../core/rate-limiter.js';
import type {
  AdapterKind,
  HealthReport,
  MacroObservation,
  SourceDescriptor,
} from '../../domain/types.js';
import { describeSource, sourceRegistry } from '../source-registry.js';
import type { MacroSource } from '../types.js';

/**
 * ECB Data Portal adapter (SDMX 2.1 REST).
 *
 * Verified constraints (see docs/API_RESEARCH.md):
 *  - No API key, no registration, free.
 *  - No published rate limit — so we self-impose a polite one.
 *  - Directly relevant to a euro-area operator: policy rates, HICP, FX.
 *
 * Series are addressed as {flowRef}/{key}, e.g. "EXR/D.USD.EUR.SP00.A".
 * We request `format=csvdata` because it is the most stable to parse.
 */

const ECB_SELF_IMPOSED_RPM = 60;

export const ECB_SERIES = {
  /** Euro/US dollar reference rate, daily. */
  eurUsdDaily: 'EXR/D.USD.EUR.SP00.A',
  /** Deposit facility rate. */
  depositFacilityRate: 'FM/D.U2.EUR.4F.KR.DFR.LEV',
  /** Main refinancing operations, fixed rate. */
  mainRefinancingRate: 'FM/D.U2.EUR.4F.KR.MRR_FR.LEV',
  /** HICP — overall index, euro area, annual rate of change. */
  hicpAnnualRate: 'ICP/M.U2.N.000000.4.ANR',
} as const;

export const ECB_SOURCE: SourceDescriptor = describeSource({
  id: 'ecb_data',
  name: 'ECB Data Portal',
  tier: 'official',
  jurisdiction: 'EU',
  url: 'https://data.ecb.europa.eu',
  licenceNote: 'Free reuse with attribution under the ECB copyright notice.',
});

export interface EcbOptions {
  clock?: Clock;
  logger?: Logger;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  userAgent?: string;
}

/** Parse the ECB `csvdata` response into rows keyed by column name. */
export function parseEcbCsv(csv: string): Array<Record<string, string>> {
  const lines = csv.trim().split(/\r?\n/);
  const headerLine = lines[0];
  if (!headerLine) return [];
  const headers = splitCsvLine(headerLine);

  const rows: Array<Record<string, string>> = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? '';
    });
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  out.push(current);
  return out.map((cell) => cell.trim());
}

export class EcbAdapter implements MacroSource {
  readonly kind = 'macro' as const;
  readonly id = 'ecb_data';
  readonly requiresCredentials = false;
  readonly sources = [ECB_SOURCE];

  private readonly http: HttpClient;
  private readonly clock: Clock;
  private lastSuccessAt?: string;

  constructor(options: EcbOptions = {}) {
    this.clock = options.clock ?? systemClock;
    const log = options.logger ?? createLogger('ecb');
    sourceRegistry.register(ECB_SOURCE);

    this.http = new HttpClient({
      name: 'ecb_data',
      baseUrl: 'https://data-api.ecb.europa.eu/service/',
      ...(options.userAgent ? { defaultHeaders: { 'user-agent': options.userAgent } } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      rateLimit: TokenBucket.perMinute(ECB_SELF_IMPOSED_RPM, this.clock),
      clock: this.clock,
      logger: log,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }

  isConfigured(): boolean {
    return true; // no credentials required
  }

  /**
   * @param seriesId "{flowRef}/{key}", e.g. "EXR/D.USD.EUR.SP00.A".
   */
  async getSeries(
    seriesId: string,
    options: { start?: Date; end?: Date; limit?: number } = {},
  ): Promise<MacroObservation[]> {
    const separator = seriesId.indexOf('/');
    if (separator <= 0) {
      throw new Error(`ECB series id must be "{flowRef}/{key}", received "${seriesId}"`);
    }
    const flowRef = seriesId.slice(0, separator);
    const key = seriesId.slice(separator + 1);

    const csv = await this.http.getText(`data/${flowRef}/${key}`, {
      accept: 'text',
      query: {
        format: 'csvdata',
        ...(options.start ? { startPeriod: options.start.toISOString().slice(0, 10) } : {}),
        ...(options.end ? { endPeriod: options.end.toISOString().slice(0, 10) } : {}),
        ...(options.limit && !options.start ? { lastNObservations: options.limit } : {}),
      },
    });

    const retrievedAt = this.clock.now().toISOString();
    this.lastSuccessAt = retrievedAt;

    const observations: MacroObservation[] = [];
    for (const row of parseEcbCsv(csv)) {
      const period = row.TIME_PERIOD ?? '';
      if (!period) continue;

      const rawValue = row.OBS_VALUE ?? '';
      const parsed = rawValue === '' || rawValue === 'NaN' ? null : Number(rawValue);

      observations.push({
        seriesId,
        ...(row.TITLE ? { title: row.TITLE } : {}),
        date: period,
        // A missing or unparseable observation stays null; coercing it to 0
        // would invent a data point the ECB never published.
        value: parsed !== null && Number.isNaN(parsed) ? null : parsed,
        ...(row.UNIT ? { units: row.UNIT } : {}),
        ...(row.FREQ ? { frequency: row.FREQ } : {}),
        source: ECB_SOURCE.id,
        freshness: {
          asOf: period,
          retrievedAt,
          delayClass: 'end_of_day',
          feed: 'ecb_data_portal',
        },
      });
    }

    // Newest first, matching the FRED adapter's ordering.
    observations.sort((a, b) => b.date.localeCompare(a.date));
    return options.limit ? observations.slice(0, options.limit) : observations;
  }

  async health(): Promise<HealthReport> {
    const checkedAt = this.clock.now().toISOString();
    const base = {
      adapter: this.id,
      kind: this.kind as AdapterKind,
      checkedAt,
      requiresCredentials: false,
      credentialsPresent: true,
    };

    const startedAt = this.clock.nowMs();
    try {
      const obs = await this.getSeries(ECB_SERIES.eurUsdDaily, { limit: 1 });
      return {
        ...base,
        state: obs.length > 0 ? 'healthy' : 'degraded',
        ...(obs.length === 0 ? { detail: 'query returned no observations' } : {}),
        latencyMs: this.clock.nowMs() - startedAt,
        ...(this.lastSuccessAt ? { lastSuccessAt: this.lastSuccessAt } : {}),
      };
    } catch (err) {
      return {
        ...base,
        state: 'unavailable',
        detail: (err as Error).message,
        latencyMs: this.clock.nowMs() - startedAt,
      };
    }
  }

  getStats() {
    return this.http.getStats();
  }
}
