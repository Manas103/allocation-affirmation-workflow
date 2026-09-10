import { AllocationEvent, AllocationView } from "./types.js";
import { PRICE_TOLERANCE } from "./types.js";

// This is the PRODUCTION reducer: the one the live path calls once, per
// event, at write time to keep the served read model current without
// re-reading the whole log. It is intentionally the "fast" path (O(1) per
// event, a bounded 3-step cascade check at most). `rebuildOracle.ts` is a
// second, independently written implementation of the same rules that
// instead replays the entire log from empty state every time it is asked
// (O(events) per allocation) and is used only to check this one.
function isConfirmationMatch(view: AllocationView): boolean {
  return (
    view.brokerConfirmedQuantity !== null &&
    view.brokerConfirmedPrice !== null &&
    view.brokerConfirmedQuantity === view.quantity &&
    Math.abs(view.brokerConfirmedPrice - view.price) <= PRICE_TOLERANCE
  );
}

// Re-derives how far the state machine can advance given the facts recorded
// on `view` so far, cascading through as many gates as now apply in one
// pass. This is what makes the fast path correct under any arrival order:
// a custodian affirmation that arrives before the matching broker
// confirmation is still recorded (custodianAffirmed = true) even though the
// state cannot advance past "allocated" yet; once the confirmation arrives,
// this function walks allocated -> confirmed -> affirmed in the same event.
function advanceAsFarAsPossible(view: AllocationView): AllocationView {
  let state = view.state;
  if (state === "allocated" && isConfirmationMatch(view)) state = "confirmed";
  if (state === "confirmed" && view.custodianAffirmed) state = "affirmed";
  if (state === "affirmed" && view.settlementInstructionSent) state = "instructed";
  return state === view.state ? view : { ...view, state };
}

export function applyEvent(
  prior: AllocationView | undefined,
  event: AllocationEvent
): AllocationView {
  if (event.type === "ALLOCATION_CREATED") {
    if (prior) {
      throw new Error(`duplicate ALLOCATION_CREATED for ${event.allocationId}`);
    }
    return {
      allocationId: event.allocationId,
      blockTradeId: event.blockTradeId,
      account: event.account,
      side: event.side,
      symbol: event.symbol,
      quantity: event.quantity,
      price: event.price,
      tradeDate: event.tradeDate,
      cutoffIso: event.cutoffIso,
      state: "allocated",
      brokerConfirmedQuantity: null,
      brokerConfirmedPrice: null,
      custodianAffirmed: false,
      settlementInstructionSent: false,
      escalated: false,
      escalatedAt: null,
    };
  }

  if (!prior) {
    throw new Error(`event ${event.type} for unknown allocation ${event.allocationId}`);
  }

  switch (event.type) {
    case "BROKER_CONFIRMATION_RECEIVED": {
      return advanceAsFarAsPossible({
        ...prior,
        brokerConfirmedQuantity: event.confirmedQuantity,
        brokerConfirmedPrice: event.confirmedPrice,
      });
    }
    case "CUSTODIAN_AFFIRMATION_RECEIVED": {
      return advanceAsFarAsPossible({ ...prior, custodianAffirmed: true });
    }
    case "SETTLEMENT_INSTRUCTION_SENT": {
      return advanceAsFarAsPossible({ ...prior, settlementInstructionSent: true });
    }
    case "CUTOFF_ESCALATED": {
      return { ...prior, escalated: true, escalatedAt: event.occurredAt };
    }
    default: {
      const _exhaustive: never = event;
      throw new Error(`unhandled event ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export function reduceAll(events: AllocationEvent[]): Map<string, AllocationView> {
  const byAllocation = new Map<string, AllocationView | undefined>();
  for (const event of events) {
    const prior = byAllocation.get(event.allocationId);
    byAllocation.set(event.allocationId, applyEvent(prior, event));
  }
  const result = new Map<string, AllocationView>();
  for (const [id, view] of byAllocation) {
    if (view) result.set(id, view);
  }
  return result;
}
