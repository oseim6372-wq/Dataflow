require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
//  CONFIGURATION - HUBNETGH API
// ─────────────────────────────────────────────
const HUBNETGH_API_URL = process.env.HUBNETGH_API_URL || 'https://hubnetgh.site/wp-json/hubnet-api/v1';
const HUBNETGH_API_KEY = process.env.HUBNETGH_API_KEY || '';
const PAYSTACK_SECRET   = process.env.PAYSTACK_SECRET || '';
const SELF_URL          = process.env.SELF_URL || `https://dataflow-2-0.onrender.com`;
const DELIVER_SECRET    = process.env.DELIVER_SECRET || '';

// In-memory dedup set (resets on server restart)
const processedRefs = new Set();

// Bundle pricing (matching HubnetGH available volumes)
// HubnetGH supported networks: mtn, airteltigo, telecel
const BUNDLE_PRICES = {
  mtn: { "1": 12, "2": 18, "5": 35, "10": 60, "20": 110, "50": 250 },
  telecel: { "1": 12, "2": 18, "5": 35, "10": 60, "20": 110, "50": 250 },
  airteltigo: { "1": 12, "2": 18, "5": 35, "10": 60, "20": 110, "50": 250 }
};

// ─────────────────────────────────────────────
//  MIDDLEWARE
// ─────────────────────────────────────────────
app.post('/paystack-webhook', express.raw({ type: 'application/json' }), handlePaystackWebhook);
app.post('/webhook/paystack', express.raw({ type: 'application/json' }), handlePaystackWebhook);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ 
  origin: '*', 
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-API-KEY', 'X-Paystack-Signature', 'x-api-key']
}));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ─────────────────────────────────────────────
//  ROOT ROUTE
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    name: 'DataFlow Backend API',
    version: '2.0.1',
    provider: 'HubnetGH',
    hubnetghUrl: HUBNETGH_API_URL,
    timestamp: new Date().toISOString(),
    endpoints: {
      health: 'GET /health',
      balance: 'GET /api/balance',
      bundles: 'GET /api/bundles?network=mtn',
      checkPrice: 'POST /api/check-price',
      deliver: 'POST /deliver (requires x-api-key header)',
      orderStatus: 'GET /api/order-status/:orderId',
      webhook: 'POST /paystack-webhook'
    }
  });
});

// ─────────────────────────────────────────────
//  AUTH MIDDLEWARE
// ─────────────────────────────────────────────
function requireApiKey(req, res, next) {
  if (!DELIVER_SECRET) {
    console.warn('⚠️ DELIVER_SECRET not configured — /deliver is unprotected!');
    return res.status(500).json({ 
      status: 'error', 
      message: 'Server misconfiguration: DELIVER_SECRET not set' 
    });
  }
  // Accept both X-API-KEY and x-api-key (case insensitive via cors config)
  const key = req.headers['x-api-key'];
  if (!key || key !== DELIVER_SECRET) {
    console.warn(`🚫 Unauthorized /deliver attempt from ${req.ip}`);
    return res.status(401).json({ status: 'error', message: 'Unauthorized - invalid or missing API key' });
  }
  next();
}

// ─────────────────────────────────────────────
//  HELPER FUNCTIONS
// ─────────────────────────────────────────────

/**
 * Format phone number for HubnetGH API
 * HubnetGH expects format like "0272111262" (Ghana local format)
 */
function formatPhoneForHubnetGH(phone) {
  let formatted = phone.replace(/\s+/g, '').replace(/-/g, '');
  
  // Remove leading +
  if (formatted.startsWith('+')) {
    formatted = formatted.substring(1);
  }
  
  // Convert 233 format to 0 format (HubnetGH expects 0XXXXXXXXX)
  if (formatted.startsWith('233') && formatted.length === 12) {
    formatted = '0' + formatted.substring(3);
  }
  
  // Ensure it starts with 0 and is 10 digits
  if (!/^0[0-9]{9}$/.test(formatted)) {
    throw new Error(`Invalid phone number format: ${phone}. Expected Ghana number like 024XXXXXXX.`);
  }
  
  return formatted;
}

