import { OrderEvent, OrderView } from "./orderTypes.js";

// The FAST reducer for the order half of the lifecycle, structurally the
// same discipline as stateMachine.ts: one event folded into a running view,
// O(1) per event. store/rebuildOracle.ts's rebuildOrdersFromLog is a
// second, independently written implementation of the same rules, used only
// to check this one.
export function applyOrderEvent(prior: OrderView | undefined, event: OrderEvent): OrderView {
  if (event.type === "ORDER_CREATED") {
    if (prior) {
      throw new Error(`duplicate ORDER_CREATED for ${event.orderId}`);
    }
    return {
      orderId: event.orderId,
      account: event.account,
      side: event.side,
      symbol: event.symbol,
      quantity: event.quantity,
      referencePrice: event.referencePrice,
      state: "created",
      rejectionRule: null,
      rejectionDetail: null,
      filledQuantity: null,
      fillPrice: null,
    };
  }

  if (!prior) {
    throw new Error(`event ${event.type} for unknown order ${event.orderId}`);
  }

  switch (event.type) {
    case "PRETRADE_CHECK_PASSED":
      return { ...prior, state: "pretrade_passed" };
    case "PRETRADE_CHECK_FAILED":
      return { ...prior, state: "rejected", rejectionRule: event.rule, rejectionDetail: event.failingInput };
    case "ORDER_RELEASED":
      return { ...prior, state: "released" };
    case "ORDER_FILLED":
      return { ...prior, state: "filled", filledQuantity: event.filledQuantity, fillPrice: event.fillPrice };
    default: {
      const _exhaustive: never = event;
      throw new Error(`unhandled order event ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export function reduceAllOrders(events: OrderEvent[]): Map<string, OrderView> {
  const byOrder = new Map<string, OrderView | undefined>();
  for (const event of events) {
    const prior = byOrder.get(event.orderId);
    byOrder.set(event.orderId, applyOrderEvent(prior, event));
  }
  const result = new Map<string, OrderView>();
  for (const [id, view] of byOrder) {
    if (view) result.set(id, view);
  }
  return result;
}
