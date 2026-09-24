/**
 * Append-only CSV writer with daily rotation, header management, and
 * restart-resume helpers (plan §5).
 *
 * Guarantees:
 * - complete lines only (header + row written as one atomic `append`)
 * - monotonic guard: refuses rows whose key <= the last written key
 * - flush per row via explicit `drain()` (callers flush bars promptly)
 */
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { finished } from "node:stream/promises";
import type { WriteStream } from "node:fs";

export interface CsvWriterOptions {
  /** File name builder, e.g. (date) => `ohlc-1m-${date}.csv`. */
  fileNameFor: (date: string) => string;
  /** Header line, written once per new file. */
  header: string;
  /** Row key extractor used for the monotonic guard (e.g. `ts` or `date` column value). */
  keyOf: (fields: string[]) => string;
}

export class CsvWriter {
  private stream: WriteStream | null = null;
  private currentDate: string | null = null;
  private lastKey: string | null = null;

  constructor(
    private readonly dir: string,
    private readonly opts: CsvWriterOptions,
  ) {
    mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Append a row to the file for the given UTC date, rotating if needed.
   * Rows must be pre-formatted CSV field arrays (no embedded commas).
   * Returns false if the row was refused by the monotonic guard.
   */
  append(date: string, key: string, fields: string[]): boolean {
    if (this.lastKey !== null && key <= this.lastKey) {
      return false; // monotonic guard: out-of-order or duplicate row
    }
    if (this.currentDate !== date) {
      this.rotate(date);
    }
    const line = fields.join(",") + "\n";
    this.stream?.write(line);
    this.lastKey = key;
    return true;
  }

  /** Wait until all queued data is flushed to the OS. */
  async drain(): Promise<void> {
    if (!this.stream) return;
    await new Promise<void>((resolve, reject) => {
      this.stream!.write("", (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Close the current file. */
  async close(): Promise<void> {
    if (!this.stream) return;
    const s = this.stream;
    this.stream = null;
    await new Promise<void>((resolve) => {
      s.end(() => resolve());
    });
    await finished(s).catch(() => {});
  }

  private rotate(date: string): void {
    // Synchronous close: rotate must complete before the next append.
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
    const path = `${this.dir}/${this.opts.fileNameFor(date)}`;
    const isNew = !existsSync(path) || statSync(path).size === 0;
    this.stream = createWriteStream(path, { flags: "a" });
    if (isNew) {
      this.stream.write(this.opts.header + "\n");
    }
    this.currentDate = date;
    if (this.lastKey === null) {
      // Fresh process: seed the guard from the file so restarts don't
      // accept rows at or before the last persisted row.
      const last = readLastRow(path);
      if (last) this.lastKey = this.opts.keyOf(last);
    }
  }

  /** Seed the monotonic guard from an existing file's last row (recovery). */
  seedLastKeyFromFile(date: string): void {
    const path = `${this.dir}/${this.opts.fileNameFor(date)}`;
    if (!existsSync(path)) return;
    const last = readLastRow(path);
    if (last) {
      this.lastKey = this.opts.keyOf(last);
    }
  }

  get lastWrittenKey(): string | null {
    return this.lastKey;
  }
}

/**
 * Read the last complete CSV row of a file (cheap: last ~4 KB).
 * A trailing partial line (no final newline — crash mid-write) is discarded.
 * Returns the split fields, or null if the file has no complete row.
 */
export function readLastRow(path: string): string[] | null {
  if (!existsSync(path)) return null;
  const st = statSync(path);
  if (!st.isFile() || st.size === 0) return null;
  const size = st.size;
  if (size === 0) return null;
  const fd = openSync(path, "r");
  try {
    const readLen = Math.min(size, 4096);
    const buf = Buffer.alloc(readLen);
    readSync(fd, buf, 0, readLen, size - readLen);
    let text = buf.toString("utf8");
    if (!text.endsWith("\n")) {
      // Trailing partial line: discard it.
      const lastNl = text.lastIndexOf("\n");
      if (lastNl === -1) return null; // only the partial line exists in the window
      text = text.slice(0, lastNl);
    }
    const lines = text.split("\n").filter((l) => l.length > 0);
    const lastLine = lines[lines.length - 1];
    if (!lastLine) return null;
    return lastLine.split(",");
  } finally {
    closeSync(fd);
  }
}
