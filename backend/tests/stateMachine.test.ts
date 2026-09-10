import { describe, it, expect } from "vitest";
import { applyEvent } from "../src/domain/stateMachine.js";
import { AllocationEvent } from "../src/domain/types.js";

const CREATED: AllocationEvent = {
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
};

describe("applyEvent: allocated -> confirmed -> affirmed -> instructed", () => {
  it("starts a fresh allocation in the allocated state", () => {
    const view = applyEvent(undefined, CREATED);
    expect(view.state).toBe("allocated");
  });

  it("throws on a duplicate ALLOCATION_CREATED (the log is append-only, not append-and-overwrite)", () => {
    const view = applyEvent(undefined, CREATED);
    expect(() => applyEvent(view, CREATED)).toThrow();
  });

  it("advances to confirmed only when broker quantity and price both match within tolerance", () => {
    let view = applyEvent(undefined, CREATED);
    view = applyEvent(view, {
      type: "BROKER_CONFIRMATION_RECEIVED",
      allocationId: "A-1",
      confirmedQuantity: 100,
      confirmedPrice: 50.001,
      occurredAt: "2026-09-10T14:00:00.000Z",
    });
    expect(view.state).toBe("confirmed");
  });

  it("stays allocated on a quantity mismatch even though a confirmation was recorded", () => {
    let view = applyEvent(undefined, CREATED);
    view = applyEvent(view, {
      type: "BROKER_CONFIRMATION_RECEIVED",
      allocationId: "A-1",
      confirmedQuantity: 99,
      confirmedPrice: 50,
      occurredAt: "2026-09-10T14:00:00.000Z",
    });
    expect(view.state).toBe("allocated");
    expect(view.brokerConfirmedQuantity).toBe(99);
  });

  it("cascades allocated -> affirmed in one event when the affirmation arrives before a matching confirmation was ever missing, once confirmation lands", () => {
    let view = applyEvent(undefined, CREATED);
    // Custodian affirmation arrives out of order, before the broker confirmation.
    view = applyEvent(view, {
      type: "CUSTODIAN_AFFIRMATION_RECEIVED",
      allocationId: "A-1",
      occurredAt: "2026-09-10T13:30:00.000Z",
    });
    expect(view.state).toBe("allocated"); // recorded, but cannot advance yet
    expect(view.custodianAffirmed).toBe(true);

    view = applyEvent(view, {
      type: "BROKER_CONFIRMATION_RECEIVED",
      allocationId: "A-1",
      confirmedQuantity: 100,
      confirmedPrice: 50,
      occurredAt: "2026-09-10T14:00:00.000Z",
    });
    // Both facts are now known: the reducer cascades allocated -> confirmed -> affirmed in this one event.
    expect(view.state).toBe("affirmed");
  });

  it("reaches instructed only after all three facts are recorded", () => {
    let view = applyEvent(undefined, CREATED);
    view = applyEvent(view, {
      type: "BROKER_CONFIRMATION_RECEIVED",
      allocationId: "A-1",
      confirmedQuantity: 100,
      confirmedPrice: 50,
      occurredAt: "2026-09-10T14:00:00.000Z",
    });
    view = applyEvent(view, {
      type: "CUSTODIAN_AFFIRMATION_RECEIVED",
      allocationId: "A-1",
      occurredAt: "2026-09-10T15:00:00.000Z",
    });
    view = applyEvent(view, {
      type: "SETTLEMENT_INSTRUCTION_SENT",
      allocationId: "A-1",
      occurredAt: "2026-09-10T16:00:00.000Z",
    });
    expect(view.state).toBe("instructed");
  });

  it("throws on any lifecycle event for an allocation that was never created", () => {
    expect(() =>
      applyEvent(undefined, {
        type: "CUSTODIAN_AFFIRMATION_RECEIVED",
        allocationId: "NEVER-CREATED",
        occurredAt: "2026-09-10T15:00:00.000Z",
      })
    ).toThrow();
  });
});
