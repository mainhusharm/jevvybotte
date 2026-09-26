import { resolve } from "node:path";
import { autoMarketSource } from "./adapters/polymarket/auto.js";
import { fixtureMarketSource } from "./adapters/polymarket/fixture.js";
import { liveMarketSource } from "./adapters/polymarket/live.js";
import { binanceSpotSource } from "./adapters/binance/live.js";
import { fixedSpotSource } from "./adapters/binance/fixed.js";
import { typeSafeJudge } from "./adapters/jev/typesafe.js";
import { stubJudge } from "./adapters/jev/stub.js";
import { applyDry } from "./broker/dry.js";
import { LiveBroker, liveBrokerOptionsFromEnv } from "./broker/live.js";
import { logPen } from "./dryrun/log-pen.js";
import { defaultPnLPath } from "./pnl/ledger.js";
import {
  buildSpecs,
  parseCsvList,
  DEFAULT_ASSET_IDS,
  DEFAULT_TIMEFRAME_IDS,
} from "./assets.js";
import type {
  Judge,
  MarketSource,
  OrderExecutor,
  SessionConfig,
  SpotSource,
} from "./domain.js";

export type EnvBag = {
  TYPESAFE_API_KEY?: string;
  POLYMARKET_SOURCE?: string;
  BTC_UPDOWN_SLUG?: string;
  TICK_MS?: string;
  ACT_THRESHOLD?: string;
  BET_USD?: string;
  BANKROLL_USD?: string;
  KELLY_FRACTION?: string;
  MAX_ASK?: string;
  MAX_SPREAD?: string;
  MIN_EDGE?: string;
  MIN_SECONDS_TO_ENTER?: string;
  MAX_ENTERS_PER_WINDOW?: string;
  REQUIRE_TREND_HELD_SEC?: string;
  MIN_VOL_PCT?: string;
  TAKE_PROFIT_PRICE?: string;
  ENFORCE_STRATEGY?: string;
  REQUIRE_BIAS_AGREEMENT?: string;
  ASSETS?: string;
  TIMEFRAMES?: string;
  FIXTURE_PATH?: string;
  STALE_AFTER_MS?: string;
  LIVE_TRADING?: string;
  LIVE_TRADING_CONFIRM?: string;
  LIVE_MAX_ORDER_USD?: string;
  PNL_PATH?: string;
  WALLET_PVK?: string;
  POLYMARKET_FUNDER?: string;
  SIGNATURE_TYPE?: string;
  POLYGON_RPC_URL?: string;
};

export type LoadConfigOptions = {
  stubJudge?: boolean;
  fixedSpot?: boolean;
  stubConfidence?: number;
  stubSide?: "UP" | "DOWN";
  overrides?: Partial<SessionConfig>;
};

