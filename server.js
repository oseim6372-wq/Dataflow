// ============================================================
//  DATEFLOW GH — BACKEND FOR DEVELOPER PORTAL
//  Complete integration with Firebase auth, wallet management,
//  data delivery via RemaData (MTN) and HubNetGH (Telecel/AT)
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
const DELIVER_SECRET = process.env.DELIVER_SECRET || "your-super-secret-deliver-key-change-me";

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Processed references for webhook deduplication
const processedRefs = new Map();
const REF_TTL = 24 * 60 * 60 * 1000;
const MAX_REF_SIZE = 10000;

// Network providers with bidirectional failover
const NETWORK_PROVIDER = {
  mtn: { 
    name: "RemaData", 
    primary: true,
    fallback: "HubNetGH",
    fallbackNetwork: "mtn"
  },
  telecel: { 
    name: "HubNetGH", 
    primary: true,
    fallback: "RemaData",
    fallbackNetwork: "telecel"
  },
  airteltigo: { 
    name: "HubNetGH", 
    primary: true,
    fallback: "RemaData",
    fallbackNetwork: "airteltigo"
  },
};

// Bundle pricing (cost prices)
const BUNDLE_PRICES = {
  mtn: {
    1024: 4.30, 2048: 8.60, 3072: 12.50, 4096: 16.50, 5120: 21.70,
    6144: 24.50, 8192: 32.50, 10240: 39.00, 15360: 57.00, 20480: 77.10,
    25600: 96.00, 30720: 116.00, 40960: 155.00, 51200: 186.00, 102400: 370.00
  },
  telecel: {
    10240: 38.00, 15360: 55.00, 20480: 74.00, 25600: 92.00, 30720: 109.00,
    40960: 143.00, 51200: 177.00, 102400: 354.00
  },
  airteltigo: {
    1024: 3.90, 2048: 7.80, 3072: 11.80, 4096: 15.70, 5120: 19.40,
    6144: 23.80, 7168: 27.40, 8192: 31.00, 9216: 35.00, 10240: 39.00,
    12288: 47.00, 15360: 59.00, 20480: 78.50, 25600: 98.00
  }
};

// Volume mapping for RemaData (MTN specific)
const REMA_MB_MAP = {
  1024: 1000, 2048: 2000, 3072: 3000, 4096: 4000, 5120: 5000,
  6144: 6000, 7168: 7000, 8192: 8000, 9216: 9000, 10240: 10000,
  12288: 11000, 13312: 12000, 14336: 13000, 15360: 14000, 16384: 15000,
  17408: 16000, 18432: 17000, 19456: 18000, 20480: 19000, 25600: 25000,
  30720: 30000, 40960: 40000, 51200: 50000, 102400: 100000
};

// Profit margin (you can adjust this or make it dynamic)
const PROFIT_MARGIN = 1.20; // 20% markup

// ─────────────────────────────────────────────
//  FIREBASE ADMIN INIT
// ─────────────────────────────────────────────

let firebaseDb = null;

try {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    : null;

  if (serviceAccount && process.env.FIREBASE_DATABASE_URL) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
    firebaseDb = admin.database();
    console.log("✅ Firebase Admin initialized");
  } else {
    console.warn("⚠️ Firebase not configured - using mock database");
  }
} catch (err) {
  console.error(`❌ Firebase init failed: ${err.message}`);
}

// ─────────────────────────────────────────────
//  HELPER FUNCTIONS
// ─────────────────────────────────────────────

function formatPhoneLocal(phone) {
  let p = String(phone).replace(/[\s\-]/g, "");
  if (p.startsWith("233")) p = "0" + p.slice(3);
  if (p.startsWith("+233")) p = "0" + p.slice(4);
  if (!p.startsWith("0")) p = "0" + p;
  if (!/^0\d{9}$/.test(p)) {
    throw new Error(`Invalid phone format: "${phone}"`);
  }
  return p;
}

function resolveVolume(volumeInMB) {
  const mb = Number(volumeInMB);
  return mb >= 1024 ? String(Math.round(mb / 1024)) : String(mb);
}

function calculatePrice(costPrice, volumeInMB, network) {
  // Apply profit margin
  const withMargin = costPrice * PROFIT_MARGIN;
  // Round to nearest 0.05
  return Math.ceil(withMargin * 20) / 20;
}

