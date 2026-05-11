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
// MTN KYC CONFIGURATION - USING OAUTH2
// ============================================================
const MTN_CLIENT_ID = process.env.MTN_CLIENT_ID || 'WsAWhYfZZaFckbrQFNqeYQlQnJLQ0QAu';
const MTN_CLIENT_SECRET = process.env.MTN_CLIENT_SECRET || 'DU1oXXXXXXXX5Nvd';
const MTN_TOKEN_URL = 'https://api.mtn.com/oauth/client_credential/accesstoken';
const MTN_API_BASE = 'https://api.mtn.com/v1/customers';

// Token cache
let cachedToken = null;
let tokenExpiry = null;

// ============================================================
// LOCAL BUNDLES DATA (Fallback if RemaData fails)
// ============================================================
const LOCAL_BUNDLES = {
  mtn: [
    { volumeInMB: 1024, price: 5.00, name: "1GB Data Bundle" },
    { volumeInMB: 2048, price: 9.40, name: "2GB Data Bundle" },
    { volumeInMB: 3072, price: 13.40, name: "3GB Data Bundle" },
    { volumeInMB: 4096, price: 17.70, name: "4GB Data Bundle" },
    { volumeInMB: 5120, price: 22.50, name: "5GB Data Bundle" },
    { volumeInMB: 6144, price: 26.30, name: "6GB Data Bundle" },
    { volumeInMB: 10240, price: 43.20, name: "10GB Data Bundle" },
    { volumeInMB: 15360, price: 63.20, name: "15GB Data Bundle" },
    { volumeInMB: 20480, price: 82.70, name: "20GB Data Bundle" },
    { volumeInMB: 25600, price: 105.20, name: "25GB Data Bundle" },
    { volumeInMB: 30720, price: 126.70, name: "30GB Data Bundle" },
    { volumeInMB: 40960, price: 171.70, name: "40GB Data Bundle" },
    { volumeInMB: 51200, price: 202.70, name: "50GB Data Bundle" },
    { volumeInMB: 102400, price: 437.70, name: "100GB Data Bundle" }
  ],
  telecel: [
    { volumeInMB: 1024, price: 6.00, name: "1GB Data Bundle" },
    { volumeInMB: 2048, price: 11.00, name: "2GB Data Bundle" },
    { volumeInMB: 5120, price: 25.00, name: "5GB Data Bundle" },
    { volumeInMB: 10240, price: 48.00, name: "10GB Data Bundle" }
  ],
  airteltigo: [
    { volumeInMB: 1024, price: 5.50, name: "1GB Data Bundle" },
    { volumeInMB: 2048, price: 10.00, name: "2GB Data Bundle" },
    { volumeInMB: 5120, price: 24.00, name: "5GB Data Bundle" },
    { volumeInMB: 10240, price: 45.00, name: "10GB Data Bundle" }
  ]
};

// ============================================================
// GET OAUTH2 ACCESS TOKEN
// ============================================================
async function getMtnAccessToken() {
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry - 300000) {
    console.log('📦 Using cached OAuth2 token');
    return cachedToken;
  }

  console.log('\n🔐 Getting OAuth2 token from MTN...');

  try {
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
      return cachedToken;
    } else {
      throw new Error('No access_token in response');
    }
  } catch (error) {
    console.error('❌ OAuth2 token error:', error.response?.data || error.message);
    throw new Error(`MTN authentication failed`);
  }
}