function num(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function marketFromEnv(env: EnvBag, fixturePath: string): MarketSource {
  const source = (env.POLYMARKET_SOURCE ?? "auto").toLowerCase();
  const slugOverride = env.BTC_UPDOWN_SLUG || undefined;
  if (source === "fixture") return fixtureMarketSource(fixturePath);
  if (source === "live") return liveMarketSource({ slugOverride });
  return autoMarketSource({ slugOverride, fixturePath });
}

function dryExecutor(): OrderExecutor {
  return {
    async apply(position, action, market, at) {
      return applyDry(position, action, market, at);
    },
  };
}

/**
 * Build SessionConfig from env. Fail-loud if TYPESAFE_API_KEY missing unless stub.
 * LIVE_TRADING=1 posts via deposit-wallet CLOB v2 (POLY_1271).
 */
export function loadConfig(
  env: NodeJS.ProcessEnv | EnvBag,
  opts: LoadConfigOptions = {},
): SessionConfig {
  const e = env as EnvBag;
  const fixturePath = resolve(
    e.FIXTURE_PATH ?? "fixtures/btc-updown-active.json",
  );
  const threshold = num(e.ACT_THRESHOLD, 0.9);
  let betUsd = num(e.BET_USD, 5);
  const maxAsk = num(e.MAX_ASK, 0.7);
  const minEdge = num(e.MIN_EDGE, 0.1);
  const minSecondsToEnter = Math.max(0, Math.floor(num(e.MIN_SECONDS_TO_ENTER, 90)));
  const maxEntersPerWindow = Math.max(
    1,
    Math.floor(num(e.MAX_ENTERS_PER_WINDOW, 1)),
  );
  const bankrollUsd = Math.max(0, num(e.BANKROLL_USD, 100));
  const kellyFraction = Math.min(1, Math.max(0, num(e.KELLY_FRACTION, 0.25)));
  const maxSpread = Math.max(0, num(e.MAX_SPREAD, 0.02));
  const requireTrendHeldSec = Math.max(
    0,
    Math.floor(num(e.REQUIRE_TREND_HELD_SEC, 60)),
  );
  const minVolPct = Math.max(0, num(e.MIN_VOL_PCT, 0.02));
  const takeProfitPrice = Math.max(0, num(e.TAKE_PROFIT_PRICE, 0.9));
  const envEnforce =
    e.ENFORCE_STRATEGY !== "0" && e.ENFORCE_STRATEGY !== "false";
  const requireBiasAgreement =
    e.REQUIRE_BIAS_AGREEMENT !== "0" &&
    e.REQUIRE_BIAS_AGREEMENT !== "false";
  const assetIds = parseCsvList(e.ASSETS, DEFAULT_ASSET_IDS);
  const timeframeIds = parseCsvList(e.TIMEFRAMES, DEFAULT_TIMEFRAME_IDS);
  const tickMs = num(e.TICK_MS, 5_000);
  const staleAfterMs = num(e.STALE_AFTER_MS, 120_000);
  const liveTrading = e.LIVE_TRADING === "1" || e.LIVE_TRADING === "true";
  const sourceName = (e.POLYMARKET_SOURCE ?? "auto").toLowerCase();
  let signatureType = 3;
  let liveMaxOrderUsd = 5;
  if (liveTrading) {
    if (e.LIVE_TRADING_CONFIRM !== "I_ACCEPT_REAL_MONEY_RISK") {
      throw new Error(
        "LIVE_TRADING requires LIVE_TRADING_CONFIRM=I_ACCEPT_REAL_MONEY_RISK",
      );
    }
    if (sourceName !== "live") {
      throw new Error(
        "Refusing LIVE_TRADING unless POLYMARKET_SOURCE=live (auto can fall back to fixture markets)",
      );
    }
    const rawSignatureType = e.SIGNATURE_TYPE?.trim();
    if (!rawSignatureType) {
      throw new Error(
        "LIVE_TRADING requires SIGNATURE_TYPE matching your Polymarket wallet (0=EOA, 1=Proxy, 2=Safe, 3=Deposit Wallet)",
      );
    }
    signatureType = Number(rawSignatureType);
    if (!Number.isInteger(signatureType) || signatureType < 0 || signatureType > 3) {
      throw new Error("SIGNATURE_TYPE must be 0, 1, 2, or 3");
    }
    const walletKey = e.WALLET_PVK?.trim();
    if (!walletKey || !/^(0x)?[0-9a-fA-F]{64}$/.test(walletKey)) {
      throw new Error("LIVE_TRADING requires WALLET_PVK as a 32-byte hex private key (keep it only in .env)");
    }
    const funder = e.POLYMARKET_FUNDER?.trim();
    if (signatureType === 0 && funder) {
      throw new Error("Do not set POLYMARKET_FUNDER for SIGNATURE_TYPE=0 (EOA)");
    }
    if (signatureType !== 0 && !/^0x[0-9a-fA-F]{40}$/.test(funder ?? "")) {
      throw new Error(
        "SIGNATURE_TYPE 1, 2, or 3 requires POLYMARKET_FUNDER to be the matching Polymarket account wallet address",
      );
    }
    liveMaxOrderUsd = num(e.LIVE_MAX_ORDER_USD, 5);
    if (!(liveMaxOrderUsd > 0)) {
      throw new Error("LIVE_MAX_ORDER_USD must be greater than 0");
    }
    betUsd = Math.min(betUsd, liveMaxOrderUsd);
  }
  const pnlPath = resolve(e.PNL_PATH ?? defaultPnLPath());

  const offline = Boolean(opts.stubJudge || opts.fixedSpot);
  let specs = buildSpecs(assetIds, timeframeIds);
  if (specs.length === 0) {
    specs = buildSpecs(DEFAULT_ASSET_IDS, DEFAULT_TIMEFRAME_IDS);
  }
  // Offline smoke runs stay single-market so fixtures don't fan out.
  if (offline) specs = specs.slice(0, 1);
  const enforceStrategy = offline ? false : envEnforce;

  let judge: Judge;
  let spot: SpotSource;

  if (opts.stubJudge || opts.overrides?.judge) {
    if (liveTrading) {
      throw new Error(
        "Refusing LIVE_TRADING with --stub-judge (would trade on fake signals)",
      );
    }
    judge =
      opts.overrides?.judge ??
      stubJudge({
        side: opts.stubSide ?? "UP",
        confidence: opts.stubConfidence ?? 0.91,
      });
  } else {
    const apiKey = e.TYPESAFE_API_KEY?.trim();
    if (!apiKey) {
      throw new Error(
        "TYPESAFE_API_KEY is required (or pass --stub-judge for offline smoke)",
      );
    }
    judge = typeSafeJudge({ apiKey, model: "jev-1.13.0" });
  }

  if (opts.overrides?.spot) {
    spot = opts.overrides.spot;
  } else if (opts.fixedSpot) {
    spot = fixedSpotSource({
      last: 95_200,
      change24hPct: 1.4,
      volume24h: 1.2e9,
    });
  } else {
    spot = binanceSpotSource();
  }

  const polymarket =
    opts.overrides?.polymarket ?? marketFromEnv(e, fixturePath);
  const pen = opts.overrides?.pen ?? logPen();

  let executor: OrderExecutor;
  if (opts.overrides?.executor) {
    executor = opts.overrides.executor;
  } else if (liveTrading) {
    const live = new LiveBroker(liveBrokerOptionsFromEnv(env as NodeJS.ProcessEnv));
    executor = {
      apply: (position, action, market, at) =>
        live.apply(position, action, market, at),
    };
  } else {
    executor = dryExecutor();
  }

  return {
    specs,
    polymarket,
    spot,
    judge,
    pen,
    threshold: opts.overrides?.threshold ?? threshold,
    betUsd: opts.overrides?.betUsd ?? betUsd,
    bankrollUsd: opts.overrides?.bankrollUsd ?? bankrollUsd,
    kellyFraction: opts.overrides?.kellyFraction ?? kellyFraction,
    maxAsk: opts.overrides?.maxAsk ?? maxAsk,
    maxSpread: opts.overrides?.maxSpread ?? maxSpread,
    minEdge: opts.overrides?.minEdge ?? minEdge,
    minSecondsToEnter:
      opts.overrides?.minSecondsToEnter ?? minSecondsToEnter,
    maxEntersPerWindow:
      opts.overrides?.maxEntersPerWindow ?? maxEntersPerWindow,
    requireTrendHeldSec:
      opts.overrides?.requireTrendHeldSec ?? requireTrendHeldSec,
    minVolPct: opts.overrides?.minVolPct ?? minVolPct,
    enforceStrategy: opts.overrides?.enforceStrategy ?? enforceStrategy,
    requireBiasAgreement:
      opts.overrides?.requireBiasAgreement ?? requireBiasAgreement,
    takeProfitPrice: opts.overrides?.takeProfitPrice ?? takeProfitPrice,
    tickMs: opts.overrides?.tickMs ?? tickMs,
    staleAfterMs: opts.overrides?.staleAfterMs ?? staleAfterMs,
    windowLengthSec: opts.overrides?.windowLengthSec ?? 300,
    pnlPath: opts.overrides?.pnlPath ?? pnlPath,
    liveTrading,
    executor,
  };
}
