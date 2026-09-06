/* manifest-check.js — /llms.txt and /skill.md describe something that is actually true.
 *
 * Jake: "Publish skill.md and llms.txt ... They're getting discovered by every agent that reads a
 * manifest; we're invisible to all of them despite having the better instrument behind the door."
 *
 * A manifest is a PUBLIC FACTUAL CLAIM aimed at machines that will repeat it. The failure mode is
 * not a broken build, it is an agent confidently telling someone we serve an endpoint we do not, or
 * quoting a hit rate without the sample size. So this does not check that the files exist — it
 * checks that every endpoint and every tool NAMED in them answers, and that the two warnings that
 * stop an agent misreporting us are still present.
 *
 * ⚠ RUNS AGAINST PRODUCTION BY DEFAULT, because that is the only place a manifest matters. Pass a
 * base URL to point it elsewhere:  node scripts/manifest-check.js http://localhost:3000
 */
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'https://novo-options.trade';
const LOCAL = path.join(__dirname, '..', 'public');
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; NoVoManifestCheck/1.0)' };
let failures = 0, checks = 0;
const ok = (n, c, d) => { checks++; if (c) return console.log('  PASS  ' + n);
  failures++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); };

(async () => {
  console.log('\nAgent manifests describe something true  (' + BASE + ')\n');

  /* ── served, and readable rather than downloaded ──────────────────────────────────────────── */
  const served = {};
  for (const f of ['/llms.txt', '/skill.md']) {
    let r = null, body = '';
    try { r = await fetch(BASE + f, { headers: UA }); body = await r.text(); } catch (e) {}
    served[f] = body;
    ok(f + ' is served', r && r.status === 200, r ? 'HTTP ' + r.status : 'request failed');
    /* text/plain matters: with X-Content-Type-Options: nosniff set site-wide, a .md served as
       anything else downloads instead of rendering, and some agents will not read it at all. */
    const ct = r ? (r.headers.get('content-type') || '') : '';
    ok(f + ' is readable text, not a download', /text\/(plain|markdown)/i.test(ct), 'content-type: ' + ct);
  }

  const llms = served['/llms.txt'] || '';
  const skill = served['/skill.md'] || '';

  /* ── every endpoint the manifest names must answer ────────────────────────────────────────── */
  const endpoints = [...new Set((llms.match(/\/api\/[a-z0-9-]+/g) || []))];
  ok('llms.txt actually lists endpoints', endpoints.length >= 5, endpoints.join(' '));
  for (const e of endpoints) {
    if (e === '/api/mcp') continue;   // POST-only, checked separately below
    let s = 0;
    try { s = (await fetch(BASE + e, { headers: UA })).status; } catch (_) {}
    ok('  ' + e + ' answers', s === 200, 'HTTP ' + s);
  }

  /* ── every TOOL the skill names must exist on the live MCP server ─────────────────────────── */
  let live = [];
  try {
    const r = await fetch(BASE + '/api/mcp', {
      method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, UA),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const j = await r.json();
    live = ((j.result && j.result.tools) || []).map((t) => t.name);
  } catch (_) {}
  ok('the MCP server answers tools/list', live.length > 0, live.length + ' tools');

  /* Named in the docs but absent from the server is the dangerous direction: an agent will call it
     and fail. The reverse (a tool we ship but do not document) is only a missed opportunity. */
  const named = [...new Set(((llms + skill).match(/\b(get|ask)_[a-z_]+/g) || []))];
  const ghosts = named.filter((n) => !live.includes(n));
  ok('every tool named in the manifests exists on the server',
    ghosts.length === 0, 'named but absent: ' + ghosts.join(', '));
  const undocumented = live.filter((n) => !named.includes(n));
  ok('...and every tool the server exposes is documented',
    undocumented.length === 0, 'live but undocumented: ' + undocumented.join(', '));

  /* ── the two warnings that stop an agent misreporting us ──────────────────────────────────── */
  /* These are not style. Without the first, an agent reports a gated field as missing data. Without
     the second, it quotes 1,000+ scored sessions as a live forward record when most of that is a
     reconstructed backtest ending in 2023. Both are how a trading product gets torn apart. */
  ok('the manifests warn that free dealer levels are delayed and GATED',
    /gated/i.test(llms) && /gated/i.test(skill),
    'llms=' + /gated/i.test(llms) + ' skill=' + /gated/i.test(skill));
  ok('...and that the track record mixes a backtest with the live record',
    /backtest/i.test(llms) && /backtest/i.test(skill),
    'llms=' + /backtest/i.test(llms) + ' skill=' + /backtest/i.test(skill));

  /* ── claims that must not appear ──────────────────────────────────────────────────────────── */
  const advice = /\b(financial advice|investment advice|buy signal|guaranteed|we recommend you (buy|sell))\b/i;
  const bad = [llms, skill].filter((t) => advice.test(t) && !/not financial advice|never financial advice|no(t| ) ?a recommendation/i.test(t));
  ok('neither manifest reads as financial advice', bad.length === 0);
  ok('both state the coverage honestly (SPY, QQQ, IWM — not "all stocks")',
    /SPY, QQQ and IWM/.test(llms) && /SPY, QQQ and IWM/.test(skill));

  /* ── the local files match what is served ─────────────────────────────────────────────────── */
  for (const f of ['llms.txt', 'skill.md']) {
    let localTxt = '';
    try { localTxt = fs.readFileSync(path.join(LOCAL, f), 'utf8'); } catch (_) {}
    const remote = served['/' + f] || '';
    ok(f + ': what is deployed matches the repo',
      localTxt.trim().replace(/\r/g, '') === remote.trim().replace(/\r/g, ''),
      'local ' + localTxt.length + 'B vs served ' + remote.length + 'B');
  }

  console.log('\n' + (failures ? 'FAILED ' + failures + '/' + checks : 'OK ' + checks + '/' + checks) + '\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
