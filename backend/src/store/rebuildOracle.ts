import { AllocationEvent, AllocationState, AllocationView, PRICE_TOLERANCE } from "../domain/types.js";

// The reference oracle. This is a SEPARATE implementation of the same rules
// as domain/stateMachine.ts, written without reusing any of its code, and
// deliberately naive: for every allocation it groups that allocation's whole
// history and rescans it from scratch, rather than folding one event at a
// time into a running object. It is O(events) per allocation instead of
// O(1), and that is the point: it is the thing whose correctness is obvious
// by inspection, not the thing that has to be fast. `diffAgainstLive` below
// is what proves the fast path in stateMachine.ts never drifted from it.
export function rebuildFromLog(events: AllocationEvent[]): Map<string, AllocationView> {
  const byAllocation = new Map<string, AllocationEvent[]>();
  for (const event of events) {
    const existing = byAllocation.get(event.allocationId);
    if (existing) {
      existing.push(event);
    } else {
      byAllocation.set(event.allocationId, [event]);
    }
  }

  const rebuilt = new Map<string, AllocationView>();

  for (const [allocationId, history] of byAllocation) {
    const creation = history.find((e) => e.type === "ALLOCATION_CREATED");
    if (!creation || creation.type !== "ALLOCATION_CREATED") {
      // A history with no creation event is not a real allocation; skip it
      // rather than fabricate one, matching the fast path, which can never
      // produce a view without having first seen ALLOCATION_CREATED.
      continue;
    }

    const confirmationEvents = history.filter((e) => e.type === "BROKER_CONFIRMATION_RECEIVED");
    const lastConfirmation =
      confirmationEvents.length > 0 ? confirmationEvents[confirmationEvents.length - 1] : undefined;
    const brokerConfirmedQuantity =
      lastConfirmation && lastConfirmation.type === "BROKER_CONFIRMATION_RECEIVED"
        ? lastConfirmation.confirmedQuantity
        : null;
    const brokerConfirmedPrice =
      lastConfirmation && lastConfirmation.type === "BROKER_CONFIRMATION_RECEIVED"
        ? lastConfirmation.confirmedPrice
        : null;

    const custodianAffirmed = history.some((e) => e.type === "CUSTODIAN_AFFIRMATION_RECEIVED");
    const settlementInstructionSent = history.some((e) => e.type === "SETTLEMENT_INSTRUCTION_SENT");

    const escalationEvents = history.filter((e) => e.type === "CUTOFF_ESCALATED");
    const escalated = escalationEvents.length > 0;
    const lastEscalation = escalated ? escalationEvents[escalationEvents.length - 1] : undefined;
    const escalatedAt = lastEscalation ? lastEscalation.occurredAt : null;

    const confirmationMatches =
      brokerConfirmedQuantity !== null &&
      brokerConfirmedPrice !== null &&
      brokerConfirmedQuantity === creation.quantity &&
      Math.abs(brokerConfirmedPrice - creation.price) <= PRICE_TOLERANCE;

    let state: AllocationState = "allocated";
    if (confirmationMatches) state = "confirmed";
    if (confirmationMatches && custodianAffirmed) state = "affirmed";
    if (confirmationMatches && custodianAffirmed && settlementInstructionSent) state = "instructed";

    rebuilt.set(allocationId, {
      allocationId,
      blockTradeId: creation.blockTradeId,
      account: creation.account,
      side: creation.side,
      symbol: creation.symbol,
      quantity: creation.quantity,
      price: creation.price,
      tradeDate: creation.tradeDate,
      cutoffIso: creation.cutoffIso,
      state,
      brokerConfirmedQuantity,
      brokerConfirmedPrice,
      custodianAffirmed,
      settlementInstructionSent,
      escalated,
      escalatedAt,
    });
  }

  return rebuilt;
}

export interface RebuildDiffResult {
  totalCompared: number;
  matches: number;
  mismatches: Array<{ allocationId: string; live?: AllocationView; rebuilt?: AllocationView }>;
}

// Field-by-field equality; AllocationView has no nested objects, so a shallow
// compare of every key is an exact compare of the whole record.
function viewsEqual(a: AllocationView, b: AllocationView): boolean {
  const keys = Object.keys(a) as (keyof AllocationView)[];
  return keys.every((key) => a[key] === b[key]);
}

export function diffAgainstLive(
  live: Map<string, AllocationView>,
  rebuilt: Map<string, AllocationView>
): RebuildDiffResult {
  const ids = new Set<string>([...live.keys(), ...rebuilt.keys()]);
  let matches = 0;
  const mismatches: RebuildDiffResult["mismatches"] = [];
  for (const id of ids) {
    const liveView = live.get(id);
    const rebuiltView = rebuilt.get(id);
    if (liveView && rebuiltView && viewsEqual(liveView, rebuiltView)) {
      matches += 1;
    } else {
      mismatches.push({ allocationId: id, live: liveView, rebuilt: rebuiltView });
    }
  }
  return { totalCompared: ids.size, matches, mismatches };
}
