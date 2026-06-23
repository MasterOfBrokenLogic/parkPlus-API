const express = require('express');
const fs = require('fs');
const axios = require('axios');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
const PORT = process.env.PORT || 5055;
const PROXY_FILE = path.join(__dirname, 'proxies.txt');

// ================= PROXY MANAGEMENT =================

let proxies = [];
let proxyIndex = 0;
let proxyFailures = new Map();

// Load proxies from file
function loadProxies() {
    try {
        if (fs.existsSync(PROXY_FILE)) {
            const content = fs.readFileSync(PROXY_FILE, 'utf-8');
            proxies = content.split('\n')
                .filter(line => line.trim() && !line.startsWith('#'))
                .map(line => line.trim());
            console.log(`✅ Loaded ${proxies.length} proxies`);
        } else {
            console.log('⚠️ proxies.txt not found');
            proxies = [];
        }
    } catch (e) {
        console.error('Error loading proxies:', e.message);
        proxies = [];
    }
}

// Get next proxy (round robin)
function getNextProxy() {
    if (!proxies.length) return null;

    for (let i = 0; i < proxies.length; i++) {
        const proxy = proxies[proxyIndex % proxies.length];
        proxyIndex++;
        const failures = proxyFailures.get(proxy) || 0;
        if (failures < 3) {
            return proxy;
        }
    }
    // Reset if all failed
    proxyFailures.clear();
    proxyIndex = 0;
    return proxies[0];
}

// Mark proxy success/failure
function markProxyResult(proxy, success) {
    if (!proxy) return;
    if (success) {
        proxyFailures.delete(proxy);
    } else {
        const failures = proxyFailures.get(proxy) || 0;
        proxyFailures.set(proxy, failures + 1);
        console.log(`❌ Proxy failed (${failures + 1}/3): ${proxy.substring(0, 50)}...`);
    }
}

// Parse proxy string into { host, port, auth }
// Supports formats:
//   host:port:user:pass   (your owlproxy format)
//   http://user:pass@host:port
//   host:port
function parseProxy(proxyStr) {
    if (!proxyStr) return null;
    try {
        // Format: host:port:username:password
        const parts = proxyStr.split(':');
        if (parts.length === 4 && !proxyStr.startsWith('http')) {
            const [host, port, username, password] = parts;
            return { host, port: parseInt(port), auth: `${username}:${password}` };
        }
        // Format: http://user:pass@host:port
        if (proxyStr.includes('@')) {
            const authPart = proxyStr.split('@')[0].split('://')[1];
            const hostPart = proxyStr.split('@')[1];
            const [username, password] = authPart.split(':');
            const [host, port] = hostPart.split(':');
            return { host, port: parseInt(port), auth: `${username}:${password}` };
        }
        // Format: host:port (no auth)
        const url = new URL(proxyStr.startsWith('http') ? proxyStr : `http://${proxyStr}`);
        return { host: url.hostname, port: parseInt(url.port), auth: null };
    } catch (e) {
        console.error('Error parsing proxy:', e.message);
        return null;
    }
}

// Create axios instance with proxy
function createAxiosWithProxy(proxyStr) {
    const config = {
        timeout: 15000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/149.0.0.0 Mobile Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive'
        }
    };

    if (proxyStr) {
        const parsed = parseProxy(proxyStr);
        if (parsed) {
            try {
                const agent = new HttpsProxyAgent({
                    host: parsed.host,
                    port: parsed.port,
                    proxyAuth: parsed.auth
                });
                config.httpsAgent = agent;
                config.httpAgent = agent;
            } catch (e) {
                console.error('Error creating proxy agent:', e.message);
            }
        }
    }

    return axios.create(config);
}

// Common Park+ headers
const PARK_HEADERS = {
    'authorization': 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiIsImtpZCI6InYxIn0.eyJleHAiOjE3ODQxMzI0MjMsInN1YiI6IjM0NzY2NzU1IiwidW5pcXVlX2lkIjoibmpuQWdUWlFSYUVPZFpzZ0pzVUh1YUJYWXBIWWVJSFRZenZHVHRrVFZscmZTaGRDSHpRQWNLb2NiZ2NqdW1NbyIsImh0dHBzOi8vcGFya3doZWVscy5jby5pbi8iOnsidXNlcl9pZCI6MzQ3NjY3NTUsIm5hbWUiOiIgIiwiZW1haWwiOiIiLCJwaG9uZV9udW1iZXIiOiI3ODExMDE3MTI1Iiwicm9sZSI6ImNsaWVudCIsImRldmljZV9pZCI6bnVsbCwidmVyc2lvbiI6NCwidGVzdF91c2VyIjpmYWxzZX19.uDYVH-7gWe8AFNCm5GZIJL9zhzhZSyl9cA1Tw2_CSObzSqwH_U_NqQ5SobhBJ7g4t3WoMrP6mQCgtMRGR1e1cg',
    'app-name': 'Park+ PWA',
    'client-id': '8186c1be-660f-428c-93a7-6480c2d8af66',
    'client-secret': 'hjjh0uw8c3j7vw5jgba8',
    'device-id': '1ec5656295d0e004180397f4f7e4fc7a',
    'platform': 'web',
    'origin': 'https://parkplus.io',
    'referer': 'https://parkplus.io/',
    'Content-Type': 'application/json'
};

