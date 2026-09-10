import { describe, it, expect } from "vitest";
import { applyEvent } from "../src/domain/stateMachine.js";
import { blockingFieldFor, isAtRisk } from "../src/domain/blockingField.js";
import { shouldEscalate } from "../src/domain/cutoff.js";
import { computeCutoffEscalations } from "../src/domain/cutoffSweep.js";
import { AllocationEvent, AllocationView } from "../src/domain/types.js";

function created(overrides: Partial<AllocationEvent & { type: "ALLOCATION_CREATED" }> = {}): AllocationEvent {
  return {
    type: "ALLOCATION_CREATED",
    allocationId: "A-1",
    blockTradeId: "BLK-1",
    account: "ACCT-1",
    side: "BUY",
    symbol: "ACME",
    quantity: 100,
    price: 50,
    tradeDate: "2026-09-10",
    cutoffIso: "2026-09-10T21:00:00.000Z",
    occurredAt: "2026-09-10T13:00:00.000Z",
    ...overrides,
  } as AllocationEvent;
}

describe("blockingFieldFor: names the exact field blocking every at-risk allocation", () => {
  it("names a missing broker confirmation", () => {
    const view = applyEvent(undefined, created());
    expect(blockingFieldFor(view)).toBe("missing broker confirmation");
  });

  it("names a quantity mismatch, not a generic 'missing confirmation'", () => {
    let view = applyEvent(undefined, created());
    view = applyEvent(view, {
      type: "BROKER_CONFIRMATION_RECEIVED",
      allocationId: "A-1",
      confirmedQuantity: 99,
      confirmedPrice: 50,
      occurredAt: "2026-09-10T14:00:00.000Z",
    });
    expect(blockingFieldFor(view)).toBe("quantity mismatch vs client instruction");
  });

  it("names a price mismatch beyond tolerance", () => {
    let view = applyEvent(undefined, created());
    view = applyEvent(view, {
      type: "BROKER_CONFIRMATION_RECEIVED",
      allocationId: "A-1",
      confirmedQuantity: 100,
      confirmedPrice: 51,
      occurredAt: "2026-09-10T14:00:00.000Z",
    });
    expect(blockingFieldFor(view)).toBe("price mismatch vs client instruction beyond tolerance");
  });

  it("names a missing custodian affirmation once confirmed", () => {
    let view = applyEvent(undefined, created());
    view = applyEvent(view, {
      type: "BROKER_CONFIRMATION_RECEIVED",
      allocationId: "A-1",
      confirmedQuantity: 100,
      confirmedPrice: 50,
      occurredAt: "2026-09-10T14:00:00.000Z",
    });
    expect(blockingFieldFor(view)).toBe("missing affirmation from custodian");
  });

  it("returns null once instructed: nothing left to block", () => {
    let view = applyEvent(undefined, created());
    view = applyEvent(view, {
      type: "BROKER_CONFIRMATION_RECEIVED",
      allocationId: "A-1",
      confirmedQuantity: 100,
      confirmedPrice: 50,
      occurredAt: "2026-09-10T14:00:00.000Z",
    });
    view = applyEvent(view, { type: "CUSTODIAN_AFFIRMATION_RECEIVED", allocationId: "A-1", occurredAt: "t" });
    view = applyEvent(view, { type: "SETTLEMENT_INSTRUCTION_SENT", allocationId: "A-1", occurredAt: "t" });
    expect(blockingFieldFor(view)).toBeNull();
  });
});

describe("cutoff escalation", () => {
  it("does not escalate before the cutoff", () => {
    const view = applyEvent(undefined, created());
    expect(shouldEscalate(view, "2026-09-10T20:59:59.000Z")).toBe(false);
  });

  it("escalates an unaffirmed allocation once the cutoff passes", () => {
    const view = applyEvent(undefined, created());
    expect(shouldEscalate(view, "2026-09-10T21:00:01.000Z")).toBe(true);
  });

  it("never escalates an already-affirmed allocation, even past its cutoff", () => {
    let view = applyEvent(undefined, created());
    view = applyEvent(view, {
      type: "BROKER_CONFIRMATION_RECEIVED",
      allocationId: "A-1",
      confirmedQuantity: 100,
      confirmedPrice: 50,
      occurredAt: "t",
    });
    view = applyEvent(view, { type: "CUSTODIAN_AFFIRMATION_RECEIVED", allocationId: "A-1", occurredAt: "t" });
    expect(shouldEscalate(view, "2026-09-10T21:00:01.000Z")).toBe(false);
  });

  it("does not re-escalate an allocation already marked escalated", () => {
    let view: AllocationView = applyEvent(undefined, created());
    view = applyEvent(view, {
      type: "CUTOFF_ESCALATED",
      allocationId: "A-1",
      blockingField: "missing broker confirmation",
      occurredAt: "2026-09-10T21:00:01.000Z",
    });
    expect(shouldEscalate(view, "2026-09-10T22:00:00.000Z")).toBe(false);
  });

  it("computeCutoffEscalations names the blocking field on every escalation it raises", () => {
    const view = applyEvent(undefined, created());
    const escalations = computeCutoffEscalations([view], "2026-09-10T21:00:01.000Z");
    expect(escalations).toHaveLength(1);
    expect(escalations[0].type).toBe("CUTOFF_ESCALATED");
    if (escalations[0].type === "CUTOFF_ESCALATED") {
      expect(escalations[0].blockingField).toBe("missing broker confirmation");
    }
  });
});

describe("isAtRisk", () => {
  it("is at risk once past cutoff and not yet affirmed", () => {
    const view = applyEvent(undefined, created());
    expect(isAtRisk(view, "2026-09-10T21:00:01.000Z")).toBe(true);
  });

  it("is not at risk before cutoff", () => {
    const view = applyEvent(undefined, created());
    expect(isAtRisk(view, "2026-09-10T20:00:00.000Z")).toBe(false);
  });
});
