import { Pool } from "pg";

// The append-only log. This is the single source of truth: nothing about an
// allocation is ever stored anywhere else in durable form. `seq` gives a
// total order across all allocations, which is what the rebuild oracle
// replays in.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS allocation_events (
  seq BIGSERIAL PRIMARY KEY,
  allocation_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_allocation_events_allocation_id
  ON allocation_events (allocation_id);
`;

export async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
}
