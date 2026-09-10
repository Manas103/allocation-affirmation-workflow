import { AllocationView } from "./types.js";
import { blockingFieldFor } from "./blockingField.js";

// The cutoff sweep is a pure decision function: given the current view and
// "now", should this allocation be escalated? It does not mutate anything;
// the caller (the store's sweep job) appends a CUTOFF_ESCALATED event when
// this returns true and the allocation is not already escalated.
//
// The rule matches the resume claim directly: anything not yet affirmed by
// its trade-date same-day cutoff is escalated, naming the field that is
// still blocking it. Once an allocation reaches "affirmed" or "instructed"
// it can never be escalated, even if it crosses its cutoff later (there is
// nothing left for it to miss).
export function shouldEscalate(view: AllocationView, nowIso: string): boolean {
  if (view.escalated) return false;
  if (view.state === "affirmed" || view.state === "instructed") return false;
  return nowIso >= view.cutoffIso;
}

export function escalationBlockingField(view: AllocationView) {
  return blockingFieldFor(view);
}
