/**
 * Asset + timeframe registry for Polymarket crypto Up/Down windows.
 *
 * Polymarket lists `<asset>-updown-<tf>-<windowStartUnix>` events for several
 * coins across 5m / 15m / 1h horizons. This module is the single source of
 * truth for which coins and timeframes the bot can trade.
 */

export type Asset = {
  /** Polymarket slug prefix, e.g. "btc". */
  id: string;
  /** Binance spot symbol, e.g. "BTCUSDT". */
  symbol: string;
  /** Human label for prompts / UI, e.g. "Bitcoin". */
  name: string;
  /** Ticker shown in the UI, e.g. "BTC". */
  ticker: string;
};

export const ASSETS: Record<string, Asset> = {
  btc: { id: "btc", symbol: "BTCUSDT", name: "Bitcoin", ticker: "BTC" },
  eth: { id: "eth", symbol: "ETHUSDT", name: "Ethereum", ticker: "ETH" },
  sol: { id: "sol", symbol: "SOLUSDT", name: "Solana", ticker: "SOL" },
  xrp: { id: "xrp", symbol: "XRPUSDT", name: "XRP", ticker: "XRP" },
  doge: { id: "doge", symbol: "DOGEUSDT", name: "Dogecoin", ticker: "DOGE" },
  bnb: { id: "bnb", symbol: "BNBUSDT", name: "BNB", ticker: "BNB" },
};

/** Order matters: earlier assets win ties when ranking opportunities. */
export const DEFAULT_ASSET_IDS = ["btc", "eth", "sol", "xrp", "doge", "bnb"];

export type Timeframe = {
  id: string;
  label: string;
  windowSec: number;
  /** Seconds into the window before the analysis allows an entry. */
  observeSec: number;
};

export const TIMEFRAMES: Record<string, Timeframe> = {
  "5m": { id: "5m", label: "5m", windowSec: 300, observeSec: 45 },
  "15m": { id: "15m", label: "15m", windowSec: 900, observeSec: 240 },
  "1h": { id: "1h", label: "1h", windowSec: 3600, observeSec: 600 },
};

export const DEFAULT_TIMEFRAME_IDS = ["5m", "15m"];

export type MarketSpec = {
  asset: Asset;
  timeframe: Timeframe;
  /** Stable id, e.g. "btc-5m". */
  key: string;
};

export function specKey(assetId: string, timeframeId: string): string {
  return `${assetId}-${timeframeId}`;
}

export function parseCsvList(
  raw: string | undefined,
  fallback: string[],
): string[] {
  if (raw == null || raw.trim() === "") return fallback.slice();
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/** Build the enabled set of asset x timeframe specs from raw id lists. */
export function buildSpecs(
  assetIds: string[],
  timeframeIds: string[],
): MarketSpec[] {
  const specs: MarketSpec[] = [];
  for (const assetId of assetIds) {
    const asset = ASSETS[assetId];
    if (!asset) continue;
    for (const tfId of timeframeIds) {
      const timeframe = TIMEFRAMES[tfId];
      if (!timeframe) continue;
      specs.push({ asset, timeframe, key: specKey(assetId, tfId) });
    }
  }
  return specs;
}

/** Window start (unix sec) for a timeframe at `nowMs`. */
export function windowStartSec(nowMs: number, windowSec: number): number {
  return Math.floor(nowMs / 1000 / windowSec) * windowSec;
}

/** Polymarket event slug for the active window of a spec. */
export function activeSlugForSpec(spec: MarketSpec, nowMs = Date.now()): string {
  const start = windowStartSec(nowMs, spec.timeframe.windowSec);
  return `${spec.asset.id}-updown-${spec.timeframe.id}-${start}`;
}

export type SlugParts = {
  assetId: string;
  timeframeId: string;
  windowSec: number;
  windowStartSec: number;
};

const SLUG_RE = /^([a-z0-9]+)-updown-(5m|15m|1h|4h|1d)-(\d+)$/i;

/** Parse `<asset>-updown-<tf>-<start>` slugs. Unknown shapes return null. */
export function parseUpDownSlug(slug: string): SlugParts | null {
  const m = SLUG_RE.exec(slug.trim());
  if (!m) return null;
  const tf = TIMEFRAMES[m[2]!.toLowerCase()];
  const start = Number(m[3]);
  if (!tf || !Number.isFinite(start)) return null;
  return {
    assetId: m[1]!.toLowerCase(),
    timeframeId: tf.id,
    windowSec: tf.windowSec,
    windowStartSec: start,
  };
}

/** True when `slug` is the active window of `spec` at `nowMs`. */
export function slugMatchesSpec(
  spec: MarketSpec,
  slug: string,
  nowMs = Date.now(),
): boolean {
  return slug === activeSlugForSpec(spec, nowMs);
}

export function assetById(id: string): Asset | null {
  return ASSETS[id.toLowerCase()] ?? null;
}

/** Resolve the spec a slug belongs to, if that spec is enabled. */
export function specForSlug(
  specs: MarketSpec[],
  slug: string,
): MarketSpec | null {
  const parts = parseUpDownSlug(slug);
  if (!parts) return null;
  return (
    specs.find(
      (s) =>
        s.asset.id === parts.assetId && s.timeframe.id === parts.timeframeId,
    ) ?? null
  );
}

export function formatSpec(spec: MarketSpec): string {
  return `${spec.asset.ticker} ${spec.timeframe.label}`;
}
