import { Pool } from "pg";
import { AllocationEvent } from "../domain/types.js";

// A pool.query-shaped subset is all this module needs, so it also accepts a
// transactional client acquired from pool.connect().
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export async function appendEvent(db: Queryable, event: AllocationEvent): Promise<void> {
  await db.query(
    `INSERT INTO allocation_events (allocation_id, event_type, payload, occurred_at)
     VALUES ($1, $2, $3, $4)`,
    [event.allocationId, event.type, JSON.stringify(event), event.occurredAt]
  );
}

// Chunked multi-row insert. This is the only concession this project makes
// for the 250,000-allocation scale benchmark: one round trip per event would
// make that benchmark take an unreasonable amount of wall clock time against
// an in-process SQL engine, so events belonging to a bulk seed are grouped
// into VALUES lists of `batchSize` rows. Each row inserted is still the same
// row a single appendEvent call would have produced; nothing about the log's
// shape or content changes.
export async function appendEventsBatch(
  db: Queryable,
  events: AllocationEvent[],
  batchSize = 2000
): Promise<void> {
  for (let start = 0; start < events.length; start += batchSize) {
    const chunk = events.slice(start, start + batchSize);
    const values: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((event, i) => {
      const base = i * 4;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      params.push(event.allocationId, event.type, JSON.stringify(event), event.occurredAt);
    });
    await db.query(
      `INSERT INTO allocation_events (allocation_id, event_type, payload, occurred_at)
       VALUES ${values.join(", ")}`,
      params
    );
  }
}

function parsePayload(row: { payload: unknown }): AllocationEvent {
  const raw = row.payload;
  return typeof raw === "string" ? (JSON.parse(raw) as AllocationEvent) : (raw as AllocationEvent);
}

export async function getAllEventsOrdered(db: Queryable): Promise<AllocationEvent[]> {
  const res = await db.query(`SELECT payload FROM allocation_events ORDER BY seq ASC`);
  return res.rows.map(parsePayload);
}

export async function getEventsForAllocation(
  db: Queryable,
  allocationId: string
): Promise<AllocationEvent[]> {
  const res = await db.query(
    `SELECT payload FROM allocation_events WHERE allocation_id = $1 ORDER BY seq ASC`,
    [allocationId]
  );
  return res.rows.map(parsePayload);
}

export async function countEvents(db: Queryable): Promise<number> {
  const res = await db.query(`SELECT COUNT(*)::int AS n FROM allocation_events`);
  return res.rows[0].n as number;
}