function getBundlePrice(network, volumeInMB) {
  const prices = BUNDLE_PRICES[network];
  if (!prices || !prices[volumeInMB]) {
    return null;
  }
  return calculatePrice(prices[volumeInMB], volumeInMB, network);
}

// ─────────────────────────────────────────────
//  DELIVERY FUNCTIONS
// ─────────────────────────────────────────────

async function deliverViaRemaData(phone, volumeInMB, reference) {
  if (!REMADATA_API_KEY) {
    throw new Error("RemaData API not configured");
  }
  
  const orderRef = reference || `DF-${Date.now()}`;
  const localPhone = formatPhoneLocal(phone);
  const remaMB = REMA_MB_MAP[Number(volumeInMB)] || Number(volumeInMB);

  const payload = {
    ref: orderRef,
    phone: localPhone,
    volumeInMB: remaMB,
    networkType: "mtn",
  };

  console.log(`📦 [RemaData] ${volumeInMB}MB → ${remaMB}MB MTN → ${localPhone}`);

  const response = await axios.post(`${REMADATA_API_URL}/buy-data`, payload, {
    headers: { "X-API-KEY": REMADATA_API_KEY, "Content-Type": "application/json" },
    timeout: 30000,
  });

  if (response.data?.status !== "success") {
    throw new Error(response.data?.message || "RemaData delivery failed");
  }

  const remaReference = response.data?.data?.reference || response.data?.reference || orderRef;
  return { success: true, reference: remaReference, provider: "RemaData", data: response.data };
}

async function deliverViaHubNet(phone, networkType, volumeInMB, reference) {
  if (!HUBNET_API_KEY) {
    throw new Error("HubNetGH API not configured");
  }
  
  let network;
  switch (networkType) {
    case "airteltigo": network = "airteltigo"; break;
    case "telecel": network = "telecel"; break;
    case "mtn": network = "mtn"; break;
    default: network = "telecel";
  }
  
  const volume = resolveVolume(volumeInMB);
  const requestId = reference || `DF-${Date.now()}`;
  const localPhone = formatPhoneLocal(phone);

  console.log(`📦 [HubNetGH] ${volume}GB ${network} → ${localPhone}`);

  const response = await axios.post(
    `${HUBNET_BASE_URL}/place_order`,
    { network, volume, customer_number: localPhone, quantity: 1, request_id: requestId },
    {
      headers: { "Content-Type": "application/json", "X-API-KEY": HUBNET_API_KEY },
      timeout: 30000,
    }
  );

  if (!response.data?.success) {
    throw new Error(response.data?.message || "HubNetGH delivery failed");
  }

  const orderId = String(response.data?.order_id || requestId);
  return { success: true, reference: orderId, provider: "HubNetGH", data: response.data };
}

async function deliverData(phone, networkType, volumeInMB, reference = null) {
  const net = networkType?.toLowerCase();
  const providerConfig = NETWORK_PROVIDER[net];
  
  if (!providerConfig) {
    throw new Error(`Unsupported network: "${networkType}"`);
  }
  
  const errors = [];
  
  // Try primary provider
  try {
    if (providerConfig.name === "RemaData") {
      return await deliverViaRemaData(phone, volumeInMB, reference);
    } else {
      return await deliverViaHubNet(phone, net, volumeInMB, reference);
    }
  } catch (primaryError) {
    errors.push(`${providerConfig.name}: ${primaryError.message}`);
    console.warn(`⚠️ Primary failed: ${primaryError.message}`);
    
    // Try fallback
    if (providerConfig.fallback) {
      try {
        let result;
        if (providerConfig.fallback === "RemaData") {
          result = await deliverViaRemaData(phone, volumeInMB, reference);
        } else {
          result = await deliverViaHubNet(phone, providerConfig.fallbackNetwork, volumeInMB, reference);
        }
        console.log(`✅ Fallback successful via ${providerConfig.fallback}`);
        return result;
      } catch (fallbackError) {
        errors.push(`${providerConfig.fallback}: ${fallbackError.message}`);
      }
    }
  }
  
  throw new Error(`Delivery failed: ${errors.join(" | ")}`);
}

