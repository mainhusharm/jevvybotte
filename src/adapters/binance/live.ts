import {
  asIsoTime,
  nowIso,
  type Sample,
  type SpotPulse,
  type SpotSource,
} from "../../domain.js";

const BINANCE = "https://api.binance.com";
/** How many 1m closes to keep for the rules-based analysis. */
const CLOSES = 60;
const TICKER_TTL_MS = 90_000;
const KLINES_TTL_MS = 20_000;

type CacheEntry<T> = { at: number; value: T };
const tickerCache = new Map<string, CacheEntry<Record<string, string>>>();
const klinesCache = new Map<string, CacheEntry<unknown[]>>();

async function getJson(path: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${BINANCE}${path}`, {
      signal: AbortSignal.timeout(12_000),
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    (err as Error & { status?: number }).status = 0;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} binance ${path}`);
  }
  return res.json();
}

async function cachedTicker24(sym: string): Promise<Record<string, string>> {
  const hit = tickerCache.get(sym);
  if (hit && Date.now() - hit.at < TICKER_TTL_MS) return hit.value;
  const value = (await getJson(
    `/api/v3/ticker/24hr?symbol=${sym}`,
  )) as Record<string, string>;
  tickerCache.set(sym, { at: Date.now(), value });
  return value;
}

async function cachedKlines(sym: string): Promise<unknown[]> {
  const hit = klinesCache.get(sym);
  if (hit && Date.now() - hit.at < KLINES_TTL_MS) return hit.value;
  const value = (await getJson(
    `/api/v3/klines?symbol=${sym}&interval=1m&limit=${CLOSES}`,
  )) as unknown[];
  klinesCache.set(sym, { at: Date.now(), value });
  return value;
}

function parseKlineRows(rows: unknown[]): { openTime: number; open: number; close: number }[] {
  const out: { openTime: number; open: number; close: number }[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const openTime = Number(row[0]);
    const open = Number(row[1]);
    const close = Number(row[4]);
    if (Number.isFinite(openTime) && Number.isFinite(close)) {
      out.push({ openTime, open, close });
    }
  }
  return out;
}

export function binanceSpotSource(): SpotSource {
  return {
    async pullPulse(
      symbol: string,
      opts?: { windowStartSec?: number },
    ): Promise<Sample<SpotPulse>> {
      const sym = symbol.toUpperCase();
      const [ticker24, price, klinesRaw] = await Promise.all([
        cachedTicker24(sym),
        getJson(`/api/v3/ticker/price?symbol=${sym}`) as Promise<{ price: string }>,
        cachedKlines(sym),
      ]);

      const last = Number(price.price);
      const change24hPct = Number(ticker24.priceChangePercent);
      const high24h = Number(ticker24.highPrice);
      const low24h = Number(ticker24.lowPrice);
      const volume24hQuote = Number(ticker24.quoteVolume);

      const klines = parseKlineRows(klinesRaw);
      const closes1m = klines.map((k) => k.close);

      // Window open = 1m kline whose openTime equals the window start.
      let windowOpen: number | null = null;
      if (opts?.windowStartSec != null) {
        const targetMs = opts.windowStartSec * 1000;
        const hit = klines.find((k) => Math.abs(k.openTime - targetMs) < 1000);
        if (hit) windowOpen = hit.open;
      }

      notFiniteThrow({ last, change24hPct, high24h, low24h, volume24hQuote });

      const moveVsWindowOpenPct =
        windowOpen != null && windowOpen > 0
          ? ((last - windowOpen) / windowOpen) * 100
          : 0;

      const value: SpotPulse = {
        symbol: sym,
        last,
        change24hPct,
        high24h,
        low24h,
        volume24hQuote,
        moveVsWindowOpenPct: Number.isFinite(moveVsWindowOpenPct)
          ? moveVsWindowOpenPct
          : 0,
        windowOpen,
        closes1m,
      };
      const pulledAt = nowIso();
      return {
        value,
        freshness: { pulledAt: asIsoTime(pulledAt), ageMs: 0 },
        source: "live",
      };
    },
  };
}

function notFiniteThrow(vals: Record<string, number>): void {
  for (const [k, v] of Object.entries(vals)) {
    if (!Number.isFinite(v)) throw new Error(`binance ticker parse failed (${k})`);
  }
}
