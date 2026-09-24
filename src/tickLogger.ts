/**
 * Raw tick provenance CSV (plan §5): one row per successful quote,
 * both directions, rotated daily.
 */
import { CsvWriter } from "./csvWriter.js";
import type { QuoteTick } from "./jupiter.js";

const HEADER = "ts,direction,inAmount,outAmount,price,priceImpact,router,feeBps,inUsdValue,outUsdValue";

export class TickLogger {
  private readonly writer: CsvWriter;

  constructor(dir: string) {
    this.writer = new CsvWriter(dir, {
      fileNameFor: (date) => `ticks-${date}.csv`,
      header: HEADER,
      // Key is epoch-ms: 13-digit ms timestamps sort lexicographically the
      // same as chronologically until year 2286 (when they go 14-digit).
      keyOf: (fields) => String(Date.parse(fields[0] ?? "")),
    });
  }

  /** Seed the monotonic guard from today's existing tick file (recovery). */
  seed(date: string): void {
    this.writer.seedLastKeyFromFile(date);
  }

  append(tick: QuoteTick): boolean {
    const date = new Date(tick.ts).toISOString().slice(0, 10);
    return this.writer.append(date, `${tick.ts}`, [
      new Date(tick.ts).toISOString(), // full ISO with ms
      tick.direction,
      tick.inAmount,
      tick.outAmount,
      tick.price,
      tick.priceImpact,
      tick.router,
      tick.feeBps,
      tick.inUsdValue,
      tick.outUsdValue,
    ]);
  }

  drain(): Promise<void> {
    return this.writer.drain();
  }

  close(): Promise<void> {
    return this.writer.close();
  }
}
