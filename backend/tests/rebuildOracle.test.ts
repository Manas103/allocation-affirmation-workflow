import { describe, it, expect } from "vitest";
import { generateBulkPopulation } from "../src/seed/syntheticSeed.js";
import { LiveStateProjector } from "../src/store/liveProjector.js";
import { rebuildFromLog, diffAgainstLive } from "../src/store/rebuildOracle.js";

describe("rebuildFromLog vs LiveStateProjector (reference oracle diff)", () => {
  it("agrees with the live projector, field for field, on a mixed-scenario population", () => {
    const { events, allocationIds } = generateBulkPopulation({
      totalAllocations: 3000,
      accountsPerBlock: 37,
      tradeDate: "2026-09-10",
      cutoffIso: "2026-09-10T21:00:00.000Z",
      activityAtIso: "2026-09-10T18:00:00.000Z",
      createdAtIso: "2026-09-10T13:00:00.000Z",
      seed: 42,
    });

    const projector = new LiveStateProjector();
    projector.applyMany(events);

    const rebuilt = rebuildFromLog(events);
    const diff = diffAgainstLive(projector.snapshot(), rebuilt);

    expect(allocationIds.length).toBe(3000);
    expect(diff.totalCompared).toBe(3000);
    expect(diff.matches).toBe(3000);
    expect(diff.mismatches).toHaveLength(0);
  });

  it("catches a real disagreement when one path sees an event the other does not", () => {
    const { events } = generateBulkPopulation({
      totalAllocations: 50,
      accountsPerBlock: 10,
      tradeDate: "2026-09-10",
      cutoffIso: "2026-09-10T21:00:00.000Z",
      activityAtIso: "2026-09-10T18:00:00.000Z",
      createdAtIso: "2026-09-10T13:00:00.000Z",
      seed: 7,
    });

    const projector = new LiveStateProjector();
    projector.applyMany(events);
    const live = projector.snapshot();

    // Drop the last event before rebuilding, simulating a rebuild that ran
    // against a truncated log: the two paths must disagree, proving the
    // diff is not vacuously true.
    const truncated = events.slice(0, -1);
    const rebuilt = rebuildFromLog(truncated);
    const diff = diffAgainstLive(live, rebuilt);

    expect(diff.mismatches.length).toBeGreaterThan(0);
  });
});
