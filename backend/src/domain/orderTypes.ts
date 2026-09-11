import { Side } from "./types.js";
import { PreTradeRule } from "./preTradeCompliance.js";

// The front half of the lifecycle: creation -> pre-trade compliance ->
// release -> fill. A filled order's fill event is the trigger for the
// existing ALLOCATION_CREATED chain (see proRataAllocator.ts and
// api/server.ts's /orders/:id/fill), so one append-only log now covers
// creation, pre-trade compliance, release, fill, and every client-account
// allocation a fill produced.
export type OrderState = "created" | "pretrade_passed" | "rejected" | "released" | "filled";

export type OrderEvent =
  | {
      type: "ORDER_CREATED";
      orderId: string;
      account: string;
      side: Side;
      symbol: string;
      quantity: number;
      referencePrice: number; // used for the pre-trade notional/concentration/cash checks
      occurredAt: string;
    }
  | {
      type: "PRETRADE_CHECK_PASSED";
      orderId: string;
      occurredAt: string;
    }
  | {
      type: "PRETRADE_CHECK_FAILED";
      orderId: string;
      rule: PreTradeRule;
      failingInput: string;
      occurredAt: string;
    }
  | {
      type: "ORDER_RELEASED";
      orderId: string;
      occurredAt: string;
    }
  | {
      type: "ORDER_FILLED";
      orderId: string;
      filledQuantity: number;
      fillPrice: number;
      occurredAt: string;
    };

export type OrderEventType = OrderEvent["type"];

// The materialized shape served by the API. Same discipline as
// domain/types.ts's AllocationView: this is what both the fast live-order
// path (orderLifecycle.ts) and the slow rebuild-from-log oracle
// (store/rebuildOracle.ts's rebuildOrdersFromLog) must agree on, field for
// field.
export interface OrderView {
  orderId: string;
  account: string;
  side: Side;
  symbol: string;
  quantity: number;
  referencePrice: number;
  state: OrderState;
  rejectionRule: PreTradeRule | null;
  rejectionDetail: string | null;
  filledQuantity: number | null;
  fillPrice: number | null;
}
