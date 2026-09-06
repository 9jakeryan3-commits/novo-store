/* x-endpoint-check.js — the gate, the cache and the two rules the endpoint must enforce for
 * callers that cannot enforce them for themselves.
 *
 * This endpoint exists so the crypto collector and the engine's Python reports do not each grow
 * their own X fetcher. That makes it the boundary where "please follow the rule" has to become
 * "the rule is applied for you", because a caller in another repo and another language will not
 * pass a flag it does not know about. Two things therefore cannot be defaults:
 *
 *   * the auth gate must run BEFORE any X call, or an unauthenticated request can spend our quota
 *   * posts must be allowlisted whether or not the caller asked, because @DeItaone has a live
 *     homoglyph twin and a missing flag would hand it NoVo's voice
 *
 * Network and KV are both stubbed, so this runs offline with no token and no quota.
 */

const path = require('path');
const HANDLER = path.join(__dirname, '..', 'api', 'x-mentions.js');
const KVPATH = path.join(__dirname, '..', 'api', '_kv.js');

let failures = 0, checks = 0;
function ok(name, cond, detail) {
  checks++;
  if (cond) { console.log('  PASS  ' + name); return; }
  failures++;
  console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
}

const SECRET = 'test-secret-not-a-real-credential';

function fakeRes() {
  const r = { code: null, body: null, headers: {}, ended: false };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => { r.ended = true; return r; };
  return r;
}

/* A KV stub that records writes, so "the cache is a mechanism not a convention" is testable. */
function makeStore() {
  const m = new Map();
  return { m, get: async (k) => m.get(k) || null, set: async (k, v) => { m.set(k, v); } };
}

let xCalls = 0, lastUrls = [];
function load(payload, store) {
  xCalls = 0; lastUrls = [];
  const realFetch = global.fetch, realTok = process.env.X_BEARER_TOKEN, realSec = process.env.ANALYST_PUBLISH_SECRET;
  process.env.X_BEARER_TOKEN = 'test-token';
  process.env.ANALYST_PUBLISH_SECRET = SECRET;
  global.fetch = async (u) => { xCalls++; lastUrls.push(u); return { ok: true, status: 200, json: async () => payload }; };
  for (const p of [HANDLER, KVPATH, path.join(__dirname, '..', 'api', '_lib', 'x-client.js')]) {
    delete require.cache[require.resolve(p)];
  }
  const kvmod = require(KVPATH);
  kvmod.kv = () => store || null;                       // swap the shared client for the stub
  require.cache[require.resolve(KVPATH)].exports = kvmod;
  const h = require(HANDLER);
  return { h, restore() {
    global.fetch = realFetch;
    if (realTok === undefined) delete process.env.X_BEARER_TOKEN; else process.env.X_BEARER_TOKEN = realTok;
    if (realSec === undefined) delete process.env.ANALYST_PUBLISH_SECRET; else process.env.ANALYST_PUBLISH_SECRET = realSec;
  } };
}

function counts() {
  const rows = [];
  const end = new Date('2026-09-03T18:00:00Z');
  for (let i = 168; i >= 1; i--) {
    const s = new Date(end.getTime() - i * 3600000);
    rows.push({ start: s.toISOString(), end: new Date(s.getTime() + 3600000).toISOString(),
                tweet_count: 40 + (i % 30) });
  }
  rows.push({ start: end.toISOString(), end: new Date(end.getTime() + 2580000).toISOString(), tweet_count: 5 });
  return { data: rows, meta: { total_tweet_count: rows.reduce((a, b) => a + b.tweet_count, 0) } };
}

async function call(query, headers, store, payload) {
  const { h, restore } = load(payload || counts(), store);
  const res = fakeRes();
  try { await h({ method: 'GET', query: query, headers: headers || {} }, res); } finally { restore(); }
  return res;
}

