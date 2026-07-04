// Step 1 of the Analyst → Discord link: redirect the subscriber to Discord's OAuth consent.
// Carries the Stripe checkout-session id through `state` so the callback can verify + attach it.
module.exports = async (req, res) => {
  const SITE = process.env.SITE_URL || 'https://novo-aitrading.app';
  const clientId = process.env.DISCORD_CLIENT_ID;
  const cs = (req.query.cs || '').toString().trim();
  if (!clientId) return res.status(503).send('Discord linking not configured.');
  if (!cs) { res.writeHead(302, { Location: `${SITE}/analyst` }); return res.end(); }
  const redirect = `${SITE}/api/discord-callback`;
  const url = 'https://discord.com/api/oauth2/authorize'
    + `?client_id=${encodeURIComponent(clientId)}`
    + `&redirect_uri=${encodeURIComponent(redirect)}`
    + '&response_type=code'
    + `&scope=${encodeURIComponent('identify guilds.join')}`
    + `&state=${encodeURIComponent(cs)}`
    + '&prompt=consent';
  res.writeHead(302, { Location: url });
  res.end();
};
