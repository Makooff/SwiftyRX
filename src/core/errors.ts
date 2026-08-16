/** Base class for all errors raised by this system. */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly context: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
  }
}

/** An upstream HTTP API returned an error or could not be reached. */
export class UpstreamError extends AppError {
  constructor(
    message: string,
    public readonly status: number | undefined,
    context: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, { ...context, status }, options);
  }

  /** 429 / 5xx / network failures are worth retrying; 4xx generally is not. */
  get retryable(): boolean {
    if (this.status === undefined) return true; // network-level failure
    if (this.status === 429) return true;
    return this.status >= 500;
  }
}

/** The provider refused the request because we exceeded its published quota. */
export class RateLimitError extends UpstreamError {
  constructor(
    message: string,
    public readonly retryAfterMs: number | undefined,
    context: Record<string, unknown> = {},
  ) {
    super(message, 429, { ...context, retryAfterMs });
  }
}

/** A circuit breaker is open: the provider is presumed unhealthy. */
export class CircuitOpenError extends AppError {}

/**
 * Data exists but is too old to act on. Callers must treat this as
 * "DO NOT TRADE", never as "use it anyway".
 */
export class StaleDataError extends AppError {
  constructor(
    message: string,
    public readonly ageSeconds: number,
    public readonly maxAgeSeconds: number,
    context: Record<string, unknown> = {},
  ) {
    super(message, { ...context, ageSeconds, maxAgeSeconds });
  }
}

/** A configured budget (money or quota) would be exceeded by this call. */
export class BudgetExceededError extends AppError {}

/** An adapter received a payload it could not trust or parse. */
export class DataIntegrityError extends AppError {}
