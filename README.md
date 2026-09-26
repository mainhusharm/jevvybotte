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

## AI tools (MCP: Claude / Cursor)

The built-in Model Context Protocol server lets an AI client search Polymarket, inspect live quotes, read account positions, preview capped trades, and record paper orders. It uses stdio locally; paper trading is the default and paper order records exist only in the MCP process memory. This integration uses public Polymarket APIs for market discovery, so it does not require `TYPESAFE_API_KEY`.

### Cursor

Create a project-level `.cursor/mcp.json` in the repository root. For a global entry in Cursor Settings → MCP or `~/.cursor/mcp.json`, replace `${workspaceFolder}` in the example with absolute paths to this checkout.

```json
{
  "mcpServers": {
    "polymarket": {
      "type": "stdio",
      "command": "node",
      "args": [
        "${workspaceFolder}/node_modules/tsx/dist/cli.mjs",
        "${workspaceFolder}/src/mcp/server.ts"
      ]
    }
  }
}
```

Restart/reload Cursor or enable the server under Customize → MCP. The workspace interpolation uses the folder containing `.cursor/mcp.json`. Cursor's [MCP documentation](https://cursor.com/docs/mcp) currently lists elicitation support, which this server requires before it will permit a live order.

### Claude Desktop

In Claude Desktop, open **Settings → Developer → Edit Config**. The config file is:

