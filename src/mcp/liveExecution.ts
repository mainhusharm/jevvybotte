import type { DomainMarket, IntendedOrder, Side } from "../domain.js";
import { isExplicitLiveOrderApproval, LiveOrderApproval } from "./safety.js";

export type LiveOrderElicitationResult = {
  action: string;
  approve: unknown;
};

export async function executeLiveOrderWithApproval<T>(args: {
  previewExpiresAt: number;
  marketSlug: string;
  outcome: Side;
  amountUsd: number;
  supportsFormElicitation: boolean;
  loadMarket: (slug: string) => Promise<DomainMarket>;
  makeOrder: (market: DomainMarket, outcome: Side, amountUsd: number) => IntendedOrder;
  requestApproval: (
    market: DomainMarket,
    order: IntendedOrder,
  ) => Promise<LiveOrderElicitationResult>;
  submit: (order: IntendedOrder) => Promise<T>;
  now?: () => number;
}): Promise<T> {
  const now = args.now ?? Date.now;
  if (args.previewExpiresAt < now()) {
    throw new Error("Order preview expired; call preview_order again");
  }
  if (!args.supportsFormElicitation) {
    throw new Error(
      "Live order blocked: this MCP client does not advertise form elicitation support; no tool-argument fallback is allowed",
    );
  }

  const market = await args.loadMarket(args.marketSlug);
  const order = args.makeOrder(market, args.outcome, args.amountUsd);
  const approvalLatch = new LiveOrderApproval();
  const elicitation = await args.requestApproval(market, order);
  const humanApproved = isExplicitLiveOrderApproval(
    elicitation.action,
    elicitation.approve,
  );
  if (!humanApproved) {
    throw new Error(
      "Live order declined or not explicitly approved by the human in the MCP elicitation form",
    );
  }
  if (args.previewExpiresAt < now()) {
    throw new Error(
      "Order preview expired while awaiting human approval; call preview_order again",
    );
  }

  const confirmedMarket = await args.loadMarket(args.marketSlug);
  const confirmedOrder = args.makeOrder(
    confirmedMarket,
    args.outcome,
    args.amountUsd,
  );
  if (
    confirmedOrder.tokenId !== order.tokenId ||
    confirmedOrder.price !== order.price ||
    confirmedOrder.size !== order.size
  ) {
    throw new Error(
      "Market quote changed during human approval; no order was sent. Create a new preview and approve the updated order",
    );
  }
  if (args.previewExpiresAt < now()) {
    throw new Error(
      "Order preview expired during the final market check; no order was sent. Call preview_order again",
    );
  }

  if (!approvalLatch.consume(humanApproved)) {
    throw new Error("Live order approval was already used or is invalid");
  }
  return args.submit(order);
}