/**
 * Map network type to HubnetGH format
 * HubnetGH accepts: mtn, airteltigo, telecel
 */
function mapNetworkToHubnetGH(networkType) {
  const networkMap = {
    'mtn': 'mtn',
    'telecel': 'telecel',
    'airteltigo': 'airteltigo',
    'tel': 'telecel',
    'at': 'airteltigo',
    'vodafone': 'telecel'
  };
  return networkMap[networkType.toLowerCase()] || networkType.toLowerCase();
}

/**
 * Core delivery function - calls HubnetGH POST /place_order
 * Docs: https://hubnetgh.site/wp-json/hubnet-api/v1/place_order
 */
async function deliverData(phone, volumeInGB, networkType, reference = null) {
  const orderRef = reference || `DF-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const hubnetNetwork = mapNetworkToHubnetGH(networkType);
  const formattedPhone = formatPhoneForHubnetGH(phone);
  const volumeStr = volumeInGB.toString();

  // Match HubnetGH API format exactly
  const payload = {
    network: hubnetNetwork,          // "mtn", "airteltigo", or "telecel"
    volume: volumeStr,               // String: "1", "2", "5", "10", "20", "50"
    customer_number: formattedPhone, // "0272111262"
    quantity: 1,
    request_id: orderRef             // Optional unique reference for dedup
  };

  console.log(`📦 Placing order with HubnetGH: ${volumeStr}GB (${hubnetNetwork}) → ${formattedPhone} | Ref: ${orderRef}`);
  console.log(`📤 Payload:`, JSON.stringify(payload));

  try {
    const response = await axios.post(
      `${HUBNETGH_API_URL}/place_order`,
      payload,
      {
        headers: {
          'X-API-KEY': HUBNETGH_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );
    
    console.log(`✅ HubnetGH response:`, JSON.stringify(response.data));

    // HubnetGH returns: { success: true, message: "...", order_id: 1234, total: 15 }
    if (response.data.success) {
      return {
        success: true,
        data: response.data,
        hubnetghOrderId: response.data.order_id,
        message: response.data.message || 'Order placed successfully'
      };
    } else {
      throw new Error(response.data.message || 'Order placement failed');
    }
  } catch (error) {
    console.error(`❌ HubnetGH API error:`, error.response?.data || error.message);
    
    const errorMessage = error.response?.data?.message || 
                         error.response?.data?.error || 
                         error.message || 
                         'Order delivery failed';
    
    const enhancedError = new Error(errorMessage);
    enhancedError.status = error.response?.status || 500;
    enhancedError.details = error.response?.data || null;
    
    // Map HubnetGH error codes
    if (errorMessage.toLowerCase().includes('balance') || 
        errorMessage.toLowerCase().includes('insufficient') ||
        error.response?.status === 402) {
      enhancedError.status = 402;
    }
    if (errorMessage.toLowerCase().includes('product not found') ||
        errorMessage.toLowerCase().includes('bundle')) {
      enhancedError.status = 404;
    }
    if (errorMessage.toLowerCase().includes('rate limit')) {
      enhancedError.status = 429;
    }
    
    throw enhancedError;
  }
}

/**
 * Paystack webhook handler
 */
async function handlePaystackWebhook(req, res) {
  console.log(`📨 Webhook received at ${req.path}`);

  if (!PAYSTACK_SECRET) {
    console.warn('⚠️ No Paystack secret configured — rejecting webhook');
    return res.status(401).send('Unauthorized');
  }

  // Verify Paystack signature
  const hash = crypto
    .createHmac('sha512', PAYSTACK_SECRET)
    .update(req.body)
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    console.warn('⚠️ Paystack webhook: invalid signature — rejected');
    return res.status(401).send('Unauthorized');
  }
  console.log(`✅ Signature verified`);

  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch (err) {
    console.error('❌ Failed to parse webhook JSON:', err);
    return res.status(400).send('Bad JSON');
  }

  // Always respond 200 quickly
  res.sendStatus(200);

  // Only process charge.success events
  if (event.event !== 'charge.success') {
    console.log(`📝 Webhook event ignored: ${event.event}`);
    return;
  }

  const { reference, metadata, amount } = event.data;

  // Dedup check
  if (processedRefs.has(reference)) {
    console.warn(`⚠️ Duplicate webhook ignored: ${reference}`);
    return;
  }

  // Verify transaction with Paystack API
  let txData;
  try {
    console.log(`🔍 Verifying transaction: ${reference}`);
    const verifyRes = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
        timeout: 15000,
      }
    );

    txData = verifyRes.data?.data;

    if (!txData || txData.status !== 'success') {
      console.warn(`⚠️ Paystack verification failed: ${reference} status=${txData?.status}`);
      return;
    }

    if (process.env.NODE_ENV === 'production' && txData.domain === 'test') {
      console.warn(`⚠️ Test transaction rejected in production: ${reference}`);
      return;
    }

    if (txData.amount !== amount) {
      console.error(`🚨 AMOUNT MISMATCH! Ref: ${reference}`);
      console.error(`   Actual: ${(txData.amount / 100).toFixed(2)} GHS`);
      console.error(`   Webhook: ${(amount / 100).toFixed(2)} GHS`);
      return;
    }

    console.log(`✅ Transaction verified: ${reference} | GH₵${(txData.amount / 100).toFixed(2)}`);
  } catch (err) {
    console.error(`❌ Verification error for ${reference}:`, err.response?.data || err.message);
    return;
  }

  processedRefs.add(reference);

  const phone = metadata?.phone;
  const volumeInGB = metadata?.volumeInGB;
  const networkType = metadata?.networkType;

  console.log(`💰 Payment confirmed: ${reference} | GH₵${(amount / 100).toFixed(2)}`);

  if (!phone || !volumeInGB || !networkType) {
    console.error(`❌ Missing metadata for: ${reference}`, { metadata });
    processedRefs.delete(reference);
    return;
  }

  // Auto-deliver after verified payment
  try {
    console.log(`🚀 Auto-delivering: ${reference}`);
    const result = await deliverData(phone, Number(volumeInGB), networkType, reference);
    console.log(`🎉 Auto-delivery successful! HubnetGH Order #${result.hubnetghOrderId}`);
  } catch (err) {
    console.error(`❌ Auto-delivery failed for ${reference}:`, err.message);
    processedRefs.delete(reference);
  }
}

