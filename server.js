// ============================================================
//  DATEFLOW GH — UNIFIED BACKEND
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

// RemaData Configuration (for MTN)
const REMADATA_API_URL = "https://remadata.com/api";
const REMADATA_API_KEY = process.env.REMADATA_API_KEY || "";

// HubNetGH Configuration (for Telecel & AT)
const HUBNET_BASE_URL = "https://hubnetgh.site/wp-json/hubnet-api/v1";
const HUBNET_API_KEY = process.env.HUBNET_API_KEY || "";

// Paystack
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || "";

// Security
const DELIVER_SECRET = process.env.DELIVER_SECRET || "";

// In-memory dedup (prevents duplicate webhook processing)
const processedRefs = new Set();

// Network to provider mapping
const NETWORK_PROVIDER = {
  mtn: { name: "RemaData", config: { apiUrl: REMADATA_API_URL, apiKey: REMADATA_API_KEY } },
  telecel: { name: "HubNetGH", config: { apiUrl: HUBNET_BASE_URL, apiKey: HUBNET_API_KEY } },
  airteltigo: { name: "HubNetGH", config: { apiUrl: HUBNET_BASE_URL, apiKey: HUBNET_API_KEY } }
};

// HubNet static price list (fallback if API fails)
const HUBNET_PRICES = {
  mtn: [
    { volume: "1", volumeInMB: 1024, price: 4.00 },
    { volume: "2", volumeInMB: 2048, price: 8.00 },
    { volume: "3", volumeInMB: 3072, price: 12.00 },
    { volume: "4", volumeInMB: 4096, price: 16.00 },
    { volume: "5", volumeInMB: 5120, price: 19.60 },
    { volume: "6", volumeInMB: 6144, price: 24.00 },
    { volume: "7", volumeInMB: 7168, price: 27.00 },
    { volume: "8", volumeInMB: 8192, price: 32.00 },
    { volume: "10", volumeInMB: 10240, price: 39.00 },
    { volume: "15", volumeInMB: 15360, price: 57.00 },
    { volume: "20", volumeInMB: 20480, price: 77.10 },
    { volume: "25", volumeInMB: 25600, price: 96.00 },
    { volume: "30", volumeInMB: 30720, price: 116.00 },
    { volume: "40", volumeInMB: 40960, price: 155.00 },
    { volume: "50", volumeInMB: 51200, price: 186.00 },
    { volume: "100", volumeInMB: 102400, price: 370.00 },
  ],
  telecel: [
    { volume: "10", volumeInMB: 10240, price: 38.00 },
    { volume: "15", volumeInMB: 15360, price: 55.00 },
    { volume: "20", volumeInMB: 20480, price: 74.00 },
    { volume: "25", volumeInMB: 25600, price: 92.00 },
    { volume: "30", volumeInMB: 30720, price: 109.00 },
    { volume: "40", volumeInMB: 40960, price: 143.00 },
    { volume: "50", volumeInMB: 51200, price: 177.00 },
    { volume: "100", volumeInMB: 102400, price: 354.00 },
  ],
  airteltigo: [
    { volume: "1", volumeInMB: 1024, price: 3.90 },
    { volume: "2", volumeInMB: 2048, price: 7.80 },
    { volume: "3", volumeInMB: 3072, price: 11.80 },
    { volume: "4", volumeInMB: 4096, price: 15.70 },
    { volume: "5", volumeInMB: 5120, price: 19.40 },
    { volume: "6", volumeInMB: 6144, price: 23.80 },
    { volume: "7", volumeInMB: 7168, price: 27.40 },
    { volume: "8", volumeInMB: 8192, price: 31.00 },
    { volume: "9", volumeInMB: 9216, price: 35.00 },
    { volume: "10", volumeInMB: 10240, price: 39.00 },
    { volume: "12", volumeInMB: 12288, price: 47.00 },
    { volume: "15", volumeInMB: 15360, price: 59.00 },
    { volume: "20", volumeInMB: 20480, price: 78.50 },
    { volume: "25", volumeInMB: 25600, price: 98.00 },
  ],
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
    console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT_JSON not set — DB writes disabled");
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

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Auth middleware for /deliver endpoint
function requireApiKey(req, res, next) {
  if (!DELIVER_SECRET) {
    console.warn("⚠️ DELIVER_SECRET not configured — /deliver is unprotected!");
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
  if (formatted.startsWith("0")) {
    formatted = "233" + formatted.substring(1);
  }
  if (formatted.startsWith("+")) {
    formatted = formatted.substring(1);
  }
  return formatted;
}

function resolveVolume(volumeInMB) {
  const mb = Number(volumeInMB);
  if (mb >= 1024) {
    return String(Math.round(mb / 1024));
  }
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
//  DELIVERY FUNCTIONS BY PROVIDER
// ─────────────────────────────────────────────

/**
 * Deliver MTN data via RemaData API
 */
async function deliverViaRemaData(phone, volumeInMB, reference) {
  const orderRef = reference || `DF-${Date.now()}`;
  const formattedPhone = formatPhoneNumber(phone);

  const payload = {
    ref: orderRef,
    phone: formattedPhone,
    volumeInMB: Number(volumeInMB),
    networkType: "mtn"
  };

  console.log(`📦 [RemaData] Delivering ${volumeInMB}MB MTN → ${phone} | Ref: ${orderRef}`);

  const response = await axios.post(
    `${REMADATA_API_URL}/buy-data`,
    payload,
    {
      headers: {
        "X-API-KEY": REMADATA_API_KEY,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );

  const remaReference = response.data?.data?.reference || response.data?.reference || orderRef;

  return {
    success: response.data?.status === "success",
    reference: remaReference,
    data: response.data,
    provider: "RemaData"
  };
}

/**
 * Deliver Telecel/AT data via HubNetGH API
 */
async function deliverViaHubNet(phone, networkType, volumeInMB, reference) {
  const network = networkType === "airteltigo" ? "airteltigo" : "telecel";
  const volume = resolveVolume(volumeInMB);
  const requestId = reference || `DF-${Date.now()}`;

  console.log(`📦 [HubNetGH] Delivering ${volume}GB ${network} → ${phone} | Ref: ${requestId}`);

  const response = await axios.post(
    `${HUBNET_BASE_URL}/place_order`,
    {
      network,
      volume,
      customer_number: phone,
      quantity: 1,
      request_id: requestId,
    },
    {
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": HUBNET_API_KEY,
      },
      timeout: 30000,
    }
  );

  return {
    success: response.data?.success === true,
    reference: String(response.data?.order_id || requestId),
    data: response.data,
    provider: "HubNetGH"
  };
}

/**
 * Main delivery router - selects provider based on network type
 */
async function deliverData(phone, networkType, volumeInMB, reference = null) {
  const provider = NETWORK_PROVIDER[networkType?.toLowerCase()];

  if (!provider) {
    throw new Error(`Unsupported network type: ${networkType}`);
  }

  if (provider.name === "RemaData") {
    return await deliverViaRemaData(phone, volumeInMB, reference);
  } else {
    return await deliverViaHubNet(phone, networkType, volumeInMB, reference);
  }
}

// ─────────────────────────────────────────────
//  PAYSTACK WEBHOOK HANDLER
// ─────────────────────────────────────────────
function verifyPaystackSignature(rawBody, signature) {
  if (!PAYSTACK_SECRET || !rawBody || !signature) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const hash = crypto.createHmac("sha512", PAYSTACK_SECRET).update(body).digest("hex");
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

  // Respond immediately
  res.status(200).json({ received: true });

  // Process charge.success asynchronously
  if (event.event === "charge.success") {
    const { data } = event;
    const meta = data.metadata || {};
    const phone = meta.phone || meta.customer_phone;
    const networkType = meta.networkType || meta.network_type;
    const volumeInMB = meta.volumeInMB || meta.volume_in_mb;
    const ref = data.reference;
    const amount = data.amount ? data.amount / 100 : 0;

    // Duplicate check
    if (processedRefs.has(ref)) {
      console.warn(`⚠️ Duplicate webhook ignored for ref: ${ref}`);
      return;
    }

    if (!phone || !volumeInMB || !networkType) {
      console.warn(`⚠️ Missing delivery data: phone=${phone}, volume=${volumeInMB}, network=${networkType}`);
      return;
    }

    processedRefs.add(ref);

    try {
      console.log(`💳 Processing auto-delivery: ${networkType} ${volumeInMB}MB → ${phone}`);
      const result = await deliverData(phone, networkType, Number(volumeInMB), ref);
      
      if (result.success) {
        console.log(`✅ Auto-delivery successful via ${result.provider} | Ref: ${result.reference}`);
        
        // Save to Firebase if available
        if (db) {
          const orderData = {
            ref: ref,
            phone: phone,
            networkType: networkType,
            volumeInMB: volumeInMB,
            amount: amount,
            status: "completed",
            provider: result.provider,
            providerRef: result.reference,
            timestamp: new Date().toISOString(),
            source: "paystack_webhook"
          };
          await db.ref("transactions/" + ref).set(orderData);
        }
      } else {
        console.error(`❌ Auto-delivery failed: ${result.data?.message || "Unknown error"}`);
        processedRefs.delete(ref); // Allow retry
      }
    } catch (err) {
      console.error(`❌ Webhook delivery error:`, err.message);
      processedRefs.delete(ref);
    }
  }
});

// ─────────────────────────────────────────────
//  API ROUTES
// ─────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    service: "DataFlow GH Unified Backend",
    timestamp: new Date().toISOString(),
    providers: {
      mtn: { provider: "RemaData", configured: !!REMADATA_API_KEY },
      telecel: { provider: "HubNetGH", configured: !!HUBNET_API_KEY },
      airteltigo: { provider: "HubNetGH", configured: !!HUBNET_API_KEY }
    },
    endpoints: ["/deliver", "/api/bundles", "/api/order-status/:ref", "/api/balance", "/paystack/webhook"]
  });
});

