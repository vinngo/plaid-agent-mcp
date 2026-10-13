// Minimal structured logger. Writes to stderr so it never interferes with any
// stdout-based protocol and stays readable in CloudWatch.

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;

// Redact anything that looks like a secret so access tokens never hit the logs.
const SECRET_KEY = /(secret|token|access|api[_-]?key|password|authorization)/i;

function redact(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && typeof v === "string" ? mask(v) : redact(v);
    }
    return out;
  }
  return value;
}

function mask(v: string): string {
  if (v.length <= 8) return "***";
  return `${v.slice(0, 4)}…${v.slice(-2)}`;
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    msg,
  };
  if (meta) Object.assign(line, redact(meta) as Record<string, unknown>);
  process.stderr.write(`${JSON.stringify(line)}\n`);
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};
