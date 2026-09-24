import type { MarketSpec } from "./assets.js";

export type Confidence = number & { readonly __brand: "Confidence" };

/**
 * Confidence strictly greater than the session threshold (default 0.90).
 * Only constructible via gate(); ENTER requires this brand.
 */
export type HighConfidence = Confidence & { readonly __high: "HighConfidence" };

export type Side = "UP" | "DOWN";

export type TokenId = string & { readonly __brand: "TokenId" };

export type IsoTime = string & { readonly __brand: "IsoTime" };

export function asTokenId(s: string): TokenId {
  return s as TokenId;
}

export function asIsoTime(s: string): IsoTime {
  return s as IsoTime;
}

export function nowIso(): IsoTime {
  return asIsoTime(new Date().toISOString());
}

/** Finite probability in (0, 1]. */
export function parseConfidence(n: number): Confidence | null {
  if (!Number.isFinite(n) || n <= 0 || n > 1) return null;
  return n as Confidence;
}

export type Freshness = {
  pulledAt: IsoTime;
  ageMs: number;
};

export type Sample<T> = {
  value: T;
  freshness: Freshness;
  source: "live" | "fixture" | "stub";
};

export type DomainMarket = {
  eventSlug: string;
  /** Slug-derived asset id ("btc"), null when unknown. */
  assetId: string | null;
  /** Slug-derived timeframe id ("5m"), null when unknown. */
  timeframeId: string | null;
  /** Window length in seconds, null when unknown. */
  windowSec: number | null;
  question: string;
  conditionId: string;
  endsAt: IsoTime | null;
  volume24hUsd: number;
  closed: boolean;
  active: boolean;
  /** Parallel to Up/Down outcomes when Gamma provides them; used at settle. */
  outcomePrices: { UP: number | null; DOWN: number | null } | null;
  bySide: Record<
    Side,
    {
      tokenId: TokenId;
      outcomeLabel: string;
      mid: number;
      bestBid: number | null;
      bestAsk: number | null;
      spread: number | null;
      lastTrade: number | null;
    }
  >;
};

export type SpotPulse = {
  symbol: string;
  last: number;
  change24hPct: number;
  high24h: number;
  low24h: number;
  volume24hQuote: number;
  moveVsWindowOpenPct: number;
  /** Price at the start of the active window (1m kline open), when known. */
  windowOpen: number | null;
  /** Recent 1m closes, oldest → newest, for momentum/volatility analysis. */
  closes1m: number[];
};

/** Rule-based pre-JEV read of the current window (the "analyze" stage). */
export type StrategyAnalysis = {
  assetId: string;
  timeframeId: string;
  /** Seconds elapsed inside the current window. */
  elapsedSec: number;
  /** Short-horizon return in basis points (e.g. last 3 x 1m). */
  momentumBps: number;
  /** Return over the full window so far, in basis points. */
  windowMoveBps: number;
  /** Std-dev of 1m returns, in percent. */
  volatilityPct: number;
  /** Consecutive seconds the current direction has held. */
  trendHeldSec: number;
  /** Fair P(UP) from the rules-only model, 0..1. */
  fairUp: number;
  /** Rule-based side with the edge (or NEUTRAL when too weak). */
  bias: Side | "NEUTRAL";
  /** 0..1 confidence in the rule-based read. */
  biasStrength: number;
  /** Reasons the strategy says to sit this window out. */
  skip: string[];
  /** Human one-liner for JEV facts / logs. */
  notes: string;
};

/** A scored market opportunity produced by the scanner. */
export type ScanCandidate = {
  specKey: string;
  assetId: string;
  ticker: string;
  timeframeId: string;
  slug: string;
  ask: number;
  fairUp: number;
  /** Rule-based edge of the best side: P(best) - ask(best). */
  edge: number;
  side: Side;
  eligible: boolean;
  reasons: string[];
  analysis: StrategyAnalysis;
};

export type ActorHealth =
  | { ok: true }
  | { ok: false; code: "transport" | "parse" | "empty" | "stale"; detail: string };

export type WindowPhase = "awaiting_window" | "trading" | "settling" | "recorded";

export type Position =
  | { kind: "flat" }
  | {
      kind: "open";
      side: Side;
      tokenId: TokenId;
      size: number;
      entryPrice: number;
      openedAt: IsoTime;
      slug: string;
    };

export type IntendedOrder = {
  side: "BUY" | "SELL";
  tokenId: TokenId;
  outcome: Side;
  price: number;
  size: number;
  at: IsoTime;
  idempotencyKey: string;
  rationale: string;
  /** Gamma event slug this order belongs to (for the Polymarket link). */
  marketSlug?: string;
  /** Slug-derived asset id ("btc"). */
  assetId?: string;
  /** Slug-derived timeframe id ("5m"). */
  timeframeId?: string;
};