// Get wallet balance (RemaData only)
app.get("/api/balance", async (req, res) => {
  try {
    const response = await axios.get(`${REMADATA_API_URL}/wallet-balance`, {
      headers: { "X-API-KEY": REMADATA_API_KEY },
      timeout: 10000
    });
    res.json(response.data);
  } catch (err) {
    console.error("Balance error:", err.response?.data || err.message);
    res.status(500).json({ status: "error", message: "Failed to fetch balance" });
  }
});

// Get bundles (unified - returns from correct provider)
app.get("/api/bundles", async (req, res) => {
  const network = (req.query.network || "mtn").toLowerCase();
  
  try {
    let bundles = [];
    
    if (network === "mtn") {
      // Fetch from RemaData
      const response = await axios.get(`${REMADATA_API_URL}/bundles?network=mtn`, {
        headers: { "X-API-KEY": REMADATA_API_KEY },
        timeout: 10000
      });
      
      if (response.data?.status === "success" && Array.isArray(response.data.data)) {
        bundles = response.data.data.map(b => ({
          volumeInMB: Number(b.volumeInMB),
          volume: b.volume || `${b.volumeInMB / 1024}GB`,
          price: parseFloat(b.price),
          name: b.name,
          network: "mtn"
        }));
      }
    } else {
      // Fetch from HubNet static prices
      const baseBundles = HUBNET_PRICES[network] || HUBNET_PRICES.mtn;
      const settings = await getProfitSettings();
      bundles = baseBundles.map(b => ({
        volumeInMB: b.volumeInMB,
        volume: b.volume,
        price: applyProfit(b.price, b.volumeInMB, network, settings),
        costPrice: b.price,
        network: network
      }));
    }
    
    res.json({ status: "success", data: bundles, provider: NETWORK_PROVIDER[network]?.name });
  } catch (err) {
    console.error("Bundles error:", err.message);
    // Fallback to static prices
    const fallbackBundles = HUBNET_PRICES[network] || HUBNET_PRICES.mtn;
    res.json({ 
      status: "success", 
      data: fallbackBundles.map(b => ({ ...b, network })),
      provider: "fallback"
    });
  }
});