- Windows: `%APPDATA%\\Claude\\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

Merge this entry into the existing JSON (replace both paths with the absolute location of this checkout; keep Windows backslashes doubled in JSON, or use forward slashes):

```json
{
  "mcpServers": {
    "polymarket": {
      "command": "node",
      "args": [
        "C:/path/to/polymarket-btc5m-jev-trading/node_modules/tsx/dist/cli.mjs",
        "C:/path/to/polymarket-btc5m-jev-trading/src/mcp/server.ts"
      ]
    }
  }
}
```

Completely quit and restart Claude Desktop after saving. Current instructions for the config location are in the [MCP local-server guide](https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers). Client support for MCP form elicitation can vary by app/version: paper mode works without it, but live calls are blocked unless the client advertises form elicitation and presents the approval form.

The server loads the project's ignored root `.env` itself; do not put private keys in client config. The `node` command must be available to the desktop/editor process, and dependencies must already be installed in this checkout.

#### Safe first use

Start with paper mode: search for a market, call `get_market`, then `preview_order` followed by `place_order` with the default `mode: "paper"`. Only arm live mode after you have checked that the client displays the separate live-order elicitation prompt. MCP tool-call permission prompts and this order-specific approval form are distinct.

#### Troubleshooting

- Confirm Node 20+ and run `npm install` in the repository.
- Confirm the paths to both `node_modules/tsx/dist/cli.mjs` and `src/mcp/server.ts` are absolute and valid; use forward slashes in Windows JSON paths if easier.
- Restart the client after editing its config. In Cursor, inspect **Output → MCP Logs**. Claude Desktop MCP logs are under `%APPDATA%\\Claude\\logs` on Windows or `~/Library/Logs/Claude` on macOS.
- If a live call says the client does not advertise form elicitation, update/use a client that supports MCP form elicitation. There is deliberately no model-controlled text confirmation fallback; keep live disabled or use paper mode.

#### Tools

- `search_markets` and `get_market` — public search and live market quotes.
- `get_positions` — public Data API position read; give it your account wallet address if it cannot be derived locally.
- `preview_order` — creates a one-minute, single-use BUY preview bounded by `LIVE_MAX_ORDER_USD` (default $5).
- `place_order` — defaults to paper mode. It only records a local paper intent unless called with `mode: "live"` and the live setup below is armed. For live trading, the server asks the MCP client to show a form requiring a human to approve the exact BUY outcome, target shares, current ask/budget, and FOK price-protection behavior. Clients without form-elicitation support are blocked; no tool-argument or challenge-text fallback is provided. Quotes and preview expiry are checked again after approval before any order is sent.
- `get_paper_orders` — views this process's recent paper intents.

The MCP server never runs the bot's automatic strategy. Each tool call is a separate request; the model should not be treated as a source of guaranteed or verified trade advice. Launch via the client config above and review paper previews first. For manual testing, use `npm run mcp` in a terminal (MCP clients should invoke Node and tsx directly to keep stdout reserved for MCP messages). To enable MCP live trading, place `LIVE_TRADING=1`, `LIVE_TRADING_CONFIRM`, wallet fields, and `LIVE_MAX_ORDER_USD` in `.env`; the MCP server does not require a TypeSafe key. Its MCP-specific `mode: "live"` call asks the client to display a human approval form for that exact order before it submits.

To disable all real trading, keep `LIVE_TRADING` unset/off. Even when live configuration is enabled, `place_order` defaults to `mode: "paper"`. Review each client-side approval form yourself; the model cannot approve the form on your behalf.

---

## Live trading

1. On [Polymarket](https://polymarket.com), make sure your account is funded and can trade normally. Identify the account wallet address and wallet type in your profile/settings. The signer key must control the account or be an authorized signer. Wallet/signature mapping: `0` = EOA (no funder), `1` = legacy Proxy, `2` = legacy Safe, `3` = Deposit Wallet (default for accounts created on/after May 4, 2026).
2. Use a dedicated low-balance signer wallet. Never use a wallet holding funds you care about. Add settings to the ignored root `.env` (do not share the private key in chat, source files, logs, or `.env.example`):

```bash
LIVE_TRADING=1
LIVE_TRADING_CONFIRM=I_ACCEPT_REAL_MONEY_RISK
WALLET_PVK=0x...                 # signer private key (local .env only)
POLYMARKET_SOURCE=live            # required; no fixture fallback
SIGNATURE_TYPE=3                  # match your account wallet type
POLYMARKET_FUNDER=0x...           # exact account wallet address for types 1/2/3; omit for 0
LIVE_MAX_ORDER_USD=5              # hard notional ceiling for every single order
BET_USD=5                          # strategy stake cap, keep <= LIVE_MAX_ORDER_USD
```

The account must already be funded and have trading approvals set up on Polymarket. This bot does not make deposits or approvals. With live mode enabled it creates/derives CLOB API credentials locally from the signer, then places **FOK** orders; unfilled orders are cancelled. It will not cancel your other open orders. For MCP buys, the CLOB v2 market-order amount is a USDC budget, rounded down to cents; the SDK reserves estimated fees against the configured cap, and a tick-aligned relative 3% price-protection limit restricts the worst acceptable price. The client approval prompt shows the quoted budget and protected price. Actual fill size can be lower than preview shares; review each FOK prompt carefully.

3. For the strategy-driven TUI, verify settings carefully, then run `npm run watch` and confirm it says **LIVE TRADING**. For MCP, configure its local process environment with the same live settings and approve each exact order in the client-side MCP elicitation form. Do not combine strategy live mode with `--stub-judge` or fixture/auto market sources. To return to paper trading, set `LIVE_TRADING=0` or remove it.

Polymarket API flow/reference: [Wallets and Authentication](https://docs.polymarket.com/trading/wallets-auth), [Place Your First Order](https://docs.polymarket.com/trading/quickstart), [Place Orders](https://docs.polymarket.com/trading/place-orders). Never provide your private key to an assistant or support chat.

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
| `LIVE_TRADING_CONFIRM` | — | Exact value `I_ACCEPT_REAL_MONEY_RISK` required to arm live mode |
| `WALLET_PVK` | — | Signer key (live only; store in local ignored `.env`) |
| `POLYMARKET_FUNDER` | — | Account wallet address for signature types 1/2/3 |
| `SIGNATURE_TYPE` | — | Required live: 0=EOA, 1=Proxy, 2=Safe, 3=Deposit Wallet |
| `LIVE_MAX_ORDER_USD` | `5` | Per-order notional ceiling (strategy + MCP live orders) |
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
npm run mcp           # local stdio MCP server (paper mode by default)
npm run typecheck
npm run smoke:policy  # offline policy checks
npm run smoke:mcp     # offline MCP handshake / tools check
npm run smoke:mcp-safety  # mocked live approval and FOK safety checks
```

---

## Disclaimer

Experimental software. Not financial advice. You can lose money. Not affiliated with Polymarket or TypeSafe beyond using their APIs/SDKs.
