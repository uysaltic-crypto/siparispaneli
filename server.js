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
const REPRICE_HOURS = Number(process.env.REPRICE_INTERVAL_HOURS || 4);

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
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// Çiçeksepeti stok ucu (/api/v1/products/stock-price) 10 dakikada 1 istekten
// fazlasını kabul etmiyor ("Limit aşımı" hatası) — bu yüzden gönderimler anlık
// değil, bir kuyrukta biriktirilip pencere açılınca TEK istekte toplu gönderilir.
// Sunucu yeniden başlasa bile kuyruk ve son gönderim zamanı kalıcı tutulur.
let csStockQueue = new Map(Object.entries(loadJSON("cs-stock-queue.json", {})));
let csLastPushAt = Number(loadJSON("cs-last-push.json", {}).at) || 0;
function persistCsQueue() {
  saveJSON("cs-stock-queue.json", Object.fromEntries(csStockQueue));
}
function persistCsLastPush() {
  saveJSON("cs-last-push.json", { at: csLastPushAt });
}

// products artık "ürün kodu" (code) altında toplanır. Her ürün, platform bazında
// farklı bir barkod/SKU'ya bağlanabilir (skus: { hb: "...", ty: "...", ... }).
// Bir platform için ayrıca bir SKU tanımlanmamışsa, o platformda ürün kodunun
// kendisi SKU olarak kullanılır (geriye dönük uyumluluk).
function ensureProduct(code, name) {
  if (!products[code]) {
    products[code] = {
      name: name || "İsimsiz ürün",
      category: "",
      stocks: {},
      centralStock: 0,
      image: null,
      skus: {},
      prices: {}, // { platformId: number } — Prapazar'daki gibi her platformun kendi satış fiyatı
      // { platformId: string } — platformun kendi "Ürün Kodu / Model Kodu" bilgisi (stok kodundan
      // farklı: Çiçeksepeti'nde mainProductCode, Trendyol'da productMainId, N11'de n11ProductId).
      // Salt bilgi amaçlı — eşleştirmede kullanılmıyor, sadece panelde gösteriliyor.
      productCodes: {},
      listingStatus: {}, // { platformId: 'satista' | 'pasif' }
      pricing: { minPrice: null, maxPrice: null, myPrice: null, autoReprice: false, undercut: 0.01 },
      competitors: [], // [{ url, label, lastPrice, lastCheckedAt, lastError, sellerName }]
      // Bu ürün sürükle-bırak ile başka bir ürünün altında birleştirildiyse, ana
      // ürünün kodu burada tutulur (aşağıdaki "Birleştirme ailesi" bölümüne bakın).
      // Birleştirilmemiş / bağımsız bir ürünse null'dur.
      mergedInto: null,
    };
  }
  if (!products[code].stocks) products[code].stocks = {};
  if (!products[code].skus) products[code].skus = {};
  if (!products[code].prices) products[code].prices = {};
  if (!products[code].productCodes) products[code].productCodes = {};
  if (!products[code].listingStatus) products[code].listingStatus = {};
  if (products[code].category === undefined) products[code].category = "";
  if (!products[code].pricing) products[code].pricing = { minPrice: null, maxPrice: null, myPrice: null, autoReprice: false, undercut: 0.01 };
  if (!products[code].competitors) products[code].competitors = [];
  if (products[code].mergedInto === undefined) products[code].mergedInto = null;
  return products[code];
}

function skuForPlatform(code, platform) {
  const p = products[code];
  return (p?.skus?.[platform] || code || "").trim();
}

// Ürün bu platformda GERÇEKTEN kayıtlı mı? Siteden çekme / içe aktarma / sipariş /
// elle SKU girişi bir platform için `skus` (veya `productCodes`) kaydı bırakır.
// Hiçbir platformda kaydı olmayan (elle açılmış, henüz hiçbir yerden çekilmemiş) ürünlerde
// eski davranış korunur: her platformda varmış gibi kabul edilir.
function hasAnyListing(p) {
  return !!p && (Object.keys(p.skus || {}).length > 0 || Object.keys(p.productCodes || {}).length > 0);
}
function isListedOn(code, platform) {
  const p = products[code];
  if (!p) return false;
  if (p.skus?.[platform] || p.productCodes?.[platform]) return true;
  return !hasAnyListing(p);
}

/* ------------------------------------------------------------------
   Birleştirme ailesi: sürükle-bırak ile bir ürün başka birinin üzerine
   bırakıldığında artık SİLİNMİYOR — `mergedInto` alanına ana ürünün kodu
   yazılıyor ve kendi skus/stocks/prices/productCodes/listingStatus verisi
   olduğu gibi kalıyor. Böylece hiçbir "siteden çekilen kendi stok kodu"
   ezilip kaybolmuyor; panelde ana ürünün altında ayrı bir alt ürün olarak
   görünmeye devam ediyor. Merkezi stok tüm aile için ortak tutulur ve stok
   senkronizasyonu ailedeki her üyenin kendi gerçek platform SKU'suna da
   ayrıca gönderilir (aşağıya bakın: processNewOrdersAndSync, push endpoint).
------------------------------------------------------------------ */
function resolveRoot(code, _hops = 0) {
  const p = products[code];
  if (!p || !p.mergedInto || !products[p.mergedInto] || _hops > 10) return code;
  return resolveRoot(p.mergedInto, _hops + 1);
}

function getFamilyCodes(anyCode) {
  const root = resolveRoot(anyCode);
  const family = [root];
  Object.keys(products).forEach((c) => {
    if (c !== root && resolveRoot(c) === root) family.push(c);
  });
  return family;
}

// Merkezi stoğu ailenin tamamına (ana ürün + tüm alt ürünler) aynı değerle yazar.
function propagateCentralStock(anyCode, value) {
  const v = Number(value) || 0;
  getFamilyCodes(anyCode).forEach((c) => {
    if (products[c]) products[c].centralStock = v;
  });
}

