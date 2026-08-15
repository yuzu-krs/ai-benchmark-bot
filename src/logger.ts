export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const LEVEL_WEIGHTS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level: LogLevel): Logger {
  const threshold = LEVEL_WEIGHTS[level];
  const emit = (emitted: LogLevel, message: string, fields: LogFields = {}): void => {
    if (LEVEL_WEIGHTS[emitted] < threshold) return;
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: emitted,
      message,
      ...fields
    });
    if (emitted === "error") console.error(line);
    else if (emitted === "warn") console.warn(line);
    else console.log(line);
  };
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields)
  };
}

export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: error.message };
  }
  return { errorMessage: String(error) };
}
