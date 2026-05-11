require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors({ origin: '*' }));

// ============================================================
// MTN KYC CONFIGURATION - USING OAUTH2 (CORRECT METHOD)
// ============================================================
const MTN_CLIENT_ID = process.env.MTN_CLIENT_ID || 'WsAWhYfZZaFckbrQFNqeYQlQnJLQ0QAu';     // Your Consumer Key
const MTN_CLIENT_SECRET = process.env.MTN_CLIENT_SECRET || 'DU1oXXXXXXXX5Nvd';            // Your Consumer Secret (from screenshot)
const MTN_TOKEN_URL = 'https://api.mtn.com/oauth/client_credential/accesstoken';
const MTN_API_BASE = 'https://api.mtn.com/v1/customers';

// Token cache
let cachedToken = null;
let tokenExpiry = null;

// ============================================================
// GET OAUTH2 ACCESS TOKEN
// ============================================================
async function getMtnAccessToken() {
  // Return cached token if still valid (with 5 min buffer)
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry - 300000) {
    console.log('📦 Using cached OAuth2 token');
    return cachedToken;
  }

  console.log('\n🔐 Getting OAuth2 token from MTN...');
  console.log(`   Client ID: ${MTN_CLIENT_ID.substring(0, 15)}...`);
  console.log(`   Token URL: ${MTN_TOKEN_URL}`);

  try {
    // Create Basic Auth header from Client ID and Secret
    const credentials = Buffer.from(`${MTN_CLIENT_ID}:${MTN_CLIENT_SECRET}`).toString('base64');

    const response = await axios.post(
      MTN_TOKEN_URL,
      'grant_type=client_credentials',
      {
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 30000
      }
    );

    if (response.data && response.data.access_token) {
      cachedToken = response.data.access_token;
      const expiresIn = response.data.expires_in || 3600;
      tokenExpiry = Date.now() + (expiresIn * 1000);
      
      console.log(`✅ OAuth2 token obtained! Expires in ${expiresIn} seconds`);
      console.log(`   Token: ${cachedToken.substring(0, 30)}...`);
      return cachedToken;
    } else {
      throw new Error('No access_token in response');
    }
  } catch (error) {
    console.error('❌ OAuth2 token error:');
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Data:`, error.response.data);
    } else {
      console.error(`   Message: ${error.message}`);
    }
    throw new Error(`MTN authentication failed: ${error.response?.data?.error_description || error.message}`);
  }
}

// ============================================================
// FORMAT PHONE NUMBER TO E.123 STANDARD
// ============================================================
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

// ============================================================
// VALIDATE MTN PHONE NUMBER
// ============================================================
function isValidMtnNumber(phone) {
  const cleanPhone = phone.replace(/\s+/g, '').replace(/-/g, '');
  const mtnPrefixes = ['024', '054', '055', '059', '053'];
  if (cleanPhone.startsWith('0')) {
    return mtnPrefixes.includes(cleanPhone.substring(0, 3));
  }
  if (cleanPhone.startsWith('233')) {
    return mtnPrefixes.includes(cleanPhone.substring(3, 6));
  }
  return false;
}

// ============================================================
// FETCH KYC FROM MTN - USING OAUTH2 BEARER TOKEN
// ============================================================
async function fetchMtnKyc(phoneNumber) {
  const formattedPhone = formatPhoneForMtn(phoneNumber);
  const transactionId = `DF-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  const url = `${MTN_API_BASE}/${formattedPhone}/kyc`;

  console.log(`\n📞 KYC Request:`);
  console.log(`   Original: ${phoneNumber}`);
  console.log(`   Formatted: ${formattedPhone}`);
  console.log(`   URL: ${url}`);
  console.log(`   Transaction ID: ${transactionId}`);

  try {
    const token = await getMtnAccessToken();

    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'transactionId': transactionId
      },
      timeout: 30000
    });

    console.log(`✅ KYC Success! Status: ${response.status}`);

    const kycData = response.data?.data || response.data;

    return {
      success: true,
      data: {
        firstName: kycData?.firstName || '',
        lastName: kycData?.lastName || '',
        fullName: `${kycData?.firstName || ''} ${kycData?.lastName || ''}`.trim(),
        idType: kycData?.idType || null,
        idNumber: kycData?.idNumber || null,
        dateOfBirth: kycData?.dateOfBirth || null,
        gender: kycData?.gender || null
      }
    };

  } catch (error) {
    console.error(`❌ KYC Failed:`);

    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Data:`, JSON.stringify(error.response.data, null, 2));

      if (error.response.status === 404) {
        return { success: false, error: 'Customer not found in MTN records. Please check the number.' };
      } else if (error.response.status === 401) {
        return { success: false, error: 'OAuth2 token invalid or expired. Please contact support.' };
      } else if (error.response.status === 403) {
        return { success: false, error: 'Access forbidden. Your credentials may not have KYC permissions.' };
      }
    } else if (error.request) {
      console.error(`   No response received`);
      return { success: false, error: 'Network error - Could not reach MTN servers.' };
    }

    return {
      success: false,
      error: error.response?.data?.message || 'Failed to fetch customer KYC data'
    };
  }
}

// ============================================================
// REMADATA CONFIGURATION
// ============================================================
const REMADATA_BASE = process.env.REMADATA_BASE || 'https://api.remadata.net';
const REMADATA_TOKEN = process.env.REMADATA_TOKEN || '';
const REMADATA_SENDER = process.env.REMADATA_SENDER || '';

// ============================================================
// HEALTH CHECK ENDPOINT
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    mtnOAuthConfigured: !!(MTN_CLIENT_ID && MTN_CLIENT_SECRET),
    remaDataConfigured: !!REMADATA_TOKEN,
    endpoints: [
      'GET  /api/bundles?network=mtn → List bundles',
      'POST /deliver → Deliver bundle',
      'GET  /api/kyc/lookup?phone=024XXXXXX → KYC name lookup (OAuth2)',
      'GET  /health → Health check'
    ]
  });
});

// ============================================================
// BUNDLES ENDPOINT
// ============================================================
app.get('/api/bundles', async (req, res) => {
  const { network } = req.query;

  console.log(`\n📦 Bundles Request — network: ${network}`);

  if (!network) {
    return res.status(400).json({ status: 'error', message: 'network query param required' });
  }

  const networkMap = {
    mtn: 'MTN',
    telecel: 'TELECEL',
    airteltigo: 'AIRTELTIGO'
  };
  const remaNetwork = networkMap[network.toLowerCase()];
  if (!remaNetwork) {
    return res.status(400).json({ status: 'error', message: `Unknown network: ${network}` });
  }

  try {
    const response = await axios.get(`${REMADATA_BASE}/api/v1/bundles`, {
      headers: {
        'Authorization': `Bearer ${REMADATA_TOKEN}`,
        'Accept': 'application/json'
      },
      params: { network: remaNetwork },
      timeout: 15000
    });

    const raw = response.data?.data || response.data || [];
    const bundles = (Array.isArray(raw) ? raw : []).map(b => ({
      volumeInMB: Number(b.volume || b.volumeInMB || b.size || 0),
      price: parseFloat(b.price || b.amount || 0),
      name: b.name || b.description || '',
      network: remaNetwork
    })).filter(b => b.volumeInMB > 0 && b.price > 0);

    console.log(`✅ Returning ${bundles.length} bundles for ${remaNetwork}`);
    res.json({ status: 'success', data: bundles });

  } catch (err) {
    console.error('❌ Bundles fetch error:', err.response?.status, err.response?.data || err.message);
    res.status(502).json({
      status: 'error',
      message: err.response?.data?.message || 'Failed to fetch bundles from provider'
    });
  }
});

// ============================================================
// DELIVER ENDPOINT
// ============================================================
app.post('/deliver', async (req, res) => {
  const { phone, networkType, volumeInMB, ref } = req.body;

  console.log('\n=========================================');
  console.log('🚀 Delivery Request');
  console.log(`   Phone:       ${phone}`);
  console.log(`   Network:     ${networkType}`);
  console.log(`   VolumeInMB:  ${volumeInMB}`);
  console.log(`   Ref:         ${ref}`);
  console.log('=========================================');

  if (!phone || !networkType || !volumeInMB || !ref) {
    return res.status(400).json({
      status: 'error',
      message: 'Missing required fields: phone, networkType, volumeInMB, ref'
    });
  }

  const networkMap = {
    mtn: 'MTN',
    telecel: 'TELECEL',
    airteltigo: 'AIRTELTIGO'
  };
  const remaNetwork = networkMap[networkType.toLowerCase()] || networkType.toUpperCase();

  try {
    const payload = {
      phone: phone.startsWith('0') ? '233' + phone.substring(1) : phone,
      network: remaNetwork,
      volume: Number(volumeInMB),
      ref: ref,
      sender: REMADATA_SENDER
    };

    console.log('📤 Sending to RemaData:', payload);

    const response = await axios.post(`${REMADATA_BASE}/api/v1/send`, payload, {
      headers: {
        'Authorization': `Bearer ${REMADATA_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 30000
    });

    const result = response.data;
    console.log('✅ RemaData response:', JSON.stringify(result, null, 2));

    if (result.status === 'success' || result.success === true) {
      res.json({
        status: 'success',
        message: result.message || 'Bundle delivered successfully',
        reference: result.reference || result.data?.reference || ref,
        orderId: ref
      });
    } else {
      console.warn('⚠️ RemaData returned non-success:', result);
      res.status(400).json({
        status: 'error',
        message: result.message || 'Delivery failed. Please check provider logs.'
      });
    }

  } catch (err) {
    console.error('❌ Delivery error:', err.response?.status, err.response?.data || err.message);
    res.status(502).json({
      status: 'error',
      message: err.response?.data?.message || 'Failed to deliver bundle. Please retry.'
    });
  }
});

