# solquote — Implementation Plan

Headless TypeScript service that polls the Jupiter Swap API V2 every 5 seconds for SOL↔USDC quotes, aggregates 1-minute and daily OHLC bars, and writes CSV files for later backtesting of swap algorithms. Runs in Docker with the CSV directory bind-mounted.

## 1. Overview

### Goals
- Poll Jupiter Swap API V2 (`GET /swap/v2/order`, quote-only mode) every 5 s in **both directions**: SOL→USDC (buy price) and USDC→SOL (sell price).
- Aggregate ticks into **1-minute OHLC bars** (file rotates daily at UTC midnight) and **daily OHLC bars** (single appended file), UTC everywhere.
- Write provenance-rich **raw tick CSV** (one row per successful quote, both directions).
- Flush per bar, handle gaps honestly (no synthetic rows), resume cleanly across restarts.
- Ship as a Docker image; CSVs land in a mounted volume; tiny HTTP health endpoint.

### Non-goals
- No swap execution, no wallet, no transaction signing (quote-only, `taker` omitted).
- No Price API v3 usage, no external price backfill (CoinGecko/Pyth) in v1.
- No charting/UI, no database, no linter, no heavy test suite.
- No multi-pair support (SOL/USDC only, mints hardcoded as constants but env-overridable is NOT in scope — keep constants).

### Locked decisions (agreed with owner; do not re-open)
| # | Decision |
|---|----------|
| 1 | Poll both directions (2 requests per 5 s tick = 0.4 RPS; Free tier limit is 1 RPS — fits) |
| 2 | Quote size 0.1 SOL; USDC→SOL side uses USD-equivalent sizing (see §3.3) |
| 3 | ISO-8601 UTC timestamps in CSVs |
| 4 | Flat layout: all CSVs in one mounted dir (`CSV_DIR=/app/data`) |
| 5 | Minute with zero successful ticks → **no row** (honest gap), warn log |
| 6 | Floor tick ts to UTC minute; open=first tick, close=last, high/low=max/min; daily rows keyed by UTC date |
| 7 | Swap quotes only |
| 8 | HTTP health endpoint on port 8080 for Docker HEALTHCHECK |
| 9 | Minimal vitest tests (aggregator + CSV writer only), bare `tsc --strict`, no linter |

## 2. Architecture

```
                       ┌─────────────────────────────────────────────┐
                       │                 process                      │
 ┌──────────────┐      │  ┌─────────┐   ┌────────────┐   ┌────────┐  │
 │ Jupiter API  │◄─────┼──┤ poller  │──►│  aggregator │──►│ writers │  │
 │ /swap/v2/    │      │  └────┬────┘   └────────────┘   └───┬────┘  │
 │ order        │      │       │ (raw ticks)                 │       │
 └──────────────┘      │       ▼                             ▼       │
                       │  ┌──────────┐              ┌──────────────┐  │
                       │  │ health   │              │  CSV files   │  │
                       │  │ :8080    │              │ /app/data    │  │
                       │  └──────────┘              └──────────────┘  │
                       └─────────────────────────────────────────────┘
```

Data flow per tick (every `POLL_INTERVAL_MS` ± jitter):
1. `poller` fires two quote requests (SOL→USDC, USDC→SOL) sequentially-ish (not stacked; see §3.4).
2. Each successful response is converted to a **tick**: `{ ts, direction, inAmount, outAmount, price, priceImpact, router, feeBps }`.
3. Tick goes to `aggregator` (current 1-min bar + current daily bar) **and** to `tickWriter` (raw CSV).
4. On minute rollover, completed bar is emitted to `ohlc1mWriter`; on UTC-day rollover, completed daily bar goes to `ohlc1dWriter` and the 1-min writer rotates its file.
5. `health` server reports `{ status, lastTickAt, lastErrorAt }` on `:8080/health`; returns **503** when `lastTickAt` is older than 2× `POLL_INTERVAL_MS` (a 200 while the poller is dead would hide silent data loss from the Docker HEALTHCHECK), 200 otherwise.

