import { kellyStakeUsd } from "./analysis.js";
import type {
  Confidence,
  DomainMarket,
  HighConfidence,
  IntendedOrder,
  IsoTime,
  JudgeOpinion,
  Position,
  Side,
  StrategyAnalysis,
  TradeAction,
} from "./domain.js";

/** Brand confidence only when strictly above threshold. */
export function gate(c: Confidence, threshold: number): HighConfidence | null {
  if (!(c > threshold)) return null;
  return c as HighConfidence;
}

function priceBand(price: number): string {
  return (Math.round(price * 100) / 100).toFixed(2);
}

export function buildIdempotencyKey(args: {
  side: "BUY" | "SELL";
  tokenId: string;
  outcome: Side;
  size: number;
  price: number;
}): string {
  return `${args.side}:${args.tokenId}:${args.outcome}:${args.size}:${priceBand(args.price)}`;
}

/**
 * Share count for a USD budget at `price`. Floors to 2dp so size×price ≤ usd.
 */
export function sizeSharesForUsd(usd: number, price: number): number {
  if (!(usd > 0) || !(price > 0)) return 0;
  return Math.floor((usd / price) * 100) / 100;
}

/** Compact market identity for logs, e.g. "BTC 5m". */
export function marketTag(market: DomainMarket): string {
  const asset = (market.assetId ?? "?").toUpperCase();
  const tf = market.timeframeId ?? "";
  return tf ? `${asset} ${tf}` : asset;
}

/** Public Polymarket event URL for a Gamma slug. */
export function polymarketUrl(slug: string): string {
  return `https://polymarket.com/event/${slug}`;
}

function buyOrder(
  market: DomainMarket,
  outcome: Side,
  stakeUsd: number,
  at: IsoTime,
  rationale: string,
): IntendedOrder {
  const quote = market.bySide[outcome];
  const price = quote.bestAsk ?? quote.mid;
  const size = sizeSharesForUsd(stakeUsd, price);
  return {
    side: "BUY",
    tokenId: quote.tokenId,
    outcome,
    price,
    size,
    at,
    idempotencyKey: buildIdempotencyKey({
      side: "BUY",
      tokenId: quote.tokenId,
      outcome,
      size,
      price,
    }),
    rationale,
    marketSlug: market.eventSlug,
    assetId: market.assetId ?? undefined,
    timeframeId: market.timeframeId ?? undefined,
  };
}

function sellOrder(
  market: DomainMarket,
  outcome: Side,
  size: number,
  at: IsoTime,
  rationale: string,
): IntendedOrder {
  const quote = market.bySide[outcome];
  const price = markBid(market, outcome);
  return {
    side: "SELL",
    tokenId: quote.tokenId,
    outcome,
    size,
    price,
    at,
    idempotencyKey: buildIdempotencyKey({
      side: "SELL",
      tokenId: quote.tokenId,
      outcome,
      size,
      price,
    }),
    rationale,
    marketSlug: market.eventSlug,
    assetId: market.assetId ?? undefined,
    timeframeId: market.timeframeId ?? undefined,
  };
}

/** Mark price for exiting a side. Ignore stub wing bids far from mid. */
export function markBid(market: DomainMarket, side: Side): number {
  const q = market.bySide[side];
  const gamma = market.outcomePrices?.[side];
  if (
    q.bestBid != null &&
    Number.isFinite(q.bestBid) &&
    Math.abs(q.bestBid - q.mid) <= 0.25
  ) {
    return q.bestBid;
  }
  if (q.lastTrade != null && Number.isFinite(q.lastTrade)) return q.lastTrade;
  if (gamma != null && Number.isFinite(gamma)) return gamma;
  return q.mid;
}

/** Top-of-book spread for a side (falls back to 0 when unknown). */
export function spreadOf(market: DomainMarket, side: Side): number {
  const q = market.bySide[side];
  if (q.bestAsk != null && q.bestBid != null) {
    return Math.max(0, q.bestAsk - q.bestBid);
  }
  return q.spread ?? 0;
}

