import { AllocationEvent, AllocationView } from "../domain/types.js";
import { applyEvent } from "../domain/stateMachine.js";
import { OrderEvent, OrderView } from "../domain/orderTypes.js";
import { applyOrderEvent } from "../domain/orderLifecycle.js";

// The "fast" production path: an in-memory read model kept current by
// applying each event once, at write time, instead of re-reading the whole
// log to answer a query. This is what the API and the console actually read
// from. The append-only table in Postgres (or pg-mem) underneath it is the
// durable source of truth; this class is a cache of it, and the whole point
// of the rebuild oracle is to prove the cache never drifts from the log.
export class LiveStateProjector {
  private readonly byAllocation = new Map<string, AllocationView>();

  apply(event: AllocationEvent): AllocationView {
    const prior = this.byAllocation.get(event.allocationId);
    const next = applyEvent(prior, event);
    this.byAllocation.set(event.allocationId, next);
    return next;
  }

  applyMany(events: AllocationEvent[]): void {
    for (const event of events) this.apply(event);
  }

  get(allocationId: string): AllocationView | undefined {
    return this.byAllocation.get(allocationId);
  }

  all(): AllocationView[] {
    return Array.from(this.byAllocation.values());
  }

  size(): number {
    return this.byAllocation.size;
  }

  snapshot(): Map<string, AllocationView> {
    return new Map(this.byAllocation);
  }
}

// The same fast, served-read-model discipline as LiveStateProjector above,
// for the order half of the lifecycle: applyOrderEvent folded forward one
// event at a time. store/rebuildOracle.ts's rebuildOrdersFromLog is what
// proves this class never drifts from the log, the same way rebuildFromLog
// proves LiveStateProjector never does.
export class LiveOrderProjector {
  private readonly byOrder = new Map<string, OrderView>();

  apply(event: OrderEvent): OrderView {
    const prior = this.byOrder.get(event.orderId);
    const next = applyOrderEvent(prior, event);
    this.byOrder.set(event.orderId, next);
    return next;
  }

  applyMany(events: OrderEvent[]): void {
    for (const event of events) this.apply(event);
  }

  get(orderId: string): OrderView | undefined {
    return this.byOrder.get(orderId);
  }

  all(): OrderView[] {
    return Array.from(this.byOrder.values());
  }

  size(): number {
    return this.byOrder.size;
  }

  snapshot(): Map<string, OrderView> {
    return new Map(this.byOrder);
  }
}
