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
// MTN OAUTH 2.0 + KYC CONFIGURATION
// ============================================================
const MTN_CONSUMER_KEY    = process.env.MTN_CONSUMER_KEY    || '';
const MTN_CONSUMER_SECRET = process.env.MTN_CONSUMER_SECRET || '';
const MTN_OAUTH_URL       = 'https://api.mtn.com/v1/oauth/access_token';
const MTN_API_BASE        = 'https://api.mtn.com/v1/customers';

// In-memory token cache — no external dep needed
let mtnTokenCache = {
  token:     null,
  expiresAt: 0   // epoch ms
};

// ============================================================
// GET (OR REUSE) MTN OAUTH ACCESS TOKEN
// Uses client_credentials grant as per MTN OAuth 2.0 docs
// ============================================================
async function getMtnAccessToken() {
  const now = Date.now();

  // Return cached token if still valid (with 60s buffer)
  if (mtnTokenCache.token && now < mtnTokenCache.expiresAt - 60000) {
    console.log('🔑 Using cached MTN OAuth token');
    return mtnTokenCache.token;
  }

  console.log('🔑 Fetching new MTN OAuth access token…');

  if (!MTN_CONSUMER_KEY || !MTN_CONSUMER_SECRET) {
    throw new Error('MTN_CONSUMER_KEY or MTN_CONSUMER_SECRET not set in environment');
  }

  const params = new URLSearchParams();
  params.append('grant_type',    'client_credentials');
  params.append('client_id',     MTN_CONSUMER_KEY);
  params.append('client_secret', MTN_CONSUMER_SECRET);

  const response = await axios.post(MTN_OAUTH_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000
  });

  const { access_token, expires_in } = response.data;

  if (!access_token) throw new Error('No access_token in MTN OAuth response');

  // expires_in is in seconds; default 3599 if missing
  const expiresInMs = (parseInt(expires_in, 10) || 3599) * 1000;
  mtnTokenCache = { token: access_token, expiresAt: now + expiresInMs };

  console.log(`✅ MTN OAuth token obtained — expires in ${Math.round(expiresInMs / 60000)} min`);
  return access_token;
}

// ============================================================
// FORMAT PHONE NUMBER TO E.164 (no +)
// ============================================================
function formatPhoneForMtn(phone) {
  let formatted = phone.replace(/\s+/g, '').replace(/-/g, '');
  if (formatted.startsWith('0'))  formatted = '233' + formatted.substring(1);
  if (formatted.startsWith('+'))  formatted = formatted.substring(1);
  return formatted;
}

// ============================================================
// VALIDATE MTN PHONE NUMBER
// ============================================================
function isValidMtnNumber(phone) {
  const clean = phone.replace(/\s+/g, '').replace(/-/g, '');
  const mtnPrefixes = ['024', '054', '055', '059', '053'];
  if (clean.startsWith('0'))   return mtnPrefixes.includes(clean.substring(0, 3));
  if (clean.startsWith('233')) return mtnPrefixes.includes(clean.substring(3, 6));
  return false;
}

// ============================================================
// FETCH KYC FROM MTN — USING OAUTH 2.0 BEARER TOKEN
// ============================================================
async function fetchMtnKyc(phoneNumber) {
  const formattedPhone  = formatPhoneForMtn(phoneNumber);
  const transactionId   = `DF-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  const url             = `${MTN_API_BASE}/${formattedPhone}/kyc`;

  console.log(`\n📞 KYC Request:`);
  console.log(`   Original:      ${phoneNumber}`);
  console.log(`   Formatted:     ${formattedPhone}`);
  console.log(`   URL:           ${url}`);
  console.log(`   TransactionId: ${transactionId}`);

  let accessToken;
  try {
    accessToken = await getMtnAccessToken();
  } catch (tokenErr) {
    console.error('❌ Token fetch failed:', tokenErr.message);
    return { success: false, error: 'Could not authenticate with MTN. Check consumer credentials.' };
  }

  try {
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept':        'application/json',
        'transactionId': transactionId
      },
      timeout: 30000
    });

    console.log(`✅ KYC Success! Status: ${response.status}`);

    const kycData = response.data?.data || response.data;

    return {
      success: true,
      data: {
        firstName:   kycData?.firstName   || '',
        lastName:    kycData?.lastName    || '',
        fullName:    `${kycData?.firstName || ''} ${kycData?.lastName || ''}`.trim(),
        idType:      kycData?.idType      || null,
        idNumber:    kycData?.idNumber    || null,
        dateOfBirth: kycData?.dateOfBirth || null,
        gender:      kycData?.gender      || null
      }
    };

  } catch (error) {
    console.error(`❌ KYC Failed:`);

    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Data:`,   JSON.stringify(error.response.data, null, 2));

      // If token expired mid-session, clear cache so next call re-fetches
      if (error.response.status === 401) {
        mtnTokenCache = { token: null, expiresAt: 0 };
        return { success: false, error: 'MTN session expired. Please try again.' };
      }
      if (error.response.status === 403) return { success: false, error: 'Access forbidden. KYC scope may not be enabled on your MTN app.' };
      if (error.response.status === 404) return { success: false, error: 'Customer not found in MTN records. Please check the number.' };
      if (error.response.status === 400) return { success: false, error: 'Invalid request. Please check the phone number format.' };
    } else if (error.request) {
      console.error(`   No response received`);
      return { success: false, error: 'Network error — could not reach MTN servers.' };
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
const REMADATA_BASE   = process.env.REMADATA_BASE   || 'https://api.remadata.net';
const REMADATA_TOKEN  = process.env.REMADATA_TOKEN  || '';   // set in Render env vars
const REMADATA_SENDER = process.env.REMADATA_SENDER || '';   // your RemaData sender/account ID

// ============================================================
// HEALTH CHECK ENDPOINT
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    kycApiConfigured:      !!(MTN_CONSUMER_KEY && MTN_CONSUMER_SECRET),
    remaDataConfigured:    !!REMADATA_TOKEN,
    endpoints: [
      'GET  /api/bundles?network=mtn|telecel|airteltigo → List bundles',
      'POST /deliver                                     → Deliver bundle',
      'GET  /api/kyc/lookup?phone=024XXXXXX             → KYC name lookup',
      'GET  /health                                     → Health check'
    ]
  });
});