export type PlanTradeOpts = {
  /** ENTER only when conf > this (default 0.90). */
  threshold: number;
  betUsd: number;
  /** Refuse ENTER when ask > maxAsk (default 0.70). */
  maxAsk: number;
  /** Refuse ENTER when spread > maxSpread (default 0.02). */
  maxSpread: number;
  /** Require P(win) ≥ ask + minEdge (default 0.10). */
  minEdge: number;
  /** No new ENTER when seconds left < this (default 90). */
  minSecondsToEnter: number;
  /** Window seconds remaining; null unknown. */
  secondsRemaining: number | null;
  maxEntersPerWindow: number;
  entersThisWindow: number;
  /** Rules-based analysis for this window (analyze stage). */
  analysis?: StrategyAnalysis;
  /** When false, strategy skips are advisory only (stub/offline runs). */
  enforceStrategy?: boolean;
  /** Refuse when JEV side fights the analysis bias. */
  requireBiasAgreement?: boolean;
  bankrollUsd?: number;
  kellyFraction?: number;
  /** Exit an open position once the bid reaches this (0 disables). */
  takeProfitPrice?: number;
};

/** P that the held (or named) side wins the window, from Jev probs or choice. */
export function heldWinProb(opinion: JudgeOpinion, side: Side): number {
  const fromProbs = opinion.probs?.[side];
  if (fromProbs != null && Number.isFinite(fromProbs)) return fromProbs;
  return opinion.side === side ? opinion.confidence : 1 - opinion.confidence;
}

/**
 * Analyze-then-trade policy.
 *
 * Flat: skip obvious no-trade regimes, then ENTER once when JEV conf is high,
 * the rules-based bias agrees, ask/spread are sane, P(win) ≥ ask+minEdge, and
 * enough time is left. Stake is fractional-Kelly capped at `betUsd`.
 * Open: take profit at `takeProfitPrice`, else ride to resolution.
 */