export type AbstainReason =
  | { code: "LOW_CONFIDENCE"; side: Side; confidence: Confidence }
  | {
      code: "NO_EDGE";
      side: Side;
      pWin: number;
      ask: number;
      need: number;
    }
  | { code: "TOO_LATE"; detail: string }
  | { code: "COOLDOWN"; detail: string }
  | { code: "MAX_TRADES"; detail: string }
  | { code: "STRATEGY_SKIP"; detail: string }
  | { code: "WIDE_SPREAD"; detail: string }
  | { code: "WORLD_INCOMPLETE"; missing: ReadonlyArray<"market" | "spot"> }
  | { code: "JUDGE_FAILED"; message: string }
  | { code: "MARKET_UNAVAILABLE"; message: string }
  | { code: "STALE_INPUTS"; detail: string }
  | { code: "AWAITING_WINDOW"; detail: string }
  | { code: "SETTLING"; detail: string };

export type TradeAction =
  | { kind: "ABSTAIN"; reason: AbstainReason }
  | { kind: "ENTER"; side: Side; confidence: HighConfidence; order: IntendedOrder; why: string }
  | { kind: "HOLD"; side: Side; confidence: Confidence; why: string }
  | {
      kind: "EXIT";
      side: Side;
      order: IntendedOrder;
      reason: "confidence_floor" | "window_end" | "switch" | "take_profit";
      why: string;
    }
  | {
      kind: "SWITCH";
      from: Side;
      to: Side;
      confidence: HighConfidence;
      exit: IntendedOrder;
      enter: IntendedOrder;
      why: string;
    };

export type PnLRecord = {
  slug: string;
  settledAt: IsoTime;
  /** Slug-derived asset id, when known. */
  assetId?: string;
  /** Slug-derived timeframe id, when known. */
  timeframeId?: string;
  winner: Side | null;
  positionSide: Side | null;
  entryPrice: number | null;
  exitPrice: number | null;
  size: number;
  pnlUsd: number;
  mode: "dry-run" | "live";
  reason:
    | "exit"
    | "switch"
    | "window_end"
    | "settle"
    | "take_profit"
    | "confidence_floor";
};

export type QuoteSlice = {
  mid: number;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  lastTrade: number | null;
};

export type FactsForJev = {
  market: {
    slug: string;
    question: string;
    assetId: string | null;
    assetName: string | null;
    timeframeId: string | null;
    endsAt: string | null;
    volume24hUsd: number;
    up: QuoteSlice;
    down: QuoteSlice;
  };
  asset: {
    symbol: string;
    last: number;
    change24hPct: number;
    high24h: number;
    low24h: number;
    volume24hQuote: number;
    /** Move vs the window open reference, percent. */
    moveVsWindowOpenPct: number;
    windowOpen: number | null;
  };
  /** Rules-based pre-JEV analysis (momentum, vol, held direction, skips). */
  analysis: StrategyAnalysis;
  session: {
    secondsRemaining: number | null;
    windowLengthSec: number;
    position:
      | { kind: "flat" }
      | {
          kind: "open";
          side: Side;
          size: number;
          entryPrice: number;
          mark: number;
          uPnLUsd: number;
          uPnLPct: number;
          inProfit: boolean;
        };
  };
  meta: {
    marketSource: "live" | "fixture" | "stub";
    spotSource: "live" | "fixture" | "stub";
    composedAt: string;
  };
};

export type JudgeOpinion = {
  side: Side;
  confidence: Confidence;
  probs?: { UP: number; DOWN: number };
};

export interface MarketSource {
  /** Pull the active window for a given asset/timeframe spec. */
  pullActive(spec: MarketSpec): Promise<Sample<DomainMarket>>;
  /** Optional: fetch a specific slug (for settle after rollover). */
  pullBySlug?(slug: string): Promise<Sample<DomainMarket>>;
}

export interface SpotSource {
  /** Pull the latest spot pulse for a Binance symbol ("BTCUSDT"). */
  pullPulse(
    symbol: string,
    opts?: { windowStartSec?: number },
  ): Promise<Sample<SpotPulse>>;
}

export interface Judge {
  ask(facts: FactsForJev): Promise<JudgeOpinion>;
}

export interface DryRunPen {
  record(order: IntendedOrder): Promise<void>;
  /** Recent recorded intents for TUI / snapshot (newest last). */
  tail?(limit?: number): ReadonlyArray<IntendedOrder>;
}

