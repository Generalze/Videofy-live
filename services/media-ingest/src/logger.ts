type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let configuredLevel: LogLevel = 'info';

export function setLogLevel(level: string): void {
  if (level in LEVELS) configuredLevel = level as LogLevel;
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[configuredLevel]) return;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: 'media-ingest',
    message,
    ...meta,
  };
  const out = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') process.stderr.write(out + '\n');
  else process.stdout.write(out + '\n');
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => log('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => log('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log('error', msg, meta),
};