export function planTrade(
  position: Position,
  opinion: JudgeOpinion,
  market: DomainMarket,
  at: IsoTime,
  opts: PlanTradeOpts,
): TradeAction {
  const {
    threshold,
    betUsd,
    maxAsk,
    maxSpread,
    minEdge,
    minSecondsToEnter,
    secondsRemaining,
    maxEntersPerWindow,
    entersThisWindow,
    analysis,
    enforceStrategy = false,
    requireBiasAgreement = false,
    bankrollUsd = 0,
    kellyFraction = 0.25,
    takeProfitPrice = 0,
  } = opts;
  const hi = gate(opinion.confidence, threshold);

  if (position.kind === "open") {
    const mark = markBid(market, position.side);
    if (takeProfitPrice > 0 && mark >= takeProfitPrice) {
      const why = `[${marketTag(market)}] TAKE PROFIT ${position.side} @ bid ${mark.toFixed(3)} ≥ ${takeProfitPrice.toFixed(2)} — lock it`;
      return {
        kind: "EXIT",
        side: position.side,
        reason: "take_profit",
        why,
        order: sellOrder(market, position.side, position.size, at, why),
      };
    }
    const edge = mark - position.entryPrice;
    const uPnL = position.size * edge;
    const pHeld = heldWinProb(opinion, position.side);
    const why = `[${marketTag(market)}] HOLD ${position.side} to resolution · Jev conf ${opinion.confidence.toFixed(3)} P(held)=${pHeld.toFixed(3)} · mark ${mark.toFixed(3)} entry ${position.entryPrice.toFixed(3)} uPnL $${uPnL.toFixed(2)}`;
    return {
      kind: "HOLD",
      side: position.side,
      confidence: opinion.confidence,
      why,
    };
  }

  // Analyze stage: skip windows in known bad regimes.
  if (enforceStrategy && analysis) {
    const blocking = analysis.skip.filter(
      (r) =>
        r === "too_early" ||
        r === "low_vol" ||
        r === "chop" ||
        r === "no_direction",
    );
    if (blocking.length > 0) {
      return {
        kind: "ABSTAIN",
        reason: {
          code: "STRATEGY_SKIP",
          detail: `${market.eventSlug} ${blocking.join("+")} (${analysis.notes})`,
        },
      };
    }
    if (
      requireBiasAgreement &&
      analysis.bias !== "NEUTRAL" &&
      analysis.bias !== opinion.side
    ) {
      return {
        kind: "ABSTAIN",
        reason: {
          code: "STRATEGY_SKIP",
          detail: `bias conflict: analysis=${analysis.bias} jev=${opinion.side} (mom ${analysis.momentumBps.toFixed(1)}bps)`,
        },
      };
    }
  }

  if (!hi) {
    return {
      kind: "ABSTAIN",
      reason: {
        code: "LOW_CONFIDENCE",
        side: opinion.side,
        confidence: opinion.confidence,
      },
    };
  }

  if (entersThisWindow >= maxEntersPerWindow) {
    return {
      kind: "ABSTAIN",
      reason: {
        code: "MAX_TRADES",
        detail: `already entered this window (${entersThisWindow}/${maxEntersPerWindow}) — ride only`,
      },
    };
  }

  if (
    secondsRemaining != null &&
    secondsRemaining < minSecondsToEnter
  ) {
    return {
      kind: "ABSTAIN",
      reason: {
        code: "TOO_LATE",
        detail: `${secondsRemaining}s left < ${minSecondsToEnter}s enter cutoff — book already prices the outcome`,
      },
    };
  }

  const spread = spreadOf(market, opinion.side);
  if (maxSpread > 0 && spread > maxSpread) {
    return {
      kind: "ABSTAIN",
      reason: {
        code: "WIDE_SPREAD",
        detail: `${opinion.side} spread ${spread.toFixed(3)} > ${maxSpread.toFixed(3)} — start at a loss`,
      },
    };
  }

  const ask =
    market.bySide[opinion.side].bestAsk ?? market.bySide[opinion.side].mid;
  const pWin = heldWinProb(opinion, opinion.side);
  const need = ask + minEdge;

  if (ask > maxAsk) {
    return {
      kind: "ABSTAIN",
      reason: {
        code: "NO_EDGE",
        side: opinion.side,
        pWin,
        ask,
        need: maxAsk,
      },
    };
  }

  // Fair EV needs P(win) above ask by minEdge. Conf alone is not edge.
  if (!(pWin >= need)) {
    return {
      kind: "ABSTAIN",
      reason: {
        code: "NO_EDGE",
        side: opinion.side,
        pWin,
        ask,
        need,
      },
    };
  }

  // Fractional-Kelly stake, capped at the configured max notional.
  let stakeUsd = betUsd;
  if (bankrollUsd > 0) {
    const kelly = kellyStakeUsd({
      pWin,
      price: ask,
      bankrollUsd,
      fraction: kellyFraction,
    });
    stakeUsd = Math.min(betUsd, kelly);
    if (!(stakeUsd > 0)) {
      return {
        kind: "ABSTAIN",
        reason: {
          code: "NO_EDGE",
          side: opinion.side,
          pWin,
          ask,
          need,
        },
      };
    }
  }

  const biasTag = analysis ? ` · ${analysis.bias}/${analysis.momentumBps.toFixed(0)}bps` : "";
  const why = `[${marketTag(market)}] ENTER ${opinion.side}: P=${pWin.toFixed(3)} vs ask ${ask.toFixed(3)} (edge ${(pWin - ask).toFixed(3)}) · conf ${opinion.confidence.toFixed(3)} · stake $${stakeUsd.toFixed(2)}${biasTag}`;
  return {
    kind: "ENTER",
    side: opinion.side,
    confidence: hi,
    why,
    order: buyOrder(market, opinion.side, stakeUsd, at, why),
  };
}

/** Force-close at window end (bid mark or mid). */
export function planWindowEndExit(
  position: Extract<Position, { kind: "open" }>,
  market: DomainMarket,
  at: IsoTime,
): TradeAction {
  const mark = markBid(market, position.side);
  const why = `[${marketTag(market)}] WINDOW END: force sell ${position.side} @ bid ${mark.toFixed(3)}`;
  return {
    kind: "EXIT",
    side: position.side,
    reason: "window_end",
    why,
    order: sellOrder(market, position.side, position.size, at, why),
  };
}
