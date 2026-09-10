// Core domain types. An allocation is the unit that moves through the state
// machine; a block trade is purely the thing it fans out from and is not
// itself stateful.

export type AllocationState = "allocated" | "confirmed" | "affirmed" | "instructed";

export type BlockingField =
  | "missing broker confirmation"
  | "quantity mismatch vs client instruction"
  | "price mismatch vs client instruction beyond tolerance"
  | "missing affirmation from custodian"
  | "missing settlement instruction"
  | null;

export type Side = "BUY" | "SELL";

// The append-only log. Every row is one fact that happened; nothing is ever
// updated or deleted. `sequence` is assigned by the store on insert (a
// monotonically increasing integer per allocation is enough for correct
// replay ordering; global ordering uses the primary key / insertion order of
// the underlying table).
export type AllocationEvent =
  | {
      type: "ALLOCATION_CREATED";
      allocationId: string;
      blockTradeId: string;
      account: string;
      side: Side;
      symbol: string;
      quantity: number;
      price: number;
      tradeDate: string; // ISO date, YYYY-MM-DD
      cutoffIso: string; // ISO instant, the same-day affirmation cutoff for this allocation
      occurredAt: string; // ISO instant
    }
  | {
      type: "BROKER_CONFIRMATION_RECEIVED";
      allocationId: string;
      confirmedQuantity: number;
      confirmedPrice: number;
      occurredAt: string;
    }
  | {
      type: "CUSTODIAN_AFFIRMATION_RECEIVED";
      allocationId: string;
      occurredAt: string;
    }
  | {
      type: "SETTLEMENT_INSTRUCTION_SENT";
      allocationId: string;
      occurredAt: string;
    }
  | {
      type: "CUTOFF_ESCALATED";
      allocationId: string;
      blockingField: Exclude<BlockingField, null>;
      occurredAt: string;
    };

export type AllocationEventType = AllocationEvent["type"];

// The materialized shape served by the API and shown in the console. This is
// what both the fast live-state path and the slow rebuild-from-log oracle
// must agree on, field for field.
export interface AllocationView {
  allocationId: string;
  blockTradeId: string;
  account: string;
  side: Side;
  symbol: string;
  quantity: number;
  price: number;
  tradeDate: string;
  cutoffIso: string;
  state: AllocationState;
  brokerConfirmedQuantity: number | null;
  brokerConfirmedPrice: number | null;
  custodianAffirmed: boolean;
  settlementInstructionSent: boolean;
  escalated: boolean;
  escalatedAt: string | null;
}

export const PRICE_TOLERANCE = 0.005; // absolute price tolerance, in quote currency
