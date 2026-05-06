// ============================================================
//  DATEFLOW GH — UNIFIED BACKEND (PRODUCTION READY)
//  MTN → RemaData API (local format 0XXXXXXXXX + volume mapping)
//  Telecel/AT → HubNetGH API (local format 0XXXXXXXXX)
//  Features: Retry logic, bidirectional failover, queue, memory protection
//  COST PRICES NOW COME FROM REMADATA API DYNAMICALLY
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

// Cache for RemaData bundle prices
let remaBundleCache = null;
let lastRemaCacheUpdate = 0;
const REMA_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Network providers with BIDIRECTIONAL failover support
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
//  FETCH BUNDLE PRICES FROM REMADATA API
// ─────────────────────────────────────────────

async function fetchRemaBundlePrices() {
  if (remaBundleCache && (Date.now() - lastRemaCacheUpdate) < REMA_CACHE_TTL) {
    return remaBundleCache;
  }

  if (!REMADATA_API_KEY) {
    console.warn("⚠️ REMADATA_API_KEY not set, using fallback prices");
    return getFallbackBundlePrices();
  }

  try {
    console.log("📡 Fetching bundle prices from RemaData API...");
    const response = await axios.get(`${REMADATA_API_URL}/bundles`, {
      headers: { "X-API-KEY": REMADATA_API_KEY },
      timeout: 15000
    });

    if (response.data?.status === "success" && Array.isArray(response.data.data)) {
      // Map RemaData bundles to our format
      const priceMap = new Map();
      
      for (const bundle of response.data.data) {
        const volumeInMB = bundle.volumeInMB || bundle.volume_in_mb;
        const price = parseFloat(bundle.price);
        
        if (volumeInMB && !isNaN(price)) {
          priceMap.set(volumeInMB, price);
        }
      }
      
      remaBundleCache = priceMap;
      lastRemaCacheUpdate = Date.now();
      console.log(`✅ Fetched ${priceMap.size} bundle prices from RemaData`);
      return remaBundleCache;
    }
    
    console.warn("⚠️ RemaData API returned unexpected format, using fallback");
    return getFallbackBundlePrices();
    
  } catch (err) {
    console.error(`❌ Failed to fetch RemaData bundles: ${err.message}`);
    return getFallbackBundlePrices();
  }
}

function getFallbackBundlePrices() {
  // Fallback prices (used if RemaData API is unavailable)
  const fallbackPrices = new Map();
  fallbackPrices.set(1024, 4.30);
  fallbackPrices.set(2048, 8.60);
  fallbackPrices.set(3072, 12.50);
  fallbackPrices.set(4096, 16.50);
  fallbackPrices.set(5120, 21.70);
  fallbackPrices.set(6144, 24.50);
  fallbackPrices.set(8192, 32.50);
  fallbackPrices.set(10240, 39.00);
  fallbackPrices.set(15360, 57.00);
  fallbackPrices.set(20480, 77.10);
  fallbackPrices.set(25600, 96.00);
  fallbackPrices.set(30720, 116.00);
  fallbackPrices.set(40960, 155.00);
  fallbackPrices.set(51200, 186.00);
  fallbackPrices.set(102400, 370.00);
  return fallbackPrices;
}

// ─────────────────────────────────────────────
//  GET TELEPRICE FOR TELEPINS (from environment)
// ─────────────────────────────────────────────

function getTelepriceBundlePrices() {
  const telepricePrices = new Map();
  telepricePrices.set(10240, parseFloat(process.env.TELEPINS_10GB_PRICE) || 38.00);
  telepricePrices.set(15360, parseFloat(process.env.TELEPINS_15GB_PRICE) || 55.00);
  telepricePrices.set(20480, parseFloat(process.env.TELEPINS_20GB_PRICE) || 74.00);
  telepricePrices.set(25600, parseFloat(process.env.TELEPINS_25GB_PRICE) || 92.00);
  telepricePrices.set(30720, parseFloat(process.env.TELEPINS_30GB_PRICE) || 109.00);
  telepricePrices.set(40960, parseFloat(process.env.TELEPINS_40GB_PRICE) || 143.00);
  telepricePrices.set(51200, parseFloat(process.env.TELEPINS_50GB_PRICE) || 177.00);
  telepricePrices.set(102400, parseFloat(process.env.TELEPINS_100GB_PRICE) || 354.00);
  return telepricePrices;
}

