import express, { Express } from "express";
import { Pool } from "pg";
import { ensureSchema } from "../store/schema.js";
import { appendEvent, appendEventsBatch } from "../store/eventStore.js";
import { LiveStateProjector } from "../store/liveProjector.js";
import { fanOutBlockTrade, BlockTradeSpec } from "../domain/fanOut.js";
import { blockingFieldFor, isAtRisk } from "../domain/blockingField.js";
import { computeCutoffEscalations } from "../domain/cutoffSweep.js";
import { AllocationEvent } from "../domain/types.js";

export interface AppDeps {
  pool: Pool;
  projector: LiveStateProjector;
}

export function buildApp({ pool, projector }: AppDeps): Express {
  const app = express();
  app.use(express.json());
  // The React console runs on Vite's own dev-server origin, a different
  // origin from this API's own dynamically-assigned port (both ports are
  // chosen freely at start, never fixed, per BUILDER.md section 3a), so a
  // permissive CORS header is what makes local development and the
  // Playwright console test work at all. Everything served here is
  // synthetic demo data; there is nothing behind this API a wildcard origin
  // puts at risk.
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/block-trades", async (req, res) => {
    try {
      const spec = req.body as BlockTradeSpec;
      const events = fanOutBlockTrade(spec);
      await appendEventsBatch(pool, events);
      projector.applyMany(events);
      res.status(201).json({ allocationIds: events.map((e) => (e as any).allocationId) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/allocations/:id/broker-confirmation", async (req, res) => {
    await handleLifecycleEvent(res, {
      type: "BROKER_CONFIRMATION_RECEIVED",
      allocationId: req.params.id,
      confirmedQuantity: req.body.confirmedQuantity,
      confirmedPrice: req.body.confirmedPrice,
      occurredAt: req.body.occurredAt ?? new Date().toISOString(),
    });
  });

  app.post("/allocations/:id/custodian-affirmation", async (req, res) => {
    await handleLifecycleEvent(res, {
      type: "CUSTODIAN_AFFIRMATION_RECEIVED",
      allocationId: req.params.id,
      occurredAt: req.body.occurredAt ?? new Date().toISOString(),
    });
  });

  app.post("/allocations/:id/settlement-instruction", async (req, res) => {
    await handleLifecycleEvent(res, {
      type: "SETTLEMENT_INSTRUCTION_SENT",
      allocationId: req.params.id,
      occurredAt: req.body.occurredAt ?? new Date().toISOString(),
    });
  });

  async function handleLifecycleEvent(res: express.Response, event: AllocationEvent) {
    try {
      if (!projector.get(event.allocationId)) {
        res.status(404).json({ error: `unknown allocation ${event.allocationId}` });
        return;
      }
      await appendEvent(pool, event);
      const next = projector.apply(event);
      res.json(next);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }

  app.post("/cutoff-sweep", async (req, res) => {
    const nowIso: string = req.body?.nowIso ?? new Date().toISOString();
    const escalations = computeCutoffEscalations(projector.all(), nowIso);
    await appendEventsBatch(pool, escalations);
    projector.applyMany(escalations);
    res.json({ nowIso, escalatedAllocationIds: escalations.map((e) => e.allocationId) });
  });

  app.get("/allocations", (_req, res) => {
    res.json(projector.all());
  });

  app.get("/allocations/at-risk", (req, res) => {
    const nowIso = typeof req.query.now === "string" ? req.query.now : new Date().toISOString();
    const atRisk = projector
      .all()
      .filter((view) => isAtRisk(view, nowIso))
      .map((view) => ({ ...view, blockingField: blockingFieldFor(view) }));
    res.json(atRisk);
  });

  app.get("/allocations/:id", (req, res) => {
    const view = projector.get(req.params.id);
    if (!view) {
      res.status(404).json({ error: `unknown allocation ${req.params.id}` });
      return;
    }
    res.json({ ...view, blockingField: blockingFieldFor(view) });
  });

  // A small, fixed demo dataset for local development and for the Playwright
  // console test: one allocation stuck on each of the named blocking fields,
  // one clean instructed allocation, and one that is past its own (very
  // near) cutoff so the console has something genuinely escalated to show.
  app.post("/demo/seed", async (req, res) => {
    const nowIso = new Date().toISOString();
    const soonCutoff = new Date(Date.now() + 60_000).toISOString(); // 1 minute out
    const pastCutoff = new Date(Date.now() - 60_000).toISOString(); // already missed
    const tradeDate = nowIso.slice(0, 10);

    const events: AllocationEvent[] = [];

    // Missing broker confirmation, not yet at risk (cutoff still ahead).
    events.push({
      type: "ALLOCATION_CREATED",
      allocationId: "DEMO-MISSING-CONFIRMATION",
      blockTradeId: "DEMO-BLK-1",
      account: "ACCT-DEMO-1",
      side: "BUY",
      symbol: "DEMO",
      quantity: 500,
      price: 101.25,
      tradeDate,
      cutoffIso: soonCutoff,
      occurredAt: nowIso,
    });

    // Quantity mismatch, already past cutoff: escalated.
    events.push({
      type: "ALLOCATION_CREATED",
      allocationId: "DEMO-QTY-MISMATCH",
      blockTradeId: "DEMO-BLK-1",
      account: "ACCT-DEMO-2",
      side: "BUY",
      symbol: "DEMO",
      quantity: 500,
      price: 101.25,
      tradeDate,
      cutoffIso: pastCutoff,
      occurredAt: nowIso,
    });
    events.push({
      type: "BROKER_CONFIRMATION_RECEIVED",
      allocationId: "DEMO-QTY-MISMATCH",
      confirmedQuantity: 499,
      confirmedPrice: 101.25,
      occurredAt: nowIso,
    });

    // Missing custodian affirmation, already past cutoff: escalated.
    events.push({
      type: "ALLOCATION_CREATED",
      allocationId: "DEMO-MISSING-AFFIRMATION",
      blockTradeId: "DEMO-BLK-1",
      account: "ACCT-DEMO-3",
      side: "SELL",
      symbol: "DEMO",
      quantity: 750,
      price: 55.5,
      tradeDate,
      cutoffIso: pastCutoff,
      occurredAt: nowIso,
    });
    events.push({
      type: "BROKER_CONFIRMATION_RECEIVED",
      allocationId: "DEMO-MISSING-AFFIRMATION",
      confirmedQuantity: 750,
      confirmedPrice: 55.5,
      occurredAt: nowIso,
    });

    // Fully clean, instructed well ahead of its own cutoff.
    events.push({
      type: "ALLOCATION_CREATED",
      allocationId: "DEMO-CLEAN-INSTRUCTED",
      blockTradeId: "DEMO-BLK-1",
      account: "ACCT-DEMO-4",
      side: "SELL",
      symbol: "DEMO",
      quantity: 250,
      price: 20,
      tradeDate,
      cutoffIso: soonCutoff,
      occurredAt: nowIso,
    });
    events.push({
      type: "BROKER_CONFIRMATION_RECEIVED",
      allocationId: "DEMO-CLEAN-INSTRUCTED",
      confirmedQuantity: 250,
      confirmedPrice: 20,
      occurredAt: nowIso,
    });
    events.push({
      type: "CUSTODIAN_AFFIRMATION_RECEIVED",
      allocationId: "DEMO-CLEAN-INSTRUCTED",
      occurredAt: nowIso,
    });
    events.push({
      type: "SETTLEMENT_INSTRUCTION_SENT",
      allocationId: "DEMO-CLEAN-INSTRUCTED",
      occurredAt: nowIso,
    });

    await appendEventsBatch(pool, events);
    projector.applyMany(events);

    const sweepNow = new Date().toISOString();
    const escalations = computeCutoffEscalations(projector.all(), sweepNow);
    await appendEventsBatch(pool, escalations);
    projector.applyMany(escalations);

    res.status(201).json({
      allocationIds: [
        "DEMO-MISSING-CONFIRMATION",
        "DEMO-QTY-MISMATCH",
        "DEMO-MISSING-AFFIRMATION",
        "DEMO-CLEAN-INSTRUCTED",
      ],
      escalatedAllocationIds: escalations.map((e) => e.allocationId),
    });
  });

  return app;
}

export async function bootstrapApp(deps: AppDeps): Promise<Express> {
  await ensureSchema(deps.pool);
  return buildApp(deps);
}