// Unified delivery endpoint (protected)
app.post("/deliver", requireApiKey, async (req, res) => {
  const { phone, networkType, volumeInMB, ref } = req.body;

  if (!phone || !networkType || !volumeInMB) {
    return res.status(400).json({
      status: "error",
      message: "Missing required fields: phone, networkType, volumeInMB"
    });
  }

  // Validate network
  const validNetworks = ["mtn", "telecel", "airteltigo"];
  const normalizedNetwork = networkType.toLowerCase();
  if (!validNetworks.includes(normalizedNetwork)) {
    return res.status(400).json({
      status: "error",
      message: `Invalid network. Must be: ${validNetworks.join(", ")}`
    });
  }

  // Validate phone
  let cleanPhone = phone.replace(/\s+/g, "").replace(/-/g, "");
  if (!/^(0|233)[0-9]{9}$/.test(cleanPhone)) {
    return res.status(400).json({ status: "error", message: "Invalid phone number format" });
  }

  const volumeNum = Number(volumeInMB);
  if (isNaN(volumeNum) || volumeNum <= 0) {
    return res.status(400).json({ status: "error", message: "Invalid volumeInMB" });
  }

  try {
    const result = await deliverData(cleanPhone, normalizedNetwork, volumeNum, ref);
    
    if (result.success) {
      console.log(`✅ Delivery successful via ${result.provider}`);
      return res.json({
        status: "success",
        message: "Data delivered successfully",
        provider: result.provider,
        reference: result.reference,
        data: result.data
      });
    } else {
      return res.status(500).json({
        status: "error",
        message: result.data?.message || "Delivery failed",
        provider: result.provider
      });
    }
  } catch (err) {
    console.error("❌ /deliver error:", err.message);
    const statusCode = err.response?.status || 500;
    const errorMessage = err.response?.data?.message || err.message;
    return res.status(statusCode).json({
      status: "error",
      message: errorMessage
    });
  }
});