(async () => {
  console.log('\nX endpoint checks\n');

  /* ── 1. THE GATE RUNS BEFORE ANY X CALL ──────────────────────────────────────────────────────
   * "401 was returned" is not enough. If the handler fetched first and rejected after, an
   * unauthenticated request would still spend quota — a gate that costs exactly what it prevents.
   * xCalls is the discriminating assertion; the status code alone is not. */
  {
    const res = await call({ symbol: 'SPY' }, {});
    ok('no key -> 401', res.code === 401, JSON.stringify(res.body));
    ok('...and ZERO X calls were made (the gate runs first, not after)', xCalls === 0, 'xCalls=' + xCalls);

    const bad = await call({ symbol: 'SPY' }, { 'x-novo-key': 'wrong' });
    ok('wrong key -> 401', bad.code === 401, JSON.stringify(bad.body));
    ok('...and still zero X calls', xCalls === 0, 'xCalls=' + xCalls);
  }

  /* ── 2. THE HAPPY PATH ───────────────────────────────────────────────────────────────────── */
  {
    const res = await call({ symbol: 'SPY' }, { 'x-novo-key': SECRET }, makeStore());
    ok('valid key -> 200 with a ranked volume',
      res.code === 200 && res.body.ok === true && res.body.volume &&
      typeof res.body.volume.percentile_of_own_history === 'number',
      JSON.stringify(res.body && res.body.volume && res.body.volume.percentile_of_own_history));
    ok('the pool the rank was taken against is named in the payload',
      res.body.volume.ranked_against && res.body.volume.ranked_against.n > 0,
      JSON.stringify(res.body.volume.ranked_against));
    ok('never edge-cached', res.headers['cache-control'] === 'no-store', res.headers['cache-control']);
  }

  /* ── 3. THE RATE BUDGET IS A MECHANISM, NOT A REQUEST ────────────────────────────────────────
   * Xavier's objection was arithmetic and Timmy's dealer map polls every 15s per member. A second
   * caller must cost ZERO X calls, or the cache is decorative. */
  {
    const store = makeStore();
    await call({ symbol: 'BTC' }, { 'x-novo-key': SECRET }, store);
    const first = xCalls;
    const second = await call({ symbol: 'BTC' }, { 'x-novo-key': SECRET }, store);
    ok('the first caller spends one X call', first === 1, 'xCalls=' + first);
    ok('the SECOND caller spends none (shared cache, not per-caller)',
      xCalls === 0 && second.body.cached === true, 'xCalls=' + xCalls + ' cached=' + second.body.cached);
    ok('and gets the same ranked number, not a re-derivation',
      second.body.volume && typeof second.body.volume.percentile_of_own_history === 'number',
      JSON.stringify(second.body.volume && second.body.volume.percentile_of_own_history));
  }

  /* ── 4. POSTS ARE ALLOWLISTED WHETHER OR NOT THE CALLER ASKED ───────────────────────────────
   * The whole reason this endpoint exists is callers in other languages. They will not pass a flag
   * they do not know about, so allowlisting cannot be opt-in here. */
  {
    const payload = {
      data: [{ id: '1', author_id: '9999000001', created_at: '2026-09-06T01:00:00Z',
               text: 'BREAKING: FED CUTS BY 50BP', public_metrics: { like_count: 99999, retweet_count: 5000 } }],
      includes: { users: [{ id: '9999000001', username: 'deltaone', name: '*Walter Bloomberg',
                            public_metrics: { followers_count: 1918688 } }] },
    };
    const res = await call({ symbol: 'SPY', posts: '1' }, { 'x-novo-key': SECRET }, makeStore(), payload);
    ok('the caller did not ask for the allowlist and got it anyway',
      res.body.posts && res.body.posts.allowlist &&
      res.body.posts.allowlist.mode === 'allowlist_only',
      JSON.stringify(res.body.posts && res.body.posts.allowlist));
    // ⚠ These read through OPTIONAL chaining deliberately. The first version dereferenced
    // res.body.posts.allowlist.note directly, so when the allowlist was sabotaged away the check
    // THREW instead of failing — killing the run before the summary printed. A harness that
    // crashes on the defect it is testing reports nothing at all, which is worse than a red line:
    // an aborted run and a passing run both end without a FAILED count.
    ok('the impersonator is not returned to a cross-language caller',
      res.body.posts?.posts?.length === 0 && res.body.posts?.allowlist?.dropped_unlisted === 1,
      JSON.stringify(res.body.posts && res.body.posts.posts));
    ok('the doctrine note travels to the other language too',
      /CANDIDATE catalyst/.test(res.body.posts?.allowlist?.note || ''),
      res.body.posts && res.body.posts.allowlist && res.body.posts.allowlist.note);
  }

  /* ── 5. POSTS ARE NOT CACHED ────────────────────────────────────────────────────────────────
   * A five-minute-old "catalyst" served as current is the staleness failure the product argues
   * against. Volume is a 7-day distribution and caches fine; a headline does not. */
  {
    const store = makeStore();
    await call({ symbol: 'SPY', posts: '1' }, { 'x-novo-key': SECRET }, store);
    const before = store.m.size;
    const second = await call({ symbol: 'SPY', posts: '1' }, { 'x-novo-key': SECRET }, store);
    ok('a posts request writes nothing to the cache', before === 0, 'entries=' + before);
    ok('and a second posts request is served fresh, never from cache',
      second.body.cached === false && xCalls > 0, 'cached=' + second.body.cached + ' xCalls=' + xCalls);
  }

  /* ── 5b. THE PERSISTABLE SERIES NEVER CONTAINS A PARTIAL HOUR ───────────────────────────────
   * This is stricter than the live path on purpose. A live rank that included the in-progress
   * hour is wrong for one request and self-corrects on the next. A STORED partial hour is wrong
   * FOREVER — indistinguishable from a genuinely quiet hour the moment it lands, unrepairable
   * because X will not serve that window again, and inherited by every percentile computed
   * against it afterwards. The corpus has no undo, so this is the boundary that has to hold. */
  {
    const payload = counts();
    const inProgress = payload.data[payload.data.length - 1];
    const res = await call({ symbol: 'BTC', buckets: '1' }, { 'x-novo-key': SECRET }, makeStore(), payload);
    const b = res.body.volume.complete_buckets;
    ok('buckets=1 returns the hourly series', Array.isArray(b) && b.length === 168, 'n=' + (b && b.length));
    ok('and the IN-PROGRESS hour is not among them',
      !b.some((x) => x.start === inProgress.start),
      'in-progress start=' + inProgress.start);
    ok('every returned bucket is a full hour',
      b.every((x) => (new Date(x.end) - new Date(x.start)) === 3600000),
      JSON.stringify(b.filter((x) => (new Date(x.end) - new Date(x.start)) !== 3600000).slice(0, 2)));
    ok('the series carries the reason it excludes the fragment',
      /never be stored/.test(res.body.volume.buckets_note || ''), res.body.volume.buckets_note);

    // A bucket request must not be served a cached summary that has no buckets in it — the
    // collector would then store nothing and log a success.
    const store = makeStore();
    await call({ symbol: 'BTC' }, { 'x-novo-key': SECRET }, store, payload);       // warm summary
    const second = await call({ symbol: 'BTC', buckets: '1' }, { 'x-novo-key': SECRET }, store, payload);
    ok('a buckets request is never served from the summary cache',
      Array.isArray(second.body.volume.complete_buckets) &&
      second.body.volume.complete_buckets.length === 168 && second.body.cached === false,
      'cached=' + second.body.cached + ' buckets=' +
      (second.body.volume.complete_buckets && second.body.volume.complete_buckets.length));
  }

  /* ── 6. A MISSING CREDENTIAL IS NOT A QUIET TAPE ────────────────────────────────────────────
   * Xavier's billing point generalised: a configuration state must never render as low chatter. */
  {
    const realTok = process.env.X_BEARER_TOKEN;
    delete process.env.X_BEARER_TOKEN;
    const { h, restore } = load(counts(), makeStore());
    delete process.env.X_BEARER_TOKEN;                  // load() sets it; clear again for this case
    const res = fakeRes();
    await h({ method: 'GET', query: { symbol: 'SPY' }, headers: { 'x-novo-key': SECRET } }, res);
    restore();
    if (realTok !== undefined) process.env.X_BEARER_TOKEN = realTok;
    ok('no token -> an explicit configuration state, not a zero',
      res.body.ok === false && res.body.reason === 'x_not_configured',
      JSON.stringify(res.body));
    ok('...and it says so in words a renderer cannot mistake for "quiet"',
      /NOT a quiet tape/.test(res.body.note || ''), res.body.note);
  }

  console.log('\n' + (failures ? 'FAILED ' + failures + '/' + checks : 'OK ' + checks + '/' + checks) + '\n');
  process.exit(failures ? 1 : 0);
})();
