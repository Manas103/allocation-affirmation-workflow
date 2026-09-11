// Claim under test: "pro-rata allocator conserved every share across
// 250,000 allocations". tests/proRataAllocator.test.ts already property-tests
// allocateProRata against 500 randomized weight sets; this script is the
// scale benchmark that actually reaches 250,000 individual allocations (not
// 250,000 orders) and is the number the README reports. An "allocation" here
// is one (order, account) pair the allocator produced a quantity for, the
// same unit the sibling bench_rebuild_250k.ts benchmark counts.
import { allocateProRata, AccountWeight } from "../src/domain/proRataAllocator.js";
import { pseudoRandom } from "../src/seed/syntheticSeed.js";

const TARGET_ALLOCATIONS = 250_000;

function main() {
  const rand = pseudoRandom(20260910);
  let allocationsChecked = 0;
  let ordersChecked = 0;
  let conservationFailures = 0;
  let nonIntegerFailures = 0;
  let negativeFailures = 0;

  while (allocationsChecked < TARGET_ALLOCATIONS) {
    const numAccounts = 2 + Math.floor(rand() * 48); // 2..49 client accounts per order
    const weights: AccountWeight[] = Array.from({ length: numAccounts }, (_, i) => ({
      account: `ACCT-${ordersChecked}-${i}`,
      weight: 0.01 + rand() * 1000,
    }));
    const filledQuantity = Math.floor(rand() * 5_000_000);

    const result = allocateProRata(filledQuantity, weights);

    const total = Object.values(result).reduce((a, b) => a + b, 0);
    if (total !== filledQuantity) {
      conservationFailures++;
      console.log(`CONSERVATION FAILURE on order ${ordersChecked}: total ${total} != filledQuantity ${filledQuantity}`);
    }
    for (const qty of Object.values(result)) {
      if (!Number.isInteger(qty)) nonIntegerFailures++;
      if (qty < 0) negativeFailures++;
    }

    ordersChecked++;
    allocationsChecked += numAccounts;
  }

  console.log("=== Trade Order Lifecycle -- pro-rata allocation conservation benchmark ===");
  console.log(`orders generated: ${ordersChecked}`);
  console.log(`allocations generated: ${allocationsChecked}`);
  console.log("");
  console.log("-- claim: pro-rata allocator conserved every share across 250,000 allocations --");
  console.log(`conservation failures: ${conservationFailures} / ${ordersChecked} orders`);
  console.log(`non-integer allocation failures: ${nonIntegerFailures}`);
  console.log(`negative allocation failures: ${negativeFailures}`);

  if (conservationFailures !== 0 || nonIntegerFailures !== 0 || negativeFailures !== 0) {
    process.exitCode = 1;
  }
}

main();
