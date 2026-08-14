export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(minimumLevel: LogLevel = "info"): Logger {
  const minimum = LEVELS[minimumLevel];

  const write = (level: LogLevel, message: string, fields: Record<string, unknown> = {}) => {
    if (LEVELS[level] < minimum) return;
    const record = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...fields
    });
    if (level === "error") console.error(record);
    else if (level === "warn") console.warn(record);
    else console.log(record);
  };

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields)
  };
}

export function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: error.message, stack: error.stack };
  }
  return { error: String(error) };
}
