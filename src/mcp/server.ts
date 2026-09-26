import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { liveMarketBySlug } from "../adapters/polymarket/live.js";
import { effectiveEndsAt, fetchJson } from "../adapters/polymarket/wire.js";
import { loadDotEnv } from "../loadEnv.js";
import { asIsoTime, type DomainMarket, type IntendedOrder, type Side } from "../domain.js";
import { fokPriceCeiling, liveOrderBudgetUsd, LiveBroker, liveBrokerOptionsFromEnv } from "../broker/live.js";
import { buildIdempotencyKey, sizeSharesForUsd } from "../policy.js";
import { executeLiveOrderWithApproval } from "./liveExecution.js";

type SearchMarket = {
  slug?: string;
  question?: string;
  title?: string;
  conditionId?: string;
  clobTokenIds?: string | string[];
  outcomes?: string | string[];
};

type SearchEvent = {
  slug?: string;
  title?: string;
  markets?: SearchMarket[];
};

type SearchResponse = {
  events?: SearchEvent[];
  markets?: SearchMarket[];
};

type Preview = {
  id: string;
  expiresAt: number;
  marketSlug: string;
  amountUsd: number;
  order: IntendedOrder;
  executionMode: "paper" | "live";
};

const POLYMARKET_FUNDER = /^0x[0-9a-fA-F]{40}$/;
const pendingPreviews = new Map<string, Preview>();
const paperOrders: Array<{ order: IntendedOrder; recordedAt: string }> = [];

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function liveEnabled(): boolean {
  return process.env.LIVE_TRADING === "1" || process.env.LIVE_TRADING === "true";
}

function orderCapUsd(): number {
  const value = Number(process.env.LIVE_MAX_ORDER_USD ?? "5");
  return Number.isFinite(value) && value > 0 ? value : 5;
}

function compactMarket(market: DomainMarket) {
  return {
    slug: market.eventSlug,
    question: market.question,
    conditionId: market.conditionId,
    active: market.active,
    closed: market.closed,
    endsAt: market.endsAt,
    volume24hUsd: market.volume24hUsd,
    outcomes: {
      UP: {
        tokenId: market.bySide.UP.tokenId,
        label: market.bySide.UP.outcomeLabel,
        bestBid: market.bySide.UP.bestBid,
        bestAsk: market.bySide.UP.bestAsk,
        mid: market.bySide.UP.mid,
      },
      DOWN: {
        tokenId: market.bySide.DOWN.tokenId,
        label: market.bySide.DOWN.outcomeLabel,
        bestBid: market.bySide.DOWN.bestBid,
        bestAsk: market.bySide.DOWN.bestAsk,
        mid: market.bySide.DOWN.mid,
      },
    },
    url: `https://polymarket.com/event/${market.eventSlug}`,
  };
}

async function getMarket(slug: string, forOrder = false): Promise<DomainMarket> {
  const sample = await liveMarketBySlug(slug);
  if (sample.source !== "live") {
    throw new Error("Live Polymarket market data is required; paper fixtures are not accepted here");
  }
  if (forOrder && (!sample.value.active || sample.value.closed)) {
    throw new Error("Market is not active; refusing to preview/place an order");
  }
  if (forOrder) {
    const endsAt = effectiveEndsAt(sample.value);
    const endsAtMs = endsAt == null ? Number.NaN : Date.parse(endsAt);
    if (!Number.isFinite(endsAtMs) || endsAtMs <= Date.now()) {
      throw new Error("Market window has ended or its end time is unknown; refusing to preview/place an order");
    }
  }
  return sample.value;
}

function positionWallet(user?: string): string {
  if (user) {
    if (!POLYMARKET_FUNDER.test(user)) throw new Error("user must be a 0x-prefixed 20-byte wallet address");
    return user;
  }

  const configuredFunder = process.env.POLYMARKET_FUNDER?.trim();
  if (configuredFunder && POLYMARKET_FUNDER.test(configuredFunder)) {
    return configuredFunder;
  }
  const privateKey = process.env.WALLET_PVK?.trim();
  if (privateKey && /^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) {
    if (Number(process.env.SIGNATURE_TYPE ?? "0") !== 0) {
      throw new Error("Set POLYMARKET_FUNDER or pass user for a Proxy, Safe, or Deposit Wallet account");
    }
    const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    return privateKeyToAccount(key as `0x${string}`).address;
  }
  throw new Error("Pass the Polymarket account wallet address as user (or configure POLYMARKET_FUNDER)");
}