// ─────────────────────────────────────────────
//  WALLET OPERATIONS
// ─────────────────────────────────────────────

async function getWalletBalance(userId) {
  if (!firebaseDb) return 0;
  try {
    const snapshot = await firebaseDb.ref(`wallets/${userId}/balance`).once("value");
    return snapshot.val() || 0;
  } catch (err) {
    console.error(`Failed to get wallet balance: ${err.message}`);
    return 0;
  }
}

async function updateWalletBalance(userId, amount, type, description, reference = null) {
  if (!firebaseDb) {
    console.log(`Mock: ${type} ${amount} to ${userId}`);
    return true;
  }
  
  try {
    const walletRef = firebaseDb.ref(`wallets/${userId}`);
    const balanceSnapshot = await walletRef.child("balance").once("value");
    const currentBalance = balanceSnapshot.val() || 0;
    
    const newBalance = type === "credit" ? currentBalance + amount : currentBalance - amount;
    
    if (type === "debit" && newBalance < 0) {
      throw new Error("Insufficient balance");
    }
    
    await walletRef.child("balance").set(newBalance);
    
    const transaction = {
      id: reference || `tx_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      type,
      amount,
      balanceAfter: newBalance,
      description,
      timestamp: new Date().toISOString(),
    };
    
    await walletRef.child("transactions").push(transaction);
    
    return { success: true, newBalance };
  } catch (err) {
    console.error(`Wallet operation failed: ${err.message}`);
    throw err;
  }
}

// ─────────────────────────────────────────────
//  ORDER MANAGEMENT
// ─────────────────────────────────────────────

async function saveOrder(orderData) {
  if (!firebaseDb) {
    console.log("Mock save order:", orderData);
    return;
  }
  
  try {
    const orderRef = orderData.orderRef || orderData.reference || `ORD_${Date.now()}`;
    await firebaseDb.ref(`partner_orders/${orderRef}`).set({
      ...orderData,
      timestamp: orderData.timestamp || new Date().toISOString(),
    });
    console.log(`✅ Order saved: ${orderRef}`);
  } catch (err) {
    console.error(`Failed to save order: ${err.message}`);
  }
}

async function getOrdersByPartner(partnerId) {
  if (!firebaseDb) return [];
  try {
    const snapshot = await firebaseDb.ref("partner_orders").once("value");
    const allOrders = snapshot.val() || {};
    return Object.values(allOrders).filter(o => o.partnerId === partnerId);
  } catch (err) {
    console.error(`Failed to get orders: ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────
//  MIDDLEWARE
// ─────────────────────────────────────────────

app.use(cors({ origin: "*" }));

// Raw body for Paystack webhook
app.use((req, res, next) => {
  if (req.path === "/paystack/webhook") {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      req.rawBody = Buffer.concat(chunks);
      try {
        req.body = JSON.parse(req.rawBody.toString());
      } catch {
        req.body = {};
      }
      next();
    });
  } else {
    express.json()(req, res, next);
  }
});

// API Key middleware for /deliver endpoint
function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"] || req.body?.apiKey;
  if (!key || key !== DELIVER_SECRET) {
    return res.status(401).json({ status: "error", message: "Invalid API key" });
  }
  next();
}

// Partner authentication from portal
async function authenticatePartner(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) {
    return res.status(401).json({ status: "error", message: "Missing X-API-KEY header" });
  }
  
  if (!firebaseDb) {
    // Mock authentication for testing
    req.partner = { partnerId: "TEST_PARTNER", apiKey, name: "Test Partner" };
    return next();
  }
  
  try {
    const developersSnapshot = await firebaseDb.ref("developers").once("value");
    const developers = developersSnapshot.val() || {};
    
    let foundPartner = null;
    for (const [uid, data] of Object.entries(developers)) {
      if (data.apiKey === apiKey) {
        foundPartner = { ...data, uid };
        break;
      }
    }
    
    if (!foundPartner) {
      return res.status(401).json({ status: "error", message: "Invalid API key" });
    }
    
    req.partner = foundPartner;
    next();
  } catch (err) {
    console.error(`Auth error: ${err.message}`);
    res.status(500).json({ status: "error", message: "Authentication failed" });
  }
}

