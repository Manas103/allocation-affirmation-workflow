import { AllocationEvent, Side } from "./types.js";

export interface BlockTradeSpec {
  blockTradeId: string;
  symbol: string;
  side: Side;
  tradeDate: string; // YYYY-MM-DD
  cutoffIso: string; // same-day affirmation cutoff for every allocation this trade fans into
  totalQuantity: number;
  price: number;
  accounts: string[]; // one allocation per account
  createdAtIso?: string; // when the block was allocated; defaults to 4 hours before cutoff
}

// Fans one simulated block trade out into one ALLOCATION_CREATED event per
// client account. The split is proportional-with-remainder: accounts get an
// equal share of the block, with the leftover shares (from integer division)
// handed to the first accounts in the list, so quantities always sum back to
// the block's total exactly (a real allocation desk would apply its own
// pro-rata schedule; the arithmetic property that matters here, and the one
// this module is tested against, is that the fan-out never drops or invents
// shares).
export function fanOutBlockTrade(spec: BlockTradeSpec): AllocationEvent[] {
  const n = spec.accounts.length;
  if (n === 0) {
    throw new Error(`block trade ${spec.blockTradeId} has no target accounts`);
  }
  const base = Math.floor(spec.totalQuantity / n);
  const remainder = spec.totalQuantity - base * n;
  const createdAtIso =
    spec.createdAtIso ?? new Date(new Date(spec.cutoffIso).getTime() - 4 * 60 * 60 * 1000).toISOString();

  const events: AllocationEvent[] = [];
  spec.accounts.forEach((account, i) => {
    const quantity = base + (i < remainder ? 1 : 0);
    events.push({
      type: "ALLOCATION_CREATED",
      allocationId: `${spec.blockTradeId}-${account}`,
      blockTradeId: spec.blockTradeId,
      account,
      side: spec.side,
      symbol: spec.symbol,
      quantity,
      price: spec.price,
      tradeDate: spec.tradeDate,
      cutoffIso: spec.cutoffIso,
      occurredAt: createdAtIso,
    });
  });
  return events;
}
