// Claims under test: "40 of 40 seeded breaches blocked" and "0 false blocks
// over 5,000 clean orders". generateSeededBreachOrders and generateCleanOrders
// (src/seed/orderSeed.ts) deterministically build the two populations;
// runPreTradeChecks (src/domain/preTradeCompliance.ts) is run once per order,
// exactly as the API's order-creation path would run it.
import { runPreTradeChecks } from "../src/domain/preTradeCompliance.js";
import { generateSeededBreachOrders, generateCleanOrders } from "../src/seed/orderSeed.js";

const NUM_CLEAN = 5_000;

function main() {
  const breachScenario = generateSeededBreachOrders(20260910);
  const cleanScenario = generateCleanOrders(20260911, NUM_CLEAN);

  let breachesBlocked = 0;
  let wrongRuleNamed = 0;
  for (const order of breachScenario.orders) {
    const account = breachScenario.book.get(order.account)!;
    const result = runPreTradeChecks(order, account, breachScenario.restrictedSymbols, breachScenario.concentrationLimitPct);
    if (!result.passed) {
      breachesBlocked++;
      const expected = breachScenario.expectedRuleByOrderId.get(order.orderId);
      if (result.rule !== expected) wrongRuleNamed++;
    } else {
      console.log(`NOT BLOCKED (should have been): ${order.orderId}`);
    }
  }

  let falseBlocks = 0;
  for (const order of cleanScenario.orders) {
    const account = cleanScenario.book.get(order.account)!;
    const result = runPreTradeChecks(order, account, cleanScenario.restrictedSymbols, cleanScenario.concentrationLimitPct);
    if (!result.passed) {
      falseBlocks++;
      console.log(`FALSELY BLOCKED: ${order.orderId} on rule ${result.rule} (${result.failingInput})`);
    }
  }

  console.log("=== Trade Order Lifecycle -- pre-trade compliance benchmark ===");
  console.log(`seeded breaches: ${breachScenario.orders.length}`);
  console.log(`seeded clean: ${cleanScenario.orders.length}`);
  console.log("");
  console.log("-- claim: 40 of 40 seeded breaches blocked --");
  console.log(`breaches blocked: ${breachesBlocked} / ${breachScenario.orders.length}`);
  console.log(`breaches blocked naming the exact intended rule: ${breachScenario.orders.length - wrongRuleNamed} / ${breachScenario.orders.length}`);
  console.log("");
  console.log("-- claim: 0 false blocks over 5,000 clean orders --");
  console.log(`clean orders falsely blocked: ${falseBlocks} / ${cleanScenario.orders.length}`);

  if (breachesBlocked !== breachScenario.orders.length || wrongRuleNamed !== 0 || falseBlocks !== 0) {
    process.exitCode = 1;
  }
}

main();
