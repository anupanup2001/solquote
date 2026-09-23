/**
 * Wiring (plan §2/§7): monotonic high-water-mark seeding, staggered
 * cadence-anchored poll loop, 1-second rollover timer, CSV writers,
 * health server, graceful shutdown.
 */
import { loadConfig, createLogger } from "./config.js";
import {
  JupiterClient,
  FatalApiError,
  sellUsdcAmount,
  parseFixed6,
} from "./jupiter.js";
import type { QuoteTick } from "./jupiter.js";
import {
  OhlcAggregator,
  formatMinuteBucket,
  formatUtcDate,
} from "./ohlc.js";
import type { Bar } from "./ohlc.js";
import { CsvWriter } from "./csvWriter.js";
import { TickLogger } from "./tickLogger.js";
import { startHealthServer } from "./health.js";

const JITTER_MS = 250;
const ROLLOVER_TIMER_MS = 1_000;
const SELL_STAGGER_MS = 2_500;

const MINUTE_HEADER = "ts,open,high,low,close,sell_close,ticks";
const DAILY_HEADER = "date,open,high,low,close,sell_close,ticks";

interface Writers {
  minute: CsvWriter;
  daily: CsvWriter;
  ticks: TickLogger;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL);
  log.info("solquote starting", {
    csvDir: cfg.CSV_DIR,
    pollIntervalMs: cfg.POLL_INTERVAL_MS,
    port: cfg.PORT,
  });

  const health = { lastTickAt: null as number | null, lastErrorAt: null as number | null };
  const healthServer = await startHealthServer(cfg.PORT, health, cfg.POLL_INTERVAL_MS);
  log.info("health server listening", { port: cfg.PORT });

  const writers: Writers = {
    minute: new CsvWriter(cfg.CSV_DIR, {
      fileNameFor: (date) => `ohlc-1m-${date}.csv`,
      header: MINUTE_HEADER,
      keyOf: (fields) => fields[0] ?? "",
    }),
    daily: new CsvWriter(cfg.CSV_DIR, {
      fileNameFor: () => "ohlc-1d.csv",
      header: DAILY_HEADER,
      keyOf: (fields) => fields[0] ?? "",
    }),
    ticks: new TickLogger(cfg.CSV_DIR),
  };

  // --- Boot: monotonic high-water mark (plan §4, review round 1) -------------
  // In-progress-bar resume is intentionally unsupported (owner decision,
  // review round 1): a crash mid-minute forfeits that minute's partial OHLC
  // row (gap semantics; raw tick CSV keeps full provenance). Writers only
  // seed their last written key so appends can never duplicate a persisted
  // row after a restart.
  const bootDate = formatUtcDate(Date.now());
  writers.minute.seedLastKeyFromFile(bootDate);
  writers.daily.seedLastKeyFromFile(bootDate);
  writers.ticks.seed(bootDate);
  log.info("boot: monotonic high-water mark seeded; in-progress-bar resume intentionally unsupported (partial minute forfeited on crash)");

  let lastPrice6 = 150n * 10n ** 6n; // boot default 150.0 USDC/SOL (plan §3.3)
  let shutdown = false;
  let pollInFlight = false;

  const aggregator = new OhlcAggregator({
    onMinuteBar: (bar) => void writeMinuteBar(bar),
    onDailyBar: (bar) => void writeDailyBar(bar),
    onDiscarded: (count, reason) => log.warn("ticks discarded (monotonic guard)", { count, reason }),
  });

  async function writeMinuteBar(bar: Bar): Promise<void> {
    const ts = formatMinuteBucket(bar.bucketStart);
    writers.minute.append(formatUtcDate(bar.bucketStart), ts, [
      ts,
      bar.open,
      bar.high,
      bar.low,
      bar.close,
      bar.sellClose,
      String(bar.ticks),
    ]);
    await writers.minute.drain(); // flush per bar, like daily bars (review round 1)
  }

  async function writeDailyBar(bar: Bar): Promise<void> {
    const date = formatUtcDate(bar.bucketStart);
    writers.daily.append(date, date, [
      date,
      bar.open,
      bar.high,
      bar.low,
      bar.close,
      bar.sellClose,
      String(bar.ticks),
    ]);
    await writers.daily.drain();
  }

  function flushGapWarnings(): void {
    const skipped = aggregator.takeSkippedMinutes();
    if (skipped > 0) log.warn("gap minutes (no successful ticks)", { skipped });
  }

  function ingest(tick: QuoteTick): void {
    aggregator.push(tick);
    writers.ticks.append(tick);
    health.lastTickAt = tick.ts;
  }

  // --- Startup smoke test (plan §3.5) ---------------------------------------
  const client = new JupiterClient(cfg.JUP_API, log);
  try {
    const smoke = await client.smokeTest();
    log.info("startup smoke test ok", { price: smoke.price, router: smoke.router });
    ingest(smoke);
    lastPrice6 = parseFixed6(smoke.price);
  } catch (err) {
    log.error("startup smoke test failed", { error: String(err) });
    await stop(1);
    return;
  }

  // --- Poll loop (plan §3.4): jittered, staggered, cadence-anchored ---------
  // Cadence is anchored (review round 1): tick N is scheduled at
  // anchor + POLL_INTERVAL_MS ± jitter, independent of how long the previous
  // cycle took, so buy-side samples land every ~5s. pollInFlight skip +
  // Math.max(0, …) handle slow cycles without stacking.
  let nextTickAt = 0;

  async function pollCycle(): Promise<void> {
    // Buy side: SOL→USDC
    const buy = await client.getQuote("SOL_TO_USDC", BigInt(cfg.QUOTE_SOL_LAMPORTS));
    if (buy && !shutdown) {
      ingest(buy);
      lastPrice6 = parseFixed6(buy.price);
    }
    if (shutdown) return;

    // Sell side: USDC→SOL, staggered +2.5s, sized ~0.1 SOL notional (plan §3.3).
    await sleep(SELL_STAGGER_MS);
    if (shutdown) return;
    const amount = sellUsdcAmount(lastPrice6, BigInt(cfg.QUOTE_SOL_LAMPORTS));
    const sell = await client.getQuote("USDC_TO_SOL", amount);
    if (sell && !shutdown) ingest(sell);
  }

  function scheduleNext(anchor: number): void {
    if (shutdown) return;
    nextTickAt = anchor + cfg.POLL_INTERVAL_MS + Math.floor(Math.random() * (2 * JITTER_MS + 1)) - JITTER_MS;
    const delayMs = Math.max(0, nextTickAt - Date.now());
    setTimeout(() => {
      void (async () => {
        if (shutdown) return;
        if (pollInFlight) {
          log.warn("poll cycle still in flight — skipping this tick slot", {
            slot: new Date(nextTickAt).toISOString(),
          });
          scheduleNext(nextTickAt);
          return;
        }
        pollInFlight = true;
        try {
          await pollCycle();
        } catch (err) {
          if (err instanceof FatalApiError) {
            log.error("fatal API error — exiting", { status: err.status, error: err.message });
            await stop(1);
            return;
          }
          health.lastErrorAt = Date.now();
          log.error("poll cycle error", { error: String(err) });
        } finally {
          pollInFlight = false;
          flushGapWarnings();
          // Anchor the next slot on this slot's scheduled time, not cycle
          // completion, so the 5s cadence holds even for slow cycles.
          if (!shutdown) scheduleNext(nextTickAt);
        }
      })();
    }, delayMs);
  }

  // 1-second rollover timer: primary bar emission driver (plan §4).
  const rolloverTimer = setInterval(() => {
    aggregator.emitDue(Date.now());
    flushGapWarnings();
  }, ROLLOVER_TIMER_MS);

  scheduleNext(Date.now());

  // --- Graceful shutdown (plan §7) -------------------------------------------
  let stopping = false;

  async function stop(code: number): Promise<void> {
    if (stopping) return;
    stopping = true;
    shutdown = true;
    clearInterval(rolloverTimer);
    // In-progress bars are NOT emitted (never closed; gap semantics, plan §7).
    // Bars for fully-elapsed minutes were flushed by the rollover timer ≤1s ago.
    await Promise.allSettled([
      writers.minute.close(),
      writers.daily.close(),
      writers.ticks.close(),
    ]);
    healthServer.close();
    process.exit(code);
  }

  process.on("SIGTERM", () => void stop(0));
  process.on("SIGINT", () => void stop(0));
  process.on("uncaughtException", (err) => {
    log.error("uncaught exception", { error: String(err?.stack ?? err) });
    void stop(1);
  });
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", { error: String(reason) });
    void stop(1);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(JSON.stringify({ level: "error", msg: "fatal", error: String(err?.stack ?? err) }));
  process.exit(1);
});
