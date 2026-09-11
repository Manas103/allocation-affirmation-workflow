import express, { Express } from "express";
import { Pool } from "pg";
import { ensureSchema } from "../store/schema.js";
import { appendEvent, appendEventsBatch } from "../store/eventStore.js";
import { LiveStateProjector, LiveOrderProjector } from "../store/liveProjector.js";
import { fanOutBlockTrade, BlockTradeSpec } from "../domain/fanOut.js";
import { blockingFieldFor, isAtRisk } from "../domain/blockingField.js";
import { computeCutoffEscalations } from "../domain/cutoffSweep.js";
import { AllocationEvent } from "../domain/types.js";
import { OrderEvent } from "../domain/orderTypes.js";
import { PositionBook } from "../domain/positionBook.js";
import { runPreTradeChecks } from "../domain/preTradeCompliance.js";
import { allocateProRata, AccountWeight } from "../domain/proRataAllocator.js";
import { RESTRICTED_SYMBOLS, CONCENTRATION_LIMIT_PCT } from "../seed/orderSeed.js";

export interface AppDeps {
  pool: Pool;
  projector: LiveStateProjector;
  orderProjector?: LiveOrderProjector;
  // Every account referenced by an order routed through /orders/:id/pretrade-check
  // must have an entry here (BUILDER.md's "keep positions deterministic and
  // real enough for the checks to be real"). A small default demo book is
  // supplied so the console's own demo flow (the ACCT-DEMO-* accounts) has
  // somewhere to check pre-trade compliance against out of the box.
  positionBook?: PositionBook;
  restrictedSymbols?: ReadonlySet<string>;
  concentrationLimitPct?: number;
}

function defaultDemoPositionBook(): PositionBook {
  const book: PositionBook = new Map();
  for (const account of ["ACCT-DEMO-1", "ACCT-DEMO-2", "ACCT-DEMO-3", "ACCT-DEMO-4"]) {
    book.set(account, { account, cash: 10_000_000, bookValue: 10_000_000, holdings: {} });
  }
  return book;
}

