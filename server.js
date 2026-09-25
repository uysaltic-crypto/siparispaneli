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
      listingStatus: {}, // { platformId: 'satista' | 'pasif' }
      pricing: { minPrice: null, maxPrice: null, myPrice: null, autoReprice: false, undercut: 0.01 },
      competitors: [], // [{ url, label, lastPrice, lastCheckedAt, lastError, sellerName }]
    };
  }
  if (!products[code].stocks) products[code].stocks = {};
  if (!products[code].skus) products[code].skus = {};
  if (!products[code].prices) products[code].prices = {};
  if (!products[code].listingStatus) products[code].listingStatus = {};
  if (products[code].category === undefined) products[code].category = "";
  if (!products[code].pricing) products[code].pricing = { minPrice: null, maxPrice: null, myPrice: null, autoReprice: false, undercut: 0.01 };
  if (!products[code].competitors) products[code].competitors = [];
  return products[code];
}

function skuForPlatform(code, platform) {
  const p = products[code];
  return (p?.skus?.[platform] || code || "").trim();
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
      p.centralStock = Math.max(0, (Number(p.centralStock) || 0) - (Number(line.quantity) || 1));
      changedCodes.add(code);
    });

    processedPackages.add(key);
    newlyProcessed++;
  }

  ordersByPlatform.forEach((orders) => orders.forEach(handleOrder));

  if (newlyProcessed) {
    persistProcessed();
    persistProducts();
  }

  for (const code of changedCodes) {
    const p = products[code];
    const results = {};
    await Promise.all(
      PLATFORMS.filter((pl) => pl.configured()).map(async (pl) => {
        const r = await pl.pushStock(skuForPlatform(code, pl.id), p.centralStock);
        results[pl.id] = r;
        if (r.ok) p.stocks[pl.id] = p.centralStock;
      })
    );
    pushLog.push({ time: new Date().toISOString(), barcode: code, name: p.name, centralStock: p.centralStock, trigger: "sipariş", results });
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
      listingStatus: p.listingStatus || {},
      centralStock: p.centralStock,
      image: p.image || null,
      pricing: p.pricing || { minPrice: null, maxPrice: null, myPrice: null, autoReprice: false, undercut: 0.01 },
      competitors: p.competitors || [],
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
  if (centralStock !== undefined && centralStock !== "") p.centralStock = Number(centralStock);
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

app.delete("/api/products/:code", requireAuth, (req, res) => {
  delete products[req.params.code];
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
  persistProducts();
  res.json({ ok: true, product: { code: newCode, ...p } });
});

// İki ürünü tek üründe birleştirir (sürükle-bırak ile farklı platformlardaki
// karşılıkları aynı ürün kodu altında toplamak için). `from` ürününün platform
// SKU'ları ve stokları `to` ürününe aktarılır (to'da zaten varsa to'nunki kalır),
// merkezi stok en yüksek olan değer korunur, `from` silinir.
app.post("/api/products/merge", requireAuth, (req, res) => {
  const { from, to } = req.body || {};
  const src = products[from];
  const dst = products[to];
  if (!src || !dst) return res.status(404).json({ ok: false, error: "Ürün bulunamadı." });
  if (from === to) return res.status(400).json({ ok: false, error: "Aynı ürünü kendisiyle birleştiremezsin." });

  Object.entries(src.skus || {}).forEach(([platformId, sku]) => {
    if (!dst.skus[platformId]) {
      dst.skus[platformId] = sku;
      if (src.stocks?.[platformId] !== undefined) dst.stocks[platformId] = src.stocks[platformId];
    }
  });
  dst.centralStock = Math.max(Number(dst.centralStock) || 0, Number(src.centralStock) || 0);
  if (!dst.image && src.image) dst.image = src.image;
  if ((!dst.name || dst.name === "İsimsiz ürün") && src.name) dst.name = src.name;

  delete products[from];
  persistProducts();
  res.json({ ok: true, product: { code: to, ...dst } });
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

  const results = {};
  await Promise.all(
    PLATFORMS.filter((pl) => pl.configured()).map(async (pl) => {
      const r = await pl.pushStock(skuForPlatform(code, pl.id), p.centralStock);
      results[pl.id] = r;
      if (r.ok) p.stocks[pl.id] = p.centralStock;
    })
  );
  persistProducts();

  const entry = { time: new Date().toISOString(), barcode: code, name: p.name, centralStock: p.centralStock, trigger: "manuel", results };
  pushLog.push(entry);
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

app.use(express.static(path.join(__dirname, "public")));

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
