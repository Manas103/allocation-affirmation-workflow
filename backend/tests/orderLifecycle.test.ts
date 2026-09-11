import { describe, it, expect } from "vitest";
import { applyOrderEvent } from "../src/domain/orderLifecycle.js";
import { OrderEvent } from "../src/domain/orderTypes.js";

const CREATED: OrderEvent = {
  type: "ORDER_CREATED",
  orderId: "ORD-1",
  account: "ACCT-1",
  side: "BUY",
  symbol: "ACME",
  quantity: 1000,
  referencePrice: 25,
  occurredAt: "2026-09-10T13:00:00.000Z",
};

describe("applyOrderEvent: created -> pretrade -> released -> filled", () => {
  it("starts a fresh order in the created state", () => {
    const view = applyOrderEvent(undefined, CREATED);
    expect(view.state).toBe("created");
    expect(view.rejectionRule).toBeNull();
    expect(view.filledQuantity).toBeNull();
  });

  it("throws on a duplicate ORDER_CREATED (the log is append-only, not append-and-overwrite)", () => {
    const view = applyOrderEvent(undefined, CREATED);
    expect(() => applyOrderEvent(view, CREATED)).toThrow();
  });

  it("throws on any event for an order that was never created", () => {
    expect(() =>
      applyOrderEvent(undefined, { type: "ORDER_RELEASED", orderId: "NEVER", occurredAt: "t" })
    ).toThrow();
  });

  it("advances to pretrade_passed", () => {
    let view = applyOrderEvent(undefined, CREATED);
    view = applyOrderEvent(view, { type: "PRETRADE_CHECK_PASSED", orderId: "ORD-1", occurredAt: "t" });
    expect(view.state).toBe("pretrade_passed");
  });

  it("names the rule and the failing input on a pretrade rejection", () => {
    let view = applyOrderEvent(undefined, CREATED);
    view = applyOrderEvent(view, {
      type: "PRETRADE_CHECK_FAILED",
      orderId: "ORD-1",
      rule: "CASH_SUFFICIENCY",
      failingInput: "shortfall of $500.00",
      occurredAt: "t",
    });
    expect(view.state).toBe("rejected");
    expect(view.rejectionRule).toBe("CASH_SUFFICIENCY");
    expect(view.rejectionDetail).toBe("shortfall of $500.00");
  });

  it("reaches released then filled, recording the filled quantity and fill price", () => {
    let view = applyOrderEvent(undefined, CREATED);
    view = applyOrderEvent(view, { type: "PRETRADE_CHECK_PASSED", orderId: "ORD-1", occurredAt: "t" });
    view = applyOrderEvent(view, { type: "ORDER_RELEASED", orderId: "ORD-1", occurredAt: "t" });
    view = applyOrderEvent(view, {
      type: "ORDER_FILLED",
      orderId: "ORD-1",
      filledQuantity: 1000,
      fillPrice: 25.02,
      occurredAt: "t",
    });
    expect(view.state).toBe("filled");
    expect(view.filledQuantity).toBe(1000);
    expect(view.fillPrice).toBe(25.02);
  });
});
