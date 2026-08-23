import { config } from "../config.ts";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(config.logLevel as Level) in LEVELS ? (config.logLevel as Level) : "info"];

/** Keys whose values must never reach a log line. */
const SECRET_KEYS = /^(password|newPassword|currentPassword|token|token_hash|cookie|authorization|secret|preview)$/i;

function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object" || depth > 3) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.test(key) ? "[redacted]" : redact(val, depth + 1);
  }
  return out;
}

function emit(level: Level, message: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;
  const line = { t: new Date().toISOString(), level, msg: message, ...(fields ? (redact(fields) as object) : {}) };
  const text = config.isProd ? JSON.stringify(line) : `${level.padEnd(5)} ${message}${fields ? " " + JSON.stringify(redact(fields)) : ""}`;
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};

/** Short opaque id so a user-facing 500 can be tied to a log line. */
export function errorId(): string {
  return Math.random().toString(36).slice(2, 10);
}
