require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || "";
const REFRESH_MINUTES = Number(process.env.REFRESH_INTERVAL_MINUTES || 15);

/* ------------------------------------------------------------------
   Basit dosya tabanlı kalıcı depo (data/*.json)
------------------------------------------------------------------ */
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"));
  } catch (e) {
    return fallback;
  }
}
function saveJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// products: { [barcode]: { name, stocks: { hb, ty, n11, cs }, centralStock } }
let products = loadJSON("products.json", {});
let processedPackages = new Set(loadJSON("processed.json", []));
let pushLog = loadJSON("push-log.json", []);

function persistProducts() {
  saveJSON("products.json", products);
}
function persistProcessed() {
  saveJSON("processed.json", Array.from(processedPackages));
}
function persistPushLog() {
  pushLog = pushLog.slice(-150);
  saveJSON("push-log.json", pushLog);
}

function ensureProduct(barcode, name) {
  if (!products[barcode]) {
    products[barcode] = { name: name || "İsimsiz ürün", stocks: {}, centralStock: 0, image: null };
  }
  if (!products[barcode].stocks) products[barcode].stocks = {};
  return products[barcode];
}

/* ------------------------------------------------------------------
   Basit oturum koruması (tek kullanıcılı araç varsayımı)
------------------------------------------------------------------ */
const sessions = new Set();

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .filter(Boolean)
      .map((c) => {
        const [k, ...v] = c.trim().split("=");
        return [k, decodeURIComponent(v.join("="))];
      })
  );
}

app.post("/api/login", (req, res) => {
  if (!PANEL_PASSWORD) return res.json({ ok: true });
  if (req.body?.password === PANEL_PASSWORD) {
    const token = crypto.randomBytes(24).toString("hex");
    sessions.add(token);
    res.setHeader(
      "Set-Cookie",
      `siparis_session=${token}; HttpOnly; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax`
    );
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: "Şifre yanlış." });
});

function requireAuth(req, res, next) {
  if (!PANEL_PASSWORD) return next();
  const cookies = parseCookies(req);
  if (cookies.siparis_session && sessions.has(cookies.siparis_session)) return next();
  return res.status(401).json({ ok: false, error: "Giriş gerekli." });
}

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

/* ==================================================================
   HEPSİBURADA
================================================================== */
function hbConfigured() {
  return !!(process.env.HB_MERCHANT_ID && process.env.HB_USERNAME && process.env.HB_PASSWORD);
}

async function fetchHepsiburadaOrders() {
  if (!hbConfigured()) return { platform: "hb", error: "Hepsiburada API bilgileri .env dosyasında eksik.", orders: [] };
  const { HB_MERCHANT_ID, HB_USERNAME, HB_PASSWORD, HB_ENV } = process.env;
  const host = HB_ENV === "test" ? "oms-external-sit.hepsiburada.com" : "oms-external.hepsiburada.com";
  const url = `https://${host}/packages/merchantid/${HB_MERCHANT_ID}?timespan=24`;

  try {
    const resp = await axios.get(url, {
      auth: { username: HB_USERNAME, password: HB_PASSWORD },
      headers: { "User-Agent": `${HB_MERCHANT_ID} - SelfIntegration`, Accept: "application/json" },
      timeout: 20000,
    });
    const raw = Array.isArray(resp.data) ? resp.data : resp.data?.items || resp.data?.Items || [];
    return { platform: "hb", error: null, orders: raw.map(normalizeHbPackage) };
  } catch (err) {
    const msg =
      err.response?.status === 401 || err.response?.status === 403
        ? "Hepsiburada kimlik doğrulama hatası — kullanıcı adı/şifreyi kontrol et."
        : err.response?.data
        ? `Hepsiburada hata: ${JSON.stringify(err.response.data).slice(0, 300)}`
        : `Hepsiburada bağlantı hatası: ${err.message}`;
    return { platform: "hb", error: msg, orders: [] };
  }
}