export function buildApp({
  pool,
  projector,
  orderProjector = new LiveOrderProjector(),
  positionBook = defaultDemoPositionBook(),
  restrictedSymbols = RESTRICTED_SYMBOLS,
  concentrationLimitPct = CONCENTRATION_LIMIT_PCT,
}: AppDeps): Express {
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

  // The front half of the lifecycle: creation -> pre-trade compliance ->
  // release -> fill. Every route below appends to the SAME append-only log
  // as the allocation routes above (store/eventStore.ts, one table), so a
  // single audit trail covers order creation through client-account
  // allocation. See domain/lifecycleEvent.ts for how the two id spaces (an
  // order id, an allocation id) share that one table.
  app.post("/orders", async (req, res) => {
    try {
      const body = req.body;
      const event: OrderEvent = {
        type: "ORDER_CREATED",
        orderId: body.orderId,
        account: body.account,
        side: body.side,
        symbol: body.symbol,
        quantity: body.quantity,
        referencePrice: body.referencePrice,
        occurredAt: body.occurredAt ?? new Date().toISOString(),
      };
      await appendEvent(pool, event);
      const view = orderProjector.apply(event);
      res.status(201).json(view);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/orders/:id/pretrade-check", async (req, res) => {
    const view = orderProjector.get(req.params.id);
    if (!view) {
      res.status(404).json({ error: `unknown order ${req.params.id}` });
      return;
    }
    const account = positionBook.get(view.account);
    if (!account) {
      res.status(400).json({ error: `no position book entry for account ${view.account}` });
      return;
    }
    const result = runPreTradeChecks(
      { symbol: view.symbol, side: view.side, quantity: view.quantity, referencePrice: view.referencePrice },
      account,
      restrictedSymbols,
      concentrationLimitPct
    );
    const occurredAt: string = req.body?.occurredAt ?? new Date().toISOString();
    const event: OrderEvent = result.passed
      ? { type: "PRETRADE_CHECK_PASSED", orderId: view.orderId, occurredAt }
      : {
          type: "PRETRADE_CHECK_FAILED",
          orderId: view.orderId,
          rule: result.rule,
          failingInput: result.failingInput,
          occurredAt,
        };
    await appendEvent(pool, event);
    const next = orderProjector.apply(event);
    res.json({ ...next, preTradeResult: result });
  });

  app.post("/orders/:id/release", async (req, res) => {
    const view = orderProjector.get(req.params.id);
    if (!view) {
      res.status(404).json({ error: `unknown order ${req.params.id}` });
      return;
    }
    if (view.state !== "pretrade_passed") {
      res.status(400).json({ error: `order ${view.orderId} is ${view.state}, not pretrade_passed; cannot release` });
      return;
    }
    const event: OrderEvent = {
      type: "ORDER_RELEASED",
      orderId: view.orderId,
      occurredAt: req.body?.occurredAt ?? new Date().toISOString(),
    };
    await appendEvent(pool, event);
    res.json(orderProjector.apply(event));
  });

  // Fills the order, then immediately allocates the filled quantity across
  // client accounts by target weight via the pro-rata allocator and appends
  // one ALLOCATION_CREATED per account, joining the existing
  // allocated -> confirmed -> affirmed -> instructed chain from there. This
  // is the one place the two halves of the lifecycle actually meet.
  app.post("/orders/:id/fill", async (req, res) => {
    const view = orderProjector.get(req.params.id);
    if (!view) {
      res.status(404).json({ error: `unknown order ${req.params.id}` });
      return;
    }
    if (view.state !== "released") {
      res.status(400).json({ error: `order ${view.orderId} is ${view.state}, not released; cannot fill` });
      return;
    }
    try {
      const { filledQuantity, fillPrice, tradeDate, cutoffIso } = req.body;
      const weights: AccountWeight[] = req.body.weights;
      const occurredAt: string = req.body.occurredAt ?? new Date().toISOString();

      const fillEvent: OrderEvent = {
        type: "ORDER_FILLED",
        orderId: view.orderId,
        filledQuantity,
        fillPrice,
        occurredAt,
      };
      await appendEvent(pool, fillEvent);
      const filledView = orderProjector.apply(fillEvent);

      const perAccountQty = allocateProRata(filledQuantity, weights);
      const allocationEvents: AllocationEvent[] = Object.entries(perAccountQty).map(([account, quantity]) => ({
        type: "ALLOCATION_CREATED",
        allocationId: `${view.orderId}-${account}`,
        blockTradeId: view.orderId,
        account,
        side: view.side,
        symbol: view.symbol,
        quantity,
        price: fillPrice,
        tradeDate,
        cutoffIso,
        occurredAt,
      }));
      await appendEventsBatch(pool, allocationEvents);
      projector.applyMany(allocationEvents);

      res.status(201).json({
        order: filledView,
        allocationIds: allocationEvents.map((e) => (e as { allocationId: string }).allocationId),
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/orders", (_req, res) => {
    res.json(orderProjector.all());
  });

  app.get("/orders/:id", (req, res) => {
    const view = orderProjector.get(req.params.id);
    if (!view) {
      res.status(404).json({ error: `unknown order ${req.params.id}` });
      return;
    }
    res.json(view);
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

  // A small, fixed demo of the front half of the lifecycle, kept separate
  // from /demo/seed above so it can never change that route's at-risk count:
  // one order that clears every pre-trade gate and is released and filled
  // into two client-account allocations (both instructed immediately, so
  // neither one is ever at risk), and one order rejected for trading a
  // restricted symbol.
  app.post("/demo/seed-orders", async (req, res) => {
    const nowIso = new Date().toISOString();
    const futureCutoff = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const tradeDate = nowIso.slice(0, 10);

    const cleanOrderCreated: OrderEvent = {
      type: "ORDER_CREATED",
      orderId: "DEMO-ORDER-CLEAN",
      account: "ACCT-DEMO-1",
      side: "BUY",
      symbol: "DEMO",
      quantity: 1000,
      referencePrice: 25,
      occurredAt: nowIso,
    };
    await appendEvent(pool, cleanOrderCreated);
    orderProjector.apply(cleanOrderCreated);

    const cleanCheck = runPreTradeChecks(
      { symbol: "DEMO", side: "BUY", quantity: 1000, referencePrice: 25 },
      positionBook.get("ACCT-DEMO-1")!,
      restrictedSymbols,
      concentrationLimitPct
    );
    const cleanPassedEvent: OrderEvent = cleanCheck.passed
      ? { type: "PRETRADE_CHECK_PASSED", orderId: "DEMO-ORDER-CLEAN", occurredAt: nowIso }
      : {
          type: "PRETRADE_CHECK_FAILED",
          orderId: "DEMO-ORDER-CLEAN",
          rule: cleanCheck.rule,
          failingInput: cleanCheck.failingInput,
          occurredAt: nowIso,
        };
    await appendEvent(pool, cleanPassedEvent);
    orderProjector.apply(cleanPassedEvent);

    const releasedEvent: OrderEvent = { type: "ORDER_RELEASED", orderId: "DEMO-ORDER-CLEAN", occurredAt: nowIso };
    await appendEvent(pool, releasedEvent);
    orderProjector.apply(releasedEvent);

    const filledEvent: OrderEvent = {
      type: "ORDER_FILLED",
      orderId: "DEMO-ORDER-CLEAN",
      filledQuantity: 1000,
      fillPrice: 25,
      occurredAt: nowIso,
    };
    await appendEvent(pool, filledEvent);
    orderProjector.apply(filledEvent);

    const perAccountQty = allocateProRata(1000, [
      { account: "ACCT-DEMO-A", weight: 0.6 },
      { account: "ACCT-DEMO-B", weight: 0.4 },
    ]);
    const allocationEvents: AllocationEvent[] = Object.entries(perAccountQty).map(([account, quantity]) => ({
      type: "ALLOCATION_CREATED",
      allocationId: `DEMO-ORDER-CLEAN-${account}`,
      blockTradeId: "DEMO-ORDER-CLEAN",
      account,
      side: "BUY",
      symbol: "DEMO",
      quantity,
      price: 25,
      tradeDate,
      cutoffIso: futureCutoff,
      occurredAt: nowIso,
    }));
    await appendEventsBatch(pool, allocationEvents);
    projector.applyMany(allocationEvents);

    const restrictedOrderCreated: OrderEvent = {
      type: "ORDER_CREATED",
      orderId: "DEMO-ORDER-RESTRICTED",
      account: "ACCT-DEMO-2",
      side: "BUY",
      symbol: [...restrictedSymbols][0],
      quantity: 100,
      referencePrice: 10,
      occurredAt: nowIso,
    };
    await appendEvent(pool, restrictedOrderCreated);
    orderProjector.apply(restrictedOrderCreated);

    const restrictedCheck = runPreTradeChecks(
      { symbol: restrictedOrderCreated.symbol, side: "BUY", quantity: 100, referencePrice: 10 },
      positionBook.get("ACCT-DEMO-2")!,
      restrictedSymbols,
      concentrationLimitPct
    );
    const rejectedEvent: OrderEvent = restrictedCheck.passed
      ? { type: "PRETRADE_CHECK_PASSED", orderId: "DEMO-ORDER-RESTRICTED", occurredAt: nowIso }
      : {
          type: "PRETRADE_CHECK_FAILED",
          orderId: "DEMO-ORDER-RESTRICTED",
          rule: restrictedCheck.rule,
          failingInput: restrictedCheck.failingInput,
          occurredAt: nowIso,
        };
    await appendEvent(pool, rejectedEvent);
    orderProjector.apply(rejectedEvent);

    res.status(201).json({
      orderIds: ["DEMO-ORDER-CLEAN", "DEMO-ORDER-RESTRICTED"],
      allocationIds: allocationEvents.map((e) => (e as { allocationId: string }).allocationId),
    });
  });

  return app;
}

export async function bootstrapApp(deps: AppDeps): Promise<Express> {
  await ensureSchema(deps.pool);
  return buildApp(deps);
}
