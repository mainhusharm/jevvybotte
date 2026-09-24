import {
  asIsoTime,
  nowIso,
  type Sample,
  type SpotPulse,
  type SpotSource,
} from "../../domain.js";

export type FixedSpotInput = {
  last: number;
  change24hPct: number;
  volume24h: number;
  high24h?: number;
  low24h?: number;
  moveVsWindowOpenPct?: number;
  /** Fully-qualified symbol for this stub feed (defaults to BTCUSDT). */
  symbol?: string;
  /** Optional deterministic 1m closes (oldest → newest). */
  closes1m?: number[];
};

/** Build a flat-ish closes series ending at `last` for offline analysis. */
function synthCloses(last: number, n = 30): number[] {
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(last);
  return out;
}

export function fixedSpotSource(input: FixedSpotInput): SpotSource {
  return {
    async pullPulse(symbol: string): Promise<Sample<SpotPulse>> {
      const value: SpotPulse = {
        symbol: input.symbol ?? symbol.toUpperCase(),
        last: input.last,
        change24hPct: input.change24hPct,
        high24h: input.high24h ?? input.last * 1.02,
        low24h: input.low24h ?? input.last * 0.98,
        volume24hQuote: input.volume24h,
        moveVsWindowOpenPct: input.moveVsWindowOpenPct ?? 0,
        windowOpen: input.last,
        closes1m: input.closes1m ?? synthCloses(input.last),
      };
      const pulledAt = nowIso();
      return {
        value,
        freshness: { pulledAt: asIsoTime(pulledAt), ageMs: 0 },
        source: "stub",
      };
    },
  };
}

export class FixedSpotSource implements SpotSource {
  private readonly inner: SpotSource;
  constructor(input: FixedSpotInput) {
    this.inner = fixedSpotSource(input);
  }
  pullPulse(
    symbol: string,
    opts?: { windowStartSec?: number },
  ): Promise<Sample<SpotPulse>> {
    void opts;
    return this.inner.pullPulse(symbol);
  }
}