function normalizeHbPackage(pkg) {
  const items = pkg.Items || pkg.items || pkg.LineItems || pkg.lineItems || [];
  const lines = items.map((it) => ({
    barcode: String(
      it.MerchantSku || it.merchantSku || it.Sku || it.sku || it.HepsiburadaSku || it.hepsiburadaSku || it.Barcode || it.barcode || ""
    ).trim(),
    quantity: Number(it.Quantity || it.quantity || 1),
    name: it.ProductName || it.productName || it.Name || "",
  }));
  const productSummary = lines.map((l) => `${l.name || l.barcode || "Ürün"} x${l.quantity}`).join(", ");
  const total =
    pkg.TotalPrice ?? pkg.totalPrice ?? pkg.Price ?? pkg.price ??
    items.reduce((s, it) => s + Number(it.Price || it.price || 0) * Number(it.Quantity || it.quantity || 1), 0);

  return {
    platform: "hb",
    orderNumber: pkg.OrderNumber || pkg.orderNumber || pkg.PackageNumber || pkg.packageNumber || "—",
    packageId: String(pkg.PackageNumber || pkg.packageNumber || pkg.Id || pkg.id || pkg.OrderNumber || pkg.orderNumber || ""),
    customer: pkg.CustomerName || pkg.customerName || pkg.ShippingAddress?.Name || "Müşteri",
    city: pkg.ShippingAddress?.City || pkg.shippingAddress?.city || pkg.City || "",
    productSummary: productSummary || "—",
    amount: Number(total) || 0,
    status: pkg.Status || pkg.status || "Open",
    date: pkg.OrderDate || pkg.orderDate || pkg.PackageDate || pkg.packageDate || null,
    lines,
  };
}

// Mevcut stok/ürün listesini Hepsiburada'dan çekme (best-effort — resmi dokümandan
// tam doğrulanamadı, uç nokta yapısı push tarafıyla aynı host/desen üzerinden tahmin edildi).
async function fetchStockHepsiburada() {
  if (!hbConfigured()) return { platform: "hb", error: "Hepsiburada API bilgileri .env dosyasında eksik.", rows: [] };
  const { HB_MERCHANT_ID, HB_USERNAME, HB_PASSWORD, HB_ENV } = process.env;
  const host = HB_ENV === "test" ? "listing-external-sit.hepsiburada.com" : "listing-external.hepsiburada.com";
  const url = `https://${host}/listings/merchantid/${HB_MERCHANT_ID}`;
  const rows = [];
  try {
    let offset = 0;
    const limit = 200;
    for (let page = 0; page < 25; page++) {
      const resp = await axios.get(url, {
        auth: { username: HB_USERNAME, password: HB_PASSWORD },
        params: { limit, offset },
        headers: { "User-Agent": `${HB_MERCHANT_ID} - SelfIntegration`, Accept: "application/json" },
        timeout: 20000,
      });
      const items = resp.data?.listings || resp.data?.Listings || resp.data?.items || (Array.isArray(resp.data) ? resp.data : []);
      if (!items.length) break;
      items.forEach((it) => {
        const barcode = String(it.MerchantSku || it.merchantSku || it.Sku || it.sku || "").trim();
        if (!barcode) return;
        rows.push({
          barcode,
          stock: Number(it.AvailableStock ?? it.availableStock ?? 0),
          name: it.ProductName || it.productName || "",
        });
      });
      if (items.length < limit) break;
      offset += limit;
    }
    return { platform: "hb", error: null, rows };
  } catch (err) {
    const msg =
      err.response?.status === 401 || err.response?.status === 403
        ? "Hepsiburada kimlik doğrulama hatası — kullanıcı adı/şifreyi kontrol et."
        : err.response?.data
        ? `Hepsiburada hata: ${JSON.stringify(err.response.data).slice(0, 300)}`
        : `Hepsiburada bağlantı hatası: ${err.message}`;
    return { platform: "hb", error: msg, rows: [] };
  }
}