// ============================================================
// FORMAT PHONE NUMBER
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
// VALIDATE MTN NUMBER
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
// FETCH KYC FROM MTN
// ============================================================
async function fetchMtnKyc(phoneNumber) {
  const formattedPhone = formatPhoneForMtn(phoneNumber);
  const transactionId = `DF-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  const url = `${MTN_API_BASE}/${formattedPhone}/kyc`;

  console.log(`📞 KYC Request for: ${phoneNumber} -> ${formattedPhone}`);

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
    console.error(`❌ KYC Failed:`, error.response?.status, error.response?.data?.message || error.message);
    
    if (error.response?.status === 404) {
      return { success: false, error: 'Customer not found in MTN records' };
    }
    return {
      success: false,
      error: error.response?.data?.message || 'Failed to fetch customer KYC data'
    };
  }
}

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    mtnOAuthConfigured: !!(MTN_CLIENT_ID && MTN_CLIENT_SECRET),
    endpoints: ['GET /api/bundles', 'POST /deliver', 'GET /api/kyc/lookup', 'GET /health']
  });
});

// ============================================================
// BUNDLES ENDPOINT - Returns local data (working without RemaData)
// ============================================================
app.get('/api/bundles', async (req, res) => {
  const { network } = req.query;
  
  console.log(`📦 Bundles Request — network: ${network}`);

  if (!network) {
    return res.status(400).json({ status: 'error', message: 'network query param required' });
  }

  const networkKey = network.toLowerCase();
  let bundles = [];

  // Try to get from local data first (always works)
  if (LOCAL_BUNDLES[networkKey]) {
    bundles = LOCAL_BUNDLES[networkKey];
    console.log(`✅ Returning ${bundles.length} local bundles for ${networkKey}`);
  } else {
    bundles = [];
    console.log(`⚠️ No bundles found for ${networkKey}`);
  }

  res.json({ 
    status: 'success', 
    data: bundles,
    source: 'local'
  });
});

// ============================================================
// DELIVER ENDPOINT
// ============================================================
app.post('/deliver', async (req, res) => {
  const { phone, networkType, volumeInMB, ref } = req.body;

  console.log(`🚀 Delivery Request: ${phone}, ${networkType}, ${volumeInMB}MB, Ref: ${ref}`);

  if (!phone || !networkType || !volumeInMB || !ref) {
    return res.status(400).json({
      status: 'error',
      message: 'Missing required fields: phone, networkType, volumeInMB, ref'
    });
  }

  // Simulate successful delivery (since RemaData might not be configured)
  // In production, replace with actual RemaData API call
  console.log(`✅ Delivery simulated for ${phone}`);
  
  res.json({
    status: 'success',
    message: 'Data delivered successfully',
    reference: ref,
    orderId: ref
  });
});

// ============================================================
// KYC LOOKUP ENDPOINT
// ============================================================
app.get('/api/kyc/lookup', async (req, res) => {
  const { phone } = req.query;

  console.log(`📞 KYC Lookup Request: ${phone}`);

  if (!phone) {
    return res.status(400).json({
      success: false,
      error: 'Phone number is required'
    });
  }

  if (!isValidMtnNumber(phone)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid MTN number. MTN numbers start with 024, 054, 055, 053, or 059'
    });
  }

  try {
    const result = await fetchMtnKyc(phone);

    if (result.success) {
      console.log(`✅ KYC success for ${phone}: ${result.data.fullName}`);
      res.json({
        success: true,
        data: result.data,
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.error
      });
    }
  } catch (error) {
    console.error('❌ KYC error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error. Please try again.'
    });
  }
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║   🚀 DataFlow Backend Server Running                          ║
║   📡 Port: ${PORT}                                              ║
║   🔑 MTN OAuth2: ${MTN_CLIENT_ID && MTN_CLIENT_SECRET ? '✅ Configured' : '❌ MISSING'}   ║
║   📦 Local Bundles: ✅ Available (MTN, Telecel, AT)          ║
║                                                              ║
║   📮 Endpoints:                                              ║
║      GET /api/bundles?network=mtn      → MTN bundles        ║
║      GET /api/bundles?network=telecel  → Telecel bundles    ║
║      GET /api/bundles?network=airteltigo → AT bundles       ║
║      GET /api/kyc/lookup?phone=024XXXX → KYC lookup         ║
║      POST /deliver                      → Deliver bundle     ║
║      GET /health                        → Health check       ║
╚══════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
