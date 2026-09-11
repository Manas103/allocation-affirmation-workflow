import { Pool } from "pg";

// The append-only log. This is the single source of truth: nothing about an
// order or an allocation is ever stored anywhere else in durable form.
// `entity_id` is deliberately generic, not `allocation_id`: an order's own
// events (creation, pre-trade compliance, release, fill) and the
// ALLOCATION_CREATED events its fill produces both live in this one table,
// keyed by whichever id (an order id or an allocation id) the event belongs
// to, so one sequential scan is the whole audit trail end to end. `seq`
// gives a total order across the whole log, which is what the rebuild
// oracle replays in.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS allocation_events (
  seq BIGSERIAL PRIMARY KEY,
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_allocation_events_entity_id
  ON allocation_events (entity_id);
`;

export async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
}