// Make request with proxy rotation
async function makeRequest(url, method = 'GET', data = null) {
    let lastError = null;
    const maxAttempts = proxies.length || 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const proxy = getNextProxy();
        const axiosInstance = createAxiosWithProxy(proxy);

        try {
            const config = {
                method,
                url,
                headers: PARK_HEADERS,
                timeout: 15000
            };

            if (data && method === 'POST') {
                config.data = data;
            }

            const response = await axiosInstance(config);
            markProxyResult(proxy, true);
            console.log(`✅ Request successful with: ${proxy ? 'Proxy ' + (attempt + 1) : 'Direct'}`);
            return response.data;

        } catch (error) {
            lastError = error;
            markProxyResult(proxy, false);
            console.log(`❌ Attempt ${attempt + 1} failed: ${error.message}`);

            if (error.response?.status === 403) {
                console.log('⚠️ 403 Forbidden - Token may be expired');
            }
        }
    }

    throw lastError || new Error('All proxies failed');
}

// ================= ENDPOINTS =================

// Challan endpoint
app.get('/challan/:vehicle', async (req, res) => {
    const vehicleNumber = req.params.vehicle.toUpperCase();
    const url = `https://challan.parkplus.io/api/v1/challan/challan-list?vehicle_number=${vehicleNumber}&status=PENDING&page=1&limit=50`;

    try {
        const data = await makeRequest(url, 'GET');
        res.json({
            success: true,
            vehicle: vehicleNumber,
            data: data
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            vehicle: vehicleNumber,
            error: error.message,
            status: error.response?.status
        });
    }
});

// Fastag endpoint
app.get('/fastag/:vehicle', async (req, res) => {
    const vehicleNumber = req.params.vehicle.toUpperCase();
    const url = 'https://fastag-issuance.parkplus.io/fastag-recharge/tag/v2/vrn-detail';
    const postData = { vehicle_number: vehicleNumber, source: 'recharge' };

    try {
        const data = await makeRequest(url, 'POST', postData);
        res.json({
            success: true,
            vehicle: vehicleNumber,
            data: data
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            vehicle: vehicleNumber,
            error: error.message,
            status: error.response?.status
        });
    }
});

// Test all proxies against the Park+ API
app.get('/proxy/test', async (req, res) => {
    const testUrl = 'https://challan.parkplus.io/api/v1/challan/challan-list?vehicle_number=TEST1234&status=PENDING&page=1&limit=1';
    const results = [];

    for (let i = 0; i < proxies.length; i++) {
        const proxy = proxies[i];
        const parsed = parseProxy(proxy);
        const label = parsed ? `${parsed.host}:${parsed.port} [${i + 1}/${proxies.length}]` : proxy;
        const start = Date.now();

        try {
            const instance = createAxiosWithProxy(proxy);
            const response = await instance({
                method: 'GET',
                url: testUrl,
                headers: PARK_HEADERS,
                timeout: 10000
            });
            results.push({
                proxy: label,
                status: 'ok',
                http_status: response.status,
                latency_ms: Date.now() - start
            });
            console.log(`✅ [${i + 1}] OK (${Date.now() - start}ms)`);
        } catch (err) {
            results.push({
                proxy: label,
                status: 'fail',
                http_status: err.response?.status || null,
                error: err.message,
                latency_ms: Date.now() - start
            });
            console.log(`❌ [${i + 1}] FAIL: ${err.message}`);
        }
    }

    const ok = results.filter(r => r.status === 'ok').length;
    res.json({
        total: proxies.length,
        working: ok,
        failed: proxies.length - ok,
        results
    });
});

// Proxy status endpoint
app.get('/proxy/status', (req, res) => {
    const proxyStatus = {};
    proxies.forEach(proxy => {
        const failures = proxyFailures.get(proxy) || 0;
        proxyStatus[proxy.substring(0, 40) + '...'] = {
            failures: failures,
            status: failures < 3 ? 'active' : 'failed'
        };
    });

    res.json({
        total_proxies: proxies.length,
        active_proxies: proxies.filter(p => (proxyFailures.get(p) || 0) < 3).length,
        current_index: proxyIndex % (proxies.length || 1),
        proxies: proxyStatus
    });
});

// Reload proxies endpoint
app.get('/proxy/reload', (req, res) => {
    loadProxies();
    proxyFailures.clear();
    proxyIndex = 0;
    res.json({ message: 'Proxies reloaded', total: proxies.length });
});

// Ping route for UptimeRobot (keeps Render awake)
app.get('/ping', (req, res) => {
    res.send('pong');
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'running',
        port: PORT,
        proxies_loaded: proxies.length,
        timestamp: new Date().toISOString()
    });
});

// ================= START SERVER =================

loadProxies();

// Reload proxies every 10 minutes
setInterval(() => {
    loadProxies();
    console.log('🔄 Proxies reloaded automatically');
}, 10 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════╗
║   🚀 Park+ API Proxy Server          ║
║   Port: ${PORT}                          ║
║   Proxies: ${proxies.length} loaded              ║
╠══════════════════════════════════════╣
║ Endpoints:                           ║
║   GET /challan/:vehicle              ║
║   GET /fastag/:vehicle               ║
║   GET /proxy/status                  ║
║   GET /proxy/reload                  ║
║   GET /health                        ║
╚══════════════════════════════════════╝
    `);
});