// Unified order status endpoint
app.get("/api/order-status/:reference", async (req, res) => {
  const { reference } = req.params;
  const { network } = req.query;

  if (!reference) {
    return res.status(400).json({ status: "error", message: "Reference is required" });
  }

  // Try each provider until we find the order
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
          return res.json({
            status: "success",
            provider: provider.name,
            data: response.data.data
          });
        }
      } else if (provider.name === "HubNetGH") {
        const response = await axios.get(`${HUBNET_BASE_URL}/order_status`, {
          params: { order_id: reference },
          headers: { "X-API-KEY": HUBNET_API_KEY },
          timeout: 10000
        });
        
        if (response.data?.success) {
          return res.json({
            status: "success",
            provider: provider.name,
            data: {
              order_id: response.data.order_id,
              status: response.data.status,
              status_label: response.data.status_label,
              customer_number: response.data.customer_number,
              network: response.data.network,
              volume: response.data.volume
            }
          });
        }
      }
    } catch (err) {
      // Continue to next provider
      continue;
    }
  }

  return res.status(404).json({
    status: "error",
    message: "Order not found with any provider"
  });
});

// Profit settings endpoints
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
    res.json({ status: "success", message: "Profit settings saved", settings });
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
╔═══════════════════════════════════════════════════════════════╗
║   🚀 DataFlow GH UNIFIED Backend Running                      ║
║   📡 Port: ${PORT}                                              ║
║                                                               ║
║   📦 Provider Routing:                                        ║
║      MTN       → RemaData  ${REMADATA_API_KEY ? "✅" : "❌"}                    ║
║      Telecel   → HubNetGH  ${HUBNET_API_KEY ? "✅" : "❌"}                    ║
║      AT        → HubNetGH  ${HUBNET_API_KEY ? "✅" : "❌"}                    ║
║                                                               ║
║   💳 Paystack Webhook: ${PAYSTACK_SECRET ? "✅" : "❌"}                         ║
║   🔒 /deliver protected: ${DELIVER_SECRET ? "✅" : "❌"}                       ║
║   🔥 Firebase: ${db ? "✅" : "❌"}                                           ║
║                                                               ║
║   📮 Endpoints:                                               ║
║      POST /deliver                 → Manual delivery 🔒       ║
║      GET  /api/bundles             → Get bundles             ║
║      GET  /api/order-status/:ref   → Check order status      ║
║      GET  /api/balance             → RemaData wallet         ║
║      POST /paystack/webhook        → Paystack auto-delivery  ║
║      GET  /health                  → Health check            ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});

// Keep-alive for production
if (process.env.NODE_ENV === "production") {
  setInterval(async () => {
    try {
      await axios.get(`http://localhost:${PORT}/health`, { timeout: 10000 });
    } catch (err) {
      console.error("⚠️ Health check failed:", err.message);
    }
  }, 4 * 60 * 1000);
}

module.exports = app;
