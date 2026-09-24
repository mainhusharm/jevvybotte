/**
 * Smoke planTrade — ride-to-resolution + EV/time gates.
 * Run: npx tsx scripts/smoke-policy.ts
 */
import assert from "node:assert/strict";
import {
  asIsoTime,
  asTokenId,
  parseConfidence,
  type DomainMarket,
  type Position,
} from "../src/domain.js";
import { planTrade } from "../src/policy.js";

const at = asIsoTime("2026-01-01T00:00:00.000Z");
const market: DomainMarket = {
  eventSlug: "btc-updown-5m-smoke",
  assetId: "btc",
  timeframeId: "5m",
  windowSec: 300,
  question: "smoke",
  conditionId: "0x1",
  endsAt: asIsoTime("2099-01-01T00:00:00.000Z"),
  volume24hUsd: 1,
  closed: false,
  active: true,
  outcomePrices: null,
  bySide: {
    UP: {
      tokenId: asTokenId("up"),
      outcomeLabel: "Up",
      mid: 0.55,
      bestBid: 0.54,
      bestAsk: 0.56,
      spread: 0.02,
      lastTrade: 0.55,
    },
    DOWN: {
      tokenId: asTokenId("down"),
      outcomeLabel: "Down",
      mid: 0.45,
      bestBid: 0.44,
      bestAsk: 0.46,
      spread: 0.02,
      lastTrade: 0.45,
    },
  },
};

const confHi = parseConfidence(0.91)!;
const confLo = parseConfidence(0.4)!;
const confMid = parseConfidence(0.9)!;
const opts = {
  threshold: 0.9,
  betUsd: 5,
  maxAsk: 0.7,
  maxSpread: 0,
  minEdge: 0.1,
  minSecondsToEnter: 90,
  secondsRemaining: 200,
  maxEntersPerWindow: 1,
  entersThisWindow: 0,
};
const flat: Position = { kind: "flat" };
const openUp: Position = {
  kind: "open",
  side: "UP",
  tokenId: asTokenId("up"),
  size: 10,
  entryPrice: 0.56,
  openedAt: at,
  slug: market.eventSlug,
};

{
  const a = planTrade(flat, { side: "UP", confidence: confLo }, market, at, opts);
  assert.equal(a.kind, "ABSTAIN");
  console.log("ok flat+low → ABSTAIN");
}

{
  const a = planTrade(flat, { side: "UP", confidence: confMid }, market, at, opts);
  assert.equal(a.kind, "ABSTAIN");
  console.log("ok flat+0.90 ≤ 0.90 → ABSTAIN");
}

{
  // conf 0.91, ask 0.56 → need 0.66; without probs pWin=conf → ENTER
  const a = planTrade(flat, { side: "UP", confidence: confHi }, market, at, opts);
  assert.equal(a.kind, "ENTER");
  if (a.kind === "ENTER") {
    assert.equal(a.order.marketSlug, market.eventSlug);
    assert.equal(a.order.assetId, "btc");
    assert.equal(a.order.timeframeId, "5m");
    assert.ok(a.why.startsWith("[BTC 5m]"), `why tag missing: ${a.why}`);
  }
  console.log("ok flat+0.91 edge vs 0.56 → ENTER (market-tagged)");
}

{
  const a = planTrade(
    openUp,
    { side: "DOWN", confidence: confLo, probs: { UP: 0.2, DOWN: 0.8 } },
    market,
    at,
    opts,
  );
  assert.equal(a.kind, "HOLD");
  console.log("ok open+low/flip signal → HOLD to resolution");
}

{
  const a = planTrade(
    openUp,
    { side: "DOWN", confidence: confHi, probs: { UP: 0.1, DOWN: 0.9 } },
    market,
    at,
    opts,
  );
  assert.equal(a.kind, "HOLD");
  console.log("ok open+opposite high → HOLD (no SWITCH/SELL)");
}

{
  const a = planTrade(flat, { side: "UP", confidence: confHi }, market, at, {
    ...opts,
    entersThisWindow: 1,
  });
  assert.equal(a.kind, "ABSTAIN");
  if (a.kind === "ABSTAIN") assert.equal(a.reason.code, "MAX_TRADES");
  console.log("ok second enter blocked — one ride per window");
}

{
  const rich: DomainMarket = {
    ...market,
    bySide: {
      ...market.bySide,
      UP: { ...market.bySide.UP, bestAsk: 0.75, mid: 0.75, bestBid: 0.74 },
    },
  };
  const a = planTrade(flat, { side: "UP", confidence: confHi }, rich, at, opts);
  assert.equal(a.kind, "ABSTAIN");
  if (a.kind === "ABSTAIN") assert.equal(a.reason.code, "NO_EDGE");
  console.log("ok ask>0.70 → NO_EDGE");
}

