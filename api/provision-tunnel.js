// provision-tunnel.js
// Called by buyer's setup.ps1 at install time.
// POST { key: "<license_key>" }
// Returns { hostname: "td1234.novo-aitrading.app", token: "eyJ..." }
// Idempotent: same license key always returns the same permanent URL.

const { list, put } = require('@vercel/blob');
const { createHash, createHmac, timingSafeEqual } = require('crypto');
const https           = require('https');

// Self-contained authenticity check — no license-server round-trip needed.
// Both NOVO- (one-time) and NOVS- (subscription) keys embed an HMAC signature of
// their own body: sig = HMAC(NOVO_LICENSE_SECRET, token)[0:8], where token is the
// two middle segments. A random or forged string can't produce a valid signature
// without the secret, so this rejects abuse before we ever create a CF tunnel.
// (Note: this proves the key was issued by us, not that the subscription is still
// active — license_check.py blocks suspended/cancelled keys at app runtime.)
function verifyLicenseKey(key) {
  const secret = process.env.NOVO_LICENSE_SECRET;
  if (!secret) return false;
  const m = /^(NOVO|NOVS)-([0-9A-F]{8})-([0-9A-F]{8})-([0-9A-F]{8})$/.exec(key);
  if (!m) return false;
  const token = m[2] + m[3];
  const expected = createHmac('sha256', secret).update(token).digest('hex').substring(0, 8).toUpperCase();
  const a = Buffer.from(expected);
  const b = Buffer.from(m[4]);
  return a.length === b.length && timingSafeEqual(a, b);
}

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

  const cleanKey  = key.trim().toUpperCase();
  if (!verifyLicenseKey(cleanKey)) {
    console.warn(`[provision-tunnel] rejected key with invalid signature from ${ip}`);
    return res.status(403).json({ error: 'Invalid license key.' });
  }

  // Gate on license STATUS (not just signature) — a cancelled/suspended/revoked key must not be able to
  // mint a Cloudflare tunnel + DNS record (infra/cost abuse). FAIL OPEN on any license-server error so a
  // transient LS outage never breaks a legitimate buyer's install.
  try {
    const LS = (process.env.NOVO_LICENSE_SERVER_URL || '').replace(/\/$/, '');
    if (LS && process.env.LICENSE_ADMIN_KEY) {
      const sr = await fetch(`${LS}/admin/key-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': process.env.LICENSE_ADMIN_KEY },
        body: JSON.stringify({ key: cleanKey }),
      });
      if (sr.ok) {
        const st = await sr.json();
        if (st.found && st.status !== 'active') {
          console.warn(`[provision-tunnel] refused: key status=${st.status} from ${ip}`);
          return res.status(403).json({ error: 'License is not active. Reactivate it, then re-run setup.' });
        }
      }
    }
  } catch (_e) { /* fail-open: LS unreachable -> proceed so installs never break on a blip */ }

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

    // Re-check just before persist: if a concurrent install of the SAME key already provisioned (the idempotency
    // race), tear down the duplicate tunnel we just made and return the existing mapping instead of creating a
    // second one. Shrinks the race window from the whole handler to just the final blob write.
    try {
      const { blobs: existing } = await list({ prefix: `tunnel-map/${keyHash}`, token: blobToken });
      if (existing.length > 0) {
        const data = await fetch(existing[0].url).then(r => r.json());
        await cfFetch('DELETE', `/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}`).catch(() => {});
        // also delete the CNAME we created for this now-discarded tdCode, or it orphans in the zone
        try {
          const rec = await cfFetch('GET', `/zones/${zoneId}/dns_records?type=CNAME&name=${tdCode}.${DOMAIN}`);
          const recId = rec.result?.[0]?.id;
          if (recId) await cfFetch('DELETE', `/zones/${zoneId}/dns_records/${recId}`).catch(() => {});
        } catch (_) {}
        console.log(`[provision-tunnel] concurrent provision detected — returning existing: ${data.hostname}`);
        return res.status(200).json({ hostname: data.hostname, token: data.token });
      }
    } catch (_) {}

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
