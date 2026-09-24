import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  JUP_API: z
    .string()
    .min(1, "JUP_API is required (get one at https://developers.jup.ag/portal)")
    .startsWith("jup_", "JUP_API should look like jup_... (Jupiter portal key)"),
  CSV_DIR: z.string().default("./data"), // Docker image sets CSV_DIR=/app/data via ENV
  POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
  QUOTE_SOL_LAMPORTS: z.coerce
    .number()
    .int()
    .positive()
    .default(100_000_000),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error"])
    .default("info"),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(env)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return parsed.data;
}

export type LogLevel = Config["LOG_LEVEL"];

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level: LogLevel) {
  const threshold = LEVELS[level];
  const emit = (lvl: LogLevel, msg: string, extra?: Record<string, unknown>) => {
    if (LEVELS[lvl] < threshold) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...extra });
    if (lvl === "error" || lvl === "warn") console.error(line);
    else console.log(line);
  };
  return {
    debug: (msg: string, extra?: Record<string, unknown>) => emit("debug", msg, extra),
    info: (msg: string, extra?: Record<string, unknown>) => emit("info", msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => emit("warn", msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => emit("error", msg, extra),
  };
}

export type Logger = ReturnType<typeof createLogger>;
