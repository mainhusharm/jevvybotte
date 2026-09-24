# polymarket-btc5m-jev-trading

A terminal agent for Polymarket **crypto Up or Down** markets (BTC, ETH, SOL,
XRP, DOGE, BNB) across **5m / 15m** windows (1h supported by the registry).

Every tick it scans every enabled window, runs a rules-based analysis, ranks the
opportunities, and trades only the best one: **analyze → JEV → policy → trade**.
It asks [TypeSafe Jev](https://typesafe.ai) whether the asset finishes UP or
DOWN vs the window open, then enters only if the edge survives the gates. It
**abstains** most of the time. Default mode is **dry-run** (no real orders).
Live trading is optional.

---

## Requirements

- Node.js 20+
- A TypeSafe API key (`TYPESAFE_API_KEY`)

For live trading only: a Polygon wallet that already works on [Polymarket](https://polymarket.com) (connected, funded with USDC.e, able to trade in the browser). This project does **not** set allowances or deposits for you.

---

## Install

```bash
git clone https://github.com/VGabriel45/polymarket-btc5m-jev-trading.git
cd polymarket-btc5m-jev-trading
cp .env.example .env
npm install
```

Edit `.env` and set:

```bash
TYPESAFE_API_KEY=your_key_here
```

---

## Web dashboard (recommended)

Run the same bot with a live browser dashboard instead of the terminal UI:

```bash
npm run web
```

It prints one line to the terminal and then serves the UI:

```text
JEV dashboard → http://127.0.0.1:3000
```

Open that URL. The tab shows the market header, Up/Down prices, spread, live Up-price chart,
market depth, the Jev decision (confidence vs gate), position, PnL, recent decisions, the event
log, and recent orders. It streams over Server-Sent Events, so it updates on every tick with no
terminal output. Use the **Stop / Start** button in the top bar to pause or resume the loop.

Offline without a TypeSafe key:

```bash
POLYMARKET_SOURCE=fixture npm run web:stub
```

The server binds to `127.0.0.1` by default (it can drive live orders and reads `.env`). To expose it
on another interface, set `WEB_HOST` and `WEB_PORT`:

```bash
WEB_HOST=0.0.0.0 WEB_PORT=8080 npm run web
```

Only do that on a trusted network — there is no authentication on the control endpoint.

---

## Dry-run (terminal UI)

```bash
npm run watch
```

Ink TUI opens. You should see **DRY-RUN**. Press `q` to quit.

One-shot tick (JSON to stdout):

```bash
npm run once
```

Offline without a TypeSafe key:

```bash
POLYMARKET_SOURCE=fixture npm run watch -- --stub-judge
```

---

## Live trading

1. On [polymarket.com](https://polymarket.com), connect the wallet you will use and confirm you can trade normally.
2. Add to `.env`:

```bash
LIVE_TRADING=1
WALLET_PVK=0x...              # private key of that wallet
POLYMARKET_FUNDER=0x...       # deposit / proxy address if Polymarket uses one
SIGNATURE_TYPE=3              # POLY_1271 deposit wallet (usual)
POLYMARKET_SOURCE=live
BET_USD=5
```

3. Run:

```bash
npm run watch
```

Confirm the TUI shows **LIVE TRADING**. Live mode posts **FOK** (fill-or-kill) market orders. Unfilled orders are cancelled, not left resting.

Do not combine live mode with `--stub-judge` or `POLYMARKET_SOURCE=fixture`.

---

## How it decides

Every ~5s (`TICK_MS`) the session runs the full pipeline:

1. **Scan** every enabled `ASSETS` × `TIMEFRAMES` window (market + spot in parallel).
2. **Analyze** each window (rules only): momentum, window move, realized 1m
   volatility, how long the direction has held, and skip filters
   (`too_early`, `low_vol`, `chop`, `no_direction`).
3. **Rank** candidates by rules-based edge (fair P(best side) − ask) and pick the
   single best eligible window.
4. **Ask JEV** for a calibrated P(UP)/P(DOWN) on that window, with the analysis
   block included as a prior.
5. **Apply policy**, then trade or abstain:

| Situation | Action |
|-----------|--------|
| Analysis says low-vol / chop / too early | Wait (skipped before JEV) |
| Confidence ≤ `ACT_THRESHOLD` | Wait |
| JEV fights the momentum bias | Wait |
| Spread too wide, ask too high, or no edge vs ask, or little time left | Wait |
| Confidence high, bias agrees, edge ok | Buy once (fractional-Kelly, ≤ `BET_USD`) |
| Held position reaches `TAKE_PROFIT_PRICE` | Sell to lock profit |
| Held position otherwise | Hold until the window ends |

Winners are decided by Polymarket's rules (oracle reference vs price to beat),
not by share odds. Positions ride to resolution unless take-profit fires.

---

## Useful env vars

| Var | Default | What it does |
|-----|---------|--------------|
| `TYPESAFE_API_KEY` | — | Jev API key |
| `POLYMARKET_SOURCE` | `auto` | `live`, `fixture`, or `auto` |
| `ASSETS` | `btc,eth,sol,xrp,doge,bnb` | Coins to scan |
| `TIMEFRAMES` | `5m,15m` | Window lengths to scan |
| `TICK_MS` | `5000` | Seconds between ticks (ms) |
| `ACT_THRESHOLD` | `0.90` | Min confidence to enter (must be **strictly greater**) |
| `MAX_ASK` | `0.70` | Max share price to buy |
| `MAX_SPREAD` | `0.02` | Max top-of-book spread to accept |
| `MIN_EDGE` | `0.10` | Need P(win) ≥ ask + this |
| `BET_USD` | `5` | Max USD per entry |
| `BANKROLL_USD` | `100` | Bankroll for fractional-Kelly sizing |
| `KELLY_FRACTION` | `0.25` | Kelly fraction (¼ Kelly) |
| `MIN_SECONDS_TO_ENTER` | `90` | No new entries with less time left |
| `REQUIRE_TREND_HELD_SEC` | `60` | Direction must have held this long |
| `MIN_VOL_PCT` | `0.02` | Skip windows with less 1m volatility |
| `ENFORCE_STRATEGY` | `1` | Enforce analyze-stage skips |
| `REQUIRE_BIAS_AGREEMENT` | `1` | JEV must agree with the momentum bias |
| `TAKE_PROFIT_PRICE` | `0.90` | Sell open position at this bid (0 = off) |
| `MAX_ENTERS_PER_WINDOW` | `1` | One ride per window |
| `LIVE_TRADING` | off | Set `1` for real CLOB orders |
| `WALLET_PVK` | — | Signer key (live only) |
| `POLYMARKET_FUNDER` | — | Funder / deposit wallet (live) |
| `SIGNATURE_TYPE` | `3` | `3` = POLY_1271 |
| `WEB_PORT` | `3000` | Port for `npm run web` |
| `WEB_HOST` | `127.0.0.1` | Bind address for `npm run web` |

Full list is in `.env.example`.

---

## Scripts

```bash
npm run web           # browser dashboard (recommended)
npm run web:stub      # browser dashboard, offline stub
npm run watch         # TUI loop
npm run once          # single tick
npm run typecheck
npm run smoke:policy  # offline policy checks
```

---

## Disclaimer

Experimental software. Not financial advice. You can lose money. Not affiliated with Polymarket or TypeSafe beyond using their APIs/SDKs.
