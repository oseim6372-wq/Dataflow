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
// We must capture it BEFORE express.json() parses it into an object.
// Solution: store raw body on req.rawBody for the webhook route,
// while still allowing express.json() to work for all other routes.
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
    console.warn("⚠️  FIREBASE_SERVICE_ACCOUNT_JSON not set — DB writes disabled");
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

// ── Utility ───────────────────────────────────────────────────
/**
 * Convert volumeInMB + networkType to the HubNet "volume" string.
 * HubNet volume = GB as a whole number string, e.g. "1", "2", "5".
 * For bundles under 1 GB we send the MB count as a string.
 */
function resolveVolume(volumeInMB) {
  const mb = Number(volumeInMB);
  if (mb >= 1024) {
    return String(Math.round(mb / 1024));
  }
  return String(mb);
}

/**
 * Map internal network keys to HubNet network strings.
 */
const NETWORK_MAP = {
  mtn: "mtn",
  telecel: "mtn",   // update if HubNet supports telecel
  airteltigo: "mtn", // update if HubNet supports AT
};

function resolveNetwork(networkType) {
  return NETWORK_MAP[networkType?.toLowerCase()] || networkType || "mtn";
}

// ── Routes ────────────────────────────────────────────────────

// Health check
app.get("/health", async (_req, res) => {
  res.json({
    status: "OK",
    service: "DataFlow GH Backend",
    timestamp: new Date().toISOString(),
    hubnetConfigured: !!process.env.HUBNET_API_KEY,
    paystackConfigured: !!process.env.PAYSTACK_SECRET_KEY,
    firebaseConfigured: !!db,
    profitSettingsCached: !!profitSettingsCache,
  });
});