// ─────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    apiProvider: 'HubnetGH',
    backendUrl: SELF_URL,
    hubnetghConfigured: !!(HUBNETGH_API_KEY && HUBNETGH_API_KEY.length > 5),
    paystackConfigured: !!(PAYSTACK_SECRET && PAYSTACK_SECRET.length > 5),
    deliverProtected: !!(DELIVER_SECRET && DELIVER_SECRET.length > 5),
    uptime: process.uptime()
  });
});

// Wallet balance - proxies HubnetGH GET /check_balance
app.get('/api/balance', async (req, res) => {
  if (!HUBNETGH_API_KEY) {
    return res.status(500).json({ 
      status: 'error', 
      message: 'HubnetGH API key not configured on server' 
    });
  }
  
  try {
    const response = await axios.get(`${HUBNETGH_API_URL}/check_balance`, {
      headers: { 'X-API-KEY': HUBNETGH_API_KEY },
      timeout: 10000
    });
    
    // HubnetGH returns: { success: true, wallet_balance: 115.50 }
    if (response.data && response.data.success === true) {
      res.json({
        status: 'success',
        data: {
          balance: response.data.wallet_balance !== undefined ? 
                   parseFloat(response.data.wallet_balance) : 0
        }
      });
    } else {
      res.status(500).json({ 
        status: 'error', 
        message: response.data?.message || 'Failed to fetch balance from HubnetGH' 
      });
    }
  } catch (err) {
    console.error('Balance error:', err.response?.data || err.message);
    
    // Check for specific HubnetGH errors
    if (err.response?.status === 401 || err.response?.status === 403) {
      return res.status(500).json({ 
        status: 'error', 
        message: 'HubnetGH API key invalid or not approved' 
      });
    }
    
    res.status(500).json({ 
      status: 'error', 
      message: err.response?.data?.message || 'Failed to fetch balance from HubnetGH' 
    });
  }
});