async function pushStockToHepsiburada(barcode, quantity) {
  if (!hbConfigured()) return { ok: false, message: "Hepsiburada API bilgisi eksik." };
  const { HB_MERCHANT_ID, HB_USERNAME, HB_PASSWORD, HB_ENV } = process.env;
  const host = HB_ENV === "test" ? "listing-external-sit.hepsiburada.com" : "listing-external.hepsiburada.com";
  const url = `https://${host}/listings/merchantid/${HB_MERCHANT_ID}/stock-uploads`;
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<listings><listing><MerchantSku>${escapeXml(barcode)}</MerchantSku>` +
    `<AvailableStock>${qty}</AvailableStock></listing></listings>`;
  try {
    const resp = await axios.post(url, xml, {
      auth: { username: HB_USERNAME, password: HB_PASSWORD },
      headers: { "Content-Type": "application/xml", Accept: "application/json", "User-Agent": `${HB_MERCHANT_ID} - SelfIntegration` },
      timeout: 15000,
    });
    return { ok: true, message: "Gönderildi", trackingId: resp.data?.Id || resp.data?.id || null };
  } catch (err) {
    return { ok: false, message: err.response?.data ? JSON.stringify(err.response.data).slice(0, 250) : err.message };
  }
}

/* ==================================================================
   TRENDYOL
================================================================== */
function tyConfigured() {
  return !!(process.env.TY_SELLER_ID && process.env.TY_API_KEY && process.env.TY_API_SECRET);
}

async function fetchTrendyolOrders() {
  if (!tyConfigured()) return { platform: "ty", error: "Trendyol API bilgileri .env dosyasında eksik.", orders: [] };
  const { TY_SELLER_ID, TY_API_KEY, TY_API_SECRET, TY_ENV } = process.env;
  const host = TY_ENV === "test" ? "stageapigw.trendyol.com" : "apigw.trendyol.com";
  const endDate = Date.now();
  const startDate = endDate - 7 * 24 * 60 * 60 * 1000;
  const url = `https://${host}/integration/order/sellers/${TY_SELLER_ID}/v2/orders`;

  try {
    const resp = await axios.get(url, {
      auth: { username: TY_API_KEY, password: TY_API_SECRET },
      params: { startDate, endDate, orderByField: "PackageLastModifiedDate", orderByDirection: "DESC", size: 200 },
      headers: { "User-Agent": `${TY_SELLER_ID} - SelfIntegration`, Accept: "application/json" },
      timeout: 20000,
    });
    const content = resp.data?.content || [];
    return { platform: "ty", error: null, orders: content.map(normalizeTyPackage) };
  } catch (err) {
    const msg =
      err.response?.status === 401 || err.response?.status === 403
        ? "Trendyol kimlik doğrulama hatası — API key/secret veya seller ID'yi kontrol et."
        : err.response?.data
        ? `Trendyol hata: ${JSON.stringify(err.response.data).slice(0, 300)}`
        : `Trendyol bağlantı hatası: ${err.message}`;
    return { platform: "ty", error: msg, orders: [] };
  }
}

function normalizeTyPackage(pkg) {
  const lines = (pkg.lines || []).map((l) => ({
    barcode: String(l.barcode || l.stockCode || "").trim(),
    quantity: Number(l.quantity || 1),
    name: l.productName || l.stockCode || "",
  }));
  return {
    platform: "ty",
    orderNumber: pkg.orderNumber || String(pkg.shipmentPackageId || "—"),
    packageId: String(pkg.shipmentPackageId || ""),
    customer: `${pkg.customerFirstName || ""} ${pkg.customerLastName || ""}`.trim() || "Müşteri",
    city: pkg.shipmentAddress?.city || "",
    productSummary: lines.map((l) => `${l.name || l.barcode || "Ürün"} x${l.quantity}`).join(", ") || "—",
    amount: Number(pkg.packageTotalPrice ?? pkg.packageGrossAmount ?? 0),
    status: pkg.shipmentPackageStatus || pkg.status || "—",
    date: pkg.orderDate || null,
    lines,
  };
}

// Mevcut stok/ürün listesini Trendyol'dan çekme — resmi dokümandan doğrulandı
// (Ürün Filtreleme - Onaylı Ürün v2). Bu uç nokta stokla birlikte ürün başlığını
// ve görsel URL'sini de döndürdüğü için isim/resim eksikliği burada çözülüyor.
function resolveTyImage(url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return `https://cdn.dsmcdn.com${url.startsWith("/") ? "" : "/"}${url}`;
}