// ── GET /api/balance ──────────────────────────────────────────
// Returns the HubNet wallet balance.
app.get("/api/balance", async (_req, res) => {
  try {
    const { data } = await hubnet.get("/check_balance");

    if (data.success) {
      return res.json({
        status: "success",
        data: {
          balance: data.wallet_balance,
        },
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

// ── HubNet Cost Prices (confirmed from hubnetgh.site) ─────────
// These are the exact wholesale prices from HubNet's platform.
// The frontend adds your profit margin on top of these.
const HUBNET_PRICES = {
  mtn: [
    { volume: "1",   volumeInMB: 1024,   price: 4.00  },
    { volume: "2",   volumeInMB: 2048,   price: 8.00  },
    { volume: "3",   volumeInMB: 3072,   price: 12.00 },
    { volume: "4",   volumeInMB: 4096,   price: 16.00 },
    { volume: "5",   volumeInMB: 5120,   price: 19.60 },
    { volume: "6",   volumeInMB: 6144,   price: 24.00 },
    { volume: "7",   volumeInMB: 7168,   price: 27.00 },
    { volume: "8",   volumeInMB: 8192,   price: 32.00 },
    { volume: "10",  volumeInMB: 10240,  price: 39.00 },
    { volume: "15",  volumeInMB: 15360,  price: 57.00 },
    { volume: "20",  volumeInMB: 20480,  price: 77.10 },
    { volume: "25",  volumeInMB: 25600,  price: 96.00 },
    { volume: "30",  volumeInMB: 30720,  price: 116.00 },
    { volume: "40",  volumeInMB: 40960,  price: 155.00 },
    { volume: "50",  volumeInMB: 51200,  price: 186.00 },
    { volume: "100", volumeInMB: 102400, price: 370.00 },
  ],
  telecel: [
    { volume: "10",  volumeInMB: 10240,  price: 38.00  },
    { volume: "15",  volumeInMB: 15360,  price: 55.00  },
    { volume: "20",  volumeInMB: 20480,  price: 74.00  },
    { volume: "25",  volumeInMB: 25600,  price: 92.00  },
    { volume: "30",  volumeInMB: 30720,  price: 109.00 },
    { volume: "40",  volumeInMB: 40960,  price: 143.00 },
    { volume: "50",  volumeInMB: 51200,  price: 177.00 },
    { volume: "100", volumeInMB: 102400, price: 354.00 },
  ],
  airteltigo: [
    { volume: "1",   volumeInMB: 1024,   price: 3.90  },
    { volume: "2",   volumeInMB: 2048,   price: 7.80  },
    { volume: "3",   volumeInMB: 3072,   price: 11.80 },
    { volume: "4",   volumeInMB: 4096,   price: 15.70 },
    { volume: "5",   volumeInMB: 5120,   price: 19.40 },
    { volume: "6",   volumeInMB: 6144,   price: 23.80 },
    { volume: "7",   volumeInMB: 7168,   price: 27.40 },
    { volume: "8",   volumeInMB: 8192,   price: 31.00 },
    { volume: "9",   volumeInMB: 9216,   price: 35.00 },
    { volume: "10",  volumeInMB: 10240,  price: 39.00 },
    { volume: "12",  volumeInMB: 12288,  price: 47.00 },
    { volume: "15",  volumeInMB: 15360,  price: 59.00 },
    { volume: "20",  volumeInMB: 20480,  price: 78.50 },
    { volume: "25",  volumeInMB: 25600,  price: 98.00 },
  ],
};

// ── Profit settings store (Firebase-backed) ───────────────────
// Profit config shape saved in Firebase at: system/profitSettings
// {
//   mode: "flat" | "percent" | "perBundle",
//   flatAmount: 1.00,          // added to every bundle (mode=flat)
//   percentAmount: 10,         // % added on top (mode=percent)
//   perBundle: { "mtn_1024": 0.50, ... }  // per-bundle overrides (mode=perBundle)
// }
let profitSettingsCache = null;

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
  // Default: flat
  const flat = parseFloat(flatAmount) || 0;
  return Math.ceil((costPrice + flat) * 20) / 20;
}

// ── GET /api/bundles ──────────────────────────────────────────
// Returns HubNet cost prices + your profit margin applied.
// Frontend passes ?network=mtn|telecel|airteltigo
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
    return res.json({ status: "success", data: baseBundles.map(b => ({ ...b, network, costPrice: b.price })) });
  }
});

// ── GET /api/profit-settings ──────────────────────────────────
// Admin: get current profit configuration
app.get("/api/profit-settings", async (_req, res) => {
  try {
    const settings = await getProfitSettings();
    // Also return the raw HubNet prices so admin can preview
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

// ── POST /api/profit-settings ─────────────────────────────────
// Admin: save profit configuration
// Body: { mode, flatAmount?, percentAmount?, perBundle? }
app.post("/api/profit-settings", async (req, res) => {
  const { mode, flatAmount, percentAmount, perBundle } = req.body;
  const validModes = ["flat", "percent", "perBundle"];
  if (!validModes.includes(mode)) {
    return res.status(400).json({ status: "error", message: "mode must be flat | percent | perBundle" });
  }
  const settings = { mode, flatAmount: parseFloat(flatAmount) || 0, percentAmount: parseFloat(percentAmount) || 0, perBundle: perBundle || {}, updatedAt: new Date().toISOString() };
  try {
    if (db) await db.ref("system/profitSettings").set(settings);
    profitSettingsCache = settings; // update in-memory cache
    console.log(`✅ Profit settings updated: mode=${mode}`);
    return res.json({ status: "success", message: "Profit settings saved", settings });
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
});

// ── POST /api/bundles/refresh ─────────────────────────────────
// Admin: clears profit settings cache so next request re-reads Firebase
app.post("/api/bundles/refresh", (_req, res) => {
  profitSettingsCache = null;
  console.log("🔄 Profit settings cache cleared");
  res.json({ status: "success", message: "Cache cleared. Prices will reload from Firebase on next request." });
});

// ── POST /deliver ─────────────────────────────────────────────
// Called by the frontend after a successful Paystack payment.
// Sends the data bundle via the HubNet /place_order endpoint.
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
        data: {
          order_id: data.order_id,
          total: data.total,
        },
      });
    }

    console.warn("⚠️  HubNet place_order failed:", data);
    return res.status(502).json({
      status: "error",
      message: data.message || "HubNet order failed",
    });
  } catch (err) {
    const hubnetMsg =
      err.response?.data?.message || err.response?.data || err.message;
    console.error("❌ /deliver error:", hubnetMsg);

    const statusCode = err.response?.status || 500;
    return res.status(statusCode).json({
      status: "error",
      message: typeof hubnetMsg === "string" ? hubnetMsg : JSON.stringify(hubnetMsg),
    });
  }
});

