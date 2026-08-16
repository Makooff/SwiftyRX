import pino from 'pino';
import { redact } from './redact.js';

const level = process.env.LOG_LEVEL ?? 'info';
const pretty = (process.env.LOG_PRETTY ?? 'true').toLowerCase() !== 'false';

const base = pino({
  level,
  // Structured logs by default; pretty only for local development.
  ...(pretty && process.env.NODE_ENV !== 'production'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }
    : {}),
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Belt and braces: pino's own key redaction on top of our deep redactor.
  redact: {
    paths: [
      'apiKey',
      'api_key',
      'secret',
      'token',
      'password',
      'headers.authorization',
      'headers.Authorization',
      'headers["apca-api-secret-key"]',
      '*.apiKey',
      '*.secret',
      '*.token',
    ],
    censor: '[REDACTED]',
  },
});

export type LogContext = Record<string, unknown>;

export interface Logger {
  trace(ctx: LogContext, msg: string): void;
  debug(ctx: LogContext, msg: string): void;
  info(ctx: LogContext, msg: string): void;
  warn(ctx: LogContext, msg: string): void;
  error(ctx: LogContext, msg: string): void;
  child(ctx: LogContext): Logger;
}

function wrap(instance: pino.Logger): Logger {
  const emit =
    (fn: 'trace' | 'debug' | 'info' | 'warn' | 'error') => (ctx: LogContext, msg: string) => {
      instance[fn](redact(ctx) as LogContext, msg);
    };
  return {
    trace: emit('trace'),
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (ctx: LogContext) => wrap(instance.child(redact(ctx) as LogContext)),
  };
}

export const logger: Logger = wrap(base);

export function createLogger(component: string, ctx: LogContext = {}): Logger {
  return logger.child({ component, ...ctx });
}
