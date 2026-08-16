import type {
  AdapterKind,
  Bar,
  BarInterval,
  HealthReport,
  MacroObservation,
  NormalizedDocument,
  Quote,
  SourceDescriptor,
} from '../domain/types.js';

/** Everything an adapter needs to advertise itself and be health-checked. */
export interface Adapter {
  readonly id: string;
  readonly kind: AdapterKind;
  /** Sources this adapter can emit documents for. */
  readonly sources: SourceDescriptor[];
  /** True when the adapter cannot run without credentials. */
  readonly requiresCredentials: boolean;
  /** Whether required credentials are present in the current configuration. */
  isConfigured(): boolean;
  /** Cheap liveness probe. Must never throw; report `unavailable` instead. */
  health(): Promise<HealthReport>;
}

export interface FetchWindow {
  /** Only return documents published at or after this instant. */
  since?: Date;
  /** Cap on documents returned per call. */
  limit?: number;
}

/** Adapters that emit documents (news, official sources, social). */
export interface DocumentSource extends Adapter {
  fetchDocuments(window?: FetchWindow): Promise<NormalizedDocument[]>;
}

/** Adapters that emit prices. */
export interface MarketDataSource extends Adapter {
  readonly kind: 'market_data';
  /** Documented delay of this feed — surfaced so callers can reject stale data. */
  readonly delayNote: string;
  getQuote(symbol: string): Promise<Quote>;
  getBars(
    symbol: string,
    interval: BarInterval,
    options: { start: Date; end?: Date; limit?: number },
  ): Promise<Bar[]>;
}

/** Adapters that emit macroeconomic series. */
export interface MacroSource extends Adapter {
  readonly kind: 'macro';
  getSeries(
    seriesId: string,
    options?: { start?: Date; end?: Date; limit?: number },
  ): Promise<MacroObservation[]>;
}

export function isDocumentSource(adapter: Adapter): adapter is DocumentSource {
  return typeof (adapter as DocumentSource).fetchDocuments === 'function';
}

export function isMarketDataSource(adapter: Adapter): adapter is MarketDataSource {
  return adapter.kind === 'market_data';
}

export function isMacroSource(adapter: Adapter): adapter is MacroSource {
  return adapter.kind === 'macro';
}
