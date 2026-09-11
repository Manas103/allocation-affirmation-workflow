import { describe, it, expect } from "vitest";
import {
  checkRestrictedList,
  checkCashSufficiency,
  checkConcentration,
  runPreTradeChecks,
} from "../src/domain/preTradeCompliance.js";
import { AccountPosition } from "../src/domain/positionBook.js";
import { generateSeededBreachOrders, generateCleanOrders } from "../src/seed/orderSeed.js";

const RESTRICTED = new Set(["EMBR"]);
const LIMIT_PCT = 0.25;

function account(overrides: Partial<AccountPosition> = {}): AccountPosition {
  return { account: "ACCT-1", cash: 1_000_000, bookValue: 1_000_000, holdings: {}, ...overrides };
}

describe("checkRestrictedList: names the exact restricted symbol", () => {
  it("refuses an order on a restricted symbol", () => {
    const result = checkRestrictedList("EMBR", RESTRICTED);
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.rule).toBe("RESTRICTED_LIST");
      expect(result.failingInput).toBe("EMBR");
    }
  });

  it("passes a symbol that is not on the list", () => {
    expect(checkRestrictedList("ACME", RESTRICTED)).toEqual({ passed: true });
  });
});

describe("checkCashSufficiency: names the shortfall amount", () => {
  it("refuses a BUY whose notional exceeds available cash", () => {
    const result = checkCashSufficiency(
      { symbol: "ACME", side: "BUY", quantity: 100, referencePrice: 50 }, // notional 5,000
      account({ cash: 1_000 })
    );
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.rule).toBe("CASH_SUFFICIENCY");
      expect(result.failingInput).toContain("shortfall of $4000.00");
      expect(result.failingInput).toContain("notional $5000.00");
      expect(result.failingInput).toContain("available cash $1000.00");
    }
  });

  it("passes a BUY within available cash", () => {
    const result = checkCashSufficiency(
      { symbol: "ACME", side: "BUY", quantity: 100, referencePrice: 50 },
      account({ cash: 5_000 })
    );
    expect(result).toEqual({ passed: true });
  });

  it("never fails a SELL on cash, however large the notional", () => {
    const result = checkCashSufficiency(
      { symbol: "ACME", side: "SELL", quantity: 1_000_000, referencePrice: 999 },
      account({ cash: 0 })
    );
    expect(result).toEqual({ passed: true });
  });
});

describe("checkConcentration: names the resulting percentage and the limit", () => {
  it("refuses a BUY that would push a symbol over the limit", () => {
    // existing 200,000 of a 1,000,000 book (20%) + 100,000 notional (10%) = 30% > 25%
    const result = checkConcentration(
      { symbol: "ACME", side: "BUY", quantity: 1_000, referencePrice: 100 },
      account({ bookValue: 1_000_000, holdings: { ACME: 200_000 } }),
      LIMIT_PCT
    );
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.rule).toBe("CONCENTRATION");
      expect(result.failingInput).toContain("ACME");
      expect(result.failingInput).toContain("30.00%");
      expect(result.failingInput).toContain("25% limit");
    }
  });

  it("passes a BUY that stays within the limit", () => {
    const result = checkConcentration(
      { symbol: "ACME", side: "BUY", quantity: 10, referencePrice: 100 }, // 1,000 notional, 0.1% of book
      account({ bookValue: 1_000_000, holdings: {} }),
      LIMIT_PCT
    );
    expect(result).toEqual({ passed: true });
  });

  it("never fails a SELL on concentration, since selling only reduces it", () => {
    const result = checkConcentration(
      { symbol: "ACME", side: "SELL", quantity: 1_000_000, referencePrice: 999 },
      account({ bookValue: 1_000_000, holdings: { ACME: 900_000 } }),
      LIMIT_PCT
    );
    expect(result).toEqual({ passed: true });
  });
});

describe("runPreTradeChecks: stops at the first failing rule", () => {
  it("reports restricted-list even when the same order would also fail cash or concentration", () => {
    const result = runPreTradeChecks(
      { symbol: "EMBR", side: "BUY", quantity: 100_000, referencePrice: 500 },
      account({ cash: 1, bookValue: 1_000_000, holdings: { EMBR: 900_000 } }),
      RESTRICTED,
      LIMIT_PCT
    );
    expect(result.passed).toBe(false);
    if (!result.passed) expect(result.rule).toBe("RESTRICTED_LIST");
  });

  it("passes a clean order against a clean book", () => {
    const result = runPreTradeChecks(
      { symbol: "ACME", side: "BUY", quantity: 10, referencePrice: 100 },
      account(),
      RESTRICTED,
      LIMIT_PCT
    );
    expect(result).toEqual({ passed: true });
  });
});

describe("generateSeededBreachOrders: every seeded order fails exactly the intended rule", () => {
  const scenario = generateSeededBreachOrders(20260910);

  it("produces exactly 40 orders", () => {
    expect(scenario.orders).toHaveLength(40);
    expect(scenario.expectedRuleByOrderId.size).toBe(40);
  });

  it("every order fails the rule it was constructed to fail, and no other", () => {
    for (const order of scenario.orders) {
      const account = scenario.book.get(order.account);
      expect(account).toBeDefined();
      const result = runPreTradeChecks(order, account!, scenario.restrictedSymbols, scenario.concentrationLimitPct);
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.rule).toBe(scenario.expectedRuleByOrderId.get(order.orderId));
        expect(result.failingInput.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("generateCleanOrders: every generated order passes every rule", () => {
  it("produces 200 orders that all pass (a fast subset of the full 5,000 checked by the benchmark)", () => {
    const scenario = generateCleanOrders(20260910, 200);
    expect(scenario.orders).toHaveLength(200);
    for (const order of scenario.orders) {
      const account = scenario.book.get(order.account);
      const result = runPreTradeChecks(order, account!, scenario.restrictedSymbols, scenario.concentrationLimitPct);
      expect(result).toEqual({ passed: true });
    }
  });
});
