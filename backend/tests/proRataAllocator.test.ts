import { describe, it, expect } from "vitest";
import { allocateProRata, AccountWeight } from "../src/domain/proRataAllocator.js";
import { pseudoRandom } from "../src/seed/syntheticSeed.js";

function sum(result: Record<string, number>): number {
  return Object.values(result).reduce((a, b) => a + b, 0);
}

describe("allocateProRata: fixed examples", () => {
  it("splits evenly when weights are equal and quantity divides exactly", () => {
    const result = allocateProRata(300, [
      { account: "A", weight: 1 },
      { account: "B", weight: 1 },
      { account: "C", weight: 1 },
    ]);
    expect(result).toEqual({ A: 100, B: 100, C: 100 });
  });

  it("gives the whole quantity to a single account", () => {
    const result = allocateProRata(777, [{ account: "ONLY", weight: 1 }]);
    expect(result).toEqual({ ONLY: 777 });
  });

  it("hands the remainder to the account(s) with the largest fractional share, deterministically", () => {
    // 100 split 1/3, 1/3, 1/3: each gets exactly 33.33..., floors sum to 99,
    // one share left over. All three remainders are equal (0.333...), so the
    // tie-break is alphabetical: "A" wins.
    const result = allocateProRata(100, [
      { account: "A", weight: 1 },
      { account: "B", weight: 1 },
      { account: "C", weight: 1 },
    ]);
    expect(sum(result)).toBe(100);
    expect(result.A).toBe(34);
    expect(result.B).toBe(33);
    expect(result.C).toBe(33);
  });

  it("is exact for a heavily skewed weight set", () => {
    const result = allocateProRata(1_000_000, [
      { account: "WHALE", weight: 0.97 },
      { account: "MINNOW-1", weight: 0.02 },
      { account: "MINNOW-2", weight: 0.01 },
    ]);
    expect(sum(result)).toBe(1_000_000);
  });

  it("gives a zero-weight account zero shares when any nonzero-weight account still has a fractional remainder to take them", () => {
    const result = allocateProRata(10, [
      { account: "ZERO", weight: 0 },
      { account: "ALL", weight: 1 },
    ]);
    expect(result).toEqual({ ZERO: 0, ALL: 10 });
  });

  it("rejects an empty account list rather than fabricating an allocation", () => {
    expect(() => allocateProRata(100, [])).toThrow();
  });

  it("rejects a non-integer or negative filled quantity", () => {
    expect(() => allocateProRata(10.5, [{ account: "A", weight: 1 }])).toThrow();
    expect(() => allocateProRata(-1, [{ account: "A", weight: 1 }])).toThrow();
  });

  it("rejects a negative weight", () => {
    expect(() => allocateProRata(10, [{ account: "A", weight: -1 }])).toThrow();
  });

  it("rejects an all-zero weight set (nothing to allocate by)", () => {
    expect(() => allocateProRata(10, [{ account: "A", weight: 0 }, { account: "B", weight: 0 }])).toThrow();
  });
});

// Property test for the claim under test: "pro-rata allocator conserved
// every share across 250,000 allocations". This is the small, fast form of
// that claim (hundreds of randomized weight sets, not 250,000 allocations);
// scripts/bench_prorata_allocation_250k.ts is the scale benchmark that
// actually reaches 250,000 allocations and is the number the README reports.
//
// The first implementation of allocateProRata rounded each account
// independently with Math.round(filledQuantity * weight / totalWeight).
// This exact loop, run against that implementation, is what caught it not
// conserving shares (see the README's Findings section for the measured
// failure rate and the fix).
describe("allocateProRata: property test, share conservation over many random weight sets", () => {
  it("conserves every share for 500 randomized (accounts, weights, filledQuantity) configurations", () => {
    const rand = pseudoRandom(90210);
    let checked = 0;
    for (let trial = 0; trial < 500; trial++) {
      const numAccounts = 1 + Math.floor(rand() * 40);
      const weights: AccountWeight[] = Array.from({ length: numAccounts }, (_, i) => ({
        account: `ACCT-${trial}-${i}`,
        weight: 0.01 + rand() * 100,
      }));
      const filledQuantity = Math.floor(rand() * 1_000_000);
      const result = allocateProRata(filledQuantity, weights);
      expect(sum(result)).toBe(filledQuantity);
      expect(Object.keys(result)).toHaveLength(numAccounts);
      for (const qty of Object.values(result)) {
        expect(Number.isInteger(qty)).toBe(true);
        expect(qty).toBeGreaterThanOrEqual(0);
      }
      checked++;
    }
    expect(checked).toBe(500);
  });
});