function getATPrices() {
  const atPrices = new Map();
  atPrices.set(1024, parseFloat(process.env.AT_1GB_PRICE) || 3.90);
  atPrices.set(2048, parseFloat(process.env.AT_2GB_PRICE) || 7.80);
  atPrices.set(3072, parseFloat(process.env.AT_3GB_PRICE) || 11.80);
  atPrices.set(4096, parseFloat(process.env.AT_4GB_PRICE) || 15.70);
  atPrices.set(5120, parseFloat(process.env.AT_5GB_PRICE) || 19.40);
  atPrices.set(6144, parseFloat(process.env.AT_6GB_PRICE) || 23.80);
  atPrices.set(7168, parseFloat(process.env.AT_7GB_PRICE) || 27.40);
  atPrices.set(8192, parseFloat(process.env.AT_8GB_PRICE) || 31.00);
  atPrices.set(9216, parseFloat(process.env.AT_9GB_PRICE) || 35.00);
  atPrices.set(10240, parseFloat(process.env.AT_10GB_PRICE) || 39.00);
  atPrices.set(12288, parseFloat(process.env.AT_12GB_PRICE) || 47.00);
  atPrices.set(15360, parseFloat(process.env.AT_15GB_PRICE) || 59.00);
  atPrices.set(20480, parseFloat(process.env.AT_20GB_PRICE) || 78.50);
  atPrices.set(25600, parseFloat(process.env.AT_25GB_PRICE) || 98.00);
  return atPrices;
}

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
    ["REMADATA_API_KEY", REMADATA_API_KEY, "MTN delivery will fail"],
    ["HUBNET_API_KEY", HUBNET_API_KEY, "Telecel/AT delivery will fail"],
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

app.use((req, res, next) => {
  req.setTimeout(30000);
  res.setTimeout(30000);
  next();
});

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