function createBuyOrder(market: DomainMarket, side: Side, amountUsd: number): IntendedOrder {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error("amountUsd must be greater than 0");
  if (amountUsd > orderCapUsd()) {
    throw new Error(`amountUsd exceeds the configured per-order cap of $${orderCapUsd().toFixed(2)}`);
  }
  const quote = market.bySide[side];
  const price = quote.bestAsk;
  if (price == null || !Number.isFinite(price) || price <= 0 || price >= 1) {
    throw new Error(`No valid best ask is available for ${side}; refusing a market order`);
  }
  const size = sizeSharesForUsd(amountUsd, price);
  if (size <= 0) throw new Error("Requested amount is too small to buy any shares at the current ask");
  const at = asIsoTime(new Date().toISOString());
  const rationale = `MCP order requested: BUY ${side} for up to $${amountUsd.toFixed(2)}`;
  return {
    side: "BUY",
    tokenId: quote.tokenId,
    outcome: side,
    price,
    size,
    at,
    idempotencyKey: buildIdempotencyKey({ side: "BUY", tokenId: quote.tokenId, outcome: side, size, price }),
    rationale,
    marketSlug: market.eventSlug,
    assetId: market.assetId ?? undefined,
    timeframeId: market.timeframeId ?? undefined,
  };
}

