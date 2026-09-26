import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import {
  AssetType,
  Chain,
  ClobClient,
  OrderType,
  Side as ClobSide,
  SignatureTypeV2,
  type OrderResponse,
} from "@polymarket/clob-client-v2";
import type {
  DomainMarket,
  IntendedOrder,
  IsoTime,
  Position,
  TradeAction,
} from "../domain.js";
import { applyDry } from "./dry.js";

export type LiveBrokerOpts = {
  privateKey: string;
  /** Account wallet address for Proxy, Safe, or Deposit Wallet accounts. */
  funderAddress?: string;
  rpcUrl?: string;
  signatureType: number;
  maxOrderUsd: number;
};

export function liveBrokerOptionsFromEnv(env: NodeJS.ProcessEnv): LiveBrokerOpts {
  const privateKey = env.WALLET_PVK?.trim();
  if (!privateKey || !/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("Live trading requires WALLET_PVK as a 32-byte hex private key (keep it only in .env)");
  }
  const signatureType = Number(env.SIGNATURE_TYPE);
  if (!Number.isInteger(signatureType) || signatureType < 0 || signatureType > 3) {
    throw new Error("Live trading requires SIGNATURE_TYPE=0 (EOA), 1 (Proxy), 2 (Safe), or 3 (Deposit Wallet)");
  }
  const funderAddress = env.POLYMARKET_FUNDER?.trim();
  if (signatureType === 0 && funderAddress) {
    throw new Error("Do not set POLYMARKET_FUNDER for SIGNATURE_TYPE=0 (EOA)");
  }
  if (signatureType !== 0 && !/^0x[0-9a-fA-F]{40}$/.test(funderAddress ?? "")) {
    throw new Error("POLYMARKET_FUNDER must be your Polymarket account wallet address for this signature type");
  }
  const maxOrderUsd = Number(env.LIVE_MAX_ORDER_USD ?? "5");
  if (!Number.isFinite(maxOrderUsd) || maxOrderUsd <= 0) {
    throw new Error("LIVE_MAX_ORDER_USD must be a finite value greater than 0");
  }
  return {
    privateKey,
    funderAddress,
    rpcUrl: env.POLYGON_RPC_URL,
    signatureType,
    maxOrderUsd,
  };
}

const MAX_SLIPPAGE_FRACTION = 0.03;
const MIN_PRICE = 0.01;
const MAX_PRICE = 0.99;

function floorCents(amount: number): number {
  return Math.floor((amount + Number.EPSILON) * 100) / 100;
}

/** Unrounded maximum FOK price permitted by the relative slippage protection. */
export function fokPriceCeiling(
  order: IntendedOrder,
  slippageFraction = MAX_SLIPPAGE_FRACTION,
): number {
  if (!Number.isFinite(order.price) || order.price <= 0 || order.price >= 1) {
    throw new Error("Order price must be finite and between 0 and 1");
  }
  if (!Number.isFinite(slippageFraction) || slippageFraction < 0 || slippageFraction > 1) {
    throw new Error("FOK slippage fraction must be between 0 and 1");
  }
  const ceiling = order.side === "BUY"
    ? Math.min(MAX_PRICE, order.price * (1 + slippageFraction))
    : Math.max(MIN_PRICE, order.price * (1 - slippageFraction));
  return Number(ceiling.toFixed(8));
}

/** Tick-aligned FOK limit with at most 3% relative price protection. */
export function fokLimitPrice(
  order: IntendedOrder,
  tickSize: string | number,
  slippageFraction = MAX_SLIPPAGE_FRACTION,
): number {
  const tick = Number(tickSize);
  if (!Number.isFinite(tick) || tick <= 0 || tick > 1) {
    throw new Error(`Invalid CLOB tick size: ${String(tickSize)}`);
  }
  const rawLimit = fokPriceCeiling(order, slippageFraction);
  const tickCount = order.side === "BUY"
    ? Math.floor((rawLimit + Number.EPSILON) / tick)
    : Math.ceil((rawLimit - Number.EPSILON) / tick);
  const limit = Number((tickCount * tick).toFixed(8));
  if (limit < MIN_PRICE || limit > MAX_PRICE) {
    throw new Error(`FOK limit price ${limit} is outside the tradable price range`);
  }
  if (order.side === "BUY" && limit < order.price) {
    throw new Error("FOK tick size cannot represent a BUY limit at or above the quoted ask");
  }
  if (order.side === "SELL" && limit > order.price) {
    throw new Error("FOK tick size cannot represent a SELL limit at or below the quoted bid");
  }
  return limit;
}

/** True when the CLOB response shows an immediate match / fill. */
export function orderFilled(resp: OrderResponse): boolean {
  if (!resp.success) return false;
  const status = String(resp.status ?? "").toLowerCase();
  if (status === "matched" || status === "filled") return true;
  if (resp.tradeIDs != null && resp.tradeIDs.length > 0) return true;
  const taking = Number(resp.takingAmount);
  const making = Number(resp.makingAmount);
  return (
    (Number.isFinite(taking) && taking > 0) ||
    (Number.isFinite(making) && making > 0)
  );
}

