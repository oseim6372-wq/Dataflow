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
const REMADATA_API_KEY = process.env.REMADATA_API_KEY || '';
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET || '';
const SELF_URL = process.env.SELF_URL || `http://localhost:${PORT}`;
const DELIVER_SECRET = process.env.DELIVER_SECRET || '';

// MTN KYC API Configuration - Using your actual credentials
const MTN_API_BASE_URL = 'https://api.mtn.com';
const MTN_TOKEN_URL = 'https://api.mtn.com/oauth/client_credential/accesstoken';
const MTN_KYC_URL = 'https://api.mtn.com/v1/customers';

// YOUR ACTUAL CREDENTIALS FROM THE SCREENSHOT
const MTN_CLIENT_ID = process.env.MTN_CLIENT_ID || 'WsAWXXXXXXXXXXXXXXXXX';  // Replace with your actual consumer key
const MTN_CLIENT_SECRET = process.env.MTN_CLIENT_SECRET || 'DU1oXXXXXXXX5Nvd'; // Replace with your actual consumer secret

// Token cache
let mtnAccessToken = null;
let tokenExpiresAt = null;

// ─────────────────────────────────────────────
//  MIDDLEWARE
// ─────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ 
  origin: ['https://dataflow.kesug.co', 'http://localhost:5500', 'http://127.0.0.1:5500'],
  credentials: true 
}));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ─────────────────────────────────────────────
//  MTN OAUTH2 TOKEN MANAGEMENT
// ─────────────────────────────────────────────

/**
 * Get OAuth2 access token from MTN using client credentials flow
 */
async function getMtnAccessToken() {
  // Check if we have a valid cached token (with 5 min buffer)
  if (mtnAccessToken && tokenExpiresAt && Date.now() < tokenExpiresAt - 5 * 60 * 1000) {
    console.log('✅ Using cached MTN token (expires in:', Math.round((tokenExpiresAt - Date.now()) / 1000), 'sec)');
    return mtnAccessToken;
  }

  console.log('\n🔄 Fetching new MTN OAuth2 token...');
  console.log('   Client ID:', MTN_CLIENT_ID.substring(0, 10) + '...');
  console.log('   Token URL:', MTN_TOKEN_URL);

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
        timeout: 30000
      }
    );

    const { access_token, expires_in, token_type } = response.data;

    if (!access_token) {
      throw new Error('No access token received');
    }

    // Cache the token
    mtnAccessToken = access_token;
    tokenExpiresAt = Date.now() + (expires_in * 1000);

    console.log(`✅ MTN token obtained! Expires in ${expires_in} seconds`);
    console.log(`   Token: ${access_token.substring(0, 30)}...\n`);
    
    return mtnAccessToken;

  } catch (error) {
    console.error('❌ MTN Token Error:');
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', error.response.data);
    } else {
      console.error('   Error:', error.message);
    }
    throw new Error(`MTN auth failed: ${error.response?.data?.error_description || error.message}`);
  }
}

// ─────────────────────────────────────────────
//  MTN KYC HELPER FUNCTIONS
// ─────────────────────────────────────────────

/**
 * Format phone number to E.123 standard for MTN API
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
 */
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

/**
 * Fetch KYC details from MTN API
 */
async function fetchMtnKyc(phoneNumber) {
  const formattedPhone = formatPhoneForMtn(phoneNumber);
  const transactionId = `DF-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  
  console.log(`\n🔍 KYC Lookup:`);
  console.log(`   Phone: ${phoneNumber} → ${formattedPhone}`);
  console.log(`   Transaction ID: ${transactionId}`);
  
  try {
    const token = await getMtnAccessToken();
    
    const response = await axios.get(
      `${MTN_KYC_URL}/${formattedPhone}/kyc`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'transactionId': transactionId
        },
        timeout: 30000
      }
    );
    
    console.log(`✅ KYC lookup successful!`);
    return {
      success: true,
      data: response.data
    };
    
  } catch (error) {
    console.error(`❌ KYC lookup failed:`);
    
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Data:`, error.response.data);
      
      if (error.response.status === 404) {
        return {
          success: false,
          error: 'Customer not found in MTN records',
          statusCode: 404
        };
      } else if (error.response.status === 401) {
        return {
          success: false,
          error: 'Authentication failed. Please check MTN credentials.',
          statusCode: 401
        };
      }
    } else {
      console.error(`   Error:`, error.message);
    }
    
    return {
      success: false,
      error: error.response?.data?.message || 'Failed to fetch customer KYC data',
      statusCode: error.response?.status || 500
    };
  }
}

