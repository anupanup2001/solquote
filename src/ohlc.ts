/**
 * Pure OHLC aggregation for SOL/USDC ticks.
 * No I/O, no clocks — all time comes from tick timestamps or the `now`
 * argument passed to `emitDue()`, keeping the module trivially testable.
 *
 * Series semantics (plan §4, amended): each bar carries TWO complete
 * per-side candles — `buy` tracks the USDC_TO_SOL series (the executable
 * price when buying SOL) and `sell` tracks the SOL_TO_USDC series (the
 * executable price when selling SOL). Both are normalized USDC-per-SOL.
 */

export type Direction = "SOL_TO_USDC" | "USDC_TO_SOL";

export interface Tick {
  /** epoch ms (UTC) of the quote */
  ts: number;
  direction: Direction;
  /** normalized USDC-per-SOL price as a decimal string */
  price: string;
}

export interface SideBar {
  open: string;
  high: string;
  low: string;
  close: string;
  /** count of this side's ticks in the bucket (0 when the side had none) */
  ticks: number;
}

export interface Bar {
  /** bucket start, epoch ms (minute or day) */
  bucketStart: number;
  /** USDC_TO_SOL series — the executable price for buying SOL */
  buy: SideBar;
  /** SOL_TO_USDC series — the executable price for selling SOL */
  sell: SideBar;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Floor an epoch-ms timestamp to the start of its UTC minute. */
export function floorTsToMinute(ts: number): number {
  return Math.floor(ts / MINUTE_MS) * MINUTE_MS;
}

/** Floor an epoch-ms timestamp to the start of its UTC day. */
export function floorTsToDay(ts: number): number {
  return Math.floor(ts / DAY_MS) * DAY_MS;
}

/** Format a minute bucket (epoch ms) as `YYYY-MM-DDTHH:MM:00Z`. */
export function formatMinuteBucket(bucketStart: number): string {
  return `${formatUtcDate(bucketStart)}T${formatUtcTime(bucketStart)}Z`;
}

/** Format epoch ms as `YYYY-MM-DD` (UTC). */
export function formatUtcDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function formatUtcTime(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}

/** Compare two decimal price strings numerically (equal-scale 6dp strings). */
export function comparePrices(a: string, b: string): number {
  const av = Number(a);
  const bv = Number(b);
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

export interface AggregatorEvents {
  /** Completed 1-min bar, emitted on rollover. */
  onMinuteBar: (bar: Bar) => void;
  /** Completed daily bar, emitted at UTC-day rollover. */
  onDailyBar: (bar: Bar) => void;
  /** Ticks discarded by the monotonic guard. */
  onDiscarded?: (count: number, reason: string) => void;
}

function newSideBar(): SideBar {
  return { open: "", high: "", low: "", close: "", ticks: 0 };
}

function newBar(bucketStart: number): Bar {
  return { bucketStart, buy: newSideBar(), sell: newSideBar() };
}

export class OhlcAggregator {
  private minuteBar: Bar | null = null;
  private dailyBar: Bar | null = null;
  private lastEmittedMinute = 0;
  private skippedMinutes = 0;

  constructor(private readonly events: AggregatorEvents) {}

  /**
   * Ingest a tick. Completed bars are delivered via events.
   * Monotonic guard (plan §4): discard ticks whose bucket is at or before
   * the last emitted minute bucket, or before the currently open bar's
   * bucket (covers an open bar that has not been emitted yet — e.g. a
   * backward clock step within the same minute).
   */
  push(tick: Tick): void {
    const bucket = floorTsToMinute(tick.ts);

    if (bucket <= this.lastEmittedMinute) {
      this.events.onDiscarded?.(
        1,
        `tick bucket ${formatMinuteBucket(bucket)} <= last emitted ${formatMinuteBucket(this.lastEmittedMinute)}`,
      );
      return;
    }
    if (this.minuteBar && bucket < this.minuteBar.bucketStart) {
      this.events.onDiscarded?.(
        1,
        `tick bucket ${formatMinuteBucket(bucket)} < open bar ${formatMinuteBucket(this.minuteBar.bucketStart)}`,
      );
      return;
    }

    // Tick-driven rollover fallback: a tick in a newer bucket means the
    // previous bar is complete even if the 1s timer hasn't fired yet.
    if (this.minuteBar && this.minuteBar.bucketStart < bucket) {
      this.emitMinuteBar();
    }
    if (!this.minuteBar) {
      // Fresh bar after an outage: account for fully-skipped minutes between
      // the last emitted bar and this new bar (plan §4 gap semantics).
      if (this.lastEmittedMinute > 0 && bucket > this.lastEmittedMinute) {
        const gap = Math.floor((bucket - this.lastEmittedMinute) / MINUTE_MS) - 1;
        if (gap > 0) this.skippedMinutes += gap;
      }
      this.minuteBar = newBar(bucket);
    }
    this.applyToBar(this.minuteBar, tick);

    if (this.dailyBar && this.dailyBar.bucketStart < floorTsToDay(bucket)) {
      this.emitDailyBar();
    }
    if (!this.dailyBar) this.dailyBar = newBar(floorTsToDay(bucket));
    this.applyToBar(this.dailyBar, tick);
  }

  /**
   * Timer-driven emission (call every 1s). Emits bars whose bucket is fully
   * in the past relative to `now`. Gap minutes are counted when a bar is
   * created (see `push`), not here, to avoid double counting.
   */
  emitDue(now: number): void {
    const currentMinute = floorTsToMinute(now);
    if (this.minuteBar && this.minuteBar.bucketStart < currentMinute) {
      this.emitMinuteBar();
    }
    if (this.dailyBar && floorTsToDay(this.dailyBar.bucketStart) < floorTsToDay(now)) {
      this.emitDailyBar();
    }
  }

  /** Skipped (gap) minute count accumulated since last take. */
  takeSkippedMinutes(): number {
    const n = this.skippedMinutes;
    this.skippedMinutes = 0;
    return n;
  }

  private emitMinuteBar(): void {
    if (!this.minuteBar) return;
    this.lastEmittedMinute = this.minuteBar.bucketStart;
    const bar = this.minuteBar;
    this.minuteBar = null;
    this.events.onMinuteBar(bar);
  }

  private emitDailyBar(): void {
    if (!this.dailyBar) return;
    const bar = this.dailyBar;
    this.dailyBar = null;
    this.events.onDailyBar(bar);
  }

  private applyToBar(bar: Bar, tick: Tick): void {
    const side = tick.direction === "USDC_TO_SOL" ? bar.buy : bar.sell;
    if (side.open === "") {
      side.open = tick.price;
      side.high = tick.price;
      side.low = tick.price;
    } else {
      if (comparePrices(tick.price, side.high) > 0) side.high = tick.price;
      if (comparePrices(tick.price, side.low) < 0) side.low = tick.price;
    }
    side.close = tick.price;
    side.ticks += 1;
  }
}
