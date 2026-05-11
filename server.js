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
// MTN KYC CONFIGURATION - FROM SWAGGER FILE
// ============================================================
const MTN_CLIENT_ID = process.env.MTN_CLIENT_ID || 'WsAWhYfZZaFckbrQFNqeYQlQnJLQ0QAu';
const MTN_CLIENT_SECRET = process.env.MTN_CLIENT_SECRET || 'DU1oXXXXXXXX5Nvd';
// CORRECT URLs from Swagger:
const MTN_TOKEN_URL = 'https://api.mtn.com/oauth/client_credential/accesstoken';
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
// GET OAUTH2 ACCESS TOKEN (EXACTLY AS PER SWAGGER)
// ============================================================
async function getMtnAccessToken() {
  // Return cached token if still valid
  if (cachedAccessToken && tokenExpiresAt && Date.now() < tokenExpiresAt - 300000) {
    console.log('📦 Using cached OAuth2 token');
    return cachedAccessToken;
  }

  console.log('\n🔐 Getting OAuth2 token from MTN...');
  console.log(`   Token URL: ${MTN_TOKEN_URL}`);
  console.log(`   Client ID: ${MTN_CLIENT_ID.substring(0, 15)}...`);
  console.log(`   Client Secret: ${MTN_CLIENT_SECRET ? '***' + MTN_CLIENT_SECRET.slice(-4) : 'NOT SET'}`);

  try {
    // According to Swagger: OAuth2 with client_credentials flow
    // Use Basic Authentication with Client ID and Secret
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

    console.log('📥 Token Response Status:', response.status);
    
    const { access_token, expires_in } = response.data;
    
    if (!access_token) {
      console.error('❌ No access_token in response:', response.data);
      throw new Error('No access token received');
    }

    cachedAccessToken = access_token;
    tokenExpiresAt = Date.now() + ((expires_in || 3600) * 1000);
    
    console.log(`✅ OAuth2 token obtained!`);
    console.log(`   Token: ${access_token.substring(0, 30)}...`);
    console.log(`   Expires in: ${expires_in || 3600} seconds`);
    
    return cachedAccessToken;

  } catch (error) {
    console.error('❌ OAuth2 token error:');
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Data:`, JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(`   Message: ${error.message}`);
    }
    throw new Error(`MTN authentication failed: ${error.response?.data?.message || error.message}`);
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
// FETCH KYC FROM MTN USING OAUTH2 TOKEN
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
    const accessToken = await getMtnAccessToken();
    
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
        return { success: false, error: 'Customer not found in MTN records.' };
      } else if (error.response.status === 401) {
        return { success: false, error: 'Authentication failed. Please check your MTN credentials.' };
      } else if (error.response.status === 403) {
        return { success: false, error: 'Access forbidden. Your app may not have KYC permissions.' };
      }
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
// BUNDLES ENDPOINT
// ============================================================
app.get('/api/bundles', async (req, res) => {
  const { network } = req.query;
  
  console.log(`\n📦 Bundles Request — network: ${network}`);

  if (!network) {
    return res.status(400).json({ status: 'error', message: 'network query param required' });
  }

  const networkKey = network.toLowerCase();
  let bundles = LOCAL_BUNDLES[networkKey] || [];

  console.log(`✅ Returning ${bundles.length} bundles for ${networkKey}`);
  res.json({ status: 'success', data: bundles });
});

// ============================================================
// DELIVER ENDPOINT
// ============================================================
app.post('/deliver', async (req, res) => {
  const { phone, networkType, volumeInMB, ref } = req.body;

  console.log(`\n🚀 Delivery Request: ${phone}, ${networkType}, ${volumeInMB}MB, Ref: ${ref}`);

  if (!phone || !networkType || !volumeInMB || !ref) {
    return res.status(400).json({
      status: 'error',
      message: 'Missing required fields: phone, networkType, volumeInMB, ref'
    });
  }

  // Simulate delivery (replace with actual API call)
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

  console.log('\n=========================================');
  console.log('📞 KYC Lookup Request');
  console.log(`   Phone: ${phone}`);
  console.log('=========================================');

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
      console.log(`✅ Returning KYC data for ${phone}`);
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
    console.error('❌ Unexpected error:', error);
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
╔══════════════════════════════════════════════════════════════════╗
║   🚀 DataFlow Backend Server Running                               ║
║   📡 Port: ${PORT}                                                   ║
║   🔐 MTN OAuth2: ${MTN_CLIENT_ID && MTN_CLIENT_SECRET ? '✅ Configured' : '❌ MISSING'}   ║
║   📦 Local Bundles: ✅ Available                                    ║
║                                                                   ║
║   📮 Endpoints:                                                   ║
║      GET /api/bundles?network=mtn       → MTN bundles            ║
║      GET /api/bundles?network=telecel   → Telecel bundles        ║
║      GET /api/bundles?network=airteltigo → AT bundles            ║
║      GET /api/kyc/lookup?phone=024XXXXX → KYC lookup             ║
║      POST /deliver                       → Deliver bundle         ║
║      GET /health                         → Health check           ║
╚════════════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
