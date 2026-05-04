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

function formatCurrency(value: number): string {
  return `${value.toLocaleString("vi-VN")} VND`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(date);
}

function getStatusClass(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes("xac nhan") || normalized.includes("confirm") || normalized.includes("done")) {
    return "badge success";
  }
  if (normalized.includes("huy") || normalized.includes("cancel") || normalized.includes("fail")) {
    return "badge danger";
  }
  return "badge warning";
}

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
      <main className="auth-page">
        <section className="auth-panel">
          <div className="auth-brand">
            <p className="eyebrow">QLKho Platform</p>
            <h1>Sales and Inventory Hub</h1>
            <p>Quan ly ban hang realtime, dong bo nhanh.vn, theo doi ton kho tuc thi.</p>
          </div>
        </section>
        <section className="auth-card">
          <h2>Dang nhap he thong</h2>
          <p>Su dung tai khoan co role admin, sales hoac kho.</p>
          <label>
            Username
            <input value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          <button className="primary-btn" onClick={login}>
            Dang nhap
          </button>
          {error ? <p className="error">{error}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="dashboard">
      <header className="topbar">
        <div>
          <p className="eyebrow">Realtime Operations</p>
          <h1>Dashboard quan ly ban hang</h1>
          <p className="muted">Dong bo nhanh.vn qua webhook va queue async.</p>
        </div>
        <button className="ghost-btn" onClick={logout}>
          Dang xuat
        </button>
      </header>

      {error ? <p className="error banner">{error}</p> : null}

      <section className="metrics-grid">
        <article className="metric-card">
          <p className="metric-title">Don hom nay</p>
          <strong>{metrics?.todayOrders ?? 0}</strong>
          <span className="metric-subtitle">Xu ly trong 24 gio</span>
        </article>
        <article className="metric-card">
          <p className="metric-title">Doanh thu hom nay</p>
          <strong>{formatCurrency(metrics?.todayRevenue ?? 0)}</strong>
          <span className="metric-subtitle">Tong gia tri don hang</span>
        </article>
        <article className="metric-card">
          <p className="metric-title">San pham can nhap</p>
          <strong>{metrics?.lowStockProducts ?? 0}</strong>
          <span className="metric-subtitle">Ton kho &lt;= 5</span>
        </article>
        <article className="metric-card">
          <p className="metric-title">Hang doi dong bo</p>
          <strong>{metrics?.pendingSyncJobs ?? 0}</strong>
          <span className="metric-subtitle">Queue dang cho xu ly</span>
        </article>
      </section>

      <section className="content-grid">
        <article className="panel large">
          <div className="panel-header">
            <h2>Don hang moi nhat</h2>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ma don</th>
                  <th>Khach hang</th>
                  <th>Trang thai</th>
                  <th>Gia tri</th>
                  <th>Cap nhat</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id}>
                    <td>{order.order_code}</td>
                    <td>{order.customer_name || "Khach le"}</td>
                    <td>
                      <span className={getStatusClass(order.status)}>{order.status}</span>
                    </td>
                    <td>{formatCurrency(Number(order.total_amount))}</td>
                    <td>{formatDateTime(order.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>

        <article className="panel">
          <div className="panel-header">
            <h2>Canh bao ton kho thap</h2>
          </div>
          <ul className="stock-list">
            {sortedLowStock.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>{item.sku}</strong>
                  <p>{item.name}</p>
                </div>
                <span className={item.stock <= 2 ? "badge danger" : "badge warning"}>{item.stock}</span>
              </li>
            ))}
          </ul>
        </article>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Su kien realtime</h2>
        </div>
        <pre className="event-log">{events.join("\n") || "No events yet"}</pre>
      </section>
    </main>
  );
}
