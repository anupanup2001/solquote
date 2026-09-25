/**
 * Jupiter Swap API V2 quote-only client (plan §3).
 *
 * `GET https://api.jup.ag/swap/v2/order` WITHOUT `taker` returns a quote with
 * no assembled transaction — the documented "price check" mode. No wallet, no
 * RPC, no signing. Auth via the `x-api-key` header.
 */
import type { Direction } from "./ohlc.js";
import type { Logger } from "./config.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112"; // 9 decimals
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // 6 decimals

const SOL_DECIMALS = 9n;

const BASE_URL = "https://api.jup.ag/swap/v2";
const MAX_ATTEMPTS = 5;
const BACKOFFS_MS = [1_000, 2_000, 4_000, 8_000, 60_000] as const;
const REQUEST_TIMEOUT_MS = 5_000;

export interface QuoteTick {
  ts: number;
  direction: Direction;
  /** raw base-unit input amount (string, as returned) */
  inAmount: string;
  /** raw base-unit output amount (string, as returned) */
  outAmount: string;
  /** normalized USDC-per-SOL, fixed 6-decimal TRUNCATED string */
  price: string;
  /** percentage points, e.g. -0.012 */
  priceImpact: string;
  router: string;
  feeBps: string;
  inUsdValue: string;
  outUsdValue: string;
}

interface OrderResponse {
  inAmount?: unknown;
  outAmount?: unknown;
  inUsdValue?: unknown;
  outUsdValue?: unknown;
  priceImpact?: unknown;
  router?: unknown;
  feeBps?: unknown;
}

export class JupiterClient {
  constructor(
    private readonly apiKey: string,
    private readonly log: Logger,
  ) {}

  /**
   * Fetch a quote-only order. `amount` is in base units of the input mint.
   * Retries 429/5xx/network errors with full-jitter backoff (plan §3.4);
   * returns null after MAX_ATTEMPTS (caller skips the tick).
   * Throws FatalApiError on 401/403/404 or malformed success bodies.
   */
  async getQuote(direction: Direction, amount: bigint): Promise<QuoteTick | null> {
    const inputMint = direction === "SOL_TO_USDC" ? SOL_MINT : USDC_MINT;
    const outputMint = direction === "SOL_TO_USDC" ? USDC_MINT : SOL_MINT;
    const url = `${BASE_URL}/order?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}`;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const res = await fetch(url, {
          headers: { "x-api-key": this.apiKey },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        this.logRateLimit(res);
        if (res.ok) {
          const body = (await res.json()) as OrderResponse;
          return this.toTick(direction, body);
        }
        if (res.status === 401 || res.status === 403) {
          throw new FatalApiError(
            res.status,
            `auth rejected (${res.status}) — check JUP_API key validity/permissions: ${await safeText(res)}`,
          );
        }
        if (res.status === 404) {
          throw new FatalApiError(
            res.status,
            `endpoint not found (404) — API shape changed: ${await safeText(res)}`,
          );
        }
        if (res.status === 429 || res.status >= 500) {
          if (attempt === MAX_ATTEMPTS) {
            this.log.warn("quote retry attempts exhausted; skipping tick", {
              status: res.status,
              direction,
            });
            return null;
          }
          await sleep(jittered(BACKOFFS_MS[attempt - 1] ?? 60_000));
          continue;
        }
        // Other 4xx: non-retryable, non-fatal — log and skip the tick.
        this.log.warn("quote request failed", {
          status: res.status,
          body: await safeText(res),
          direction,
        });
        return null;
      } catch (err) {
        if (err instanceof FatalApiError) throw err;
        if (attempt === MAX_ATTEMPTS) {
          this.log.warn("network error retries exhausted; skipping tick", {
            direction,
            error: String(err),
          });
          return null;
        }
        await sleep(jittered(BACKOFFS_MS[attempt - 1] ?? 60_000));
      }
    }
    return null; // unreachable
  }

