// Analyst → Discord link, ONE function (Vercel Hobby caps at 12 functions):
//   • no ?code  → connect leg: redirect to Discord OAuth (carries the Stripe session id in `state`)
//   • ?code     → callback leg: verify the paid Analyst session, capture the Discord user, store it on the
//                 Stripe customer, add them to the guild + grant the Analyst role.
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const GUILD = process.env.DISCORD_GUILD_ID || '1522967079400112198';
const ROLE = process.env.DISCORD_ROLE_ID || '1522973509565943982';

module.exports = async (req, res) => {
  const SITE = process.env.SITE_URL || 'https://novo-aitrading.app';
  const redirect = `${SITE}/api/discord`;
  const code = (req.query.code || '').toString();
  const state = (req.query.state || '').toString();
  const cs = (req.query.cs || '').toString().trim();

  // ── Callback leg ──────────────────────────────────────────────
  if (code) {
    const back = (s) => { res.writeHead(302, { Location: `${SITE}/analyst?welcome=1&discord=${s}` }); res.end(); };
    try {
      if (!state) return back('error');
      const sess = await stripe.checkout.sessions.retrieve(state);
      // Any PAID NoVo subscription (Analyst OR Pulse) earns the paid-Discord role. A valid paid session id
      // is unguessable, so this can't be forged without actually subscribing.
      if (!sess || sess.payment_status !== 'paid' || sess.mode !== 'subscription') return back('error');
      const customerId = sess.customer;
      const isAnalyst = sess.metadata?.tier === 'analyst';

      const tokRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code', code, redirect_uri: redirect,
        }),
      });
      if (!tokRes.ok) return back('error');
      const access = (await tokRes.json()).access_token;
      if (!access) return back('error');

      const meRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${access}` } });
      if (!meRes.ok) return back('error');
      const uid = (await meRes.json()).id;
      if (!uid) return back('error');

      if (customerId) { try { await stripe.customers.update(customerId, { metadata: { discord_id: uid } }); } catch (e) {} }

      const bot = process.env.DISCORD_BOT_TOKEN;
      if (bot) {
        try {
          await fetch(`https://discord.com/api/guilds/${GUILD}/members/${uid}`, {
            method: 'PUT', headers: { Authorization: `Bot ${bot}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ access_token: access, roles: [ROLE] }),
          });
        } catch (e) {}
        try {
          await fetch(`https://discord.com/api/guilds/${GUILD}/members/${uid}/roles/${ROLE}`, {
            method: 'PUT', headers: { Authorization: `Bot ${bot}` },
          });
        } catch (e) {}
      }
      res.writeHead(302, { Location: isAnalyst ? `${SITE}/analyst?welcome=1&discord=connected` : `${SITE}/analyst?discord=connected` });
      return res.end();
    } catch (e) { console.error('[discord cb]', e.message); return back('error'); }
  }

  // ── Connect leg ───────────────────────────────────────────────
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId) return res.status(503).send('Discord linking not configured.');
  if (!cs) { res.writeHead(302, { Location: `${SITE}/analyst` }); return res.end(); }
  const url = 'https://discord.com/api/oauth2/authorize'
    + `?client_id=${encodeURIComponent(clientId)}`
    + `&redirect_uri=${encodeURIComponent(redirect)}`
    + '&response_type=code'
    + `&scope=${encodeURIComponent('identify guilds.join')}`
    + `&state=${encodeURIComponent(cs)}&prompt=consent`;
  res.writeHead(302, { Location: url });
  res.end();
};
