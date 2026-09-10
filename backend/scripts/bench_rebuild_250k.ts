// Claim under test: "status rebuilt from the append-only event log alone
// matched live state on all 250,000 allocations". Generates 250,000
// synthetic allocations across many block trades and lifecycle scenarios
// (a realistic mostly-clean mix, per generateBulkPopulation's default
// weights), applies every event to the fast LiveStateProjector exactly as
// the API does, then independently rebuilds the same population from the
// raw event log alone via rebuildFromLog (store/rebuildOracle.ts, a
// separately written O(events)-per-allocation implementation) and diffs
// the two field by field.
import { generateBulkPopulation } from "../src/seed/syntheticSeed.js";
import { LiveStateProjector } from "../src/store/liveProjector.js";
import { rebuildFromLog, diffAgainstLive } from "../src/store/rebuildOracle.js";

const TOTAL = 250_000;
const CUTOFF_ISO = "2026-09-10T21:00:00.000Z";
const CREATED_AT_ISO = "2026-09-10T13:00:00.000Z";
const ACTIVITY_AT_ISO = "2026-09-10T18:00:00.000Z"; // before cutoff, for the "clean" scenarios

function main() {
  const started = Date.now();
  const { events, allocationIds } = generateBulkPopulation({
    totalAllocations: TOTAL,
    accountsPerBlock: 40,
    tradeDate: "2026-09-10",
    cutoffIso: CUTOFF_ISO,
    activityAtIso: ACTIVITY_AT_ISO,
    createdAtIso: CREATED_AT_ISO,
    seed: 20260910,
  });

  const projector = new LiveStateProjector();
  projector.applyMany(events);
  const live = projector.snapshot();

  const rebuilt = rebuildFromLog(events);
  const diff = diffAgainstLive(live, rebuilt);
  const elapsedMs = Date.now() - started;

  console.log("=== Allocation and Same-Day Affirmation Workflow -- rebuild-vs-live benchmark ===");
  console.log(`allocations generated: ${allocationIds.length}`);
  console.log(`events generated: ${events.length}`);
  console.log(`live state size: ${live.size}`);
  console.log(`rebuilt state size: ${rebuilt.size}`);
  console.log("");
  console.log("-- claim: status rebuilt from the append-only event log alone matched live state on all 250,000 allocations --");
  console.log(`compared: ${diff.totalCompared}`);
  console.log(`matches: ${diff.matches} / ${diff.totalCompared}`);
  console.log(`mismatches: ${diff.mismatches.length}`);
  if (diff.mismatches.length > 0) {
    console.log("first 5 mismatches:");
    for (const m of diff.mismatches.slice(0, 5)) {
      console.log(JSON.stringify(m));
    }
  }
  console.log(`elapsed: ${elapsedMs} ms`);

  if (allocationIds.length !== TOTAL) {
    console.error(`generator produced ${allocationIds.length} allocations, expected ${TOTAL}`);
    process.exitCode = 1;
  }
  if (diff.matches !== diff.totalCompared) {
    process.exitCode = 1;
  }
}

main();