// ─────────────────────────────────────────────
//  MAIN ROUTES
// ─────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    mtnKycConfigured: !!(MTN_CLIENT_ID && MTN_CLIENT_SECRET),
    endpoints: ['/api/kyc/lookup', '/deliver', '/api/bundles', '/health']
  });
});

// ✅ MTN KYC LOOKUP ENDPOINT
app.get('/api/kyc/lookup', async (req, res) => {
  const { phone } = req.query;
  
  console.log('=========================================');
  console.log('📞 KYC Lookup Request Received');
  console.log('   Phone:', phone);
  console.log('=========================================');
  
  // Validate phone parameter
  if (!phone) {
    return res.status(400).json({
      success: false,
      error: 'Phone number is required',
      code: 'MISSING_PHONE'
    });
  }
  
  // Validate MTN number
  if (!isValidMtnNumber(phone)) {
    return res.status(400).json({
      success: false,
      error: `Invalid or non-MTN number. MTN numbers start with 024, 054, 055, 053, or 059`,
      code: 'INVALID_NETWORK'
    });
  }
  
  // Check credentials
  if (!MTN_CLIENT_ID || !MTN_CLIENT_SECRET) {
    console.error('❌ MTN credentials missing!');
    return res.status(500).json({
      success: false,
      error: 'KYC service not configured. Please contact support.',
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
    
    // Extract KYC data
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
    
    console.log(`✅ Returning KYC data for ${phone}: ${responseData.data.fullName}\n`);
    res.json(responseData);
    
  } catch (error) {
    console.error('❌ Unexpected error:', error);
    res.status(500).json({
      success: false,
      error: 'An unexpected error occurred. Please try again.',
      code: 'INTERNAL_ERROR'
    });
  }
});

// Manual token refresh endpoint
app.post('/api/mtn/refresh-token', async (req, res) => {
  try {
    mtnAccessToken = null;
    tokenExpiresAt = null;
    const newToken = await getMtnAccessToken();
    res.json({
      success: true,
      message: 'Token refreshed successfully',
      token: newToken.substring(0, 30) + '...'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Simple delivery endpoint (placeholder - integrate with your actual delivery)
app.post('/deliver', (req, res) => {
  res.json({ status: 'success', message: 'Delivery endpoint - integrate with RemaData' });
});

// Bundles endpoint (placeholder)
app.get('/api/bundles', (req, res) => {
  res.json({ status: 'success', data: [] });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ status: 'error', message: `Route not found: ${req.method} ${req.url}` });
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
╔════════════════════════════════════════════════════════════════╗
║   🚀 DataFlow Backend Server Running                            ║
║   📡 Port: ${PORT}                                                ║
║   🌐 URL:  ${SELF_URL}                                           ║
║   📞 MTN KYC: ${MTN_CLIENT_ID ? '✅ OAuth2 Configured' : '❌ NOT SET'}        ║
║                                                                  ║
║   📮 Endpoints:                                                  ║
║      GET  /api/kyc/lookup?phone=024XXXXXX → KYC lookup ✓         ║
║      POST /api/mtn/refresh-token        → Refresh MTN token      ║
║      GET  /health                       → Health check           ║
║                                                                  ║
║   💡 Test with: curl "http://localhost:${PORT}/api/kyc/lookup?phone=0244502480" ║
╚════════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
