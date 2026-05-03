// ============================================================
//  DATEFLOW GH — UNIFIED BACKEND (FIXED WEBHOOK)
//  MTN → RemaData API  |  Telecel/AT → HubNetGH API
// ============================================================

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const admin = require("firebase-admin");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────

const REMADATA_API_URL = "https://remadata.com/api";
const REMADATA_API_KEY = process.env.REMADATA_API_KEY || "";

const HUBNET_BASE_URL = "https://hubnetgh.site/wp-json/hubnet-api/v1";
const HUBNET_API_KEY = process.env.HUBNET_API_KEY || "";

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || "";
const DELIVER_SECRET = process.env.DELIVER_SECRET || "";

const processedRefs = new Set();

const NETWORK_PROVIDER = {
  mtn: { name: "RemaData" },
  telecel: { name: "HubNetGH" },
  airteltigo: { name: "HubNetGH" }
};

// ─────────────────────────────────────────────
//  FIREBASE ADMIN INIT
// ─────────────────────────────────────────────
let db = null;
let profitSettingsCache = null;

try {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    : null;

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
    db = admin.database();
    console.log("✅ Firebase Admin initialised");
  } else {
    console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT_JSON not set");
  }
} catch (err) {
  console.error("❌ Firebase init error:", err.message);
}

// ─────────────────────────────────────────────
//  MIDDLEWARE
// ─────────────────────────────────────────────
app.use(cors({ origin: "*" }));

// Paystack webhook needs raw body
app.use((req, res, next) => {
  if (req.path === "/paystack/webhook") {
    let raw = [];
    req.on("data", chunk => raw.push(chunk));
    req.on("end", () => {
      req.rawBody = Buffer.concat(raw);
      next();
    });
    req.on("error", next);
  } else {
    express.json()(req, res, next);
  }
});

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// FIX 3: Guard against empty DELIVER_SECRET
function requireApiKey(req, res, next) {
  if (!DELIVER_SECRET) {
    console.error("❌ DELIVER_SECRET env var not set");
    return res.status(500).json({ status: "error", message: "Server misconfiguration" });
  }
  const key = req.headers["x-api-key"] || req.body?.apiKey;
  if (!key || key !== DELIVER_SECRET) {
    console.warn(`🚫 Unauthorized /deliver attempt from ${req.ip}`);
    return res.status(401).json({ status: "error", message: "Unauthorized" });
  }
  next();
}

// ─────────────────────────────────────────────
//  HELPER FUNCTIONS
// ─────────────────────────────────────────────

function formatPhoneNumber(phone) {
  let formatted = phone.replace(/\s+/g, "").replace(/-/g, "");
  if (formatted.startsWith("0")) formatted = "233" + formatted.substring(1);
  if (formatted.startsWith("+")) formatted = formatted.substring(1);
  return formatted;
}

function resolveVolume(volumeInMB) {
  const mb = Number(volumeInMB);
  if (mb >= 1024) return String(Math.round(mb / 1024));
  return String(mb);
}

async function getProfitSettings() {
  if (profitSettingsCache) return profitSettingsCache;
  if (!db) return { mode: "flat", flatAmount: 0 };
  try {
    const snap = await db.ref("system/profitSettings").once("value");
    profitSettingsCache = snap.val() || { mode: "flat", flatAmount: 0 };
    return profitSettingsCache;
  } catch {
    return { mode: "flat", flatAmount: 0 };
  }
}

function applyProfit(costPrice, volumeInMB, network, settings) {
  if (!settings) return costPrice;
  const { mode, flatAmount, percentAmount, perBundle } = settings;
  if (mode === "percent") {
    const pct = parseFloat(percentAmount) || 0;
    return Math.ceil((costPrice * (1 + pct / 100)) * 20) / 20;
  }
  if (mode === "perBundle") {
    const key = `${network}_${volumeInMB}`;
    const bundleProfit = parseFloat(perBundle?.[key]) || parseFloat(flatAmount) || 0;
    return Math.ceil((costPrice + bundleProfit) * 20) / 20;
  }
  const flat = parseFloat(flatAmount) || 0;
  return Math.ceil((costPrice + flat) * 20) / 20;
}