// ─────────────────────────────────────────────
//  API ROUTES (For Developer Portal)
// ─────────────────────────────────────────────

// Health check
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
      airteltigo: { provider: "HubNetGH", configured: !!HUBNET_API_KEY },
    },
    firebase: !!firebaseDb,
  });
});

// Get available bundles
app.get("/bundles", authenticatePartner, async (req, res) => {
  const network = (req.query.network || "mtn").toLowerCase();
  
  const bundleList = [];
  const prices = BUNDLE_PRICES[network];
  
  if (!prices) {
    return res.status(400).json({ status: "error", message: `Unknown network: ${network}` });
  }
  
  for (const [volumeInMB, costPrice] of Object.entries(prices)) {
    const price = calculatePrice(costPrice, parseInt(volumeInMB), network);
    const volumeInGB = (parseInt(volumeInMB) / 1024).toFixed(2);
    bundleList.push({
      network,
      name: volumeInGB.endsWith(".00") ? `${Math.round(parseFloat(volumeInGB))}GB` : `${volumeInGB}GB`,
      volume: volumeInGB.endsWith(".00") ? `${Math.round(parseFloat(volumeInGB))}.00GB` : `${volumeInGB}GB`,
      volumeInMB: parseInt(volumeInMB),
      price: price,
    });
  }
  
  res.json({ status: "success", data: bundleList, count: bundleList.length });
});

// Get cost price (for calculation before purchase)
app.post("/get-cost-price", authenticatePartner, async (req, res) => {
  const { networkType, volumeInMB } = req.body;
  
  if (!networkType || !volumeInMB) {
    return res.status(400).json({ status: "error", message: "Missing networkType or volumeInMB" });
  }
  
  const network = networkType.toLowerCase();
  const prices = BUNDLE_PRICES[network];
  
  if (!prices) {
    return res.status(400).json({ status: "error", message: `Unknown network: ${network}` });
  }
  
  const costPrice = prices[volumeInMB];
  if (!costPrice) {
    return res.status(400).json({ status: "error", message: `No bundle found for ${volumeInMB}MB on ${network}` });
  }
  
  const apiPrice = calculatePrice(costPrice, volumeInMB, network);
  
  res.json({
    status: "success",
    volume: `${volumeInMB}MB`,
    network: network,
    api_price: apiPrice.toFixed(2),
    currency: "GHS",
    cost_price: costPrice.toFixed(2),
  });
});

