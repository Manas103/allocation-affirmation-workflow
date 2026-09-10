import { AllocationEvent, AllocationView } from "./types.js";
import { shouldEscalate, escalationBlockingField } from "./cutoff.js";

// Scans a set of live views and produces the CUTOFF_ESCALATED events that
// should be appended right now. This is what a scheduled job would call
// every few minutes in a real deployment; the caller is responsible for both
// appending the returned events to the log and applying them to the live
// projector (server.ts does both in the same request/tick so the two never
// disagree about which allocations have been escalated).
export function computeCutoffEscalations(
  views: AllocationView[],
  nowIso: string
): AllocationEvent[] {
  const events: AllocationEvent[] = [];
  for (const view of views) {
    if (shouldEscalate(view, nowIso)) {
      const blockingField = escalationBlockingField(view);
      if (!blockingField) continue; // defensive: shouldEscalate already excludes terminal-ish states
      events.push({
        type: "CUTOFF_ESCALATED",
        allocationId: view.allocationId,
        blockingField,
        occurredAt: nowIso,
      });
    }
  }
  return events;
}
