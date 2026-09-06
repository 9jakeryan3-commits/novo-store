/* x-allowlist-check.js — proves NoVo cannot quote an account nobody vetted.
 *
 * THE THREAT IS LIVE, NOT THEORETICAL. Einstein's verification of the source list turned up three
 * separate spoof vectors on the single account we would most want to quote:
 *
 *   @DeItaone     1,918,688  the real Walter Bloomberg (capital I)
 *   @deltaone         2,056  homoglyph twin (lowercase l) — indistinguishable in most fonts
 *   @WalterBloomberg 11,494  display-name twin
 *
 * So the checks below are built around an ACTUAL IMPERSONATION ATTEMPT: the stub returns posts
 * from the real account, both twins, and an unlisted account, and the client must publish exactly
 * one of them. A test that only feeds legitimate posts would pass against a client with no filter
 * at all.
 *
 * Network is stubbed. Runs offline, deterministically, no token, no quota.
 */

const path = require('path');
const CLIENT = path.join(__dirname, '..', 'api', '_lib', 'x-client.js');
const SOURCES = require(path.join(__dirname, '..', 'api', '_lib', 'x-sources.json'));

let failures = 0, checks = 0;
function ok(name, cond, detail) {
  checks++;
  if (cond) { console.log('  PASS  ' + name); return; }
  failures++;
  console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
}

const REAL_DELTAONE = '2704294333';        // @DeItaone, from the vetted list
const REUTERS = '1652541';

/* One real wire post, two impersonators, one merely-unlisted account. The impersonators are given
 * FAR higher engagement than the real post, so any implementation that down-weights instead of
 * dropping puts them at the top. */
function impersonationPayload() {
  return {
    data: [
      { id: '1', author_id: '9999000001', created_at: '2026-09-06T01:00:00Z',
        text: 'BREAKING: FED CUTS BY 50BP', public_metrics: { like_count: 50000, retweet_count: 20000 } },
      { id: '2', author_id: '9999000002', created_at: '2026-09-06T01:01:00Z',
        text: 'BREAKING: FED CUTS BY 50BP', public_metrics: { like_count: 40000, retweet_count: 15000 } },
      { id: '3', author_id: REAL_DELTAONE, created_at: '2026-09-06T01:02:00Z',
        text: '*FED HOLDS RATES STEADY', public_metrics: { like_count: 900, retweet_count: 300 } },
      { id: '4', author_id: '9999000003', created_at: '2026-09-06T01:03:00Z',
        text: 'my hot take on the fed', public_metrics: { like_count: 80000, retweet_count: 40000 } },
    ],
    includes: { users: [
      // Note what the payload CLAIMS. The homoglyph twin asserts the real handle's display name
      // and a huge follower count; if anything downstream trusts the response's own fields
      // instead of our vetted record, this is what it renders.
      { id: '9999000001', username: 'deltaone', name: '*Walter Bloomberg',
        public_metrics: { followers_count: 1918688 } },
      { id: '9999000002', username: 'WalterBloomberg', name: 'Walter Bloomberg',
        public_metrics: { followers_count: 11494 } },
      /* ⚠ THE REAL ACCOUNT'S PAYLOAD FIELDS DELIBERATELY DISAGREE WITH OUR VETTED RECORD, and
         that is the only reason the attribution check can fail at all. The first version of this
         stub echoed the true handle here — so "attributed from our record" and "attributed from
         the response" produced an IDENTICAL string, and the check passed against a client that
         trusted the payload completely. A check that cannot fail, in the file written to catch
         impersonation.
         The disagreement is also the realistic case rather than a contrived one: X handles are
         RENAMEABLE by their owner. author_id survives a rename; the username in a response does
         not. If @DeItaone renames tomorrow, a payload-attributed quote silently changes who NoVo
         says it is quoting while the id stays perfectly correct. */
      { id: REAL_DELTAONE, username: 'renamed_after_we_vetted_it', name: 'Something Else',
        public_metrics: { followers_count: 7 } },
      { id: '9999000003', username: 'randomtrader', name: 'Random Trader',
        public_metrics: { followers_count: 500 } },
    ] },
  };
}

