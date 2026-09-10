import { AllocationView, BlockingField, PRICE_TOLERANCE } from "./types.js";

// Names the single field currently preventing an allocation from advancing.
// This is the function the operations console calls for every at-risk row;
// it is deliberately a pure function of the current view so both the live
// path and the rebuilt-from-log path produce identical answers whenever
// their views agree.
export function blockingFieldFor(view: AllocationView): BlockingField {
  if (view.state === "instructed") {
    return null;
  }
  if (view.state === "affirmed") {
    return "missing settlement instruction";
  }
  if (view.state === "confirmed") {
    return "missing affirmation from custodian";
  }
  // state === "allocated": either no confirmation arrived yet, or one
  // arrived but did not match closely enough to advance the allocation.
  if (view.brokerConfirmedQuantity === null || view.brokerConfirmedPrice === null) {
    return "missing broker confirmation";
  }
  if (view.brokerConfirmedQuantity !== view.quantity) {
    return "quantity mismatch vs client instruction";
  }
  if (Math.abs(view.brokerConfirmedPrice - view.price) > PRICE_TOLERANCE) {
    return "price mismatch vs client instruction beyond tolerance";
  }
  // A matching confirmation arrived but the state has not yet been advanced
  // by the event that carries it (should not happen once the reducer has
  // processed that event; kept as a defined fallback rather than undefined
  // behavior).
  return "missing broker confirmation";
}

export function isAtRisk(view: AllocationView, nowIso: string): boolean {
  if (view.state === "affirmed" || view.state === "instructed") {
    return false;
  }
  return nowIso >= view.cutoffIso || view.escalated;
}
