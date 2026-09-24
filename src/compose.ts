import type {
  DomainMarket,
  FactsForJev,
  IsoTime,
  Position,
  QuoteSlice,
  Sample,
  SpotPulse,
  StrategyAnalysis,
} from "./domain.js";
import { secondsRemaining } from "./adapters/polymarket/wire.js";
import { markBid } from "./policy.js";

function ageMsOf(pulledAt: IsoTime, now: IsoTime): number {
  return Math.max(0, Date.parse(now) - Date.parse(pulledAt));
}

function quoteSlice(
  market: DomainMarket,
  side: "UP" | "DOWN",
): QuoteSlice {
  const q = market.bySide[side];
  return {
    mid: q.mid,
    bid: q.bestBid,
    ask: q.bestAsk,
    spread: q.spread,
    lastTrade: q.lastTrade,
  };
}

/** Asset display name for prompts, from the slug-derived id. */
export function assetDisplayName(assetId: string | null): string | null {
  if (!assetId) return null;
  const map: Record<string, string> = {
    btc: "Bitcoin",
    eth: "Ethereum",
    sol: "Solana",
    xrp: "XRP",
    doge: "Dogecoin",
    bnb: "BNB",
  };
  return map[assetId] ?? assetId.toUpperCase();
}

export function composeFacts(
  market: Sample<DomainMarket>,
  spot: Sample<SpotPulse>,
  now: IsoTime,
  staleAfterMs: number,
  position: Position,
  windowLengthSec: number,
  analysis: StrategyAnalysis,
  windowOpenFallback: number | null,
):
  | { ok: true; facts: FactsForJev }
  | { ok: false; reason: "stale_inputs" | "actor_unhealthy"; detail: string } {
  const marketAge = ageMsOf(market.freshness.pulledAt, now);
  const spotAge = ageMsOf(spot.freshness.pulledAt, now);

  if (marketAge > staleAfterMs || spotAge > staleAfterMs) {
    return {
      ok: false,
      reason: "stale_inputs",
      detail: `marketAgeMs=${marketAge} spotAgeMs=${spotAge} staleAfterMs=${staleAfterMs}`,
    };
  }

  const m = market.value;
  const s = spot.value;
  const openPx =
    s.windowOpen != null && s.windowOpen > 0
      ? s.windowOpen
      : windowOpenFallback != null && windowOpenFallback > 0
        ? windowOpenFallback
        : null;
  const moveVsWindowOpenPct =
    openPx != null ? ((s.last - openPx) / openPx) * 100 : 0;

  let sessionPosition: FactsForJev["session"]["position"];
  if (position.kind === "flat") {
    sessionPosition = { kind: "flat" };
  } else {
    const mark = markBid(m, position.side);
    const uPnLUsd = position.size * (mark - position.entryPrice);
    const uPnLPct =
      position.entryPrice > 0
        ? ((mark - position.entryPrice) / position.entryPrice) * 100
        : 0;
    sessionPosition = {
      kind: "open",
      side: position.side,
      size: position.size,
      entryPrice: position.entryPrice,
      mark,
      uPnLUsd,
      uPnLPct,
      inProfit: uPnLUsd > 0,
    };
  }

  const facts: FactsForJev = {
    market: {
      slug: m.eventSlug,
      question: m.question,
      assetId: m.assetId,
      assetName: assetDisplayName(m.assetId),
      timeframeId: m.timeframeId,
      endsAt: m.endsAt,
      volume24hUsd: m.volume24hUsd,
      up: quoteSlice(m, "UP"),
      down: quoteSlice(m, "DOWN"),
    },
    asset: {
      symbol: s.symbol,
      last: s.last,
      change24hPct: s.change24hPct,
      high24h: s.high24h,
      low24h: s.low24h,
      volume24hQuote: s.volume24hQuote,
      moveVsWindowOpenPct: Number.isFinite(moveVsWindowOpenPct)
        ? moveVsWindowOpenPct
        : 0,
      windowOpen: openPx,
    },
    analysis,
    session: {
      secondsRemaining: secondsRemaining(m.endsAt, now),
      windowLengthSec,
      position: sessionPosition,
    },
    meta: {
      marketSource: market.source,
      spotSource: spot.source,
      composedAt: now,
    },
  };

  return { ok: true, facts };
}