// ─────────────────────────────────────────────
//  DELIVERY FUNCTIONS
// ─────────────────────────────────────────────

async function deliverViaRemaData(phone, volumeInMB, reference) {
  const orderRef = reference || `DF-${Date.now()}`;
  const formattedPhone = formatPhoneNumber(phone);

  const payload = {
    ref: orderRef,
    phone: formattedPhone,
    volumeInMB: Number(volumeInMB),
    networkType: "mtn"
  };

  console.log(`📦 [RemaData] Delivering ${volumeInMB}MB MTN → ${phone}`);

  const response = await axios.post(`${REMADATA_API_URL}/buy-data`, payload, {
    headers: { "X-API-KEY": REMADATA_API_KEY, "Content-Type": "application/json" },
    timeout: 30000,
  });

  const remaReference = response.data?.data?.reference || response.data?.reference || orderRef;

  return {
    success: response.data?.status === "success",
    reference: remaReference,
    data: response.data,
    provider: "RemaData"
  };
}

async function deliverViaHubNet(phone, networkType, volumeInMB, reference) {
  const network = networkType === "airteltigo" ? "airteltigo" : "telecel";
  const volume = resolveVolume(volumeInMB);
  const requestId = reference || `DF-${Date.now()}`;

  console.log(`📦 [HubNetGH] Delivering ${volume}GB ${network} → ${phone}`);

  const response = await axios.post(`${HUBNET_BASE_URL}/place_order`, {
    network,
    volume,
    customer_number: phone,
    quantity: 1,
    request_id: requestId,
  }, {
    headers: { "Content-Type": "application/json", "X-API-KEY": HUBNET_API_KEY },
    timeout: 30000,
  });

  return {
    success: response.data?.success === true,
    reference: String(response.data?.order_id || requestId),
    data: response.data,
    provider: "HubNetGH"
  };
}

async function deliverData(phone, networkType, volumeInMB, reference = null) {
  const provider = NETWORK_PROVIDER[networkType?.toLowerCase()];
  if (!provider) throw new Error(`Unsupported network type: ${networkType}`);
  if (provider.name === "RemaData") {
    return await deliverViaRemaData(phone, volumeInMB, reference);
  } else {
    return await deliverViaHubNet(phone, networkType, volumeInMB, reference);
  }
}

// ─────────────────────────────────────────────
//  WEBHOOK HANDLER
// ─────────────────────────────────────────────
function verifyPaystackSignature(rawBody, signature) {
  if (!PAYSTACK_SECRET || !rawBody || !signature) return false;
  const hash = crypto.createHmac("sha512", PAYSTACK_SECRET).update(rawBody).digest("hex");
  return hash === signature;
}

app.post("/paystack/webhook", async (req, res) => {
  const signature = req.headers["x-paystack-signature"];

  if (!verifyPaystackSignature(req.rawBody, signature)) {
    console.warn("⚠️ Invalid Paystack webhook signature");
    return res.status(401).json({ error: "Invalid signature" });
  }

  let event;
  try {
    event = JSON.parse(req.rawBody.toString());
    console.log(`📨 Webhook received: ${event.event}`);
  } catch (err) {
    console.error("❌ Failed to parse webhook body:", err.message);
    return res.status(400).json({ error: "Invalid JSON" });
  }

  // Respond immediately to Paystack
  res.status(200).json({ received: true });

  if (event.event !== "charge.success") {
    console.log(`📝 Webhook event ignored: ${event.event}`);
    return;
  }

  const { data } = event;
  const meta = data.metadata || {};
  const phone = meta.phone || meta.customer_phone;
  const networkType = meta.networkType || meta.network_type;
  const volumeInMB = meta.volumeInMB || meta.volume_in_mb;
  const ref = data.reference;
  const amount = data.amount ? data.amount / 100 : 0;

  if (!phone || !volumeInMB || !networkType) {
    console.warn(`⚠️ Missing delivery data: phone=${phone}, volume=${volumeInMB}, network=${networkType}`);
    return;
  }

  if (processedRefs.has(ref)) {
    console.warn(`⚠️ Duplicate webhook ignored for ref: ${ref}`);
    return;
  }
  processedRefs.add(ref);

  try {
    console.log(`💳 Auto-delivering: ${networkType} ${volumeInMB}MB → ${phone}`);

    // ✅ DIRECT CALL - NO HTTP REQUEST
    const result = await deliverData(phone, networkType, Number(volumeInMB), ref);

    if (result.success) {
      console.log(`✅ Auto-delivery successful via ${result.provider} | Ref: ${result.reference}`);

      // FIX 1: Save completed order to Firebase
      if (db) {
        await db.ref("transactions/" + ref).set({
          ref,
          phone,
          networkType,
          volumeInMB,
          amount,
          status: "completed",
          provider: result.provider,
          providerRef: result.reference,
          timestamp: new Date().toISOString(),
          source: "paystack_webhook"
        }).catch(e => console.warn("⚠️ Firebase save error:", e.message));
      }
    } else {
      console.error(`❌ Auto-delivery failed: ${result.data?.message}`);
      processedRefs.delete(ref); // Allow retry
    }
  } catch (err) {
    console.error(`❌ Webhook error:`, err.message);
    processedRefs.delete(ref); // Allow retry
  }
});

