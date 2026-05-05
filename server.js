// ============================================================
//  DATEFLOW GH — UNIFIED BACKEND (PRODUCTION READY)
//  MTN → RemaData API (local format 0XXXXXXXXX + volume mapping)
//  Telecel/AT → HubNetGH API (local format 0XXXXXXXXX)
//  Features: Retry logic, bidirectional failover, queue, memory protection
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
//  PARTNER AUTH MIDDLEWARE (NEW)
// ─────────────────────────────────────────────

async function validatePartner(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  const partnerId = req.headers["x-partner-id"];
  
  if (!apiKey || !partnerId) {
    return res.status(401).json({
      status: "error",
      message: "Missing API key or Partner ID",
      code: "MISSING_CREDENTIALS"
    });
  }
  
  if (!db) {
    return res.status(503).json({
      status: "error",
      message: "Database unavailable",
      code: "DB_ERROR"
    });
  }
  
  try {
    const snapshot = await db.ref(`developers`).orderByChild('apiKey').equalTo(apiKey).once('value');
    const developers = snapshot.val();
    
    let partner = null;
    for (const key in developers) {
      if (developers[key].partnerId === partnerId) {
        partner = developers[key];
        partner.uid = key;
        break;
      }
    }
    
    if (!partner) {
      return res.status(401).json({
        status: "error",
        message: "Invalid API key or Partner ID",
        code: "INVALID_CREDENTIALS"
      });
    }
    
    // Update total requests
    await db.ref(`developers/${partner.uid}`).update({
      totalRequests: (partner.totalRequests || 0) + 1,
      lastUsed: new Date().toISOString()
    });
    
    req.partner = partner;
    next();
  } catch (err) {
    console.error("Partner validation error:", err);
    res.status(500).json({
      status: "error",
      message: "Authentication failed",
      code: "AUTH_ERROR"
    });
  }
}

// ─────────────────────────────────────────────
//  WALLET FUNCTIONS (NEW)
// ─────────────────────────────────────────────

async function getPartnerWallet(partnerId) {
  if (!db) return { balance: 0, transactions: [] };
  try {
    const walletId = `partner_${partnerId}`;
    const snapshot = await db.ref(`wallets/${walletId}`).once("value");
    const data = snapshot.val();
    return {
      balance: data?.balance || 0,
      transactions: data?.transactions || [],
      partnerId: partnerId
    };
  } catch (err) {
    console.error(`Failed to get wallet for ${partnerId}:`, err);
    return { balance: 0, transactions: [], partnerId: partnerId };
  }
}

async function creditPartnerWallet(partnerId, amount, reference, description) {
  if (!db) throw new AppError("Wallet system unavailable", 503, "FIREBASE");
  
  const walletId = `partner_${partnerId}`;
  const walletRef = db.ref(`wallets/${walletId}`);
  let newBalance = 0;
  
  try {
    await walletRef.transaction(current => {
      if (!current) {
        newBalance = amount;
        return {
          balance: amount,
          transactions: [{
            id: reference,
            amount: amount,
            type: "credit",
            status: "completed",
            description: description,
            timestamp: new Date().toISOString(),
            balanceAfter: amount
          }]
        };
      }
      
      newBalance = (current.balance || 0) + amount;
      const transactions = current.transactions || [];
      
      transactions.unshift({
        id: reference,
        amount: amount,
        type: "credit",
        status: "completed",
        description: description,
        timestamp: new Date().toISOString(),
        balanceAfter: newBalance
      });
      
      if (transactions.length > 100) transactions.pop();
      
      return {
        ...current,
        balance: newBalance,
        transactions: transactions
      };
    });
    
    // Also update the developer record
    const devSnapshot = await db.ref(`developers`).orderByChild('partnerId').equalTo(partnerId).once('value');
    const developers = devSnapshot.val();
    for (const uid in developers) {
      await db.ref(`developers/${uid}`).update({ walletBalance: newBalance });
      break;
    }
    
    console.log(`💰 Credited ${amount} to wallet ${partnerId} | Ref: ${reference}`);
    return { success: true, balance: newBalance };
  } catch (err) {
    console.error(`Failed to credit wallet ${partnerId}:`, err);
    throw new AppError(`Failed to credit wallet: ${err.message}`, 500, "WALLET");
  }
}