Modules (one file each, flat `src/`):
- `config.ts` — env parsing + validation (zod).
- `jupiter.ts` — quote client: URL building, auth header, fetch with timeout, backoff/retry, response → tick mapping + price math.
- `ohlc.ts` — pure aggregator: `push(tick) → Bar | null` (returns completed bar on rollover). Pure = trivially testable.
- `csvWriter.ts` — append-only CSV writer with rotation support: `ensureFile`, `appendRow`, `rotate(date)`, flush semantics.
- `tickLogger.ts` — thin wrapper over csvWriter for the raw tick file.
- `health.ts` — node `http` server, `GET /health` → JSON.
- `main.ts` — wiring, poll loop, signal handling, startup smoke test, restart recovery.

## 3. Jupiter API integration

### 3.1 Endpoint
```
GET https://api.jup.ag/swap/v2/order
    ?inputMint=<in-mint>&outputMint=<out-mint>&amount=<integer base units>
Headers: x-api-key: $JUP_API
```
**Omit `taker`** → quote-only response (no transaction). This is the documented price-check mode; no wallet/RPC needed.

Constants:
- SOL mint: `So11111111111111111111111111111111111111112` (9 decimals)
- USDC mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (6 decimals)

Do **not** set `slippageBps` — Jupiter auto-determines; response echoes the used `slippageBps`. Fewer params = mode `"ultra"` = all routers compete.

### 3.2 Price derivation (BigInt-safe)
`inAmount`/`outAmount` are strings in base units. Parse with `BigInt`, never `Number`:
```
buyPrice  (SOL→USDC) = outAmount / inAmount × 10^(9−6) = outAmount / inAmount × 1000   // USDC per SOL
sellPrice (USDC→SOL) = inAmount / outAmount × 10^(9−6) = inAmount / outAmount × 1000    // USDC per SOL
```
Compute as `(a * 10n**18n) / b` scaled then format to a decimal string with 6 fractional digits (price precision of 1e-6 USDC per SOL is ample). Emit as plain decimal string in CSV to avoid float artifacts.

Also carried per tick: `priceImpact` (percentage points, e.g. `-0.1` = −0.1%), `router`, `feeBps` — provenance only, not used in OHLC math.

### 3.3 USDC→SOL quote sizing (decision 2)
To keep both sides near 0.1 SOL notional:
- Maintain `lastPrice` = most recent buyPrice (boot default: **150.0** USDC/SOL).
- `usdcAmount = round(0.1 SOL × lastPrice × 10^6)` base units, clamped to [5, 1000] USDC. The 5 USDC floor preserves USD-equivalence at current SOL prices (0.1 SOL ≈ $15 at SOL=$150); the clamp only binds at extremes (> $10,000 SOL). Sell notional therefore tracks ~0.1 SOL worth, per the locked decision.
- Refresh `lastPrice` from every successful SOL→USDC quote (ignore sellPrice for sizing to avoid feedback loops).
- This is one line of state, deterministic, and avoids `Quote size drift` compounding (see §10).

### 3.4 Rate-limit / retry policy (Free tier = 1 RPS, 60 s sliding window, per org)
- Two requests per tick at 5 s spacing = 0.4 RPS average; **stagger** the two calls by 2.5 s within the tick (buy at t+0, sell at t+2.5s) so the sliding window sees ≤1 req per 2.5 s.
- Per request: `AbortController` timeout of 5 s.
- On 429/5xx/network error: exponential backoff with full jitter — 1s, 2s, 4s, 8s (cap 60s), max 5 attempts; then **skip the tick** (do not block the next tick) and log a warn.
- Read `x-ratelimit-remaining` / `x-ratelimit-reset` on every response; log a warn when remaining ≤ 10 (headroom guard: the 1 RPS limit is per **org** — if other services share this key, remaining will visibly shrink).
- 401/403 at startup → fail fast with a clear message (bad/permission-limited key). 404 → fail fast (wrong endpoint).
- Never stack polls: single `setTimeout` loop; if a tick's work is still in flight when the next fires, skip it.
- Jitter: schedule each tick at `interval + uniform(-250ms, +250ms)`.