async function main(): Promise<void> {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  loadDotEnv(projectRoot);
  if (liveEnabled()) {
    if (process.env.LIVE_TRADING_CONFIRM !== "I_ACCEPT_REAL_MONEY_RISK") {
      throw new Error("LIVE_TRADING requires LIVE_TRADING_CONFIRM=I_ACCEPT_REAL_MONEY_RISK");
    }
    if (process.env.POLYMARKET_SOURCE?.toLowerCase() !== "live") {
      throw new Error("MCP live trading requires POLYMARKET_SOURCE=live (no fixture fallback)");
    }
    liveBrokerOptionsFromEnv(process.env);
  }
  const server = new McpServer(
    { name: "polymarket-paper-trader", version: "1.0.0" },
    {
      instructions:
        "Polymarket market tools. Trading is paper-only unless the local operator explicitly configures LIVE_TRADING and confirms each real order through a client-side MCP elicitation form. Always inspect markets and preview first. Never request or reveal wallet secrets.",
    },
  );

  server.registerTool(
    "search_markets",
    {
      description: "Search public Polymarket events and markets. Read-only; no wallet credentials are needed.",
      inputSchema: {
        query: z.string().trim().min(2).max(120).describe("Search words or market topic"),
        limit: z.number().int().min(1).max(10).default(5).describe("Maximum number of results"),
      },
    },
    async ({ query, limit }) => {
      const data = (await fetchJson(
        `https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(query)}`,
      )) as SearchResponse;
      const eventResults = (data.events ?? []).slice(0, limit).map((event) => ({
        title: event.title ?? null,
        slug: event.slug ?? null,
        markets: (event.markets ?? []).slice(0, 5).map((market) => ({
          title: market.question ?? market.title ?? null,
          slug: market.slug ?? null,
          conditionId: market.conditionId ?? null,
        })),
      }));
      const marketResults = (data.markets ?? []).slice(0, limit).map((market) => ({
        title: market.question ?? market.title ?? null,
        slug: market.slug ?? null,
        conditionId: market.conditionId ?? null,
      }));
      return result({ query, events: eventResults, markets: marketResults });
    },
  );

  server.registerTool(
    "get_market",
    {
      description: "Get live quotes, token IDs, status, and event URL for one market slug. Read-only.",
      inputSchema: { slug: z.string().trim().min(3).max(180).describe("Polymarket market/event slug") },
    },
    async ({ slug }) => result(compactMarket(await getMarket(slug))),
  );

  server.registerTool(
    "get_positions",
    {
      description: "Read a Polymarket account's current positions using the public Data API; this tool cannot trade.",
      inputSchema: {
        user: z.string().optional().describe("Account wallet address; defaults to configured funder or the EOA signer address"),
        limit: z.number().int().min(1).max(100).default(25),
      },
    },
    async ({ user, limit }) => {
      const wallet = positionWallet(user);
      const positions = await fetchJson(
        `https://data-api.polymarket.com/v2/positions?user=${encodeURIComponent(wallet)}&limit=${limit}`,
      );
      return result({ wallet, positions });
    },
  );

  server.registerTool(
    "preview_order",
    {
      description: "Prepare a capped BUY order preview without submitting it. The preview expires after 60 seconds and can be used once with place_order.",
      inputSchema: {
        slug: z.string().trim().min(3).max(180),
        side: z.enum(["UP", "DOWN"]),
        amountUsd: z.number().positive().max(1000).describe("Maximum USD notional requested; local per-order cap still applies"),
      },
    },
    async ({ slug, side, amountUsd }) => {
      const market = await getMarket(slug, true);
      const order = createBuyOrder(market, side, amountUsd);
      const preview: Preview = {
        id: randomUUID(),
        expiresAt: Date.now() + 60_000,
        marketSlug: market.eventSlug,
        amountUsd,
        order,
        executionMode: "paper",
      };
      pendingPreviews.set(preview.id, preview);
      while (pendingPreviews.size > 20) {
        const oldest = pendingPreviews.keys().next().value;
        if (oldest == null) break;
        pendingPreviews.delete(oldest);
      }
      const { id, expiresAt } = preview;
      return result({
        previewId: id,
        expiresAt: new Date(expiresAt).toISOString(),
        executionMode: "paper",
        submitted: false,
        market: compactMarket(market),
        order: { side: order.side, outcome: order.outcome, amountUsd, shares: order.size, quotedAsk: order.price },
        warning: "Paper preview only; no real order has been sent.",
      });
    },
  );

  server.registerTool(
    "place_order",
    {
      description: "Consume a preview once. Defaults to a paper order recorded in memory. Live mode sends a BUY FOK order only after local live flags are armed and a human explicitly approves the exact order in a client-side MCP elicitation form. Clients without elicitation support are blocked.",
      inputSchema: {
        previewId: z.string().uuid().describe("ID returned by preview_order; expires after one minute and is single-use"),
        mode: z.enum(["paper", "live"]).default("paper").describe("Execution mode; defaults to paper even if live capability is configured"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ previewId, mode }) => {
      const preview = pendingPreviews.get(previewId);
      if (!preview) throw new Error("Unknown or already-used preview; call preview_order again");
      pendingPreviews.delete(previewId);
      if (preview.expiresAt < Date.now()) throw new Error("Order preview expired; call preview_order again");
      if (mode === "live") {
        if (!liveEnabled()) {
          throw new Error("Live trading is disabled; LIVE_TRADING must be enabled locally. Previewing and paper mode remain available.");
        }
        if (process.env.LIVE_TRADING_CONFIRM !== "I_ACCEPT_REAL_MONEY_RISK") {
          throw new Error("Live trading is not armed: configure LIVE_TRADING_CONFIRM locally first");
        }
        if (process.env.POLYMARKET_SOURCE?.toLowerCase() !== "live") {
          throw new Error("Live orders require POLYMARKET_SOURCE=live");
        }
        const options = liveBrokerOptionsFromEnv(process.env);
        const broker = new LiveBroker(options);
        const fill = await executeLiveOrderWithApproval({
          previewExpiresAt: preview.expiresAt,
          marketSlug: preview.marketSlug,
          outcome: preview.order.outcome,
          amountUsd: preview.amountUsd,
          supportsFormElicitation: Boolean(server.server.getClientCapabilities()?.elicitation?.form),
          loadMarket: (slug) => getMarket(slug, true),
          makeOrder: createBuyOrder,
          requestApproval: async (freshMarket, order) => {
            const orderBudgetUsd = liveOrderBudgetUsd(order);
            const protectedPrice = fokPriceCeiling(order);
            const approval = await server.server.elicitInput({
              mode: "form",
              message: [
                "Approve this exact REAL-MONEY Polymarket order?",
                `Market: ${freshMarket.question} (${freshMarket.eventSlug})`,
                `Action: BUY ${order.outcome}; target ${order.size} shares at current ask $${order.price.toFixed(4)}`,
                `Requested collateral budget: $${orderBudgetUsd.toFixed(2)}; configured order-plus-fee ceiling: $${orderCapUsd().toFixed(2)}. SDK may reduce the order amount to reserve estimated fees within that ceiling.`,
                `Execution: Fill-or-kill (FOK). Maximum protected price is $${protectedPrice.toFixed(4)} before inward tick rounding; at a worse fill price the same USDC budget buys fewer shares. This may spend real funds. Decline to cancel.`,
              ].join("\n"),
              requestedSchema: {
                type: "object",
                properties: {
                  approve: {
                    type: "boolean",
                    title: "Approve this real-money order",
                    description: "Select true only if you personally reviewed and approve the exact order shown above.",
                    default: false,
                  },
                },
                required: ["approve"],
              },
            });
            return {
              action: approval.action,
              approve: approval.content?.approve,
            };
          },
          submit: (order) => broker.placeBuy(order),
        });
        return result({
          executionMode: "live",
          submitted: fill.filled,
          order: fill.order,
          status: fill.status,
          orderId: fill.orderId,
          message: fill.filled ? "FOK order filled." : "No fill; FOK order was cancelled by the CLOB.",
        });
      }

      const paperRecord = { order: preview.order, recordedAt: new Date().toISOString() };
      paperOrders.push(paperRecord);
      if (paperOrders.length > 100) paperOrders.shift();
      return result({
        executionMode: "paper",
        submitted: false,
        recorded: true,
        order: preview.order,
        message: "Paper order recorded in this MCP server process only; no real order was sent.",
      });
    },
  );

  server.registerTool(
    "get_paper_orders",
    {
      description: "List recent paper order intents recorded by this MCP server process. This is not an exchange position ledger.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(20) },
    },
    async ({ limit }) => result({ orders: paperOrders.slice(-limit) }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Polymarket MCP server connected over stdio. Order execution defaults to paper mode.");
  if (liveEnabled()) {
    console.error("LIVE TRADING ENABLED: real orders are possible. Every live order requires explicit approval through the MCP client's elicitation form.");
  }
}

main().catch((error: unknown) => {
  console.error("Polymarket MCP server failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
