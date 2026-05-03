import { useEffect, useMemo, useState } from "react";

type Metric = {
  todayOrders: number;
  todayRevenue: number;
  lowStockProducts: number;
  pendingSyncJobs: number;
};

type Order = {
  id: string;
  order_code: string;
  status: string;
  total_amount: number;
  customer_name: string;
  updated_at: string;
};

type Product = {
  id: string;
  sku: string;
  name: string;
  stock: number;
  unit_price: number;
  updated_at: string;
};

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? "ws://localhost:4000";

async function fetchJson<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    throw new Error(`Failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

export function App() {
  const [metrics, setMetrics] = useState<Metric | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [token, setToken] = useState<string>(() => localStorage.getItem("qlkho_token") ?? "");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");

  const sortedLowStock = useMemo(
    () => products.filter((item) => item.stock <= 5).sort((a, b) => a.stock - b.stock).slice(0, 10),
    [products]
  );

  const refresh = async () => {
    if (!token) {
      return;
    }
    try {
      const [metricData, orderData, productData] = await Promise.all([
        fetchJson<Metric>("/v1/dashboard", token),
        fetchJson<Order[]>("/v1/orders?limit=20", token),
        fetchJson<Product[]>("/v1/products?limit=50", token)
      ]);
      setMetrics(metricData);
      setOrders(orderData);
      setProducts(productData);
      setError("");
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    if (!token) {
      return;
    }
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, 10_000);
    return () => clearInterval(interval);
  }, [token]);

  useEffect(() => {
    if (!token) {
      return;
    }
    const ws = new WebSocket(`${SOCKET_URL.replace("https://", "wss://").replace("http://", "ws://")}/ws`);
    ws.onmessage = (event) => {
      setEvents((prev) => [event.data, ...prev].slice(0, 12));
      void refresh();
    };
    ws.onerror = () => setError("WebSocket disconnected. Check API route /ws.");
    return () => ws.close();
  }, [token]);

  const login = async () => {
    try {
      const response = await fetch(`${API_BASE}/v1/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ username, password })
      });
      if (!response.ok) {
        throw new Error(`Login failed ${response.status}`);
      }
      const data = (await response.json()) as { token: string };
      setToken(data.token);
      localStorage.setItem("qlkho_token", data.token);
      setPassword("");
      setError("");
    } catch (err) {
      setError(String(err));
    }
  };

  const logout = () => {
    localStorage.removeItem("qlkho_token");
    setToken("");
    setMetrics(null);
    setOrders([]);
    setProducts([]);
    setEvents([]);
  };

  if (!token) {
    return (
      <main className="container">
        <header>
          <h1>QLKho Login</h1>
          <p>Dang nhap tai khoan co role admin/sales/kho.</p>
        </header>
        <article className="login">
          <label>
            Username
            <input value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          <button onClick={login}>Login</button>
          {error ? <p className="error">{error}</p> : null}
        </article>
      </main>
    );
  }

  return (
    <main className="container">
      <header>
        <h1>Sales Management Realtime</h1>
        <p>Dong bo nhanh.vn qua webhook va queue async.</p>
        <button onClick={logout}>Logout</button>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <section className="grid metrics">
        <article>
          <h2>Orders Today</h2>
          <strong>{metrics?.todayOrders ?? 0}</strong>
        </article>
        <article>
          <h2>Revenue Today</h2>
          <strong>{(metrics?.todayRevenue ?? 0).toLocaleString()} VND</strong>
        </article>
        <article>
          <h2>Low Stock SKUs</h2>
          <strong>{metrics?.lowStockProducts ?? 0}</strong>
        </article>
        <article>
          <h2>Pending Sync</h2>
          <strong>{metrics?.pendingSyncJobs ?? 0}</strong>
        </article>
      </section>

      <section className="grid">
        <article>
          <h2>Latest Orders</h2>
          <ul>
            {orders.map((order) => (
              <li key={order.id}>
                <span>{order.order_code}</span>
                <span>{order.status}</span>
                <span>{Number(order.total_amount).toLocaleString()} VND</span>
              </li>
            ))}
          </ul>
        </article>

        <article>
          <h2>Low Stock Products</h2>
          <ul>
            {sortedLowStock.map((item) => (
              <li key={item.id}>
                <span>{item.sku}</span>
                <span>{item.name}</span>
                <span className={item.stock <= 2 ? "critical" : ""}>{item.stock}</span>
              </li>
            ))}
          </ul>
        </article>
      </section>

      <section>
        <h2>Realtime Events</h2>
        <pre>{events.join("\n") || "No events yet"}</pre>
      </section>
    </main>
  );
}
