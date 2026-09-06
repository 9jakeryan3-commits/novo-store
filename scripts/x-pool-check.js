/* x-pool-check.js — proves the X mention percentile ranks like against like.
 *
 * WHY THIS FILE EXISTS. Einstein measured, over 168 real complete hours, that SPY's mention volume
 * runs ~77/hr on weekdays and ~41/hr at weekends. Ranked against a MIXED pool, SPY's busiest weekend
 * hour of the entire week reaches only the 69.0th percentile — the scale is capped and does not say
 * so, and the Sunday Week Ahead would therefore report "middling" every Sunday no matter what
 * happened. The same mixing inflates weekday hours, which is the case that runs five days a week.
 *
 * The checks below are written so they FAIL on the pre-fix code. That is the point: a test that
 * passes against both the bug and the fix has measured nothing. Check 1 reproduces the 69% ceiling
 * from a synthetic series with the measured shape and asserts the ceiling is GONE; run it against a
 * client with the pool split removed and it fails on exactly that number.
 *
 * Network is stubbed, so this runs offline and deterministically. No token, no live quota.
 */

const path = require('path');
const Module = require('module');

const CLIENT = path.join(__dirname, '..', 'api', '_lib', 'x-client.js');

let failures = 0;
let checks = 0;
function ok(name, cond, detail) {
  checks++;
  if (cond) { console.log('  PASS  ' + name); return; }
  failures++;
  console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
}

/* ── synthetic series ────────────────────────────────────────────────────────────────────────────
 * 168 complete hourly buckets ending at a chosen hour, plus one in-progress bucket, with weekday and
 * weekend hours drawn from different levels. Deterministic: a fixed pseudo-random sequence, so a
 * regression is a real change and never a reroll.
 */
function series({ weekdayMedian, weekendMedian, lastHourCount, endsUTC, spread = 0.5 }) {
  const rows = [];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const end = new Date(endsUTC);
  // 168 complete buckets, oldest first, then the in-progress one.
  for (let i = 168; i >= 1; i--) {
    const s = new Date(end.getTime() - i * 3600000);
    const e = new Date(s.getTime() + 3600000);
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(s);
    const weekend = (wd === 'Sat' || wd === 'Sun');
    const base = weekend ? weekendMedian : weekdayMedian;
    const n = Math.max(0, Math.round(base * (1 - spread + 2 * spread * rnd())));
    rows.push({ start: s.toISOString(), end: e.toISOString(), tweet_count: n });
  }
  // Overwrite the LAST COMPLETE bucket with the value under test.
  rows[rows.length - 1].tweet_count = lastHourCount;
  // The in-progress hour: deliberately large, to catch anyone ranking it again.
  rows.push({
    start: end.toISOString(),
    end: new Date(end.getTime() + 43 * 60000).toISOString(),
    tweet_count: 9999,
  });
  const total = rows.reduce((a, b) => a + b.tweet_count, 0);
  return { data: rows, meta: { total_tweet_count: total } };
}

/* Load the client with fetch stubbed and a token present, fresh each time so module state cannot
 * leak between checks. */
function loadClient(payload) {
  const realFetch = global.fetch;
  const realTok = process.env.X_BEARER_TOKEN;
  process.env.X_BEARER_TOKEN = 'test-token-not-a-real-credential';
  global.fetch = async () => ({ ok: true, status: 200, json: async () => payload });
  delete require.cache[require.resolve(CLIENT)];
  const c = require(CLIENT);
  return {
    client: c,
    restore() {
      global.fetch = realFetch;
      if (realTok === undefined) delete process.env.X_BEARER_TOKEN; else process.env.X_BEARER_TOKEN = realTok;
    },
  };
}

async function volume(payload) {
  const { client, restore } = loadClient(payload);
  try { return await client.mentionVolume('SPY'); } finally { restore(); }
}