/** Rewrite size/price from fill amounts when the API returns them. */
export function withFillAmounts(
  order: IntendedOrder,
  resp: OrderResponse,
): IntendedOrder {
  if (order.side === "BUY") {
    const shares = Number(resp.takingAmount);
    const usd = Number(resp.makingAmount);
    if (shares > 0 && usd > 0) {
      return { ...order, size: shares, price: usd / shares };
    }
  } else {
    const shares = Number(resp.makingAmount);
    const usd = Number(resp.takingAmount);
    if (shares > 0 && usd > 0) {
      return { ...order, size: shares, price: usd / shares };
    }
  }
  return order;
}

export function liveOrderBudgetUsd(order: IntendedOrder): number {
  if (order.side !== "BUY") return 0;
  if (!Number.isFinite(order.size) || order.size <= 0 || !Number.isFinite(order.price) || order.price <= 0) {
    return 0;
  }
  // Polymarket CLOB v2 market BUY `amount` is collateral (USDC), rounded down
  // to cents so floating-point rounding can never cross the configured cap.
  return floorCents(order.size * order.price);
}

export function marketBuyRequest(
  order: IntendedOrder,
  maxOrderUsd: number,
  tickSize: string | number,
): {
  tokenID: string;
  side: typeof ClobSide.BUY;
  amount: number;
  price: number;
  userUSDCBalance: number;
} {
  if (order.side !== "BUY") throw new Error("Market buy request requires a BUY order");
  if (!Number.isFinite(maxOrderUsd) || maxOrderUsd <= 0) {
    throw new Error("LIVE_MAX_ORDER_USD must be a finite value greater than 0");
  }
  const amount = liveOrderBudgetUsd(order);
  if (!(amount > 0) || amount > maxOrderUsd) {
    throw new Error(`Refusing BUY order: estimated notional $${amount.toFixed(2)} exceeds LIVE_MAX_ORDER_USD=$${maxOrderUsd.toFixed(2)} or is invalid`);
  }
  return {
    tokenID: order.tokenId,
    side: ClobSide.BUY,
    amount,
    price: fokLimitPrice(order, tickSize),
    // SDK treats this as the collateral budget available for order+fees, and
    // reduces the USDC order amount if its estimated fees would exceed it.
    userUSDCBalance: maxOrderUsd,
  };
}

function marketAmount(order: IntendedOrder): number {
  if (order.side === "BUY") return liveOrderBudgetUsd(order);
  return order.size;
}

/**
 * Posts FOK market orders via CLOB v2. Position updates only on fill.
 * No unrelated account orders are cancelled by this broker.
 */
export class LiveBroker {
  private clientPromise: Promise<ClobClient> | null = null;
  private readonly opts: LiveBrokerOpts;

  constructor(opts: LiveBrokerOpts) {
    if (!Number.isInteger(opts.signatureType) || opts.signatureType < 0 || opts.signatureType > 3) {
      throw new Error("SIGNATURE_TYPE must be 0, 1, 2, or 3");
    }
    if (!(opts.maxOrderUsd > 0) || !Number.isFinite(opts.maxOrderUsd)) {
      throw new Error("LIVE_MAX_ORDER_USD must be a finite value greater than 0");
    }
    this.opts = opts;
  }

  private async client(): Promise<ClobClient> {
    if (!this.clientPromise) this.clientPromise = this.buildClient();
    return this.clientPromise;
  }

