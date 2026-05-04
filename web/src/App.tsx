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
  category: string;
  unit_price: number;
};

type Customer = {
  id: string;
  full_name: string;
  phone: string;
  email: string;
  address: string;
};

type InventoryTransaction = {
  id: string;
  type: "in" | "out" | "adjust";
  sku: string;
  product_name: string;
  quantity: number;
  reference_code: string;
  created_at: string;
};

type User = {
  id: string;
  username: string;
  role: "admin" | "sales" | "kho";
  is_active: boolean;
};

type CurrentUser = {
  id: string;
  username: string;
  role: "admin" | "sales" | "kho";
};

type ModuleId = "dashboard" | "products" | "customers" | "inventory" | "users";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? "ws://localhost:4000";

function formatCurrency(value: number): string {
  return `${value.toLocaleString("vi-VN")} VND`;
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(parsed);
}

function statusClass(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes("xác") || normalized.includes("confirm") || normalized.includes("done")) return "badge success";
  if (normalized.includes("hủy") || normalized.includes("cancel") || normalized.includes("fail")) return "badge danger";
  return "badge warning";
}

async function fetchJson<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`Yêu cầu thất bại (${response.status}).`);
  return (await response.json()) as T;
}

async function mutateJson<T>(path: string, token: string, method: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Yêu cầu thất bại (${response.status}).`);
  }
  return (await response.json()) as T;
}

export function App() {
  const [token, setToken] = useState<string>(() => localStorage.getItem("qlkho_token") ?? "");
  const [activeModule, setActiveModule] = useState<ModuleId>("dashboard");
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");

  const [metrics, setMetrics] = useState<Metric | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [inventoryTx, setInventoryTx] = useState<InventoryTransaction[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [events, setEvents] = useState<string[]>([]);

  const [productForm, setProductForm] = useState({ sku: "", name: "", category: "", unitPrice: 0, stock: 0 });
  const [customerForm, setCustomerForm] = useState({ fullName: "", phone: "", email: "", address: "" });
  const [inventoryForm, setInventoryForm] = useState({
    mode: "inbound",
    productId: "",
    quantity: 1,
    referenceCode: "",
    note: ""
  });
  const [userForm, setUserForm] = useState({ username: "", password: "", role: "sales" });

  const canManageUsers = currentUser?.role === "admin";
  const canManageCatalog = currentUser?.role === "admin" || currentUser?.role === "kho";
  const canManageCustomers = currentUser?.role === "admin" || currentUser?.role === "sales";

  const lowStock = useMemo(() => products.filter((item) => item.stock <= 5).slice(0, 8), [products]);

  const refresh = async () => {
    if (!token) return;
    try {
      const [metricData, orderData, productData, customerData, txData] = await Promise.all([
        fetchJson<Metric>("/v1/dashboard", token),
        fetchJson<Order[]>("/v1/orders?limit=20", token),
        fetchJson<Product[]>("/v1/products?limit=200", token),
        fetchJson<Customer[]>("/v1/customers?limit=200", token),
        fetchJson<InventoryTransaction[]>("/v1/inventory/transactions?limit=80", token)
      ]);
      setMetrics(metricData);
      setOrders(orderData);
      setProducts(productData);
      setCustomers(customerData);
      setInventoryTx(txData);
      if (canManageUsers) {
        const userData = await fetchJson<User[]>("/v1/users", token);
        setUsers(userData);
      }
      setError("");
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    if (!token) return;
    void (async () => {
      try {
        const me = await fetchJson<{ user: CurrentUser }>("/v1/auth/me", token);
        setCurrentUser(me.user);
      } catch {
        logout();
      }
    })();
  }, [token]);

  useEffect(() => {
    if (!token || !currentUser) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => clearInterval(timer);
  }, [token, currentUser]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!token) return;
    const ws = new WebSocket(`${SOCKET_URL.replace("https://", "wss://").replace("http://", "ws://")}/ws`);
    ws.onmessage = (event) => {
      setEvents((prev) => [event.data, ...prev].slice(0, 20));
      void refresh();
    };
    ws.onerror = () => setError("Mất kết nối realtime, vui lòng tải lại trang.");
    return () => ws.close();
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const login = async () => {
    try {
      const response = await fetch(`${API_BASE}/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      if (!response.ok) throw new Error(`Đăng nhập thất bại (${response.status}).`);
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
    setCurrentUser(null);
    setMetrics(null);
    setOrders([]);
    setProducts([]);
    setCustomers([]);
    setInventoryTx([]);
    setUsers([]);
    setEvents([]);
  };

  const createProduct = async () => {
    if (!token) return;
    try {
      await mutateJson("/v1/products", token, "POST", productForm);
      setNotice("Đã tạo sản phẩm mới.");
      setProductForm({ sku: "", name: "", category: "", unitPrice: 0, stock: 0 });
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const createCustomer = async () => {
    if (!token) return;
    try {
      await mutateJson("/v1/customers", token, "POST", customerForm);
      setNotice("Đã tạo khách hàng mới.");
      setCustomerForm({ fullName: "", phone: "", email: "", address: "" });
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const createInventoryTx = async () => {
    if (!token) return;
    try {
      const endpoint = inventoryForm.mode === "inbound" ? "/v1/inventory/inbound" : "/v1/inventory/outbound";
      await mutateJson(endpoint, token, "POST", {
        productId: inventoryForm.productId,
        quantity: Number(inventoryForm.quantity),
        referenceCode: inventoryForm.referenceCode,
        note: inventoryForm.note
      });
      setNotice("Đã ghi nhận giao dịch kho.");
      setInventoryForm({ mode: "inbound", productId: "", quantity: 1, referenceCode: "", note: "" });
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const createUser = async () => {
    if (!token) return;
    try {
      await mutateJson("/v1/users", token, "POST", userForm);
      setNotice("Đã tạo người dùng.");
      setUserForm({ username: "", password: "", role: "sales" });
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const toggleUser = async (item: User) => {
    if (!token) return;
    await mutateJson(`/v1/users/${item.id}`, token, "PATCH", { isActive: !item.is_active });
    await refresh();
  };

  if (!token) {
    return (
      <main className="auth-shell">
        <section className="auth-hero">
          <p className="hero-tag">QLKho Commerce</p>
          <h1>Nền tảng quản trị bán hàng hiện đại</h1>
          <p>Tập trung toàn bộ vận hành sản phẩm, khách hàng, kho và đồng bộ realtime trong một giao diện cao cấp.</p>
        </section>
        <section className="auth-card">
          <h2>Đăng nhập hệ thống</h2>
          <p>Vui lòng đăng nhập bằng tài khoản đã được cấp quyền.</p>
          <label>Tên đăng nhập</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
          <label>Mật khẩu</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className="primary-btn" onClick={login}>Đăng nhập</button>
          {error ? <p className="alert error">{error}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <h2>QLKho</h2>
        <p className="text-muted">Xin chào, {currentUser?.username ?? "user"}</p>
        <nav className="side-nav">
          {[
            { id: "dashboard", label: "Tổng quan" },
            { id: "products", label: "Sản phẩm" },
            { id: "customers", label: "Khách hàng" },
            { id: "inventory", label: "Kho vận" },
            { id: "users", label: "Người dùng", hidden: !canManageUsers }
          ]
            .filter((item) => !item.hidden)
            .map((item) => (
              <button
                key={item.id}
                className={`nav-item ${activeModule === item.id ? "active" : ""}`}
                onClick={() => setActiveModule(item.id as ModuleId)}
              >
                {item.label}
              </button>
            ))}
        </nav>
        <button className="ghost-btn full" onClick={logout}>Đăng xuất</button>
      </aside>

      <section className="content-shell">
        <header className="content-head">
          <div>
            <p className="hero-tag">Vận hành thương mại điện tử</p>
            <h1>
              {activeModule === "dashboard" && "Tổng quan vận hành"}
              {activeModule === "products" && "Quản lý sản phẩm"}
              {activeModule === "customers" && "Quản lý khách hàng"}
              {activeModule === "inventory" && "Quản lý kho vận"}
              {activeModule === "users" && "Quản lý người dùng"}
            </h1>
          </div>
          <button className="ghost-btn" onClick={() => void refresh()}>Làm mới dữ liệu</button>
        </header>

        {error ? <p className="alert error">{error}</p> : null}
        {notice ? <p className="alert success">{notice}</p> : null}

        {activeModule === "dashboard" && (
          <>
            <section className="kpi-grid">
              <article className="kpi-card"><p>Đơn hôm nay</p><strong>{metrics?.todayOrders ?? 0}</strong></article>
              <article className="kpi-card"><p>Doanh thu hôm nay</p><strong>{formatCurrency(metrics?.todayRevenue ?? 0)}</strong></article>
              <article className="kpi-card"><p>Tồn kho thấp</p><strong>{metrics?.lowStockProducts ?? 0}</strong></article>
              <article className="kpi-card"><p>Hàng đợi sync</p><strong>{metrics?.pendingSyncJobs ?? 0}</strong></article>
            </section>

            <section className="page-grid">
              <article className="card wide">
                <header className="card-head"><h2>Đơn hàng mới nhất</h2></header>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>Mã đơn</th><th>Khách hàng</th><th>Trạng thái</th><th>Giá trị</th><th>Cập nhật</th></tr>
                    </thead>
                    <tbody>
                      {orders.map((item) => (
                        <tr key={item.id}>
                          <td>{item.order_code}</td>
                          <td>{item.customer_name || "Khách lẻ"}</td>
                          <td><span className={statusClass(item.status)}>{item.status}</span></td>
                          <td>{formatCurrency(Number(item.total_amount))}</td>
                          <td>{formatDate(item.updated_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>

              <article className="card">
                <header className="card-head"><h2>Tồn kho cần nhập</h2></header>
                <ul className="simple-list">
                  {lowStock.map((item) => (
                    <li key={item.id}>
                      <div><strong>{item.sku}</strong><p>{item.name}</p></div>
                      <span className={item.stock <= 2 ? "badge danger" : "badge warning"}>{item.stock}</span>
                    </li>
                  ))}
                </ul>
              </article>
            </section>

            <section className="card">
              <header className="card-head"><h2>Realtime events</h2></header>
              <pre className="event-log">{events.join("\n") || "Chưa có sự kiện."}</pre>
            </section>
          </>
        )}

        {activeModule === "products" && (
          <section className="page-grid">
            <article className="card wide">
              <header className="card-head"><h2>Danh sách sản phẩm</h2></header>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>SKU</th><th>Tên</th><th>Danh mục</th><th>Đơn giá</th><th>Tồn</th></tr>
                  </thead>
                  <tbody>
                    {products.map((item) => (
                      <tr key={item.id}><td>{item.sku}</td><td>{item.name}</td><td>{item.category}</td><td>{formatCurrency(Number(item.unit_price))}</td><td>{item.stock}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
            <article className="card">
              <header className="card-head"><h2>Thêm sản phẩm</h2></header>
              {canManageCatalog ? (
                <>
                  <input placeholder="SKU" value={productForm.sku} onChange={(e) => setProductForm((p) => ({ ...p, sku: e.target.value }))} />
                  <input placeholder="Tên sản phẩm" value={productForm.name} onChange={(e) => setProductForm((p) => ({ ...p, name: e.target.value }))} />
                  <input placeholder="Danh mục" value={productForm.category} onChange={(e) => setProductForm((p) => ({ ...p, category: e.target.value }))} />
                  <input type="number" placeholder="Đơn giá" value={productForm.unitPrice} onChange={(e) => setProductForm((p) => ({ ...p, unitPrice: Number(e.target.value) }))} />
                  <input type="number" placeholder="Tồn kho ban đầu" value={productForm.stock} onChange={(e) => setProductForm((p) => ({ ...p, stock: Number(e.target.value) }))} />
                  <button className="primary-btn" onClick={createProduct}>Lưu sản phẩm</button>
                </>
              ) : (
                <p className="text-muted">Bạn không có quyền thao tác sản phẩm.</p>
              )}
            </article>
          </section>
        )}

        {activeModule === "customers" && (
          <section className="page-grid">
            <article className="card wide">
              <header className="card-head"><h2>Danh sách khách hàng</h2></header>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Họ tên</th><th>Điện thoại</th><th>Email</th><th>Địa chỉ</th></tr>
                  </thead>
                  <tbody>
                    {customers.map((item) => (
                      <tr key={item.id}><td>{item.full_name}</td><td>{item.phone}</td><td>{item.email}</td><td>{item.address}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
            <article className="card">
              <header className="card-head"><h2>Thêm khách hàng</h2></header>
              {canManageCustomers ? (
                <>
                  <input placeholder="Họ tên" value={customerForm.fullName} onChange={(e) => setCustomerForm((p) => ({ ...p, fullName: e.target.value }))} />
                  <input placeholder="Số điện thoại" value={customerForm.phone} onChange={(e) => setCustomerForm((p) => ({ ...p, phone: e.target.value }))} />
                  <input placeholder="Email" value={customerForm.email} onChange={(e) => setCustomerForm((p) => ({ ...p, email: e.target.value }))} />
                  <input placeholder="Địa chỉ" value={customerForm.address} onChange={(e) => setCustomerForm((p) => ({ ...p, address: e.target.value }))} />
                  <button className="primary-btn" onClick={createCustomer}>Lưu khách hàng</button>
                </>
              ) : (
                <p className="text-muted">Bạn không có quyền thao tác khách hàng.</p>
              )}
            </article>
          </section>
        )}

        {activeModule === "inventory" && (
          <section className="page-grid">
            <article className="card wide">
              <header className="card-head"><h2>Lịch sử nhập xuất kho</h2></header>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Loại</th><th>SKU</th><th>Sản phẩm</th><th>Số lượng</th><th>Mã tham chiếu</th><th>Thời gian</th></tr>
                  </thead>
                  <tbody>
                    {inventoryTx.map((item) => (
                      <tr key={item.id}>
                        <td>{item.type}</td>
                        <td>{item.sku}</td>
                        <td>{item.product_name}</td>
                        <td>{item.quantity}</td>
                        <td>{item.reference_code}</td>
                        <td>{formatDate(item.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
            <article className="card">
              <header className="card-head"><h2>Tạo giao dịch kho</h2></header>
              <select value={inventoryForm.mode} onChange={(e) => setInventoryForm((p) => ({ ...p, mode: e.target.value }))}>
                <option value="inbound">Nhập kho</option>
                <option value="outbound">Xuất kho</option>
              </select>
              <select value={inventoryForm.productId} onChange={(e) => setInventoryForm((p) => ({ ...p, productId: e.target.value }))}>
                <option value="">Chọn sản phẩm</option>
                {products.map((item) => (
                  <option key={item.id} value={item.id}>{item.sku} - {item.name}</option>
                ))}
              </select>
              <input type="number" value={inventoryForm.quantity} onChange={(e) => setInventoryForm((p) => ({ ...p, quantity: Number(e.target.value) }))} placeholder="Số lượng" />
              <input value={inventoryForm.referenceCode} onChange={(e) => setInventoryForm((p) => ({ ...p, referenceCode: e.target.value }))} placeholder="Mã tham chiếu" />
              <input value={inventoryForm.note} onChange={(e) => setInventoryForm((p) => ({ ...p, note: e.target.value }))} placeholder="Ghi chú" />
              <button className="primary-btn" onClick={createInventoryTx}>Lưu giao dịch</button>
            </article>
          </section>
        )}

        {activeModule === "users" && (
          <section className="page-grid">
            <article className="card wide">
              <header className="card-head"><h2>Danh sách người dùng</h2></header>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Tên đăng nhập</th><th>Vai trò</th><th>Trạng thái</th><th>Thao tác</th></tr>
                  </thead>
                  <tbody>
                    {users.map((item) => (
                      <tr key={item.id}>
                        <td>{item.username}</td>
                        <td>{item.role}</td>
                        <td>{item.is_active ? "Hoạt động" : "Khóa"}</td>
                        <td><button className="ghost-btn" onClick={() => void toggleUser(item)}>{item.is_active ? "Khóa" : "Mở khóa"}</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
            <article className="card">
              <header className="card-head"><h2>Tạo người dùng</h2></header>
              {canManageUsers ? (
                <>
                  <input placeholder="Tên đăng nhập" value={userForm.username} onChange={(e) => setUserForm((p) => ({ ...p, username: e.target.value }))} />
                  <input type="password" placeholder="Mật khẩu" value={userForm.password} onChange={(e) => setUserForm((p) => ({ ...p, password: e.target.value }))} />
                  <select value={userForm.role} onChange={(e) => setUserForm((p) => ({ ...p, role: e.target.value }))}>
                    <option value="sales">sales</option>
                    <option value="kho">kho</option>
                    <option value="admin">admin</option>
                  </select>
                  <button className="primary-btn" onClick={createUser}>Lưu người dùng</button>
                </>
              ) : (
                <p className="text-muted">Chỉ admin có quyền thao tác module này.</p>
              )}
            </article>
          </section>
        )}
      </section>
    </main>
  );
}