let lastUrl = null;
function loadClient(payload) {
  const realFetch = global.fetch, realTok = process.env.X_BEARER_TOKEN;
  process.env.X_BEARER_TOKEN = 'test-token-not-a-real-credential';
  global.fetch = async (u) => { lastUrl = u; return { ok: true, status: 200, json: async () => payload }; };
  delete require.cache[require.resolve(CLIENT)];
  const c = require(CLIENT);
  return { client: c, restore() {
    global.fetch = realFetch;
    if (realTok === undefined) delete process.env.X_BEARER_TOKEN; else process.env.X_BEARER_TOKEN = realTok;
  } };
}
async function posts(payload, symbol, opts) {
  const { client, restore } = loadClient(payload);
  try { return await client.recentPosts(symbol, null, 10, opts); } finally { restore(); }
}

(async () => {
  console.log('\nX source-allowlist checks\n');

  /* ── 1. THE SOURCE FILE ITSELF ───────────────────────────────────────────────────────────── */
  {
    const all = [];
    for (const t of Object.keys(SOURCES.tiers)) for (const s of SOURCES.tiers[t].sources) all.push(s);
    ok('every source carries a string author_id',
      all.length === 39 && all.every((s) => typeof s.id === 'string' && /^\d+$/.test(s.id)),
      'n=' + all.length);
    ok('no duplicate ids', new Set(all.map((s) => s.id)).size === all.length);
    ok('every company-tier source is bound to its own ticker',
      SOURCES.tiers.company.sources.every((s) => typeof s.ticker === 'string' && s.ticker.length),
      JSON.stringify(SOURCES.tiers.company.sources.map((s) => [s.handle, s.ticker])));
    // The real one is in; both twins must be absent by id AND by handle.
    const handles = all.map((s) => s.handle);
    ok('the REAL @DeItaone is listed and both twins are not',
      handles.indexOf('DeItaone') !== -1 &&
      handles.indexOf('deltaone') === -1 && handles.indexOf('WalterBloomberg') === -1,
      JSON.stringify(handles.filter((h) => /delta|walter/i.test(h))));
  }

  /* ── 2. THE IMPERSONATION ATTEMPT ────────────────────────────────────────────────────────── */
  {
    const r = await posts(impersonationPayload(), null, { allowlistOnly: true, tiers: ['wire'] });
    ok('exactly one post survives the id filter',
      r.posts.length === 1, JSON.stringify(r.posts.map((p) => p.author)));
    ok('and it is the REAL account',
      r.posts.length === 1 && r.posts[0].author === '@DeItaone', JSON.stringify(r.posts[0]));
    ok('the homoglyph twin is DROPPED, not merely ranked lower',
      !r.posts.some((p) => /deltaone/.test(p.author)) &&
      !r.posts.some((p) => p.text.indexOf('CUTS BY 50BP') !== -1),
      JSON.stringify(r.posts));
    ok('the drop is COUNTED, not silent',
      r.allowlist.dropped_unlisted === 3 && r.allowlist.returned_before_filter === 4,
      JSON.stringify(r.allowlist));
    ok('attribution comes from our vetted record, not the payload',
      r.posts[0].author === '@DeItaone' && r.posts[0].tier === 'wire' &&
      r.posts[0].followers === 1918688,
      JSON.stringify(r.posts[0]));
  }

  /* ── 3. THE QUERY IS NARROWED SERVER-SIDE ────────────────────────────────────────────────── */
  {
    await posts(impersonationPayload(), null, { allowlistOnly: true, tiers: ['wire'] });
    const q = decodeURIComponent(lastUrl);
    ok('the request carries from: clauses (without them the filter returns [] every time)',
      q.indexOf('from:Reuters') !== -1 && q.indexOf('from:DeItaone') !== -1, q.slice(0, 200));
    ok('the from: clause never names a twin', q.indexOf('from:deltaone') === -1, q.slice(0, 200));
  }

  /* ── 4. THE COMPANY-TIER RULE IS ENFORCED, NOT DOCUMENTED ────────────────────────────────── */
  {
    const tsla = await posts({ data: [], includes: {} }, 'TSLA', { allowlistOnly: true, tiers: ['company'] });
    const q1 = decodeURIComponent(lastUrl);
    ok('elonmusk and Tesla are sources on TSLA',
      q1.indexOf('from:elonmusk') !== -1 && q1.indexOf('from:Tesla') !== -1, q1.slice(0, 200));
    ok('...and Apple is not a source on TSLA',
      q1.indexOf('from:Apple') === -1, q1.slice(0, 200));

    const spy = await posts({ data: [], includes: {} }, 'SPY', { allowlistOnly: true, tiers: ['company'] });
    ok('no company account is a source on the market (SPY -> nothing eligible)',
      spy.posts.length === 0 && spy.allowlist.sources_queried === 0,
      JSON.stringify(spy.allowlist));
  }

  /* ── 5. NO SILENT CAPS ───────────────────────────────────────────────────────────────────── */
  {
    const r = await posts(impersonationPayload(), null, { allowlistOnly: true });
    ok('with every tier requested, sources that did not fit the budget are NAMED',
      Array.isArray(r.allowlist.sources_omitted), JSON.stringify(r.allowlist.sources_omitted));
    ok('and the number actually queried is reported alongside them',
      r.allowlist.sources_queried > 0 &&
      r.allowlist.sources_queried + r.allowlist.sources_omitted.length === 31,
      'queried=' + r.allowlist.sources_queried + ' omitted=' + r.allowlist.sources_omitted.length + "  (31 eligible: 39 minus the 8 company accounts, which need a matching ticker)");
  }

  /* ── 6. THE UNFILTERED PATH IS UNCHANGED ─────────────────────────────────────────────────── */
  {
    const r = await posts(impersonationPayload(), null);
    ok('without allowlistOnly the old behaviour is intact (volume must not be filtered)',
      r.posts.length === 4 && !r.allowlist, JSON.stringify(r.posts.length));
  }

  /* ── 7. THE TOPIC IS WRITTEN THE WAY A WIRE WRITES IT ────────────────────────────────────────
   * The defect these catch shipped once already: `($SPY) (from:Reuters OR ...)` returned ZERO
   * posts for SPY, QQQ and IWM — 100% of the analyst's covered universe — and returned them
   * silently, with sources_queried 23 and dropped_unlisted 0. Measured live by Einstein.
   * The checks assert the QUERY, not the result, because the result depends on what X happens to
   * be carrying that hour; the query is the thing that was wrong. */
  {
    await posts({ data: [], includes: {} }, 'SPY', { allowlistOnly: true, tiers: ['wire'] });
    const q = decodeURIComponent(lastUrl);
    ok('SPY asks for the INDEX the way a wire writes it, not just the cashtag',
      q.indexOf('S&P 500') !== -1, q.slice(0, 160));
    ok('...and keeps the cashtag as an OR term so trader posts still match',
      q.indexOf('$SPY') !== -1 && q.indexOf('OR $SPY') !== -1, q.slice(0, 160));
    ok('the topic is ANDed with the sources, not substituted for them',
      q.indexOf('from:Reuters') !== -1, q.slice(0, 160));
  }

  /* ── 8. VOLUME MUST NOT INHERIT THE TOPIC MAP ────────────────────────────────────────────────
   * counts/recent measures TRADER attention. Swapping $SPY for "S&P 500" would measure a
   * different population under the same label — a new denominator wearing the old name, which is
   * the failure this whole file's history is made of. */
  {
    const { client, restore } = loadClient({ data: [
      { start: '2026-09-05T00:00:00Z', end: '2026-09-05T01:00:00Z', tweet_count: 50 },
      { start: '2026-09-05T01:00:00Z', end: '2026-09-05T02:00:00Z', tweet_count: 50 },
    ], meta: { total_tweet_count: 100 } });
    try { await client.mentionVolume('SPY'); } finally { restore(); }
    const q = decodeURIComponent(lastUrl);
    // ⚠ THESE TWO ARE A PAIR AND THE SECOND IS THE ONE THAT DISCRIMINATES. The SPY topic clause
    // CONTAINS "$SPY" as an OR term, so the cashtag check passes even if volume wrongly inherited
    // the map. Do not delete the second one as redundant — it is the whole test.
    ok('the VOLUME query still uses the cashtag',
      q.indexOf('$SPY') !== -1, q.slice(0, 160));
    ok('...and never the wire-prose topic clause',
      q.indexOf('S&P 500') === -1, q.slice(0, 160));
  }

  /* ── 8b. THE ASSEMBLED QUERY FITS X'S CAP ────────────────────────────────────────────────────
   * QUERY_BUDGET bounds the from: clause alone; the topic, the operators and the parentheses ride
   * on top of it. A budget that only counts part of the string is a limit that does not limit. */
  {
    let worst = 0;
    for (const sym of ['SPY', 'NVDA', null]) {
      await posts({ data: [], includes: {} }, sym, { allowlistOnly: true });
      const u = new URL(lastUrl);
      worst = Math.max(worst, decodeURIComponent(u.searchParams.get('query')).length);
    }
    ok('the longest assembled query stays under X\'s 512-character cap',
      worst <= 512, 'longest=' + worst);
  }

  /* ── 9. AN EMPTY RESULT SAYS WHICH KIND OF EMPTY IT IS ───────────────────────────────────────
   * posts: [] meant three different things and only one was visible. "We asked and they were
   * silent" is a finding; "we asked in a language they do not speak" is a broken query. NoVo will
   * narrate that difference away if the payload does not carry it. */
  {
    const mapped = await posts({ data: [], includes: {} }, 'SPY', { allowlistOnly: true, tiers: ['wire'] });
    ok('a mapped symbol returning nothing reports the sources as SILENT',
      mapped.allowlist.topic_expressed_as === 'topic_clause' &&
      mapped.allowlist.no_posts_reason === 'sources_silent',
      JSON.stringify(mapped.allowlist));

    // An unmapped symbol falls back to the cashtag, which we now know is a weak query against
    // wires — so its emptiness is NOT evidence of silence and must not be reported as such.
    const unmapped = await posts({ data: [], includes: {} }, 'XLE', { allowlistOnly: true, tiers: ['wire'] });
    ok('an UNMAPPED symbol admits its query was weak rather than claiming silence',
      unmapped.allowlist.topic_expressed_as === 'cashtag_only' &&
      unmapped.allowlist.no_posts_reason === 'weak_topic_query',
      JSON.stringify(unmapped.allowlist));

    const found = await posts(impersonationPayload(), 'SPY', { allowlistOnly: true, tiers: ['wire'] });
    ok('and when posts DO come back there is no reason attached',
      found.posts.length > 0 && found.allowlist.no_posts_reason === null,
      JSON.stringify(found.allowlist.no_posts_reason));
  }

  /* ── 10. BUDGET OVERFLOW AND A FAILED CALL ARE DIFFERENT FACTS ───────────────────────────────
   * Folding them into one list makes "we ran out of room" indistinguishable from "the wire call
   * errored" — the same conflation section 9 exists to undo, one level down. */
  {
    const r = await posts(impersonationPayload(), null, { allowlistOnly: true });
    ok('sources_omitted and source_groups_failed are separate fields',
      Array.isArray(r.allowlist.sources_omitted) && Array.isArray(r.allowlist.source_groups_failed),
      JSON.stringify({ omitted: r.allowlist.sources_omitted, failed: r.allowlist.source_groups_failed }));
    ok('a clean run reports no failed groups',
      r.allowlist.source_groups_failed.length === 0, JSON.stringify(r.allowlist.source_groups_failed));
  }

  console.log('\n' + (failures ? 'FAILED ' + failures + '/' + checks : 'OK ' + checks + '/' + checks) + '\n');
  process.exit(failures ? 1 : 0);
})();