(async () => {
  console.log('\nX mention-volume pooling checks\n');

  /* ── 1. THE CEILING IS GONE ────────────────────────────────────────────────────────────────────
   * A Sunday hour at SPY's genuine weekend maximum. Against a mixed pool it cannot exceed ~69%
   * (Einstein's measured figure); against weekend hours it must reach the top of the scale.
   * 2026-09-06T18:00:00Z is 14:00 ET on a SUNDAY. */
  {
    const v = await volume(series({
      weekdayMedian: 77, weekendMedian: 41, lastHourCount: 62,
      endsUTC: '2026-09-06T18:00:00Z',
    }));
    ok('a busy WEEKEND hour ranks against weekend hours',
      v.ranked_against && v.ranked_against.pool.indexOf('weekend') === 0,
      'pool was: ' + (v.ranked_against && v.ranked_against.pool));
    ok('a busy weekend hour is no longer capped near 69%',
      v.rankable === true && v.percentile_of_own_history > 80,
      'percentile=' + v.percentile_of_own_history + ' (mixed-pool ceiling was 69.0) rankable=' + v.rankable);
    // ⚠ `n >= 24 && hour_kind === 'weekend'` was the first version of this check and it CANNOT FAIL:
    // an unsplit pool is still 168 (>= 24) and the hour is still a weekend hour, so it passed
    // against the very bug it was written for. The discriminating assertion is that the pool is
    // SMALLER than the window — that is what proves a split actually happened.
    ok('the weekend pool is a strict subset of the window, and carries its n',
      v.ranked_against && v.ranked_against.hour_kind === 'weekend' &&
      v.ranked_against.n < v.observations && v.ranked_against.n <= 60,
      JSON.stringify(v.ranked_against) + ' observations=' + v.observations);
    // Same trap: the FALLBACK string also contains the word "weekend" ("too few weekend hours..."),
    // so matching on that word alone passes under the bug. Match the pool name itself.
    ok('the note states which pool the percentile is against',
      typeof v.note === 'string' && v.note.indexOf('weekend hours only') !== -1,
      v.note);
  }

  /* ── 2. THE INFLATION IS GONE TOO ──────────────────────────────────────────────────────────────
   * The half of the defect that runs five days a week. An unremarkable weekday hour — at the
   * weekday median — must land near the MIDDLE of the weekday pool. Against the mixed pool the 48
   * quiet weekend buckets sit beneath it and push it well above centre.
   * 2026-09-03T18:00:00Z is 14:00 ET on a THURSDAY. */
  {
    const v = await volume(series({
      weekdayMedian: 77, weekendMedian: 41, lastHourCount: 77,
      endsUTC: '2026-09-03T18:00:00Z',
    }));
    ok('a median WEEKDAY hour ranks against weekday hours',
      v.ranked_against && v.ranked_against.hour_kind === 'weekday',
      JSON.stringify(v.ranked_against));
    // The band is two-sided on purpose. An hour AT its own pool's median must land NEAR 50; a
    // one-sided "< 65" passed at 64.3 under the mixed pool, i.e. it cleared the bug by 0.7 points.
    ok('a median weekday hour lands near the middle of its own pool',
      v.rankable === true && v.percentile_of_own_history > 40 && v.percentile_of_own_history < 60,
      'percentile=' + v.percentile_of_own_history + ' - a median hour must rank near 50; well ' +
      'above it means quiet weekend buckets are still padding the denominator');
  }

  /* ── 3. THE GATE MOVED WITH THE DENOMINATOR ────────────────────────────────────────────────────
   * IWM's shape: fine on the week, too coarse at weekends. The gate must read the POOL. If it still
   * read the whole window this would rank, and the rank would be a coin flip. */
  {
    const v = await volume(series({
      weekdayMedian: 14, weekendMedian: 3, lastHourCount: 5,
      endsUTC: '2026-09-06T18:00:00Z', spread: 0.9,
    }));
    ok('a coarse WEEKEND pool refuses to rank even when the week looks fine',
      v.rankable === false && v.percentile_of_own_history === null,
      'rankable=' + v.rankable + ' pct=' + v.percentile_of_own_history + ' median=' + v.median_hour);
    ok('the refusal states the reason AND names the pool',
      typeof v.unrankable_because === 'string' && v.unrankable_because.indexOf('weekend') !== -1,
      String(v.unrankable_because));
    ok('the raw distribution still ships when the ranking is refused',
      Number.isFinite(v.total) && Number.isFinite(v.last_complete_hour) && v.observations > 0,
      'gate the ranking, never the count: ' + JSON.stringify({
        total: v.total, last: v.last_complete_hour, obs: v.observations }));
  }

  /* ── 4. THE IN-PROGRESS HOUR IS STILL NEVER RANKED ─────────────────────────────────────────────
   * The synthetic in-progress bucket is 9999 — far above every complete hour. If it entered the
   * pool or became the ranked value, this check catches it. Guards the ORIGINAL fix against being
   * undone by this one. */
  {
    const v = await volume(series({
      weekdayMedian: 77, weekendMedian: 41, lastHourCount: 77,
      endsUTC: '2026-09-03T18:00:00Z',
    }));
    ok('the in-progress hour is reported separately, never ranked',
      v.in_progress_hour && v.in_progress_hour.count === 9999 && v.last_complete_hour !== 9999,
      JSON.stringify(v.in_progress_hour) + ' last_complete=' + v.last_complete_hour);
    ok('the in-progress hour carries its elapsed minutes',
      v.in_progress_hour && v.in_progress_hour.elapsed_minutes === 43,
      String(v.in_progress_hour && v.in_progress_hour.elapsed_minutes));
    ok('the busiest complete hour is not the in-progress one',
      v.busiest_hour < 9999, 'busiest_hour=' + v.busiest_hour);
  }

  /* ── 5. UNREADABLE TIMESTAMPS FALL BACK LOUDLY, NOT SILENTLY ───────────────────────────────────
   * If the calendar cannot be resolved the client must still answer — but a caller has to be able to
   * tell a like-for-like rank from a mixed one. A silent fallback is the failure this change exists
   * to remove, so absence of a stated reason is itself the defect. */
  {
    const p = series({ weekdayMedian: 77, weekendMedian: 41, lastHourCount: 77,
      endsUTC: '2026-09-03T18:00:00Z' });
    for (const row of p.data) row.start = 'not-a-timestamp';
    const v = await volume(p);
    ok('unreadable bucket timestamps still return an answer',
      v && (v.rankable === true || v.rankable === false), JSON.stringify(v && v.error));
    ok('and the payload SAYS the pool could not be split',
      v.ranked_against && /could not split|unreadable/.test(v.ranked_against.pool),
      'pool was: ' + (v.ranked_against && v.ranked_against.pool));
  }

  /* ── 6. A 24/7 ASSET DE-SEASONALISES BY HOUR-OF-DAY INSTEAD ──────────────────────────────────
   * Xavier measured the same question on crypto rather than assuming Einstein's answer carried
   * over, and it does not. Weekday/weekend is 1.09-1.31x on a coin; the DIURNAL cycle is
   * 1.86-2.93x. Rank a 02Z hour against all 168 and the percentile mostly encodes WHAT TIME IT IS.
   * The series below has Xavier's BTC shape: a 16Z peak against a 02Z trough, ~2.4x.
   */
  function diurnal({ peakHourUTC, peak, trough, lastRelative, endsUTC }) {
    const rows = [];
    let seed = 99991;
    const end = new Date(endsUTC);
    for (let i = 168; i >= 1; i--) {
      const s = new Date(end.getTime() - i * 3600000);
      const h = s.getUTCHours();
      // smooth cycle peaking at peakHourUTC
      const d = Math.min(Math.abs(h - peakHourUTC), 24 - Math.abs(h - peakHourUTC));
      // Deterministic noise: a real diurnal series is a TENDENCY, not a repeating waveform. A
      // noiseless cycle de-seasonalises to a constant, which tests nothing about ranking.
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const jitter = 0.75 + 0.5 * (seed / 0x7fffffff);
      const n = Math.round((trough + (peak - trough) * Math.cos((d / 12) * Math.PI) * 0.5 + (peak - trough) * 0.5) * jitter);
      rows.push({ start: s.toISOString(), end: new Date(s.getTime() + 3600000).toISOString(), tweet_count: Math.max(0, n) });
    }
    /* The value under test is expressed RELATIVE to what that hour-of-day normally is, derived
       from the series itself. Hard-coding "128 is typical at 02Z" was wrong — for a 16Z peak the
       02Z level is ~140, not the trough — and the check then failed for a reason that had nothing
       to do with the code. Deriving it means the test cannot drift from its own generator. */
    const lastH = new Date(rows[rows.length - 1].start).getUTCHours();
    const sameHour = rows.filter((r) => new Date(r.start).getUTCHours() === lastH)
                         .map((r) => r.tweet_count).sort((a, b) => a - b);
    const typical = sameHour[Math.floor(sameHour.length / 2)];
    rows[rows.length - 1].tweet_count = Math.round(typical * lastRelative);
    rows.push({ start: end.toISOString(), end: new Date(end.getTime() + 43 * 60000).toISOString(), tweet_count: 1 });
    return { data: rows, meta: { total_tweet_count: rows.reduce((a, b) => a + b.tweet_count, 0) } };
  }

  {
    // A 02Z hour sitting at its OWN hour-of-day's normal level. Against the raw 168 it looks like
    // one of the quietest hours of the week; de-seasonalised it is unremarkable, which is true.
    // x1.0 = exactly normal FOR 02Z, which raw-ranked would still sit near the bottom of the
    // week purely because 02Z is always quiet.
    const p = diurnal({ peakHourUTC: 16, peak: 306, trough: 128, lastRelative: 1.0,
                        endsUTC: '2026-09-06T03:00:00Z' });
    const { client, restore } = loadClient(p);
    let v; try { v = await client.mentionVolume('BTC'); } finally { restore(); }

    ok('a coin de-seasonalises by hour-of-day, not weekday/weekend',
      v.ranked_against && v.ranked_against.seasonality === 'hour_of_day',
      JSON.stringify(v.ranked_against));
    ok('a TYPICAL 02Z hour is not reported as a weekly extreme',
      v.rankable === true && v.percentile_of_own_history > 20 && v.percentile_of_own_history < 80,
      'percentile=' + v.percentile_of_own_history + ' - raw-ranked it would sit near the bottom ' +
      'purely because 02Z is always quiet');
    ok('the pool is NOT halved to buy 1.1x of weekday/weekend separation',
      v.ranked_against.n > 120, 'n=' + v.ranked_against.n);
    ok('the thin part of the method is reported, not buried',
      v.ranked_against.baseline_n === 7, 'baseline_n=' + v.ranked_against.baseline_n);

    // ...and a genuinely busy 02Z hour must still reach the top. Otherwise de-seasonalising has
    // merely flattened the signal along with the cycle, which would be a worse bug than the one
    // it fixes: an anomaly detector that cannot detect an anomaly.
    const busy = diurnal({ peakHourUTC: 16, peak: 306, trough: 128, lastRelative: 6.0,
                           endsUTC: '2026-09-06T03:00:00Z' });
    const l2 = loadClient(busy);
    let v2; try { v2 = await l2.client.mentionVolume('BTC'); } finally { l2.restore(); }
    ok('a genuinely ABNORMAL 02Z hour still ranks at the top',
      v2.rankable === true && v2.percentile_of_own_history > 95,
      'percentile=' + v2.percentile_of_own_history);
  }

  {
    // An equity is unaffected by any of the above.
    const v = await volume(series({ weekdayMedian: 77, weekendMedian: 41, lastHourCount: 77,
      endsUTC: '2026-09-03T18:00:00Z' }));
    ok('an equity still splits weekday/weekend',
      v.ranked_against.seasonality === 'weekday_weekend' && v.ranked_against.baseline_n === null,
      JSON.stringify(v.ranked_against));
  }

  /* ── 7. TIES MUST NOT READ AS EXTREMES ───────────────────────────────────────────────────────
   * `below / n` counts only values strictly LESS than the current one, so a series with heavy ties
   * under-reports — in the limit a perfectly tied series returns percentile 0, "the quietest hour
   * on record", for a value that is exactly typical.
   *
   * I found this while testing de-seasonalisation (ratios cluster hard around 1.0) and switched to
   * mid-rank — but the sabotage run showed every existing check still passed with the old formula
   * restored, i.e. I had changed the published number with nothing testing it. This is that test.
   * It is not synthetic-only: IWM resolves to 33 distinct values across a week, so its ties are
   * common, and a tied IWM hour would have been reported at the bottom of its range. */
  {
    const rows = [];
    const end = new Date('2026-09-03T18:00:00Z');
    for (let i = 168; i >= 1; i--) {
      const s = new Date(end.getTime() - i * 3600000);
      // Heavy ties on purpose: 150 exactly, with a handful of outliers either side.
      const n = (i % 40 === 0) ? 90 : (i % 37 === 0) ? 220 : 150;
      rows.push({ start: s.toISOString(), end: new Date(s.getTime() + 3600000).toISOString(), tweet_count: n });
    }
    rows[rows.length - 1].tweet_count = 150;                    // dead typical
    rows.push({ start: end.toISOString(), end: new Date(end.getTime() + 600000).toISOString(), tweet_count: 3 });
    const { client, restore } = loadClient({ data: rows, meta: { total_tweet_count: 25000 } });
    let v; try { v = await client.mentionVolume('SPY'); } finally { restore(); }
    ok('a value tied with most of its history ranks near the MIDDLE, not at zero',
      v.rankable === true && v.percentile_of_own_history > 35 && v.percentile_of_own_history < 65,
      'percentile=' + v.percentile_of_own_history + ' - strictly-below counting reports a dead ' +
      'typical value as the quietest hour on record');
  }

  console.log('\n' + (failures ? 'FAILED ' + failures + '/' + checks : 'OK ' + checks + '/' + checks) + '\n');
  process.exit(failures ? 1 : 0);
})();
