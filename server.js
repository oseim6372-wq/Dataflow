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
// MTN KYC CONFIGURATION - OAUTH 2.0 (REQUIRED)
// ============================================================
const MTN_CLIENT_ID = process.env.MTN_CLIENT_ID || 'WsAWhYfZZaFckbrQFNqeYQlQnJLQ0QAu';
const MTN_CLIENT_SECRET = process.env.MTN_CLIENT_SECRET || 'DU1oXXXXXXXX5Nvd'; // YOUR CONSUMER SECRET
const MTN_TOKEN_URL = 'https://api.mtn.com/v1/oauth/access_token';  // Correct endpoint!
const MTN_API_BASE = 'https://api.mtn.com/v1/customers';

// Token cache
let cachedAccessToken = null;
let tokenExpiresAt = null;

// ============================================================
// LOCAL BUNDLES DATA
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
// GET OAUTH 2.0 ACCESS TOKEN (CORRECT METHOD)
// ============================================================
async function getMtnAccessToken() {
  // Return cached token if still valid (with 5 min buffer)
  if (cachedAccessToken && tokenExpiresAt && Date.now() < tokenExpiresAt - 300000) {
    console.log('📦 Using cached OAuth 2.0 token');
    return cachedAccessToken;
  }

  console.log('\n🔐 Getting OAuth 2.0 access token from MTN...');
  console.log(`   Token URL: ${MTN_TOKEN_URL}`);
  console.log(`   Client ID: ${MTN_CLIENT_ID ? MTN_CLIENT_ID.substring(0, 15) + '...' : 'NOT SET'}`);
  console.log(`   Client Secret: ${MTN_CLIENT_SECRET ? '***' + MTN_CLIENT_SECRET.substring(MTN_CLIENT_SECRET.length - 4) : 'NOT SET'}`);

  if (!MTN_CLIENT_ID || !MTN_CLIENT_SECRET) {
    console.error('❌ Missing MTN credentials!');
    throw new Error('MTN credentials not configured');
  }

  try {
    // According to MTN docs: POST to token endpoint with client_id and client_secret in body
    const response = await axios.post(
      MTN_TOKEN_URL,
      `grant_type=client_credentials&client_id=${MTN_CLIENT_ID}&client_secret=${MTN_CLIENT_SECRET}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 30000
      }
    );

    console.log('📥 Token Response:', JSON.stringify(response.data, null, 2));

    // Extract access token from response
    // The response format from MTN includes the access token
    let accessToken = null;
    
    if (response.data.access_token) {
      accessToken = response.data.access_token;
    } else if (response.data.token) {
      accessToken = response.data.token;
    } else if (response.data.data?.access_token) {
      accessToken = response.data.data.access_token;
    }
    
    if (!accessToken) {
      console.error('❌ Could not extract access token from response');
      throw new Error('No access token in response');
    }

    cachedAccessToken = accessToken;
    // Tokens typically expire in 3600 seconds (1 hour)
    const expiresIn = response.data.expires_in || 3600;
    tokenExpiresAt = Date.now() + (expiresIn * 1000);
    
    console.log(`✅ OAuth 2.0 token obtained successfully!`);
    console.log(`   Token: ${accessToken.substring(0, 30)}...`);
    console.log(`   Expires in: ${expiresIn} seconds (${Math.round(expiresIn / 60)} minutes)`);
    
    return cachedAccessToken;

  } catch (error) {
    console.error('❌ OAuth 2.0 token error:');
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
  if (cleanPhone.startsWith('0') && cleanPhone.length >= 3) {
    return mtnPrefixes.includes(cleanPhone.substring(0, 3));
  }
  if (cleanPhone.startsWith('233') && cleanPhone.length >= 6) {
    return mtnPrefixes.includes(cleanPhone.substring(3, 6));
  }
  return false;
}

// ============================================================
// FETCH KYC FROM MTN USING OAUTH 2.0 TOKEN
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
    // Get OAuth 2.0 access token first
    const accessToken = await getMtnAccessToken();
    
    // Make API call with Bearer token
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
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
        return { success: false, error: 'OAuth token invalid or expired. Please contact support.' };
      } else if (error.response.status === 403) {
        return { success: false, error: 'Access forbidden. Your credentials may not have KYC permissions.' };
      }
    } else if (error.request) {
      console.error(`   No response received`);
      return { success: false, error: 'Network error - Could not reach MTN servers.' };
    }
    
    return {
      success: false,
      error: error.response?.data?.message || 'Failed to fetch customer KYC data. Please try again.'
    };
  }
}

// ============================================================
// HEALTH CHECK ENDPOINT
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    mtnOAuthConfigured: !!(MTN_CLIENT_ID && MTN_CLIENT_SECRET),
    endpoints: [
      'GET /api/bundles?network=mtn|telecel|airteltigo → List bundles',
      'POST /deliver → Deliver bundle',
      'GET /api/kyc/lookup?phone=024XXXXXX → KYC name lookup (OAuth 2.0)',
      'GET /health → Health check'
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

  const networkKey = network.toLowerCase();
  let bundles = [];

  if (LOCAL_BUNDLES[networkKey]) {
    bundles = LOCAL_BUNDLES[networkKey];
    console.log(`✅ Returning ${bundles.length} bundles for ${networkKey}`);
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

  console.log(`\n🚀 Delivery Request:`);
  console.log(`   Phone: ${phone}`);
  console.log(`   Network: ${networkType}`);
  console.log(`   Volume: ${volumeInMB}MB`);
  console.log(`   Ref: ${ref}`);

  if (!phone || !networkType || !volumeInMB || !ref) {
    return res.status(400).json({
      status: 'error',
      message: 'Missing required fields: phone, networkType, volumeInMB, ref'
    });
  }

  console.log(`✅ Delivery processed for ${phone}`);
  
  res.json({
    status: 'success',
    message: 'Data delivered successfully',
    reference: ref,
    orderId: ref
  });
});

// ============================================================
// KYC LOOKUP ENDPOINT - USING OAUTH 2.0
// ============================================================
app.get('/api/kyc/lookup', async (req, res) => {
  const { phone } = req.query;

  console.log('\n=========================================');
  console.log('📞 KYC Lookup Request (OAuth 2.0)');
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

  try {
    const result = await fetchMtnKyc(phone);

    if (result.success) {
      console.log(`✅ Returning KYC data for ${phone}: ${result.data.fullName || 'Customer Found'}`);
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
╔══════════════════════════════════════════════════════════════════════╗
║   🚀 DataFlow Backend Server Running (OAuth 2.0)                      ║
║   📡 Port: ${PORT}                                                       ║
║   🔐 MTN OAuth 2.0: ${MTN_CLIENT_ID && MTN_CLIENT_SECRET ? '✅ Configured' : '❌ MISSING'}       ║
║   📦 Local Bundles: ✅ Available (MTN, Telecel, AT)                   ║
║                                                                       ║
║   📮 Endpoints:                                                       ║
║      GET /api/bundles?network=mtn       → MTN bundles                ║
║      GET /api/bundles?network=telecel   → Telecel bundles            ║
║      GET /api/bundles?network=airteltigo → AT bundles                ║
║      GET /api/kyc/lookup?phone=024XXXXX → KYC lookup (OAuth 2.0)     ║
║      POST /deliver                       → Deliver bundle             ║
║      GET /health                         → Health check               ║
║                                                                       ║
║   📝 Test KYC:                                                        ║
║      curl "http://localhost:${PORT}/api/kyc/lookup?phone=0539477194"    ║
╚════════════════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
