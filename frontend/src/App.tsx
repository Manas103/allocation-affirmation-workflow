import { useEffect, useState } from "react";

// The backend base URL is injected at dev/build time via VITE_API_BASE (see
// README "Building and running"). This is the operations console: it shows
// every at-risk allocation and, for each one, the exact field blocking it,
// straight from GET /allocations/at-risk, which already computes
// blockingField from the same domain logic the backend uses to decide
// escalation (src/domain/blockingField.ts). The console never guesses; it
// only ever displays what the API already named.
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

interface AtRiskAllocation {
  allocationId: string;
  blockTradeId: string;
  account: string;
  symbol: string;
  quantity: number;
  state: string;
  escalated: boolean;
  blockingField: string | null;
}

export function App() {
  const [rows, setRows] = useState<AtRiskAllocation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const res = await fetch(`${API_BASE}/allocations/at-risk?now=${encodeURIComponent(new Date().toISOString())}`);
      if (!res.ok) throw new Error(`GET /allocations/at-risk -> ${res.status}`);
      const data = (await res.json()) as AtRiskAllocation[];
      setRows(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <main>
      <h1>At-risk allocations</h1>
      <p>
        Every row below is past its trade-date affirmation cutoff, or already escalated, and not yet affirmed. The
        "Blocking field" column names the exact field the operations desk needs to chase, not a generic "at risk"
        flag.
      </p>
      <button onClick={load}>Refresh</button>
      {loading && <p data-testid="loading">Loading...</p>}
      {error && <p role="alert">Failed to load: {error}</p>}
      <table>
        <thead>
          <tr>
            <th>Allocation</th>
            <th>Account</th>
            <th>Symbol</th>
            <th>Qty</th>
            <th>State</th>
            <th>Escalated</th>
            <th>Blocking field</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.allocationId} data-testid="at-risk-row">
              <td>{row.allocationId}</td>
              <td>{row.account}</td>
              <td>{row.symbol}</td>
              <td>{row.quantity}</td>
              <td>{row.state}</td>
              <td>{row.escalated ? "yes" : "no"}</td>
              <td data-testid="blocking-field">{row.blockingField ?? "(none)"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!loading && rows.length === 0 && !error && <p>No at-risk allocations.</p>}
    </main>
  );
}
