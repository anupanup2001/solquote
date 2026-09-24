import { describe, it, expect } from "vitest";
import {
  priceUsdPerSol,
  formatFixed6Truncated,
  clampSellUsdcAmount,
  sellUsdcAmount,
  parseFixed6,
} from "../src/jupiter.js";

describe("priceUsdPerSol", () => {
  it("derives buy price: out(USDC 6dp)/in(lamports) × 10^(9−6)", () => {
    // 0.1 SOL (100000000 lamports) -> 14,812,345 USDC base units = 14.812345 USDC
    // price = 14.812345 / 0.1 = 148.123450 USDC/SOL
    expect(priceUsdPerSol("14812345", "100000000")).toBe("148.123450");
  });

  it("derives sell price: in(USDC 6dp)/out(lamports) × 10^(9−6)", () => {
    // 1,481,234 USDC base units (1.481234 USDC) for 9,999,999 lamports
    // price = 1.481234 / 0.009999999 ≈ 148.123414 USDC/SOL
    expect(priceUsdPerSol("1481234", "9999999")).toBe("148.123414");
  });

  it("truncates (never rounds) at the 6th decimal", () => {
    // 1 USDC base unit per 1 lamport -> 1000 USDC/SOL exactly
    expect(priceUsdPerSol("1", "1")).toBe("1000.000000");
    // 1e-6 USDC per 0.01 SOL = 0.0001 USDC/SOL; one more lamport truncates down
    expect(priceUsdPerSol("1", "10000000")).toBe("0.000100");
    expect(priceUsdPerSol("1", "10000001")).toBe("0.000099");
  });
});

describe("formatFixed6Truncated", () => {
  it("renders scaled BigInt with 6 fraction digits", () => {
    expect(formatFixed6Truncated(148123450n)).toBe("148.123450");
    expect(formatFixed6Truncated(0n)).toBe("0.000000");
    expect(formatFixed6Truncated(1n)).toBe("0.000001");
    expect(formatFixed6Truncated(-1500000n)).toBe("-1.500000");
  });
});

describe("sell sizing (plan §3.3)", () => {
  it("computes USDC for 0.1 SOL at lastPrice", () => {
    // 0.1 SOL at 150 USDC/SOL -> 15 USDC = 15000000 base units
    expect(sellUsdcAmount(150_000_000n, 100_000_000n)).toBe(15_000_000n);
  });

  it("clamps to [5, 1000] USDC", () => {
    expect(clampSellUsdcAmount(1_000_000n)).toBe(5_000_000n); // < 5 USDC -> 5
    expect(clampSellUsdcAmount(5_000_000_000_000n)).toBe(1_000_000_000n); // > 1000 -> 1000
    expect(clampSellUsdcAmount(500_000_000n)).toBe(500_000_000n); // 500 USDC, in range
  });
});

describe("parseFixed6", () => {
  it("round-trips price strings into scaled BigInts", () => {
    expect(parseFixed6("148.123456")).toBe(148_123_456n);
    expect(parseFixed6("150")).toBe(150_000_000n);
    expect(parseFixed6("150")).toBe(150_000_000n);
    expect(parseFixed6("0.5")).toBe(500_000n);
    expect(parseFixed6("-1.234567")).toBe(-1_234_567n);
  });
});
