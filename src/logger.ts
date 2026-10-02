import { redactDeep } from './redact.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export type Logger = {
  level: LogLevel;
  secrets: string[];
  debug(event: string, data?: Record<string, unknown>): void;
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
};

/**
 * Structured JSON logging on **stderr**. stdout is reserved for the MCP stdio
 * transport, so nothing here may ever write to stdout. Every payload is passed
 * through secret redaction before serialization.
 */
export function createLogger(
  level: LogLevel = 'info',
  secrets: string[] = [],
  bindings: Record<string, unknown> = {},
  sink: (line: string) => void = (line) => process.stderr.write(line + '\n'),
): Logger {
  const emit = (
    lvl: Exclude<LogLevel, 'silent'>,
    event: string,
    data?: Record<string, unknown>,
  ) => {
    if (ORDER[lvl] < ORDER[level] || level === 'silent') return;
    const payload = {
      ts: new Date().toISOString(),
      level: lvl,
      event,
      ...bindings,
      ...(data ?? {}),
    };
    try {
      sink(JSON.stringify(redactDeep(payload, logger.secrets)));
    } catch {
      sink(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: 'warn',
          event: 'log_serialize_failed',
        }),
      );
    }
  };

  const logger: Logger = {
    level,
    secrets,
    debug: (e, d) => emit('debug', e, d),
    info: (e, d) => emit('info', e, d),
    warn: (e, d) => emit('warn', e, d),
    error: (e, d) => emit('error', e, d),
    child: (extra) => createLogger(level, secrets, { ...bindings, ...extra }, sink),
  };
  return logger;
}
