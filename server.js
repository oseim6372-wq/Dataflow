require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────
const REMADATA_API_URL = 'https://remadata.com/api';
const REMADATA_API_KEY  = process.env.REMADATA_API_KEY  || '';
const PAYSTACK_SECRET   = process.env.PAYSTACK_SECRET   || '';
const SELF_URL          = process.env.SELF_URL          || `http://localhost:${PORT}`;
const DELIVER_SECRET    = process.env.DELIVER_SECRET    || '';

// MTN KYC API Configuration - OAuth2
const MTN_API_URL = 'https://api.mtn.com/v1/customers';
const MTN_TOKEN_URL = 'https://api.mtn.com/oauth/client_credential/accesstoken';
const MTN_CLIENT_ID = process.env.MTN_CLIENT_ID || '';      // Your API key / client ID
const MTN_CLIENT_SECRET = process.env.MTN_CLIENT_SECRET || ''; // The customer secret they gave you
const MTN_API_KEY = process.env.MTN_API_KEY || ''; // Optional: x-api-key if still needed

// Token cache
let mtnAccessToken = null;
let tokenExpiresAt = null;

// In-memory dedup set (resets on server restart)
const processedRefs = new Set();

// ─────────────────────────────────────────────
//  MIDDLEWARE
// ─────────────────────────────────────────────
app.post('/paystack-webhook', express.raw({ type: 'application/json' }), handlePaystackWebhook);
app.post('/webhook/paystack', express.raw({ type: 'application/json' }), handlePaystackWebhook);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
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
//  MTN OAUTH2 TOKEN MANAGEMENT
// ─────────────────────────────────────────────

/**
 * Get OAuth2 access token from MTN
 * Uses client credentials flow (application scope)
 */
async function getMtnAccessToken() {
  // Check if we have a valid cached token (with 5 min buffer)
  if (mtnAccessToken && tokenExpiresAt && Date.now() < tokenExpiresAt - 5 * 60 * 1000) {
    console.log('✅ Using cached MTN access token');
    return mtnAccessToken;
  }

  if (!MTN_CLIENT_ID || !MTN_CLIENT_SECRET) {
    throw new Error('MTN_CLIENT_ID and MTN_CLIENT_SECRET environment variables are required');
  }

  console.log('🔄 Fetching new MTN OAuth2 token...');

  try {
    // Create Basic Auth header
    const credentials = Buffer.from(`${MTN_CLIENT_ID}:${MTN_CLIENT_SECRET}`).toString('base64');

    const response = await axios.post(
      MTN_TOKEN_URL,
      'grant_type=client_credentials',
      {
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 15000
      }
    );

    const { access_token, expires_in } = response.data;

    if (!access_token) {
      throw new Error('No access token received from MTN');
    }

    // Cache the token (expires_in is in seconds)
    mtnAccessToken = access_token;
    tokenExpiresAt = Date.now() + (expires_in * 1000);

    console.log(`✅ MTN OAuth2 token obtained. Expires in ${expires_in} seconds`);
    return mtnAccessToken;

  } catch (error) {
    console.error('❌ Failed to get MTN OAuth2 token:', error.response?.data || error.message);
    throw new Error(`MTN authentication failed: ${error.response?.data?.error_description || error.message}`);
  }
}

/**
 * Make an authenticated request to MTN API
 * Automatically handles token refresh
 */
