// ============================================================
//  DataFlow GH — Backend Server
//  Integrates: HubNet API · Paystack · Firebase Admin
// ============================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const admin = require("firebase-admin");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: "*" }));

// Paystack webhook needs the RAW body for signature verification.
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

// ── Firebase Admin Initialisation ────────────────────────────
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

// ── HubNet API client ─────────────────────────────────────────
const hubnet = axios.create({
  baseURL: "https://hubnetgh.site/wp-json/hubnet-api/v1",
  headers: {
    "Content-Type": "application/json",
    "X-API-KEY": process.env.HUBNET_API_KEY,
  },
  timeout: 30000,
});

// ── Paystack helper ───────────────────────────────────────────
function verifyPaystackSignature(rawBody, signature) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret || !rawBody || !signature) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const hash = crypto
    .createHmac("sha512", secret)
    .update(body)
    .digest("hex");
  return hash === signature;
}

// ── Utility Functions ─────────────────────────────────────────
function resolveVolume(volumeInMB) {
  const mb = Number(volumeInMB);
  if (mb >= 1024) {
    return String(Math.round(mb / 1024));
  }
  return String(mb);
}

const NETWORK_MAP = {
  mtn: "mtn",
  telecel: "telecel",
  airteltigo: "airteltigo",
};

function resolveNetwork(networkType) {
  return NETWORK_MAP[networkType?.toLowerCase()] || networkType || "mtn";
}

// ── HubNet Cost Prices ────────────────────────────────────────
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

// ── Profit Settings ───────────────────────────────────────────
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

// ============================================================
// ROUTES
// ============================================================

// Health check
app.get("/health", async (_req, res) => {
  res.json({
    status: "OK",
    service: "DataFlow GH Backend",
    timestamp: new Date().toISOString(),
    hubnetConfigured: !!process.env.HUBNET_API_KEY,
    paystackConfigured: !!process.env.PAYSTACK_SECRET_KEY,
    firebaseConfigured: !!db,
  });
});

