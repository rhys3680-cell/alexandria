export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export function createLogger(level: LogLevel = 'info', sink: (line: string) => void = console.error): Logger {
  const min = ORDER[level];
  const emit = (lvl: LogLevel, message: string, meta?: unknown) => {
    if (ORDER[lvl] < min) return;
    const suffix = meta === undefined ? '' : ` ${safeJson(meta)}`;
    sink(`[${new Date().toISOString()}] ${lvl.toUpperCase()} ${message}${suffix}`);
  };
  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