async function mtnApiRequest(endpoint, options = {}) {
  const token = await getMtnAccessToken();
  
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    ...options.headers
  };
  
  // Add x-api-key if provided (hybrid auth)
  if (MTN_API_KEY) {
    headers['x-api-key'] = MTN_API_KEY;
  }

  try {
    const response = await axios({
      method: options.method || 'GET',
      url: `${MTN_API_URL}${endpoint}`,
      headers,
      data: options.data,
      timeout: options.timeout || 15000
    });
    return response;
  } catch (error) {
    // If token expired, clear cache and retry once
    if (error.response?.status === 401) {
      console.log('⚠️ Token may have expired, clearing cache and retrying...');
      mtnAccessToken = null;
      tokenExpiresAt = null;
      
      const newToken = await getMtnAccessToken();
      const retryHeaders = {
        'Authorization': `Bearer ${newToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        ...options.headers
      };
      if (MTN_API_KEY) retryHeaders['x-api-key'] = MTN_API_KEY;
      
      const retryResponse = await axios({
        method: options.method || 'GET',
        url: `${MTN_API_URL}${endpoint}`,
        headers: retryHeaders,
        data: options.data,
        timeout: options.timeout || 15000
      });
      return retryResponse;
    }
    throw error;
  }
}

// ─────────────────────────────────────────────
//  MTN KYC HELPER FUNCTIONS
// ─────────────────────────────────────────────

/**
 * Format phone number to E.123 standard for MTN API
 * Converts: 024XXXXXXX → 23324XXXXXXX
 */
function formatPhoneForMtn(phone) {
  let formatted = phone.replace(/\s+/g, '').replace(/-/g, '');
  
  if (formatted.startsWith('0')) {
    formatted = '233' + formatted.substring(1);
  }
  if (formatted.startsWith('+')) {
    formatted = formatted.substring(1);
  }
  
  return formatted;
}

/**
 * Validate MTN phone number
 * MTN Ghana prefixes: 024, 054, 055, 059, 053
 */
function isValidMtnNumber(phone) {
  const cleanPhone = phone.replace(/\s+/g, '').replace(/-/g, '');
  const mtnPrefixes = ['024', '054', '055', '059', '053'];
  const prefix = cleanPhone.substring(0, 3);
  
  if (cleanPhone.startsWith('0') && mtnPrefixes.includes(prefix)) {
    return true;
  }
  
  if (cleanPhone.startsWith('233')) {
    const localPrefix = cleanPhone.substring(3, 6);
    return mtnPrefixes.includes(localPrefix);
  }
  
  return false;
}

/**
 * Fetch KYC details from MTN API using OAuth2
 */
async function fetchMtnKyc(phoneNumber) {
  const formattedPhone = formatPhoneForMtn(phoneNumber);
  const transactionId = `DF-KYC-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  
  console.log(`🔍 Looking up KYC for: ${phoneNumber} → ${formattedPhone}`);
  console.log(`📝 Transaction ID: ${transactionId}`);
  
  try {
    const response = await mtnApiRequest(`/${formattedPhone}/kyc`, {
      method: 'GET',
      headers: {
        'transactionId': transactionId
      },
      timeout: 15000
    });
    
    console.log(`✅ KYC lookup successful for: ${phoneNumber}`);
    return {
      success: true,
      data: response.data
    };
  } catch (error) {
    console.error(`❌ KYC lookup failed for ${phoneNumber}:`, error.response?.status, error.response?.data || error.message);
    
    if (error.response?.status === 404) {
      return {
        success: false,
        error: 'Customer not found in MTN records',
        statusCode: 404
      };
    } else if (error.response?.status === 401 || error.response?.status === 403) {
      return {
        success: false,
        error: 'API authentication failed. Please check MTN credentials.',
        statusCode: error.response.status
      };
    } else {
      return {
        success: false,
        error: error.response?.data?.message || 'Failed to fetch customer KYC data',
        statusCode: error.response?.status || 500
      };
    }
  }
}

// ─────────────────────────────────────────────
//  HELPER FUNCTIONS
// ─────────────────────────────────────────────

async function deliverData(phone, volumeInMB, networkType, reference = null) {
  const orderRef = reference || `DF-${Date.now()}`;

  let formattedPhone = phone.replace(/\s+/g, '').replace(/-/g, '');
  if (formattedPhone.startsWith('0')) {
    formattedPhone = '233' + formattedPhone.substring(1);
  }
  if (formattedPhone.startsWith('+')) {
    formattedPhone = formattedPhone.substring(1);
  }

  const payload = {
    ref:         orderRef,
    phone:       formattedPhone,
    volumeInMB:  Number(volumeInMB),
    networkType: networkType.toLowerCase()
  };

  console.log(`📦 Delivering ${volumeInMB}MB (${networkType}) → ${phone} | Ref: ${orderRef}`);

  try {
    const response = await axios.post(
      `${REMADATA_API_URL}/buy-data`,
      payload,
      {
        headers: {
          'X-API-KEY':    REMADATA_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );
    console.log(`✅ Delivery success:`, response.data);

    const remaReference = response.data?.data?.reference || response.data?.reference || orderRef;

    return {
      success: true,
      data: response.data,
      remaDataRef: remaReference
    };
  } catch (error) {
    console.error(`❌ Delivery failed:`, error.response?.data || error.message);

    const enhancedError = new Error(
      error.response?.data?.message ||
      error.response?.data?.error ||
      error.message ||
      'Delivery failed'
    );
    enhancedError.status = error.response?.status || 500;
    enhancedError.details = error.response?.data || null;
    enhancedError.code = error.code;

    throw enhancedError;
  }
}

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
      return;
    }

    console.log(`✅ Transaction verified: ${reference} | Amount: ${(txData.amount / 100).toFixed(2)} GHS`);

  } catch (err) {
    console.error(`❌ Paystack API verification error:`, err.message);
    return;
  }

  processedRefs.add(reference);

  const phone = metadata?.phone;
  const volumeInMB = metadata?.volumeInMB;
  const networkType = metadata?.networkType;

  console.log(`💰 Payment received: ${reference}`);

  if (!phone || !volumeInMB || !networkType) {
    console.error(`❌ Webhook missing delivery metadata for ref: ${reference}`);
    processedRefs.delete(reference);
    return;
  }

  try {
    console.log(`🚀 Auto-delivering after verified payment: ${reference}`);
    const result = await deliverData(phone, Number(volumeInMB), networkType, reference);
    console.log(`🎉 Auto-delivery successful! RemaData Ref: ${result.remaDataRef}`);
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
    remadataConfigured: !!REMADATA_API_KEY && REMADATA_API_KEY !== '',
    paystackConfigured: !!PAYSTACK_SECRET && PAYSTACK_SECRET !== '',
    deliverProtected:   !!DELIVER_SECRET  && DELIVER_SECRET  !== '',
    mtnKycConfigured:   !!(MTN_CLIENT_ID && MTN_CLIENT_SECRET),
    endpoints: ['/deliver', '/api/balance', '/api/order-status/:ref', '/paystack-webhook', '/api/bundles', '/api/orders', '/api/kyc/lookup']
  });
});

