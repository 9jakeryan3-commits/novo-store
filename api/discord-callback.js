// Step 2: Discord redirects here after consent. Verify the Stripe session is a paid Analyst sub,
// capture the Discord user id (stored on the Stripe customer), add them to the server + grant the
// Analyst role. All best-effort; on any failure we bounce back with ?discord=error.
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const GUILD = process.env.DISCORD_GUILD_ID || '1522967079400112198';
const ROLE = process.env.DISCORD_ROLE_ID || '1522973509565943982';

module.exports = async (req, res) => {
  const SITE = process.env.SITE_URL || 'https://novo-aitrading.app';
  const back = (state) => { res.writeHead(302, { Location: `${SITE}/analyst?welcome=1&discord=${state}` }); res.end(); };
  try {
    const code = (req.query.code || '').toString();
    const cs = (req.query.state || '').toString();
    if (!code || !cs) return back('error');

    // 1. verify this is a genuine paid Analyst checkout session
    const sess = await stripe.checkout.sessions.retrieve(cs);
    if (!sess || sess.payment_status !== 'paid' || sess.metadata?.tier !== 'analyst') return back('error');
    const customerId = sess.customer;

    // 2. exchange the code for a Discord access token
    const redirect = `${SITE}/api/discord-callback`;
    const tokRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code, redirect_uri: redirect,
      }),
    });
    if (!tokRes.ok) return back('error');
    const tok = await tokRes.json();
    const access = tok.access_token;
    if (!access) return back('error');

    // 3. identify the Discord user
    const meRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${access}` } });
    if (!meRes.ok) return back('error');
    const uid = (await meRes.json()).id;
    if (!uid) return back('error');

    // 4. remember the link on the Stripe customer (so cancel can revoke the role later)
    if (customerId) {
      try { await stripe.customers.update(customerId, { metadata: { discord_id: uid } }); } catch (e) {}
    }

    // 5. add them to the server (guilds.join) with the Analyst role, then ensure the role if already a member
    const bot = process.env.DISCORD_BOT_TOKEN;
    if (bot) {
      try {
        await fetch(`https://discord.com/api/guilds/${GUILD}/members/${uid}`, {
          method: 'PUT',
          headers: { Authorization: `Bot ${bot}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: access, roles: [ROLE] }),
        });
      } catch (e) {}
      try {
        await fetch(`https://discord.com/api/guilds/${GUILD}/members/${uid}/roles/${ROLE}`, {
          method: 'PUT', headers: { Authorization: `Bot ${bot}` },
        });
      } catch (e) {}
    }
    return back('connected');
  } catch (e) {
    console.error('[discord-callback]', e.message);
    return back('error');
  }
};
