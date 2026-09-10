import { AllocationEvent, AllocationView } from "../domain/types.js";
import { applyEvent } from "../domain/stateMachine.js";

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
