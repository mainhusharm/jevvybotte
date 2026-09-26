import assert from "node:assert/strict";
import { asIsoTime, asTokenId, type DomainMarket, type IntendedOrder } from "../src/domain.js";
import { fokLimitPrice, fokPriceCeiling, liveOrderBudgetUsd, marketBuyRequest } from "../src/broker/live.js";
import { executeLiveOrderWithApproval } from "../src/mcp/liveExecution.js";
import { isExplicitLiveOrderApproval, LiveOrderApproval } from "../src/mcp/safety.js";

function market(ask = 0.55): DomainMarket {
  return {
    eventSlug: "btc-updown-5m-1900000000",
    assetId: "btc",
    timeframeId: "5m",
    windowSec: 300,
    question: "Bitcoin Up or Down?",
    conditionId: "condition-id",
    endsAt: asIsoTime(new Date(Date.now() + 120_000).toISOString()),
    volume24hUsd: 1000,
    closed: false,
    active: true,
    outcomePrices: { UP: 0.5, DOWN: 0.5 },
    bySide: {
      UP: {
        tokenId: asTokenId("up-token"),
        outcomeLabel: "Up",
        mid: ask - 0.01,
        bestBid: ask - 0.02,
        bestAsk: ask,
        spread: 0.02,
        lastTrade: ask - 0.01,
      },
      DOWN: {
        tokenId: asTokenId("down-token"),
        outcomeLabel: "Down",
        mid: 0.5,
        bestBid: 0.49,
        bestAsk: 0.51,
        spread: 0.02,
        lastTrade: 0.5,
      },
    },
  };
}

function order(price = 0.55, size = 8.92, side: "BUY" | "SELL" = "BUY"): IntendedOrder {
  return {
    side,
    tokenId: asTokenId("up-token"),
    outcome: "UP",
    price,
    size,
    at: asIsoTime(new Date().toISOString()),
    idempotencyKey: "smoke-order",
    rationale: "smoke test only",
  };
}

assert.equal(isExplicitLiveOrderApproval("accept", true), true);
assert.equal(isExplicitLiveOrderApproval("accept", false), false);
assert.equal(isExplicitLiveOrderApproval("accept", "true"), false);
assert.equal(isExplicitLiveOrderApproval("decline", true), false);
assert.equal(isExplicitLiveOrderApproval("cancel", true), false);

const latch = new LiveOrderApproval();
assert.equal(latch.consume(false), false, "declined approval must not pass the gate");
assert.equal(latch.consume(true), true, "explicit approval should pass once");
assert.equal(latch.consume(true), false, "approval must be single-use");

const makeOrder = (current: DomainMarket, outcome: "UP" | "DOWN"): IntendedOrder => ({
  ...order(current.bySide[outcome].bestAsk ?? 0.55),
  tokenId: current.bySide[outcome].tokenId,
});

let approvals = 0;
let submissions = 0;
await assert.rejects(
  executeLiveOrderWithApproval({
    previewExpiresAt: Date.now() + 60_000,
    marketSlug: "btc-updown-5m-1900000000",
    outcome: "UP",
    amountUsd: 5,
    supportsFormElicitation: false,
    loadMarket: async () => market(),
    makeOrder: makeOrder,
    requestApproval: async () => {
      approvals++;
      return { action: "accept", approve: true };
    },
    submit: async () => {
      submissions++;
      return "submitted";
    },
  }),
  /does not advertise form elicitation/,
);
assert.equal(approvals, 0, "unsupported clients must never be prompted or submit");
assert.equal(submissions, 0, "unsupported clients must never reach the broker");

await assert.rejects(
  executeLiveOrderWithApproval({
    previewExpiresAt: Date.now() + 60_000,
    marketSlug: "btc-updown-5m-1900000000",
    outcome: "UP",
    amountUsd: 5,
    supportsFormElicitation: true,
    loadMarket: async () => market(),
    makeOrder,
    requestApproval: async () => ({ action: "decline", approve: true }),
    submit: async () => {
      submissions++;
      return "submitted";
    },
  }),
  /declined or not explicitly approved/,
);
assert.equal(submissions, 0, "declined elicitation must never reach the broker");

