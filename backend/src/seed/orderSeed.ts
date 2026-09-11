import { Side } from "../domain/types.js";
import { PositionBook } from "../domain/positionBook.js";
import { PreTradeRule } from "../domain/preTradeCompliance.js";
import { pseudoRandom } from "./syntheticSeed.js";

// Every generator in this module produces clearly-labeled SYNTHETIC orders
// and a clearly-labeled SYNTHETIC position book. Nothing here talks to a
// real order management system, custodian, or clearing house; see the
// README's honest framing section.

export interface SeededOrder {
  orderId: string;
  account: string;
  side: Side;
  symbol: string;
  quantity: number;
  referencePrice: number;
}

export interface SeededComplianceScenario {
  orders: SeededOrder[];
  book: PositionBook;
  restrictedSymbols: Set<string>;
  concentrationLimitPct: number;
  // Present only for orders the scenario deliberately built to fail exactly
  // one rule; absent (no entry) for orders meant to pass every rule.
  expectedRuleByOrderId: Map<string, PreTradeRule>;
}

export const CONCENTRATION_LIMIT_PCT = 0.25;

// Deliberately disjoint from the symbol universe used elsewhere in this
// project (syntheticSeed.ts's SYMBOLS) so a restricted-list breach can never
// accidentally collide with a "clean" symbol used by another scenario.
export const RESTRICTED_SYMBOLS: ReadonlySet<string> = new Set(["EMBR", "SANCT"]);
const CLEAN_SYMBOLS = ["ACME", "GLOB", "NOVA", "ORBT", "TERA"];

// Builds exactly 40 orders, each constructed with enough margin on the two
// rules it is not meant to fail that only its one intended rule can ever
// fire: 14 restricted-list, 13 cash-sufficiency, 13 concentration (40
// total). Every account in the returned book is used by exactly one order,
// so no order's compliance check can be affected by another order's account.
export function generateSeededBreachOrders(seed: number): SeededComplianceScenario {
  const rand = pseudoRandom(seed);
  const orders: SeededOrder[] = [];
  const book: PositionBook = new Map();
  const expectedRuleByOrderId = new Map<string, PreTradeRule>();

  const NUM_RESTRICTED = 14;
  const NUM_CASH = 13;
  const NUM_CONCENTRATION = 13; // 14 + 13 + 13 = 40

  const restrictedList = [...RESTRICTED_SYMBOLS];
  for (let i = 0; i < NUM_RESTRICTED; i++) {
    const account = `ACCT-BREACH-RESTRICTED-${i}`;
    const orderId = `ORD-BREACH-RESTRICTED-${i}`;
    const symbol = restrictedList[i % restrictedList.length];
    // All cash, no existing holdings: cash and concentration both pass with
    // enormous margin, so only the restricted-list check can fire.
    const cash = 900_000 + rand() * 200_000;
    book.set(account, { account, cash, bookValue: cash, holdings: {} });
    const quantity = 100 + Math.floor(rand() * 400);
    const referencePrice = 10 + rand() * 40; // notional at most 25,000, <<< cash and <<< 25% of book
    orders.push({ orderId, account, side: "BUY", symbol, quantity, referencePrice });
    expectedRuleByOrderId.set(orderId, "RESTRICTED_LIST");
  }

  for (let i = 0; i < NUM_CASH; i++) {
    const account = `ACCT-BREACH-CASH-${i}`;
    const orderId = `ORD-BREACH-CASH-${i}`;
    const symbol = CLEAN_SYMBOLS[i % CLEAN_SYMBOLS.length];
    const bookValue = 900_000 + rand() * 200_000;
    const cash = 1_000 + rand() * 1_000; // tiny cash relative to the book
    const otherHoldingValue = bookValue - cash; // parked in a symbol this order never touches
    book.set(account, { account, cash, bookValue, holdings: { [`OTHER-${i}`]: otherHoldingValue } });
    const quantity = 500 + Math.floor(rand() * 500);
    const referencePrice = 20 + rand() * 20; // notional 10,000-30,000: far over cash, far under 25% of book
    orders.push({ orderId, account, side: "BUY", symbol, quantity, referencePrice });
    expectedRuleByOrderId.set(orderId, "CASH_SUFFICIENCY");
  }

  for (let i = 0; i < NUM_CONCENTRATION; i++) {
    const account = `ACCT-BREACH-CONCENTRATION-${i}`;
    const orderId = `ORD-BREACH-CONCENTRATION-${i}`;
    const symbol = CLEAN_SYMBOLS[i % CLEAN_SYMBOLS.length];
    const bookValue = 900_000 + rand() * 200_000;
    const existingHolding = bookValue * 0.2; // already 20% of book in this symbol
    const cash = bookValue * 0.3; // plenty of cash for the order itself
    const otherHoldingValue = bookValue - existingHolding - cash;
    book.set(account, {
      account,
      cash,
      bookValue,
      holdings: { [symbol]: existingHolding, [`OTHER-${i}`]: otherHoldingValue },
    });
    const quantity = 1_000 + Math.floor(rand() * 500);
    // Notional fixed at exactly 10% of book value, so resultingPct is always
    // exactly 30% (20% existing + 10% new), comfortably over the 25% limit,
    // however quantity/referencePrice happen to split it.
    const targetNotional = bookValue * 0.1;
    const referencePrice = targetNotional / quantity;
    orders.push({ orderId, account, side: "BUY", symbol, quantity, referencePrice });
    expectedRuleByOrderId.set(orderId, "CONCENTRATION");
  }

  return {
    orders,
    book,
    restrictedSymbols: new Set(RESTRICTED_SYMBOLS),
    concentrationLimitPct: CONCENTRATION_LIMIT_PCT,
    expectedRuleByOrderId,
  };
}

// Builds `count` orders that pass every pre-trade rule by construction:
// never a restricted symbol, notional always well under both available cash
// and the concentration limit. Used by the 0-false-blocks-over-5,000-clean-
// orders benchmark.
export function generateCleanOrders(seed: number, count = 5_000): SeededComplianceScenario {
  const rand = pseudoRandom(seed);
  const orders: SeededOrder[] = [];
  const book: PositionBook = new Map();

  for (let i = 0; i < count; i++) {
    const account = `ACCT-CLEAN-${i}`;
    const orderId = `ORD-CLEAN-${i}`;
    const symbol = CLEAN_SYMBOLS[i % CLEAN_SYMBOLS.length];
    const bookValue = 900_000 + rand() * 200_000;
    const cash = bookValue; // effectively all cash, nothing already held
    book.set(account, { account, cash, bookValue, holdings: {} });
    const quantity = 10 + Math.floor(rand() * 990);
    const referencePrice = 5 + rand() * 45; // notional at most ~50,000: <<< cash and <<< 25% of a >=900,000 book
    orders.push({ orderId, account, side: "BUY", symbol, quantity, referencePrice });
  }

  return {
    orders,
    book,
    restrictedSymbols: new Set(RESTRICTED_SYMBOLS),
    concentrationLimitPct: CONCENTRATION_LIMIT_PCT,
    expectedRuleByOrderId: new Map(),
  };
}