### 3.5 Startup smoke test
Before the loop starts: one real SOL→USDC quote. Log the derived price. Any non-200 → `process.exit(1)` with the status/body. Guarantees bad keys fail fast in Docker.

## 4. OHLC aggregation rules

- **Bucket key**: `floorTsToMinute(tsUTC)` → `YYYY-MM-DDTHH:MM:00Z`; daily key = `YYYY-MM-DD`.
- Each successful tick updates the current bar: `high = max`, `low = min`, `close = price`, `ticks += 1`; first tick sets `open`.
- **Series**: the OHLC core (`open/high/low/close`) tracks the **buyPrice series (SOL→USDC)**. The sellPrice series is recorded as a single `sell_close` column = close of the sell-side ticks within the same bucket (empty string if the sell direction had no tick that bucket). Rationale: backtesting a swap algorithm needs both an executable buy and sell estimate, but two full OHLC columns quadruple columns for little value — sell-side intra-minute volatility on this pair is within noise of buy-side; the raw tick file preserves full fidelity if it's ever needed.
- **Rollover (timer-driven, primary)**: a 1-second wall-clock timer (`setInterval`, 1 s) checks whether the current minute bucket has changed; when it has (or when the UTC date rolls over), it emits the current bar(s) to the writer. Tick-driven rollover remains as a fallback (if a tick with a newer bucket arrives first, the bar is emitted then). Rationale: emission must not depend on the *next* tick arriving — if the API goes down at 14:07:30, the 14:07 bar (already holding real ticks) is still flushed within ≤1 s instead of being lost forever. Same timer closes the daily bar at 00:00:00Z.
- **Gaps**: buckets with zero successful ticks produce **no CSV row** (locked decision 5). A warn is logged with the number of skipped minutes. Same semantics for the daily file (a fully-down day produces no row).
- **Rotation**: 1-min writer rotates when the bar's UTC date changes → close current file, open `ohlc-1m-<newDate>.csv`, write header if file is new.
- **Restart recovery** (in-progress bars):
  1. On boot, find today's `ohlc-1m-<today>.csv` in `CSV_DIR`. If present, read the **last row** (cheap: read last ~4 KB, split lines).
     - If the last row's `ts` == current minute bucket → resume that bar: `open/high/low` from the row, `close = open`, `ticks = 0` (ticks count restarts; acceptable and documented) — subsequent ticks in this minute extend it correctly.
     - Else → no in-progress bar; next tick starts fresh.
  2. For the daily bar: read the last row of `ohlc-1d.csv`. If its `date` == today → resume today's daily bar the same way. If the last row's date is older and **today's date > last row date**: no daily row was written for missing days — that is correct gap behavior (do not backfill).
  3. Tick file is append-only; no recovery needed.
  - Note: this only resumes the *current* minute/day. Because bars are now emitted on the 1-second timer (not the next tick), a bar for a completed minute is on disk within ~1 s of that minute ending — the only loss window is a crash inside that 1 s (≤1 partial bar, matching gap semantics). If the process was down across a boundary, the previous boundary bar was already flushed before the crash in the normal path; if it crashed mid-write, the CSV may end with a partial line — the writer mitigates by writing complete lines only (see §5) and recovery skips a trailing partial line (no trailing `\n` → discard).
- **Resume of `sell_close`**: when resuming a 1-min bar, also restore `sell_close` from the resumed row's `sell_close` column; subsequent sell ticks overwrite it as normal.
- **Monotonic guard**: ticks whose bucket ≤ the last *emitted* bar's bucket are discarded with a warn log (protects against NTP clock steps backward). Writers additionally refuse to append a `ts`/`date` ≤ the last row's — the last-row value is tracked in memory after recovery.

## 5. CSV formats & files

All in `CSV_DIR` (flat, locked decision 4). UTF-8, LF newlines, header always written when a file is created.

**`ohlc-1m-YYYY-MM-DD.csv`** (rotates at UTC midnight)
```
ts,open,high,low,close,sell_close,ticks
2026-09-23T14:07:00Z,148.123456,148.201001,148.099002,148.177443,148.189112,12
```
- `ts` = minute bucket start, ISO-8601 UTC. `open/high/low/close` = buyPrice series. `sell_close` = last sellPrice in bucket (empty if none). `ticks` = successful buy-direction ticks in bucket.