// ============================================================
// KYC LOOKUP ENDPOINT - USING OAUTH2
// ============================================================
app.get('/api/kyc/lookup', async (req, res) => {
  const { phone } = req.query;

  console.log('\n=========================================');
  console.log('📞 KYC Lookup Request (OAuth2)');
  console.log(`   Phone: ${phone}`);
  console.log('=========================================');

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
      error: 'Invalid MTN number. MTN numbers start with 024, 054, 055, 053, or 059',
      code: 'INVALID_NETWORK'
    });
  }

  if (!MTN_CLIENT_ID || !MTN_CLIENT_SECRET) {
    return res.status(500).json({
      success: false,
      error: 'KYC service not configured - missing OAuth2 credentials',
      code: 'NO_CREDENTIALS'
    });
  }

  try {
    const result = await fetchMtnKyc(phone);

    if (result.success) {
      console.log(`✅ Returning KYC data for ${phone}: ${result.data.fullName}`);
      res.json({
        success: true,
        data: result.data,
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.error,
        code: 'KYC_LOOKUP_FAILED'
      });
    }
  } catch (error) {
    console.error('❌ Unexpected error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error. Please try again.',
      code: 'INTERNAL_ERROR'
    });
  }
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║   🚀 DataFlow Backend Server Running (OAuth2)                ║
║   📡 Port: ${PORT}                                              ║
║   🔑 MTN OAuth2: ${MTN_CLIENT_ID && MTN_CLIENT_SECRET ? '✅ Configured' : '❌ MISSING'}   ║
║   📦 RemaData:   ${REMADATA_TOKEN ? '✅ Configured' : '❌ MISSING'}                       ║
║                                                              ║
║   📮 Endpoints:                                              ║
║      GET /api/kyc/lookup?phone=024XXXXXX  → KYC lookup      ║
║      GET /api/bundles?network=mtn         → Bundles list    ║
║      POST /deliver                         → Deliver bundle  ║
║      GET /health                           → Health check    ║
║                                                              ║
║   📝 Test KYC:                                              ║
║      curl "http://localhost:${PORT}/api/kyc/lookup?phone=0244502480" ║
╚══════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