async function debitPartnerWallet(partnerId, amount, reference, description) {
  if (!db) throw new AppError("Wallet system unavailable", 503, "FIREBASE");
  
  const walletId = `partner_${partnerId}`;
  const walletRef = db.ref(`wallets/${walletId}`);
  let result = null;
  let newBalance = 0;
  
  await walletRef.transaction(current => {
    if (!current || (current.balance || 0) < amount) {
      result = { success: false, error: "Insufficient balance" };
      return;
    }
    
    newBalance = (current.balance || 0) - amount;
    const transactions = current.transactions || [];
    
    transactions.unshift({
      id: reference,
      amount: amount,
      type: "debit",
      status: "completed",
      description: description,
      timestamp: new Date().toISOString(),
      balanceAfter: newBalance
    });
    
    if (transactions.length > 100) transactions.pop();
    
    result = { success: true, balance: newBalance };
    
    return {
      ...current,
      balance: newBalance,
      transactions: transactions
    };
  });
  
  if (result && result.success) {
    // Update the developer record
    const devSnapshot = await db.ref(`developers`).orderByChild('partnerId').equalTo(partnerId).once('value');
    const developers = devSnapshot.val();
    for (const uid in developers) {
      await db.ref(`developers/${uid}`).update({ walletBalance: newBalance });
      break;
    }
    
    console.log(`💸 Debited ${amount} from wallet ${partnerId} | Ref: ${reference}`);
    return { success: true, balance: result.balance };
  }
  
  throw new AppError(result?.error || "Insufficient balance", 400, "WALLET");
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

// ✅ FIXED: HubNetGH now correctly handles all network types (mtn, telecel, airteltigo)
async function deliverViaHubNet(phone, networkType, volumeInMB, reference) {
  if (!HUBNET_API_KEY) {
    throw new AppError(
      "HubNetGH API not configured. Please set HUBNET_API_KEY environment variable.",
      503, "CONFIGURATION"
    );
  }
  
  // ✅ FIX: Properly map all network types to HubNetGH expected values
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
  
  // Track all errors for final customer notification
  const errors = [];
  
  // Try primary provider
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
    
    // Try fallback provider if configured
    if (fallbackProvider) {
      console.log(`🔄 Attempting fallback: ${fallbackProvider} for ${net}`);
      try {
        let result;
        if (fallbackProvider === "RemaData") {
          result = await deliverViaRemaData(phone, volumeInMB, reference);
        } else if (fallbackProvider === "HubNetGH") {
          // Pass the fallbackNetwork (e.g., "mtn", "telecel", "airteltigo")
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
    
    // Both providers failed - throw customer-friendly error
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
  
  // Check if this is a wallet funding transaction
  const isWalletFunding = meta.purpose === "wallet_funding";
  const partnerId = meta.partnerId;

  if (isWalletFunding && partnerId) {
    try {
      await creditPartnerWallet(partnerId, amount, ref, `Wallet funding via Paystack`);
      console.log(`✅ Partner wallet funded: ${partnerId} +${amount}`);
      
      if (db) {
        await db.ref(`wallet_transactions/${ref}`).set({
          partnerId,
          amount,
          type: "credit",
          status: "completed",
          reference: ref,
          timestamp: new Date().toISOString()
        });
      }
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

  if (network !== "mtn") {
    const settings = await getProfitSettings();
    bundles = bundles.map((b) => ({
      ...b,
      costPrice: b.price,
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

// ─────────────────────────────────────────────
//  ORDER STATUS LOOKUP - ENHANCED WITH FIREBASE FIRST
// ─────────────────────────────────────────────

app.get("/api/order-status/:reference", asyncHandler(async (req, res) => {
  const { reference } = req.params;
  const { network } = req.query;

  if (!reference) {
    throw new AppError("Reference parameter is required", 400, "VALIDATION");
  }

  // STEP 1: Check Firebase first to get the provider reference
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

  // STEP 2: Build provider list (prioritize known provider from Firebase)
  let providersToTry = [];
  
  if (knownProvider) {
    // Use the provider we know from Firebase with the correct providerRef
    providersToTry = [{ name: knownProvider, ref: providerRef }];
  } else if (network) {
    // Use network filter
    const providerConfig = NETWORK_PROVIDER[network.toLowerCase()];
    if (providerConfig) {
      providersToTry = [{ name: providerConfig.name, ref: reference }];
    }
  } else {
    // Try all providers with the original reference
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

  // Step 3: If not found and we have Firebase data but provider check failed, try alternative
  if (knownProvider && providerRef && errors.length > 0) {
    console.log(`🔄 Firebase had provider ${knownProvider} but check failed, trying alternative providers...`);
    // Try the other provider as fallback
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

// ============================================================
// NEW PARTNER API ENDPOINTS FOR EXTERNAL DEVELOPERS
// ============================================================

// GET /api/partner/wallet - Get partner wallet balance
app.get("/api/partner/wallet", validatePartner, asyncHandler(async (req, res) => {
  const partner = req.partner;
  const wallet = await getPartnerWallet(partner.partnerId);
  
  res.json({
    status: "success",
    data: {
      balance: wallet.balance,
      currency: "GHS",
      partnerId: partner.partnerId,
      name: partner.name
    }
  });
}));

// GET /api/partner/bundles - Get available bundles for partners
app.get("/api/partner/bundles", validatePartner, asyncHandler(async (req, res) => {
  const network = req.query.network || null;
  
  const bundleData = {
    mtn: [
      { id: "mtn_1GB", name: "1GB", size: "1GB", volumeInMB: 1024, price: 4.30 },
      { id: "mtn_2GB", name: "2GB", size: "2GB", volumeInMB: 2048, price: 8.60 },
      { id: "mtn_5GB", name: "5GB", size: "5GB", volumeInMB: 5120, price: 21.70 },
      { id: "mtn_10GB", name: "10GB", size: "10GB", volumeInMB: 10240, price: 39.00 },
      { id: "mtn_15GB", name: "15GB", size: "15GB", volumeInMB: 15360, price: 57.00 },
      { id: "mtn_20GB", name: "20GB", size: "20GB", volumeInMB: 20480, price: 77.10 },
      { id: "mtn_30GB", name: "30GB", size: "30GB", volumeInMB: 30720, price: 116.00 },
      { id: "mtn_50GB", name: "50GB", size: "50GB", volumeInMB: 51200, price: 186.00 },
      { id: "mtn_100GB", name: "100GB", size: "100GB", volumeInMB: 102400, price: 370.00 }
    ],
    telecel: [
      { id: "telecel_10GB", name: "10GB", size: "10GB", volumeInMB: 10240, price: 38.00 },
      { id: "telecel_15GB", name: "15GB", size: "15GB", volumeInMB: 15360, price: 55.00 },
      { id: "telecel_20GB", name: "20GB", size: "20GB", volumeInMB: 20480, price: 74.00 },
      { id: "telecel_30GB", name: "30GB", size: "30GB", volumeInMB: 30720, price: 109.00 },
      { id: "telecel_50GB", name: "50GB", size: "50GB", volumeInMB: 51200, price: 177.00 },
      { id: "telecel_100GB", name: "100GB", size: "100GB", volumeInMB: 102400, price: 354.00 }
    ],
    airteltigo: [
      { id: "at_1GB", name: "1GB", size: "1GB", volumeInMB: 1024, price: 3.90 },
      { id: "at_2GB", name: "2GB", size: "2GB", volumeInMB: 2048, price: 7.80 },
      { id: "at_5GB", name: "5GB", size: "5GB", volumeInMB: 5120, price: 19.40 },
      { id: "at_10GB", name: "10GB", size: "10GB", volumeInMB: 10240, price: 39.00 },
      { id: "at_15GB", name: "15GB", size: "15GB", volumeInMB: 15360, price: 59.00 },
      { id: "at_20GB", name: "20GB", size: "20GB", volumeInMB: 20480, price: 78.50 }
    ]
  };

  if (network && bundleData[network]) {
    return res.json({ status: "success", data: bundleData[network], count: bundleData[network].length });
  }
  
  const allBundles = [...bundleData.mtn, ...bundleData.telecel, ...bundleData.airteltigo];
  res.json({ status: "success", data: allBundles, count: allBundles.length });
}));

// POST /api/partner/calculate - Calculate cost before order
app.post("/api/partner/calculate", validatePartner, asyncHandler(async (req, res) => {
  const { bundleSize, network } = req.body;
  
  if (!bundleSize || !network) {
    throw new AppError("Missing bundleSize or network", 400, "VALIDATION");
  }
  
  const bundleData = {
    mtn: { "1GB": 4.30, "2GB": 8.60, "5GB": 21.70, "10GB": 39.00, "15GB": 57.00, "20GB": 77.10, "30GB": 116.00, "50GB": 186.00, "100GB": 370.00 },
    telecel: { "10GB": 38.00, "15GB": 55.00, "20GB": 74.00, "30GB": 109.00, "50GB": 177.00, "100GB": 354.00 },
    airteltigo: { "1GB": 3.90, "2GB": 7.80, "5GB": 19.40, "10GB": 39.00, "15GB": 59.00, "20GB": 78.50 }
  };
  
  const networkLower = network.toLowerCase();
  if (!bundleData[networkLower]) {
    throw new AppError(`Invalid network: ${network}`, 400, "VALIDATION");
  }
  
  const price = bundleData[networkLower][bundleSize];
  if (!price) {
    throw new AppError(`Invalid bundle size: ${bundleSize} for ${network}`, 400, "VALIDATION");
  }
  
  res.json({
    status: "success",
    data: {
      network: networkLower,
      bundleSize: bundleSize,
      price: price,
      currency: "GHS"
    }
  });
}));

// POST /api/partner/order - Place order (deducts from wallet)
app.post("/api/partner/order", validatePartner, asyncHandler(async (req, res) => {
  const { phone, bundleSize, network, orderRef, customerName, customerEmail, webhookUrl } = req.body;
  const partner = req.partner;
  
  if (!phone || !bundleSize || !network) {
    throw new AppError("Missing required fields: phone, bundleSize, network", 400, "VALIDATION");
  }
  
  // Get bundle price
  const bundleData = {
    mtn: { "1GB": { price: 4.30, volumeInMB: 1024 }, "2GB": { price: 8.60, volumeInMB: 2048 }, "5GB": { price: 21.70, volumeInMB: 5120 }, "10GB": { price: 39.00, volumeInMB: 10240 }, "15GB": { price: 57.00, volumeInMB: 15360 }, "20GB": { price: 77.10, volumeInMB: 20480 }, "30GB": { price: 116.00, volumeInMB: 30720 }, "50GB": { price: 186.00, volumeInMB: 51200 }, "100GB": { price: 370.00, volumeInMB: 102400 } },
    telecel: { "10GB": { price: 38.00, volumeInMB: 10240 }, "15GB": { price: 55.00, volumeInMB: 15360 }, "20GB": { price: 74.00, volumeInMB: 20480 }, "30GB": { price: 109.00, volumeInMB: 30720 }, "50GB": { price: 177.00, volumeInMB: 51200 }, "100GB": { price: 354.00, volumeInMB: 102400 } },
    airteltigo: { "1GB": { price: 3.90, volumeInMB: 1024 }, "2GB": { price: 7.80, volumeInMB: 2048 }, "5GB": { price: 19.40, volumeInMB: 5120 }, "10GB": { price: 39.00, volumeInMB: 10240 }, "15GB": { price: 59.00, volumeInMB: 15360 }, "20GB": { price: 78.50, volumeInMB: 20480 } }
  };
  
  const networkLower = network.toLowerCase();
  if (!bundleData[networkLower]) {
    throw new AppError(`Invalid network: ${network}`, 400, "VALIDATION");
  }
  
  const bundle = bundleData[networkLower][bundleSize];
  if (!bundle) {
    throw new AppError(`Invalid bundle size: ${bundleSize} for ${network}`, 400, "VALIDATION");
  }
  
  // Apply profit if not MTN
  let finalPrice = bundle.price;
  if (networkLower !== "mtn") {
    const settings = await getProfitSettings();
    finalPrice = applyProfit(bundle.price, bundle.volumeInMB, networkLower, settings);
  }
  
  // Check wallet balance
  const wallet = await getPartnerWallet(partner.partnerId);
  if (wallet.balance < finalPrice) {
    throw new AppError(`Insufficient balance. Required: GHS ${finalPrice.toFixed(2)}, Available: GHS ${wallet.balance.toFixed(2)}`, 400, "INSUFFICIENT_BALANCE");
  }
  
  // Format phone
  const formattedPhone = formatPhoneLocal(phone);
  
  // Validate network compatibility
  const prefix = formattedPhone.substring(0, 3);
  const mtnPrefixes = ['024', '054', '055', '059', '053'];
  const telPrefixes = ['020', '050', '026'];
  const atPrefixes = ['027', '057'];
  
  if (networkLower === 'mtn' && !mtnPrefixes.includes(prefix)) {
    throw new AppError(`${formattedPhone} is not an MTN number`, 400, "VALIDATION");
  }
  if (networkLower === 'telecel' && !telPrefixes.includes(prefix)) {
    throw new AppError(`${formattedPhone} is not a Telecel number`, 400, "VALIDATION");
  }
  if (networkLower === 'airteltigo' && !atPrefixes.includes(prefix)) {
    throw new AppError(`${formattedPhone} is not an AT number`, 400, "VALIDATION");
  }
  
  const ref = orderRef || `PARTNER_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  
  // Debit wallet first
  await debitPartnerWallet(partner.partnerId, finalPrice, ref, `Purchase: ${bundleSize} ${network} for ${formattedPhone}`);
  
  try {
    // Attempt delivery
    const deliveryResult = await deliverData(formattedPhone, networkLower, bundle.volumeInMB, ref);
    
    // Save order
    if (db) {
      await db.ref(`partner_orders/${ref}`).set({
        orderRef: ref,
        partnerId: partner.partnerId,
        partnerName: partner.name,
        phone: formattedPhone,
        network: networkLower,
        bundleSize: bundleSize,
        volumeInMB: bundle.volumeInMB,
        amount: finalPrice,
        status: "completed",
        provider: deliveryResult.provider,
        providerRef: deliveryResult.reference,
        customerName: customerName || null,
        customerEmail: customerEmail || null,
        timestamp: new Date().toISOString()
      });
    }
    
    // Send webhook if provided
    if (webhookUrl) {
      axios.post(webhookUrl, {
        event: "order.completed",
        orderRef: ref,
        status: "completed",
        phone: formattedPhone,
        bundle: bundleSize,
        network: networkLower,
        amount: finalPrice
      }).catch(err => console.warn(`Webhook failed: ${err.message}`));
    }
    
    res.json({
      status: "success",
      message: "Data delivered successfully",
      data: {
        orderRef: ref,
        phone: formattedPhone,
        network: networkLower,
        bundle: bundleSize,
        amount: finalPrice,
        walletBalanceAfter: (await getPartnerWallet(partner.partnerId)).balance,
        provider: deliveryResult.provider,
        providerReference: deliveryResult.reference
      }
    });
    
  } catch (err) {
    // Refund wallet if delivery fails
    await creditPartnerWallet(partner.partnerId, finalPrice, `refund_${ref}`, `Refund for failed order: ${ref}`);
    
    if (db) {
      await db.ref(`partner_orders/${ref}`).set({
        orderRef: ref,
        partnerId: partner.partnerId,
        partnerName: partner.name,
        phone: formattedPhone,
        network: networkLower,
        bundleSize: bundleSize,
        volumeInMB: bundle.volumeInMB,
        amount: finalPrice,
        status: "failed",
        error: err.message,
        timestamp: new Date().toISOString(),
        refunded: true
      });
    }
    
    throw err;
  }
}));

// GET /api/partner/order/:reference - Check order status
app.get("/api/partner/order/:reference", validatePartner, asyncHandler(async (req, res) => {
  const { reference } = req.params;
  const partner = req.partner;
  
  if (!reference) {
    throw new AppError("Reference parameter is required", 400, "VALIDATION");
  }
  
  if (db) {
    try {
      const snapshot = await db.ref(`partner_orders/${reference}`).once("value");
      const order = snapshot.val();
      
      if (order && order.partnerId === partner.partnerId) {
        return res.json({
          status: "success",
          data: order
        });
      }
    } catch (err) {
      console.warn(`⚠️ Partner order lookup failed: ${err.message}`);
    }
  }
  
  res.status(404).json({
    status: "error",
    message: "Order not found",
    code: "ORDER_NOT_FOUND"
  });
}));

// GET /api/partner/transactions - Get partner transaction history
app.get("/api/partner/transactions", validatePartner, asyncHandler(async (req, res) => {
  const partner = req.partner;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  
  const wallet = await getPartnerWallet(partner.partnerId);
  const transactions = (wallet.transactions || []).slice(0, limit);
  
  res.json({
    status: "success",
    data: {
      transactions: transactions,
      total: wallet.transactions?.length || 0,
      returned: transactions.length
    }
  });
}));

// POST /api/partner/wallet/topup - Generate Paystack payment link
app.post("/api/partner/wallet/topup", validatePartner, asyncHandler(async (req, res) => {
  const { amount, email, callback_url } = req.body;
  const partner = req.partner;
  
  if (!amount || amount < 10) {
    throw new AppError("Amount must be at least GHS 10", 400, "VALIDATION");
  }
  
  if (!email || !email.includes('@')) {
    throw new AppError("Valid email is required", 400, "VALIDATION");
  }
  
  if (!PAYSTACK_SECRET) {
    throw new AppError("Paystack not configured", 503, "CONFIGURATION");
  }
  
  const reference = `WALLET_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  
  const response = await axios.post(
    "https://api.paystack.co/transaction/initialize",
    {
      email: email,
      amount: Math.round(amount * 100),
      reference: reference,
      callback_url: callback_url || "https://dataflow.kesug.com/wallet",
      metadata: {
        purpose: "wallet_funding",
        partnerId: partner.partnerId,
        partnerName: partner.name,
        amount: amount
      }
    },
    {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        "Content-Type": "application/json"
      }
    }
  );
  
  if (response.data?.status) {
    res.json({
      status: "success",
      data: {
        authorization_url: response.data.data.authorization_url,
        reference: reference,
        amount: amount,
        callback_url: callback_url
      }
    });
  } else {
    throw new AppError("Failed to initialize payment", 500, "PAYSTACK");
  }
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
${col("║  Telecel → HubNetGH", !!HUBNET_API_KEY)}        ║
${col("║  AirtelTigo → HubNetGH", !!HUBNET_API_KEY)}        ║
${col("║  Paystack Webhook", !!PAYSTACK_SECRET)}        ║
${col("║  /deliver Auth", !!DELIVER_SECRET)}        ║
${col("║  Firebase", !!db)}        ║
${col("║  Partner API", true)}        ║
╠══════════════════════════════════════════════════════════════╣
║  Partner API Endpoints:                                     ║
║  • GET  /api/partner/wallet                                 ║
║  • GET  /api/partner/bundles                                ║
║  • POST /api/partner/calculate                              ║
║  • POST /api/partner/order                                  ║
║  • GET  /api/partner/order/:reference                       ║
║  • GET  /api/partner/transactions                           ║
║  • POST /api/partner/wallet/topup                           ║
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
