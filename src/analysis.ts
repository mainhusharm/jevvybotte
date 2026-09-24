import type { Side, SpotPulse, StrategyAnalysis } from "./domain.js";
import { windowStartSec } from "./assets.js";

export type AnalysisOpts = {
  /** Seconds into the window before entries are allowed. */
  observeSec: number;
  /** Skip windows whose 1m return std-dev is below this percent. */
  minVolPct: number;
  /** Direction must have held this long for a valid setup. */
  requireTrendHeldSec: number;
  /** |momentum| under this (bps) with no held trend reads as chop. */
  chopBps: number;
};

export const DEFAULT_ANALYSIS_OPTS: AnalysisOpts = {
  observeSec: 45,
  minVolPct: 0.02,
  requireTrendHeldSec: 60,
  chopBps: 5,
};

function stdevPct(returnsPct: number[]): number {
  if (returnsPct.length < 2) return 0;
  const mean = returnsPct.reduce((a, b) => a + b, 0) / returnsPct.length;
  const variance =
    returnsPct.reduce((a, b) => a + (b - mean) * (b - mean), 0) /
    (returnsPct.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

/** Consecutive seconds the latest 1m direction has held (60s per bar). */
function trendHeldSec(closes: number[]): number {
  if (closes.length < 2) return 0;
  let held = 0;
  let dir = 0;
  for (let i = closes.length - 1; i > 0; i--) {
    const d = Math.sign(closes[i]! - closes[i - 1]!);
    if (d === 0) break;
    if (dir === 0) dir = d;
    else if (d !== dir) break;
    held += 60;
  }
  return held;
}

function logistic(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Rules-based "analyze" stage. Turns raw spot data into a directional read and
 * a set of skip filters BEFORE anything is sent to JEV.
 *
 * The model is deliberately simple and explainable: a drift (window move +
 * short momentum) divided by realized 1m volatility, squashed through a
 * logistic. JEV still owns the final calibrated probability; this stage only
 * frames the window and filters obvious no-trade regimes.
 */
export function analyzeWindow(args: {
  assetId: string;
  timeframeId: string;
  spot: SpotPulse;
  windowSec: number;
  nowMs: number;
  opts: AnalysisOpts;
}): StrategyAnalysis {
  const { assetId, timeframeId, spot, windowSec, nowMs, opts } = args;
  const startSec = windowStartSec(nowMs, windowSec);
  const elapsedSec = Math.max(0, Math.floor(nowMs / 1000) - startSec);

  const closes = spot.closes1m.filter((c) => Number.isFinite(c) && c > 0);
  const returnsPct: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    if (prev > 0) returnsPct.push(((closes[i]! - prev) / prev) * 100);
  }
  const volatilityPct = stdevPct(returnsPct);

  const last = spot.last > 0 ? spot.last : (closes[closes.length - 1] ?? 0);
  const refOpen =
    spot.windowOpen != null && spot.windowOpen > 0
      ? spot.windowOpen
      : (closes[0] ?? last);
  const windowMoveBps =
    refOpen > 0 ? ((last - refOpen) / refOpen) * 10_000 : 0;

  const back = Math.min(3, Math.max(1, closes.length - 1));
  const momRef = closes.length > back ? closes[closes.length - 1 - back]! : refOpen;
  const momentumBps = momRef > 0 ? ((last - momRef) / momRef) * 10_000 : 0;

  const heldSec = trendHeldSec(closes);

  // Drift vs realized vol → fair P(UP).
  const driftBps = 0.5 * windowMoveBps + 0.5 * momentumBps;
  const stdBps = Math.max(volatilityPct * 100, 0.5);
  const fairUp = Number.isFinite(driftBps)
    ? Math.min(0.98, Math.max(0.02, logistic(driftBps / stdBps)))
    : 0.5;

  const biasStrength = Math.min(1, Math.abs(fairUp - 0.5) * 2);
  const bias: Side | "NEUTRAL" =
    fairUp > 0.52 ? "UP" : fairUp < 0.48 ? "DOWN" : "NEUTRAL";

  const skip: string[] = [];
  if (elapsedSec < opts.observeSec) skip.push("too_early");
  if (volatilityPct < opts.minVolPct) skip.push("low_vol");
  if (heldSec < opts.requireTrendHeldSec && Math.abs(momentumBps) < opts.chopBps) {
    skip.push("chop");
  }
  if (bias === "NEUTRAL") skip.push("no_direction");

  const notes =
    `mom=${momentumBps.toFixed(1)}bps win=${windowMoveBps.toFixed(1)}bps ` +
    `vol=${volatilityPct.toFixed(3)}% held=${heldSec}s fairUP=${fairUp.toFixed(3)}` +
    (skip.length > 0 ? ` skip=${skip.join("+")}` : "");

  return {
    assetId,
    timeframeId,
    elapsedSec,
    momentumBps,
    windowMoveBps,
    volatilityPct,
    trendHeldSec: heldSec,
    fairUp,
    bias,
    biasStrength,
    skip,
    notes,
  };
}

/** Kelly fraction of bankroll for a binary bet at `price` with prob `p`. */
export function kellyStakeUsd(args: {
  pWin: number;
  price: number;
  bankrollUsd: number;
  fraction: number;
}): number {
  const { pWin, price, bankrollUsd, fraction } = args;
  if (!(price > 0 && price < 1) || !(bankrollUsd > 0)) return 0;
  const b = (1 - price) / price; // net odds
  const q = 1 - pWin;
  const full = (b * pWin - q) / b;
  if (!(full > 0)) return 0;
  return Math.max(0, Math.min(bankrollUsd, full * fraction * bankrollUsd));
}