// platform -> { sku: productCode } eşleşme dizini. Sipariş satırlarındaki barkodu
// veya içe aktarma/siteden çekme satırlarındaki SKU'yu hangi ürün koduna ait
// olduğunu bulmak için kullanılır.
function buildSkuIndex() {
  const platformIds = PLATFORMS.map((pl) => pl.id);
  const index = {};
  platformIds.forEach((id) => (index[id] = new Map()));
  Object.entries(products).forEach(([code, p]) => {
    platformIds.forEach((id) => {
      const sku = (p.skus?.[id] || code || "").trim();
      if (sku) index[id].set(sku, code);
    });
  });
  return index;
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
// Hepsiburada yetkilendirme (Ağustos 2024 "Yeni Entegratör Servis Auth" düzenlemesi,
// developers.hepsiburada.com): Basic Auth kullanıcı adı = Merchant ID, şifre = Servis
// Anahtarı (12 karakter; Satıcı Paneli > Bilgilerim > Entegrasyon > Entegratörlerim);
// User-Agent başlığı = geliştirici kullanıcı adı (örn. xxx_dev).
//   HB_MERCHANT_ID  → Merchant ID
//   HB_SERVICE_KEY  → Servis Anahtarı
//   HB_USERNAME     → geliştirici kullanıcı adı (User-Agent olarak gider)
// Eski yapı (HB_USERNAME + HB_PASSWORD ile doğrudan Basic Auth) HB_SERVICE_KEY
// tanımlı değilse geriye dönük uyumluluk için çalışmaya devam eder.
function hbConfigured() {
  const e = process.env;
  return !!(e.HB_MERCHANT_ID && e.HB_USERNAME && (e.HB_SERVICE_KEY || e.HB_PASSWORD));
}
function hbAuthConfig() {
  const { HB_MERCHANT_ID, HB_USERNAME, HB_PASSWORD, HB_SERVICE_KEY } = process.env;
  if (HB_SERVICE_KEY) {
    return { auth: { username: HB_MERCHANT_ID, password: HB_SERVICE_KEY }, userAgent: HB_USERNAME };
  }
  return { auth: { username: HB_USERNAME, password: HB_PASSWORD }, userAgent: `${HB_MERCHANT_ID} - SelfIntegration` };
}

async function fetchHepsiburadaOrders() {
  if (!hbConfigured()) return { platform: "hb", error: "Hepsiburada API bilgileri .env dosyasında eksik.", orders: [] };
  const { HB_MERCHANT_ID, HB_ENV } = process.env;
  const hbAuth = hbAuthConfig();
  const host = HB_ENV === "test" ? "oms-external-sit.hepsiburada.com" : "oms-external.hepsiburada.com";
  const url = `https://${host}/packages/merchantid/${HB_MERCHANT_ID}`;

  try {
    // Hepsiburada bu uçta limit ve offset parametrelerini ZORUNLU tutuyor
    // ("Bad Request limit and offset parameters are required") — sayfalayarak çekiyoruz.
    const raw = [];
    const limit = 50;
    for (let page = 0; page < 40; page++) {
      const resp = await axios.get(url, {
        auth: hbAuth.auth,
        params: { timespan: 24, limit, offset: page * limit },
        headers: { "User-Agent": hbAuth.userAgent, Accept: "application/json" },
        timeout: 20000,
      });
      const batch = Array.isArray(resp.data) ? resp.data : resp.data?.items || resp.data?.Items || resp.data?.packages || [];
      raw.push(...batch);
      if (batch.length < limit) break;
    }
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
  const { HB_MERCHANT_ID, HB_ENV } = process.env;
  const hbAuth = hbAuthConfig();
  const host = HB_ENV === "test" ? "listing-external-sit.hepsiburada.com" : "listing-external.hepsiburada.com";
  const url = `https://${host}/listings/merchantid/${HB_MERCHANT_ID}`;
  const rows = [];
  try {
    let offset = 0;
    const limit = 200;
    for (let page = 0; page < 25; page++) {
      const resp = await axios.get(url, {
        auth: hbAuth.auth,
        params: { limit, offset },
        headers: { "User-Agent": hbAuth.userAgent, Accept: "application/json" },
        timeout: 20000,
      });
      const items = resp.data?.listings || resp.data?.Listings || resp.data?.items || (Array.isArray(resp.data) ? resp.data : []);
      if (!items.length) break;
      items.forEach((it) => {
        const barcode = String(it.MerchantSku || it.merchantSku || it.Sku || it.sku || "").trim();
        if (!barcode) return;
        const price = Number(it.Price ?? it.price ?? it.SalePrice ?? it.salePrice ?? 0) || undefined;
        rows.push({
          barcode,
          stock: Number(it.AvailableStock ?? it.availableStock ?? 0),
          name: it.ProductName || it.productName || "",
          price,
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
  const { HB_MERCHANT_ID, HB_ENV } = process.env;
  const hbAuth = hbAuthConfig();
  const host = HB_ENV === "test" ? "listing-external-sit.hepsiburada.com" : "listing-external.hepsiburada.com";
  const url = `https://${host}/listings/merchantid/${HB_MERCHANT_ID}/stock-uploads`;
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<listings><listing><MerchantSku>${escapeXml(barcode)}</MerchantSku>` +
    `<AvailableStock>${qty}</AvailableStock></listing></listings>`;
  try {
    const resp = await axios.post(url, xml, {
      auth: hbAuth.auth,
      headers: { "Content-Type": "application/xml", Accept: "application/json", "User-Agent": hbAuth.userAgent },
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
        const productCode = item.productMainId || undefined; // Trendyol'da "Model Kodu"
        (item.variants || []).forEach((v) => {
          const barcode = String(v.barcode || v.stockCode || "").trim();
          if (!barcode) return;
          const price = Number(v.salePrice ?? v.listPrice ?? v.price ?? 0) || undefined;
          rows.push({ barcode, stock: Number(v.stock?.quantity ?? v.quantity ?? 0), name, image, price, productCode });
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

// Fiyat + stok birlikte gönderilir (Trendyol aynı uç noktayı kullanıyor). Otomatik
// fiyatlandırma motoru tarafından çağrılır.
async function pushPriceToTrendyol(barcode, salePrice, quantity) {
  if (!tyConfigured()) return { ok: false, message: "Trendyol API bilgisi eksik." };
  const { TY_SELLER_ID, TY_API_KEY, TY_API_SECRET, TY_ENV } = process.env;
  const host = TY_ENV === "test" ? "stageapigw.trendyol.com" : "apigw.trendyol.com";
  const url = `https://${host}/integration/inventory/sellers/${TY_SELLER_ID}/products/price-and-inventory`;
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  const price = Math.round(Number(salePrice) * 100) / 100;
  try {
    const resp = await axios.post(
      url,
      { items: [{ barcode, quantity: qty, salePrice: price, listPrice: price }] },
      { auth: { username: TY_API_KEY, password: TY_API_SECRET }, headers: { "Content-Type": "application/json" }, timeout: 15000 }
    );
    return { ok: true, message: "Gönderildi", batchRequestId: resp.data?.batchRequestId || null };
  } catch (err) {
    return { ok: false, message: err.response?.data ? JSON.stringify(err.response.data).slice(0, 250) : err.message };
  }
}

/* ==================================================================
   Rekabet takibi — RESMİ BİR API DEĞİL. Rakip ürün sayfası genel
   (public) HTML'i çekilip fiyat ayıklanır. Bu yüzden "best effort"tur:
   sayfa tasarımı değişirse ayıklama bozulabilir. Öncelik JSON-LD
   (schema.org Product/Offer) verisine verilir çünkü bu, görsel
   tasarım değişse bile genelde aynı kalan yapısal bir veridir.
================================================================== */
async function fetchCompetitorPrice(url) {
  try {
    const resp = await axios.get(url, {
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      maxRedirects: 5,
    });
    const html = String(resp.data);

    // 1) JSON-LD (schema.org Product/Offer) — en güvenilir yol
    const ldBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    for (const m of ldBlocks) {
      try {
        let data = JSON.parse(m[1].trim());
        const items = Array.isArray(data) ? data : data["@graph"] || [data];
        for (const item of items) {
          const offers = item?.offers ? (Array.isArray(item.offers) ? item.offers : [item.offers]) : null;
          if (offers) {
            const price = offers.map((o) => Number(o.price || o.lowPrice)).find((n) => !isNaN(n) && n > 0);
            if (price) return { ok: true, price, sellerName: offers[0]?.seller?.name || null };
          }
        }
      } catch (_) {
        /* bu blok JSON-LD değilse yoksay, diğerine bak */
      }
    }

    // 2) Yedek: meta etiketi (og:price:amount / product:price:amount)
    const metaMatch = html.match(/<meta[^>]+(?:property|name)=["'](?:og:price:amount|product:price:amount)["'][^>]+content=["']([\d.,]+)["']/i);
    if (metaMatch) {
      const price = Number(metaMatch[1].replace(/\./g, "").replace(",", "."));
      if (price > 0) return { ok: true, price, sellerName: null };
    }

    return { ok: false, error: "Sayfadan fiyat okunamadı (yapı değişmiş olabilir)." };
  } catch (err) {
    const status = err.response?.status;
    if (status === 403 || status === 429) return { ok: false, error: "Site erişimi engelledi (çok sık çekiliyor olabilir)." };
    return { ok: false, error: err.message };
  }
}

function clamp(n, min, max) {
  let v = n;
  if (min !== null && min !== undefined && min !== "") v = Math.max(v, Number(min));
  if (max !== null && max !== undefined && max !== "") v = Math.min(v, Number(max));
  return Math.round(v * 100) / 100;
}

// Tek bir ürün için: rakip fiyatlarını tazeler, otomatik fiyatlandırma açıksa
// yeni fiyatı hesaplayıp Trendyol'a gönderir. results.priceLog'a bir kayıt düşer.
async function repriceProduct(code) {
  const p = products[code];
  if (!p) return { ok: false, error: "Ürün bulunamadı." };

  await Promise.all(
    (p.competitors || []).map(async (c) => {
      const r = await fetchCompetitorPrice(c.url);
      c.lastCheckedAt = new Date().toISOString();
      if (r.ok) {
        c.lastPrice = r.price;
        c.sellerName = r.sellerName || c.sellerName;
        c.lastError = null;
      } else {
        c.lastError = r.error;
      }
    })
  );

  let pushResult = null;
  const prices = (p.competitors || []).map((c) => c.lastPrice).filter((n) => typeof n === "number" && n > 0);
  const lowest = prices.length ? Math.min(...prices) : null;

  if (p.pricing.autoReprice && p.pricing.minPrice != null && p.pricing.maxPrice != null && lowest != null) {
    const target = clamp(lowest - (Number(p.pricing.undercut) || 0), p.pricing.minPrice, p.pricing.maxPrice);
    if (target !== p.pricing.myPrice) {
      const qty = p.stocks?.ty ?? p.centralStock ?? 0;
      const sku = skuForPlatform(code, "ty");
      const r = await pushPriceToTrendyol(sku, target, qty);
      pushResult = { ok: r.ok, message: r.message, newPrice: target };
      if (r.ok) {
        p.pricing.myPrice = target;
        p.prices.ty = target;
      }
      pushLog.push({
        time: new Date().toISOString(),
        barcode: code,
        name: p.name,
        centralStock: p.centralStock,
        trigger: "otomatik fiyatlandırma",
        results: { ty: r },
      });
      persistPushLog();
    }
  }

  persistProducts();
  return { ok: true, lowest, pushResult, competitors: p.competitors };
}

async function repriceAll() {
  const codes = Object.keys(products).filter((c) => (products[c].competitors || []).length > 0);
  for (const code of codes) {
    try {
      await repriceProduct(code);
    } catch (e) {
      console.error("Rekabet kontrolü hatası:", code, e.message);
    }
  }
  return { checked: codes.length };
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

// Satıcı Ürün Sorgulama — developer.n11.com/documentation/n11-marketplace-entegrasyonu/satici-urun-sorgulama/
// GET https://api.n11.com/ms/product-query (appKey/appSecret header, page 0'dan başlar, size max 250)
async function fetchStockN11() {
  if (!n11Configured()) return { platform: "n11", error: "N11 API bilgileri .env dosyasında eksik.", rows: [] };
  const { N11_APP_KEY, N11_APP_SECRET } = process.env;
  const url = "https://api.n11.com/ms/product-query";
  const rows = [];
  try {
    let page = 0;
    for (let i = 0; i < 50; i++) {
      const resp = await axios.get(url, {
        headers: { appKey: N11_APP_KEY, appSecret: N11_APP_SECRET, Accept: "application/json" },
        params: { page, size: 250 },
        timeout: 20000,
      });
      const content = resp.data?.content || [];
      content.forEach((it) => {
        const barcode = String(it.stockCode || "").trim();
        if (!barcode) return;
        const price = Number(it.salePrice ?? it.listPrice ?? 0) || undefined;
        const productCode = it.n11ProductId != null ? String(it.n11ProductId) : undefined; // N11'de "N11 Ürün Kodu"
        rows.push({ barcode, stock: Number(it.quantity ?? 0), name: it.title || "", price, image: it.imageUrls?.[0] || undefined, productCode });
      });
      const totalPages = resp.data?.totalPages ?? 1;
      page++;
      if (!content.length || page >= totalPages) break;
    }
    return { platform: "n11", error: null, rows };
  } catch (err) {
    const msg =
      err.response?.status === 401 || err.response?.status === 403
        ? "N11 kimlik doğrulama hatası — appKey/appSecret'i kontrol et."
        : err.response?.data
        ? `N11 hata: ${JSON.stringify(err.response.data).slice(0, 300)}`
        : `N11 bağlantı hatası: ${err.message}`;
    return { platform: "n11", error: msg, rows: [] };
  }
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
   ÇİÇEKSEPETİ — ciceksepeti.dev resmi dokümanına göre doğrulandı (25.09.2026):
   - Base URL: prod https://apis.ciceksepeti.com/api/v1/ , test https://sandbox-apis.ciceksepeti.com/api/v1/
   - Sipariş listesi: POST /api/v1/Order/GetOrders  (GET DEĞİL, body ile parametre)
   - Her istekte iki header zorunlu: x-api-key (API Key) VE user-agent
     (entegratör kullanılmıyorsa sadece Satıcı ID; entegratörle çalışılıyorsa
     "Satıcı Id-Entegratör Adı")
   - Aynı request body ile dakikada 1 istekten fazla atılamıyor (rate limit).
================================================================== */
function csConfigured() {
  return !!(process.env.CS_API_KEY && process.env.CS_SUPPLIER_ID);
}

// Çiçeksepeti'nden sadece stok kodu belirli bir önekle (varsayılan: "kcm") başlayan
// ürünler alınır. Değiştirmek için .env'e CS_CODE_PREFIX=xxx yaz; boş bırakırsan
// (CS_CODE_PREFIX=) filtre kapanır ve tüm ürünler gelir. Büyük/küçük harf fark etmez.
function csCodePrefix() {
  return (process.env.CS_CODE_PREFIX !== undefined ? process.env.CS_CODE_PREFIX : "kcm").trim().toLowerCase();
}
function csCodeAllowed(code) {
  const prefix = csCodePrefix();
  if (!prefix) return true;
  return String(code || "").trim().toLowerCase().startsWith(prefix);
}

function csHost() {
  return process.env.CS_ENV === "test" ? "sandbox-apis.ciceksepeti.com" : "apis.ciceksepeti.com";
}

function csHeaders() {
  const { CS_API_KEY, CS_SUPPLIER_ID, CS_INTEGRATOR_NAME } = process.env;
  const userAgent = CS_INTEGRATOR_NAME ? `${CS_SUPPLIER_ID}-${CS_INTEGRATOR_NAME}` : String(CS_SUPPLIER_ID);
  return { "x-api-key": CS_API_KEY, "user-agent": userAgent, "Content-Type": "application/json", Accept: "application/json" };
}

async function fetchCiceksepetiOrders() {
  if (!csConfigured())
    return { platform: "cs", error: "Çiçeksepeti API bilgisi .env dosyasında eksik (CS_API_KEY, CS_SUPPLIER_ID).", orders: [] };
  const url = `https://${csHost()}/api/v1/Order/GetOrders`;
  const endDate = new Date();
  const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  try {
    const resp = await axios.post(
      url,
      { startDate: startDate.toISOString(), endDate: endDate.toISOString(), pageSize: 100, page: 0 },
      { headers: csHeaders(), timeout: 20000 }
    );
    const orders = resp.data?.orders || resp.data?.Orders || resp.data?.result || resp.data?.data || resp.data?.content || [];
    return { platform: "cs", error: null, orders: (Array.isArray(orders) ? orders : []).map(normalizeCsPackage) };
  } catch (err) {
    const detail = err.response?.data ? ` — ${JSON.stringify(err.response.data).slice(0, 300)}` : "";
    const msg =
      err.response?.status === 401 || err.response?.status === 403
        ? `Çiçeksepeti kimlik doğrulama hatası (${err.response.status})${detail}`
        : err.response?.data
        ? `Çiçeksepeti hata: ${JSON.stringify(err.response.data).slice(0, 300)}`
        : `Çiçeksepeti bağlantı hatası: ${err.message}`;
    return { platform: "cs", error: msg, orders: [] };
  }
}

function normalizeCsPackage(pkg) {
  const items = pkg.orderItems || pkg.items || pkg.lines || [];
  const lines = items
    .map((it) => ({
      barcode: String(it.stockCode || it.barcode || "").trim(),
      quantity: Number(it.quantity || 1),
      name: it.productName || it.stockCode || "",
    }))
    .filter((l) => csCodeAllowed(l.barcode));
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

// Ürün Listeleme — ciceksepeti.dev resmi dokümanına göre doğrulandı (25.09.2026):
// GET /api/v1/Products — Page 1'den başlar, PageSize en fazla 60.
// Response: { totalCount, products: [{ stockCode, stockQuantity, salesPrice, productName, images: [...] }] }
// NOT: Bu uç nokta "farklı istekleri 5 saniyede 1 kez" kabul ediyor (rate limit) —
// çok sayfalı ürün listesi çekerken sayfalar arasına bu yüzden bekleme konuyor.
async function fetchStockCiceksepeti() {
  if (!csConfigured()) return { platform: "cs", error: "Çiçeksepeti API bilgisi .env dosyasında eksik (CS_API_KEY, CS_SUPPLIER_ID).", rows: [] };
  const url = `https://${csHost()}/api/v1/Products`;
  const rows = [];
  let page = 1;
  let totalCount = Infinity;
  while (rows.length < totalCount && page < 200) {
    try {
      if (page > 1) await sleep(5200); // "5 saniyede 1 farklı istek" sınırına takılmamak için
      const resp = await axios.get(url, { headers: csHeaders(), params: { Page: page, PageSize: 60 }, timeout: 20000 });
      const products = resp.data?.products || resp.data?.Products || [];
      totalCount = Number(resp.data?.totalCount ?? resp.data?.TotalCount ?? products.length);
      products.forEach((it) => {
        const barcode = String(it.stockCode || it.StockCode || "").trim();
        if (!barcode || !csCodeAllowed(barcode)) return;
        const price = Number(it.salesPrice ?? it.SalesPrice ?? 0) || undefined;
        const productCode = it.mainProductCode || it.MainProductCode || undefined; // Çiçeksepeti'nde "Ürün Kodu"
        rows.push({
          barcode,
          stock: Number(it.stockQuantity ?? it.StockQuantity ?? 0),
          name: it.productName || it.ProductName || "",
          price,
          image: it.images?.[0] || it.Images?.[0] || undefined,
          productCode,
        });
      });
      if (!products.length) break;
      page++;
    } catch (err) {
      const detail = err.response?.data ? ` — ${JSON.stringify(err.response.data).slice(0, 300)}` : "";
      const msg =
        err.response?.status === 401 || err.response?.status === 403
          ? `Çiçeksepeti kimlik doğrulama hatası (${err.response.status})${detail}`
          : err.response?.data
          ? `Çiçeksepeti hata (sayfa ${page})${rows.length ? `, ${rows.length} ürün alındıktan sonra` : ""}: ${JSON.stringify(err.response.data).slice(0, 300)}`
          : `Çiçeksepeti bağlantı hatası: ${err.message}`;
      // Önceki sayfalardan toplanan ürünler varsa onları at, kısmi sonuçla dön —
      // tüm listeyi boşa düşürmek yerine "şimdilik bu kadarı geldi" demek daha iyi.
      return { platform: "cs", error: msg, rows };
    }
  }
  return { platform: "cs", error: null, rows };
}

// NOT: "Ürün Yönetimi" > stok/fiyat güncelleme ucu (/api/v1/products/stock-price)
// canlıda denendiğinde şu hatayı verdi: "Limit aşımı! Bu endpointe aynı isteği
// 10 dakikada 1 kez atabilirsiniz." — yani ürün bazında değil, UÇ NOKTA bazında
// 10 dakikada sadece 1 istek kabul ediliyor. Bu yüzden her ürün için ayrı ayrı
// anlık göndermek yerine: gelen güncellemeler bir kuyrukta biriktirilir, 10
// dakikalık pencere açık ise hemen (kuyrukta birikmiş her şeyle birlikte) TEK
// istekte gönderilir; pencere kapalıysa kuyruğa eklenir ve pencere açılır
// açılmaz otomatik olarak toplu gönderilir.
const CS_STOCK_RATE_LIMIT_MS = 10 * 60 * 1000 + 5000; // 10 dk + küçük güvenlik payı
let csFlushTimer = null;

async function csFlushStockQueue() {
  csFlushTimer = null;
  if (!csStockQueue.size) return { ok: true, message: "Kuyruk boş" };
  // Kuyruk değeri eski sürümde sadece sayıydı; yeni sürümde { qty, price }.
  const items = Array.from(csStockQueue.entries()).map(([stockCode, v]) => {
    const qty = typeof v === "object" && v !== null ? v.qty : v;
    const price = typeof v === "object" && v !== null ? v.price : undefined;
    const item = { stockCode, stockQuantity: qty };
    if (Number(price) > 0) {
      item.listPrice = price;
      item.salesPrice = price;
    }
    return item;
  });
  csStockQueue = new Map();
  csLastPushAt = Date.now();
  persistCsQueue();
  persistCsLastPush();
  let ok = true;
  let message = "Gönderildi";
  try {
    await axios.post(`https://${csHost()}/api/v1/products/stock-price`, { items }, { headers: csHeaders(), timeout: 15000 });
  } catch (err) {
    ok = false;
    message = err.response?.data ? JSON.stringify(err.response.data).slice(0, 250) : err.message;
  }
  pushLog.push({
    time: new Date().toISOString(),
    barcode: items.map((i) => i.stockCode).join(", "),
    name: `${items.length} ürün (Çiçeksepeti toplu gönderim)`,
    centralStock: null,
    trigger: "cs-toplu",
    results: { cs: ok ? { ok: true } : { ok: false, message } },
  });
  persistPushLog();
  return { ok, message };
}

function csScheduleFlush(delayMs) {
  if (csFlushTimer) return;
  csFlushTimer = setTimeout(() => {
    csFlushStockQueue().catch(() => {});
  }, Math.max(0, delayMs));
}

// Sunucu, kuyrukta bekleyen kayıtlarla yeniden başlamış olabilir — pencere
// zaten açıksa hemen, değilse kalan süre kadar bekleyip otomatik gönder.
if (csStockQueue.size) {
  csScheduleFlush(Math.max(0, CS_STOCK_RATE_LIMIT_MS - (Date.now() - csLastPushAt)));
}

async function pushStockToCiceksepeti(barcode, quantity, price) {
  if (!csConfigured()) return { ok: false, message: "Çiçeksepeti API bilgisi eksik." };
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  const prev = csStockQueue.get(String(barcode));
  const prevPrice = typeof prev === "object" && prev !== null ? prev.price : undefined;
  const pr = Number(price) > 0 ? Math.round(Number(price) * 100) / 100 : prevPrice;
  csStockQueue.set(String(barcode), { qty, price: pr });
  persistCsQueue();

  const elapsed = Date.now() - csLastPushAt;
  if (elapsed >= CS_STOCK_RATE_LIMIT_MS) {
    return await csFlushStockQueue();
  }
  const remainingMin = Math.max(1, Math.ceil((CS_STOCK_RATE_LIMIT_MS - elapsed) / 60000));
  csScheduleFlush(CS_STOCK_RATE_LIMIT_MS - elapsed);
  return { ok: true, message: `Çiçeksepeti hız sınırı nedeniyle kuyruğa alındı — en geç ${remainingMin} dk içinde toplu gönderilecek` };
}

/* ==================================================================
   KOÇTAŞ — koctas.mirakl.net standart Mirakl altyapısı üzerinde çalışıyor
   (ekran görüntüsündeki "Koçtaş Satış Ortağım" panelinde Ayarlar > API
   Anahtarı bölümünden alınan anahtarla). Mirakl'ın resmi Seller API
   dokümanına göre (developer.mirakl.com):
   - Kimlik doğrulama: her istekte "Authorization: {API anahtarı}" header'ı
     (Mirakl'a özel — appKey/appSecret ikilisi yok, tek bir anahtar yeterli).
   - Sipariş listesi: GET /api/orders (OR11) — sayfalama offset/max ile.
   - Ürün/teklif listesi (stok+fiyat): GET /api/offers (OF21).
   - Stok güncelleme: POST /api/offers/stock/imports (STO01) — CSV dosyası,
     multipart/form-data, "offer-sku";"quantity";"warehouse-code";"update-delete"
     formatında. Diğer platformlardan farklı olarak SENKRON değil: istek bir
     import_id döner, gerçek güncelleme Mirakl tarafında kuyrukta işlenir.
   - shop_id parametresi opsiyonel — hesabın tek mağazası varsa Mirakl
     otomatik olarak onu kullanır; birden fazla mağazaya erişimi olan
     hesaplarda .env'e KOCTAS_SHOP_ID eklenmesi gerekebilir.
   Uç noktalar resmi dokümana göre doğru yazıldı ancak bu hesapla henüz
   canlı test edilmedi — bu yüzden aşağıda "verified: false" işaretli;
   ilk denemede hata alırsan Senkron Günlüğü'ndeki mesajı ilet.
================================================================== */
function koctasConfigured() {
  return !!process.env.KOCTAS_API_KEY;
}

function koctasHost() {
  return process.env.KOCTAS_HOST || "koctas.mirakl.net";
}

function koctasHeaders(extra) {
  return { Authorization: process.env.KOCTAS_API_KEY, Accept: "application/json", ...extra };
}

function koctasShopParams() {
  return process.env.KOCTAS_SHOP_ID ? { shop_id: Number(process.env.KOCTAS_SHOP_ID) } : {};
}

async function fetchKoctasOrders() {
  if (!koctasConfigured()) return { platform: "koctas", error: "Koçtaş API bilgisi .env dosyasında eksik (KOCTAS_API_KEY).", orders: [] };
  const url = `https://${koctasHost()}/api/orders`;
  try {
    const resp = await axios.get(url, {
      headers: koctasHeaders(),
      params: { ...koctasShopParams(), max: 100 },
      timeout: 20000,
    });
    const orders = resp.data?.orders || [];
    return { platform: "koctas", error: null, orders: orders.map(normalizeKoctasOrder) };
  } catch (err) {
    const detail = err.response?.data ? ` — ${JSON.stringify(err.response.data).slice(0, 300)}` : "";
    const msg =
      err.response?.status === 401 || err.response?.status === 403
        ? `Koçtaş kimlik doğrulama hatası (${err.response.status})${detail}`
        : err.response?.data
        ? `Koçtaş hata: ${JSON.stringify(err.response.data).slice(0, 300)}`
        : `Koçtaş bağlantı hatası: ${err.message}`;
    return { platform: "koctas", error: msg, orders: [] };
  }
}

function normalizeKoctasOrder(o) {
  const lines = (o.order_lines || o.lines || []).map((l) => ({
    barcode: String(l.offer_sku || l.shop_sku || l.product_sku || "").trim(),
    quantity: Number(l.quantity || 1),
    name: l.product_title || l.offer_sku || "",
  }));
  return {
    platform: "koctas",
    orderNumber: o.order_id || o.commercial_id || String(o.id || "—"),
    packageId: String(o.order_id || o.id || ""),
    customer: [o.customer?.firstname, o.customer?.lastname].filter(Boolean).join(" ") || "Müşteri",
    city: o.customer?.shipping_address?.city || "",
    productSummary: lines.map((l) => `${l.name || l.barcode || "Ürün"} x${l.quantity}`).join(", ") || "—",
    amount: Number(o.total_price ?? o.price ?? 0),
    status: o.order_state || o.status || "—",
    date: o.created_date ? new Date(o.created_date).getTime() : null,
    lines,
  };
}

// Ürün/teklif listesi — Mirakl OF21: GET /api/offers (offset/max sayfalama).
async function fetchStockKoctas() {
  if (!koctasConfigured()) return { platform: "koctas", error: "Koçtaş API bilgisi .env dosyasında eksik (KOCTAS_API_KEY).", rows: [] };
  const url = `https://${koctasHost()}/api/offers`;
  const rows = [];
  try {
    let offset = 0;
    const max = 100;
    let totalCount = Infinity;
    while (offset < totalCount && offset < 20000) {
      const resp = await axios.get(url, {
        headers: koctasHeaders(),
        params: { ...koctasShopParams(), offset, max },
        timeout: 20000,
      });
      const offers = resp.data?.offers || [];
      totalCount = Number(resp.data?.total_count ?? offers.length + offset);
      offers.forEach((o) => {
        const barcode = String(o.shop_sku || o.sku || "").trim();
        if (!barcode) return;
        const price = Number(o.price ?? 0) || undefined;
        const productCode = o.product_sku != null ? String(o.product_sku) : undefined; // Mirakl "product-id"
        rows.push({
          barcode,
          stock: Number(o.quantity ?? 0),
          name: o.product_title || "",
          price,
          image: o.product_image_urls?.[0] || undefined,
          productCode,
        });
      });
      if (!offers.length) break;
      offset += max;
    }
    return { platform: "koctas", error: null, rows };
  } catch (err) {
    const detail = err.response?.data ? ` — ${JSON.stringify(err.response.data).slice(0, 300)}` : "";
    const msg =
      err.response?.status === 401 || err.response?.status === 403
        ? `Koçtaş kimlik doğrulama hatası (${err.response.status})${detail}`
        : err.response?.data
        ? `Koçtaş hata: ${JSON.stringify(err.response.data).slice(0, 300)}`
        : `Koçtaş bağlantı hatası: ${err.message}`;
    return { platform: "koctas", error: msg, rows: [] };
  }
}

// Stok güncelleme — Mirakl STO01: POST /api/offers/stock/imports. multipart/form-data
// gerektiriyor; ekstra bir npm paketine ihtiyaç duymamak için gövde, Google Drive
// yedekleme fonksiyonunda (uploadBackupToDrive) olduğu gibi elle inşa ediliyor.
// Diğer platformlardan farklı olarak yanıt anında "başarılı/başarısız" değil, bir
// import_id döner — gerçek sonuç Mirakl tarafında ayrıca işlenir.
async function pushStockToKoctas(barcode, quantity) {
  if (!koctasConfigured()) return { ok: false, message: "Koçtaş API bilgisi eksik." };
  const url = `https://${koctasHost()}/api/offers/stock/imports`;
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  const sku = String(barcode).replace(/"/g, '""');
  const csv = `"offer-sku";"quantity";"warehouse-code";"update-delete"\r\n"${sku}";"${qty}";"";""\r\n`;

  const boundary = "koctasstok" + crypto.randomBytes(8).toString("hex");
  const body =
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="stok.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n` +
    `--${boundary}--`;

  try {
    const resp = await axios.post(url, body, {
      headers: koctasHeaders({ "Content-Type": `multipart/form-data; boundary=${boundary}` }),
      params: koctasShopParams(),
      timeout: 15000,
    });
    return { ok: true, message: "Gönderildi (Mirakl kuyruğuna alındı)", importId: resp.data?.import_id || null };
  } catch (err) {
    return { ok: false, message: err.response?.data ? JSON.stringify(err.response.data).slice(0, 250) : err.message };
  }
}

// Fiyat güncelleme — Mirakl PRI01: POST /api/offers/pricing/imports (multipart, "file" alanında
// CSV: "offer-sku";"price"). Dakikada en fazla 1 istek; yanıt import_id döner (kuyruğa alınır).
async function pushPriceToKoctas(barcode, price) {
  if (!koctasConfigured()) return { ok: false, message: "Koçtaş API bilgisi eksik." };
  const url = `https://${koctasHost()}/api/offers/pricing/imports`;
  const sku = String(barcode).replace(/"/g, '""');
  const pr = (Math.round(Number(price) * 100) / 100).toFixed(2);
  const csv = `"offer-sku";"price"\r\n"${sku}";"${pr}"\r\n`;
  const boundary = "koctasfiyat" + crypto.randomBytes(8).toString("hex");
  const body =
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fiyat.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n` +
    `--${boundary}--`;
  try {
    const resp = await axios.post(url, body, {
      headers: koctasHeaders({ "Content-Type": `multipart/form-data; boundary=${boundary}` }),
      params: koctasShopParams(),
      timeout: 15000,
    });
    return { ok: true, message: "Fiyat gönderildi (Mirakl kuyruğuna alındı)", importId: resp.data?.import_id || null };
  } catch (err) {
    return { ok: false, message: err.response?.data ? JSON.stringify(err.response.data).slice(0, 250) : err.message };
  }
}

// N11: aynı price-stock-update görevi fiyatı da taşıyabiliyor (listPrice/salePrice).
async function pushListingToN11(barcode, quantity, price) {
  if (!n11Configured()) return { ok: false, message: "N11 API bilgisi eksik." };
  const { N11_APP_KEY, N11_APP_SECRET } = process.env;
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  const pr = Math.round(Number(price) * 100) / 100;
  const body = {
    payload: { integrator: "TicaretPaneli", skus: [{ stockCode: barcode, quantity: qty, listPrice: pr, salePrice: pr, currencyType: "TL" }] },
  };
  try {
    const resp = await axios.post("https://api.n11.com/ms/product/tasks/price-stock-update", body, {
      headers: { appKey: N11_APP_KEY, appSecret: N11_APP_SECRET, "Content-Type": "application/json" },
      timeout: 15000,
    });
    if (resp.data?.status === "REJECT") return { ok: false, message: (resp.data?.reasons || []).join(" ") || "N11 reddetti." };
    return { ok: true, message: "Gönderildi", taskId: resp.data?.id || null };
  } catch (err) {
    return { ok: false, message: err.response?.data ? JSON.stringify(err.response.data).slice(0, 250) : err.message };
  }
}

// Hepsiburada: price-uploads (XML, stok gönderimiyle aynı yapı). Resmi örnekte ondalık ayracı virgül.
async function pushPriceToHepsiburada(barcode, price) {
  if (!hbConfigured()) return { ok: false, message: "Hepsiburada API bilgisi eksik." };
  const { HB_MERCHANT_ID, HB_ENV } = process.env;
  const hbAuth = hbAuthConfig();
  const host = HB_ENV === "test" ? "listing-external-sit.hepsiburada.com" : "listing-external.hepsiburada.com";
  const url = `https://${host}/listings/merchantid/${HB_MERCHANT_ID}/price-uploads`;
  const pr = (Math.round(Number(price) * 100) / 100).toFixed(2).replace(".", ",");
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<listings><listing><MerchantSku>${escapeXml(barcode)}</MerchantSku><Price>${pr}</Price></listing></listings>`;
  try {
    const resp = await axios.post(url, xml, {
      auth: hbAuth.auth,
      headers: { "Content-Type": "application/xml", Accept: "application/json", "User-Agent": hbAuth.userAgent },
      timeout: 15000,
    });
    return { ok: true, message: "Fiyat gönderildi", trackingId: resp.data?.Id || resp.data?.id || null };
  } catch (err) {
    return { ok: false, message: err.response?.data ? JSON.stringify(err.response.data).slice(0, 250) : err.message };
  }
}

// Bir platforma bir ürünün STOK + FİYAT bilgisini birlikte gönderir. Fiyat yoksa sadece stok gider.
async function pushListingToPlatform(platformId, sku, quantity, price) {
  const pl = PLATFORMS.find((x) => x.id === platformId);
  if (!pl) return { ok: false, message: "Geçersiz platform." };
  const hasPrice = Number(price) > 0;
  if (!hasPrice) return pl.pushStock(sku, quantity);
  switch (platformId) {
    case "ty":
      return pushPriceToTrendyol(sku, price, quantity);
    case "n11":
      return pushListingToN11(sku, quantity, price);
    case "cs":
      return pushStockToCiceksepeti(sku, quantity, price);
    case "hb": {
      const [stockRes, priceRes] = await Promise.all([pl.pushStock(sku, quantity), pushPriceToHepsiburada(sku, price)]);
      const ok = stockRes.ok && priceRes.ok;
      return { ok, message: ok ? "Stok ve fiyat gönderildi" : [!stockRes.ok && `stok: ${stockRes.message}`, !priceRes.ok && `fiyat: ${priceRes.message}`].filter(Boolean).join(" | ") };
    }
    case "koctas": {
      const stockRes = await pl.pushStock(sku, quantity);
      const priceRes = await pushPriceToKoctas(sku, price);
      const ok = stockRes.ok && priceRes.ok;
      return { ok, message: ok ? "Stok ve fiyat gönderildi (Mirakl kuyruğuna alındı)" : [!stockRes.ok && `stok: ${stockRes.message}`, !priceRes.ok && `fiyat: ${priceRes.message}`].filter(Boolean).join(" | ") };
    }
    default:
      return pl.pushStock(sku, quantity);
  }
}

/* ==================================================================
   PLATFORM KAYDI — yeni bir pazaryeri eklemek için buraya bir satır
================================================================== */
const PLATFORMS = [
  { id: "hb", name: "Hepsiburada", color: "#FF6A00", configured: hbConfigured, fetchOrders: fetchHepsiburadaOrders, pushStock: pushStockToHepsiburada, fetchStock: fetchStockHepsiburada, stockPullVerified: false, verified: true, panelUrl: "https://merchant.hepsiburada.com/" },
  { id: "ty", name: "Trendyol", color: "#00C2B2", configured: tyConfigured, fetchOrders: fetchTrendyolOrders, pushStock: pushStockToTrendyol, fetchStock: fetchStockTrendyol, stockPullVerified: true, verified: true, panelUrl: "https://partner.trendyol.com/" },
  { id: "n11", name: "N11", color: "#7B2CBF", configured: n11Configured, fetchOrders: fetchN11Orders, pushStock: pushStockToN11, fetchStock: fetchStockN11, stockPullVerified: true, verified: true, panelUrl: "https://so.n11.com/" },
  // Sipariş çekme (GetOrders) ve ürün listeleme (Products) resmi dokümana göre doğrulandı;
  // stok/fiyat gönderme ucu (products/stock-price) henüz doğrulanmadı.
  { id: "cs", name: "Çiçeksepeti", color: "#E4287C", configured: csConfigured, fetchOrders: fetchCiceksepetiOrders, pushStock: pushStockToCiceksepeti, fetchStock: fetchStockCiceksepeti, stockPullVerified: true, verified: true, panelUrl: "https://seller.ciceksepeti.com/" },
  // Mirakl'ın resmi API dokümanına göre yazıldı (OR11/OF21/STO01) ama bu hesapla
  // henüz canlı denenmedi — ilk kullanımda uç nokta/alan adlarını birlikte doğrularız.
  { id: "koctas", name: "Koçtaş", color: "#F58220", configured: koctasConfigured, fetchOrders: fetchKoctasOrders, pushStock: pushStockToKoctas, fetchStock: fetchStockKoctas, stockPullVerified: false, verified: false, panelUrl: `https://${koctasHost()}/` },
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
      panelUrl: p.panelUrl || null,
    })),
  });
});

/* ------------------------------------------------------------------
   Yeni siparişlerden stok düşürme + tüm yapılandırılmış platformlara
   otomatik geri yazma
------------------------------------------------------------------ */
async function processNewOrdersAndSync(ordersByPlatform) {
  const changedCodes = new Set();
  let newlyProcessed = 0;
  const skuIndex = buildSkuIndex();

  function handleOrder(order) {
    if (!order.packageId && !order.orderNumber) return;
    const key = `${order.platform}:${order.packageId || order.orderNumber}`;
    if (processedPackages.has(key)) return;

    (order.lines || []).forEach((line) => {
      if (!line.barcode) return;
      // Bu platformdaki SKU daha önce bir ürün koduna bağlanmışsa onu kullan;
      // yoksa yeni bir ürün oluştur (kod = bu platformdaki barkod).
      const code = skuIndex[order.platform]?.get(line.barcode) || line.barcode;
      const p = ensureProduct(code, line.name);
      if (!p.skus[order.platform]) p.skus[order.platform] = line.barcode;
      if (line.name && (!p.name || p.name === "İsimsiz ürün")) p.name = line.name;
      // Bu ürün birleştirme ile bir ana ürünün altındaysa, merkezi stok TÜM aile
      // için ortak: düşüşü ailenin ortak stoğundan yap ve tüm aileye yay.
      const root = resolveRoot(code);
      const currentFamilyStock = Number(products[root]?.centralStock) || 0;
      const newStock = Math.max(0, currentFamilyStock - (Number(line.quantity) || 1));
      propagateCentralStock(root, newStock);
      changedCodes.add(root);
    });

    processedPackages.add(key);
    newlyProcessed++;
  }

  ordersByPlatform.forEach((orders) => orders.forEach(handleOrder));

  if (newlyProcessed) {
    persistProcessed();
    persistProducts();
  }

  for (const rootCode of changedCodes) {
    const root = products[rootCode];
    if (!root) continue;
    const familyCodes = getFamilyCodes(rootCode);
    const central = Number(root.centralStock) || 0;
    const results = {};
    await Promise.all(
      PLATFORMS.filter((pl) => pl.configured()).map(async (pl) => {
        // Ana ürünün kendi kaydı (eskiden olduğu gibi — SKU tanımlı değilse ürün
        // kodu fallback olarak kullanılır) + bu platformda gerçek/kendi SKU'su olan
        // her alt ürün AYRICA gönderilir, böylece hangi platformda kaç farklı
        // listeleme (SKU) varsa hepsi güncel stokla senkron kalır.
        const targets = isListedOn(rootCode, pl.id) ? [{ code: rootCode, sku: skuForPlatform(rootCode, pl.id) }] : [];
        familyCodes.forEach((c) => {
          if (c === rootCode) return;
          const ownSku = products[c]?.skus?.[pl.id];
          if (ownSku) targets.push({ code: c, sku: ownSku });
        });
        const outcomes = await Promise.all(
          targets.map(async (t) => {
            const r = await pl.pushStock(t.sku, central);
            if (r.ok && products[t.code]) products[t.code].stocks[pl.id] = central;
            return r;
          })
        );
        if (!outcomes.length) return;
        const ok = outcomes.every((o) => o.ok);
        results[pl.id] = ok ? { ok: true } : { ok: false, message: outcomes.filter((o) => !o.ok).map((o) => o.message).join(" | ") };
      })
    );
    pushLog.push({ time: new Date().toISOString(), barcode: rootCode, name: root.name, centralStock: central, trigger: "sipariş", results });
  }

  if (changedCodes.size) {
    persistProducts();
    persistPushLog();
  }

  return { changedCount: changedCodes.size, newOrders: newlyProcessed };
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
  res.json({
    products: Object.entries(products).map(([code, p]) => ({
      code,
      barcode: code, // geriye dönük uyumluluk için aynı alan iki isimle de dönüyor
      name: p.name,
      category: p.category || "",
      stocks: p.stocks || {},
      skus: p.skus || {},
      prices: p.prices || {},
      productCodes: p.productCodes || {},
      listingStatus: p.listingStatus || {},
      centralStock: p.centralStock,
      image: p.image || null,
      pricing: p.pricing || { minPrice: null, maxPrice: null, myPrice: null, autoReprice: false, undercut: 0.01 },
      competitors: p.competitors || [],
      mergedInto: p.mergedInto || null,
    })),
  });
});

// Eşleştirme sekmesi için: her yapılandırılmış platformda, hangi ürünlerin o
// platforma henüz özel bir SKU ile bağlanmadığını (varsayılan olarak ürün koduyla
// eşleştiğini) listeler — kullanıcı isterse bunu onaylar ya da farklı bir SKU girer.
app.get("/api/products/match-status", requireAuth, (req, res) => {
  const status = {};
  PLATFORMS.filter((pl) => pl.configured()).forEach((pl) => {
    status[pl.id] = Object.entries(products)
      .filter(([, p]) => !p.skus?.[pl.id])
      .map(([code, p]) => ({ code, name: p.name, defaultSku: code }));
  });
  res.json({ status });
});

app.post("/api/products", requireAuth, (req, res) => {
  const { code, barcode, name, category, centralStock, stocks, skus, prices, listingStatus } = req.body || {};
  const productCode = String(code || barcode || "").trim();
  if (!productCode) return res.status(400).json({ ok: false, error: "Ürün kodu gerekli." });
  const p = ensureProduct(productCode, name);
  if (name?.trim()) p.name = name.trim();
  if (category !== undefined) p.category = String(category || "").trim();
  if (centralStock !== undefined && centralStock !== "") propagateCentralStock(productCode, Number(centralStock));
  if (stocks && typeof stocks === "object") {
    Object.entries(stocks).forEach(([platformId, val]) => {
      if (val !== undefined && val !== "") p.stocks[platformId] = Number(val);
    });
  }
  if (prices && typeof prices === "object") {
    Object.entries(prices).forEach(([platformId, val]) => {
      if (val === "" || val === null) delete p.prices[platformId];
      else if (val !== undefined) p.prices[platformId] = Number(val);
    });
  }
  if (listingStatus && typeof listingStatus === "object") {
    Object.entries(listingStatus).forEach(([platformId, val]) => {
      p.listingStatus[platformId] = val === "pasif" ? "pasif" : "satista";
    });
  }
  const conflicts = [];
  if (skus && typeof skus === "object") {
    const skuIndex = buildSkuIndex();
    Object.entries(skus).forEach(([platformId, val]) => {
      const sku = String(val || "").trim();
      if (!sku) {
        delete p.skus[platformId];
        return;
      }
      // Bu SKU zaten başka bir üründe kayıtlıysa (eşleştirme çakışması), burada
      // uygulamıyoruz — kullanıcıya "birleştirilsin mi?" seçeneği sunuluyor.
      const owner = skuIndex[platformId]?.get(sku);
      if (owner && owner !== productCode) {
        conflicts.push({ platform: platformId, sku, code: owner, name: products[owner]?.name || owner });
        return;
      }
      p.skus[platformId] = sku;
    });
  }
  persistProducts();
  res.json({ ok: true, product: { code: productCode, ...p }, conflicts });
});

// Birleştirilmiş bir ürünü ana üründen ayırır: tekrar bağımsız bir kart olur.
// Kendi platform verileri zaten kendi kaydında durduğu için hiçbir şey kaybolmaz;
// merkezi stok ayrılma anındaki değeriyle kalır ve artık ayrı takip edilir.
app.post("/api/products/:code/unmerge", requireAuth, (req, res) => {
  const p = products[req.params.code];
  if (!p) return res.status(404).json({ ok: false, error: "Ürün bulunamadı." });
  if (!p.mergedInto) return res.status(400).json({ ok: false, error: "Bu ürün zaten birleştirilmemiş." });
  p.mergedInto = null;
  persistProducts();
  res.json({ ok: true, product: { code: req.params.code, ...p } });
});

app.delete("/api/products/:code", requireAuth, (req, res) => {
  const code = req.params.code;
  // Silinen ürün başka ürünlerin ana ürünüyse (yani alt ürünleri varsa), o alt
  // ürünler ortada kalmasın diye bağımsız (birleştirilmemiş) ürünlere dönüşür.
  Object.values(products).forEach((p) => {
    if (p.mergedInto === code) p.mergedInto = null;
  });
  delete products[code];
  persistProducts();
  res.json({ ok: true });
});

// Bir ürünün Ana Ürün Kodu'nu (objede anahtar olarak kullanılan `code`) değiştirir.
// SKU'lar, stoklar, fiyatlar, rekabet ayarları vs. hepsi yeni koda taşınır.
// Bir platform için ayrıca SKU tanımlanmamışsa o platformda varsayılan SKU olarak
// bu kod kullanıldığından (skuForPlatform), kod değişince o varsayılan da değişir —
// eğer platformda gerçek SKU zaten farklıysa (skus objesinde kayıtlıysa) etkilenmez.
app.post("/api/products/:code/rename", requireAuth, (req, res) => {
  const oldCode = req.params.code;
  const newCode = String(req.body?.newCode || "").trim();
  const p = products[oldCode];
  if (!p) return res.status(404).json({ ok: false, error: "Ürün bulunamadı." });
  if (!newCode) return res.status(400).json({ ok: false, error: "Yeni ürün kodu boş olamaz." });
  if (newCode === oldCode) return res.json({ ok: true, product: { code: oldCode, ...p } });
  if (products[newCode]) return res.status(409).json({ ok: false, error: "Bu ürün kodu zaten başka bir üründe kullanılıyor. Birleştirmek için üzerine sürükleyip bırakabilirsin." });

  products[newCode] = p;
  delete products[oldCode];
  // Bu ürünün kodu değiştiği için ona bağlı (mergedInto ile işaret eden) alt
  // ürünlerin ve bu ürünün kendisi bir alt ürünse onu işaret eden hiçbir şeyin
  // referansı kopmasın diye eski koda işaret eden her yer yeni koda güncellenir.
  Object.values(products).forEach((other) => {
    if (other.mergedInto === oldCode) other.mergedInto = newCode;
  });
  persistProducts();
  res.json({ ok: true, product: { code: newCode, ...p } });
});

// İki ürünü aynı "aile" altında birleştirir (sürükle-bırak ile farklı
// platformlardaki karşılıkları tek bir Ana Ürün altında toplamak için).
// ÖNEMLİ: `from` ürünü ARTIK SİLİNMİYOR. Kendi skus/stocks/prices/productCodes/
// listingStatus verisi (siteden çekilen kendi stok kodu dahil) aynen kalıyor;
// sadece `mergedInto` alanına ana ürünün kodu yazılıp panelde ana ürünün altında
// bir "alt ürün" olarak görünmeye devam ediyor. Böylece hiçbir platform verisi ya
// da stok kodu sessizce kaybolmaz/ezilmez. Merkezi stok tüm aile için ortak tek
// bir değere (en yüksek olan) eşitlenir; stok senkronizasyonu da artık ailedeki
// her üyenin kendi gerçek platform SKU'suna ayrıca gönderilir.
app.post("/api/products/merge", requireAuth, (req, res) => {
  const { from, to } = req.body || {};
  const src = products[from];
  const dst = products[to];
  if (!src || !dst) return res.status(404).json({ ok: false, error: "Ürün bulunamadı." });
  if (from === to) return res.status(400).json({ ok: false, error: "Aynı ürünü kendisiyle birleştiremezsin." });

  const newRoot = resolveRoot(to);
  if (resolveRoot(from) === newRoot) {
    return res.status(400).json({ ok: false, error: "Bu ürünler zaten aynı ana ürün altında birleşik." });
  }

  // Reparent etmeden ÖNCE, birleşecek iki ailenin (from'un kendi alt ürünleri
  // varsa onlar dahil, to'nun mevcut ailesi dahil) merkezi stoklarının en
  // yükseğini bul — birleştirme sonrası tüm aile bu değere eşitlenecek.
  const combinedCodesBeforeMerge = [...new Set([...getFamilyCodes(from), ...getFamilyCodes(newRoot)])];
  const unified = Math.max(...combinedCodesBeforeMerge.map((c) => Number(products[c]?.centralStock) || 0), 0);

  src.mergedInto = newRoot;

  // Ana ürün için resim/rekabet ayarı tanımlı değilse alt üründen bilgi amaçlı devral
  // (bu bir "kayıp" değil, sadece ana kartta gösterilecek varsayılanı doldurmak).
  if (!dst.image && src.image) dst.image = src.image;
  if ((!dst.competitors || !dst.competitors.length) && src.competitors?.length) dst.competitors = src.competitors;

  propagateCentralStock(newRoot, unified);

  persistProducts();
  res.json({ ok: true, product: { code: newRoot, ...products[newRoot] }, familyCodes: getFamilyCodes(newRoot) });
});

// Ortak birleştirme mantığı: hem Excel/CSV içe aktarma hem de "Siteden Çek" (API)
// aynı satır listesini (r.barcode = o platformdaki SKU, stock, name) bu fonksiyonla
// ürün kataloğuna işler. SKU daha önce bir ürün koduna bağlıysa o ürün güncellenir;
// değilse yeni bir ürün oluşturulur (kod = bu platformdaki SKU).
function mergeStockRows(platform, rows) {
  const skuIndex = buildSkuIndex()[platform];
  let updated = 0,
    created = 0;
  rows.forEach((r) => {
    const sku = String(r.barcode || "").trim();
    if (!sku) return;
    const stock = Number(r.stock) || 0;
    const code = skuIndex.get(sku) || sku;
    const existed = !!products[code];
    const p = ensureProduct(code, r.name);
    if (!p.skus[platform]) p.skus[platform] = sku;
    p.stocks[platform] = stock;
    // Ürün daha önce hiç görülmemişse (merkezi stok hiç ayarlanmamışsa) bu platformun
    // stok değeri merkezi stoğun ilk değeri olarak da kullanılır.
    if (!existed) p.centralStock = stock;
    if (r.name && (!p.name || p.name === "İsimsiz ürün")) p.name = r.name;
    if (r.image) p.image = r.image;
    const price = Number(r.price);
    if (price > 0) p.prices[platform] = price;
    if (r.productCode) p.productCodes[platform] = String(r.productCode).trim();
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

// Bir ürünün merkezi stoğunu elle tüm yapılandırılmış platformlara anında gönder.
// Her platforma, o platform için tanımlı SKU ile gönderilir (skuForPlatform).
app.post("/api/products/:code/push", requireAuth, async (req, res) => {
  const code = req.params.code;
  const p = products[code];
  if (!p) return res.status(404).json({ ok: false, error: "Ürün bulunamadı." });

  // Hangi kod verilirse verilsin (ana ürün ya da bir alt ürün), tüm aile için
  // ortak merkezi stok, ailedeki her üyenin kendi gerçek platform SKU'suna
  // ayrıca gönderilir — böylece birleştirilmiş ürünlerin hiçbiri geride kalmaz.
  const rootCode = resolveRoot(code);
  const root = products[rootCode];
  const familyCodes = getFamilyCodes(rootCode);
  const central = Number(root.centralStock) || 0;

  const results = {};
  await Promise.all(
    PLATFORMS.filter((pl) => pl.configured()).map(async (pl) => {
      const targets = isListedOn(rootCode, pl.id) ? [{ code: rootCode, sku: skuForPlatform(rootCode, pl.id) }] : [];
      familyCodes.forEach((c) => {
        if (c === rootCode) return;
        const ownSku = products[c]?.skus?.[pl.id];
        if (ownSku) targets.push({ code: c, sku: ownSku });
      });
      const outcomes = await Promise.all(
        targets.map(async (t) => {
          const r = await pl.pushStock(t.sku, central);
          if (r.ok && products[t.code]) products[t.code].stocks[pl.id] = central;
          return r;
        })
      );
      if (!outcomes.length) return;
      const ok = outcomes.every((o) => o.ok);
      results[pl.id] = ok ? { ok: true } : { ok: false, message: outcomes.filter((o) => !o.ok).map((o) => o.message).join(" | ") };
    })
  );
  persistProducts();

  const entry = { time: new Date().toISOString(), barcode: rootCode, name: root.name, centralStock: central, trigger: "manuel", results };
  pushLog.push(entry);
  persistPushLog();

  res.json({ ok: true, results });
});

// Panelde bir platform kutusuna girilen (o platforma ÖZEL) stok ve fiyatı ilgili siteye gönderir.
// body: { platform } → sadece o platform; boşsa yapılandırılmış tüm platformlar.
app.post("/api/products/:code/push-platform", requireAuth, async (req, res) => {
  const code = req.params.code;
  const p = products[code];
  if (!p) return res.status(404).json({ ok: false, error: "Ürün bulunamadı." });
  const onlyId = req.body?.platform;
  const targets = PLATFORMS.filter((pl) => pl.configured() && (!onlyId || pl.id === onlyId));
  if (!targets.length) return res.status(400).json({ ok: false, error: "Yapılandırılmış platform yok." });

  const results = {};
  await Promise.all(
    targets.map(async (pl) => {
      // Stok artık sadece MERKEZİ stoktan gelir (birleştirilmiş ürünlerde ailenin ortak stoğu).
      if (!isListedOn(code, pl.id)) {
        results[pl.id] = { ok: false, message: `Ürün ${pl.name}'da kayıtlı değil (bu platformdan çekilmemiş).` };
        return;
      }
      const qty = Number(products[resolveRoot(code)]?.centralStock) || 0;
      const price = p.prices?.[pl.id];
      const sku = skuForPlatform(code, pl.id);
      results[pl.id] = await pushListingToPlatform(pl.id, sku, qty, price);
    })
  );
  pushLog.push({
    time: new Date().toISOString(),
    barcode: code,
    name: p.name,
    centralStock: p.centralStock,
    trigger: "manuel (fiyat+stok)",
    results: Object.fromEntries(Object.entries(results).map(([id, r]) => [id, r.ok ? { ok: true } : { ok: false, message: r.message }])),
  });
  persistPushLog();
  res.json({ ok: true, results });
});

app.get("/api/push-log", requireAuth, (req, res) => {
  res.json({ log: pushLog.slice(-60).reverse() });
});

/* ------------------------------------------------------------------
   API — Rekabet takibi / otomatik fiyatlandırma
------------------------------------------------------------------ */

// Bir ürünün rekabet ayarlarını (min/max fiyat, otomatik fiyatlandırma açık/kapalı,
// rakip link listesi) günceller. Rakip listesi tamamen gönderilenle değiştirilir.
app.post("/api/products/:code/pricing", requireAuth, (req, res) => {
  const p = products[req.params.code];
  if (!p) return res.status(404).json({ ok: false, error: "Ürün bulunamadı." });
  const { minPrice, maxPrice, autoReprice, undercut, competitorUrls } = req.body || {};

  if (minPrice !== undefined) p.pricing.minPrice = minPrice === "" || minPrice === null ? null : Number(minPrice);
  if (maxPrice !== undefined) p.pricing.maxPrice = maxPrice === "" || maxPrice === null ? null : Number(maxPrice);
  if (autoReprice !== undefined) p.pricing.autoReprice = !!autoReprice;
  if (undercut !== undefined && undercut !== "") p.pricing.undercut = Number(undercut);

  if (p.pricing.minPrice != null && p.pricing.maxPrice != null && p.pricing.minPrice > p.pricing.maxPrice) {
    return res.status(400).json({ ok: false, error: "En düşük fiyat, en yüksek fiyattan büyük olamaz." });
  }

  if (Array.isArray(competitorUrls)) {
    const existing = new Map((p.competitors || []).map((c) => [c.url, c]));
    p.competitors = competitorUrls
      .map((u) => String(u || "").trim())
      .filter(Boolean)
      .map((url) => existing.get(url) || { url, label: "", lastPrice: null, lastCheckedAt: null, lastError: null, sellerName: null });
  }

  persistProducts();
  res.json({ ok: true, product: { code: req.params.code, ...p } });
});

// Tek bir ürün için hemen kontrol et (rakip fiyatlarını çek + gerekiyorsa fiyatı güncelle)
app.post("/api/products/:code/reprice-check", requireAuth, async (req, res) => {
  const result = await repriceProduct(req.params.code);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

// Tüm rakip linki tanımlı ürünleri kontrol et
app.post("/api/reprice-all", requireAuth, async (req, res) => {
  res.json(await repriceAll());
});

/* ==================================================================
   YEDEKLEME — Google Drive
   Kurulum:
   1) Google Cloud Console'da bir proje aç, "Service Account" (hizmet hesabı)
      oluştur, JSON anahtar dosyasını indir.
   2) İndirdiğin dosyayı proje köküne koy (örn. service-account.json) ve
      .env dosyasına şu satırı ekle:
        GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./service-account.json
   3) Google Drive'da bir klasör oluştur, klasörü hizmet hesabının
      e-postasıyla (JSON dosyasındaki "client_email") DÜZENLEYEN olarak
      paylaş (normal "Paylaş" menüsünden, e-posta adresi olarak).
   4) Klasörün ID'sini (tarayıcıda adresteki /folders/XXXXX kısmı)
      .env dosyasına ekle:
        GOOGLE_DRIVE_FOLDER_ID=XXXXX
   İsteğe bağlı: BACKUP_INTERVAL_HOURS (varsayılan 24), BACKUP_KEEP_COUNT
   (Drive'da tutulacak en yeni yedek sayısı, varsayılan 30 — fazlası silinir).
   Ek npm paketi gerekmez; kimlik doğrulama axios + crypto ile yapılır.
================================================================== */
const GOOGLE_KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || "";
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || "";
const BACKUP_INTERVAL_HOURS = Number(process.env.BACKUP_INTERVAL_HOURS || 24);
const BACKUP_KEEP_COUNT = Number(process.env.BACKUP_KEEP_COUNT || 30);

/* --- OAuth ile bağlantı (önerilen yöntem) ---
   Servis hesaplarının kendi depolama kotası olmadığı için normal (Workspace
   olmayan) bir Google Drive'a dosya YAZAMAZLAR — klasör paylaşılmış olsa bile
   Google "Service Accounts do not have storage quota" hatası verir. Bunun
   çözümü, panelin senin kendi Google hesabınla bir kere yetkilendirilmesi:
   1) Google Cloud Console > APIs & Services > Credentials > Create Credentials
      > OAuth client ID > Application type: Web application.
   2) Authorized redirect URI olarak şunu ekle:
        <sitenin-adresi>/api/backup/oauth/callback
      (örn. https://siparispaneli.onrender.com/api/backup/oauth/callback)
   3) OAuth consent screen ekranını doldurman istenebilir (User Type: External,
      uygulama adı vs.) — "Testing" durumunda kalabilir, kendi hesabını
      "Test users" listesine eklemen yeterli.
   4) Oluşan Client ID ve Client Secret'ı .env'e ekle:
        GOOGLE_OAUTH_CLIENT_ID=...
        GOOGLE_OAUTH_CLIENT_SECRET=...
        GOOGLE_OAUTH_REDIRECT_URI=https://.../api/backup/oauth/callback
   5) Panelde Yedekleme sekmesinden "Google ile Bağlan" butonuna bas, kendi
      hesabınla giriş yap. "Google doğrulamadı" uyarısı çıkarsa Advanced >
      Go to ... (unsafe) ile devam et (kendi uygulaman olduğu için güvenli).
*/
const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
const GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
const GOOGLE_OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI || "";

function oauthConfigured() {
  return !!(GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET && GOOGLE_OAUTH_REDIRECT_URI);
}

let oauthRefreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN || (loadJSON("google-oauth-token.json", {}).refresh_token || "");
let oauthAccessCache = { token: null, exp: 0 };
let oauthPendingState = null;

function oauthReady() {
  return !!(oauthConfigured() && oauthRefreshToken);
}

app.get("/api/backup/oauth/start", requireAuth, (req, res) => {
  if (!oauthConfigured()) {
    return res.status(400).send("GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REDIRECT_URI .env'de eksik.");
  }
  oauthPendingState = crypto.randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: "https://www.googleapis.com/auth/drive",
    state: oauthPendingState,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get("/api/backup/oauth/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`Google yetkilendirme hatası: ${error}`);
  if (!code || !state || state !== oauthPendingState) {
    return res.status(400).send("Geçersiz veya süresi dolmuş istek. Yedekleme sekmesinden tekrar “Google ile Bağlan” de.");
  }
  oauthPendingState = null;
  try {
    const resp = await axios.post(
      "https://oauth2.googleapis.com/token",
      new URLSearchParams({
        code,
        client_id: GOOGLE_OAUTH_CLIENT_ID,
        client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
        redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
        grant_type: "authorization_code",
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15000 }
    );
    const { refresh_token, access_token, expires_in } = resp.data;
    if (!refresh_token) {
      return res
        .status(400)
        .send(
          "Google bir refresh token döndürmedi (muhtemelen bu hesap için izin daha önce verilmişti). " +
            "myaccount.google.com/permissions adresinden bu uygulamanın erişimini kaldırıp tekrar dene."
        );
    }
    oauthRefreshToken = refresh_token;
    oauthAccessCache = { token: access_token, exp: Math.floor(Date.now() / 1000) + Number(expires_in || 3600) };
    saveJSON("google-oauth-token.json", { refresh_token });
    res.send(`<!doctype html><html><body style="font-family:sans-serif; padding:40px; max-width:640px;">
      <h2>Google Drive bağlantısı başarılı ✅</h2>
      <p>Bu sekmeyi kapatabilirsin, panele dönüp "Şimdi Yedekle" ile deneyebilirsin.</p>
      <p style="color:#888; font-size:13px;">Not: Sunucu yeniden dağıtıldığında (redeploy) bu bağlantının kaybolmaması için,
      barındırma panelindeki (Render vb.) ortam değişkenlerine şunu da eklemen önerilir:</p>
      <pre style="background:#f2f2f2; padding:10px; border-radius:6px; white-space:pre-wrap; word-break:break-all;">GOOGLE_OAUTH_REFRESH_TOKEN=${refresh_token}</pre>
      </body></html>`);
  } catch (e) {
    const msg = e.response?.data ? JSON.stringify(e.response.data).slice(0, 500) : e.message;
    res.status(500).send("Token alınamadı: " + msg);
  }
});

async function getOAuthAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (oauthAccessCache.token && oauthAccessCache.exp - 60 > now) return oauthAccessCache.token;
  if (!oauthReady()) throw new Error("Google Drive bağlantısı henüz kurulmadı (Yedekleme sekmesinden “Google ile Bağlan”).");
  const resp = await axios.post(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: oauthRefreshToken,
      grant_type: "refresh_token",
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15000 }
  );
  oauthAccessCache = { token: resp.data.access_token, exp: now + Number(resp.data.expires_in || 3600) };
  return oauthAccessCache.token;
}

/* --- Servis hesabı ile bağlantı (yalnızca Google Workspace Paylaşılan Sürücü
   kullanıyorsan işe yarar — normal kişisel Drive'da kota hatası verir,
   bu yüzden yukarıdaki OAuth yöntemi önerilir) --- */
let googleCreds; // undefined = henüz denenmedi, false = yüklenemedi, object = hazır
function loadGoogleCreds() {
  if (googleCreds !== undefined) return googleCreds;

  // Render gibi dosya sistemi kalıcı olmayan barındırmalarda, JSON anahtarının
  // TAMAMI tek bir ortam değişkeni olarak da verilebilir: GOOGLE_SERVICE_ACCOUNT_KEY_JSON
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON || "";
  if (rawJson.trim()) {
    try {
      const json = JSON.parse(rawJson);
      if (!json.client_email || !json.private_key) throw new Error("client_email/private_key eksik");
      googleCreds = json;
      return googleCreds;
    } catch (e) {
      console.error("GOOGLE_SERVICE_ACCOUNT_KEY_JSON çözümlenemedi:", e.message);
      googleCreds = false;
      return googleCreds;
    }
  }

  if (!GOOGLE_KEY_FILE) {
    googleCreds = false;
    return googleCreds;
  }
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, GOOGLE_KEY_FILE), "utf8");
    const json = JSON.parse(raw);
    if (!json.client_email || !json.private_key) throw new Error("client_email/private_key eksik");
    googleCreds = json;
  } catch (e) {
    console.error("Google servis hesabı anahtarı okunamadı:", e.message);
    googleCreds = false;
  }
  return googleCreds;
}

function driveConfigured() {
  return !!(GOOGLE_DRIVE_FOLDER_ID && (oauthReady() || loadGoogleCreds()));
}

function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let driveTokenCache = { token: null, exp: 0 };
async function getDriveAccessToken() {
  if (oauthReady()) return getOAuthAccessToken();

  const creds = loadGoogleCreds();
  if (!creds) throw new Error("Google servis hesabı yapılandırılmadı.");
  const now = Math.floor(Date.now() / 1000);
  if (driveTokenCache.token && driveTokenCache.exp - 60 > now) return driveTokenCache.token;

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(
    JSON.stringify({
      iss: creds.client_email,
      scope: "https://www.googleapis.com/auth/drive",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const unsigned = `${header}.${claim}`;
  const signature = base64url(crypto.sign("RSA-SHA256", Buffer.from(unsigned), creds.private_key));
  const jwt = `${unsigned}.${signature}`;

  const resp = await axios.post(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15000 }
  );
  driveTokenCache = { token: resp.data.access_token, exp: now + Number(resp.data.expires_in || 3600) };
  return driveTokenCache.token;
}

// Yedek içeriği: ürün kataloğu + işlenmiş sipariş paketleri + gönderim günlüğü
// tek bir JSON dosyasında toplanır (geri yüklerken bunların hepsi değiştirilir).
function buildBackupPayload() {
  return JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      products,
      processedPackages: Array.from(processedPackages),
      pushLog,
    },
    null,
    2
  );
}

async function uploadBackupToDrive() {
  const token = await getDriveAccessToken();
  const content = buildBackupPayload();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `yedek-${stamp}.json`;
  const metadata = { name, parents: [GOOGLE_DRIVE_FOLDER_ID], mimeType: "application/json" };

  const boundary = "panelyedek" + crypto.randomBytes(8).toString("hex");
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${content}\r\n` +
    `--${boundary}--`;

  const resp = await axios.post(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,createdTime,size",
    body,
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` }, timeout: 30000 }
  );
  await cleanupOldBackups(token);
  return resp.data;
}

async function listBackupsFromDrive(token) {
  const t = token || (await getDriveAccessToken());
  const q = encodeURIComponent(`'${GOOGLE_DRIVE_FOLDER_ID}' in parents and trashed = false`);
  const resp = await axios.get(
    `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=createdTime desc&pageSize=100&fields=files(id,name,createdTime,size)`,
    { headers: { Authorization: `Bearer ${t}` }, timeout: 15000 }
  );
  return resp.data.files || [];
}

// BACKUP_KEEP_COUNT'tan fazla yedek varsa en eskilerini Drive'dan siler.
async function cleanupOldBackups(token) {
  try {
    const files = await listBackupsFromDrive(token);
    const excess = files.slice(BACKUP_KEEP_COUNT);
    for (const f of excess) {
      await axios
        .delete(`https://www.googleapis.com/drive/v3/files/${f.id}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 })
        .catch(() => {});
    }
  } catch (e) {
    console.error("Eski yedekler temizlenemedi:", e.message);
  }
}

async function restoreBackupFromDrive(fileId) {
  const token = await getDriveAccessToken();
  const resp = await axios.get(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30000,
  });
  const data = resp.data;
  if (!data || typeof data !== "object" || !data.products) throw new Error("Yedek dosyası geçersiz görünüyor.");
  products = data.products || {};
  processedPackages = new Set(data.processedPackages || []);
  pushLog = data.pushLog || [];
  persistProducts();
  persistProcessed();
  persistPushLog();
  return { restoredAt: data.createdAt || null, productCount: Object.keys(products).length };
}

let lastBackup = { at: null, error: null, name: null };

async function runScheduledBackup() {
  if (!driveConfigured()) return;
  try {
    const file = await uploadBackupToDrive();
    lastBackup = { at: new Date().toISOString(), error: null, name: file.name };
    console.log("Google Drive yedeklemesi tamamlandı:", file.name);
  } catch (e) {
    const msg = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
    lastBackup = { ...lastBackup, error: msg };
    console.error("Google Drive yedeklemesi başarısız:", msg);
  }
}

app.get("/api/backup/status", requireAuth, (req, res) => {
  res.json({
    configured: driveConfigured(),
    oauthAvailable: oauthConfigured(),
    oauthConnected: oauthReady(),
    lastBackup,
    intervalHours: BACKUP_INTERVAL_HOURS,
  });
});

app.post("/api/backup/run", requireAuth, async (req, res) => {
  if (!driveConfigured())
    return res.status(400).json({ ok: false, error: "Google Drive yedekleme yapılandırılmadı (.env: GOOGLE_SERVICE_ACCOUNT_KEY_FILE, GOOGLE_DRIVE_FOLDER_ID)." });
  try {
    const file = await uploadBackupToDrive();
    lastBackup = { at: new Date().toISOString(), error: null, name: file.name };
    res.json({ ok: true, file });
  } catch (e) {
    const msg = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
    lastBackup = { ...lastBackup, error: msg };
    res.status(500).json({ ok: false, error: msg });
  }
});

app.get("/api/backup/list", requireAuth, async (req, res) => {
  if (!driveConfigured()) return res.status(400).json({ ok: false, error: "Google Drive yedekleme yapılandırılmadı." });
  try {
    res.json({ ok: true, files: await listBackupsFromDrive() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message });
  }
});

app.post("/api/backup/restore", requireAuth, async (req, res) => {
  if (!driveConfigured()) return res.status(400).json({ ok: false, error: "Google Drive yedekleme yapılandırılmadı." });
  const { fileId } = req.body || {};
  if (!fileId) return res.status(400).json({ ok: false, error: "fileId gerekli." });
  try {
    res.json({ ok: true, ...(await restoreBackupFromDrive(fileId)) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message });
  }
});

// index.html ve diğer statik dosyalar server.js ile AYNI klasörde duruyor
// (ayrı bir "public" alt klasörü yok) — bu yüzden doğrudan __dirname servis edilir.
app.use(express.static(__dirname));

// Herhangi bir API/asset eşleşmesi olmayan GET isteklerinde (ör. tarayıcıdan
// doğrudan "/" ziyareti) her zaman ana paneli (index.html) döndür.
// (app.get("*", ...) yerine app.use kullanılıyor — Express'in tüm sürümlerinde
// "*" joker rotası aynı şekilde çalışmayabiliyor, app.use ise her sürümde güvenli.)
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Panel çalışıyor: http://localhost:${PORT}`);
  refreshAll().catch((e) => console.error("İlk veri çekme hatası:", e.message));
  setInterval(() => {
    refreshAll().catch((e) => console.error("Otomatik yenileme hatası:", e.message));
  }, Math.max(REFRESH_MINUTES, 5) * 60 * 1000);

  // Rekabet kontrolü siparişlerden çok daha seyrek çalışır (varsayılan: 4 saatte bir)
  // — hem rakip siteyi çok sık yormamak hem de engellenme riskini azaltmak için.
  setInterval(() => {
    repriceAll().catch((e) => console.error("Rekabet kontrolü hatası:", e.message));
  }, Math.max(REPRICE_HOURS, 1) * 60 * 60 * 1000);

  // Google Drive yedeklemesi (varsayılan: günde bir). Yapılandırma eksikse sessizce atlanır.
  // Kurulumun doğru çalıştığını hemen görebilmek için 2 dakika sonra bir deneme yedeklemesi de yapılır.
  if (driveConfigured()) {
    setTimeout(() => runScheduledBackup(), 2 * 60 * 1000);
  }
  setInterval(() => {
    runScheduledBackup();
  }, Math.max(BACKUP_INTERVAL_HOURS, 1) * 60 * 60 * 1000);
});