  private logRateLimit(res: Response): void {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining !== null) {
      const n = Number(remaining);
      if (Number.isFinite(n) && n <= 10) {
        this.log.warn("jupiter rate-limit headroom low", {
          remaining,
          reset: res.headers.get("x-ratelimit-reset"),
        });
      }
    }
  }

  /** Map an /order response to a tick; validates expected fields (plan §10 shape guard). */
  private toTick(direction: Direction, body: OrderResponse): QuoteTick {
    if (
      typeof body.inAmount !== "string" ||
      typeof body.outAmount !== "string" ||
      body.inAmount === "" ||
      body.outAmount === ""
    ) {
      throw new FatalApiError(
        200,
        `unexpected /order response shape: ${JSON.stringify(body).slice(0, 500)}`,
      );
    }
    const inAmount = body.inAmount;
    const outAmount = body.outAmount;
    // Sell side (SOL_TO_USDC): price = out(USDC 6dp)/in(lamports) × 10^(9−6).
    // Buy side (USDC_TO_SOL): price = in(USDC 6dp)/out(lamports) × 10^(9−6) —
    // in/out of the response, because the response's input is USDC and output
    // is SOL. Both are the executable USDC-per-SOL price for that direction.
    const price =
      direction === "SOL_TO_USDC"
        ? priceUsdPerSol(outAmount, inAmount)
        : priceUsdPerSol(inAmount, outAmount);
    return {
      ts: Date.now(),
      direction,
      inAmount,
      outAmount,
      price,
      priceImpact: body.priceImpact !== undefined ? String(body.priceImpact) : "",
      router: typeof body.router === "string" ? body.router : "",
      feeBps: body.feeBps !== undefined ? String(body.feeBps) : "",
      inUsdValue: body.inUsdValue !== undefined ? String(body.inUsdValue) : "",
      outUsdValue: body.outUsdValue !== undefined ? String(body.outUsdValue) : "",
    };
  }

  /** Startup smoke test: one real quote; fail fast on any error (plan §3.5). */
  async smokeTest(): Promise<QuoteTick> {
    const tick = await this.getQuote("SOL_TO_USDC", 100_000_000n);
    if (!tick) {
      throw new FatalApiError(0, "startup smoke test failed: no quote returned");
    }
    return tick;
  }
}

export class FatalApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "FatalApiError";
  }
}

/**
 * Normalize a USDC-per-SOL price from raw base-unit BigInt strings:
 * `numerator/denominator × 10^(9−6)`, rendered as a fixed 6-decimal
 * TRUNCATED string (never rounded — deterministic for tests, plan §5).
 */
export function priceUsdPerSol(numeratorBaseUnits: string, denominatorBaseUnits: string): string {
  const num = BigInt(numeratorBaseUnits);
  const den = BigInt(denominatorBaseUnits);
  if (den === 0n) throw new Error(`zero denominator in price math: ${denominatorBaseUnits}`);
  // ×10^(9−6)=1000 for lamports→USDC scale, then ×1e6 for 6 fractional digits.
  const scaled = (num * 1_000n * 10n ** 6n) / den;
  return formatFixed6Truncated(scaled);
}

/** Render a scaled-by-1e6 BigInt as a decimal string with 6 fraction digits (truncated). */
export function formatFixed6Truncated(scaled6: bigint): string {
  const negative = scaled6 < 0n;
  const abs = negative ? -scaled6 : scaled6;
  const whole = abs / 10n ** 6n;
  const frac = abs % 10n ** 6n;
  return `${negative ? "-" : ""}${whole}.${frac.toString().padStart(6, "0")}`;
}

const MIN_SELL_USDC = 5n * 10n ** 6n;
const MAX_SELL_USDC = 1000n * 10n ** 6n;

/** Clamp USDC base units to [5, 1000] USDC (plan §3.3). */
export function clampSellUsdcAmount(usdcBaseUnits: bigint): bigint {
  if (usdcBaseUnits < MIN_SELL_USDC) return MIN_SELL_USDC;
  if (usdcBaseUnits > MAX_SELL_USDC) return MAX_SELL_USDC;
  return usdcBaseUnits;
}

/**
 * USDC base units (6dp) for the given SOL lamports notional at `price6`
 * (USDC-per-SOL scaled by 1e6), rounded then clamped to [5, 1000] USDC.
 */
export function sellUsdcAmount(price6: bigint, quoteSolLamports: bigint): bigint {
  const usdc = (quoteSolLamports * price6) / 10n ** SOL_DECIMALS;
  return clampSellUsdcAmount(usdc);
}

/** Parse a fixed-6 decimal string into a scaled BigInt (for sell sizing). */
export function parseFixed6(price: string): bigint {
  const negative = price.startsWith("-");
  const [whole, frac = ""] = price.slice(negative ? 1 : 0).split(".");
  const fracPadded = frac.padEnd(6, "0").slice(0, 6);
  const value = BigInt(whole + fracPadded);
  return negative ? -value : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Full jitter: uniform [0, ms) — plan §3.4 "exponential backoff with full jitter". */
function jittered(ms: number): number {
  return Math.floor(Math.random() * ms);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<unreadable body>";
  }
}