// ============================================================
// BUNDLES ENDPOINT
// GET /api/bundles?network=mtn|telecel|airteltigo
// Fetches available bundles from RemaData and returns them
// in the shape the frontend expects: { status:'success', data:[...] }
// ============================================================
app.get('/api/bundles', async (req, res) => {
  const { network } = req.query;

  console.log(`\n📦 Bundles Request — network: ${network}`);

  if (!network) {
    return res.status(400).json({ status: 'error', message: 'network query param required' });
  }

  // Map frontend network keys → RemaData network names
  const networkMap = {
    mtn:        'MTN',
    telecel:    'TELECEL',
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

    // RemaData returns bundles — normalise to what the frontend expects
    const raw = response.data?.data || response.data || [];
    const bundles = (Array.isArray(raw) ? raw : []).map(b => ({
      volumeInMB: Number(b.volume || b.volumeInMB || b.size || 0),
      price:      parseFloat(b.price || b.amount || 0),
      name:       b.name || b.description || '',
      network:    remaNetwork
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
// POST /deliver
// Body: { phone, networkType, volumeInMB, ref }
// Calls RemaData to deliver the bundle, returns result
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
    mtn:        'MTN',
    telecel:    'TELECEL',
    airteltigo: 'AIRTELTIGO'
  };
  const remaNetwork = networkMap[networkType.toLowerCase()] || networkType.toUpperCase();

  try {
    const payload = {
      phone:      phone.startsWith('0') ? '233' + phone.substring(1) : phone,
      network:    remaNetwork,
      volume:     Number(volumeInMB),
      ref:        ref,
      sender:     REMADATA_SENDER
    };

    console.log('📤 Sending to RemaData:', payload);

    const response = await axios.post(`${REMADATA_BASE}/api/v1/send`, payload, {
      headers: {
        'Authorization': `Bearer ${REMADATA_TOKEN}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json'
      },
      timeout: 30000
    });

    const result = response.data;
    console.log('✅ RemaData response:', JSON.stringify(result, null, 2));

    // Normalise to what the frontend checks: data.status === 'success'
    if (result.status === 'success' || result.success === true) {
      res.json({
        status:    'success',
        message:   result.message || 'Bundle delivered successfully',
        reference: result.reference || result.data?.reference || ref,
        orderId:   ref
      });
    } else {
      console.warn('⚠️ RemaData returned non-success:', result);
      res.status(400).json({
        status:  'error',
        message: result.message || 'Delivery failed. Please check provider logs.'
      });
    }

  } catch (err) {
    console.error('❌ Delivery error:', err.response?.status, err.response?.data || err.message);
    res.status(502).json({
      status:  'error',
      message: err.response?.data?.message || 'Failed to deliver bundle. Please retry.'
    });
  }
});

// ============================================================
// KYC LOOKUP ENDPOINT
// Called by the frontend phone field (MTN numbers only)
// GET /api/kyc/lookup?phone=0241234567
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

  if (!MTN_CONSUMER_KEY || !MTN_CONSUMER_SECRET) {
    return res.status(500).json({
      success: false,
      error: 'KYC service not configured — MTN_CONSUMER_KEY/SECRET missing',
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
║   🚀 DataFlow Backend Server Running                          ║
║   📡 Port: ${PORT}                                              ║
║   🔑 MTN OAuth: ${(MTN_CONSUMER_KEY && MTN_CONSUMER_SECRET) ? '✅ Configured' : '❌ MISSING KEY/SECRET'}       ║
║   📦 RemaData: ${REMADATA_TOKEN ? '✅ Configured' : '❌ MISSING TOKEN'}                     ║
║                                                              ║
║   📮 Endpoints:                                              ║
║      GET  /api/bundles?network=mtn|telecel|at → Bundles      ║
║      POST /deliver                            → Deliver      ║
║      GET  /api/kyc/lookup?phone=024XXXXXX     → KYC lookup   ║
║      GET  /health                             → Health check  ║
╚══════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