async function fetchStockTrendyol() {
  if (!tyConfigured()) return { platform: "ty", error: "Trendyol API bilgileri .env dosyasında eksik.", rows: [] };
  const { TY_SELLER_ID, TY_API_KEY, TY_API_SECRET, TY_ENV } = process.env;
  const host = TY_ENV === "test" ? "stageapigw.trendyol.com" : "apigw.trendyol.com";
  const url = `https://${host}/integration/product/sellers/${TY_SELLER_ID}/products/approved`;
  const rows = [];
  try {
    let page = 0;
    let nextPageToken = null;
    for (let i = 0; i < 25; i++) {
      const params = nextPageToken ? { size: 100, nextPageToken } : { size: 100, page };
      const resp = await axios.get(url, {
        auth: { username: TY_API_KEY, password: TY_API_SECRET },
        params,
        headers: { "User-Agent": `${TY_SELLER_ID} - SelfIntegration`, Accept: "application/json" },
        timeout: 20000,
      });
      const content = resp.data?.content || [];
      content.forEach((item) => {
        const name = item.title || item.productMainId || "";
        const image = resolveTyImage(item.images?.[0]?.url);
        (item.variants || []).forEach((v) => {
          const barcode = String(v.barcode || v.stockCode || "").trim();
          if (!barcode) return;
          rows.push({ barcode, stock: Number(v.stock?.quantity ?? v.quantity ?? 0), name, image });
        });
      });
      nextPageToken = resp.data?.nextPageToken || null;
      const totalPages = resp.data?.totalPages ?? 1;
      page++;
      if (!content.length || (!nextPageToken && page >= totalPages)) break;
    }
    return { platform: "ty", error: null, rows };
  } catch (err) {
    const msg =
      err.response?.status === 401 || err.response?.status === 403
        ? "Trendyol kimlik doğrulama hatası — API key/secret veya seller ID'yi kontrol et."
        : err.response?.data
        ? `Trendyol hata: ${JSON.stringify(err.response.data).slice(0, 300)}`
        : `Trendyol bağlantı hatası: ${err.message}`;
    return { platform: "ty", error: msg, rows: [] };
  }
}

async function pushStockToTrendyol(barcode, quantity) {
  if (!tyConfigured()) return { ok: false, message: "Trendyol API bilgisi eksik." };
  const { TY_SELLER_ID, TY_API_KEY, TY_API_SECRET, TY_ENV } = process.env;
  const host = TY_ENV === "test" ? "stageapigw.trendyol.com" : "apigw.trendyol.com";
  const url = `https://${host}/integration/inventory/sellers/${TY_SELLER_ID}/products/price-and-inventory`;
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  try {
    const resp = await axios.post(
      url,
      { items: [{ barcode, quantity: qty }] },
      { auth: { username: TY_API_KEY, password: TY_API_SECRET }, headers: { "Content-Type": "application/json" }, timeout: 15000 }
    );
    return { ok: true, message: "Gönderildi", batchRequestId: resp.data?.batchRequestId || null };
  } catch (err) {
    return { ok: false, message: err.response?.data ? JSON.stringify(err.response.data).slice(0, 250) : err.message };
  }
}

/* ==================================================================
   N11 — resmi REST API (developer.n11.com)
================================================================== */
function n11Configured() {
  return !!(process.env.N11_APP_KEY && process.env.N11_APP_SECRET);
}

