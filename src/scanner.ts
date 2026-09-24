import { analyzeWindow, type AnalysisOpts } from "./analysis.js";
import { activeSlugForSpec, parseUpDownSlug, type MarketSpec } from "./assets.js";
import type {
  ActorHealth,
  DomainMarket,
  Sample,
  ScanCandidate,
  Side,
  SpotPulse,
} from "./domain.js";
import { spreadOf } from "./policy.js";
import { windowHasEnded } from "./adapters/polymarket/wire.js";

/** One scanned market slot: spec + latest feeds + health. */
export type MarketFeed = {
  spec: MarketSpec;
  market: Sample<DomainMarket> | null;
  spot: Sample<SpotPulse> | null;
  marketHealth: ActorHealth;
  spotHealth: ActorHealth;
};

export type ScanOpts = {
  analysis: AnalysisOpts;
  maxAsk: number;
  maxSpread: number;
  minEdge: number;
  /** When false, strategy skips are advisory and do not block eligibility. */
  enforceStrategy: boolean;
};

function askOf(market: DomainMarket, side: Side): number {
  const q = market.bySide[side];
  return q.bestAsk ?? q.mid;
}

/**
 * Score one feed into a ranked candidate. Returns null when the feed cannot be
 * scanned (missing data, closed/rolled window, slug/spec mismatch).
 */
export function scanFeed(
  feed: MarketFeed,
  nowMs: number,
  opts: ScanOpts,
): ScanCandidate | null {
  const { market, spot } = feed;
  if (!market || !spot) return null;
  if (!feed.marketHealth.ok || !feed.spotHealth.ok) return null;

  const m = market.value;
  if (m.closed || !m.active) return null;
  // Fixtures/dry-runs may use non-slug ids; only enforce when the slug parses.
  const slugParts = parseUpDownSlug(m.eventSlug);
  if (slugParts && m.eventSlug !== activeSlugForSpec(feed.spec, nowMs)) return null;
  if (windowHasEnded(m, nowMs)) return null;

  const analysis = analyzeWindow({
    assetId: feed.spec.asset.id,
    timeframeId: feed.spec.timeframe.id,
    spot: spot.value,
    windowSec: feed.spec.timeframe.windowSec,
    nowMs,
    opts: { ...opts.analysis, observeSec: feed.spec.timeframe.observeSec },
  });

  const askUp = askOf(m, "UP");
  const askDown = askOf(m, "DOWN");
  const fairDown = 1 - analysis.fairUp;
  const edgeUp = analysis.fairUp - askUp;
  const edgeDown = fairDown - askDown;
  const side: Side = edgeUp >= edgeDown ? "UP" : "DOWN";
  const edge = Math.max(edgeUp, edgeDown);
  const ask = side === "UP" ? askUp : askDown;

  const reasons: string[] = [];
  if (opts.enforceStrategy) reasons.push(...analysis.skip);
  if (ask > opts.maxAsk) reasons.push("ask_too_high");
  const spread = spreadOf(m, side);
  if (opts.maxSpread > 0 && spread > opts.maxSpread) reasons.push("wide_spread");
  if (!(edge >= opts.minEdge)) reasons.push("thin_edge");

  return {
    specKey: feed.spec.key,
    assetId: feed.spec.asset.id,
    ticker: feed.spec.asset.ticker,
    timeframeId: feed.spec.timeframe.id,
    slug: m.eventSlug,
    ask,
    fairUp: analysis.fairUp,
    edge,
    side,
    eligible: reasons.length === 0,
    reasons,
    analysis,
  };
}

/** Rank all scannable feeds; eligible first, then by rule-based edge. */
export function rankCandidates(
  feeds: MarketFeed[],
  nowMs: number,
  opts: ScanOpts,
): ScanCandidate[] {
  const out: ScanCandidate[] = [];
  for (const feed of feeds) {
    const c = scanFeed(feed, nowMs, opts);
    if (c) out.push(c);
  }
  out.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (b.edge !== a.edge) return b.edge - a.edge;
    return a.specKey.localeCompare(b.specKey);
  });
  return out;
}