  private async buildClient(): Promise<ClobClient> {
    const pkRaw = this.opts.privateKey.trim();
    const key = (pkRaw.startsWith("0x") ? pkRaw : `0x${pkRaw}`) as `0x${string}`;
    const account = privateKeyToAccount(key);
    const rpc =
      this.opts.rpcUrl ??
      process.env.POLYGON_RPC_URL ??
      "https://polygon-bor-rpc.publicnode.com";
    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(rpc),
    });

    const funder = this.opts.funderAddress?.trim();
    const sig = [
      SignatureTypeV2.EOA,
      SignatureTypeV2.POLY_PROXY,
      SignatureTypeV2.POLY_GNOSIS_SAFE,
      SignatureTypeV2.POLY_1271,
    ][this.opts.signatureType];
    if (sig == null) throw new Error("Invalid Polymarket signature type");
    if (this.opts.signatureType === 0 && funder) {
      throw new Error("Do not set a funder address for an EOA wallet");
    }
    if (
      this.opts.signatureType !== 0 &&
      !/^0x[0-9a-fA-F]{40}$/.test(funder ?? "")
    ) {
      throw new Error("A valid POLYMARKET_FUNDER account wallet is required for this signature type");
    }

    const auth = new ClobClient({
      host: "https://clob.polymarket.com",
      chain: Chain.POLYGON,
      signer: walletClient,
    });
    const creds = await auth.createOrDeriveApiKey();
    const client = new ClobClient({
      host: "https://clob.polymarket.com",
      chain: Chain.POLYGON,
      signer: walletClient,
      creds,
      signatureType: sig,
      funderAddress: funder,
      throwOnError: true,
    });
    await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    return client;
  }

  private async postFok(
    client: ClobClient,
    order: IntendedOrder,
  ): Promise<OrderResponse> {
    const tokenID = order.tokenId;
    const tickSize = await client.getTickSize(tokenID);
    const negRisk = await client.getNegRisk(tokenID);
    const side = order.side === "BUY" ? ClobSide.BUY : ClobSide.SELL;
    const marketOrder = order.side === "BUY"
      ? marketBuyRequest(order, this.opts.maxOrderUsd, tickSize)
      : {
          tokenID,
          side,
          amount: marketAmount(order),
          price: fokLimitPrice(order, tickSize),
        };
    return client.createAndPostMarketOrder(
      marketOrder,
      { tickSize, negRisk },
      OrderType.FOK,
    );
  }

  async placeBuy(
    order: IntendedOrder,
  ): Promise<{ filled: boolean; order: IntendedOrder | null; status: string; orderId: string | null }> {
    if (order.side !== "BUY") throw new Error("MCP live trading only supports BUY orders");
    const usdNotional = liveOrderBudgetUsd(order);
    if (!(usdNotional > 0) || usdNotional > this.opts.maxOrderUsd) {
      throw new Error(
        `Refusing BUY order: estimated notional $${usdNotional.toFixed(2)} exceeds LIVE_MAX_ORDER_USD=$${this.opts.maxOrderUsd.toFixed(2)} or is invalid`,
      );
    }
    const client = await this.client();
    const response = await this.postFok(client, order);
    const filled = orderFilled(response);
    return {
      filled,
      order: filled ? withFillAmounts(order, response) : null,
      status: String(response.status ?? (filled ? "matched" : "no_fill")),
      orderId: response.orderID || null,
    };
  }

  async apply(
    position: Position,
    action: TradeAction,
    market: DomainMarket,
    at: IsoTime,
  ): Promise<{ position: Position; orders: IntendedOrder[]; responses: OrderResponse[] }> {
    const planned = applyDry(position, action, market, at);
    if (planned.orders.length === 0) {
      return { position, orders: [], responses: [] };
    }

    for (const order of planned.orders) {
      // Entry orders add exposure; exits only reduce the position opened by this bot.
      if (order.side !== "BUY") continue;
      const usdNotional = liveOrderBudgetUsd(order);
      if (!(usdNotional > 0) || usdNotional > this.opts.maxOrderUsd) {
        throw new Error(
          `Refusing BUY order: estimated notional $${usdNotional.toFixed(2)} exceeds LIVE_MAX_ORDER_USD=$${this.opts.maxOrderUsd.toFixed(2)} or is invalid`,
        );
      }
    }

    const client = await this.client();
    const responses: OrderResponse[] = [];
    const filled: IntendedOrder[] = [];

    for (const order of planned.orders) {
      try {
        const resp = await this.postFok(client, order);
        responses.push(resp);
        if (orderFilled(resp)) {
          const adj = withFillAmounts(order, resp);
          filled.push(adj);
          console.error(
            `[live] FOK FILL ${adj.side} ${adj.outcome} @${adj.price.toFixed(4)} ×${adj.size} orderID=${resp.orderID} status=${resp.status}`,
          );
        } else {
          console.error(
            `[live] FOK NO FILL ${order.side} ${order.outcome} @${order.price} ×${order.size} status=${resp.status} err=${resp.errorMsg || ""}`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[live] FOK KILLED/FAIL ${order.side} ${order.outcome} @${order.price} ×${order.size}: ${msg}`,
        );
      }
    }

    if (filled.length === 0) {
      return { position, orders: [], responses };
    }

    if (filled.length < planned.orders.length) {
      console.error(
        `[live] partial FOK set (${filled.length}/${planned.orders.length}) — keeping prior position`,
      );
      return { position, orders: [], responses };
    }

    // Rebuild action with fill-adjusted orders so position uses real size/price.
    const filledAction = actionWithFills(action, filled);
    const applied = applyDry(position, filledAction, market, at);
    return { position: applied.position, orders: filled, responses };
  }
}

function actionWithFills(
  action: TradeAction,
  filled: IntendedOrder[],
): TradeAction {
  if (action.kind === "ENTER" && filled[0]) {
    return { ...action, order: filled[0] };
  }
  if (action.kind === "EXIT" && filled[0]) {
    return { ...action, order: filled[0] };
  }
  if (action.kind === "SWITCH" && filled.length >= 2) {
    return { ...action, exit: filled[0]!, enter: filled[1]! };
  }
  return action;
}

export function assertLiveConfigured(liveTrading: boolean, hasKey: boolean): void {
  if (liveTrading && !hasKey) {
    throw new Error("LIVE_TRADING=1 requires WALLET_PVK");
  }
}