let quoteLoads = 0;
const successfulResult = await executeLiveOrderWithApproval({
  previewExpiresAt: Date.now() + 60_000,
  marketSlug: "btc-updown-5m-1900000000",
  outcome: "UP",
  amountUsd: 5,
  supportsFormElicitation: true,
  loadMarket: async () => {
    quoteLoads++;
    return market();
  },
  makeOrder,
  requestApproval: async (_freshMarket, approvedOrder) => {
    assert.equal(approvedOrder.price, 0.55);
    return { action: "accept", approve: true };
  },
  submit: async (submittedOrder) => {
    submissions++;
    assert.equal(submittedOrder.price, 0.55);
    return "submitted";
  },
});
assert.equal(successfulResult, "submitted");
assert.equal(quoteLoads, 2, "must refresh and compare the quote after approval");
assert.equal(submissions, 1, "an explicitly approved unchanged order may submit exactly once");

let driftLoads = 0;
await assert.rejects(
  executeLiveOrderWithApproval({
    previewExpiresAt: Date.now() + 60_000,
    marketSlug: "btc-updown-5m-1900000000",
    outcome: "UP",
    amountUsd: 5,
    supportsFormElicitation: true,
    loadMarket: async () => market(++driftLoads === 1 ? 0.55 : 0.56),
    makeOrder,
    requestApproval: async () => ({ action: "accept", approve: true }),
    submit: async () => {
      submissions++;
      return "submitted";
    },
  }),
  /quote changed during human approval/,
);
assert.equal(submissions, 1, "quote drift after approval must never reach the broker");

let now = 10;
await assert.rejects(
  executeLiveOrderWithApproval({
    previewExpiresAt: 20,
    marketSlug: "btc-updown-5m-1900000000",
    outcome: "UP",
    amountUsd: 5,
    supportsFormElicitation: true,
    loadMarket: async () => market(),
    makeOrder,
    requestApproval: async () => {
      now = 21;
      return { action: "accept", approve: true };
    },
    submit: async () => {
      submissions++;
      return "submitted";
    },
    now: () => now,
  }),
  /expired while awaiting human approval/,
);
assert.equal(submissions, 1, "expired previews must never reach the broker");

assert.equal(fokLimitPrice(order(0.55), "0.005"), 0.565, "BUY protection is tick-aligned and never exceeds 3%");
assert.equal(fokLimitPrice(order(0.55, 8.92, "SELL"), "0.005"), 0.535, "SELL protection is tick-aligned and never exceeds 3%");
assert.equal(fokLimitPrice(order(0.55), "0.01"), 0.56, "coarse ticks round BUY protection inward");
assert.equal(fokPriceCeiling(order(0.55)), 0.5665, "elicitation displays the unrounded maximum price");
assert.equal(fokPriceCeiling(order(0.7)), 0.721, "ceiling arithmetic is stable across binary floating-point values");
assert.throws(() => fokLimitPrice(order(0.55), "0.1"), /cannot represent a BUY limit/);
assert.throws(() => fokLimitPrice(order(0.55), "0"), /Invalid CLOB tick size/);
assert.equal(liveOrderBudgetUsd(order(0.56, 8.92)), 4.99, "BUY collateral is rounded down to cents under its cap");
assert.equal(liveOrderBudgetUsd(order(0.55, Number.NaN)), 0, "invalid size cannot pass the live budget check");
assert.deepEqual(
  marketBuyRequest(order(0.55, 8.92), 5, "0.005"),
  {
    tokenID: "up-token",
    side: "BUY",
    amount: 4.9,
    price: 0.565,
    userUSDCBalance: 5,
  },
  "market BUY must pass USDC budget and fee ceiling independently from share target",
);
assert.throws(() => marketBuyRequest(order(0.55, 20), 5, "0.01"), /exceeds LIVE_MAX_ORDER_USD/);
assert.throws(() => marketBuyRequest(order(0.55, 8.92, "SELL"), 5, "0.01"), /requires a BUY order/);

console.log("smoke:mcp-safety: elicitation denial, capability gate, expiry, quote drift, one-use approval, tick rounding, and budget checks passed");
