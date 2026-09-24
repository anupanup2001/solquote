import { describe, it, expect, vi } from "vitest";
import {
  OhlcAggregator,
  floorTsToMinute,
  floorTsToDay,
} from "../src/ohlc.js";
import type { Bar, Tick } from "../src/ohlc.js";

function buy(ts: number, price: string): Tick {
  return { ts, direction: "SOL_TO_USDC", price };
}
function sell(ts: number, price: string): Tick {
  return { ts, direction: "USDC_TO_SOL", price };
}

/** Fixed reference time inside a minute: 2026-09-23T14:07:03.512Z. */
const T0 = Date.parse("2026-09-23T14:07:03.512Z");
const M0 = floorTsToMinute(T0); // 14:07:00Z
const M1 = M0 + 60_000;

function harness() {
  const minuteBars: Bar[] = [];
  const dailyBars: Bar[] = [];
  const discarded: { count: number; reason: string }[] = [];
  const agg = new OhlcAggregator({
    onMinuteBar: (b) => minuteBars.push(b),
    onDailyBar: (b) => dailyBars.push(b),
    onDiscarded: (count, reason) => discarded.push({ count, reason }),
  });
  return { agg, minuteBars, dailyBars, discarded };
}

describe("floorTsToMinute / floorTsToDay", () => {
  it("floors to UTC minute", () => {
    expect(floorTsToMinute(T0)).toBe(Date.parse("2026-09-23T14:07:00Z"));
  });
  it("floors to UTC day", () => {
    expect(floorTsToDay(T0)).toBe(Date.parse("2026-09-23T00:00:00Z"));
  });
  it("floors across a UTC day boundary (23:59 -> 00:00Z)", () => {
    const late = Date.parse("2026-09-23T23:59:59.999Z");
    expect(floorTsToMinute(late)).toBe(Date.parse("2026-09-23T23:59:00Z"));
    expect(floorTsToDay(late + 1)).toBe(Date.parse("2026-09-24T00:00:00Z"));
  });
});

describe("OhlcAggregator", () => {
  it("first tick opens a bar; subsequent ticks update high/low/close/ticks", () => {
    const { agg, minuteBars } = harness();
    agg.push(buy(T0, "148.100000"));
    agg.push(buy(T0 + 5_000, "148.300000"));
    agg.push(buy(T0 + 10_000, "148.200000"));
    agg.emitDue(M1); // timer advances past the minute
    expect(minuteBars).toHaveLength(1);
    const bar = minuteBars[0]!;
    expect(bar.open).toBe("148.100000");
    expect(bar.high).toBe("148.300000");
    expect(bar.low).toBe("148.100000");
    expect(bar.close).toBe("148.200000");
    expect(bar.ticks).toBe(3);
  });

  it("tick in the next minute emits the completed bar and opens a new one", () => {
    const { agg, minuteBars } = harness();
    agg.push(buy(T0, "148.100000"));
    agg.push(buy(T0 + 65_000, "148.500000")); // 14:08
    expect(minuteBars).toHaveLength(1); // tick-driven fallback emitted 14:07
    expect(minuteBars[0]!.bucketStart).toBe(M0);
    agg.emitDue(M1 + 120_000);
    expect(minuteBars).toHaveLength(2);
    expect(minuteBars[1]!.bucketStart).toBe(M0 + 60_000);
  });

  it("gap minute produces no bar; next bar opens from the late tick", () => {
    const { agg, minuteBars } = harness();
    agg.push(buy(T0, "148.100000")); // 14:07
    // No ticks during 14:08; next tick at 14:09.
    const t2 = T0 + 120_000;
    agg.push(buy(t2, "148.900000"));
    // 14:07 bar emitted by tick-driven rollover; 14:08 has no row.
    expect(minuteBars).toHaveLength(1);
    agg.emitDue(t2 + 60_000); // timer closes 14:09
    expect(minuteBars).toHaveLength(2);
    expect(minuteBars[1]!.open).toBe("148.900000");
    // Gap accounting: minutes 14:08..14:08 (between emitted 14:07 and current 14:09) = 1
    expect(agg.takeSkippedMinutes()).toBe(1);
  });

  it("sell_close records last sell tick; empty when no sell ticks", () => {
    const { agg, minuteBars } = harness();
    agg.push(buy(T0, "148.100000"));
    agg.push(sell(T0 + 1_000, "148.120000"));
    agg.push(sell(T0 + 2_000, "148.150000"));
    agg.push(buy(T0 + 3_000, "148.200000"));
    agg.emitDue(M1);
    expect(minuteBars).toHaveLength(1);
    expect(minuteBars[0]!.sellClose).toBe("148.150000");
    expect(minuteBars[0]!.ticks).toBe(2); // buy ticks only
  });

  it("daily bar emits at UTC day rollover", () => {
    const { agg, dailyBars } = harness();
    const late = Date.parse("2026-09-23T23:59:00.500Z");
    agg.push(buy(late, "147.900000"));
    agg.emitDue(late + 60_000); // now 2026-09-24T00:00
    expect(dailyBars).toHaveLength(1);
    expect(dailyBars[0]!.bucketStart).toBe(Date.parse("2026-09-23T00:00:00Z"));
  });

  it("monotonic guard discards ticks at or before the last emitted bucket", () => {
    const { agg, minuteBars, discarded } = harness();
    agg.push(buy(T0, "148.100000"));
    agg.emitDue(M1); // 14:07 emitted
    agg.push(buy(T0 + 1_000, "148.100000")); // same old bucket -> discard
    agg.push(buy(T0 - 60_000, "147.000000")); // earlier -> discard
    expect(discarded).toHaveLength(2);
    expect(minuteBars).toHaveLength(1);
  });

  it("monotonic guard discards ticks whose bucket is before the open bar (backward clock step)", () => {
    const { agg, minuteBars, discarded } = harness();
    agg.push(buy(T0, "148.100000")); // 14:07 bar open, not yet emitted
    agg.push(buy(T0 - 10_000, "147.000000")); // 14:06 tick while 14:07 bar open
    expect(discarded).toHaveLength(1);
    expect(discarded[0]!.reason).toContain("< open bar");
    // open bar untouched by the stale tick
    agg.push(buy(T0 + 10_000, "148.300000"));
    agg.emitDue(M1);
    expect(minuteBars).toHaveLength(1);
    expect(minuteBars[0]!.low).toBe("148.100000");
    expect(minuteBars[0]!.ticks).toBe(2); // T0 + T0+10s only; stale tick discarded
  });
});
