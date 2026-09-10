// Claims under test: "40 of 40 seeded cutoff breaches escalated" and "0
// false escalations". generateEscalationScenario (src/seed/syntheticSeed.ts)
// deterministically builds exactly 40 allocations that reach activity time
// still short of "affirmed" (a genuine cutoff breach once "now" passes the
// cutoff) and a larger clean population that reaches "affirmed" or
// "instructed" well before the cutoff. computeCutoffEscalations
// (src/domain/cutoffSweep.ts) is run once, after the cutoff, exactly as the
// API's /cutoff-sweep endpoint would run it.
import { generateEscalationScenario } from "../src/seed/syntheticSeed.js";
import { LiveStateProjector } from "../src/store/liveProjector.js";
import { computeCutoffEscalations } from "../src/domain/cutoffSweep.js";

const NUM_BREACHES = 40;
const NUM_CLEAN = 5_000;
const CUTOFF_ISO = "2026-09-10T21:00:00.000Z";
const CREATED_AT_ISO = "2026-09-10T13:00:00.000Z";
const ACTIVITY_AT_ISO = "2026-09-10T18:00:00.000Z"; // before cutoff
const SWEEP_NOW_ISO = "2026-09-10T21:00:01.000Z"; // just after cutoff

function main() {
  const { events, breachAllocationIds, cleanAllocationIds } = generateEscalationScenario({
    numBreaches: NUM_BREACHES,
    numClean: NUM_CLEAN,
    tradeDate: "2026-09-10",
    cutoffIso: CUTOFF_ISO,
    activityAtIso: ACTIVITY_AT_ISO,
    createdAtIso: CREATED_AT_ISO,
    seed: 20260910,
  });

  const projector = new LiveStateProjector();
  projector.applyMany(events);

  const escalations = computeCutoffEscalations(projector.all(), SWEEP_NOW_ISO);
  const escalatedIds = new Set(escalations.map((e) => e.allocationId));

  const breachSet = new Set(breachAllocationIds);
  const cleanSet = new Set(cleanAllocationIds);

  const breachesEscalated = breachAllocationIds.filter((id) => escalatedIds.has(id)).length;
  const falseEscalations = [...escalatedIds].filter((id) => cleanSet.has(id));
  const unexpectedEscalations = [...escalatedIds].filter((id) => !breachSet.has(id) && !cleanSet.has(id));

  console.log("=== Allocation and Same-Day Affirmation Workflow -- cutoff escalation benchmark ===");
  console.log(`seeded breaches: ${breachAllocationIds.length}`);
  console.log(`seeded clean: ${cleanAllocationIds.length}`);
  console.log(`total escalations raised: ${escalations.length}`);
  console.log("");
  console.log("-- claim: 40 of 40 seeded cutoff breaches escalated --");
  console.log(`breaches escalated: ${breachesEscalated} / ${breachAllocationIds.length}`);
  console.log("");
  console.log("-- claim: 0 false escalations --");
  console.log(`clean allocations falsely escalated: ${falseEscalations.length} / ${cleanAllocationIds.length}`);
  if (unexpectedEscalations.length > 0) {
    console.log(`unexpected escalation ids not in either seeded set: ${unexpectedEscalations.length}`);
  }
  for (const id of breachAllocationIds) {
    if (!escalatedIds.has(id)) console.log(`NOT ESCALATED (should have been): ${id}`);
  }
  for (const id of falseEscalations) {
    console.log(`FALSELY ESCALATED: ${id}`);
  }

  if (breachesEscalated !== breachAllocationIds.length || falseEscalations.length !== 0) {
    process.exitCode = 1;
  }
}

main();
