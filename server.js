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
app.use(express.json());

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
  if (!secret) return false;
  const hash = crypto
    .createHmac("sha512", secret)
    .update(rawBody)
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

// ── GET /api/bundles ──────────────────────────────────────────
// Returns available data bundles for a network.
// The frontend passes ?network=mtn|telecel|airteltigo
// We return a normalised list so the frontend can display prices.
//
// HubNet doesn't have a "list bundles" endpoint, so we expose
// our own curated bundle list and mark their cost price + MB.
app.get("/api/bundles", (req, res) => {
  const network = (req.query.network || "mtn").toLowerCase();

  // Curated MTN SME bundle list — price = HubNet cost (GHS).
  // Update these whenever HubNet changes rates.
  const MTN_BUNDLES = [
    { volumeInMB: 1000,  price: 4.50  }, // ~1 GB
    { volumeInMB: 2048,  price: 8.50  }, // 2 GB
    { volumeInMB: 3072,  price: 12.00 }, // 3 GB
    { volumeInMB: 5120,  price: 19.00 }, // 5 GB
    { volumeInMB: 10240, price: 36.00 }, // 10 GB
    { volumeInMB: 15360, price: 52.00 }, // 15 GB
    { volumeInMB: 20480, price: 68.00 }, // 20 GB
    { volumeInMB: 30720, price: 98.00 }, // 30 GB
    { volumeInMB: 51200, price: 155.00 }, // 50 GB
  ];

  // For now all networks use the same list.
  // Extend with TELECEL_BUNDLES / AT_BUNDLES when supported by HubNet.
  const bundles = MTN_BUNDLES.map((b) => ({
    ...b,
    network: network,
  }));

  return res.json({ status: "success", data: bundles });
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
app.post(
  "/paystack/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["x-paystack-signature"];

    if (!verifyPaystackSignature(req.body, signature)) {
      console.warn("⚠️  Invalid Paystack webhook signature");
      return res.status(401).json({ error: "Invalid signature" });
    }

    let event;
    try {
      event = JSON.parse(req.body.toString());
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }

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

          if (data.success && db) {
            // Update Firebase order status
            const snapshot = await db
              .ref("orders")
              .orderByChild("ref")
              .equalTo(ref)
              .once("value");
            const orders = snapshot.val();
            if (orders) {
              const key = Object.keys(orders)[0];
              await db.ref(`orders/${key}`).update({
                status: "completed",
                deliveryStatus: "delivered",
                remaDataRef: String(data.order_id),
                deliveryTime: new Date().toISOString(),
              });
            }
          }
        } catch (err) {
          console.error("❌ Webhook delivery error:", err.message);
        }
      }
    }

    res.json({ received: true });
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