**`ohlc-1d.csv`** (single file, appended forever)
```
date,open,high,low,close,sell_close,ticks
2026-09-23,147.950100,149.002345,147.801002,148.677443,148.701002,276
```

**`ticks-YYYY-MM-DD.csv`** (raw provenance, rotates daily)
```
ts,direction,inAmount,outAmount,price,priceImpact,router,feeBps,inUsdValue,outUsdValue
2026-09-23T14:07:03.512Z,sell,151000000,1012945620,148.174815,-0.012,metis,0,15.12,15.09
```
- `direction` ∈ {`SOL_TO_USDC`,`USDC_TO_SOL`}; `price` normalized USDC-per-SOL decimal string; `ts` full ISO with milliseconds; `inUsdValue`/`outUsdValue` captured from the API response as a free cross-check of the price math.

Numeric formatting: prices as fixed 6-decimal decimal strings (truncate, never round, so tests are deterministic); `ticks` integer; `priceImpact` as returned (number→string). No quoting needed (no commas in fields).

## 6. Project layout, dependencies, config

```
solquote/
├── .env                    # existing: JUP_API
├── data/.gitkeep           # ensures ./data exists (and is host-owned) before first compose up
├── .env.example
├── .gitignore              # node_modules, dist, data/
├── package.json            # "type": "module"
├── tsconfig.json           # strict, NodeNext, outDir dist
├── plan.md
├── Dockerfile
├── docker-compose.yml
├── data/                   # default local CSV dir (gitignored)
└── src/
    ├── config.ts
    ├── jupiter.ts
    ├── ohlc.ts
    ├── csvWriter.ts
    ├── tickLogger.ts
    ├── health.ts
    └── main.ts
└── test/
    ├── ohlc.test.ts
    └── csvWriter.test.ts
```

**Dependencies (runtime):** `dotenv`, `zod` (env validation). **Dev:** `typescript`, `tsx` (dev runner), `vitest`, `@types/node`.
That's it — `fetch` is global in Node 20+, CSV written with `fs` streams, HTTP health via `node:http`. No SDK (`@jup-ag/*` not needed for quote-only).

**Env config table:**
| Var | Default | Meaning |
|-----|---------|---------|
| `JUP_API` | (required) | Jupiter API key, sent as `x-api-key` |
| `CSV_DIR` | `/app/data` (local dev: `./data`) | Mounted CSV output dir |
| `POLL_INTERVAL_MS` | `5000` | Base poll interval |
| `QUOTE_SOL_LAMPORTS` | `100000000` | Quote size for SOL→USDC (0.1 SOL) |
| `PORT` | `8080` | Health endpoint port |
| `LOG_LEVEL` | `info` | `debug\|info\|warn\|error` |

**Logging:** plain structured `console.log(JSON.stringify(...))` helper (`logger.ts` folded into `config.ts` consumer — one small util inside `main.ts` scope) with levels. Chosen over pino because volume is tiny (1 warn/bar max) and zero-dep keeps the image minimal.

## 7. Docker

**Dockerfile (multi-stage):**
```dockerfile
FROM node:20-alpine AS deps      # copy package*.json, npm ci
FROM deps AS build               # copy src/tsconfig, npm run build (tsc)
FROM node:20-alpine              # copy dist + node_modules + package.json
USER node                        # non-root
ENV CSV_DIR=/app/data PORT=8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["node", "dist/main.js"]
```
(`wget` exists in alpine images; avoids curl install.)

**docker-compose.yml:**
```yaml
services:
  solquote:
    build: .
    restart: unless-stopped
    env_file: .env
    environment:
      - CSV_DIR=/app/data
    volumes:
      - ./data:/app/data
    ports:
      - "8080:8080"
    stop_grace_period: 15s
```

**First-run bind-mount note**: `./data` must exist on the host **before** the first `docker compose up` — Docker creates a missing bind-mount source as **root-owned**, which EACCES-crashes the non-root (UID 1000) container. `data/.gitkeep` is committed for exactly this; the README runbook also says `mkdir -p data` before first run. Host dir is already UID 1000-owned on this machine (verified).

