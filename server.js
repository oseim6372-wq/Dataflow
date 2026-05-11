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
// MTN KYC CONFIGURATION - USING API KEY ONLY
// ============================================================
const MTN_API_KEY = process.env.MTN_API_KEY || 'WsAWhYfZZaFckbrQFNqeYQlQnJLQ0QAu';
const MTN_API_BASE = 'https://api.mtn.com/v1/customers';

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
// FETCH KYC FROM MTN - USING API KEY ONLY
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
  console.log(`   API Key: ${MTN_API_KEY.substring(0, 15)}...`);

  try {
    const response = await axios.get(url, {
      headers: {
        'x-api-key': MTN_API_KEY,
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
        return { success: false, error: 'API Key invalid or expired. Please contact support.' };
      } else if (error.response.status === 403) {
        return { success: false, error: 'Access forbidden. Your API key may not have KYC permissions.' };
      } else if (error.response.status === 400) {
        return { success: false, error: 'Invalid request. Please check the phone number format.' };
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
// HEALTH CHECK ENDPOINT
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    kycApiConfigured: !!MTN_API_KEY,
    endpoints: [
      'GET /api/kyc/lookup?phone=024XXXXXX  → KYC name lookup',
      'GET /health                           → Health check'
    ]
  });
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

  if (!MTN_API_KEY) {
    return res.status(500).json({
      success: false,
      error: 'KYC service not configured',
      code: 'NO_API_KEY'
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
║   🔑 MTN API Key: ${MTN_API_KEY ? '✅ Configured' : '❌ MISSING'}            ║
║                                                              ║
║   📮 Endpoints:                                              ║
║      GET /api/kyc/lookup?phone=024XXXXXX  → KYC lookup      ║
║      GET /health                           → Health check    ║
║                                                              ║
║   📝 Test with:                                             ║
║      curl "http://localhost:${PORT}/api/kyc/lookup?phone=0244502480" ║
╚══════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
