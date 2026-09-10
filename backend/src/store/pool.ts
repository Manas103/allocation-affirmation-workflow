import { Pool } from "pg";
import { newDb } from "pg-mem";

// Postgres is not installed as a service on this machine (see BUILDER.md
// section 3). Rather than making every run depend on a database Manas would
// have to stand up by hand, this project defaults to pg-mem: a real,
// in-process SQL engine that implements enough of the Postgres wire
// semantics (schemas, transactions, JSONB, indexes) that the exact same
// application code and the exact same SQL run against it as would run
// against a real Postgres. That is the difference between this and a fake
// in-memory store: the SQL in schema.ts and eventStore.ts is real SQL,
// parsed and executed, not bypassed.
//
// Set DATABASE_URL to point at a real Postgres 14+ instance to run this
// against one (see README "Building and running" for the exact `psql`
// bootstrap and connection string shape). Every code path above this module
// is identical either way.
export function createPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (url) {
    return new Pool({ connectionString: url });
  }
  const memDb = newDb({ autoCreateForeignKeyIndices: true });
  memDb.public.registerFunction({
    name: "now",
    returns: "timestamptz" as any,
    implementation: () => new Date(),
  });
  const adapter = memDb.adapters.createPg();
  const pool = new adapter.Pool();
  return pool as unknown as Pool;
}

export async function isRealPostgresReachable(): Promise<boolean> {
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 1500 });
  try {
    await pool.query("SELECT 1");
    await pool.end();
    return true;
  } catch {
    await pool.end().catch(() => {});
    return false;
  }
}
