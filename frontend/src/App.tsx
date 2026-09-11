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

interface OrderRow {
  orderId: string;
  account: string;
  symbol: string;
  quantity: number;
  state: string;
  rejectionRule: string | null;
  rejectionDetail: string | null;
}

export function App() {
  const [rows, setRows] = useState<AtRiskAllocation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [ordersError, setOrdersError] = useState<string | null>(null);

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

  // The order-lifecycle section is deliberately independent of the at-risk
  // load above: it never touches `rows`, `error`, or `loading`, so a failure
  // here can never affect the at-risk feed this console originally shipped
  // with.
  async function loadOrders() {
    try {
      const res = await fetch(`${API_BASE}/orders`);
      if (!res.ok) throw new Error(`GET /orders -> ${res.status}`);
      const data = (await res.json()) as OrderRow[];
      setOrders(data);
      setOrdersError(null);
    } catch (err) {
      setOrdersError((err as Error).message);
    }
  }

  useEffect(() => {
    load();
    loadOrders();
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

      <h2>Order lifecycle</h2>
      <p>
        The front half of the same audit trail: creation, pre-trade compliance, release and fill, each one an event
        on the same append-only log the allocations above are read from. A rejected order names the exact rule and
        input that failed it.
      </p>
      <button onClick={loadOrders}>Refresh orders</button>
      {ordersError && <p role="alert">Failed to load orders: {ordersError}</p>}
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Account</th>
            <th>Symbol</th>
            <th>Qty</th>
            <th>State</th>
            <th>Rejection</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <tr key={order.orderId} data-testid="order-row">
              <td>{order.orderId}</td>
              <td>{order.account}</td>
              <td>{order.symbol}</td>
              <td>{order.quantity}</td>
              <td>{order.state}</td>
              <td data-testid="order-rejection">
                {order.rejectionRule ? `${order.rejectionRule}: ${order.rejectionDetail}` : "(none)"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {orders.length === 0 && !ordersError && <p>No orders yet.</p>}
    </main>
  );
}
