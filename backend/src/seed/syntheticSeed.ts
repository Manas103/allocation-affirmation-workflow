import { AllocationEvent, Side } from "../domain/types.js";
import { fanOutBlockTrade, BlockTradeSpec } from "../domain/fanOut.js";

// Every generator in this module produces clearly-labeled SYNTHETIC data.
// Nothing here talks to a real broker, custodian or settlement system; see
// the README's honest framing section.

export type LifecycleScenario =
  | "instructed"
  | "affirmed_not_instructed"
  | "confirmed_not_affirmed"
  | "allocated_no_confirmation"
  | "allocated_quantity_mismatch"
  | "allocated_price_mismatch";

const SYMBOLS = ["ACME", "GLOB", "NOVA", "ORBT", "TERA", "VELO", "ZEN", "QUAD", "PLUM", "RISE"];

function pseudoRandom(seed: number): () => number {
  // Deterministic LCG so every benchmark run and every test run generates the
  // exact same synthetic population, byte for byte, given the same seed.
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export interface LifecycleOptions {
  allocationId: string;
  quantity: number;
  price: number;
  cutoffIso: string;
  createdAtIso: string;
  scenario: LifecycleScenario;
  /** ISO instant the confirmation/affirmation/instruction facts happen at (before cutoff for clean cases). */
  activityAtIso: string;
}

// Appends the additional lifecycle events implied by `scenario` on top of an
// already-created allocation. `allocated_no_confirmation` adds nothing.
export function buildLifecycleEvents(opts: LifecycleOptions): AllocationEvent[] {
  const events: AllocationEvent[] = [];
  const { allocationId, quantity, price, scenario, activityAtIso } = opts;

  if (scenario === "allocated_no_confirmation") {
    return events;
  }

  if (scenario === "allocated_quantity_mismatch") {
    events.push({
      type: "BROKER_CONFIRMATION_RECEIVED",
      allocationId,
      confirmedQuantity: quantity + 1,
      confirmedPrice: price,
      occurredAt: activityAtIso,
    });
    return events;
  }

  if (scenario === "allocated_price_mismatch") {
    events.push({
      type: "BROKER_CONFIRMATION_RECEIVED",
      allocationId,
      confirmedQuantity: quantity,
      confirmedPrice: price + 1.5,
      occurredAt: activityAtIso,
    });
    return events;
  }

  // All remaining scenarios start with a clean, matching confirmation.
  events.push({
    type: "BROKER_CONFIRMATION_RECEIVED",
    allocationId,
    confirmedQuantity: quantity,
    confirmedPrice: price,
    occurredAt: activityAtIso,
  });

  if (scenario === "confirmed_not_affirmed") {
    return events;
  }

  events.push({
    type: "CUSTODIAN_AFFIRMATION_RECEIVED",
    allocationId,
    occurredAt: activityAtIso,
  });

  if (scenario === "affirmed_not_instructed") {
    return events;
  }

  events.push({
    type: "SETTLEMENT_INSTRUCTION_SENT",
    allocationId,
    occurredAt: activityAtIso,
  });

  return events;
}

export interface BulkGenerationOptions {
  totalAllocations: number;
  accountsPerBlock: number;
  tradeDate: string;
  cutoffIso: string;
  /** activity (confirm/affirm/instruct) timestamp for allocations that reach it, must be before cutoffIso for a "clean" population */
  activityAtIso: string;
  createdAtIso: string;
  seed: number;
  /** relative weight of each scenario; defaults to a realistic mostly-clean mix */
  weights?: Partial<Record<LifecycleScenario, number>>;
}

export interface BulkGenerationResult {
  events: AllocationEvent[];
  allocationIds: string[];
  scenarioByAllocationId: Map<string, LifecycleScenario>;
}

const DEFAULT_WEIGHTS: Record<LifecycleScenario, number> = {
  instructed: 55,
  affirmed_not_instructed: 15,
  confirmed_not_affirmed: 12,
  allocated_no_confirmation: 8,
  allocated_quantity_mismatch: 5,
  allocated_price_mismatch: 5,
};

function pickScenario(rand: () => number, weights: Record<LifecycleScenario, number>): LifecycleScenario {
  const entries = Object.entries(weights) as [LifecycleScenario, number][];
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let x = rand() * total;
  for (const [scenario, w] of entries) {
    if (x < w) return scenario;
    x -= w;
  }
  return entries[entries.length - 1][0];
}

// Generates a large, varied synthetic population by fanning out many block
// trades into client-account allocations and then driving each allocation's
// lifecycle to a randomly (but deterministically) chosen point along
// allocated -> confirmed -> affirmed -> instructed, including the mismatch
// and stuck cases the console's blocking-field logic exists to name. Used by
// the 250,000-allocation rebuild-vs-live benchmark.
export function generateBulkPopulation(opts: BulkGenerationOptions): BulkGenerationResult {
  const rand = pseudoRandom(opts.seed);
  const weights = { ...DEFAULT_WEIGHTS, ...opts.weights };
  const events: AllocationEvent[] = [];
  const allocationIds: string[] = [];
  const scenarioByAllocationId = new Map<string, LifecycleScenario>();

  const numBlocks = Math.ceil(opts.totalAllocations / opts.accountsPerBlock);
  let remaining = opts.totalAllocations;

  for (let b = 0; b < numBlocks && remaining > 0; b++) {
    const accountsInThisBlock = Math.min(opts.accountsPerBlock, remaining);
    const accounts = Array.from({ length: accountsInThisBlock }, (_, i) => `ACCT-${b}-${i}`);
    const symbol = SYMBOLS[b % SYMBOLS.length];
    const side: Side = b % 2 === 0 ? "BUY" : "SELL";
    const totalQuantity = 1000 + Math.floor(rand() * 900000);
    const price = 10 + rand() * 490;

    const spec: BlockTradeSpec = {
      blockTradeId: `BLK-${b}`,
      symbol,
      side,
      tradeDate: opts.tradeDate,
      cutoffIso: opts.cutoffIso,
      totalQuantity,
      price: Math.round(price * 100) / 100,
      accounts,
      createdAtIso: opts.createdAtIso,
    };

    const creationEvents = fanOutBlockTrade(spec);
    for (const creation of creationEvents) {
      if (creation.type !== "ALLOCATION_CREATED") continue;
      events.push(creation);
      allocationIds.push(creation.allocationId);
      const scenario = pickScenario(rand, weights);
      scenarioByAllocationId.set(creation.allocationId, scenario);
      const lifecycleEvents = buildLifecycleEvents({
        allocationId: creation.allocationId,
        quantity: creation.quantity,
        price: creation.price,
        cutoffIso: creation.cutoffIso,
        createdAtIso: opts.createdAtIso,
        scenario,
        activityAtIso: opts.activityAtIso,
      });
      events.push(...lifecycleEvents);
    }

    remaining -= accountsInThisBlock;
  }

  return { events, allocationIds, scenarioByAllocationId };
}

export interface EscalationScenarioOptions {
  numBreaches: number;
  numClean: number;
  tradeDate: string;
  cutoffIso: string;
  activityAtIso: string;
  createdAtIso: string;
  seed: number;
}

export interface EscalationScenarioResult {
  events: AllocationEvent[];
  breachAllocationIds: string[];
  cleanAllocationIds: string[];
}

const BREACH_SCENARIOS: LifecycleScenario[] = [
  "allocated_no_confirmation",
  "confirmed_not_affirmed",
  "allocated_quantity_mismatch",
  "allocated_price_mismatch",
];

// Deterministically builds exactly `numBreaches` allocations that reach
// activity time still short of "affirmed" (every one of them is a genuine
// cutoff breach once `nowIso` passes `cutoffIso`), and exactly `numClean`
// allocations that reach "affirmed" or "instructed" well before the cutoff
// (none of which should ever be escalated). Used by the 40-of-40 escalation
// and 0-false-escalation benchmarks, where the exact counts matter.
export function generateEscalationScenario(opts: EscalationScenarioOptions): EscalationScenarioResult {
  const rand = pseudoRandom(opts.seed);
  const events: AllocationEvent[] = [];
  const breachAllocationIds: string[] = [];
  const cleanAllocationIds: string[] = [];

  const blockTradeId = "BLK-ESCALATION";
  const symbol = "ESCL";

  for (let i = 0; i < opts.numBreaches; i++) {
    const allocationId = `${blockTradeId}-BREACH-${i}`;
    const quantity = 100 + Math.floor(rand() * 900);
    const price = Math.round((20 + rand() * 80) * 100) / 100;
    events.push({
      type: "ALLOCATION_CREATED",
      allocationId,
      blockTradeId,
      account: `ACCT-BREACH-${i}`,
      side: i % 2 === 0 ? "BUY" : "SELL",
      symbol,
      quantity,
      price,
      tradeDate: opts.tradeDate,
      cutoffIso: opts.cutoffIso,
      occurredAt: opts.createdAtIso,
    });
    const scenario = BREACH_SCENARIOS[i % BREACH_SCENARIOS.length];
    events.push(
      ...buildLifecycleEvents({
        allocationId,
        quantity,
        price,
        cutoffIso: opts.cutoffIso,
        createdAtIso: opts.createdAtIso,
        scenario,
        activityAtIso: opts.activityAtIso,
      })
    );
    breachAllocationIds.push(allocationId);
  }

  const cleanScenarios: LifecycleScenario[] = ["instructed", "affirmed_not_instructed"];
  for (let i = 0; i < opts.numClean; i++) {
    const allocationId = `${blockTradeId}-CLEAN-${i}`;
    const quantity = 100 + Math.floor(rand() * 900);
    const price = Math.round((20 + rand() * 80) * 100) / 100;
    events.push({
      type: "ALLOCATION_CREATED",
      allocationId,
      blockTradeId,
      account: `ACCT-CLEAN-${i}`,
      side: i % 2 === 0 ? "BUY" : "SELL",
      symbol,
      quantity,
      price,
      tradeDate: opts.tradeDate,
      cutoffIso: opts.cutoffIso,
      occurredAt: opts.createdAtIso,
    });
    const scenario = cleanScenarios[i % cleanScenarios.length];
    events.push(
      ...buildLifecycleEvents({
        allocationId,
        quantity,
        price,
        cutoffIso: opts.cutoffIso,
        createdAtIso: opts.createdAtIso,
        scenario,
        activityAtIso: opts.activityAtIso,
      })
    );
    cleanAllocationIds.push(allocationId);
  }

  return { events, breachAllocationIds, cleanAllocationIds };
}
