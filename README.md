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
ts,open,high,low,close,sell_close,ticks
2026-09-23T14:07:00Z,148.123456,148.201001,148.099002,148.177443,148.189112,12
```

**`ohlc-1d.csv`** — one row per UTC day, appended:
```
date,open,high,low,close,sell_close,ticks
2026-09-23,147.950100,149.002345,147.801002,148.677443,148.701002,276
```

**`ticks-YYYY-MM-DD.csv`** — raw quote provenance (both directions):
```
ts,direction,inAmount,outAmount,price,priceImpact,router,feeBps,inUsdValue,outUsdValue
```

Notes:
- `open/high/low/close` track the **buy** series (SOL→USDC); `sell_close` is the last USDC→SOL price in the bucket (empty if none).
- Minutes/days with zero successful ticks produce **no row** (honest gaps).
- Prices are fixed 6-decimal strings, truncated (never rounded).
- **Restarts**: in-progress-bar resume is intentionally unsupported — a crash mid-minute forfeits that partial minute's OHLC row (raw tick CSV keeps provenance); restarts never duplicate already-persisted rows (monotonic high-water mark).

## Health

`GET :8080/health` → `200 {status,lastTickAt,lastErrorAt}` while the poller is fresh (last tick within 2× poll interval), else `503`.

## Development

```bash
npm run typecheck   # tsc --noEmit (strict)
npm test            # vitest (aggregator, price math, CSV writer)
```