{
  // conf high but probs only barely above ask → no minEdge
  const a = planTrade(
    flat,
    { side: "UP", confidence: confHi, probs: { UP: 0.6, DOWN: 0.4 } },
    market,
    at,
    opts,
  );
  assert.equal(a.kind, "ABSTAIN");
  if (a.kind === "ABSTAIN") {
    assert.equal(a.reason.code, "NO_EDGE");
    if (a.reason.code === "NO_EDGE") assert.ok(a.reason.need > a.reason.ask);
  }
  console.log("ok P=0.60 vs ask 0.56 need 0.66 → NO_EDGE");
}

{
  const a = planTrade(flat, { side: "UP", confidence: confHi }, market, at, {
    ...opts,
    secondsRemaining: 60,
  });
  assert.equal(a.kind, "ABSTAIN");
  if (a.kind === "ABSTAIN") assert.equal(a.reason.code, "TOO_LATE");
  console.log("ok late window → TOO_LATE");
}

{
  // Analyze stage: low-vol regime blocks entry even with high confidence.
  const analysis = {
    assetId: "btc",
    timeframeId: "5m",
    elapsedSec: 120,
    momentumBps: 0,
    windowMoveBps: 0,
    volatilityPct: 0.001,
    trendHeldSec: 0,
    fairUp: 0.5,
    bias: "NEUTRAL" as const,
    biasStrength: 0,
    skip: ["low_vol", "chop", "no_direction"],
    notes: "flat",
  };
  const a = planTrade(flat, { side: "UP", confidence: confHi }, market, at, {
    ...opts,
    analysis,
    enforceStrategy: true,
  });
  assert.equal(a.kind, "ABSTAIN");
  if (a.kind === "ABSTAIN") assert.equal(a.reason.code, "STRATEGY_SKIP");
  console.log("ok strategy low-vol → STRATEGY_SKIP");
}

{
  // Bias conflict blocks a JEV side that fights the momentum read.
  const analysis = {
    assetId: "btc",
    timeframeId: "5m",
    elapsedSec: 120,
    momentumBps: -40,
    windowMoveBps: -50,
    volatilityPct: 0.05,
    trendHeldSec: 120,
    fairUp: 0.25,
    bias: "DOWN" as const,
    biasStrength: 0.5,
    skip: [] as string[],
    notes: "down",
  };
  const a = planTrade(flat, { side: "UP", confidence: confHi }, market, at, {
    ...opts,
    analysis,
    enforceStrategy: true,
    requireBiasAgreement: true,
  });
  assert.equal(a.kind, "ABSTAIN");
  if (a.kind === "ABSTAIN") assert.equal(a.reason.code, "STRATEGY_SKIP");
  console.log("ok bias conflict → STRATEGY_SKIP");
}

{
  // Take-profit flattens an open winner at the target bid.
  const rich: DomainMarket = {
    ...market,
    bySide: {
      ...market.bySide,
      UP: { ...market.bySide.UP, bestBid: 0.92, mid: 0.92, bestAsk: 0.93 },
    },
  };
  const a = planTrade(
    openUp,
    { side: "UP", confidence: confHi, probs: { UP: 0.95, DOWN: 0.05 } },
    rich,
    at,
    { ...opts, takeProfitPrice: 0.9 },
  );
  assert.equal(a.kind, "EXIT");
  if (a.kind === "EXIT") assert.equal(a.reason, "take_profit");
  console.log("ok bid 0.92 ≥ 0.90 → take-profit EXIT");
}

{
  // Fractional Kelly shrinks the stake below the $5 cap on a thin edge.
  const a = planTrade(
    flat,
    { side: "UP", confidence: confHi, probs: { UP: 0.67, DOWN: 0.33 } },
    { ...market, bySide: { ...market.bySide, UP: { ...market.bySide.UP, bestAsk: 0.56, bestBid: 0.55, mid: 0.555 } } },
    at,
    { ...opts, bankrollUsd: 100, kellyFraction: 0.25 },
  );
  assert.equal(a.kind, "ENTER");
  if (a.kind === "ENTER") {
    assert.ok(a.order.size * a.order.price <= 5 + 1e-9);
    console.log(`ok kelly stake → ${a.order.size} shares @ ${a.order.price}`);
  }
}

console.log("smoke-policy: all passed");
