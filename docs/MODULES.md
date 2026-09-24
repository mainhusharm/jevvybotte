# Module map — candidate 1

## Layout

```
src/
  assets.ts               # asset + timeframe registry → MarketSpec, slug helpers
  session.ts              # WindowSession — scan loop, single position, snapshot
  scanner.ts              # rankCandidates — score every scanned window by edge
  analysis.ts             # analyzeWindow (rules) + kellyStakeUsd  ("analyze" stage)
  compose.ts              # composeFacts + Sample freshness rules
  policy.ts               # gate, planTrade (edge/spread/Kelly/take-profit), exits
  domain.ts               # DomainMarket, SpotPulse, StrategyAnalysis, brands
  config.ts               # loadConfig(env) → SessionConfig wiring
  adapters/
    polymarket/
      live.ts             # Gamma resolve + CLOB reads → DomainMarket (wire dies here)
      fixture.ts          # JSON fixture → DomainMarket
      auto.ts             # live-then-fixture sticky fallback
      wire.ts             # PRIVATE: Gamma/CLOB parse helpers (never exported up)
    binance/
      live.ts             # klines + ticker (TTL-cached) → SpotPulse
      fixed.ts            # test/fixture spot
    jev/
      typesafe.ts         # TypeSafeClient.systemOne → JudgeOpinion (asset-aware)
      stub.ts             # --stub-judge / tests only
  broker/
    dry.ts                # simulate fills
    live.ts               # CLOB FOK orders (live trading)
  dryrun/
    log-pen.ts            # console/file intended order log
    memory-pen.ts         # tests
  tui/
    App.tsx               # Ink root; subscribe(emit)
    panels.tsx            # Market / Asset / Verdict panes (pure from TickSnapshot)
  web/
    server.ts             # npm run web — SSE dashboard host
    dashboard.html        # browser dashboard
  cli/
    watch.ts              # npm run watch
    once.ts               # npm run tick -- --once
fixtures/
  btc-updown-active.json  # Domain-shaped (or wire→parse in fixture adapter only)
```

## Tick call chain (≤3 files to trace)

1. **`session.ts`** — `tick()`: pull every spec's market + spot in parallel →
2. **`scanner.ts`** — `rankCandidates` → `analysis.ts` `analyzeWindow` per window →
3. **`compose.ts`** — `composeFacts(sample, spot, analysis)` → **`typesafe.ts`** `judge.ask` →
4. **`policy.ts`** — `planTrade(...)` → optional executor / `pen.record`

Adapters are leaves called from `session.ts`; they do not call each other. TUI never enters this chain.

## Responsibilities

| Module | Owns | Does not own |
|--------|------|--------------|
| `session.ts` | Loop, per-spec feed slots + health, position, snapshot assembly | Wire parsing, Ink layout, Jev SDK details |
| `scanner.ts` | Scoring/ranking every scanned window; eligibility reasons | Network I/O, order execution |
| `analysis.ts` | Rules-based momentum/vol/chop read + Kelly stake math | Jev calls, network I/O |
| `compose.ts` | Merge-at-read, staleness, `FactsForJev` shape | Threshold / policy logic |
| `policy.ts` | `gate`, `planTrade`, edge/spread/Kelly/take-profit, exits | Network I/O |
| `adapters/polymarket/*` | Gamma slug resolve (any asset/timeframe), CLOB book → `DomainMarket` | Decision, TUI |
| `adapters/binance/*` | Cached 24h stats + 1m klines → `SpotPulse` | Jev state packaging |
| `adapters/jev/*` | asset-aware `choice(UP/DOWN)` call, confidence parse | Threshold gate (app-owned) |
| `dryrun/*` | Log intended orders only | Any CLOB write client |
| `tui/*` | Colorful render of `TickSnapshot` | Fetching / judging |

## Shared state rule

- **Feeds** (inside session): one `MarketFeed` per `MarketSpec` — `Sample<DomainMarket> | null`, `Sample<SpotPulse> | null` + health each
- No global store. `composeFacts` is the sole merge for the focused window. Snapshot is a pure projection for the TUI/web.

## Polymarket live adapter (patterns from vendor skill)

Inside `adapters/polymarket/live.ts` / `wire.ts` only:

1. Gamma `GET /events?slug=…` or series/tag search for active BTC Up/Down (`active=true&closed=false`)
2. Read `markets[].clobTokenIds` / outcomes → map to `Side` UP/DOWN
3. Unauthed `ClobClient` reads: `getMidpoint`, `getSpread`, `getLastTradePrice`, optional `getOrderBook` for bid/ask
4. Emit `Sample<DomainMarket>` with `source: "live"`

`auto.ts`: on HTTP/transport failure (incl. HTTP 000 class), sticky-switch to `fixture.ts` and set `source: "fixture"` thereafter.

## Anti-patterns explicitly rejected

- No `services/gather → services/validate → services/transform → services/decide` pipeline (temporal shallow layers)
- No re-export of Gamma event DTOs as "Market"
- No pass-through `MarketService.getMarket()` that returns the same shape three modules deep
- No TUI import of adapters