export type OrderExecutor = {
  apply(
    position: Position,
    action: TradeAction,
    market: DomainMarket,
    at: IsoTime,
  ): Promise<{ position: Position; orders: IntendedOrder[] }>;
};

export type SessionConfig = {
  /** Enabled asset x timeframe windows to scan. */
  specs: MarketSpec[];
  polymarket: MarketSource;
  spot: SpotSource;
  judge: Judge;
  pen: DryRunPen;
  /** ENTER only when conf > this (default 0.90). */
  threshold: number;
  /** Base USD notional per ENTER before Kelly scaling. */
  betUsd: number;
  /** Bankroll used for fractional-Kelly sizing (USD). */
  bankrollUsd: number;
  /** Fraction of full Kelly to bet (default 0.25). */
  kellyFraction: number;
  /** Refuse ENTER if ask above this (default 0.70). */
  maxAsk: number;
  /** Refuse ENTER if top-of-book spread above this (default 0.02). */
  maxSpread: number;
  /** Require P(win) ≥ ask + minEdge (default 0.10). */
  minEdge: number;
  /** Abstain from new ENTER when fewer seconds remain (default 90). */
  minSecondsToEnter: number;
  /** Require the post-open direction to have held this many seconds. */
  requireTrendHeldSec: number;
  /** Skip windows whose 1m volatility is below this percent. */
  minVolPct: number;
  /** Enforce analysis skip filters before asking JEV (off for stub runs). */
  enforceStrategy: boolean;
  /** Refuse ENTER when the JEV side fights the analysis bias. */
  requireBiasAgreement: boolean;
  /** Max ENTER actions per window (default 1 — ride to end). */
  maxEntersPerWindow: number;
  /** Exit an open position once its bid reaches this price (0 disables). */
  takeProfitPrice: number;
  tickMs: number;
  staleAfterMs: number;
  windowLengthSec: number;
  pnlPath: string;
  liveTrading: boolean;
  executor: OrderExecutor;
};

export type PnLSummary = {
  count: number;
  cumulativeUsd: number;
  last: PnLRecord | null;
};

export type TickSnapshot = {
  tickId: number;
  at: IsoTime;
  phase: WindowPhase;
  secondsRemaining: number | null;
  position: Position;
  action: TradeAction;
  market: {
    slug: string;
    question: string;
    assetId: string | null;
    assetName: string | null;
    ticker: string | null;
    timeframeId: string | null;
    windowSec: number | null;
    upMid: number;
    downMid: number;
    upBid: number | null;
    upAsk: number | null;
    downBid: number | null;
    downAsk: number | null;
    upSpread: number | null;
    downSpread: number | null;
    volume24hUsd: number;
    closed: boolean;
    active: boolean;
    source: Sample<DomainMarket>["source"];
    conditionId: string;
  } | null;
  btc: {
    last: number;
    change24hPct: number;
    high24h: number;
    low24h: number;
    volume24hQuote: number;
    moveVsWindowOpenPct: number;
    source: Sample<SpotPulse>["source"];
  } | null;
  health: {
    market: ActorHealth;
    spot: ActorHealth;
  };
  factsPreview: FactsForJev | null;
  /** Rule-based analysis for the focused (or best) window. */
  analysis: StrategyAnalysis | null;
  /** Scored opportunities across every enabled asset x timeframe. */
  candidates: ReadonlyArray<ScanCandidate>;
  opinion: JudgeOpinion | null;
  lastOrder: IntendedOrder | null;
  intentLogTail: ReadonlyArray<IntendedOrder>;
  lastPnL: PnLRecord | null;
  /** Settled trades this session (newest last), for order-result lookup. */
  recentPnL: ReadonlyArray<PnLRecord>;
  /** Realized PnL since this session started (ledger delta from boot). */
  sessionPnLUsd: number;
  /** Realized PnL across the whole ledger (all-time). */
  cumulativePnLUsd: number;
  /** Mark-to-market on open position (bid), null when flat. */
  unrealizedPnLUsd: number | null;
  /** Ring of recent policy decisions (newest last). */
  decisionLog: ReadonlyArray<{
    at: IsoTime;
    tickId: number;
    kind: string;
    summary: string;
    conf?: number;
    side?: Side;
    marketSlug?: string;
    assetId?: string;
    timeframeId?: string;
  }>;
  /** Ring of recent API / tool activity (newest last). */
  activityLog: ReadonlyArray<{
    at: IsoTime;
    channel: string;
    op: string;
    detail: string;
    ms?: number;
    ok: boolean;
  }>;
  /** Session tick interval (for next-decision countdown). */
  tickMs: number;
  /** Pit-trader one-liner for this tick. */
  voice: string;
};
