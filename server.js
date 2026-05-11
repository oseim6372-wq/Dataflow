// ============================================================
//  DATEFLOW GH — UNIFIED BACKEND (PRODUCTION READY)
//  MTN/Telecel/AT → RemaData API (local format 0XXXXXXXXX + volume mapping)
//  Features: Retry logic, queue, memory protection
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

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || "";
const DELIVER_SECRET = process.env.DELIVER_SECRET || "";

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Processed references with memory protection
const processedRefs = new Map();
const REF_TTL = 24 * 60 * 60 * 1000;
const MAX_REF_SIZE = 10000;

// Firebase failed saves queue
const failedSaveQueue = [];
let isProcessingQueue = false;

// Network providers - all via RemaData
const NETWORK_PROVIDER = {
  mtn: { name: "RemaData", primary: true },
  telecel: { name: "RemaData", primary: true },
  airteltigo: { name: "RemaData", primary: true },
};

// Promise cache for profit settings
let profitSettingsPromise = null;
let profitSettingsCache = null;
let lastCacheUpdate = 0;
const CACHE_TTL = 5 * 60 * 1000;

// ─────────────────────────────────────────────
//  VOLUME MAPPING FOR REMADATA
// ─────────────────────────────────────────────

const REMA_MB_MAP = {
  1024: 1000, 2048: 2000, 3072: 3000, 4096: 4000,
  5120: 5000, 6144: 6000, 7168: 7000, 8192: 8000,
  9216: 9000, 10240: 10000, 11264: 11000, 12288: 12000,
  13312: 13000, 14336: 14000, 15360: 15000, 16384: 16000,
  17408: 17000, 18432: 18000, 19456: 19000, 20480: 20000,
  25600: 25000, 30720: 30000, 40960: 40000, 51200: 50000,
  102400: 100000
};

// ─────────────────────────────────────────────
//  STRUCTURED ERROR CLASS
// ─────────────────────────────────────────────