// Wallet balance
app.get('/api/balance', async (req, res) => {
  try {
    const response = await axios.get(`${REMADATA_API_URL}/wallet-balance`, {
      headers: { 'X-API-KEY': REMADATA_API_KEY },
      timeout: 10000
    });
    res.json(response.data);
  } catch (err) {
    console.error('Balance error:', err.response?.data || err.message);
    res.status(500).json({ status: 'error', message: err.response?.data?.message || 'Failed to fetch balance' });
  }
});

// Available bundles
app.get('/api/bundles', async (req, res) => {
  const { network } = req.query;
  try {
    let url = `${REMADATA_API_URL}/bundles`;
    if (network) url += `?network=${network}`;
    const response = await axios.get(url, {
      headers: { 'X-API-KEY': REMADATA_API_KEY },
      timeout: 10000
    });
    res.json(response.data);
  } catch (err) {
    console.error('Bundles error:', err.response?.data || err.message);
    res.status(500).json({ status: 'error', message: 'Failed to fetch bundles' });
  }
});

// Check price
app.post('/api/check-price', async (req, res) => {
  const { networkType, volumeInMB } = req.body;
  if (!networkType || !volumeInMB) {
    return res.status(400).json({ status: 'error', message: 'Missing required fields' });
  }
  try {
    const response = await axios.post(`${REMADATA_API_URL}/get-cost-price`,
      { networkType, volumeInMB: Number(volumeInMB) },
      { headers: { 'X-API-KEY': REMADATA_API_KEY, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Price check failed' });
  }
});

// ✅ MTN KYC LOOKUP ENDPOINT - Using OAuth2
// GET /api/kyc/lookup?phone=024XXXXXXX
app.get('/api/kyc/lookup', async (req, res) => {
  const { phone } = req.query;
  
  if (!phone) {
    return res.status(400).json({
      success: false,
      error: 'Phone number is required',
      code: 'MISSING_PHONE'
    });
  }
  
  if (!isValidMtnNumber(phone)) {
    return res.status(400).json({
      success: false,
      error: `Invalid or non-MTN number. MTN numbers start with 024, 054, 055, 053, or 059`,
      code: 'INVALID_NETWORK'
    });
  }
  
  if (!MTN_CLIENT_ID || !MTN_CLIENT_SECRET) {
    console.error('❌ MTN OAuth2 credentials not configured');
    return res.status(500).json({
      success: false,
      error: 'KYC service temporarily unavailable. Please contact support.',
      code: 'API_NOT_CONFIGURED'
    });
  }
  
  try {
    const result = await fetchMtnKyc(phone);
    
    if (!result.success) {
      return res.status(result.statusCode || 400).json({
        success: false,
        error: result.error,
        code: 'KYC_LOOKUP_FAILED'
      });
    }
    
    const kycData = result.data.data || result.data;
    
    const responseData = {
      success: true,
      data: {
        phone: phone,
        firstName: kycData.firstName || '',
        lastName: kycData.lastName || '',
        fullName: `${kycData.firstName || ''} ${kycData.lastName || ''}`.trim(),
        idType: kycData.idType || null,
        idNumber: kycData.idNumber || null,
        dateOfBirth: kycData.dateOfBirth || null,
        gender: kycData.gender || null
      },
      timestamp: new Date().toISOString()
    };
    
    console.log(`✅ KYC data returned for ${phone}: ${responseData.data.fullName}`);
    res.json(responseData);
    
  } catch (error) {
    console.error(`❌ Unexpected error in KYC lookup for ${phone}:`, error);
    res.status(500).json({
      success: false,
      error: 'An unexpected error occurred. Please try again later.',
      code: 'INTERNAL_ERROR'
    });
  }
});

// Token refresh endpoint (optional, for manual refresh)
app.post('/api/mtn/refresh-token', async (req, res) => {
  try {
    mtnAccessToken = null;
    tokenExpiresAt = null;
    const newToken = await getMtnAccessToken();
    res.json({
      success: true,
      message: 'Token refreshed successfully',
      expiresIn: Math.floor((tokenExpiresAt - Date.now()) / 1000)
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Delivery endpoint
app.post('/deliver', requireApiKey, async (req, res) => {
  console.log('📦 Received delivery request:', req.body);

  let { phone, volumeInMB, networkType, ref } = req.body;

  if (!phone || !volumeInMB || !networkType) {
    return res.status(400).json({ status: 'error', message: 'Missing required fields: phone, volumeInMB, networkType' });
  }

  phone = phone.replace(/\s+/g, '').replace(/-/g, '');
  if (!/^(0|233)[0-9]{9}$/.test(phone)) {
    return res.status(400).json({ status: 'error', message: 'Invalid phone number format' });
  }
  if (phone.startsWith('233')) phone = '0' + phone.substring(3);

  const validNetworks = ['mtn', 'telecel', 'airteltigo'];
  const normalizedNetwork = networkType.toLowerCase();
  if (!validNetworks.includes(normalizedNetwork)) {
    return res.status(400).json({ status: 'error', message: `Invalid network. Must be: ${validNetworks.join(', ')}` });
  }

  const volumeNum = Number(volumeInMB);
  if (isNaN(volumeNum) || volumeNum <= 0 || volumeNum < 10) {
    return res.status(400).json({ status: 'error', message: 'volumeInMB must be at least 10MB' });
  }

  try {
    const result = await deliverData(phone, volumeNum, normalizedNetwork, ref || null);
    res.json({
      status: 'success',
      message: 'Data delivered successfully',
      data: result.data,
      reference: result.remaDataRef
    });
  } catch (err) {
    console.error(`❌ POST /deliver error:`, err.message);
    let statusCode = err.status === 402 ? 402 : err.status === 401 ? 401 : 500;
    let errorMessage = err.message;
    if (err.status === 402) errorMessage = 'Insufficient wallet balance. Please top up.';
    res.status(statusCode).json({ status: 'error', message: errorMessage });
  }
});

// Order status
app.get('/api/order-status/:ref', async (req, res) => {
  const { ref } = req.params;

  if (!ref) {
    return res.status(400).json({ status: 'error', message: 'Reference is required' });
  }

  try {
    console.log(`🔍 Checking order status for ref: ${ref}`);

    const response = await axios.get(
      `${REMADATA_API_URL}/order-status/${encodeURIComponent(ref)}`,
      {
        headers: { 'X-API-KEY': REMADATA_API_KEY },
        timeout: 10000
      }
    );

    console.log(`✅ Status for ${ref}:`, response.data?.data?.status || response.data?.status);
    res.json(response.data);
  } catch (err) {
    console.error(`❌ Status check failed for ${ref}:`, err.response?.data || err.message);

    if (err.response?.status === 404) {
      return res.status(404).json({
        status: 'error',
        message: 'Order not found. The delivery may not have been initiated yet.'
      });
    }

    res.status(500).json({
      status: 'error',
      message: err.response?.data?.message || 'Failed to fetch order status'
    });
  }
});

// Order history
app.get('/api/orders', async (req, res) => {
  const { page = 1, per_page = 15, status, network, phone, ref_number, start_date, end_date } = req.query;
  const params = new URLSearchParams();
  if (page) params.append('page', page);
  if (per_page) params.append('per_page', per_page);
  if (status) params.append('status', status);
  if (network) params.append('network', network);
  if (phone) params.append('phone', phone);
  if (ref_number) params.append('ref_number', ref_number);
  if (start_date) params.append('start_date', start_date);
  if (end_date) params.append('end_date', end_date);

  try {
    const url = `${REMADATA_API_URL}/orders${params.toString() ? '?' + params.toString() : ''}`;
    const response = await axios.get(url, {
      headers: { 'X-API-KEY': REMADATA_API_KEY },
      timeout: 15000
    });
    res.json(response.data);
  } catch (err) {
    console.error('Orders fetch error:', err.response?.data || err.message);
    res.status(500).json({ status: 'error', message: 'Failed to fetch orders' });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ status: 'error', message: `Route ${req.method} ${req.url} not found` });
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
╔══════════════════════════════════════════════════════════════════════════════╗
║   🚀 DataFlow Backend Server Running                                          ║
║   📡 Port: ${PORT}                                                              ║
║   🌐 URL:  ${SELF_URL}                                                         ║
║   🔑 RemaData API: ${REMADATA_API_KEY ? '✅ Configured' : '❌ NOT SET'}                            ║
║   💳 Paystack:     ${PAYSTACK_SECRET  ? '✅ Configured' : '❌ NOT SET'}                              ║
║   🔒 /deliver key: ${DELIVER_SECRET   ? '✅ Configured' : '❌ NOT SET'}                              ║
║   📞 MTN KYC API:  ${(MTN_CLIENT_ID && MTN_CLIENT_SECRET) ? '✅ OAuth2 Configured' : '❌ NOT SET'}   ║
║                                                                                ║
║   📮 Endpoints:                                                                ║
║      POST /deliver                → Manual delivery 🔒                         ║
║      GET  /api/balance            → Wallet balance                             ║
║      GET  /api/order-status/:ref  → Order status ✓                             ║
║      POST /paystack-webhook       → Payment webhook                            ║
║      GET  /api/bundles            → Available bundles                          ║
║      GET  /api/orders             → Order history                              ║
║      GET  /api/kyc/lookup         → MTN SIM registration name lookup (OAuth2) ✓║
║      POST /api/mtn/refresh-token  → Manually refresh MTN token                 ║
║      GET  /health                 → Health check                               ║
╚════════════════════════════════════════════════════════════════════════════════╝
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
  
  // Also refresh MTN token periodically
  setInterval(async () => {
    try {
      await axios.post(`${SELF_URL}/api/mtn/refresh-token`, {}, { timeout: 10000 });
      console.log(`🔄 MTN token auto-refreshed - ${new Date().toISOString()}`);
    } catch (err) {
      console.error(`⚠️ MTN token refresh failed:`, err.message);
    }
  }, 50 * 60 * 1000); // Refresh every 50 minutes
}

module.exports = app;