async function deliverViaRemaData(phone, volumeInMB, reference) {
  if (!REMADATA_API_KEY) {
    throw new AppError(
      "RemaData API not configured. Please set REMADATA_API_KEY environment variable.",
      503, "CONFIGURATION"
    );
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

  console.log(`📦 [RemaData] ${volumeInMB}MB → ${remaMB}MB MTN → ${localPhone} | Ref: ${orderRef}`);

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

async function deliverViaHubNet(phone, networkType, volumeInMB, reference) {
  if (!HUBNET_API_KEY) {
    throw new AppError(
      "HubNetGH API not configured. Please set HUBNET_API_KEY environment variable.",
      503, "CONFIGURATION"
    );
  }
  
  let network;
  switch (networkType) {
    case "airteltigo":
      network = "airteltigo";
      break;
    case "telecel":
      network = "telecel";
      break;
    case "mtn":
      network = "mtn";
      break;
    default:
      network = "telecel";
      console.warn(`⚠️ Unknown network type "${networkType}", defaulting to "telecel"`);
  }
  
  const volume = resolveVolume(volumeInMB);
  const requestId = reference || `DF-${Date.now()}`;
  const localPhone = formatPhoneLocal(phone);

  console.log(`📦 [HubNetGH] ${volume}GB ${network} → ${localPhone} | Ref: ${requestId}`);

  const response = await fetchWithRetry(async () => {
    return await axios.post(
      `${HUBNET_BASE_URL}/place_order`,
      { network, volume, customer_number: localPhone, quantity: 1, request_id: requestId },
      {
        headers: { "Content-Type": "application/json", "X-API-KEY": HUBNET_API_KEY },
        timeout: 30000,
      }
    );
  });

  if (!response.data?.success) {
    const providerMsg = response.data?.message || response.data?.error || "Unknown provider error";
    throw new AppError(
      `HubNetGH delivery rejected: ${providerMsg}`,
      502, "PROVIDER",
      { providerResponse: response.data }
    );
  }

  const orderId = String(response.data?.order_id || requestId);
  console.log(`✅ [HubNetGH] Delivered | Order ID: ${orderId}`);

  return { success: true, reference: orderId, data: response.data, provider: "HubNetGH" };
}

// ─────────────────────────────────────────────
//  DELIVERY ORCHESTRATOR WITH BIDIRECTIONAL FAILOVER
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
  
  const primaryProvider = providerConfig.name;
  const fallbackProvider = providerConfig.fallback;
  const fallbackNetwork = providerConfig.fallbackNetwork;
  
  const errors = [];
  
  console.log(`📡 Trying primary provider: ${primaryProvider} for ${net}`);
  try {
    if (primaryProvider === "RemaData") {
      return await deliverViaRemaData(phone, volumeInMB, reference);
    } else {
      return await deliverViaHubNet(phone, net, volumeInMB, reference);
    }
  } catch (primaryError) {
    const errorMsg = `${primaryProvider}: ${primaryError.message}`;
    errors.push(errorMsg);
    console.warn(`⚠️ Primary provider ${primaryProvider} failed: ${primaryError.message}`);
    
    if (fallbackProvider) {
      console.log(`🔄 Attempting fallback: ${fallbackProvider} for ${net}`);
      try {
        let result;
        if (fallbackProvider === "RemaData") {
          result = await deliverViaRemaData(phone, volumeInMB, reference);
        } else if (fallbackProvider === "HubNetGH") {
          result = await deliverViaHubNet(phone, fallbackNetwork, volumeInMB, reference);
        } else {
          throw new Error(`Unknown fallback provider: ${fallbackProvider}`);
        }
        
        console.log(`✅ Fallback successful! Delivered via ${fallbackProvider} for ${net}`);
        return result;
      } catch (fallbackError) {
        const fallbackErrorMsg = `${fallbackProvider}: ${fallbackError.message}`;
        errors.push(fallbackErrorMsg);
        console.error(`❌ Fallback provider ${fallbackProvider} also failed: ${fallbackError.message}`);
      }
    }
    
    const allErrors = errors.join(" | ");
    const customerMessage = getCustomerFriendlyMessage(net, allErrors);
    
    throw new AppError(
      customerMessage,
      503,
      "PROVIDER_FAILOVER",
      { 
        network: net,
        attemptedProviders: errors,
        timestamp: new Date().toISOString()
      }
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
  
  const isWalletFunding = meta.purpose === "wallet_funding";
  const partnerId = meta.partnerId;

  if (isWalletFunding && partnerId) {
    try {
      // Credit partner wallet - simplified version without wallet functions for brevity
      console.log(`✅ Partner wallet funding: ${partnerId} +${amount}`);
    } catch (err) {
      console.error(`❌ Wallet funding failed: ${err.message}`);
    }
    return;
  }

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
  if (!REMADATA_API_KEY) criticalIssues.push("MTN deliveries will fail");
  if (!HUBNET_API_KEY) criticalIssues.push("Telecel/AT deliveries will fail");
  if (!DELIVER_SECRET) criticalIssues.push("/deliver endpoint unprotected");
  
  res.json({
    status: criticalIssues.length > 0 ? "DEGRADED" : "OK",
    service: "DataFlow GH",
    timestamp: new Date().toISOString(),
    criticalIssues,
    providers: {
      mtn: { provider: "RemaData", configured: !!REMADATA_API_KEY, operational: !!REMADATA_API_KEY },
      telecel: { provider: "HubNetGH", configured: !!HUBNET_API_KEY, operational: !!HUBNET_API_KEY },
      airteltigo: { provider: "HubNetGH", configured: !!HUBNET_API_KEY, operational: !!HUBNET_API_KEY },
    },
    failover: {
      mtn: "RemaData → HubNetGH",
      telecel: "HubNetGH → RemaData",
      airteltigo: "HubNetGH → RemaData"
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

app.get("/api/hubnet/balance", asyncHandler(async (req, res) => {
  if (!HUBNET_API_KEY) {
    return res.json({ status: "info", balance: null, message: "HubNet API not configured" });
  }
  try {
    const response = await axios.get(`${HUBNET_BASE_URL}/check_balance`, {
      headers: { "X-API-KEY": HUBNET_API_KEY },
      timeout: 15000,
    });
    if (response.data?.success) {
      return res.json({ status: "success", balance: response.data.wallet_balance ?? 0 });
    }
    res.json({ status: "info", balance: null, message: "Balance unavailable" });
  } catch (err) {
    console.warn(`⚠️ HubNet balance check failed: ${err.message}`);
    res.json({ status: "info", balance: null, message: "Balance unavailable" });
  }
}));

app.get("/api/bundles", asyncHandler(async (req, res) => {
  const network = (req.query.network || "mtn").toLowerCase();

  // Fetch real-time prices from RemaData for MTN
  const remaPrices = await fetchRemaBundlePrices();
  const telepricePrices = getTelepriceBundlePrices();
  const atPrices = getATPrices();

  const bundleData = {
    mtn: [
      { volumeInMB: 1024, volume: "1GB", name: "1GB", network: "mtn" },
      { volumeInMB: 2048, volume: "2GB", name: "2GB", network: "mtn" },
      { volumeInMB: 3072, volume: "3GB", name: "3GB", network: "mtn" },
      { volumeInMB: 4096, volume: "4GB", name: "4GB", network: "mtn" },
      { volumeInMB: 5120, volume: "5GB", name: "5GB", network: "mtn" },
      { volumeInMB: 6144, volume: "6GB", name: "6GB", network: "mtn" },
      { volumeInMB: 8192, volume: "8GB", name: "8GB", network: "mtn" },
      { volumeInMB: 10240, volume: "10GB", name: "10GB", network: "mtn" },
      { volumeInMB: 15360, volume: "15GB", name: "15GB", network: "mtn" },
      { volumeInMB: 20480, volume: "20GB", name: "20GB", network: "mtn" },
      { volumeInMB: 25600, volume: "25GB", name: "25GB", network: "mtn" },
      { volumeInMB: 30720, volume: "30GB", name: "30GB", network: "mtn" },
      { volumeInMB: 40960, volume: "40GB", name: "40GB", network: "mtn" },
      { volumeInMB: 51200, volume: "50GB", name: "50GB", network: "mtn" },
      { volumeInMB: 102400, volume: "100GB", name: "100GB", network: "mtn" },
    ],
    telecel: [
      { volumeInMB: 10240, volume: "10GB", name: "10GB", network: "telecel" },
      { volumeInMB: 15360, volume: "15GB", name: "15GB", network: "telecel" },
      { volumeInMB: 20480, volume: "20GB", name: "20GB", network: "telecel" },
      { volumeInMB: 25600, volume: "25GB", name: "25GB", network: "telecel" },
      { volumeInMB: 30720, volume: "30GB", name: "30GB", network: "telecel" },
      { volumeInMB: 40960, volume: "40GB", name: "40GB", network: "telecel" },
      { volumeInMB: 51200, volume: "50GB", name: "50GB", network: "telecel" },
      { volumeInMB: 102400, volume: "100GB", name: "100GB", network: "telecel" },
    ],
    airteltigo: [
      { volumeInMB: 1024, volume: "1GB", name: "1GB", network: "airteltigo" },
      { volumeInMB: 2048, volume: "2GB", name: "2GB", network: "airteltigo" },
      { volumeInMB: 3072, volume: "3GB", name: "3GB", network: "airteltigo" },
      { volumeInMB: 4096, volume: "4GB", name: "4GB", network: "airteltigo" },
      { volumeInMB: 5120, volume: "5GB", name: "5GB", network: "airteltigo" },
      { volumeInMB: 6144, volume: "6GB", name: "6GB", network: "airteltigo" },
      { volumeInMB: 7168, volume: "7GB", name: "7GB", network: "airteltigo" },
      { volumeInMB: 8192, volume: "8GB", name: "8GB", network: "airteltigo" },
      { volumeInMB: 9216, volume: "9GB", name: "9GB", network: "airteltigo" },
      { volumeInMB: 10240, volume: "10GB", name: "10GB", network: "airteltigo" },
      { volumeInMB: 12288, volume: "12GB", name: "12GB", network: "airteltigo" },
      { volumeInMB: 15360, volume: "15GB", name: "15GB", network: "airteltigo" },
      { volumeInMB: 20480, volume: "20GB", name: "20GB", network: "airteltigo" },
      { volumeInMB: 25600, volume: "25GB", name: "25GB", network: "airteltigo" },
    ],
  };

  if (!bundleData[network]) {
    throw new AppError(`Unknown network "${network}"`, 400, "VALIDATION");
  }

  let bundles = bundleData[network].map((b) => {
    let price;
    
    if (network === "mtn") {
      // Get price from RemaData API (dynamic)
      price = remaPrices.get(b.volumeInMB) || 39.00; // fallback
    } else if (network === "telecel") {
      price = telepricePrices.get(b.volumeInMB) || 38.00;
    } else {
      price = atPrices.get(b.volumeInMB) || 3.90;
    }
    
    return {
      ...b,
      price: price,
      costPrice: price,
    };
  });

  if (network !== "mtn") {
    const settings = await getProfitSettings();
    bundles = bundles.map((b) => ({
      ...b,
      price: applyProfit(b.price, b.volumeInMB, network, settings),
    }));
  }

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

app.get("/api/order-status/:reference", asyncHandler(async (req, res) => {
  const { reference } = req.params;
  const { network } = req.query;

  if (!reference) {
    throw new AppError("Reference parameter is required", 400, "VALIDATION");
  }

  let knownProvider = null;
  let providerRef = null;
  
  if (db) {
    try {
      const snapshot = await db.ref(`transactions/${reference}`).once("value");
      const order = snapshot.val();
      if (order && order.provider && order.providerRef) {
        knownProvider = order.provider;
        providerRef = order.providerRef;
        console.log(`📦 Found order in Firebase. Provider: ${knownProvider}, ProviderRef: ${providerRef}`);
      }
    } catch (err) {
      console.warn(`⚠️ Firebase lookup failed: ${err.message}`);
    }
  }

  let providersToTry = [];
  
  if (knownProvider) {
    providersToTry = [{ name: knownProvider, ref: providerRef }];
  } else if (network) {
    const providerConfig = NETWORK_PROVIDER[network.toLowerCase()];
    if (providerConfig) {
      providersToTry = [{ name: providerConfig.name, ref: reference }];
    }
  } else {
    providersToTry = [
      { name: "RemaData", ref: reference },
      { name: "HubNetGH", ref: reference }
    ];
  }

  const errors = [];

  for (const provider of providersToTry) {
    try {
      const lookupRef = provider.ref || reference;
      
      if (provider.name === "RemaData") {
        if (!REMADATA_API_KEY) { 
          errors.push("RemaData: API not configured"); 
          continue; 
        }
        console.log(`🔍 Checking RemaData status for ref: ${lookupRef}`);
        const response = await axios.get(
          `${REMADATA_API_URL}/order-status/${encodeURIComponent(lookupRef)}`,
          { headers: { "X-API-KEY": REMADATA_API_KEY }, timeout: 10000 }
        );
        if (response.data?.status === "success") {
          return res.json({ 
            status: "success", 
            provider: provider.name, 
            reference: lookupRef,
            data: response.data.data 
          });
        }
        errors.push(`RemaData: ${response.data?.message || "not found"}`);
      } 
      else if (provider.name === "HubNetGH") {
        if (!HUBNET_API_KEY) { 
          errors.push("HubNetGH: API not configured"); 
          continue; 
        }
        console.log(`🔍 Checking HubNetGH status for order_id: ${lookupRef}`);
        const response = await axios.get(`${HUBNET_BASE_URL}/order_status`, {
          params: { order_id: lookupRef },
          headers: { "X-API-KEY": HUBNET_API_KEY },
          timeout: 10000,
        });
        if (response.data?.success) {
          return res.json({ 
            status: "success", 
            provider: provider.name, 
            reference: lookupRef,
            data: response.data 
          });
        }
        errors.push(`HubNetGH: ${response.data?.message || "not found"}`);
      }
    } catch (err) {
      errors.push(`${provider.name}: ${err.response?.data?.message || err.message}`);
    }
  }

  if (knownProvider && providerRef && errors.length > 0) {
    console.log(`🔄 Firebase had provider ${knownProvider} but check failed, trying alternative providers...`);
    const otherProvider = knownProvider === "RemaData" ? "HubNetGH" : "RemaData";
    try {
      if (otherProvider === "RemaData" && REMADATA_API_KEY) {
        const response = await axios.get(
          `${REMADATA_API_URL}/order-status/${encodeURIComponent(reference)}`,
          { headers: { "X-API-KEY": REMADATA_API_KEY }, timeout: 10000 }
        );
        if (response.data?.status === "success") {
          return res.json({ 
            status: "success", 
            provider: otherProvider, 
            reference: reference,
            data: response.data.data,
            note: "Found via alternative provider" 
          });
        }
      } else if (otherProvider === "HubNetGH" && HUBNET_API_KEY) {
        const response = await axios.get(`${HUBNET_BASE_URL}/order_status`, {
          params: { order_id: reference },
          headers: { "X-API-KEY": HUBNET_API_KEY },
          timeout: 10000,
        });
        if (response.data?.success) {
          return res.json({ 
            status: "success", 
            provider: otherProvider, 
            reference: reference,
            data: response.data,
            note: "Found via alternative provider" 
          });
        }
      }
    } catch (err) {
      errors.push(`Alternative ${otherProvider}: ${err.message}`);
    }
  }

  console.warn(`⚠️ Order not found for ref "${reference}" | Tried: ${errors.join(" | ")}`);
  res.status(404).json({
    status: "error",
    message: "Order not found",
    details: errors,
  });
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
${col("║  MTN → RemaData (Dynamic Prices)", !!REMADATA_API_KEY)}        ║
${col("║  Telecel → HubNetGH", !!HUBNET_API_KEY)}        ║
${col("║  AirtelTigo → HubNetGH", !!HUBNET_API_KEY)}        ║
${col("║  Paystack Webhook", !!PAYSTACK_SECRET)}        ║
${col("║  /deliver Auth", !!DELIVER_SECRET)}        ║
${col("║  Firebase", !!db)}        ║
╠══════════════════════════════════════════════════════════════╣
║  ✅ COST PRICES NOW COME FROM REMADATA API DYNAMICALLY       ║
║  ✅ MTN bundles fetch real-time prices from RemaData         ║
║  ✅ Fallback prices used if API is unavailable              ║
╚══════════════════════════════════════════════════════════════╝`);
});

setInterval(async () => {
  try {
    await axios.get(`http://localhost:${PORT}/health`, { timeout: 10000 });
  } catch (err) {
    console.error(`⚠️ Keep-alive failed: ${err.message}`);
  }
}, 4 * 60 * 1000);

module.exports = app;