// Get wallet balance
app.get("/api/balance", async (_req, res) => {
  try {
    const { data } = await hubnet.get("/check_balance");
    if (data.success) {
      return res.json({
        status: "success",
        data: { balance: data.wallet_balance },
      });
    }
    return res.status(502).json({
      status: "error",
      message: data.message || "Failed to fetch balance",
    });
  } catch (err) {
    console.error("❌ /api/balance error:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

// Get bundles with profit applied
app.get("/api/bundles", async (req, res) => {
  const network = (req.query.network || "mtn").toLowerCase();
  const baseBundles = HUBNET_PRICES[network] || HUBNET_PRICES.mtn;
  try {
    const settings = await getProfitSettings();
    const bundles = baseBundles.map((b) => ({
      ...b,
      network,
      costPrice: b.price,
      price: applyProfit(b.price, b.volumeInMB, network, settings),
    }));
    return res.json({ status: "success", data: bundles });
  } catch (err) {
    console.error("❌ /api/bundles error:", err.message);
    return res.json({
      status: "success",
      data: baseBundles.map(b => ({ ...b, network, costPrice: b.price })),
    });
  }
});

// Delivery endpoint
app.post("/deliver", async (req, res) => {
  const { phone, networkType, volumeInMB, ref } = req.body;

  if (!phone || !networkType || !volumeInMB) {
    return res.status(400).json({
      status: "error",
      message: "Missing required fields: phone, networkType, volumeInMB",
    });
  }

  const network = resolveNetwork(networkType);
  const volume = resolveVolume(volumeInMB);
  const requestId = ref || `DF-${Date.now()}`;

  console.log(`📦 Delivering: ${volume}GB ${network} → ${phone} | ref: ${requestId}`);

  try {
    const { data } = await hubnet.post("/place_order", {
      network,
      volume,
      customer_number: phone,
      quantity: 1,
      request_id: requestId,
    });

    if (data.success) {
      console.log(`✅ HubNet order placed | order_id: ${data.order_id}`);
      return res.json({
        status: "success",
        message: "Data bundle delivered successfully",
        reference: String(data.order_id),
        orderId: String(data.order_id),
        total: data.total,
        data: { order_id: data.order_id, total: data.total },
      });
    }

    console.warn("⚠️ HubNet place_order failed:", data);
    return res.status(502).json({
      status: "error",
      message: data.message || "HubNet order failed",
    });
  } catch (err) {
    const hubnetMsg = err.response?.data?.message || err.response?.data || err.message;
    console.error("❌ /deliver error:", hubnetMsg);
    const statusCode = err.response?.status || 500;
    return res.status(statusCode).json({
      status: "error",
      message: typeof hubnetMsg === "string" ? hubnetMsg : JSON.stringify(hubnetMsg),
    });
  }
});

// Order status
app.get("/api/order-status/:reference", async (req, res) => {
  const { reference } = req.params;
  if (!reference) {
    return res.status(400).json({ status: "error", message: "Missing order reference" });
  }
  try {
    const { data } = await hubnet.get("/order_status", {
      params: { order_id: reference },
    });
    if (data.success) {
      return res.json({
        status: "success",
        data: {
          order_id: data.order_id,
          status: data.status,
          status_label: data.status_label,
          customer_number: data.customer_number,
          network: data.network,
          volume: data.volume,
          total: data.total,
          created_at: data.created_at,
        },
      });
    }
    return res.status(404).json({
      status: "error",
      message: data.message || "Order not found",
    });
  } catch (err) {
    const hubnetMsg = err.response?.data?.message || err.message;
    console.error("❌ /api/order-status error:", hubnetMsg);
    return res.status(err.response?.status || 500).json({
      status: "error",
      message: typeof hubnetMsg === "string" ? hubnetMsg : "Failed to fetch order status",
    });
  }
});

// ============================================================
// PAYSTACK WEBHOOK - FIXED (No duplicate orders)
// ============================================================
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

  // Respond immediately to prevent Paystack timeouts
  res.status(200).json({ received: true });

  // Process webhook asynchronously
  if (event.event === "charge.success") {
    const { data } = event;
    const meta = data.metadata || {};
    const phone = meta.phone || meta.customer_phone;
    const networkType = meta.networkType || meta.network_type;
    const volumeInMB = meta.volumeInMB || meta.volume_in_mb;
    const ref = data.reference;
    const customerEmail = data.customer?.email;
    const amount = data.amount ? data.amount / 100 : 0;
    const orderIdFromMeta = meta.orderId || meta.order_id;

    console.log(`💳 Processing charge.success: ref=${ref}, phone=${phone}, volume=${volumeInMB}MB`);

    if (!phone || !volumeInMB) {
      console.warn(`⚠️ Missing delivery data: phone=${phone}, volume=${volumeInMB}`);
      return;
    }

    try {
      const network = resolveNetwork(networkType);
      const volume = resolveVolume(volumeInMB);

      // ============================================================
      // IMPORTANT: FIRST check if order already exists in Firebase
      // This prevents duplicate orders!
      // ============================================================
      let existingOrderKey = null;
      let existingOrderData = null;

      if (db) {
        // Try to find existing order by Paystack reference
        const snapshot = await db.ref("orders").orderByChild("ref").equalTo(ref).once("value");
        const orders = snapshot.val();
        
        if (orders) {
          existingOrderKey = Object.keys(orders)[0];
          existingOrderData = orders[existingOrderKey];
          console.log(`✅ Found existing order by ref: ${existingOrderKey}`);
        } else if (orderIdFromMeta) {
          // Also try to find by orderId (DF-XXXX format from frontend)
          const orderIdSnapshot = await db.ref("orders").orderByChild("orderId").equalTo(orderIdFromMeta).once("value");
          const orderIdOrders = orderIdSnapshot.val();
          if (orderIdOrders) {
            existingOrderKey = Object.keys(orderIdOrders)[0];
            existingOrderData = orderIdOrders[existingOrderKey];
            console.log(`✅ Found existing order by orderId: ${existingOrderKey}`);
          }
        }
      }

      // Attempt delivery via HubNet
      const hubnetRes = await hubnet.post("/place_order", {
        network,
        volume,
        customer_number: phone,
        quantity: 1,
        request_id: ref,
      });

      if (hubnetRes.data.success) {
        console.log(`✅ Auto-delivered: ${volume}GB to ${phone} | order_id: ${hubnetRes.data.order_id}`);

        if (db) {
          if (existingOrderKey) {
            // UPDATE existing order - DO NOT CREATE NEW ONE
            await db.ref(`orders/${existingOrderKey}`).update({
              status: "completed",
              deliveryStatus: "delivered",
              remaDataRef: String(hubnetRes.data.order_id),
              deliveryTime: new Date().toISOString(),
              autoDelivered: true,
              webhookProcessed: true,
              webhookProcessedAt: new Date().toISOString(),
            });
            console.log(`✅ Updated existing order: ${existingOrderKey} (NO DUPLICATE CREATED)`);
          } else {
            // ONLY CREATE NEW ORDER IF ABSOLUTELY NECESSARY
            // This should rarely happen since frontend creates the order first
            console.warn(`⚠️ No existing order found for ref: ${ref} - creating fallback order`);
            const newOrderRef = db.ref("orders").push();
            await newOrderRef.set({
              orderId: `WEB-${Date.now()}`,
              ref: ref,
              phone: phone,
              email: customerEmail || "webhook@paystack.com",
              name: meta.name || "Webhook Order",
              bundle: `${volume}GB`,
              network: networkType || "mtn",
              networkType: network,
              volumeInMB: volumeInMB,
              amount: amount,
              grandTotalPaid: amount,
              status: "completed",
              deliveryStatus: "delivered",
              remaDataRef: String(hubnetRes.data.order_id),
              timestamp: new Date().toISOString(),
              source: "paystack_webhook_fallback",
            });
            console.log(`✅ Created fallback order from webhook (frontend didn't create one)`);
          }
        }
      } else {
        console.error(`❌ HubNet delivery failed: ${hubnetRes.data.message}`);
        
        // Update existing order as failed if needed
        if (db && existingOrderKey) {
          await db.ref(`orders/${existingOrderKey}`).update({
            status: "paid-pending-delivery",
            deliveryError: hubnetRes.data.message || "Auto-delivery failed",
            webhookProcessed: true,
          });
          console.log(`✅ Updated existing order as pending: ${existingOrderKey}`);
        }
      }
    } catch (err) {
      console.error(`❌ Webhook delivery error: ${err.message}`);
    }
  }
});

// Profit settings endpoints
app.get("/api/profit-settings", async (_req, res) => {
  try {
    const settings = await getProfitSettings();
    const preview = {};
    for (const [net, bundles] of Object.entries(HUBNET_PRICES)) {
      preview[net] = bundles.map((b) => ({
        ...b,
        sellingPrice: applyProfit(b.price, b.volumeInMB, net, settings),
        profit: parseFloat((applyProfit(b.price, b.volumeInMB, net, settings) - b.price).toFixed(2)),
      }));
    }
    return res.json({ status: "success", settings, preview });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
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
    console.log(`✅ Profit settings updated: mode=${mode}`);
    return res.json({ status: "success", message: "Profit settings saved", settings });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
});

app.post("/api/bundles/refresh", (_req, res) => {
  profitSettingsCache = null;
  console.log("🔄 Profit settings cache cleared");
  res.json({ status: "success", message: "Cache cleared" });
});

// Catch-all 404
app.use((_req, res) => {
  res.status(404).json({ status: "error", message: "Endpoint not found" });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 DataFlow GH Backend running on port ${PORT}`);
  console.log(`   HubNet API key : ${process.env.HUBNET_API_KEY ? "✓ set" : "✗ MISSING"}`);
  console.log(`   Paystack key   : ${process.env.PAYSTACK_SECRET_KEY ? "✓ set" : "✗ MISSING"}`);
  console.log(`   Firebase DB    : ${db ? "✓ connected" : "✗ not connected"}`);
  console.log(`\n📌 Webhook endpoint: /paystack/webhook`);
  console.log(`   Duplicate order protection: ENABLED\n`);
});
