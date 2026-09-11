// A simple synthetic book of positions per account: existing cash and
// existing market value held per symbol. Deliberately minimal (no lots, no
// prices-over-time) because the only thing the pre-trade rules below need is
// two real numbers per account: how much cash it has, and what fraction of
// its book any one symbol already represents. Nothing here is a real
// custodian or PMS position record; see the README's honest framing section.
export interface AccountPosition {
  account: string;
  cash: number;
  // Total portfolio value: cash plus the market value of every holding. A
  // BUY order does not change this number (it converts cash into a position
  // of the same value); it only changes how that value is distributed across
  // symbols, which is exactly what the concentration rule below measures.
  bookValue: number;
  holdings: Record<string, number>; // symbol -> current market value held
}

export type PositionBook = Map<string, AccountPosition>;