// ─────────────────────────────────────────────
//  API ROUTES
// ─────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({ status: "online", service: "DataFlow GH", timestamp: new Date().toISOString() });
});

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    service: "DataFlow GH",
    timestamp: new Date().toISOString(),
    providers: {
      mtn: { provider: "RemaData", configured: !!REMADATA_API_KEY },
      telecel: { provider: "HubNetGH", configured: !!HUBNET_API_KEY },
      airteltigo: { provider: "HubNetGH", configured: !!HUBNET_API_KEY }
    },
    firebase: !!db,
    webhook: !!PAYSTACK_SECRET
  });
});

app.get("/api/balance", async (req, res) => {
  try {
    const response = await axios.get(`${REMADATA_API_URL}/wallet-balance`, {
      headers: { "X-API-KEY": REMADATA_API_KEY },
      timeout: 10000
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ status: "error", message: "Failed to fetch balance" });
  }
});

app.get("/api/hubnet/balance", async (req, res) => {
  try {
    const response = await axios.get(`${HUBNET_BASE_URL}/check_balance`, {
      headers: { "X-API-KEY": HUBNET_API_KEY },
      timeout: 15000
    });
    if (response.data?.success) {
      res.json({ status: "success", balance: response.data.wallet_balance || 0 });
    } else {
      res.json({ status: "info", balance: null, message: "Check HubNet dashboard" });
    }
  } catch (err) {
    res.json({ status: "info", balance: null, message: "Check HubNet dashboard" });
  }
});

