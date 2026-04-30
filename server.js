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
  allowedHeaders: ['Content-Type', 'X-API-KEY', 'X-Paystack-Signature']
}));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ─────────────────────────────────────────────
//  ROOT ROUTE - Fixes 404 on base URL
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    name: 'DataFlow Backend API',
    version: '2.0.0',
    provider: 'HubnetGH',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: 'GET /health',
      balance: 'GET /api/balance',
      bundles: 'GET /api/bundles?network=mtn',
      checkPrice: 'POST /api/check-price',
      deliver: 'POST /deliver (requires API key)',
      orderStatus: 'GET /api/order-status/:orderId',
      webhook: 'POST /paystack-webhook'
    },
    docs: 'Contact support for API documentation'
  });
});

// ─────────────────────────────────────────────
//  AUTH MIDDLEWARE
// ─────────────────────────────────────────────
function requireApiKey(req, res, next) {
  if (!DELIVER_SECRET) {
    console.warn('⚠️ DELIVER_SECRET not configured — /deliver is unprotected!');
    return res.status(500).json({ status: 'error', message: 'Server misconfiguration: DELIVER_SECRET not set' });
  }
  const key = req.headers['x-api-key'] || req.body?.apiKey;
  if (!key || key !== DELIVER_SECRET) {
    console.warn(`🚫 Unauthorized /deliver attempt from ${req.ip}`);
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }
  next();
}

// ─────────────────────────────────────────────
//  HELPER FUNCTIONS
// ─────────────────────────────────────────────

/**
 * Format phone number for HubnetGH API
 */
function formatPhoneForHubnetGH(phone) {
  let formatted = phone.replace(/\s+/g, '').replace(/-/g, '');
  
  if (formatted.startsWith('+')) {
    formatted = formatted.substring(1);
  }
  
  if (formatted.startsWith('0')) {
    formatted = '233' + formatted.substring(1);
  }
  
  if (!/^233[0-9]{9}$/.test(formatted)) {
    throw new Error(`Invalid phone number format: ${phone}. Expected Ghana number.`);
  }
  
  return formatted;
}

/**
 * Map network type to HubnetGH format
 */
function mapNetworkToHubnetGH(networkType) {
  const networkMap = {
    'mtn': 'mtn',
    'telecel': 'telecel',
    'airteltigo': 'airteltigo',
    'tel': 'telecel',
    'at': 'airteltigo'
  };
  return networkMap[networkType.toLowerCase()] || networkType.toLowerCase();
}

/**
 * Core delivery function - calls HubnetGH API
 */
