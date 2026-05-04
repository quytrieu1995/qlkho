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

type Customer = {
  id: string;
  full_name: string;
  phone: string;
  email: string;
  address: string;
  updated_at: string;
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

type InventoryTransaction = {
  id: string;
  type: "in" | "out" | "adjust";
  quantity: number;
  reference_code: string;
  product_name: string;
  sku: string;
  created_at: string;
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
  if (
    normalized.includes("xac nhan") ||
    normalized.includes("xác nhận") ||
    normalized.includes("đã xác nhận") ||
    normalized.includes("confirm") ||
    normalized.includes("done")
  ) {
    return "badge success";
  }
  if (normalized.includes("huy") || normalized.includes("hủy") || normalized.includes("cancel") || normalized.includes("fail")) {
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
    throw new Error(`Yêu cầu thất bại, mã lỗi ${response.status}`);
  }
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
    throw new Error(text || `Yêu cầu thất bại, mã lỗi ${response.status}`);
  }
  return (await response.json()) as T;
}

type ModuleId = "dashboard" | "products" | "customers" | "inventory" | "users";

export function App() {
  const [metrics, setMetrics] = useState<Metric | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [inventoryTx, setInventoryTx] = useState<InventoryTransaction[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [token, setToken] = useState<string>(() => localStorage.getItem("qlkho_token") ?? "");
  const [activeModule, setActiveModule] = useState<ModuleId>("dashboard");
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [formMsg, setFormMsg] = useState("");

  const [productForm, setProductForm] = useState({
    sku: "",
    name: "",
    category: "",
    unitPrice: 0,
    stock: 0
  });
  const [customerForm, setCustomerForm] = useState({
    fullName: "",
    phone: "",
    email: "",
    address: ""
  });
  const [inventoryForm, setInventoryForm] = useState({
    productId: "",
    quantity: 1,
    referenceCode: "",
    note: "",
    mode: "inbound"
  });
  const [userForm, setUserForm] = useState({
    username: "",
    password: "",
    role: "sales"
  });

  const sortedLowStock = useMemo(
    () => products.filter((item) => item.stock <= 5).sort((a, b) => a.stock - b.stock).slice(0, 10),
    [products]
  );

  const canManageUsers = currentUser?.role === "admin";
  const canManageInventory = currentUser?.role === "admin" || currentUser?.role === "kho";
  const canManageCatalog = currentUser?.role === "admin" || currentUser?.role === "kho";
  const canManageCustomers = currentUser?.role === "admin" || currentUser?.role === "sales";

  const refresh = async () => {
    if (!token) {
      return;
    }
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
    if (!token) {
      return;
    }
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
    if (!token || !currentUser) {
      return;
    }
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, 10_000);
    return () => clearInterval(interval);
  }, [token, currentUser]);

  useEffect(() => {
    if (!token) {
      return;
    }
    const ws = new WebSocket(`${SOCKET_URL.replace("https://", "wss://").replace("http://", "ws://")}/ws`);
    ws.onmessage = (event) => {
      setEvents((prev) => [event.data, ...prev].slice(0, 12));
      void refresh();
    };
    ws.onerror = () => setError("Mất kết nối WebSocket realtime. Vui lòng kiểm tra tuyến /ws.");
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
        throw new Error(`Đăng nhập thất bại (${response.status}).`);
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
    setCustomers([]);
    setInventoryTx([]);
    setUsers([]);
    setEvents([]);
    setCurrentUser(null);
  };

  const submitProduct = async () => {
    if (!token) return;
    try {
      await mutateJson("/v1/products", token, "POST", productForm);
      setFormMsg("Tạo sản phẩm thành công.");
      setProductForm({ sku: "", name: "", category: "", unitPrice: 0, stock: 0 });
      await refresh();
    } catch (err) {
      setFormMsg(String(err));
    }
  };

  const submitCustomer = async () => {
    if (!token) return;
    try {
      await mutateJson("/v1/customers", token, "POST", customerForm);
      setFormMsg("Tạo khách hàng thành công.");
      setCustomerForm({ fullName: "", phone: "", email: "", address: "" });
      await refresh();
    } catch (err) {
      setFormMsg(String(err));
    }
  };

  const submitInventory = async () => {
    if (!token) return;
    try {
      const endpoint = inventoryForm.mode === "inbound" ? "/v1/inventory/inbound" : "/v1/inventory/outbound";
      await mutateJson(endpoint, token, "POST", {
        productId: inventoryForm.productId,
        quantity: Number(inventoryForm.quantity),
        referenceCode: inventoryForm.referenceCode,
        note: inventoryForm.note
      });
      setFormMsg("Cập nhật kho thành công.");
      setInventoryForm({ productId: "", quantity: 1, referenceCode: "", note: "", mode: "inbound" });
      await refresh();
    } catch (err) {
      setFormMsg(String(err));
    }
  };

  const submitUser = async () => {
    if (!token) return;
    try {
      await mutateJson("/v1/users", token, "POST", userForm);
      setFormMsg("Tạo người dùng thành công.");
      setUserForm({ username: "", password: "", role: "sales" });
      await refresh();
    } catch (err) {
      setFormMsg(String(err));
    }
  };

  const toggleUserActive = async (item: User) => {
    if (!token) return;
    await mutateJson(`/v1/users/${item.id}`, token, "PATCH", { isActive: !item.is_active });
    await refresh();
  };

  const renderModule = () => {
    if (activeModule === "dashboard") {
      return (
        <>
          <section className="metrics-grid">
            <article className="metric-card">
              <p className="metric-title">Đơn hôm nay</p>
              <strong>{metrics?.todayOrders ?? 0}</strong>
              <span className="metric-subtitle">Xử lý trong 24 giờ</span>
            </article>
            <article className="metric-card">
              <p className="metric-title">Doanh thu hom nay</p>
              <strong>{formatCurrency(metrics?.todayRevenue ?? 0)}</strong>
              <span className="metric-subtitle">Tổng giá trị đơn hàng</span>
            </article>
            <article className="metric-card">
              <p className="metric-title">Sản phẩm cần nhập</p>
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
                      <th>Khách hàng</th>
                      <th>Trang thai</th>
                      <th>Gia tri</th>
                      <th>Cập nhật</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((order) => (
                      <tr key={order.id}>
                        <td>{order.order_code}</td>
                        <td>{order.customer_name || "Khách lẻ"}</td>
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
            <pre className="event-log">{events.join("\n") || "Chưa có sự kiện realtime"}</pre>
          </section>
        </>
      );
    }

    if (activeModule === "products") {
      return (
        <section className="module-grid">
          <article className="panel">
            <div className="panel-header">
              <h2>Danh sách sản phẩm</h2>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Ten</th>
                    <th>Danh muc</th>
                    <th>Gia</th>
                    <th>Ton</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((item) => (
                    <tr key={item.id}>
                      <td>{item.sku}</td>
                      <td>{item.name}</td>
                      <td>{item.category}</td>
                      <td>{formatCurrency(Number(item.unit_price))}</td>
                      <td>{item.stock}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
          <article className="panel form-panel">
            <h2>Thêm sản phẩm</h2>
            {canManageCatalog ? (
              <>
                <input placeholder="SKU" value={productForm.sku} onChange={(e) => setProductForm((prev) => ({ ...prev, sku: e.target.value }))} />
                <input placeholder="Ten san pham" value={productForm.name} onChange={(e) => setProductForm((prev) => ({ ...prev, name: e.target.value }))} />
                <input placeholder="Danh muc" value={productForm.category} onChange={(e) => setProductForm((prev) => ({ ...prev, category: e.target.value }))} />
                <input
                  placeholder="Gia"
                  type="number"
                  value={productForm.unitPrice}
                  onChange={(e) => setProductForm((prev) => ({ ...prev, unitPrice: Number(e.target.value) }))}
                />
                <input
                  placeholder="Ton kho ban dau"
                  type="number"
                  value={productForm.stock}
                  onChange={(e) => setProductForm((prev) => ({ ...prev, stock: Number(e.target.value) }))}
                />
                <button className="primary-btn" onClick={submitProduct}>
                  Lưu sản phẩm
                </button>
              </>
            ) : (
              <p className="muted">Vai trò hiện tại không có quyền tạo/cập nhật sản phẩm.</p>
            )}
          </article>
        </section>
      );
    }

    if (activeModule === "customers") {
      return (
        <section className="module-grid">
          <article className="panel">
            <div className="panel-header">
              <h2>Danh sách khách hàng</h2>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Ten</th>
                    <th>Điện thoại</th>
                    <th>Email</th>
                    <th>Địa chỉ</th>
                  </tr>
                </thead>
                <tbody>
                  {customers.map((item) => (
                    <tr key={item.id}>
                      <td>{item.full_name}</td>
                      <td>{item.phone}</td>
                      <td>{item.email}</td>
                      <td>{item.address}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
          <article className="panel form-panel">
            <h2>Thêm khách hàng</h2>
            {canManageCustomers ? (
              <>
                <input placeholder="Ho ten" value={customerForm.fullName} onChange={(e) => setCustomerForm((prev) => ({ ...prev, fullName: e.target.value }))} />
                <input placeholder="So dien thoai" value={customerForm.phone} onChange={(e) => setCustomerForm((prev) => ({ ...prev, phone: e.target.value }))} />
                <input placeholder="Email" value={customerForm.email} onChange={(e) => setCustomerForm((prev) => ({ ...prev, email: e.target.value }))} />
                <input placeholder="Địa chỉ" value={customerForm.address} onChange={(e) => setCustomerForm((prev) => ({ ...prev, address: e.target.value }))} />
                <button className="primary-btn" onClick={submitCustomer}>
                  Lưu khách hàng
                </button>
              </>
            ) : (
              <p className="muted">Vai trò hiện tại không có quyền tạo khách hàng.</p>
            )}
          </article>
        </section>
      );
    }

    if (activeModule === "inventory") {
      return (
        <section className="module-grid">
          <article className="panel">
            <div className="panel-header">
              <h2>Lịch sử nhập xuất kho</h2>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Loai</th>
                    <th>SKU</th>
                    <th>Sản phẩm</th>
                    <th>Số lượng</th>
                    <th>Ma tham chieu</th>
                    <th>Thời gian</th>
                  </tr>
                </thead>
                <tbody>
                  {inventoryTx.map((item) => (
                    <tr key={item.id}>
                      <td>{item.type}</td>
                      <td>{item.sku}</td>
                      <td>{item.product_name}</td>
                      <td>{item.quantity}</td>
                      <td>{item.reference_code}</td>
                      <td>{formatDateTime(item.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
          <article className="panel form-panel">
            <h2>Nhập / Xuất kho</h2>
            <select value={inventoryForm.mode} onChange={(e) => setInventoryForm((prev) => ({ ...prev, mode: e.target.value }))}>
              <option value="inbound">Nhập kho</option>
              <option value="outbound">Xuất kho</option>
            </select>
            <select value={inventoryForm.productId} onChange={(e) => setInventoryForm((prev) => ({ ...prev, productId: e.target.value }))}>
              <option value="">Chọn sản phẩm</option>
              {products.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.sku} - {item.name}
                </option>
              ))}
            </select>
            <input
              type="number"
              value={inventoryForm.quantity}
              onChange={(e) => setInventoryForm((prev) => ({ ...prev, quantity: Number(e.target.value) }))}
              placeholder="Số lượng"
            />
            <input
              value={inventoryForm.referenceCode}
              onChange={(e) => setInventoryForm((prev) => ({ ...prev, referenceCode: e.target.value }))}
              placeholder="Ma tham chieu"
            />
            <input value={inventoryForm.note} onChange={(e) => setInventoryForm((prev) => ({ ...prev, note: e.target.value }))} placeholder="Ghi chu" />
            <button className="primary-btn" onClick={submitInventory} disabled={!canManageInventory && currentUser?.role !== "sales"}>
              Cập nhật kho
            </button>
          </article>
        </section>
      );
    }

    return (
      <section className="module-grid">
        <article className="panel">
          <div className="panel-header">
            <h2>Danh sách người dùng</h2>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tên đăng nhập</th>
                  <th>Vai trò</th>
                  <th>Trang thai</th>
                  <th>Thao tac</th>
                </tr>
              </thead>
              <tbody>
                {users.map((item) => (
                  <tr key={item.id}>
                    <td>{item.username}</td>
                    <td>{item.role}</td>
                    <td>{item.is_active ? "Active" : "Inactive"}</td>
                    <td>
                      <button className="ghost-btn" onClick={() => void toggleUserActive(item)}>
                        {item.is_active ? "Disable" : "Enable"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
        <article className="panel form-panel">
          <h2>Tạo tài khoản</h2>
          {canManageUsers ? (
            <>
              <input value={userForm.username} onChange={(e) => setUserForm((prev) => ({ ...prev, username: e.target.value }))} placeholder="Username" />
              <input
                type="password"
                value={userForm.password}
                onChange={(e) => setUserForm((prev) => ({ ...prev, password: e.target.value }))}
                placeholder="Password"
              />
              <select value={userForm.role} onChange={(e) => setUserForm((prev) => ({ ...prev, role: e.target.value }))}>
                <option value="sales">sales</option>
                <option value="kho">kho</option>
                <option value="admin">admin</option>
              </select>
              <button className="primary-btn" onClick={submitUser}>
                Tạo người dùng
              </button>
            </>
          ) : (
            <p className="muted">Chi admin moi co quyen quan tri nguoi dung.</p>
          )}
        </article>
      </section>
    );
  };

  if (!token) {
    return (
      <main className="auth-page">
        <section className="auth-panel">
          <div className="auth-brand">
            <p className="eyebrow">Nền tảng QLKho</p>
            <h1>Trung tâm Bán hàng và Kho</h1>
            <p>Quản lý bán hàng realtime, đồng bộ nhanh.vn, theo dõi tồn kho tức thì.</p>
          </div>
        </section>
        <section className="auth-card">
          <h2>Đăng nhập hệ thống</h2>
          <p>Sử dụng tài khoản có vai trò admin, sales hoặc kho.</p>
          <label>
            Tên đăng nhập
            <input value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label>
            Mật khẩu
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          <button className="primary-btn" onClick={login}>
            Đăng nhập
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
          <p className="eyebrow">Vận hành thời gian thực</p>
          <h1>Dashboard quản lý bán hàng</h1>
          <p className="muted">Đồng bộ nhanh.vn qua webhook và queue async.</p>
        </div>
        <button className="ghost-btn" onClick={logout}>
          Đăng xuất
        </button>
      </header>

      <nav className="module-nav">
        {[
          { id: "dashboard", label: "Tổng quan" },
          { id: "products", label: "Sản phẩm" },
          { id: "customers", label: "Khách hàng" },
          { id: "inventory", label: "Kho" },
          { id: "users", label: "Người dùng" }
        ].map((item) => (
          <button
            key={item.id}
            className={`tab-btn ${activeModule === item.id ? "active" : ""}`}
            onClick={() => setActiveModule(item.id as ModuleId)}
            disabled={item.id === "users" && !canManageUsers}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {error ? <p className="error banner">{error}</p> : null}
      {formMsg ? <p className="muted">{formMsg}</p> : null}
      {renderModule()}
    </main>
  );
}