// ── GET /api/order-status/:reference ─────────────────────────
// Proxies HubNet's /order_status endpoint.
// :reference = the HubNet order_id returned by /place_order.
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

// ── POST /paystack/webhook ────────────────────────────────────
// Receives Paystack charge.success events and auto-delivers data.
app.post("/paystack/webhook", async (req, res) => {
    const signature = req.headers["x-paystack-signature"];

    if (!verifyPaystackSignature(req.rawBody, signature)) {
      console.warn("⚠️  Invalid Paystack webhook signature");
      return res.status(401).json({ error: "Invalid signature" });
    }

    let event;
    try {
      event = JSON.parse(req.rawBody.toString());
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }

    // Respond to Paystack immediately — delivery happens async
    res.json({ received: true });

    if (event.event === "charge.success") {
      const meta = event.data.metadata || {};
      const phone = meta.phone || meta.customer_phone;
      const networkType = meta.networkType || meta.network_type || "mtn";
      const volumeInMB = meta.volumeInMB || meta.volume_in_mb;
      const ref = event.data.reference;

      console.log(`💳 Paystack webhook: ${ref} | ${phone} | ${networkType} | ${volumeInMB}MB`);

      if (phone && volumeInMB) {
        try {
          const network = resolveNetwork(networkType);
          const volume = resolveVolume(volumeInMB);

          const { data } = await hubnet.post("/place_order", {
            network,
            volume,
            customer_number: phone,
            quantity: 1,
            request_id: ref,
          });

          console.log(`✅ Webhook delivery: HubNet order_id=${data.order_id} | success=${data.success}`);

          if (db) {
            // Find the Firebase order by ref and update its status
            const snapshot = await db
              .ref("orders")
              .orderByChild("ref")
              .equalTo(ref)
              .once("value");
            const orders = snapshot.val();
            if (orders) {
              const key = Object.keys(orders)[0];
              await db.ref(`orders/${key}`).update({
                status: data.success ? "completed" : "failed",
                deliveryStatus: data.success ? "delivered" : "failed",
                remaDataRef: data.success ? String(data.order_id) : null,
                deliveryTime: new Date().toISOString(),
              });
              console.log(`✅ Firebase order ${key} updated`);
            } else {
              // Order not found in Firebase — create a new record
              await db.ref("orders").push({
                ref,
                phone,
                networkType,
                volumeInMB,
                status: data.success ? "completed" : "failed",
                deliveryStatus: data.success ? "delivered" : "failed",
                remaDataRef: data.success ? String(data.order_id) : null,
                source: "webhook",
                createdAt: new Date().toISOString(),
                deliveryTime: new Date().toISOString(),
              });
              console.log(`✅ New order created in Firebase from webhook`);
            }
          }
        } catch (err) {
          console.error("❌ Webhook delivery error:", err.message);
        }
      } else {
        console.warn(`⚠️  Webhook missing phone or volumeInMB in metadata`, meta);
      }
    }
  }
);

// ── Catch-all 404 ─────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ status: "error", message: "Endpoint not found" });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 DataFlow GH Backend running on port ${PORT}`);
  console.log(`   HubNet API key : ${process.env.HUBNET_API_KEY ? "✓ set" : "✗ MISSING"}`);
  console.log(`   Paystack key   : ${process.env.PAYSTACK_SECRET_KEY ? "✓ set" : "✗ MISSING"}`);
  console.log(`   Firebase DB    : ${db ? "✓ connected" : "✗ not connected"}\n`);
});