// Purchase data
app.post("/buy-data", authenticatePartner, async (req, res) => {
  const { ref, phone, volumeInMB, networkType } = req.body;
  
  if (!phone || !volumeInMB || !networkType) {
    return res.status(400).json({ 
      status: "error", 
      message: "Missing required fields: phone, volumeInMB, networkType" 
    });
  }
  
  const partner = req.partner;
  const network = networkType.toLowerCase();
  const prices = BUNDLE_PRICES[network];
  
  if (!prices) {
    return res.status(400).json({ status: "error", message: `Unknown network: ${network}` });
  }
  
  const costPrice = prices[volumeInMB];
  if (!costPrice) {
    return res.status(400).json({ status: "error", message: `No bundle found for ${volumeInMB}MB on ${network}` });
  }
  
  const amount = calculatePrice(costPrice, volumeInMB, network);
  const orderRef = ref || `ORD_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  
  // Check wallet balance
  const currentBalance = await getWalletBalance(partner.partnerId);
  
  if (currentBalance < amount) {
    return res.status(400).json({
      status: "error",
      message: "Insufficient wallet balance",
      data: { balance: currentBalance, required: amount }
    });
  }
  
  // Deduct from wallet
  try {
    await updateWalletBalance(partner.partnerId, amount, "debit", `Data purchase: ${volumeInMB}MB ${network} to ${phone}`, orderRef);
  } catch (err) {
    return res.status(400).json({ status: "error", message: err.message });
  }
  
  // Attempt delivery
  try {
    const deliveryResult = await deliverData(phone, network, volumeInMB, orderRef);
    
    // Save order
    await saveOrder({
      orderRef,
      partnerId: partner.partnerId,
      partnerName: partner.name,
      phone,
      network,
      volumeInMB,
      amount,
      status: "completed",
      provider: deliveryResult.provider,
      providerRef: deliveryResult.reference,
      timestamp: new Date().toISOString(),
    });
    
    const newBalance = await getWalletBalance(partner.partnerId);
    
    res.json({
      status: "success",
      message: "Order placed successfully",
      data: {
        reference: deliveryResult.reference,
        client_reference: orderRef,
        status: "completed",
        amount: amount,
        balance: newBalance.toFixed(2),
        provider: deliveryResult.provider,
      }
    });
  } catch (deliveryError) {
    // Refund wallet on delivery failure
    await updateWalletBalance(partner.partnerId, amount, "credit", `Refund: Failed order ${orderRef}`, `${orderRef}_refund`);
    
    await saveOrder({
      orderRef,
      partnerId: partner.partnerId,
      partnerName: partner.name,
      phone,
      network,
      volumeInMB,
      amount,
      status: "failed",
      error: deliveryError.message,
      timestamp: new Date().toISOString(),
    });
    
    res.json({
      status: "error",
      message: `Order failed: ${deliveryError.message}. Your wallet has been refunded.`,
      data: { reference: orderRef, refunded: true }
    });
  }
});

// Get wallet balance
app.get("/wallet-balance", authenticatePartner, async (req, res) => {
  const balance = await getWalletBalance(req.partner.partnerId);
  
  res.json({
    status: "success",
    message: "Wallet balance retrieved successfully",
    data: {
      balance: balance.toFixed(2),
      currency: "GHS",
      wallet_id: `wallet_${req.partner.partnerId}`,
      user_id: req.partner.uid || req.partner.partnerId,
    }
  });
});

// Get orders (with filtering)
app.get("/orders", authenticatePartner, async (req, res) => {
  const { ref, status, network, phone, start_date, end_date, page = 1, per_page = 15 } = req.query;
  
  let orders = await getOrdersByPartner(req.partner.partnerId);
  
  // Apply filters
  if (ref) {
    orders = orders.filter(o => o.orderRef === ref || o.orderRef?.includes(ref));
  }
  if (status) {
    orders = orders.filter(o => o.status === status);
  }
  if (network) {
    orders = orders.filter(o => o.network === network.toLowerCase());
  }
  if (phone) {
    orders = orders.filter(o => o.phone?.includes(phone));
  }
  if (start_date) {
    orders = orders.filter(o => new Date(o.timestamp) >= new Date(start_date));
  }
  if (end_date) {
    orders = orders.filter(o => new Date(o.timestamp) <= new Date(end_date));
  }
  
  // Sort by date descending
  orders.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  
  // Pagination
  const start = (page - 1) * per_page;
  const paginatedOrders = orders.slice(start, start + per_page);
  
  if (ref && paginatedOrders.length === 1) {
    // Single order response
    const order = paginatedOrders[0];
    return res.json({
      status: "success",
      data: {
        id: order.orderRef,
        reference: order.providerRef,
        client_reference: order.orderRef,
        phone: order.phone,
        network: order.network,
        volume: `${order.volumeInMB}MB`,
        amount: order.amount,
        status: order.status,
        created_at: order.timestamp,
      }
    });
  }
  
  res.json({
    status: "success",
    data: {
      orders: paginatedOrders.map(o => ({
        id: o.orderRef,
        reference: o.providerRef,
        client_reference: o.orderRef,
        phone: o.phone,
        network: o.network,
        volume: `${o.volumeInMB}MB`,
        amount: o.amount,
        status: o.status,
        created_at: o.timestamp,
      })),
      pagination: {
        current_page: parseInt(page),
        total_pages: Math.ceil(orders.length / per_page),
        total_orders: orders.length,
        per_page: parseInt(per_page),
      }
    }
  });
});

// Order status by reference (alternative endpoint)
app.get("/order-status/:reference", authenticatePartner, async (req, res) => {
  const { reference } = req.params;
  
  const orders = await getOrdersByPartner(req.partner.partnerId);
  const order = orders.find(o => o.orderRef === reference || o.providerRef === reference);
  
  if (!order) {
    return res.status(404).json({ status: "error", message: "Order not found" });
  }
  
  res.json({
    status: "success",
    data: {
      reference: order.providerRef,
      client_reference: order.orderRef,
      status: order.status,
      amount: order.amount,
      phone: order.phone,
      network: order.network,
      volume: `${order.volumeInMB}MB`,
      created_at: order.timestamp,
    }
  });
});

// ─────────────────────────────────────────────
//  PAYSTACK WEBHOOK (for wallet funding)
// ─────────────────────────────────────────────

function verifyPaystackSignature(rawBody, signature) {
  if (!PAYSTACK_SECRET || !rawBody || !signature) return false;
  const hash = crypto.createHmac("sha512", PAYSTACK_SECRET).update(rawBody).digest("hex");
  return hash === signature;
}

app.post("/paystack/webhook", async (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  
  if (!verifyPaystackSignature(req.rawBody, signature)) {
    console.warn("⚠️ Paystack webhook: invalid signature");
    return res.status(401).json({ error: "Invalid signature" });
  }
  
  const event = req.body;
  if (event.event !== "charge.success") {
    return res.status(200).json({ received: true });
  }
  
  const { data } = event;
  const meta = data.metadata || {};
  const partnerId = meta.partner_id;
  const amount = data.amount ? data.amount / 100 : 0;
  const reference = data.reference;
  
  if (!partnerId) {
    console.warn("Webhook: missing partner_id in metadata");
    return res.status(200).json({ received: true });
  }
  
  // Prevent duplicate processing
  if (processedRefs.has(reference)) {
    console.log(`Duplicate webhook ignored: ${reference}`);
    return res.status(200).json({ received: true });
  }
  processedRefs.set(reference, Date.now());
  
  console.log(`💰 Webhook: crediting ${amount} to ${partnerId}`);
  
  try {
    await updateWalletBalance(partnerId, amount, "credit", `Paystack deposit: ${reference}`, reference);
    console.log(`✅ Wallet credited: ${partnerId} +${amount}`);
  } catch (err) {
    console.error(`Failed to credit wallet: ${err.message}`);
  }
  
  res.status(200).json({ received: true });
});

// ─────────────────────────────────────────────
//  INTERNAL DELIVER ENDPOINT (for admin use)
// ─────────────────────────────────────────────

app.post("/deliver", requireApiKey, async (req, res) => {
  const { phone, networkType, volumeInMB, ref } = req.body;
  
  if (!phone || !networkType || !volumeInMB) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  
  try {
    const result = await deliverData(phone, networkType.toLowerCase(), volumeInMB, ref);
    res.json({ status: "success", provider: result.provider, reference: result.reference });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// ─────────────────────────────────────────────
//  404 HANDLER
// ─────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ status: "error", message: `Route not found: ${req.method} ${req.url}` });
});

// ─────────────────────────────────────────────
//  ERROR HANDLER
// ─────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error(`Error: ${err.message}`);
  res.status(err.statusCode || 500).json({
    status: "error",
    message: err.message || "Internal server error",
  });
});

// ─────────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────────

// Clean up old processed refs
setInterval(() => {
  const now = Date.now();
  for (const [ref, timestamp] of processedRefs.entries()) {
    if (now - timestamp > REF_TTL) {
      processedRefs.delete(ref);
    }
  }
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║   🚀  DataFlow GH Backend — Developer Portal Ready           ║
║   📡  Port: ${String(PORT).padEnd(37)}║
╠══════════════════════════════════════════════════════════════╣
║  Endpoints for Developer Portal:                            ║
║    GET  /bundles?network=mtn                                ║
║    POST /get-cost-price                                     ║
║    POST /buy-data                                           ║
║    GET  /wallet-balance                                     ║
║    GET  /orders?ref=&status=&network=                       ║
║    GET  /order-status/:reference                            ║
╠══════════════════════════════════════════════════════════════╣
║  Providers:                                                 ║
║    MTN        → RemaData ${REMADATA_API_KEY ? "✅" : "❌"}                    ║
║    Telecel    → HubNetGH ${HUBNET_API_KEY ? "✅" : "❌"}                    ║
║    AirtelTigo → HubNetGH ${HUBNET_API_KEY ? "✅" : "❌"}                    ║
║    Paystack Webhook ${PAYSTACK_SECRET ? "✅" : "❌"}                          ║
║    Firebase   ${firebaseDb ? "✅" : "❌"}                                    ║
╚══════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