app.get("/api/bundles", async (req, res) => {
  const network = (req.query.network || "mtn").toLowerCase();

  const bundleData = {
    mtn: [
      { volumeInMB: 1024, volume: "1GB", price: 4.30, name: "1GB", network: "mtn" },
      { volumeInMB: 2048, volume: "2GB", price: 8.60, name: "2GB", network: "mtn" },
      { volumeInMB: 3072, volume: "3GB", price: 12.50, name: "3GB", network: "mtn" },
      { volumeInMB: 4096, volume: "4GB", price: 16.50, name: "4GB", network: "mtn" },
      { volumeInMB: 5120, volume: "5GB", price: 21.70, name: "5GB", network: "mtn" },
      { volumeInMB: 6144, volume: "6GB", price: 24.50, name: "6GB", network: "mtn" },
      { volumeInMB: 8192, volume: "8GB", price: 32.50, name: "8GB", network: "mtn" },
      { volumeInMB: 10240, volume: "10GB", price: 39.00, name: "10GB", network: "mtn" },
      { volumeInMB: 15360, volume: "15GB", price: 57.00, name: "15GB", network: "mtn" },
      { volumeInMB: 20480, volume: "20GB", price: 77.10, name: "20GB", network: "mtn" },
      { volumeInMB: 25600, volume: "25GB", price: 96.00, name: "25GB", network: "mtn" },
      { volumeInMB: 30720, volume: "30GB", price: 116.00, name: "30GB", network: "mtn" },
      { volumeInMB: 40960, volume: "40GB", price: 155.00, name: "40GB", network: "mtn" },
      { volumeInMB: 51200, volume: "50GB", price: 186.00, name: "50GB", network: "mtn" },
      { volumeInMB: 102400, volume: "100GB", price: 370.00, name: "100GB", network: "mtn" }
    ],
    telecel: [
      { volumeInMB: 10240, volume: "10GB", price: 38.00, name: "10GB", network: "telecel" },
      { volumeInMB: 15360, volume: "15GB", price: 55.00, name: "15GB", network: "telecel" },
      { volumeInMB: 20480, volume: "20GB", price: 74.00, name: "20GB", network: "telecel" },
      { volumeInMB: 25600, volume: "25GB", price: 92.00, name: "25GB", network: "telecel" },
      { volumeInMB: 30720, volume: "30GB", price: 109.00, name: "30GB", network: "telecel" },
      { volumeInMB: 40960, volume: "40GB", price: 143.00, name: "40GB", network: "telecel" },
      { volumeInMB: 51200, volume: "50GB", price: 177.00, name: "50GB", network: "telecel" },
      { volumeInMB: 102400, volume: "100GB", price: 354.00, name: "100GB", network: "telecel" }
    ],
    airteltigo: [
      { volumeInMB: 1024, volume: "1GB", price: 3.90, name: "1GB", network: "airteltigo" },
      { volumeInMB: 2048, volume: "2GB", price: 7.80, name: "2GB", network: "airteltigo" },
      { volumeInMB: 3072, volume: "3GB", price: 11.80, name: "3GB", network: "airteltigo" },
      { volumeInMB: 4096, volume: "4GB", price: 15.70, name: "4GB", network: "airteltigo" },
      { volumeInMB: 5120, volume: "5GB", price: 19.40, name: "5GB", network: "airteltigo" },
      { volumeInMB: 6144, volume: "6GB", price: 23.80, name: "6GB", network: "airteltigo" },
      { volumeInMB: 7168, volume: "7GB", price: 27.40, name: "7GB", network: "airteltigo" },
      { volumeInMB: 8192, volume: "8GB", price: 31.00, name: "8GB", network: "airteltigo" },
      { volumeInMB: 9216, volume: "9GB", price: 35.00, name: "9GB", network: "airteltigo" },
      { volumeInMB: 10240, volume: "10GB", price: 39.00, name: "10GB", network: "airteltigo" },
      { volumeInMB: 12288, volume: "12GB", price: 47.00, name: "12GB", network: "airteltigo" },
      { volumeInMB: 15360, volume: "15GB", price: 59.00, name: "15GB", network: "airteltigo" },
      { volumeInMB: 20480, volume: "20GB", price: 78.50, name: "20GB", network: "airteltigo" },
      { volumeInMB: 25600, volume: "25GB", price: 98.00, name: "25GB", network: "airteltigo" }
    ]
  };

  let bundles = bundleData[network] || bundleData.mtn;

  if (network !== "mtn") {
    const settings = await getProfitSettings();
    bundles = bundles.map(b => ({
      ...b,
      costPrice: b.price,
      price: applyProfit(b.price, b.volumeInMB, network, settings)
    }));
  }

  res.json({ status: "success", data: bundles, count: bundles.length });
});

// FIX 2: Added input validation to /deliver
app.post("/deliver", requireApiKey, async (req, res) => {
  const { phone, networkType, volumeInMB, ref } = req.body;

  if (!phone || !networkType || !volumeInMB) {
    return res.status(400).json({ status: "error", message: "Missing required fields: phone, networkType, volumeInMB" });
  }

  const validNetworks = ["mtn", "telecel", "airteltigo"];
  if (!validNetworks.includes(networkType.toLowerCase())) {
    return res.status(400).json({ status: "error", message: `Invalid network. Must be: ${validNetworks.join(", ")}` });
  }

  const volumeNum = Number(volumeInMB);
  if (isNaN(volumeNum) || volumeNum <= 0) {
    return res.status(400).json({ status: "error", message: "Invalid volumeInMB" });
  }

  try {
    const result = await deliverData(phone, networkType.toLowerCase(), volumeNum, ref);
    if (result.success) {
      console.log(`✅ Manual delivery successful via ${result.provider}`);
      res.json({ status: "success", provider: result.provider, reference: result.reference, data: result.data });
    } else {
      res.status(500).json({ status: "error", message: result.data?.message || "Delivery failed" });
    }
  } catch (err) {
    console.error("❌ /deliver error:", err.message);
    res.status(err.response?.status || 500).json({ status: "error", message: err.response?.data?.message || err.message });
  }
});

