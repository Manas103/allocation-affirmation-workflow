import { describe, it, expect } from "vitest";
import { LiveOrderProjector } from "../src/store/liveProjector.js";
import { rebuildOrdersFromLog, diffAgainstLive } from "../src/store/rebuildOracle.js";
import { OrderEvent } from "../src/domain/orderTypes.js";

function buildMixedOrderEvents(): OrderEvent[] {
  const events: OrderEvent[] = [];
  // One clean order, all the way to filled.
  events.push(
    { type: "ORDER_CREATED", orderId: "ORD-A", account: "ACCT-1", side: "BUY", symbol: "ACME", quantity: 100, referencePrice: 10, occurredAt: "t1" },
    { type: "PRETRADE_CHECK_PASSED", orderId: "ORD-A", occurredAt: "t2" },
    { type: "ORDER_RELEASED", orderId: "ORD-A", occurredAt: "t3" },
    { type: "ORDER_FILLED", orderId: "ORD-A", filledQuantity: 100, fillPrice: 10.05, occurredAt: "t4" }
  );
  // One rejected order.
  events.push(
    { type: "ORDER_CREATED", orderId: "ORD-B", account: "ACCT-2", side: "BUY", symbol: "EMBR", quantity: 50, referencePrice: 20, occurredAt: "t1" },
    { type: "PRETRADE_CHECK_FAILED", orderId: "ORD-B", rule: "RESTRICTED_LIST", failingInput: "EMBR", occurredAt: "t2" }
  );
  // One order stuck mid-lifecycle (created only).
  events.push({ type: "ORDER_CREATED", orderId: "ORD-C", account: "ACCT-3", side: "SELL", symbol: "GLOB", quantity: 30, referencePrice: 5, occurredAt: "t1" });
  // One order passed and released but not yet filled.
  events.push(
    { type: "ORDER_CREATED", orderId: "ORD-D", account: "ACCT-4", side: "BUY", symbol: "NOVA", quantity: 75, referencePrice: 15, occurredAt: "t1" },
    { type: "PRETRADE_CHECK_PASSED", orderId: "ORD-D", occurredAt: "t2" },
    { type: "ORDER_RELEASED", orderId: "ORD-D", occurredAt: "t3" }
  );
  return events;
}

describe("rebuildOrdersFromLog vs LiveOrderProjector (reference oracle diff, order half of the lifecycle)", () => {
  it("agrees with the live order projector, field for field, across every order state", () => {
    const events = buildMixedOrderEvents();
    const projector = new LiveOrderProjector();
    projector.applyMany(events);
    const rebuilt = rebuildOrdersFromLog(events);
    const diff = diffAgainstLive(projector.snapshot(), rebuilt);

    expect(diff.totalCompared).toBe(4);
    expect(diff.matches).toBe(4);
    expect(diff.mismatches).toHaveLength(0);
  });

  it("catches a real disagreement when the rebuild ran against a truncated log", () => {
    const events = buildMixedOrderEvents();
    const projector = new LiveOrderProjector();
    projector.applyMany(events);
    const live = projector.snapshot();

    const truncated = events.slice(0, -1); // drop ORD-D's ORDER_RELEASED
    const rebuilt = rebuildOrdersFromLog(truncated);
    const diff = diffAgainstLive(live, rebuilt);

    expect(diff.mismatches.length).toBeGreaterThan(0);
  });
});
