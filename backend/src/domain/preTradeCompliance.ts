import { Side } from "./types.js";
import { AccountPosition } from "./positionBook.js";

// The three pre-trade gates an order must clear before it can be released.
// Every rejection names which rule failed and the specific input that failed
// it (the restricted symbol, the concentration percentage and limit, or the
// cash shortfall amount), mirroring blockingField.ts's convention: a caller
// is never told just "no", only what to look at.
export type PreTradeRule = "RESTRICTED_LIST" | "CONCENTRATION" | "CASH_SUFFICIENCY";

export type PreTradeResult =
  | { passed: true }
  | { passed: false; rule: PreTradeRule; failingInput: string };

export interface PreTradeOrderInput {
  symbol: string;
  side: Side;
  quantity: number;
  referencePrice: number;
}

// Restricted-list: the order references a symbol this desk is not allowed to
// trade at all, regardless of account, side, or size.
export function checkRestrictedList(
  symbol: string,
  restrictedSymbols: ReadonlySet<string>
): PreTradeResult {
  if (restrictedSymbols.has(symbol)) {
    return { passed: false, rule: "RESTRICTED_LIST", failingInput: symbol };
  }
  return { passed: true };
}

// Cash-sufficiency: a BUY order's notional must not exceed the account's
// available cash. A SELL order raises cash rather than spending it, so it
// never fails this rule.
export function checkCashSufficiency(order: PreTradeOrderInput, account: AccountPosition): PreTradeResult {
  if (order.side !== "BUY") return { passed: true };
  const notional = order.quantity * order.referencePrice;
  if (notional > account.cash) {
    const shortfall = notional - account.cash;
    return {
      passed: false,
      rule: "CASH_SUFFICIENCY",
      failingInput: `shortfall of $${shortfall.toFixed(2)} (notional $${notional.toFixed(2)} vs available cash $${account.cash.toFixed(2)})`,
    };
  }
  return { passed: true };
}

// Concentration: a BUY order must not push the account's position in one
// symbol over `limitPct` of that account's total book value. A SELL order
// only reduces a symbol's share of the book, so it never fails this rule.
export function checkConcentration(
  order: PreTradeOrderInput,
  account: AccountPosition,
  limitPct: number
): PreTradeResult {
  if (order.side !== "BUY") return { passed: true };
  const notional = order.quantity * order.referencePrice;
  const existing = account.holdings[order.symbol] ?? 0;
  const resultingPct = (existing + notional) / account.bookValue;
  if (resultingPct > limitPct) {
    return {
      passed: false,
      rule: "CONCENTRATION",
      failingInput: `${order.symbol} would reach ${(resultingPct * 100).toFixed(2)}% of account book value, over the ${(limitPct * 100).toFixed(0)}% limit`,
    };
  }
  return { passed: true };
}

// Runs all three gates in a fixed order and returns the first one that
// fails. The seeded breach population (seed/orderSeed.ts) is deliberately
// constructed so each breach order fails exactly one rule; this function
// does not assume that in general, it simply stops at the first failure.
export function runPreTradeChecks(
  order: PreTradeOrderInput,
  account: AccountPosition,
  restrictedSymbols: ReadonlySet<string>,
  concentrationLimitPct: number
): PreTradeResult {
  const restricted = checkRestrictedList(order.symbol, restrictedSymbols);
  if (!restricted.passed) return restricted;
  const cash = checkCashSufficiency(order, account);
  if (!cash.passed) return cash;
  return checkConcentration(order, account, concentrationLimitPct);
}