// Available bundles (from server cache)
app.get('/api/bundles', async (req, res) => {
  const { network } = req.query;
  
  try {
    const networkKey = mapNetworkToHubnetGH(network || 'mtn');
    const prices = BUNDLE_PRICES[networkKey] || BUNDLE_PRICES.mtn;
    
    const bundles = Object.entries(prices).map(([volume, price]) => ({
      volumeInGB: parseInt(volume),
      price: price,
      network: networkKey,
      currency: 'GHS',
      label: `${volume}GB`
    }));
    
    res.json({
      status: 'success',
      data: bundles,
      network: networkKey,
      source: 'server_pricing_cache'
    });
  } catch (err) {
    console.error('Bundles error:', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to fetch bundles' });
  }
});

// Check price for specific bundle
app.post('/api/check-price', async (req, res) => {
  const { networkType, volumeInGB } = req.body;
  
  if (!networkType || !volumeInGB) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Missing required fields: networkType, volumeInGB' 
    });
  }
  
  try {
    const networkKey = mapNetworkToHubnetGH(networkType);
    const volumeKey = volumeInGB.toString();
    const price = BUNDLE_PRICES[networkKey]?.[volumeKey];
    
    if (price === undefined) {
      return res.status(404).json({ 
        status: 'error', 
        message: `Bundle not found: ${volumeInGB}GB on ${networkKey}`,
        availableVolumes: Object.keys(BUNDLE_PRICES[networkKey] || {})
      });
    }
    
    res.json({
      status: 'success',
      data: {
        price: price,
        volumeInGB: parseInt(volumeInGB),
        network: networkKey,
        currency: 'GHS'
      }
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Price check failed' });
  }
});

// Delivery endpoint - calls HubnetGH POST /place_order
app.post('/deliver', requireApiKey, async (req, res) => {
  console.log('📦 Delivery request:', JSON.stringify(req.body));

  let { phone, volumeInGB, networkType, ref } = req.body;
  
  // Support volumeInMB as alternative
  if (req.body.volumeInMB && !volumeInGB) {
    volumeInGB = Math.round(req.body.volumeInMB / 1024);
  }

  // Validate required fields
  if (!phone || !volumeInGB || !networkType) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Missing required fields: phone, volumeInGB, networkType' 
    });
  }

  // Validate phone format
  try {
    phone = formatPhoneForHubnetGH(phone);
  } catch (err) {
    return res.status(400).json({ status: 'error', message: err.message });
  }

  const normalizedNetwork = mapNetworkToHubnetGH(networkType);
  const volumeNum = Number(volumeInGB);
  
  if (isNaN(volumeNum) || volumeNum <= 0 || !Number.isInteger(volumeNum)) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'volumeInGB must be a positive integer (1, 2, 5, 10, 20, or 50)' 
    });
  }

  // Check if bundle exists in our pricing
  const volumeKey = volumeNum.toString();
  if (!BUNDLE_PRICES[normalizedNetwork]?.[volumeKey]) {
    console.warn(`⚠️ Unknown bundle: ${volumeInGB}GB on ${normalizedNetwork} — attempting anyway`);
  }

  try {
    const result = await deliverData(phone, volumeNum, normalizedNetwork, ref || null);

    res.json({
      status: 'success',
      message: result.message || 'Order placed successfully via HubnetGH',
      data: result.data,
      order_id: result.hubnetghOrderId
    });
  } catch (err) {
    console.error(`❌ POST /deliver error:`, err.message);
    
    let statusCode = 500;
    if (err.status === 402) statusCode = 402;
    else if (err.status === 404) statusCode = 404;
    else if (err.status === 429) statusCode = 429;
    
    let errorMessage = err.message;
    if (err.status === 402) {
      errorMessage = 'Insufficient wallet balance. Please top up your HubnetGH wallet.';
    }
    
    res.status(statusCode).json({ 
      status: 'error', 
      message: errorMessage,
      details: err.details || null
    });
  }
});