class AppError extends Error {
  constructor(message, statusCode = 500, category = "INTERNAL", details = null) {
    super(message);
    this.statusCode = statusCode;
    this.category = category;
    this.details = details;
    this.isOperational = true;
  }
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ─────────────────────────────────────────────
//  CUSTOMER-FRIENDLY ERROR MESSAGES
// ─────────────────────────────────────────────

function getCustomerFriendlyMessage(network, technicalDetails) {
  const messages = {
    mtn: "MTN data delivery is temporarily unavailable. Please try again in a few minutes. If the issue persists, contact support.",
    telecel: "Telecel data delivery is temporarily unavailable. Please try again in a few minutes. If the issue persists, contact support.",
    airteltigo: "AirtelTigo data delivery is temporarily unavailable. Please try again in a few minutes. If the issue persists, contact support."
  };
  
  const baseMessage = messages[network] || "Data delivery is temporarily unavailable. Please try again later.";
  
  // Log technical details for admin only
  console.error(`📝 Technical details for ${network}: ${technicalDetails}`);
  
  return baseMessage;
}

// ─────────────────────────────────────────────
//  RETRY LOGIC WITH EXPONENTIAL BACKOFF
// ─────────────────────────────────────────────

async function fetchWithRetry(apiCall, retries = MAX_RETRIES, delay = RETRY_DELAY_MS) {
  for (let i = 0; i < retries; i++) {
    try {
      return await apiCall();
    } catch (err) {
      const isLastAttempt = i === retries - 1;
      const isProviderError = err.category === "PROVIDER";
      
      if (isLastAttempt || !isProviderError) throw err;
      
      const waitTime = delay * Math.pow(2, i);
      console.log(`🔄 Retry ${i + 1}/${retries} after ${waitTime}ms: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
}

// ─────────────────────────────────────────────
//  STARTUP VALIDATION
// ─────────────────────────────────────────────

function validateEnv() {
  const checks = [
    ["REMADATA_API_KEY", REMADATA_API_KEY, "All deliveries will fail"],
    ["PAYSTACK_SECRET_KEY", PAYSTACK_SECRET, "Webhook signature verification disabled"],
    ["DELIVER_SECRET", DELIVER_SECRET, "/deliver endpoint unprotected"],
    ["FIREBASE_DATABASE_URL", process.env.FIREBASE_DATABASE_URL, "Orders will not be saved"],
    ["FIREBASE_SERVICE_ACCOUNT_JSON", process.env.FIREBASE_SERVICE_ACCOUNT_JSON, "Firebase disabled"],
  ];

  const missing = checks.filter(([, val]) => !val);
  if (missing.length) {
    console.warn("⚠️  Missing environment variables:");
    missing.forEach(([key, , impact]) =>
      console.warn(`   • ${key.padEnd(36)} → ${impact}`)
    );
  }
}

// ─────────────────────────────────────────────
//  FIREBASE ADMIN INIT
// ─────────────────────────────────────────────
let db = null;

try {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    : null;

  if (serviceAccount && process.env.FIREBASE_DATABASE_URL) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
    db = admin.database();
    console.log("✅ Firebase Admin initialised");
    
    // Start queue processor
    setInterval(processFailedSaveQueue, 60000);
  } else {
    if (!serviceAccount) console.warn("⚠️  FIREBASE_SERVICE_ACCOUNT_JSON not set — Firebase disabled");
    if (!process.env.FIREBASE_DATABASE_URL) console.warn("⚠️  FIREBASE_DATABASE_URL not set — Firebase disabled");
  }
} catch (err) {
  console.error(`❌ Firebase init failed: ${err.message}`);
}

// ─────────────────────────────────────────────
//  FIREBASE QUEUE PROCESSOR
// ─────────────────────────────────────────────

async function saveOrderWithRetry(ref, payload, retries = 5) {
  if (!db) {
    failedSaveQueue.push({ ref, payload, timestamp: Date.now() });
    console.warn(`⚠️ Firebase unavailable, queued order "${ref}" (queue size: ${failedSaveQueue.length})`);
    return;
  }
  
  for (let i = 0; i < retries; i++) {
    try {
      await db.ref(`transactions/${ref}`).set(payload);
      console.log(`✅ Order "${ref}" saved to Firebase`);
      return;
    } catch (err) {
      if (i === retries - 1) {
        failedSaveQueue.push({ ref, payload, timestamp: Date.now() });
        console.error(`❌ Failed to save order "${ref}" after ${retries} retries, queued`);
      } else {
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
      }
    }
  }
}

async function saveFailedOrderWithRetry(ref, payload, errMessage) {
  const failedPayload = {
    ...payload,
    status: "failed",
    error: errMessage,
    timestamp: new Date().toISOString(),
  };
  await saveOrderWithRetry(ref, failedPayload);
}

async function processFailedSaveQueue() {
  if (isProcessingQueue || !db || failedSaveQueue.length === 0) return;
  
  isProcessingQueue = true;
  console.log(`🔄 Processing ${failedSaveQueue.length} queued Firebase saves...`);
  
  const queueCopy = [...failedSaveQueue];
  failedSaveQueue.length = 0;
  
  for (const item of queueCopy) {
    try {
      await db.ref(`transactions/${item.ref}`).set(item.payload);
      console.log(`✅ Queued order "${item.ref}" saved after recovery`);
    } catch (err) {
      console.error(`❌ Still failed to save "${item.ref}" after recovery, re-queuing`);
      failedSaveQueue.push(item);
    }
  }
  
  isProcessingQueue = false;
  
  if (failedSaveQueue.length > 0) {
    setTimeout(processFailedSaveQueue, 30000);
  }
}

// ─────────────────────────────────────────────
//  PROCESSED REFS CLEANUP (Memory Protection)
// ─────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  let deletedCount = 0;
  
  for (const [ref, timestamp] of processedRefs.entries()) {
    if (now - timestamp > REF_TTL) {
      processedRefs.delete(ref);
      deletedCount++;
    }
  }
  
  // Force cleanup if size exceeds limit
  if (processedRefs.size > MAX_REF_SIZE) {
    const excess = processedRefs.size - MAX_REF_SIZE;
    const iterator = processedRefs.keys();
    for (let i = 0; i < excess; i++) {
      processedRefs.delete(iterator.next().value);
    }
    console.warn(`⚠️ Force-cleaned ${excess} old refs, size now ${processedRefs.size}`);
  }
  
  if (deletedCount > 0) {
    console.log(`🧹 Cleaned ${deletedCount} expired refs, size: ${processedRefs.size}`);
  }
}, 60 * 60 * 1000);

// ─────────────────────────────────────────────
//  MIDDLEWARE
// ─────────────────────────────────────────────

app.use(cors({ origin: "*" }));

// Raw body capture for Paystack webhook
app.use((req, res, next) => {
  if (req.path === "/paystack/webhook") {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      req.rawBody = Buffer.concat(chunks);
      try {
        req.body = JSON.parse(req.rawBody.toString());
      } catch {
        req.body = {};
      }
      next();
    });
    req.on("error", next);
  } else {
    express.json()(req, res, next);
  }
});

// Request timeout
app.use((req, res, next) => {
  req.setTimeout(30000);
  res.setTimeout(30000);
  next();
});

// Request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const icon = res.statusCode < 400 ? "✓" : res.statusCode < 500 ? "⚠" : "✗";
    console.log(`${icon} ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// ─────────────────────────────────────────────
//  AUTH MIDDLEWARE
// ─────────────────────────────────────────────

function requireApiKey(req, res, next) {
  if (!DELIVER_SECRET) {
    return next(new AppError("DELIVER_SECRET not configured", 500, "INTERNAL"));
  }
  const key = req.headers["x-api-key"] || req.body?.apiKey;
  if (!key || key !== DELIVER_SECRET) {
    console.warn(`🚫 Unauthorized /deliver attempt — IP: ${req.ip}`);
    return next(new AppError("Invalid or missing API key", 401, "AUTH"));
  }
  next();
}

// ─────────────────────────────────────────────
//  PHONE FORMATTING HELPERS
// ─────────────────────────────────────────────

function formatPhoneLocal(phone) {
  let p = String(phone).replace(/[\s\-]/g, "");
  
  if (p.startsWith("233")) p = "0" + p.slice(3);
  if (p.startsWith("+233")) p = "0" + p.slice(4);
  if (!p.startsWith("0")) p = "0" + p;
  
  if (!/^0\d{9}$/.test(p)) {
    throw new AppError(
      `Phone must be 10 digits starting with 0 (e.g., 0551234567), got: "${phone}"`,
      400, "VALIDATION"
    );
  }
  return p;
}

function resolveVolume(volumeInMB) {
  const mb = Number(volumeInMB);
  return mb >= 1024 ? String(Math.round(mb / 1024)) : String(mb);
}

// ─────────────────────────────────────────────
//  PROFIT SETTINGS
// ─────────────────────────────────────────────

async function getProfitSettings() {
  if (profitSettingsCache && (Date.now() - lastCacheUpdate) < CACHE_TTL) {
    return profitSettingsCache;
  }

  if (profitSettingsPromise) return profitSettingsPromise;

  profitSettingsPromise = (async () => {
    if (!db) {
      const defaultSettings = { mode: "flat", flatAmount: 0 };
      profitSettingsCache = defaultSettings;
      lastCacheUpdate = Date.now();
      return defaultSettings;
    }
    try {
      const snap = await db.ref("system/profitSettings").once("value");
      profitSettingsCache = snap.val() || { mode: "flat", flatAmount: 0 };
      lastCacheUpdate = Date.now();
      return profitSettingsCache;
    } catch (err) {
      console.warn(`⚠️ Could not load profit settings: ${err.message}`);
      return { mode: "flat", flatAmount: 0 };
    } finally {
      profitSettingsPromise = null;
    }
  })();

  return profitSettingsPromise;
}

function applyProfit(costPrice, volumeInMB, network, settings) {
  if (!settings) return costPrice;
  const { mode, flatAmount = 0, percentAmount = 0, perBundle = {} } = settings;
  
  if (mode === "percent") {
    const pct = parseFloat(percentAmount) || 0;
    return Math.ceil(costPrice * (1 + pct / 100) * 20) / 20;
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
//  DELIVERY FUNCTIONS WITH RETRY
// ─────────────────────────────────────────────

async function deliverViaRemaData(phone, networkType, volumeInMB, reference) {
  if (!REMADATA_API_KEY) {
    throw new AppError(
      "RemaData API not configured. Please set REMADATA_API_KEY environment variable.",
      503, "CONFIGURATION"
    );
  }
  
  const orderRef = reference || `DF-${Date.now()}`;
  const localPhone = formatPhoneLocal(phone);
  const remaMB = REMA_MB_MAP[Number(volumeInMB)] || Number(volumeInMB);
  
  // Map network types to what RemaData expects
  let remaNetworkType = "mtn";
  if (networkType === "telecel") remaNetworkType = "telecel";
  if (networkType === "airteltigo") remaNetworkType = "airteltigo";

  const payload = {
    ref: orderRef,
    phone: localPhone,
    volumeInMB: remaMB,
    networkType: remaNetworkType,
  };

  console.log(`📦 [RemaData] ${volumeInMB}MB → ${remaMB}MB ${networkType} → ${localPhone} | Ref: ${orderRef}`);

  const response = await fetchWithRetry(async () => {
    return await axios.post(`${REMADATA_API_URL}/buy-data`, payload, {
      headers: { "X-API-KEY": REMADATA_API_KEY, "Content-Type": "application/json" },
      timeout: 30000,
    });
  });

  if (response.data?.status !== "success") {
    const providerMsg = response.data?.message || response.data?.error || "Unknown provider error";
    throw new AppError(
      `RemaData delivery rejected: ${providerMsg}`,
      502, "PROVIDER",
      { providerResponse: response.data }
    );
  }

  const remaReference = response.data?.data?.reference || response.data?.reference || orderRef;
  console.log(`✅ [RemaData] Delivered | Provider ref: ${remaReference}`);

  return { success: true, reference: remaReference, data: response.data, provider: "RemaData" };
}

// ─────────────────────────────────────────────
//  DELIVERY ORCHESTRATOR
// ─────────────────────────────────────────────

async function deliverData(phone, networkType, volumeInMB, reference = null) {
  const net = networkType?.toLowerCase();
  const providerConfig = NETWORK_PROVIDER[net];
  
  if (!providerConfig) {
    throw new AppError(
      `Unsupported network: "${networkType}". Valid: ${Object.keys(NETWORK_PROVIDER).join(", ")}`,
      400, "VALIDATION"
    );
  }
  
  try {
    console.log(`📡 Delivering ${net} via RemaData`);
    return await deliverViaRemaData(phone, net, volumeInMB, reference);
  } catch (error) {
    // Throw customer-friendly message
    const customerMessage = getCustomerFriendlyMessage(net, error.message);
    throw new AppError(
      customerMessage,
      503,
      "PROVIDER",
      { network: net, provider: "RemaData", error: error.message }
    );
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
    console.warn("⚠️ Paystack webhook: invalid signature");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const event = req.body;
  if (!event?.event) {
    console.error("❌ Webhook: empty or malformed body");
    return res.status(400).json({ error: "Invalid body" });
  }

  console.log(`📨 Webhook: ${event.event}`);
  res.status(200).json({ received: true });

  if (event.event !== "charge.success") return;

  const { data } = event;
  const meta = data.metadata || {};
  const phone = meta.phone || meta.customer_phone;
  const networkType = meta.networkType || meta.network_type;
  const volumeInMB = meta.volumeInMB || meta.volume_in_mb;
  const ref = data.reference;
  const amount = data.amount ? data.amount / 100 : 0;

  const baseOrderData = { ref, phone, networkType, volumeInMB, amount, source: "paystack_webhook" };

  if (!phone || !volumeInMB || !networkType) {
    console.warn(`⚠️ Webhook: missing metadata — phone=${phone}, volume=${volumeInMB}, network=${networkType}`);
    return;
  }

  if (processedRefs.has(ref)) {
    console.warn(`⚠️ Webhook: duplicate ref ignored — ${ref}`);
    return;
  }
  processedRefs.set(ref, Date.now());

  console.log(`💳 Webhook auto-delivery: ${networkType} ${volumeInMB}MB → ${phone}`);

  try {
    const result = await deliverData(phone, networkType, Number(volumeInMB), ref);

    await saveOrderWithRetry(ref, {
      ...baseOrderData,
      status: "completed",
      provider: result.provider,
      providerRef: result.reference,
      timestamp: new Date().toISOString(),
    });

    console.log(`✅ Webhook delivery complete | Provider: ${result.provider}`);
  } catch (err) {
    console.error(`❌ Webhook delivery failed: ${err.message}`);
    await saveFailedOrderWithRetry(ref, baseOrderData, err.message);
    processedRefs.delete(ref);
  }
});

// ─────────────────────────────────────────────
//  API ROUTES
// ─────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({ status: "online", service: "DataFlow GH", timestamp: new Date().toISOString() });
});

app.get("/health", (req, res) => {
  const criticalIssues = [];
  if (!REMADATA_API_KEY) criticalIssues.push("All deliveries will fail");
  if (!DELIVER_SECRET) criticalIssues.push("/deliver endpoint unprotected");
  
  res.json({
    status: criticalIssues.length > 0 ? "DEGRADED" : "OK",
    service: "DataFlow GH",
    timestamp: new Date().toISOString(),
    criticalIssues,
    providers: {
      mtn: { provider: "RemaData", configured: !!REMADATA_API_KEY, operational: !!REMADATA_API_KEY },
      telecel: { provider: "RemaData", configured: !!REMADATA_API_KEY, operational: !!REMADATA_API_KEY },
      airteltigo: { provider: "RemaData", configured: !!REMADATA_API_KEY, operational: !!REMADATA_API_KEY },
    },
    firebase: !!db,
    firebaseQueueSize: failedSaveQueue.length,
    webhook: !!PAYSTACK_SECRET,
    memory: { processedRefsSize: processedRefs.size },
  });
});

app.get("/api/balance", asyncHandler(async (req, res) => {
  if (!REMADATA_API_KEY) {
    throw new AppError("RemaData API not configured", 503, "CONFIGURATION");
  }
  try {
    const response = await axios.get(`${REMADATA_API_URL}/wallet-balance`, {
      headers: { "X-API-KEY": REMADATA_API_KEY },
      timeout: 10000,
    });
    res.json(response.data);
  } catch (err) {
    throw new AppError(`Failed to fetch balance: ${err.message}`, 502, "PROVIDER");
  }
}));

app.get("/api/bundles", asyncHandler(async (req, res) => {
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
      { volumeInMB: 102400, volume: "100GB", price: 370.00, name: "100GB", network: "mtn" },
    ],
    telecel: [
      { volumeInMB: 10240, volume: "10GB", price: 38.00, name: "10GB", network: "telecel" },
      { volumeInMB: 15360, volume: "15GB", price: 55.00, name: "15GB", network: "telecel" },
      { volumeInMB: 20480, volume: "20GB", price: 74.00, name: "20GB", network: "telecel" },
      { volumeInMB: 25600, volume: "25GB", price: 92.00, name: "25GB", network: "telecel" },
      { volumeInMB: 30720, volume: "30GB", price: 109.00, name: "30GB", network: "telecel" },
      { volumeInMB: 40960, volume: "40GB", price: 143.00, name: "40GB", network: "telecel" },
      { volumeInMB: 51200, volume: "50GB", price: 177.00, name: "50GB", network: "telecel" },
      { volumeInMB: 102400, volume: "100GB", price: 354.00, name: "100GB", network: "telecel" },
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
      { volumeInMB: 25600, volume: "25GB", price: 98.00, name: "25GB", network: "airteltigo" },
    ],
  };

  if (!bundleData[network]) {
    throw new AppError(`Unknown network "${network}"`, 400, "VALIDATION");
  }

  let bundles = bundleData[network];

  const settings = await getProfitSettings();
  bundles = bundles.map((b) => ({
    ...b,
    costPrice: b.price,
    price: applyProfit(b.price, b.volumeInMB, network, settings),
  }));

  res.json({ status: "success", data: bundles, count: bundles.length });
}));

app.post("/deliver", requireApiKey, asyncHandler(async (req, res) => {
  const { phone, networkType, volumeInMB, ref } = req.body;

  if (!phone || !networkType || !volumeInMB) {
    throw new AppError("Missing required fields: phone, networkType, volumeInMB", 400, "VALIDATION");
  }

  const validNetworks = Object.keys(NETWORK_PROVIDER);
  if (!validNetworks.includes(networkType.toLowerCase())) {
    throw new AppError(`Invalid network "${networkType}"`, 400, "VALIDATION");
  }

  const volumeNum = Number(volumeInMB);
  if (isNaN(volumeNum) || volumeNum <= 0) {
    throw new AppError("volumeInMB must be a positive number", 400, "VALIDATION");
  }

  const result = await deliverData(phone, networkType.toLowerCase(), volumeNum, ref);

  console.log(`✅ Manual delivery complete | Provider: ${result.provider}`);
  res.json({
    status: "success",
    provider: result.provider,
    reference: result.reference,
    data: result.data,
  });
}));

// ─────────────────────────────────────────────
//  ORDER STATUS LOOKUP
// ─────────────────────────────────────────────

app.get("/api/order-status/:reference", asyncHandler(async (req, res) => {
  const { reference } = req.params;

  if (!reference) {
    throw new AppError("Reference parameter is required", 400, "VALIDATION");
  }

  // Check RemaData for status
  if (!REMADATA_API_KEY) {
    throw new AppError("RemaData API not configured", 503, "CONFIGURATION");
  }

  console.log(`🔍 Checking RemaData status for ref: ${reference}`);
  
  try {
    const response = await axios.get(
      `${REMADATA_API_URL}/order-status/${encodeURIComponent(reference)}`,
      { headers: { "X-API-KEY": REMADATA_API_KEY }, timeout: 10000 }
    );
    
    if (response.data?.status === "success") {
      return res.json({ 
        status: "success", 
        provider: "RemaData", 
        reference: reference,
        data: response.data.data 
      });
    } else {
      throw new AppError("Order not found", 404, "NOT_FOUND");
    }
  } catch (err) {
    if (err.response?.status === 404 || err.statusCode === 404) {
      throw new AppError("Order not found", 404, "NOT_FOUND");
    }
    throw new AppError(`Failed to check order status: ${err.message}`, 502, "PROVIDER");
  }
}));

app.get("/api/profit-settings", asyncHandler(async (req, res) => {
  const settings = await getProfitSettings();
  res.json({ status: "success", settings });
}));

app.post("/api/profit-settings", asyncHandler(async (req, res) => {
  const { mode, flatAmount, percentAmount, perBundle } = req.body;
  const validModes = ["flat", "percent", "perBundle"];

  if (!validModes.includes(mode)) {
    throw new AppError(`Invalid mode "${mode}"`, 400, "VALIDATION");
  }

  const settings = {
    mode,
    flatAmount: parseFloat(flatAmount) || 0,
    percentAmount: parseFloat(percentAmount) || 0,
    perBundle: perBundle || {},
    updatedAt: new Date().toISOString(),
  };

  if (db) {
    try {
      await db.ref("system/profitSettings").set(settings);
    } catch (err) {
      throw new AppError(`Failed to save settings: ${err.message}`, 500, "FIREBASE");
    }
  }

  profitSettingsCache = settings;
  lastCacheUpdate = Date.now();
  profitSettingsPromise = null;

  res.json({ status: "success", settings });
}));

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
  const isOperational = err.isOperational === true;
  const statusCode = err.statusCode || 500;
  const category = err.category || "INTERNAL";

  if (isOperational) {
    console.warn(`⚠️ [${category}] ${err.message}`);
  } else {
    console.error(`💥 [UNHANDLED] ${err.message}\n${err.stack}`);
  }

  const body = {
    status: "error",
    category,
    message: isOperational ? err.message : "Internal server error",
  };

  if (err.details && process.env.NODE_ENV !== "production") {
    body.details = err.details;
  }

  res.status(statusCode).json(body);
});

// ─────────────────────────────────────────────
//  GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────

process.on("SIGTERM", async () => {
  console.log("🛑 SIGTERM received, starting graceful shutdown...");
  
  if (failedSaveQueue.length > 0) {
    console.log(`📦 Processing ${failedSaveQueue.length} queued saves before shutdown...`);
    await processFailedSaveQueue();
  }
  
  console.log("✅ Graceful shutdown complete");
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("🛑 SIGINT received, shutting down...");
  process.exit(0);
});

// ─────────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────────

validateEnv();

app.listen(PORT, () => {
  const col = (label, ok) => `  ${label.padEnd(28)} ${ok ? "✅" : "❌"}`;
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║   🚀  DataFlow GH Backend — Production Ready                 ║
║   📡  Port: ${String(PORT).padEnd(37)}║
╠══════════════════════════════════════════════════════════════╣
${col("║  MTN → RemaData", !!REMADATA_API_KEY)}        ║
${col("║  Telecel → RemaData", !!REMADATA_API_KEY)}        ║
${col("║  AirtelTigo → RemaData", !!REMADATA_API_KEY)}        ║
${col("║  Paystack Webhook", !!PAYSTACK_SECRET)}        ║
${col("║  /deliver Auth", !!DELIVER_SECRET)}        ║
${col("║  Firebase", !!db)}        ║
╠══════════════════════════════════════════════════════════════╣
║  Features:                                                  ║
║  • Retry logic (${MAX_RETRIES}x exponential backoff)                   ║
║  • All networks via RemaData                               ║
║  • Memory protection (${MAX_REF_SIZE} max refs)                        ║
║  • Firebase queue (${failedSaveQueue.length} pending)                    ║
║  • Customer-friendly error messages                        ║
╚══════════════════════════════════════════════════════════════╝`);
});

// Keep-alive for Render free tier
if (process.env.NODE_ENV === "production") {
  setInterval(async () => {
    try {
      await axios.get(`http://localhost:${PORT}/health`, { timeout: 10000 });
    } catch (err) {
      console.error(`⚠️ Keep-alive failed: ${err.message}`);
    }
  }, 4 * 60 * 1000);
}

module.exports = app;
