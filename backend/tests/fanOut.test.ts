import { describe, it, expect } from "vitest";
import { fanOutBlockTrade } from "../src/domain/fanOut.js";

describe("fanOutBlockTrade", () => {
  it("fans a block trade into one allocation per account", () => {
    const events = fanOutBlockTrade({
      blockTradeId: "BLK-1",
      symbol: "ACME",
      side: "BUY",
      tradeDate: "2026-09-10",
      cutoffIso: "2026-09-10T21:00:00.000Z",
      totalQuantity: 1000,
      price: 50,
      accounts: ["A", "B", "C"],
    });
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.type === "ALLOCATION_CREATED")).toBe(true);
  });

  it("splits quantity so the shares sum back to the block total exactly, remainder-first", () => {
    const events = fanOutBlockTrade({
      blockTradeId: "BLK-2",
      symbol: "ACME",
      side: "SELL",
      tradeDate: "2026-09-10",
      cutoffIso: "2026-09-10T21:00:00.000Z",
      totalQuantity: 1001,
      price: 50,
      accounts: ["A", "B", "C"],
    });
    const quantities = events.map((e) => (e.type === "ALLOCATION_CREATED" ? e.quantity : 0));
    expect(quantities.reduce((a, b) => a + b, 0)).toBe(1001);
    expect(quantities).toEqual([334, 334, 333]);
  });

  it("throws rather than fabricating allocations for an empty account list", () => {
    expect(() =>
      fanOutBlockTrade({
        blockTradeId: "BLK-3",
        symbol: "ACME",
        side: "BUY",
        tradeDate: "2026-09-10",
        cutoffIso: "2026-09-10T21:00:00.000Z",
        totalQuantity: 100,
        price: 50,
        accounts: [],
      })
    ).toThrow();
  });
});