async function fetchN11Orders() {
  if (!n11Configured()) return { platform: "n11", error: "N11 API bilgileri .env dosyasında eksik.", orders: [] };
  const { N11_APP_KEY, N11_APP_SECRET } = process.env;
  const endDate = Date.now();
  const startDate = endDate - 7 * 24 * 60 * 60 * 1000;
  const url = "https://api.n11.com/rest/delivery/v1/shipmentPackages";

  try {
    const resp = await axios.get(url, {
      headers: { appKey: N11_APP_KEY, appSecret: N11_APP_SECRET, Accept: "application/json" },
      params: { startDate, endDate, page: 0, size: 100, orderByDirection: "DESC", orderByField: true },
      timeout: 20000,
    });
    const content = resp.data?.content || [];
    return { platform: "n11", error: null, orders: content.map(normalizeN11Package) };
  } catch (err) {
    const msg =
      err.response?.status === 401 || err.response?.status === 403
        ? "N11 kimlik doğrulama hatası — appKey/appSecret'i kontrol et."
        : err.response?.data
        ? `N11 hata: ${JSON.stringify(err.response.data).slice(0, 300)}`
        : `N11 bağlantı hatası: ${err.message}`;
    return { platform: "n11", error: msg, orders: [] };
  }
}

function normalizeN11Package(pkg) {
  const lines = (pkg.lines || []).map((l) => ({
    barcode: String(l.stockCode || l.barcode || "").trim(),
    quantity: Number(l.quantity || 1),
    name: l.productName || l.stockCode || "",
  }));
  return {
    platform: "n11",
    orderNumber: pkg.orderNumber || String(pkg.id || "—"),
    packageId: String(pkg.id || pkg.orderNumber || ""),
    customer: pkg.customerfullName || "Müşteri",
    city: pkg.shippingAddress?.city || "",
    productSummary: lines.map((l) => `${l.name || l.barcode || "Ürün"} x${l.quantity}`).join(", ") || "—",
    amount: Number(pkg.totalAmount) || 0,
    status: pkg.shipmentPackageStatus || "—",
    date: pkg.lastModifiedDate || null,
    lines,
  };
}

async function pushStockToN11(barcode, quantity) {
  if (!n11Configured()) return { ok: false, message: "N11 API bilgisi eksik." };
  const { N11_APP_KEY, N11_APP_SECRET } = process.env;
  const url = "https://api.n11.com/ms/product/tasks/price-stock-update";
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  const body = { payload: { integrator: "TicaretPaneli", skus: [{ stockCode: barcode, quantity: qty }] } };
  try {
    const resp = await axios.post(url, body, {
      headers: { appKey: N11_APP_KEY, appSecret: N11_APP_SECRET, "Content-Type": "application/json" },
      timeout: 15000,
    });
    if (resp.data?.status === "REJECT") {
      return { ok: false, message: (resp.data?.reasons || []).join(" ") || "N11 reddetti." };
    }
    return { ok: true, message: "Gönderildi", taskId: resp.data?.id || null };
  } catch (err) {
    return { ok: false, message: err.response?.data ? JSON.stringify(err.response.data).slice(0, 250) : err.message };
  }
}

/* ==================================================================
   ÇİÇEKSEPETİ — resmi API var (ciceksepeti.dev) fakat dokümantasyon
   sitesi otomatik erişimi engellediği için uç nokta/alan adlarını
   yalnızca dolaylı kaynaklardan (SDK referansı) doğrulayabildim.
   BU BÖLÜM DOĞRULANMAYA MUHTAÇ — gerçek denemede hata görürsen
   "Senkron Günlüğü"ndeki mesajı bana ilet, birlikte düzeltelim.
================================================================== */
function csConfigured() {
  return !!process.env.CS_API_KEY;
}

async function fetchCiceksepetiOrders() {
  if (!csConfigured()) return { platform: "cs", error: "Çiçeksepeti API bilgisi .env dosyasında eksik.", orders: [] };
  const { CS_API_KEY, CS_ENV } = process.env;
  const host = CS_ENV === "test" ? "sandbox-apis.ciceksepeti.com" : "apis.ciceksepeti.com";
  const url = `https://${host}/api/v1/orders`;
  const endDate = new Date();
  const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  try {
    const resp = await axios.get(url, {
      headers: { ApiKey: CS_API_KEY, Accept: "application/json" },
      params: { startDate: startDate.toISOString(), endDate: endDate.toISOString(), page: 1, pageSize: 100 },
      timeout: 20000,
    });
    const orders = resp.data?.orders || resp.data?.content || [];
    return { platform: "cs", error: null, orders: orders.map(normalizeCsPackage) };
  } catch (err) {
    const msg =
      err.response?.status === 401 || err.response?.status === 403
        ? "Çiçeksepeti kimlik doğrulama hatası — API key'i kontrol et."
        : err.response?.data
        ? `Çiçeksepeti hata: ${JSON.stringify(err.response.data).slice(0, 300)}`
        : `Çiçeksepeti bağlantı hatası: ${err.message}`;
    return { platform: "cs", error: msg, orders: [] };
  }
}