async function deliverData(phone, volumeInGB, networkType, reference = null) {
  const orderRef = reference || `DF-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const hubnetNetwork = mapNetworkToHubnetGH(networkType);
  const formattedPhone = formatPhoneForHubnetGH(phone);
  const volumeStr = volumeInGB.toString();

  const payload = {
    network: hubnetNetwork,
    volume: volumeStr,
    customer_number: formattedPhone,
    quantity: 1,
    request_id: orderRef
  };

  console.log(`📦 Placing order with HubnetGH: ${volumeInGB}GB (${hubnetNetwork}) → ${phone} | Ref: ${orderRef}`);
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
    
    console.log(`✅ HubnetGH response:`, response.data);

    if (response.data.success) {
      return {
        success: true,
        data: response.data,
        hubnetghOrderId: response.data.order_id,
        message: response.data.message
      };
    } else {
      throw new Error(response.data.message || 'Order placement failed');
    }
  } catch (error) {
    console.error(`❌ HubnetGH API error:`, error.response?.data || error.message);
    
    const enhancedError = new Error(
      error.response?.data?.message ||
      error.response?.data?.error ||
      error.message ||
      'Order delivery failed'
    );
    enhancedError.status = error.response?.status || 500;
    enhancedError.details = error.response?.data || null;
    enhancedError.code = error.code;
    
    if (enhancedError.message.toLowerCase().includes('balance') || 
        error.response?.status === 402) {
      enhancedError.status = 402;
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

  const hash = crypto
    .createHmac('sha512', PAYSTACK_SECRET)
    .update(req.body)
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    console.warn('⚠️ Paystack webhook: invalid signature — rejected');
    return res.status(401).send('Unauthorized');
  }
  console.log(`✅ Signature verified successfully`);

  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch (err) {
    console.error('❌ Failed to parse webhook JSON:', err);
    return res.status(400).send('Bad JSON');
  }

  res.sendStatus(200);

  if (event.event !== 'charge.success') {
    console.log(`📝 Webhook event ignored: ${event.event}`);
    return;
  }

  const { reference, metadata, amount } = event.data;

  if (processedRefs.has(reference)) {
    console.warn(`⚠️ Duplicate webhook ignored for ref: ${reference}`);
    return;
  }

  let txData;
  try {
    console.log(`🔍 Verifying transaction with Paystack API...`);
    const verifyRes = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
        timeout: 15000,
      }
    );

    txData = verifyRes.data?.data;

    if (!txData || txData.status !== 'success') {
      console.warn(`⚠️ Paystack API verification failed for ${reference}: status=${txData?.status}`);
      return;
    }

    if (process.env.NODE_ENV === 'production' && txData.domain === 'test') {
      console.warn(`⚠️ Test-mode transaction rejected in production: ${reference}`);
      return;
    }

    if (txData.amount !== amount) {
      console.error(`🚨 AMOUNT MISMATCH - FAKE TRANSACTION DETECTED!`);
      console.error(`   Transaction ${reference} actual amount: ${(txData.amount / 100).toFixed(2)} GHS`);
      console.error(`   Webhook claimed amount: ${(amount / 100).toFixed(2)} GHS`);
      return;
    }

    console.log(`✅ Transaction verified: ${reference} | Amount: ${(txData.amount / 100).toFixed(2)} GHS`);

  } catch (err) {
    console.error(`❌ Paystack API verification error for ${reference}:`, err.response?.data || err.message);
    return;
  }

  processedRefs.add(reference);

  const phone = metadata?.phone;
  const volumeInGB = metadata?.volumeInGB;
  const networkType = metadata?.networkType;

  console.log(`💰 Payment received: ${reference} | Amount: GH₵${(amount / 100).toFixed(2)}`);

  if (!phone || !volumeInGB || !networkType) {
    console.error(`❌ Webhook missing delivery metadata for ref: ${reference}`, { metadata });
    processedRefs.delete(reference);
    return;
  }

  try {
    console.log(`🚀 Auto-delivering after verified payment: ${reference}`);
    const result = await deliverData(phone, Number(volumeInGB), networkType, reference);
    console.log(`🎉 Auto-delivery successful! HubnetGH Order ID: ${result.hubnetghOrderId}`);
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
    hubnetghConfigured: !!HUBNETGH_API_KEY && HUBNETGH_API_KEY !== '',
    paystackConfigured: !!PAYSTACK_SECRET && PAYSTACK_SECRET !== '',
    deliverProtected:   !!DELIVER_SECRET && DELIVER_SECRET !== '',
    uptime: process.uptime(),
    endpoints: ['/deliver', '/api/balance', '/api/order-status/:id', '/paystack-webhook', '/api/bundles', '/api/orders']
  });
});

// Wallet balance
app.get('/api/balance', async (req, res) => {
  if (!HUBNETGH_API_KEY) {
    return res.status(500).json({ status: 'error', message: 'HubnetGH API key not configured' });
  }
  
  try {
    const response = await axios.get(`${HUBNETGH_API_URL}/check_balance`, {
      headers: { 'X-API-KEY': HUBNETGH_API_KEY },
      timeout: 10000
    });
    
    if (response.data.success) {
      res.json({
        status: 'success',
        data: {
          balance: response.data.wallet_balance
        }
      });
    } else {
      res.status(500).json({ status: 'error', message: response.data.message || 'Failed to fetch balance' });
    }
  } catch (err) {
    console.error('Balance error:', err.response?.data || err.message);
    res.status(500).json({ 
      status: 'error', 
      message: err.response?.data?.message || 'Failed to fetch balance from HubnetGH' 
    });
  }
});

// Available bundles
app.get('/api/bundles', async (req, res) => {
  const { network } = req.query;
  
  try {
    const networkKey = mapNetworkToHubnetGH(network || 'mtn');
    const prices = BUNDLE_PRICES[networkKey] || BUNDLE_PRICES.mtn;
    
    const bundles = Object.entries(prices).map(([volume, price]) => ({
      volumeInMB: parseInt(volume) * 1024,
      volumeInGB: parseInt(volume),
      price: price,
      network: networkKey,
      currency: 'GHS'
    }));
    
    res.json({
      status: 'success',
      data: bundles,
      source: 'cache'
    });
  } catch (err) {
    console.error('Bundles error:', err.message);
    res.status(500).json({ status: 'error', message: 'Failed to fetch bundles' });
  }
});

// Check price
app.post('/api/check-price', async (req, res) => {
  const { networkType, volumeInGB } = req.body;
  
  if (!networkType || !volumeInGB) {
    return res.status(400).json({ status: 'error', message: 'Missing required fields' });
  }
  
  try {
    const networkKey = mapNetworkToHubnetGH(networkType);
    const price = BUNDLE_PRICES[networkKey]?.[volumeInGB.toString()];
    
    if (!price) {
      return res.status(404).json({ status: 'error', message: 'Bundle not found' });
    }
    
    res.json({
      status: 'success',
      data: {
        price: price,
        volumeInGB: volumeInGB,
        network: networkKey
      }
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Price check failed' });
  }
});

// Delivery endpoint
app.post('/deliver', requireApiKey, async (req, res) => {
  console.log('📦 Received delivery request:', req.body);

  let { phone, volumeInGB, networkType, ref } = req.body;
  
  if (req.body.volumeInMB && !volumeInGB) {
    volumeInGB = Math.round(req.body.volumeInMB / 1024);
  }

  if (!phone || !volumeInGB || !networkType) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Missing required fields: phone, volumeInGB, networkType' 
    });
  }

  try {
    const formattedPhone = formatPhoneForHubnetGH(phone);
    phone = formattedPhone;
  } catch (err) {
    return res.status(400).json({ status: 'error', message: err.message });
  }

  const normalizedNetwork = mapNetworkToHubnetGH(networkType);
  const volumeNum = Number(volumeInGB);
  
  if (isNaN(volumeNum) || volumeNum <= 0) {
    return res.status(400).json({ status: 'error', message: 'volumeInGB must be a positive number' });
  }

  try {
    const result = await deliverData(phone, volumeNum, normalizedNetwork, ref || null);

    res.json({
      status: 'success',
      message: result.message || 'Order placed successfully',
      data: result.data,
      order_id: result.hubnetghOrderId
    });
  } catch (err) {
    console.error(`❌ POST /deliver error:`, err.message);
    let statusCode = err.status === 402 ? 402 : err.status === 401 ? 401 : 500;
    let errorMessage = err.message;
    if (err.status === 402) errorMessage = 'Insufficient wallet balance. Please top up your HubnetGH wallet.';
    res.status(statusCode).json({ status: 'error', message: errorMessage });
  }
});

// Order status
app.get('/api/order-status/:orderId', async (req, res) => {
  const { orderId } = req.params;

  if (!orderId) {
    return res.status(400).json({ status: 'error', message: 'Order ID is required' });
  }

  try {
    console.log(`🔍 Checking order status for HubnetGH ID: ${orderId}`);

    const response = await axios.get(
      `${HUBNETGH_API_URL}/order_status?order_id=${encodeURIComponent(orderId)}`,
      {
        headers: { 'X-API-KEY': HUBNETGH_API_KEY },
        timeout: 10000
      }
    );

    console.log(`✅ Status for ${orderId}:`, response.data?.status);
    
    const orderData = response.data;
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
    console.error(`❌ Status check failed for ${orderId}:`, err.response?.data || err.message);

    if (err.response?.status === 404) {
      return res.status(404).json({
        status: 'error',
        message: 'Order not found. The order may not have been processed yet.'
      });
    }

    res.status(500).json({
      status: 'error',
      message: err.response?.data?.message || 'Failed to fetch order status from HubnetGH'
    });
  }
});

// Orders history (use Firebase for this)
app.get('/api/orders', async (req, res) => {
  res.json({
    status: 'info',
    message: 'Order history not available from HubnetGH API. Use Firebase for order tracking.',
    data: [],
    total: 0
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    status: 'error', 
    message: `Route ${req.method} ${req.url} not found`,
    availableEndpoints: ['/', '/health', '/api/balance', '/api/bundles', '/api/check-price', '/deliver', '/api/order-status/:id', '/paystack-webhook']
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('💥 Server error:', err.stack);
  res.status(500).json({ status: 'error', message: 'Internal server error' });
});

// ─────────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║                                                                      ║
║   🚀 DataFlow Backend Server (HubnetGH Integration)                  ║
║                                                                      ║
║   📡 Port: ${PORT}                                                    ║
║   🌐 URL:  ${SELF_URL}                                                ║
║                                                                      ║
║   🔑 HubnetGH API: ${HUBNETGH_API_KEY ? '✅ Configured' : '❌ NOT SET'}                    ║
║   💳 Paystack:      ${PAYSTACK_SECRET ? '✅ Configured' : '❌ NOT SET'}                      ║
║   🔒 /deliver key:  ${DELIVER_SECRET ? '✅ Configured' : '❌ NOT SET'}                      ║
║                                                                      ║
║   📮 Endpoints:                                                      ║
║      GET  /                       → API information                  ║
║      POST /deliver                → Place order with HubnetGH 🔒     ║
║      GET  /api/balance            → HubnetGH wallet balance          ║
║      GET  /api/order-status/:id   → Check order status ✓             ║
║      POST /paystack-webhook       → Payment webhook handler          ║
║      GET  /api/bundles            → Available bundles/prices         ║
║      GET  /health                 → Health check                     ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝
  `);
});

// Keep-alive ping for production
if (process.env.NODE_ENV === 'production') {
  setInterval(async () => {
    try {
      await axios.get(`${SELF_URL}/health`, { timeout: 10000 });
      console.log(`💓 Keep-alive ping - ${new Date().toISOString()}`);
    } catch (err) {
      console.error(`⚠️ Keep-alive ping failed:`, err.message);
    }
  }, 4 * 60 * 1000);
}

module.exports = app;
