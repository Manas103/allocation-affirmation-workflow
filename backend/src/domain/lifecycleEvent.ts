import { AllocationEvent } from "./types.js";
import { OrderEvent } from "./orderTypes.js";

// The single append-only vocabulary the event log now carries end to end:
// order creation and pre-trade compliance and release and fill
// (OrderEvent), feeding into the existing per-account allocation chain
// (AllocationEvent) that a fill produces. Same table (store/schema.ts), same
// store (store/eventStore.ts), one audit trail from order to allocation.
export type LifecycleEvent = AllocationEvent | OrderEvent;

// Every event, whichever half of the lifecycle it belongs to, carries the id
// of the stream it is a fact about: an order's own events carry orderId, an
// allocation's events (including the ones a fill produces) carry
// allocationId. This is the one place that distinction is bridged, so the
// store layer can append and replay both halves through one table without
// caring which one it is holding.
export function streamIdOf(event: LifecycleEvent): string {
  return "allocationId" in event ? event.allocationId : event.orderId;
}