function normalizeCsPackage(pkg) {
  const items = pkg.orderItems || pkg.items || pkg.lines || [];
  const lines = items.map((it) => ({
    barcode: String(it.stockCode || it.barcode || "").trim(),
    quantity: Number(it.quantity || 1),
    name: it.productName || it.stockCode || "",
  }));
  return {
    platform: "cs",
    orderNumber: pkg.orderNo || pkg.orderNumber || String(pkg.orderId || "—"),
    packageId: String(pkg.orderId || pkg.orderNo || ""),
    customer: pkg.receiverName || pkg.customerName || "Müşteri",
    city: pkg.city || pkg.address?.city || "",
    productSummary: lines.map((l) => `${l.name || l.barcode || "Ürün"} x${l.quantity}`).join(", ") || "—",
    amount: Number(pkg.totalPrice || pkg.amount || 0),
    status: pkg.status || pkg.orderStatus || "—",
    date: pkg.orderDate ? new Date(pkg.orderDate).getTime() : null,
    lines,
  };
}

async function pushStockToCiceksepeti(barcode, quantity) {
  if (!csConfigured()) return { ok: false, message: "Çiçeksepeti API bilgisi eksik." };
  const { CS_API_KEY, CS_ENV } = process.env;
  const host = CS_ENV === "test" ? "sandbox-apis.ciceksepeti.com" : "apis.ciceksepeti.com";
  const url = `https://${host}/api/v1/products/stock-price`;
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  try {
    const resp = await axios.post(
      url,
      { items: [{ stockCode: barcode, stockQuantity: qty }] },
      { headers: { ApiKey: CS_API_KEY, "Content-Type": "application/json" }, timeout: 15000 }
    );
    return { ok: true, message: "Gönderildi", batchId: resp.data?.batchId || null };
  } catch (err) {
    return { ok: false, message: err.response?.data ? JSON.stringify(err.response.data).slice(0, 250) : err.message };
  }
}

/* ==================================================================
   PLATFORM KAYDI — yeni bir pazaryeri eklemek için buraya bir satır
================================================================== */
const PLATFORMS = [
  { id: "hb", name: "Hepsiburada", color: "#FF6A00", configured: hbConfigured, fetchOrders: fetchHepsiburadaOrders, pushStock: pushStockToHepsiburada, fetchStock: fetchStockHepsiburada, stockPullVerified: false, verified: true },
  { id: "ty", name: "Trendyol", color: "#00C2B2", configured: tyConfigured, fetchOrders: fetchTrendyolOrders, pushStock: pushStockToTrendyol, fetchStock: fetchStockTrendyol, stockPullVerified: true, verified: true },
  { id: "n11", name: "N11", color: "#7B2CBF", configured: n11Configured, fetchOrders: fetchN11Orders, pushStock: pushStockToN11, fetchStock: null, stockPullVerified: false, verified: true },
  { id: "cs", name: "Çiçeksepeti", color: "#E4287C", configured: csConfigured, fetchOrders: fetchCiceksepetiOrders, pushStock: pushStockToCiceksepeti, fetchStock: null, stockPullVerified: false, verified: false },
];

app.get("/api/platforms", requireAuth, (req, res) => {
  res.json({
    platforms: PLATFORMS.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      configured: p.configured(),
      verified: p.verified,
      pullable: !!p.fetchStock,
      stockPullVerified: p.stockPullVerified,
    })),
  });
});

