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
  source: string;
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

type Shipping = {
  id: string;
  shipping_code: string;
  order_id: string | null;
  order_code?: string;
  customer_name?: string;
  carrier: string;
  service_level: string;
  status: string;
  shipping_fee: number;
  cod_amount: number;
  recipient_name: string;
  recipient_phone: string;
  recipient_address: string;
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

type ModuleId = "dashboard" | "products" | "customers" | "inventory" | "orders" | "shipping" | "users";
type ModalId = "product" | "customer" | "inventorySingle" | "inventoryBulk" | "inventoryAdjust" | "order" | "shipping" | "user";

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
  if (normalized.includes("xác") || normalized.includes("confirm") || normalized.includes("done") || normalized.includes("deliver")) {
    return "badge success";
  }
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
  const [activeModal, setActiveModal] = useState<ModalId | null>(null);
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
  const [shippings, setShippings] = useState<Shipping[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [events, setEvents] = useState<string[]>([]);

  const [editingProductId, setEditingProductId] = useState("");
  const [editingCustomerId, setEditingCustomerId] = useState("");
  const [productForm, setProductForm] = useState({ sku: "", name: "", category: "", unitPrice: 0, stock: 0 });
  const [customerForm, setCustomerForm] = useState({ fullName: "", phone: "", email: "", address: "" });
  const [inventoryForm, setInventoryForm] = useState({
    mode: "inbound",
    productId: "",
    quantity: 1,
    referenceCode: "",
    note: ""
  });
  const [inventoryBulkForm, setInventoryBulkForm] = useState({
    mode: "in",
    referenceCode: "",
    note: "",
    lines: [{ productId: "", quantity: 1, unitCost: 0 }]
  });
  const [inventoryAdjustForm, setInventoryAdjustForm] = useState({
    referenceCode: "",
    note: "",
    lines: [{ productId: "", targetStock: 0 }]
  });
  const [orderForm, setOrderForm] = useState({
    customerId: "",
    source: "local",
    status: "new",
    lines: [{ productId: "", quantity: 1, unitPrice: 0 }]
  });
  const [shippingForm, setShippingForm] = useState({
    orderId: "",
    shippingCode: "",
    carrier: "",
    serviceLevel: "",
    recipientName: "",
    recipientPhone: "",
    recipientAddress: "",
    shippingFee: 0,
    codAmount: 0,
    note: ""
  });
  const [userForm, setUserForm] = useState({ username: "", password: "", role: "sales" });

  const canManageUsers = currentUser?.role === "admin";
  const canManageCatalog = currentUser?.role === "admin" || currentUser?.role === "kho";
  const canManageCustomers = currentUser?.role === "admin" || currentUser?.role === "sales";
  const canManageOrders = currentUser?.role === "admin" || currentUser?.role === "sales";
  const canManageShipping = currentUser?.role === "admin" || currentUser?.role === "sales";

  const lowStock = useMemo(() => products.filter((item) => item.stock <= 5).slice(0, 8), [products]);

  const refresh = async () => {
    if (!token) return;
    try {
      const [metricData, orderData, productData, customerData, txData, shippingData] = await Promise.all([
        fetchJson<Metric>("/v1/dashboard", token),
        fetchJson<Order[]>("/v1/orders?limit=50", token),
        fetchJson<Product[]>("/v1/products?limit=300", token),
        fetchJson<Customer[]>("/v1/customers?limit=300", token),
        fetchJson<InventoryTransaction[]>("/v1/inventory/transactions?limit=120", token),
        fetchJson<Shipping[]>("/v1/shippings?limit=120", token)
      ]);
      setMetrics(metricData);
      setOrders(orderData);
      setProducts(productData);
      setCustomers(customerData);
      setInventoryTx(txData);
      setShippings(shippingData);
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

  useEffect(() => {
    if (!activeModal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActiveModal(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeModal]);

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
    setShippings([]);
    setUsers([]);
    setEvents([]);
  };

  const upsertProduct = async () => {
    if (!token) return;
    try {
      if (editingProductId) {
        await mutateJson(`/v1/products/${editingProductId}`, token, "PUT", productForm);
        setNotice("Đã cập nhật sản phẩm.");
      } else {
        await mutateJson("/v1/products", token, "POST", productForm);
        setNotice("Đã thêm sản phẩm mới.");
      }
      setEditingProductId("");
      setProductForm({ sku: "", name: "", category: "", unitPrice: 0, stock: 0 });
      setActiveModal(null);
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const editProduct = (item: Product) => {
    setEditingProductId(item.id);
    setProductForm({
      sku: item.sku,
      name: item.name,
      category: item.category ?? "",
      unitPrice: Number(item.unit_price),
      stock: Number(item.stock)
    });
    setActiveModal("product");
  };

  const upsertCustomer = async () => {
    if (!token) return;
    try {
      if (editingCustomerId) {
        await mutateJson(`/v1/customers/${editingCustomerId}`, token, "PUT", customerForm);
        setNotice("Đã cập nhật khách hàng.");
      } else {
        await mutateJson("/v1/customers", token, "POST", customerForm);
        setNotice("Đã thêm khách hàng mới.");
      }
      setEditingCustomerId("");
      setCustomerForm({ fullName: "", phone: "", email: "", address: "" });
      setActiveModal(null);
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const editCustomer = (item: Customer) => {
    setEditingCustomerId(item.id);
    setCustomerForm({
      fullName: item.full_name,
      phone: item.phone ?? "",
      email: item.email ?? "",
      address: item.address ?? ""
    });
    setActiveModal("customer");
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
      setNotice("Đã ghi nhận giao dịch kho lẻ.");
      setInventoryForm({ mode: "inbound", productId: "", quantity: 1, referenceCode: "", note: "" });
      setActiveModal(null);
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const createInventoryBulk = async () => {
    if (!token) return;
    try {
      const filteredItems = inventoryBulkForm.lines.filter((line) => line.productId && Number(line.quantity) > 0);
      if (filteredItems.length === 0) {
        throw new Error("Cần ít nhất 1 dòng sản phẩm hợp lệ.");
      }
      const endpoint = inventoryBulkForm.mode === "in" ? "/v1/inventory/inbound" : "/v1/inventory/bulk";
      const payload =
        inventoryBulkForm.mode === "in"
          ? {
              referenceCode: inventoryBulkForm.referenceCode,
              note: inventoryBulkForm.note,
              items: filteredItems.map((line) => ({
                productId: line.productId,
                quantity: Number(line.quantity),
                unitCost: Number(line.unitCost)
              }))
            }
          : {
              mode: "out",
              referenceCode: inventoryBulkForm.referenceCode,
              note: inventoryBulkForm.note,
              items: filteredItems.map((line) => ({
                productId: line.productId,
                quantity: Number(line.quantity)
              }))
            };
      await mutateJson(endpoint, token, "POST", payload);
      setNotice(inventoryBulkForm.mode === "in" ? "Đã tạo phiếu nhập hàng nhiều sản phẩm." : "Đã tạo phiếu xuất kho nhiều sản phẩm.");
      setInventoryBulkForm({ mode: "in", referenceCode: "", note: "", lines: [{ productId: "", quantity: 1, unitCost: 0 }] });
      setActiveModal(null);
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const createInventoryAdjust = async () => {
    if (!token) return;
    try {
      const filteredItems = inventoryAdjustForm.lines.filter((line) => line.productId);
      if (filteredItems.length === 0) {
        throw new Error("Cần chọn ít nhất 1 sản phẩm để điều chỉnh.");
      }
      await mutateJson("/v1/inventory/adjustment", token, "POST", {
        referenceCode: inventoryAdjustForm.referenceCode,
        note: inventoryAdjustForm.note,
        items: filteredItems
      });
      setNotice("Đã điều chỉnh tồn kho theo số lượng mục tiêu.");
      setInventoryAdjustForm({ referenceCode: "", note: "", lines: [{ productId: "", targetStock: 0 }] });
      setActiveModal(null);
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const createOrder = async () => {
    if (!token) return;
    try {
      const filteredItems = orderForm.lines.filter((line) => line.productId && Number(line.quantity) > 0);
      if (filteredItems.length === 0) {
        throw new Error("Đơn hàng cần có ít nhất 1 sản phẩm hợp lệ.");
      }
      const payload = {
        customerId: orderForm.customerId || undefined,
        source: orderForm.source,
        status: orderForm.status,
        items: filteredItems
      };
      await mutateJson("/v1/orders", token, "POST", payload);
      setNotice("Đã tạo đơn hàng mới.");
      setOrderForm({ customerId: "", source: "local", status: "new", lines: [{ productId: "", quantity: 1, unitPrice: 0 }] });
      setActiveModal(null);
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const updateOrderStatus = async (orderId: string, status: string) => {
    if (!token) return;
    try {
      await mutateJson(`/v1/orders/${orderId}/status`, token, "PATCH", { status });
      setNotice("Đã cập nhật trạng thái đơn hàng.");
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const createShipping = async () => {
    if (!token) return;
    try {
      await mutateJson("/v1/shippings", token, "POST", shippingForm);
      setNotice("Đã tạo vận đơn.");
      setShippingForm({
        orderId: "",
        shippingCode: "",
        carrier: "",
        serviceLevel: "",
        recipientName: "",
        recipientPhone: "",
        recipientAddress: "",
        shippingFee: 0,
        codAmount: 0,
        note: ""
      });
      setActiveModal(null);
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const updateShippingStatus = async (shippingId: string, status: string) => {
    if (!token) return;
    try {
      await mutateJson(`/v1/shippings/${shippingId}/status`, token, "PATCH", { status });
      setNotice("Đã cập nhật trạng thái vận chuyển.");
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
      setActiveModal(null);
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
            { id: "orders", label: "Đơn hàng" },
            { id: "shipping", label: "Vận chuyển" },
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
              {activeModule === "orders" && "Quản lý đơn hàng"}
              {activeModule === "shipping" && "Quản lý vận chuyển"}
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
          <section className="card">
            <header className="card-head card-head-row">
              <h2>Danh sách sản phẩm</h2>
              {canManageCatalog ? (
                <button
                  className="primary-btn"
                  onClick={() => {
                    setEditingProductId("");
                    setProductForm({ sku: "", name: "", category: "", unitPrice: 0, stock: 0 });
                    setActiveModal("product");
                  }}
                >
                  + Thêm sản phẩm
                </button>
              ) : null}
            </header>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>SKU</th><th>Tên</th><th>Danh mục</th><th>Đơn giá</th><th>Tồn</th><th>Thao tác</th></tr>
                </thead>
                <tbody>
                  {products.map((item) => (
                    <tr key={item.id}>
                      <td>{item.sku}</td>
                      <td>{item.name}</td>
                      <td>{item.category}</td>
                      <td>{formatCurrency(Number(item.unit_price))}</td>
                      <td>{item.stock}</td>
                      <td>
                        {canManageCatalog ? (
                          <button className="ghost-btn" onClick={() => editProduct(item)}>Sửa</button>
                        ) : (
                          "-"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {activeModule === "customers" && (
          <section className="card">
            <header className="card-head card-head-row">
              <h2>Danh sách khách hàng</h2>
              {canManageCustomers ? (
                <button
                  className="primary-btn"
                  onClick={() => {
                    setEditingCustomerId("");
                    setCustomerForm({ fullName: "", phone: "", email: "", address: "" });
                    setActiveModal("customer");
                  }}
                >
                  + Thêm khách hàng
                </button>
              ) : null}
            </header>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Họ tên</th><th>Điện thoại</th><th>Email</th><th>Địa chỉ</th><th>Thao tác</th></tr>
                </thead>
                <tbody>
                  {customers.map((item) => (
                    <tr key={item.id}>
                      <td>{item.full_name}</td>
                      <td>{item.phone}</td>
                      <td>{item.email}</td>
                      <td>{item.address}</td>
                      <td>
                        {canManageCustomers ? (
                          <button className="ghost-btn" onClick={() => editCustomer(item)}>Sửa</button>
                        ) : (
                          "-"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {activeModule === "inventory" && (
          <>
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
                          <td><span className={statusClass(item.type)}>{item.type}</span></td>
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
                <header className="card-head"><h2>Thao tác kho</h2></header>
                <div className="action-stack">
                  <button className="primary-btn" onClick={() => setActiveModal("inventorySingle")}>Nhập/Xuất kho lẻ</button>
                  <button className="primary-btn" onClick={() => setActiveModal("inventoryBulk")}>Nhập/Xuất nhiều sản phẩm</button>
                  <button className="primary-btn" onClick={() => setActiveModal("inventoryAdjust")}>Điều chỉnh tồn nhiều sản phẩm</button>
                </div>
              </article>
            </section>
          </>
        )}

        {activeModule === "orders" && (
          <section className="card">
            <header className="card-head card-head-row">
              <h2>Danh sách đơn hàng</h2>
              {canManageOrders ? (
                <button className="primary-btn" onClick={() => setActiveModal("order")}>+ Tạo đơn hàng</button>
              ) : null}
            </header>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Mã đơn</th><th>Khách hàng</th><th>Kênh</th><th>Tổng tiền</th><th>Trạng thái</th><th>Đổi trạng thái</th></tr>
                </thead>
                <tbody>
                  {orders.map((item) => (
                    <tr key={item.id}>
                      <td>{item.order_code}</td>
                      <td>{item.customer_name || "Khách lẻ"}</td>
                      <td>{item.source}</td>
                      <td>{formatCurrency(Number(item.total_amount))}</td>
                      <td><span className={statusClass(item.status)}>{item.status}</span></td>
                      <td>
                        <select defaultValue="" onChange={(e) => {
                          const nextStatus = e.target.value;
                          if (nextStatus) void updateOrderStatus(item.id, nextStatus);
                        }}>
                          <option value="">Chọn trạng thái</option>
                          <option value="new">new</option>
                          <option value="confirmed">confirmed</option>
                          <option value="shipping">shipping</option>
                          <option value="done">done</option>
                          <option value="cancelled">cancelled</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {activeModule === "shipping" && (
          <section className="card">
            <header className="card-head card-head-row">
              <h2>Danh sách vận chuyển</h2>
              {canManageShipping ? (
                <button className="primary-btn" onClick={() => setActiveModal("shipping")}>+ Tạo vận đơn</button>
              ) : null}
            </header>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Mã vận đơn</th><th>Đơn hàng</th><th>Khách nhận</th><th>Đơn vị</th><th>Phí ship</th><th>Trạng thái</th><th>Đổi trạng thái</th></tr>
                </thead>
                <tbody>
                  {shippings.map((item) => (
                    <tr key={item.id}>
                      <td>{item.shipping_code}</td>
                      <td>{item.order_code || "-"}</td>
                      <td>{item.recipient_name}</td>
                      <td>{item.carrier}</td>
                      <td>{formatCurrency(Number(item.shipping_fee))}</td>
                      <td><span className={statusClass(item.status)}>{item.status}</span></td>
                      <td>
                        <select defaultValue="" onChange={(e) => {
                          const nextStatus = e.target.value;
                          if (nextStatus) void updateShippingStatus(item.id, nextStatus);
                        }}>
                          <option value="">Chọn trạng thái</option>
                          <option value="pending">pending</option>
                          <option value="packed">packed</option>
                          <option value="shipped">shipped</option>
                          <option value="delivered">delivered</option>
                          <option value="returned">returned</option>
                          <option value="cancelled">cancelled</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {activeModule === "users" && (
          <section className="card">
            <header className="card-head card-head-row">
              <h2>Danh sách người dùng</h2>
              {canManageUsers ? (
                <button className="primary-btn" onClick={() => setActiveModal("user")}>+ Tạo người dùng</button>
              ) : null}
            </header>
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
          </section>
        )}

        {activeModal ? (
          <div className="modal-overlay" onClick={() => setActiveModal(null)}>
            <div className="modal-card" onClick={(event) => event.stopPropagation()}>
              <header className="card-head card-head-row">
                <h2>
                  {activeModal === "product" && (editingProductId ? "Cập nhật sản phẩm" : "Thêm sản phẩm")}
                  {activeModal === "customer" && (editingCustomerId ? "Cập nhật khách hàng" : "Thêm khách hàng")}
                  {activeModal === "inventorySingle" && "Tạo giao dịch kho lẻ"}
                  {activeModal === "inventoryBulk" && "Tạo phiếu nhập/xuất nhiều sản phẩm"}
                  {activeModal === "inventoryAdjust" && "Điều chỉnh tồn kho"}
                  {activeModal === "order" && "Tạo đơn hàng mới"}
                  {activeModal === "shipping" && "Tạo vận đơn mới"}
                  {activeModal === "user" && "Tạo người dùng"}
                </h2>
                <button className="ghost-btn" onClick={() => setActiveModal(null)}>Đóng</button>
              </header>

              {activeModal === "product" ? (
                canManageCatalog ? (
                  <>
                    <input placeholder="SKU" value={productForm.sku} onChange={(e) => setProductForm((p) => ({ ...p, sku: e.target.value }))} />
                    <input placeholder="Tên sản phẩm" value={productForm.name} onChange={(e) => setProductForm((p) => ({ ...p, name: e.target.value }))} />
                    <input placeholder="Danh mục" value={productForm.category} onChange={(e) => setProductForm((p) => ({ ...p, category: e.target.value }))} />
                    <input type="number" placeholder="Đơn giá" value={productForm.unitPrice} onChange={(e) => setProductForm((p) => ({ ...p, unitPrice: Number(e.target.value) }))} />
                    <input type="number" placeholder="Tồn kho" value={productForm.stock} onChange={(e) => setProductForm((p) => ({ ...p, stock: Number(e.target.value) }))} />
                    <button className="primary-btn" onClick={() => void upsertProduct()}>{editingProductId ? "Lưu cập nhật" : "Lưu sản phẩm"}</button>
                  </>
                ) : (
                  <p className="text-muted">Bạn không có quyền thao tác sản phẩm.</p>
                )
              ) : null}

              {activeModal === "customer" ? (
                canManageCustomers ? (
                  <>
                    <input placeholder="Họ tên" value={customerForm.fullName} onChange={(e) => setCustomerForm((p) => ({ ...p, fullName: e.target.value }))} />
                    <input placeholder="Số điện thoại" value={customerForm.phone} onChange={(e) => setCustomerForm((p) => ({ ...p, phone: e.target.value }))} />
                    <input placeholder="Email" value={customerForm.email} onChange={(e) => setCustomerForm((p) => ({ ...p, email: e.target.value }))} />
                    <input placeholder="Địa chỉ" value={customerForm.address} onChange={(e) => setCustomerForm((p) => ({ ...p, address: e.target.value }))} />
                    <button className="primary-btn" onClick={() => void upsertCustomer()}>{editingCustomerId ? "Lưu cập nhật" : "Lưu khách hàng"}</button>
                  </>
                ) : (
                  <p className="text-muted">Bạn không có quyền thao tác khách hàng.</p>
                )
              ) : null}

              {activeModal === "inventorySingle" ? (
                <>
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
                  <button className="primary-btn" onClick={() => void createInventoryTx()}>Lưu giao dịch</button>
                </>
              ) : null}

              {activeModal === "inventoryBulk" ? (
                <>
                  <select value={inventoryBulkForm.mode} onChange={(e) => setInventoryBulkForm((p) => ({ ...p, mode: e.target.value }))}>
                    <option value="in">Nhập kho nhiều dòng</option>
                    <option value="out">Xuất kho nhiều dòng</option>
                  </select>
                  <input placeholder="Mã phiếu" value={inventoryBulkForm.referenceCode} onChange={(e) => setInventoryBulkForm((p) => ({ ...p, referenceCode: e.target.value }))} />
                  <input placeholder="Ghi chú" value={inventoryBulkForm.note} onChange={(e) => setInventoryBulkForm((p) => ({ ...p, note: e.target.value }))} />
                  {inventoryBulkForm.lines.map((line, idx) => (
                    <div key={`bulk-${idx}`}>
                      <select value={line.productId} onChange={(e) => {
                        const lines = [...inventoryBulkForm.lines];
                        lines[idx] = { ...lines[idx], productId: e.target.value };
                        setInventoryBulkForm((p) => ({ ...p, lines }));
                      }}>
                        <option value="">Chọn sản phẩm</option>
                        {products.map((item) => (
                          <option key={item.id} value={item.id}>{item.sku} - {item.name}</option>
                        ))}
                      </select>
                      <input
                        type="number"
                        placeholder="Số lượng"
                        value={line.quantity}
                        onChange={(e) => {
                          const lines = [...inventoryBulkForm.lines];
                          lines[idx] = { ...lines[idx], quantity: Number(e.target.value) };
                          setInventoryBulkForm((p) => ({ ...p, lines }));
                        }}
                      />
                      {inventoryBulkForm.mode === "in" ? (
                        <input
                          type="number"
                          placeholder="Đơn giá nhập"
                          value={line.unitCost}
                          onChange={(e) => {
                            const lines = [...inventoryBulkForm.lines];
                            lines[idx] = { ...lines[idx], unitCost: Number(e.target.value) };
                            setInventoryBulkForm((p) => ({ ...p, lines }));
                          }}
                        />
                      ) : null}
                    </div>
                  ))}
                  <button className="ghost-btn" onClick={() => setInventoryBulkForm((p) => ({ ...p, lines: [...p.lines, { productId: "", quantity: 1, unitCost: 0 }] }))}>+ Thêm dòng</button>
                  <button className="primary-btn" onClick={() => void createInventoryBulk()}>Lưu phiếu nhiều dòng</button>
                </>
              ) : null}

              {activeModal === "inventoryAdjust" ? (
                <>
                  <input placeholder="Mã kiểm kê" value={inventoryAdjustForm.referenceCode} onChange={(e) => setInventoryAdjustForm((p) => ({ ...p, referenceCode: e.target.value }))} />
                  <input placeholder="Ghi chú điều chỉnh" value={inventoryAdjustForm.note} onChange={(e) => setInventoryAdjustForm((p) => ({ ...p, note: e.target.value }))} />
                  {inventoryAdjustForm.lines.map((line, idx) => (
                    <div key={`adjust-${idx}`}>
                      <select value={line.productId} onChange={(e) => {
                        const lines = [...inventoryAdjustForm.lines];
                        lines[idx] = { ...lines[idx], productId: e.target.value };
                        setInventoryAdjustForm((p) => ({ ...p, lines }));
                      }}>
                        <option value="">Chọn sản phẩm</option>
                        {products.map((item) => (
                          <option key={item.id} value={item.id}>{item.sku} - {item.name}</option>
                        ))}
                      </select>
                      <input
                        type="number"
                        placeholder="Tồn mục tiêu"
                        value={line.targetStock}
                        onChange={(e) => {
                          const lines = [...inventoryAdjustForm.lines];
                          lines[idx] = { ...lines[idx], targetStock: Number(e.target.value) };
                          setInventoryAdjustForm((p) => ({ ...p, lines }));
                        }}
                      />
                    </div>
                  ))}
                  <button className="ghost-btn" onClick={() => setInventoryAdjustForm((p) => ({ ...p, lines: [...p.lines, { productId: "", targetStock: 0 }] }))}>+ Thêm dòng</button>
                  <button className="primary-btn" onClick={() => void createInventoryAdjust()}>Xác nhận điều chỉnh</button>
                </>
              ) : null}

              {activeModal === "order" ? (
                canManageOrders ? (
                  <>
                    <select value={orderForm.customerId} onChange={(e) => setOrderForm((p) => ({ ...p, customerId: e.target.value }))}>
                      <option value="">Khách lẻ</option>
                      {customers.map((item) => (
                        <option key={item.id} value={item.id}>{item.full_name} - {item.phone}</option>
                      ))}
                    </select>
                    <input placeholder="Kênh bán (website, cửa hàng...)" value={orderForm.source} onChange={(e) => setOrderForm((p) => ({ ...p, source: e.target.value }))} />
                    <input placeholder="Trạng thái ban đầu" value={orderForm.status} onChange={(e) => setOrderForm((p) => ({ ...p, status: e.target.value }))} />
                    {orderForm.lines.map((line, idx) => (
                      <div key={`order-line-${idx}`}>
                        <select value={line.productId} onChange={(e) => {
                          const lines = [...orderForm.lines];
                          const selected = products.find((item) => item.id === e.target.value);
                          lines[idx] = {
                            ...lines[idx],
                            productId: e.target.value,
                            unitPrice: selected ? Number(selected.unit_price) : lines[idx].unitPrice
                          };
                          setOrderForm((p) => ({ ...p, lines }));
                        }}>
                          <option value="">Chọn sản phẩm</option>
                          {products.map((item) => (
                            <option key={item.id} value={item.id}>{item.sku} - {item.name}</option>
                          ))}
                        </select>
                        <input
                          type="number"
                          placeholder="Số lượng"
                          value={line.quantity}
                          onChange={(e) => {
                            const lines = [...orderForm.lines];
                            lines[idx] = { ...lines[idx], quantity: Number(e.target.value) };
                            setOrderForm((p) => ({ ...p, lines }));
                          }}
                        />
                        <input
                          type="number"
                          placeholder="Đơn giá"
                          value={line.unitPrice}
                          onChange={(e) => {
                            const lines = [...orderForm.lines];
                            lines[idx] = { ...lines[idx], unitPrice: Number(e.target.value) };
                            setOrderForm((p) => ({ ...p, lines }));
                          }}
                        />
                      </div>
                    ))}
                    <button className="ghost-btn" onClick={() => setOrderForm((p) => ({ ...p, lines: [...p.lines, { productId: "", quantity: 1, unitPrice: 0 }] }))}>+ Thêm sản phẩm</button>
                    <button className="primary-btn" onClick={() => void createOrder()}>Lưu đơn hàng</button>
                  </>
                ) : (
                  <p className="text-muted">Bạn không có quyền tạo đơn hàng.</p>
                )
              ) : null}

              {activeModal === "shipping" ? (
                canManageShipping ? (
                  <>
                    <select value={shippingForm.orderId} onChange={(e) => setShippingForm((p) => ({ ...p, orderId: e.target.value }))}>
                      <option value="">Không gắn đơn cụ thể</option>
                      {orders.map((item) => (
                        <option key={item.id} value={item.id}>{item.order_code}</option>
                      ))}
                    </select>
                    <input placeholder="Mã vận đơn (để trống sẽ tự sinh)" value={shippingForm.shippingCode} onChange={(e) => setShippingForm((p) => ({ ...p, shippingCode: e.target.value }))} />
                    <input placeholder="Đơn vị vận chuyển" value={shippingForm.carrier} onChange={(e) => setShippingForm((p) => ({ ...p, carrier: e.target.value }))} />
                    <input placeholder="Dịch vụ (nhanh/tiết kiệm...)" value={shippingForm.serviceLevel} onChange={(e) => setShippingForm((p) => ({ ...p, serviceLevel: e.target.value }))} />
                    <input placeholder="Tên người nhận" value={shippingForm.recipientName} onChange={(e) => setShippingForm((p) => ({ ...p, recipientName: e.target.value }))} />
                    <input placeholder="SĐT người nhận" value={shippingForm.recipientPhone} onChange={(e) => setShippingForm((p) => ({ ...p, recipientPhone: e.target.value }))} />
                    <input placeholder="Địa chỉ nhận hàng" value={shippingForm.recipientAddress} onChange={(e) => setShippingForm((p) => ({ ...p, recipientAddress: e.target.value }))} />
                    <input type="number" placeholder="Phí vận chuyển" value={shippingForm.shippingFee} onChange={(e) => setShippingForm((p) => ({ ...p, shippingFee: Number(e.target.value) }))} />
                    <input type="number" placeholder="Thu hộ COD" value={shippingForm.codAmount} onChange={(e) => setShippingForm((p) => ({ ...p, codAmount: Number(e.target.value) }))} />
                    <input placeholder="Ghi chú" value={shippingForm.note} onChange={(e) => setShippingForm((p) => ({ ...p, note: e.target.value }))} />
                    <button className="primary-btn" onClick={() => void createShipping()}>Lưu vận đơn</button>
                  </>
                ) : (
                  <p className="text-muted">Bạn không có quyền tạo vận đơn.</p>
                )
              ) : null}

              {activeModal === "user" ? (
                canManageUsers ? (
                  <>
                    <input placeholder="Tên đăng nhập" value={userForm.username} onChange={(e) => setUserForm((p) => ({ ...p, username: e.target.value }))} />
                    <input type="password" placeholder="Mật khẩu" value={userForm.password} onChange={(e) => setUserForm((p) => ({ ...p, password: e.target.value }))} />
                    <select value={userForm.role} onChange={(e) => setUserForm((p) => ({ ...p, role: e.target.value }))}>
                      <option value="sales">sales</option>
                      <option value="kho">kho</option>
                      <option value="admin">admin</option>
                    </select>
                    <button className="primary-btn" onClick={() => void createUser()}>Lưu người dùng</button>
                  </>
                ) : (
                  <p className="text-muted">Chỉ admin có quyền thao tác module này.</p>
                )
              ) : null}
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}
