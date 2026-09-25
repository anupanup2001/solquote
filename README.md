# solquote — Jupiter SOL/USDC OHLC recorder

Headless TypeScript service that polls the [Jupiter Swap API V2](https://developers.jup.ag/docs/swap) every 5 seconds for SOL↔USDC quotes (quote-only mode, no wallet/transaction), aggregates 1-minute and daily OHLC bars (UTC), and writes CSVs for later backtesting of swap algorithms.

See `plan.md` for the full architecture and ratified decisions.

## Run (Docker)

```bash
cp .env.example .env    # then set JUP_API
mkdir -p data           # MUST exist before first compose up (bind-mount ownership)
docker compose up --build -d
curl localhost:8080/health
```

CSVs land in `./data/` (mounted at `/app/data` in the container).

## Run (local)

```bash
npm install
npm run dev
```

## Environment

| Var | Default | Meaning |
|-----|---------|---------|
| `JUP_API` | (required) | Jupiter API key, sent as `x-api-key` |
| `CSV_DIR` | `/app/data` (docker), `./data` (dev) | CSV output dir |
| `POLL_INTERVAL_MS` | `5000` | Base poll interval (±250 ms jitter) |
| `QUOTE_SOL_LAMPORTS` | `100000000` | SOL→USDC quote size (0.1 SOL) |
| `PORT` | `8080` | Health endpoint port |
| `LOG_LEVEL` | `info` | `debug\|info\|warn\|error` |

## CSV schemas (flat in `CSV_DIR`, UTC everywhere)

**`ohlc-1m-YYYY-MM-DD.csv`** — 1-minute bars, rotates at UTC midnight:
```
ts,buy_open,buy_high,buy_low,buy_close,buy_ticks,sell_open,sell_high,sell_low,sell_close,sell_ticks
2026-09-23T14:07:00Z,148.190112,148.210001,148.180002,148.190112,12,148.123456,148.201001,148.099002,148.177443,12
```

**`ohlc-1d.csv`** — one row per UTC day, appended (same columns as the 1-min file):
```
date,buy_open,buy_high,buy_low,buy_close,buy_ticks,sell_open,sell_high,sell_low,sell_close,sell_ticks
2026-09-23,147.960100,149.012345,147.811002,148.687443,276,147.950100,149.002345,147.801002,148.677443,276
```

**`ticks-YYYY-MM-DD.csv`** — raw quote provenance (both directions):
```
ts,direction,inAmount,outAmount,price,priceImpact,router,feeBps,inUsdValue,outUsdValue
```

Notes:
- Each bar carries **two complete per-side candles**: `buy_*` tracks the **USDC_TO_SOL** series (the executable price when buying SOL) and `sell_*` tracks the **SOL_TO_USDC** series (the executable price when selling SOL). Both are normalized USDC-per-SOL. Use `buy_*` for buy decisions, `sell_*` for sell decisions, and both together for spread / round-trip math.
- A side with zero ticks in a bucket carries empty OHLC strings and `*_ticks = 0` (the zero tick count is the validity flag). A bar is emitted when at least one side has ticks. Buy/sell closes come from each side's own last tick — they are **not** time-paired; for cross-side comparisons at coarse granularities, pair via tick timestamps (reconstructable exactly from the tick CSV).
- Minutes/days with zero successful ticks produce **no row** (honest gaps).
- Prices are fixed 6-decimal strings, truncated (never rounded).
- Quote prices are already net of route fees and price impact (`feeBps`/`priceImpact` recorded per tick); backtests should add only an explicit execution buffer, not a blanket fees+slippage term.
- Quote notional differs per side (0.1 SOL for SOL_TO_USDC; ~0.1 SOL USD-equivalent for USDC_TO_SOL, clamped [5, 1000] USDC) and price impact is size-dependent.
- **Restarts**: in-progress-bar resume is intentionally unsupported — a crash mid-minute forfeits that partial minute's OHLC row (raw tick CSV keeps provenance); restarts never duplicate already-persisted rows (monotonic high-water mark).
- **Schema guard**: the writer refuses (throws `CsvHeaderMismatchError`) to append to an existing file whose header doesn't match the expected one. Old-schema bar files are archived under `data/archive-v1/` (regenerable from `ticks-*.csv`).

## Health

`GET :8080/health` → `200 {status,lastTickAt,lastErrorAt}` while the poller is fresh (last tick within 2× poll interval), else `503`.

## Development

```bash
npm run typecheck   # tsc --noEmit (strict)
npm test            # vitest (aggregator, price math, CSV writer)
```
