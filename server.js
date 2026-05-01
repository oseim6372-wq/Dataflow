const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.')); // Serve HTML files

// HubnetGH API Configuration
const HUBNET_BASE_URL = 'https://hubnetgh.site/wp-json/hubnet-api/v1';
const HUBNET_API_KEY = process.env.HUBNET_API_KEY;

// ==================== HUBNETGH PROXY ENDPOINTS ====================

/**
 * Place an order with HubnetGH (used after Paystack payment)
 * POST /api/place-order
 */
app.post('/api/place-order', async (req, res) => {
    const { network, volume, customer_number, request_id, amount_paid } = req.body;

    if (!network || !volume || !customer_number) {
        return res.status(400).json({
            success: false,
            message: 'Missing required fields: network, volume, customer_number'
        });
    }

    // Normalize network names
    let normalizedNetwork = network.toLowerCase();
    if (normalizedNetwork === 'airteltigo' || normalizedNetwork === 'at') {
        normalizedNetwork = 'airteltigo';
    } else if (normalizedNetwork === 'telecel' || normalizedNetwork === 'tel') {
        normalizedNetwork = 'telecel';
    } else if (normalizedNetwork === 'mtn') {
        normalizedNetwork = 'mtn';
    } else {
        return res.status(400).json({
            success: false,
            message: 'Invalid network. Must be mtn, telecel, or airteltigo'
        });
    }

    try {
        const response = await axios.post(`${HUBNET_BASE_URL}/place_order`, {
            network: normalizedNetwork,
            volume: volume.toString(),
            customer_number: customer_number,
            quantity: 1,
            request_id: request_id || `web_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`
        }, {
            headers: {
                'Content-Type': 'application/json',
                'X-API-KEY': HUBNET_API_KEY
            },
            timeout: 30000
        });

        // Include payment info in response
        res.json({
            ...response.data,
            amount_paid: amount_paid || 0
        });
    } catch (error) {
        console.error('HubnetGH API Error:', error.response?.data || error.message);
        
        if (error.response?.status === 402) {
            return res.status(402).json({
                success: false,
                message: 'System wallet low. Please contact support.',
                error: error.response?.data
            });
        }
        
        res.status(error.response?.status || 500).json({
            success: false,
            message: error.response?.data?.message || 'Failed to place order. Please try again.',
            error: error.response?.data
        });
    }
});

/**
 * Check wallet balance from HubnetGH
 * GET /api/check-balance
 */
app.get('/api/check-balance', async (req, res) => {
    try {
        const response = await axios.get(`${HUBNET_BASE_URL}/check_balance`, {
            headers: {
                'X-API-KEY': HUBNET_API_KEY
            },
            timeout: 15000
        });
        
        res.json(response.data);
    } catch (error) {
        console.error('Balance check error:', error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch wallet balance',
            error: error.message
        });
    }
});

/**
 * Get order status from HubnetGH
 * GET /api/order-status?order_id=123
 */
app.get('/api/order-status', async (req, res) => {
    const { order_id } = req.query;
    
    if (!order_id) {
        return res.status(400).json({
            success: false,
            message: 'Missing order_id parameter'
        });
    }
    
    try {
        const response = await axios.get(`${HUBNET_BASE_URL}/order_status`, {
            params: { order_id },
            headers: {
                'X-API-KEY': HUBNET_API_KEY
            },
            timeout: 15000
        });
        
        res.json(response.data);
    } catch (error) {
        res.status(error.response?.status || 500).json({
            success: false,
            message: error.response?.data?.message || 'Failed to fetch order status'
        });
    }
});

/**
 * Test API connection
 * GET /api/test-connection
 */
app.get('/api/test-connection', async (req, res) => {
    try {
        const response = await axios.get(`${HUBNET_BASE_URL}/check_balance`, {
            headers: {
                'X-API-KEY': HUBNET_API_KEY
            },
            timeout: 10000
        });
        
        res.json({
            success: true,
            message: 'HubnetGH API connected',
            wallet_balance: response.data.wallet_balance
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'HubnetGH API connection failed',
            error: error.message
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        hubnet_configured: !!HUBNET_API_KEY
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📡 HubnetGH API: ${HUBNET_BASE_URL}`);
    console.log(`🔑 API Key configured: ${HUBNET_API_KEY ? '✓ Yes' : '✗ No'}`);
});
