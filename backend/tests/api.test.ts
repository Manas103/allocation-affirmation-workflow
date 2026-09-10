import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { Express } from "express";
import { createPool } from "../src/store/pool.js";
import { LiveStateProjector } from "../src/store/liveProjector.js";
import { bootstrapApp } from "../src/api/server.js";

// pg-mem (via createPool with no DATABASE_URL set) so this test exercises the
// real SQL in schema.ts/eventStore.ts end to end without depending on a real
// Postgres being reachable in this environment (BUILDER.md section 3).
describe("API: block-trade fan-out, lifecycle, cutoff sweep, at-risk console feed", () => {
  let app: Express;

  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    const pool = createPool();
    const projector = new LiveStateProjector();
    app = await bootstrapApp({ pool, projector });
  });

  it("fans a block trade into one allocation per account", async () => {
    const res = await request(app)
      .post("/block-trades")
      .send({
        blockTradeId: "BLK-API-1",
        symbol: "ACME",
        side: "BUY",
        tradeDate: "2026-09-10",
        cutoffIso: "2026-09-10T21:00:00.000Z",
        totalQuantity: 300,
        price: 25,
        accounts: ["A", "B", "C"],
      });
    expect(res.status).toBe(201);
    expect(res.body.allocationIds).toHaveLength(3);
  });

  it("drives an allocation through the full state machine via the API", async () => {
    await request(app)
      .post("/block-trades")
      .send({
        blockTradeId: "BLK-API-2",
        symbol: "ACME",
        side: "BUY",
        tradeDate: "2026-09-10",
        cutoffIso: "2026-09-10T21:00:00.000Z",
        totalQuantity: 100,
        price: 50,
        accounts: ["ONLY"],
      });
    const id = "BLK-API-2-ONLY";

    await request(app).post(`/allocations/${id}/broker-confirmation`).send({ confirmedQuantity: 100, confirmedPrice: 50 });
    await request(app).post(`/allocations/${id}/custodian-affirmation`).send({});
    const res = await request(app).post(`/allocations/${id}/settlement-instruction`).send({});

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("instructed");
  });

  it("names the exact blocking field for an at-risk allocation via /allocations/at-risk", async () => {
    await request(app)
      .post("/block-trades")
      .send({
        blockTradeId: "BLK-API-3",
        symbol: "ACME",
        side: "SELL",
        tradeDate: "2026-09-10",
        cutoffIso: "2020-01-01T00:00:00.000Z", // already in the past
        totalQuantity: 100,
        price: 50,
        accounts: ["STUCK"],
      });

    const res = await request(app).get("/allocations/at-risk").query({ now: "2026-09-10T00:00:00.000Z" });
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.allocationId === "BLK-API-3-STUCK");
    expect(row).toBeDefined();
    expect(row.blockingField).toBe("missing broker confirmation");
  });

  it("escalates a past-cutoff allocation via /cutoff-sweep and never re-escalates a clean one", async () => {
    await request(app)
      .post("/block-trades")
      .send({
        blockTradeId: "BLK-API-4",
        symbol: "ACME",
        side: "BUY",
        tradeDate: "2026-09-10",
        cutoffIso: "2020-01-01T00:00:00.000Z",
        totalQuantity: 100,
        price: 50,
        accounts: ["BREACH"],
      });
    await request(app)
      .post("/block-trades")
      .send({
        blockTradeId: "BLK-API-4",
        symbol: "ACME",
        side: "BUY",
        tradeDate: "2026-09-10",
        cutoffIso: "2099-01-01T00:00:00.000Z",
        totalQuantity: 100,
        price: 50,
        accounts: ["CLEAN"],
      });

    const sweep = await request(app).post("/cutoff-sweep").send({ nowIso: "2026-09-10T00:00:00.000Z" });
    expect(sweep.body.escalatedAllocationIds).toContain("BLK-API-4-BREACH");
    expect(sweep.body.escalatedAllocationIds).not.toContain("BLK-API-4-CLEAN");
  });

  it("returns 404 for a lifecycle event on an unknown allocation rather than fabricating one", async () => {
    const res = await request(app).post("/allocations/NOPE/broker-confirmation").send({ confirmedQuantity: 1, confirmedPrice: 1 });
    expect(res.status).toBe(404);
  });
});