// Order status - proxies HubnetGH GET /order_status?order_id=X
app.get('/api/order-status/:orderId', async (req, res) => {
  const { orderId } = req.params;

  if (!orderId) {
    return res.status(400).json({ status: 'error', message: 'Order ID is required' });
  }

  if (!HUBNETGH_API_KEY) {
    return res.status(500).json({ status: 'error', message: 'HubnetGH API key not configured' });
  }

  try {
    console.log(`🔍 Checking HubnetGH order status: ${orderId}`);

    const response = await axios.get(
      `${HUBNETGH_API_URL}/order_status?order_id=${encodeURIComponent(orderId)}`,
      {
        headers: { 'X-API-KEY': HUBNETGH_API_KEY },
        timeout: 10000
      }
    );

    // HubnetGH returns: { success: true, order_id, status, status_label, customer_number, network, volume, total, created_at }
    const orderData = response.data;
    console.log(`✅ Status for #${orderId}: ${orderData.status} (${orderData.status_label})`);
    
    res.json({
      status: 'success',
      data: {
        order_id: orderData.order_id,
        status: orderData.status,
        status_label: orderData.status_label,
        customer_number: orderData.customer_number,
        network: orderData.network,
        volume: orderData.volume,
        total: orderData.total,
        created_at: orderData.created_at
      }
    });
  } catch (err) {
    console.error(`❌ Status check failed for #${orderId}:`, err.response?.data || err.message);

    if (err.response?.status === 404) {
      return res.status(404).json({
        status: 'error',
        message: `Order #${orderId} not found on HubnetGH`
      });
    }

    res.status(500).json({
      status: 'error',
      message: err.response?.data?.message || 'Failed to fetch order status from HubnetGH'
    });
  }
});

// Failed deliveries (placeholder)
app.get('/api/deliveries/failed', async (req, res) => {
  res.json({
    status: 'info',
    message: 'Failed delivery tracking available via Firebase only',
    data: [],
    total: 0
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    status: 'error', 
    message: `Route not found: ${req.method} ${req.url}`,
    availableEndpoints: [
      'GET /',
      'GET /health',
      'GET /api/balance',
      'GET /api/bundles?network=mtn',
      'POST /api/check-price',
      'POST /deliver',
      'GET /api/order-status/:orderId',
      'POST /paystack-webhook'
    ]
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('💥 Server error:', err.stack);
  res.status(500).json({ status: 'error', message: 'Internal server error' });
});

// ─────────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   🚀 DataFlow Backend v2.0.1 (HubnetGH)                      ║
║                                                              ║
║   📡 Port: ${PORT}                                            ║
║   🌐 URL:  ${SELF_URL}                                        ║
║                                                              ║
║   🔑 HubnetGH: ${HUBNETGH_API_KEY ? '✅ Configured' : '❌ NOT SET'}                            ║
║   💳 Paystack:  ${PAYSTACK_SECRET ? '✅ Configured' : '❌ NOT SET'}                            ║
║   🔒 Deliver:   ${DELIVER_SECRET ? '✅ Protected' : '❌ NOT SET'}                            ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
});

// Keep-alive ping for Render free tier (every 2 minutes)
if (process.env.NODE_ENV === 'production' || !process.env.NODE_ENV) {
  const KEEP_ALIVE_INTERVAL = 2 * 60 * 1000; // 2 minutes
  setInterval(async () => {
    try {
      const res = await axios.get(`${SELF_URL}/health`, { timeout: 10000 });
      console.log(`💓 Keep-alive ping OK - ${new Date().toISOString()}`);
    } catch (err) {
      console.error(`⚠️ Keep-alive ping failed: ${err.message}`);
    }
  }, KEEP_ALIVE_INTERVAL);
  
  console.log(`🔄 Keep-alive pings enabled (every ${KEEP_ALIVE_INTERVAL / 60000} minutes)`);
}

module.exports = app;