app.get("/api/order-status/:reference", async (req, res) => {
  const { reference } = req.params;
  const { network } = req.query;

  const providersToTry = network
    ? [NETWORK_PROVIDER[network.toLowerCase()]]
    : Object.values(NETWORK_PROVIDER);

  for (const provider of providersToTry) {
    if (!provider) continue;
    try {
      if (provider.name === "RemaData") {
        const response = await axios.get(`${REMADATA_API_URL}/order-status/${encodeURIComponent(reference)}`, {
          headers: { "X-API-KEY": REMADATA_API_KEY },
          timeout: 10000
        });
        if (response.data?.status === "success") {
          return res.json({ status: "success", provider: provider.name, data: response.data.data });
        }
      } else if (provider.name === "HubNetGH") {
        const response = await axios.get(`${HUBNET_BASE_URL}/order_status`, {
          params: { order_id: reference },
          headers: { "X-API-KEY": HUBNET_API_KEY },
          timeout: 10000
        });
        if (response.data?.success) {
          return res.json({ status: "success", provider: provider.name, data: response.data });
        }
      }
    } catch (err) {
      continue;
    }
  }

  return res.status(404).json({ status: "error", message: "Order not found" });
});

app.get("/api/profit-settings", async (req, res) => {
  try {
    const settings = await getProfitSettings();
    res.json({ status: "success", settings });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.post("/api/profit-settings", async (req, res) => {
  const { mode, flatAmount, percentAmount, perBundle } = req.body;
  const validModes = ["flat", "percent", "perBundle"];
  if (!validModes.includes(mode)) {
    return res.status(400).json({ status: "error", message: "mode must be flat | percent | perBundle" });
  }
  const settings = {
    mode,
    flatAmount: parseFloat(flatAmount) || 0,
    percentAmount: parseFloat(percentAmount) || 0,
    perBundle: perBundle || {},
    updatedAt: new Date().toISOString(),
  };
  try {
    if (db) await db.ref("system/profitSettings").set(settings);
    profitSettingsCache = settings;
    res.json({ status: "success", settings });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ status: "error", message: `Route ${req.method} ${req.url} not found` });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("💥 Server error:", err.stack);
  res.status(500).json({ status: "error", message: "Internal server error" });
});

// ─────────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   🚀 DataFlow GH Backend Running             ║
║   📡 Port: ${PORT}                               ║
║                                              ║
║   MTN     → RemaData  ${REMADATA_API_KEY ? "✅" : "❌"}                  ║
║   Telecel → HubNetGH  ${HUBNET_API_KEY ? "✅" : "❌"}                  ║
║   AT      → HubNetGH  ${HUBNET_API_KEY ? "✅" : "❌"}                  ║
║                                              ║
║   Paystack Webhook: ${PAYSTACK_SECRET ? "✅" : "❌"}                    ║
║   /deliver protected: ${DELIVER_SECRET ? "✅" : "❌"}                  ║
║   Firebase: ${db ? "✅" : "❌"}                               ║
╚══════════════════════════════════════════════╝
  `);
});

// Keep-alive ping for Render free tier
if (process.env.NODE_ENV === "production") {
  setInterval(async () => {
    try {
      await axios.get(`http://localhost:${PORT}/health`, { timeout: 10000 });
    } catch (err) {
      console.error("⚠️ Keep-alive failed:", err.message);
    }
  }, 4 * 60 * 1000);
}

module.exports = app;