**Graceful shutdown sequence** (`SIGTERM`/`SIGINT`):
1. Stop the poll loop (no new ticks).
2. Finalize in-progress bars? **No** — a partial bar is *not* emitted (it never closed); only already-completed bars are on disk. This matches gap semantics: a killed minute = partial data = still extended on resume (§4). Note: with the 1-second emission timer (§4), any bar for a fully-elapsed minute was flushed ≤1 s after it closed — the shutdown loss window is only the in-progress second, not the whole partial bar.
3. `await` writer flush/close (`stream.end()` + `finished`).
4. Close health server. `process.exit(0)`.
Jittered poll loop and in-flight fetch are aborted via the same shutdown flag + `AbortController`.

## 8. Test plan (vitest, minimal)

**`test/ohlc.test.ts`** (pure module, no I/O):
1. First tick opens a bar; subsequent ticks update high/low/close/ticks.
2. Tick in next minute → emits completed bar and opens new one.
3. Gap minute (no ticks spanning 2 minutes) → no bar emitted for the gap, next bar opens from the late tick.
4. `sell_close` recorded from sell-direction ticks; empty when none.
5. UTC floor correctness across a day boundary (23:59→00:00Z) → daily bar emitted.

**`test/csvWriter.test.ts`** (tmp dir):
1. Creates file with header on first append; appends without duplicating header.
2. Rotation: appendRow for a new date closes old file, creates new with header.
3. Restart-resume helper: reads last full row; trailing partial line (no `\n`) is discarded.

Run: `npm test`. Everything else validated by the startup smoke test + `docker compose up` manual check.

## 9. Implementation order

1. [ ] Scaffold: `package.json` (type module, scripts: dev/build/test), `tsconfig.json`, `.env.example`, `.gitignore`.
2. [ ] `src/config.ts` — env parse/validation (zod), fail-fast errors.
3. [ ] `src/ohlc.ts` — pure aggregator + `floorTsToMinute`/UTC date helpers (+ tests).
4. [ ] `src/csvWriter.ts` — append/rotate/resume (+ tests).
5. [ ] `src/jupiter.ts` — quote client, price math, backoff, smoke-test function.
6. [ ] `src/tickLogger.ts`, `src/health.ts`.
7. [ ] `src/main.ts` — wiring: recovery (§4), poll loop (staggered, jittered, non-stacking), rollover → writers, signals.
8. [ ] `Dockerfile` + `docker-compose.yml`; `docker compose up --build` end-to-end check; verify CSVs appear in `./data`, health 200, SIGTERM flushes cleanly.
9. [ ] Final review: run vitest, `tsc --noEmit`, smoke test against live API with real key.

## 10. Risks & open items

- **Quote-size drift (USDC→SOL)**: sizing derives from `lastPrice`; a stale price after long API outages could skew the sell quote size. Mitigation: clamp (§3.3) + size is cosmetic for price math (price = in/out ratio; exact `amount` barely moves the marginal price on this deep pair).
- **Free-tier 1 RPS ceiling**: our average is 0.4 RPS but retries after failures could burst; backoff cap + skip-tick policy keeps us under. If limits tighten, paid Developer tier ($25/mo, 10 RPS) is the fallback — same code, header already sent.
- **Long-run file growth**: `ohlc-1d.csv` grows ~365 rows/yr — fine. `ticks-*.csv` ~34.5k rows/day ≈ 3–4 MB/day; acceptable, but add "open item": optional tick-log retention/compression later.
- **Clock skew**: timestamps are host UTC; if host clock skews, buckets skew. Docker containers inherit host clock; acceptable. Use `Date.now()`, not response headers.
- **Partial-line CSV after crash**: writer writes full lines; recovery discards trailing partial line (§4). Acceptable one-row loss.
- **API shape drift**: V2 response fields (`priceImpact`, `router`) are new; pin behavior with a response-type guard at startup smoke test (fail fast if expected fields missing).
- **Open item (owner, later)**: historical backfill before launch date is out of scope; CSV history starts at first deployment.