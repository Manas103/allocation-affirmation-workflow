import { createPool } from "./dist/store/pool.js";
import { ensureSchema } from "./dist/store/schema.js";
import { appendEventsBatch, getAllEventsOrdered, countEvents } from "./dist/store/eventStore.js";

function makeEvents(n) {
  const events = [];
  for (let i = 0; i < n; i++) {
    events.push({
      type: "ALLOCATION_CREATED",
      allocationId: `A${i}`,
      blockTradeId: `B${Math.floor(i / 50)}`,
      account: `ACCT-${i}`,
      side: i % 2 === 0 ? "BUY" : "SELL",
      symbol: "TST",
      quantity: 100 + i,
      price: 10.5,
      tradeDate: "2026-09-10",
      cutoffIso: "2026-09-10T20:00:00.000Z",
      occurredAt: "2026-09-10T14:00:00.000Z",
    });
  }
  return events;
}

const pool = createPool();
await ensureSchema(pool);
const N = 500000;
const events = makeEvents(N);
console.log(`generated ${N} events`);

let t0 = Date.now();
await appendEventsBatch(pool, events, 2000);
console.log(`insert ${N} rows: ${Date.now() - t0}ms`);

t0 = Date.now();
const c = await countEvents(pool);
console.log(`count=${c} in ${Date.now() - t0}ms`);

t0 = Date.now();
const all = await getAllEventsOrdered(pool);
console.log(`read back ${all.length} rows: ${Date.now() - t0}ms`);

await pool.end();
