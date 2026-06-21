// provision-tunnel.js
// Called by buyer's setup.ps1 at install time.
// POST { key: "<license_key>" }
// Returns { hostname: "td1234.novo-aitrading.app", token: "eyJ..." }
// Idempotent: same license key always returns the same permanent URL.

const { list, put } = require('@vercel/blob');
const { createHash }  = require('crypto');
const https           = require('https');

const CF_ACCOUNT_ID = 'c90a8582c3a3bb842a63f5499be94010';
const DOMAIN        = 'novo-aitrading.app';

// IP-based rate limiter — max 3 provisions per minute per IP
const _rl = new Map();
function _rateLimited(ip) {
  const now = Date.now();
  const rec = _rl.get(ip) || { n: 0, reset: now + 60000 };
  if (now > rec.reset) { _rl.set(ip, { n: 1, reset: now + 60000 }); return false; }
  rec.n++;
  _rl.set(ip, rec);
  return rec.n > 3;
}

// Cloudflare API helper
function cfFetch(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: `/client/v4${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${process.env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error('CF parse error: ' + buf.slice(0, 300))); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (_rateLimited(ip)) return res.status(429).json({ error: 'Too many requests' });

  const { key } = req.body || {};
  if (!key || typeof key !== 'string' || key.trim().length < 8) {
    return res.status(400).json({ error: 'Valid license key required' });
  }

  const cleanKey  = key.trim();
  const keyHash   = createHash('sha256').update(cleanKey).digest('hex').slice(0, 32);
  const blobPath  = `tunnel-map/${keyHash}.json`;
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;

  try {
    // --- Check if already provisioned (idempotent) ---
    const { blobs } = await list({ prefix: `tunnel-map/${keyHash}`, token: blobToken });
    if (blobs.length > 0) {
      const data = await fetch(blobs[0].url).then(r => r.json());
      console.log(`[provision-tunnel] returning existing: ${data.hostname}`);
      return res.status(200).json({ hostname: data.hostname, token: data.token });
    }

    // --- Get CF zone ID ---
    const zonesResp = await cfFetch('GET', `/zones?name=${DOMAIN}`);
    const zoneId    = zonesResp.result?.[0]?.id;
    if (!zoneId) throw new Error('Cloudflare zone not found for ' + DOMAIN);

    // --- Generate unique TD code (retry if CNAME collision) ---
    let tdCode, hostname, tunnelId, token;
    for (let attempt = 0; attempt < 5; attempt++) {
      const tdNum = 1000 + Math.floor(Math.random() * 9000);
      tdCode   = `td${tdNum}`;
      hostname = `${tdCode}.${DOMAIN}`;

      // Create tunnel
      const tunnelResp = await cfFetch('POST', `/accounts/${CF_ACCOUNT_ID}/cfd_tunnel`, {
        name: `novo-${tdCode}-${keyHash.slice(0, 8)}`,
      });
      tunnelId = tunnelResp.result?.id;
      if (!tunnelId) {
        const errMsg = JSON.stringify(tunnelResp.errors || tunnelResp);
        throw new Error(`Tunnel creation failed: ${errMsg}`);
      }

      // Get token
      const tokenResp = await cfFetch('GET', `/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/token`);
      token = tokenResp.result;
      if (!token) throw new Error('Failed to retrieve tunnel token');

      // Create DNS CNAME (skip on duplicate, pick new TD code next loop)
      const dnsResp = await cfFetch('POST', `/zones/${zoneId}/dns_records`, {
        type: 'CNAME', name: tdCode,
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true, ttl: 1,
      });
      if (dnsResp.success) break;
      const dnsErr = dnsResp.errors?.[0]?.message || '';
      if (!dnsErr.includes('already exists')) throw new Error(`DNS error: ${dnsErr}`);
      // CNAME collision — delete the tunnel we just made and retry with new TD code
      await cfFetch('DELETE', `/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}`).catch(() => {});
    }

    // --- Persist mapping in Vercel Blob ---
    const mapping = { hostname, tunnelId, token, keyHash, createdAt: new Date().toISOString() };
    await put(blobPath, JSON.stringify(mapping), {
      access: 'public',
      addRandomSuffix: false,
      token: blobToken,
    });

    console.log(`[provision-tunnel] provisioned: ${hostname}`);
    return res.status(200).json({ hostname, token });

  } catch (err) {
    console.error('[provision-tunnel] ERROR:', err.message);
    return res.status(500).json({ error: 'Provisioning failed — contact support.' });
  }
};