/* ------------------------------------------------------------------
   Yeni siparişlerden stok düşürme + tüm yapılandırılmış platformlara
   otomatik geri yazma
------------------------------------------------------------------ */
async function processNewOrdersAndSync(ordersByPlatform) {
  const changedBarcodes = new Set();
  let newlyProcessed = 0;

  function handleOrder(order) {
    if (!order.packageId && !order.orderNumber) return;
    const key = `${order.platform}:${order.packageId || order.orderNumber}`;
    if (processedPackages.has(key)) return;

    (order.lines || []).forEach((line) => {
      if (!line.barcode) return;
      const p = ensureProduct(line.barcode, line.name);
      if (line.name && (!p.name || p.name === "İsimsiz ürün")) p.name = line.name;
      p.centralStock = Math.max(0, (Number(p.centralStock) || 0) - (Number(line.quantity) || 1));
      changedBarcodes.add(line.barcode);
    });

    processedPackages.add(key);
    newlyProcessed++;
  }

  ordersByPlatform.forEach((orders) => orders.forEach(handleOrder));

  if (newlyProcessed) {
    persistProcessed();
    persistProducts();
  }

  for (const barcode of changedBarcodes) {
    const p = products[barcode];
    const results = {};
    await Promise.all(
      PLATFORMS.filter((pl) => pl.configured()).map(async (pl) => {
        const r = await pl.pushStock(barcode, p.centralStock);
        results[pl.id] = r;
        if (r.ok) p.stocks[pl.id] = p.centralStock;
      })
    );
    pushLog.push({ time: new Date().toISOString(), barcode, name: p.name, centralStock: p.centralStock, trigger: "sipariş", results });
  }

  if (changedBarcodes.size) {
    persistProducts();
    persistPushLog();
  }

  return { changedCount: changedBarcodes.size, newOrders: newlyProcessed };
}

/* ------------------------------------------------------------------
   Önbellek + otomatik döngü
------------------------------------------------------------------ */
let cache = { fetchedAt: null, orders: [], errors: [], sync: { changedCount: 0, newOrders: 0 } };

async function refreshAll() {
  const results = await Promise.all(PLATFORMS.map((p) => p.fetchOrders()));
  const merged = results.flatMap((r) => r.orders).sort((a, b) => (b.date || 0) - (a.date || 0));
  const errors = results.map((r) => r.error).filter(Boolean);

  let sync = { changedCount: 0, newOrders: 0 };
  try {
    sync = await processNewOrdersAndSync(results.map((r) => r.orders));
  } catch (e) {
    errors.push("Stok senkron hatası: " + e.message);
  }

  cache = { fetchedAt: new Date().toISOString(), orders: merged, errors, sync };
  return cache;
}

/* ------------------------------------------------------------------
   API — Siparişler
------------------------------------------------------------------ */
app.get("/api/orders", requireAuth, async (req, res) => {
  if (req.query.force === "1" || !cache.fetchedAt) await refreshAll();
  res.json(cache);
});

app.post("/api/refresh", requireAuth, async (req, res) => {
  res.json(await refreshAll());
});

/* ------------------------------------------------------------------
   API — Stok / ürün yönetimi
------------------------------------------------------------------ */
app.get("/api/products", requireAuth, (req, res) => {
  res.json({ products: Object.entries(products).map(([barcode, p]) => ({ barcode, name: p.name, stocks: p.stocks || {}, centralStock: p.centralStock, image: p.image || null })) });
});

app.post("/api/products", requireAuth, (req, res) => {
  const { barcode, name, centralStock, stocks } = req.body || {};
  const code = String(barcode || "").trim();
  if (!code) return res.status(400).json({ ok: false, error: "Barkod / SKU gerekli." });
  const p = ensureProduct(code, name);
  if (name?.trim()) p.name = name.trim();
  if (centralStock !== undefined && centralStock !== "") p.centralStock = Number(centralStock);
  if (stocks && typeof stocks === "object") {
    Object.entries(stocks).forEach(([platformId, val]) => {
      if (val !== undefined && val !== "") p.stocks[platformId] = Number(val);
    });
  }
  persistProducts();
  res.json({ ok: true, product: { barcode: code, ...p } });
});

