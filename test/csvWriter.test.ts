import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CsvWriter, readLastRow } from "../src/csvWriter.js";

describe("CsvWriter", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "solquote-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writerFor(filePattern: (date: string) => string) {
    return new CsvWriter(dir, {
      fileNameFor: filePattern,
      header: "ts,value",
      keyOf: (fields) => fields[0] ?? "",
    });
  }

  it("creates file with header on first append; appends without duplicating header", async () => {
    const w = writerFor(() => "out.csv");
    expect(w.append("2026-09-23", "a1", ["a1", "10"])).toBe(true);
    await w.drain();
    w.append("2026-09-23", "a2", ["a2", "20"]);
    await w.drain();
    await w.close();
    const text = readFileSync(join(dir, "out.csv"), "utf8");
    expect(text).toBe("ts,value\na1,10\na2,20\n");
  });

  it("refuses rows whose key is <= last written key (monotonic guard)", async () => {
    const w = writerFor(() => "out.csv");
    expect(w.append("2026-09-23", "b", ["b", "1"])).toBe(true);
    expect(w.append("2026-09-23", "b", ["b", "1"])).toBe(false); // duplicate
    expect(w.append("2026-09-23", "a", ["a", "0"])).toBe(false); // older
    await w.drain();
    await w.close();
    const text = readFileSync(join(dir, "out.csv"), "utf8");
    expect(text).toBe("ts,value\nb,1\n");
  });

  it("rotates to a new date file with its own header", async () => {
    const w = writerFor((date) => `ohlc-1m-${date}.csv`);
    w.append("2026-09-23", "t1", ["t1", "1"]);
    w.append("2026-09-24", "t2", ["t2", "2"]); // rotation
    await w.drain();
    await w.close();
    expect(readFileSync(join(dir, "ohlc-1m-2026-09-23.csv"), "utf8")).toBe("ts,value\nt1,1\n");
    expect(readFileSync(join(dir, "ohlc-1m-2026-09-24.csv"), "utf8")).toBe("ts,value\nt2,2\n");
  });

  it("seeds the monotonic guard from an existing file (restart recovery)", async () => {
    // Simulate a pre-existing file from a previous run.
    writeFileSync(join(dir, "pre.csv"), "ts,value\nx1,5\nx2,9\n");
    const w = writerFor(() => "pre.csv");
    w.seedLastKeyFromFile("2026-09-23");
    expect(w.append("2026-09-23", "x2", ["x2", "9"])).toBe(false); // <= seeded key
    expect(w.append("2026-09-23", "x3", ["x3", "11"])).toBe(true);
    await w.drain();
    await w.close();
    expect(readFileSync(join(dir, "pre.csv"), "utf8")).toBe("ts,value\nx1,5\nx2,9\nx3,11\n");
  });
});

describe("readLastRow", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "solquote-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when file is missing or empty", () => {
    expect(readLastRow(join(dir, "nope.csv"))).toBeNull();
    writeFileSync(join(dir, "empty.csv"), "");
    expect(readLastRow(join(dir, "empty.csv"))).toBeNull();
  });

  it("reads the last complete row and discards a trailing partial line", () => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "f.csv");
    writeFileSync(path, "ts,open\n2026-09-23T14:06:00Z,1.0\n2026-09-23T14:07:00Z,2.0\n2026-09-23T14:0");
    expect(readLastRow(path)).toEqual(["2026-09-23T14:07:00Z", "2.0"]);
  });

  it("returns null when the window contains only a partial line", () => {
    const path = join(dir, "partial.csv");
    writeFileSync(path, "2026-09-23T14:0"); // crash before first newline
    expect(readLastRow(path)).toBeNull();
  });

  it("returns null for a directory path that exists but is not a file", () => {
    expect(existsSync(dir)).toBe(true);
    expect(readLastRow(dir)).toBeNull();
  });
});