app.delete("/api/products/:barcode", requireAuth, (req, res) => {
  delete products[req.params.barcode];
  persistProducts();
  res.json({ ok: true });
});

// Ortak birleştirme mantığı: hem Excel/CSV içe aktarma hem de "Siteden Çek" (API)
// aynı satır listesini (barcode, stock, name) bu fonksiyonla ürün kataloğuna işler.
function mergeStockRows(platform, rows) {
  let updated = 0,
    created = 0;
  rows.forEach((r) => {
    const barcode = String(r.barcode || "").trim();
    if (!barcode) return;
    const stock = Number(r.stock) || 0;
    const existed = !!products[barcode];
    const p = ensureProduct(barcode, r.name);
    p.stocks[platform] = stock;
    // Ürün daha önce hiç görülmemişse (merkezi stok hiç ayarlanmamışsa) bu platformun
    // stok değeri merkezi stoğun ilk değeri olarak da kullanılır.
    if (!existed) p.centralStock = stock;
    if (r.name && (!p.name || p.name === "İsimsiz ürün")) p.name = r.name;
    if (r.image) p.image = r.image;
    existed ? updated++ : created++;
  });
  persistProducts();
  return { updated, created };
}

// Excel/CSV içe aktarma: dosya tarayıcıda (SheetJS ile) okunur, satırlar burada birleştirilir.
app.post("/api/products/import", requireAuth, (req, res) => {
  const { platform, rows } = req.body || {};
  if (!PLATFORMS.some((p) => p.id === platform) || !Array.isArray(rows)) {
    return res.status(400).json({ ok: false, error: "Geçersiz istek." });
  }
  const result = mergeStockRows(platform, rows);
  res.json({ ok: true, ...result });
});

// Siteden çekme: ilgili platformun API'sinden mevcut stok/ürün listesini alıp
// aynı birleştirme mantığıyla kataloğa işler. Sadece fetchStock tanımlı platformlarda çalışır.
app.post("/api/products/pull", requireAuth, async (req, res) => {
  const { platform } = req.body || {};
  const pl = PLATFORMS.find((p) => p.id === platform);
  if (!pl) return res.status(400).json({ ok: false, error: "Geçersiz platform." });
  if (!pl.fetchStock) return res.status(400).json({ ok: false, error: `${pl.name} için siteden çekme henüz desteklenmiyor.` });
  if (!pl.configured()) return res.status(400).json({ ok: false, error: `${pl.name} API bilgileri .env dosyasında eksik.` });

  const result = await pl.fetchStock();
  if (result.error) return res.status(502).json({ ok: false, error: result.error });
  const merged = mergeStockRows(platform, result.rows);
  res.json({ ok: true, ...merged, total: result.rows.length });
});

// Bir ürünün merkezi stoğunu elle tüm yapılandırılmış platformlara anında gönder
app.post("/api/products/:barcode/push", requireAuth, async (req, res) => {
  const barcode = req.params.barcode;
  const p = products[barcode];
  if (!p) return res.status(404).json({ ok: false, error: "Ürün bulunamadı." });

  const results = {};
  await Promise.all(
    PLATFORMS.filter((pl) => pl.configured()).map(async (pl) => {
      const r = await pl.pushStock(barcode, p.centralStock);
      results[pl.id] = r;
      if (r.ok) p.stocks[pl.id] = p.centralStock;
    })
  );
  persistProducts();

  const entry = { time: new Date().toISOString(), barcode, name: p.name, centralStock: p.centralStock, trigger: "manuel", results };
  pushLog.push(entry);
  persistPushLog();

  res.json({ ok: true, results });
});

app.get("/api/push-log", requireAuth, (req, res) => {
  res.json({ log: pushLog.slice(-60).reverse() });
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Panel çalışıyor: http://localhost:${PORT}`);
  refreshAll().catch((e) => console.error("İlk veri çekme hatası:", e.message));
  setInterval(() => {
    refreshAll().catch((e) => console.error("Otomatik yenileme hatası:", e.message));
  }, Math.max(REFRESH_MINUTES, 5) * 60 * 1000);
});
