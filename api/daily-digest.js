// api/daily-digest.js — NoVo speaks first, personally.
//
// Once a day, every member who told NoVo what they follow (reader memory) AND has a push
// device registered gets a short personal brief on exactly those interests — their coins off
// the live crypto map, their tickers off the live dealer read. Nobody else gets anything:
// no interests means no digest, no device means no send. Market read only, never advice —
// the same boundary as every other word NoVo publishes.
//
// Runs on the Vercel cron (12:00 UTC daily). Auth: the cron's own bearer, or the analyst
// publish secret for a manual kick.

// ── the grounding guard ────────────────────────────────────────────────────────────
// THIS SURFACE'S FAILURE MODE IS NOT A BAD FORECAST, IT IS A FABRICATED NUMBER. The digest does
// not predict anything — it narrates facts it was handed. So the forecasting research's ensemble
// (sample N, take the median) buys nothing here: averaging three narrations of the same numbers
// does not make the numbers righter, it just costs three times as much. What DOES apply is the
// claim-to-evidence binding half: this brief lands on a phone at 12:00 UTC with nobody watching,
// the reader cannot check it against anything, and one invented level is worth more damage than a
// hundred correct briefs are worth trust.
//
// So every number in the generated text must trace to a number in the facts it was given. The
// check is deterministic and free — no second model call — and it fails CLOSED into a template
// built from the same facts, so the member still gets their digest and it is true by construction.

function _nums(s) {
  // Numbers as a reader would write them: 767.54, 108,432, $80k, 0.08. Commas stripped, k/m
  // suffixes expanded, sign dropped (direction is words, not digits).
  const out = [];
  // The suffix must END the word, or "2 markets" reads as two million and every brief that
  // counts something trips the guard. Measured: that exact false positive.
  const re = /(\d[\d,]*(?:\.\d+)?)\s*([kmb])?(?![a-z0-9])/gi;
  let m;
  while ((m = re.exec(s))) {
    let v = parseFloat(m[1].replace(/,/g, ""));
    if (!isFinite(v)) continue;
    const suf = (m[2] || "").toLowerCase();
    if (suf === "k") v *= 1e3; else if (suf === "m") v *= 1e6; else if (suf === "b") v *= 1e9;
    out.push(v);
  }
  return out;
}

function _allowed(facts) {
  // Every fact value, at the roundings a writer would naturally use, PLUS the percentage
  // distances between values of the same fact — "0.08% above the flip" is derived, not invented,
  // and a guard that rejected it would reject the most useful sentence in the brief.
  // Every form a writer might legitimately render a fact value in — full precision, rounded to a
  // few decimals, cut to significant figures, or divided into k/M/B. The ROUNDING LIVES HERE, on
  // the trusted side. Doing it on the text side instead is what let an invented "3.9%" through:
  // rounded to zero decimals it became 4, and 4 was permitted as a small integer count.
  const set = new Set();
  const add = (v) => {
    if (typeof v !== "number" || !isFinite(v)) return;
    const a = Math.abs(v);
    set.add(a);
    for (const p of [0, 1, 2, 3]) set.add(Number(a.toFixed(p)));
    for (const p of [1, 2, 3]) set.add(Number(a.toPrecision(p)));
    // TRUNCATION, not just rounding. Measured against real output: 0.867% came back written as
    // "0.86%" — a writer cutting the decimal rather than rounding it, which is honest and common.
    for (const p of [0, 1, 2, 3]) {
      const f = Math.pow(10, p);
      set.add(Math.floor(a * f) / f);
    }
    for (const [d, n] of [[1e3, 1000], [1e6, 1e6], [1e9, 1e9]]) {
      if (a >= n) { set.add(Number((a / d).toFixed(1))); set.add(Number((a / d).toFixed(0))); }
    }
  };
  for (const f of facts) {
    const vals = Object.values(f).flatMap((v) =>
      (v && typeof v === "object") ? Object.values(v) : [v]).filter((v) => typeof v === "number");
    vals.forEach(add);
    // DERIVED PERCENTAGES ONLY BETWEEN A PRICE AND ONE OF ITS OWN LEVELS. Allowing every pairwise
    // ratio instead made the permitted set so dense that an invented "3.9% above the flip" landed
    // inside it — measured, and it is the exact false negative this guard exists to stop. A brief
    // says how far spot is from a level; it never says what net GEX is as a percentage of DVOL.
    const price = [f.spot, f.price, f.gamma && f.gamma.spot].find((v) => typeof v === "number");
    const levels = [f.flip, f.callWall, f.putWall,
                    f.gamma && f.gamma.flip, f.gamma && f.gamma.spot]
                   .filter((v) => typeof v === "number");
    // BOTH DENOMINATORS. "1.44% above the put wall" (vs the level) and "1.46% below the call
    // wall" (vs spot) are the same true distance expressed two defensible ways, and real output
    // used both — a guard that only knew one flagged the other as invented.
    if (typeof price === "number") {
      for (const lv of levels) if (lv) {
        add(Math.abs((price - lv) / lv) * 100);
        add(Math.abs((price - lv) / price) * 100);
        // And the same distance in POINTS — "0.61 above its flip" is the most natural way to say
        // it on an index, and it is arithmetic on two given numbers, not a new claim.
        add(Math.abs(price - lv));
      }
    }
  }
  return set;
}

function ungroundedNums(text, facts) {
  const ok = [..._allowed(facts)];
  const bad = [];
  for (const n of _nums(text)) {
    const a = Math.abs(n);
    // Small WHOLE numbers are counts, hours and dates — "both of your 2 markets". Exact integers
    // only: 3.9 is a market claim wearing a small number, and it must match a real value.
    if (Number.isInteger(a) && a <= 24) continue;
    // Otherwise it has to land on a permitted form, within a hair for float noise — NOT within a
    // rounding step, which is how a nearby invented level would sneak in.
    const hit = ok.some((v) => Math.abs(a - v) <= Math.max(0.005, Math.abs(v) * 1e-6));
    if (!hit) bad.push(n);
  }
  return bad;
}

function fallbackBrief(facts) {
  // Deterministic, and true by construction. Not an apology for the model — a brief built
  // straight from the numbers, which is what the reader was owed in the first place.
  const bits = [];
  for (const f of facts.slice(0, 3)) {
    if (f.ticker) {
      const p = [`${f.ticker} ${f.spot}`];
      if (f.flip) p.push(`flip ${f.flip}`);
      if (f.callWall) p.push(`call wall ${f.callWall}`);
      bits.push(p.join(", "));
    } else if (f.coin) {
      const p = [`${f.coin} ${f.price}`];
      if (f.gamma && f.gamma.flip) p.push(`flip ${f.gamma.flip}`);
      bits.push(p.join(", "));
    }
  }
  return bits.length ? `Where your map sits: ${bits.join(" · ")}.` : null;
}

module.exports = async (req, res) => {
  const auth = String(req.headers["authorization"] || "");
  const cronOk = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const secretOk = process.env.ANALYST_PUBLISH_SECRET &&
                   req.headers["x-analyst-secret"] === process.env.ANALYST_PUBLISH_SECRET;
  if (!cronOk && !secretOk) return res.status(401).json({ error: "unauthorized" });

  const { kv: kvf } = require("./_kv.js");
  const r = kvf();
  if (!r) return res.status(200).json({ ok: false, note: "kv unavailable" });
  // getMemory is no longer called here - the roster arrives in one mget and digestOf applies the
  // same gate getMemory would have. See the schedule pass below.
  const { digestOf } = require("./_lib/member-memory.js");
  const { pushUrl, pushTargets } = require("./_lib/alerts.js");
  const { vertex } = require("./_vertex.js");
  const MODEL = (process.env.GEMINI_MODEL || "gemini-3.6-flash").trim();
  // How late a delayed cron tick may still deliver. See the matcher below for why it is small.
  const DIGEST_CATCHUP_MIN = 10;

  /* ⚠ THE COMP GATE, BY HASH, BECAUSE THIS LOOP NEVER SEES AN EMAIL. Reader memory is keyed on
     sha256(email).slice(0,16) and a hash is one-way, so isComp(email) cannot be called here the
     way every other surface calls it. Instead the SAME list is hashed the SAME way and compared —
     one implementation of the list (comp.js's parsing, copied exactly: split, trim, lowercase,
     filter), one implementation of the hash (member-memory.js's eh, copied exactly). Built per
     call, not at module load, for comp.js's stated reason: an env change should wait on a
     redeploy, never on a warm lambda's memory.
     ⚠ If member-memory.js's eh() ever changes, this silently stops matching and the comp seat
     quietly drops back to the public digest — a gate that fails CLOSED, which is the right
     direction, but it fails SILENTLY, so the header of eh() cross-points here. */
  const _compHashes = () => {
    const _c = require("crypto");
    return new Set(String(process.env.COMP_EMAILS || "")
      .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)
      .map((e) => _c.createHash("sha256").update(e).digest("hex").slice(0, 16)));
  };
  const COMP_H = _compHashes();

  let idx = [];
  try { idx = await r.smembers("mem:index"); } catch (_) { idx = []; }
  idx = (idx || []).slice(0, 100);

  /* ⚠ LOADED ONLY ONCE SOMEONE IS ACTUALLY DUE. These two are the largest reads in the handler -
     the whole crypto map and the whole live-levels object - and they used to happen on every
     invocation, before anything had checked whether a single member wanted a digest this minute.
     At the old half-hourly cadence that was 96 needless big reads a day. At once a minute it would
     be 2,880. The due-time check is the cheap part, so it goes first and these come after it.
     A tick with nobody due now costs one smembers and nothing else. */
  let snap = null, live = null, _marketLoaded = false;
  const loadMarket = async () => {
    if (_marketLoaded) return;
    _marketLoaded = true;
    try { snap = await r.get("crypto:map:live"); } catch (_) {}
    try { live = await r.get("analyst:live_levels"); } catch (_) {}
    if (typeof snap === "string") { try { snap = JSON.parse(snap); } catch (_) { snap = null; } }
    if (typeof live === "string") { try { live = JSON.parse(live); } catch (_) { live = null; } }
  };

  const webpush = require("web-push");
  const canPush = process.env.ANALYST_VAPID_PUBLIC && process.env.ANALYST_VAPID_PRIVATE;
  if (canPush) {
    webpush.setVapidDetails(process.env.ANALYST_VAPID_SUBJECT || "mailto:support@novo-options.trade",
      process.env.ANALYST_VAPID_PUBLIC, process.env.ANALYST_VAPID_PRIVATE);
  }

  /* ══ WHO IS DUE THIS MINUTE ═══════════════════════════════════════════════════════════════
     ⚠ THIS USED TO BE THREE KV ROUND-TRIPS PER MEMBER *BEFORE* ANYTHING CHECKED THE CLOCK -
     get(mem:e:), get(push:u:) and getMemory() - with the due-time test underneath all of them. At
     the old half-hourly cadence that was ~14k KV commands a day. Moving to a once-a-minute cron
     without moving the check would have made it ~433,000 a day for a roster of 100, on the same
     Upstash database that backs claimOnce and rateOk - both of which FAIL OPEN when it is
     exhausted (_kv.js:48, :62), which health.js already names as the blast radius.
     Deferring the two market payloads, which is what shipped first, recovered 2 commands out of
     ~301. It was the right change against the wrong number, and the comment I wrote claiming a
     quiet tick cost "one smembers and nothing else" was simply false - it described the code I
     meant to write rather than the code underneath it.
     A quiet tick now costs TWO commands: the smembers, and one mget for the whole roster. The
     mem:index members ARE the mem:u: suffixes (member-memory.js:69, :191), so the roster comes
     back in one call. mem:e: is not read at all any more - it was only ever there to feed
     getMemory an address, and member-purge.js flags it as ⚠ PLAINTEXT EMAIL. */
  const _fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York",
    hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
  /* ONE CLOCK FOR THE WHOLE TICK. Read per-member, the wall clock drifted as the loop ran - which
     a 30-minute bucket absorbed silently and an exact-minute match does not. */
  const _at = new Date();
  const _parts = _fmt.format(_at);
  const _nowMin = parseInt(_parts.slice(0, 2), 10) * 60 + parseInt(_parts.slice(3, 5), 10);
  const _etDay = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
  const _day = _etDay(_at);
  const _prevDay = _etDay(new Date(_at.getTime() - 86400000));

  let _recs = [];
  if (idx.length) { try { _recs = await r.mget(...idx.map((h) => "mem:u:" + h)); } catch (_) { _recs = []; } }

  const due = [];
  idx.forEach((h, i) => {
    let m = _recs[i];
    if (typeof m === "string") { try { m = JSON.parse(m); } catch (_) { m = null; } }
    const dg = digestOf(m);
    if (!dg) return;
    const _wantMin = parseInt(dg.time.slice(0, 2), 10) * 60 + parseInt(dg.time.slice(3, 5), 10);
    /* ⚠ MODULO, OR THE WINDOW TRUNCATES AT MIDNIGHT. A raw `_nowMin - _wantMin` is -1435 at 00:00
       for a 23:55 digest, which trips the never-early branch and silently cuts the advertised
       ten-minute catch-up to five for every evening time. Wrapped, "one minute early" reads as
       1439 late and is still refused, so NEVER-EARLY survives without a separate branch. */
    const _lateBy = ((_nowMin - _wantMin) % 1440 + 1440) % 1440;
    /* NEVER EARLY, AND ONLY A LITTLE LATE. Jake, 2026-09-08: "if someone wants a digest at 8:17am
       then it sends at 8:17am only way it can be." This replaced a 30-minute bucket that served
       08:17 from the 08:00 run - up to 29 minutes EARLY, which is the one direction a scheduled
       brief must not go, since it is assembled from whatever the market looked like when it ran.
       The catch-up is small on purpose: Vercel does not fire crons to the second and can drop a
       tick, so a delayed run should still deliver - but a market brief forty minutes late is not
       the brief that was asked for, and the honest outcome is nothing that day.
       DST is the formatter's problem via ET wall-clock, with two consequences worth stating rather
       than discovering: on the spring-forward Sunday 02:00-02:59 does not exist, so a member who
       chose a time in that hour gets nothing that one day; on the fall-back Sunday 01:00-01:59
       happens twice, and the per-day claim below - keyed on the ET date - is what stops the second
       pass delivering a duplicate. */
    if (_lateBy > DIGEST_CATCHUP_MIN) return;
    /* ⚠ THE CLAIM BELONGS TO THE DAY THE DIGEST IS *FOR*, NOT THE DAY IT LANDS ON. These differ
       only when the catch-up window crosses midnight: a 23:55 brief delivered at 00:02 belongs to
       the day that just ended. Stamped with the new day instead, it would suppress that new day's
       own 23:55 brief - turning one missed evening into two missed mornings, which is exactly the
       cascade the window exists to prevent. */
    due.push({ h, dg, forDay: _nowMin < _wantMin ? _prevDay : _day });
  });
  if (!due.length) {
    return res.status(200).json({ ok: true, members: idx.length, sent: 0,
                                  skipped: idx.length, errors: 0, at: _parts });
  }

  let sent = 0, skipped = idx.length - due.length, errors = 0;
  for (const { h, dg, forDay } of due) {
    try {
      let subs = null;
      try { subs = await r.get("push:u:" + h); } catch (_) {}
      if (typeof subs === "string") { try { subs = JSON.parse(subs); } catch (_) { subs = null; } }
      if (!Array.isArray(subs) || !subs.length || !canPush) { skipped++; continue; }
      /* ⚠ CLAIM THE DAY ATOMICALLY, BEFORE GENERATING ANYTHING.
         Under the old 30-minute bucket a member matched exactly ONE invocation per day, so two
         runs could never be inside the same member at once - the design was structurally immune
         to this and the plain read-then-write below it was safe.
         It is not any more. With a once-a-minute cron and a ten-minute catch-up, a member matches
         ELEVEN consecutive ticks, and the old guard read the stamp, then made one or two Vertex
         calls with no timeout on them (_vertex.js uses a bare fetch, no AbortController), and only
         then wrote the stamp. Tick N reads "unsent"; tick N+1 reads "unsent" sixty seconds later
         while N is still waiting on the model; the phone gets two morning briefs. A faster cron
         turned a safe sequence into a race.
         THE DAY IS IN THE KEY, NOT THE VALUE - an `nx` against a day-VALUED key would be blocked
         by yesterday's stamp for its whole TTL. Same idiom as _kv.js claimOnce. */
      const _ck = "digest:sent:" + h + ":" + forDay;
      let _claim = null;
      try { _claim = await r.set(_ck, "1", { nx: true, ex: 36 * 3600 }); } catch (_) { _claim = null; }
      if (!(_claim === "OK" || _claim === true)) { skipped++; continue; }
      const _unclaim = async () => { try { await r.del(_ck); } catch (_) {} };
      // Confirmed due, unsent, and subscribed - the first point at which the market payloads are
      // worth fetching. Loads once per invocation however many members are due.
      await loadMarket();
      const interests = dg.symbols;

      // Assemble ONLY their interests' facts — the model narrates, it never invents.
      const facts = [];
      for (const it of interests) {
        const key = it.toUpperCase().replace(/[^A-Z0-9]/g, "");
        const t = live && (live.tickers || []).find((x) => x.ticker === key);
        if (t) facts.push({ ticker: key, spot: t.spot, flip: t.flip, callWall: t.callWall,
                            putWall: t.putWall, regime: t.regime });
        const c = snap && snap.coins && snap.coins[key];
        if (c) facts.push({ coin: key, price: c.price, band: c.band,
                            gamma: c.gamma ? { spot: c.gamma.spot, flip: c.gamma.flip_zone,
                                               netGex: c.gamma.net_gex } : null,
                            dvol: c.dvol || null });
      }
      /* ⚠ RELEASE THE DAY ON EVERY FAILURE PATH. The claim above is taken BEFORE generating, so
         a member whose facts or model call fall over would otherwise have their whole day burnt by
         one bad minute - and the ten-minute window exists precisely so a bad minute is survivable.
         Same move as _kv.js releaseClaim. */
      if (!facts.length) { await _unclaim(); skipped++; continue; }

      /* THE PRIVATE DESK, COMP SEATS ONLY (Jake, 2026-09-09, direct: "fix the digest now").
         The chat has run NoVo Unleashed on this seat since 08a9a7f08 while the digest — a wholly
         separate handler — had NO comp awareness at all: no gate, no desk data, no directional
         posture. So the owner asked for a 9:25 brief with a direct opening call, was told in chat
         that the call is "a boundary I do not cross", and the real reason was that this file had
         never heard of him. Additive and fail-open: any failure here leaves `desk` null and the
         member gets the ordinary public brief, byte-identical to before. */
      const isCompSeat = COMP_H.has(h);
      let desk = null;
      if (isCompSeat) {
        try {
          let es = await r.get("equity:signals:live");
          if (typeof es === "string") { try { es = JSON.parse(es); } catch (_) { es = null; } }
          if (es && (es.record || es.open)) {
            desk = { open: (es.open || []).slice(0, 6), record: es.record || null };
            facts.push({ desk_open: desk.open, desk_record: desk.record });
          }
        } catch (_) { desk = null; }
      }

      /* THE CALL THE MODEL MAY MAKE, AND WHY IT IS A SIDE AND NOT A LEVEL. On the comp seat the
         brief may carry a direct opening call — but `direction` is the only kind asked for here,
         so the call carries NO price of its own. Every number still has to come from DATA, and a
         kind that needs a target would hand the model a figure to invent on the one path with no
         tool loop to check it against. Side + horizon is fully gradable and cannot be fabricated. */
      let pendingCall = null;
      const write = async (temp) => {
        const compRules = isCompSeat ? (
          "THIS IS THE PRIVATE DESK SEAT. You MAY and SHOULD open with a direct call for the " +
          "session ahead — the side, and what would void it — when the desk data or the dealer " +
          "map supports one. Do not answer that direction is a boundary you do not cross; that " +
          "is the public rule and this is not the public digest. If the data does not support a " +
          "call, say so plainly and give the levels instead — thin data is a different answer " +
          "from a refusal on principle.\n" +
          "Reply as STRICT JSON, no other text: {\"brief\":\"<the brief>\",\"call\":" +
          "{\"symbol\":\"SPY\",\"side\":\"up\"|\"down\",\"horizon_min\":<15-390>," +
          "\"thesis\":\"<one short line>\"}}  — and \"call\":null when you are not making one.\n"
        ) : "";
        const j = await vertex(`${MODEL}:generateContent`, {
          contents: [{ role: "user", parts: [{ text:
            "You are NoVo, the AI market analyst — first person, dry, precise, no advice, " +
            (isCompSeat ? "" : "no predictions, ") + "no emoji. Write a push-notification-sized " +
            "personal brief (max 55 words) " +
            "for a reader who follows these, using ONLY the numbers given. Every figure you write " +
            "must appear in DATA or be a percentage distance between two of its values — do not " +
            "round to a friendlier number and do not add a figure that is not there. Lead with " +
            "the most interesting fact.\n" + compRules + "DATA: " + JSON.stringify(facts) }] }],
          generationConfig: { temperature: temp, maxOutputTokens: 200,
                              ...(isCompSeat ? { responseMimeType: "application/json" } : {}),
                              thinkingConfig: { thinkingBudget: 0, includeThoughts: false } },
        }, "digest");
        const raw = (j && j.candidates && j.candidates[0] && j.candidates[0].content &&
                (j.candidates[0].content.parts || []).filter((p) => p.text && !p.thought)
                  .map((p) => p.text).join("").trim()) || null;
        if (!isCompSeat || !raw) return raw;
        /* An unparseable answer is NOT salvaged into a brief — same rule as read-predictions.js.
           Returning null here drops to the retry, then to the deterministic template. */
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { return null; }
        if (!parsed || typeof parsed.brief !== "string" || !parsed.brief.trim()) return null;
        pendingCall = parsed.call || null;
        return parsed.brief.trim();
      };

      let text = await write(0.4);
      // One number that is not in the facts and the brief does not go out as written: retry once
      // colder, then fall back to the template. Nobody is watching this send, so the guard is the
      // only reader it has.
      let guard = null;
      if (text) {
        let bad = ungroundedNums(text, facts);
        if (bad.length) {
          guard = "retried";
          const second = await write(0.1);
          const bad2 = second ? ungroundedNums(second, facts) : ["no text"];
          if (second && !bad2.length) { text = second; }
          else { text = fallbackBrief(facts); guard = "fallback"; }
        }
      } else {
        text = fallbackBrief(facts);
        guard = "fallback";
      }
      if (guard) console.log(`[DIGEST] grounding guard: ${guard}`);
      if (!text) { await _unclaim(); errors++; continue; }

      /* ⚠ A STATED PREDICTION THAT IS NOT RECORDED DOES NOT EXIST — the Iron Rule from
         analyst-ask.js's unleashed block, which this path could not honour on its own: the digest
         is ONE generateContent call with no tool loop, so the model cannot invoke make_prediction
         the way it does in chat. Shipping a directional brief without this would put an ungraded
         call in front of the owner every morning and quietly build the one thing the whole record
         exists to prevent — a claim with no denominator.
         NOT ON THE FALLBACK. `guard === "fallback"` means the model's draft was rejected and the
         text is the deterministic template; the call belonged to prose nobody sent, and recording
         it would grade NoVo on a sentence he did not publish.
         Failure to record is not failure to deliver: the brief still goes out. */
      if (isCompSeat && pendingCall && guard !== "fallback") {
        try {
          const sym = String(pendingCall.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
          const side = pendingCall.side === "down" ? "down" : "up";
          const hz = Math.round(Number(pendingCall.horizon_min));
          const tk = live && (live.tickers || []).find((x) => x.ticker === sym);
          const spot = tk && Number(tk.spot);
          /* No spot, no prediction — the same refusal read-predictions.js makes, for the same
             reason: a call with no starting price cannot be graded, and inventing one would score
             him against a number he never committed to. */
          if (sym && spot > 0 && isFinite(hz) && hz >= 15 && hz <= 390) {
            const { makePrediction } = require("./_lib/predictions.js");
            const made = await makePrediction({
              kind: "direction", asset_class: "equity", symbol: sym, side, spot_at: spot,
              horizon_min: hz, source: "digest",
              thesis: String(pendingCall.thesis || "").slice(0, 200) || "stated in the morning digest",
              basis: "the " + (dg.time || "morning") + " digest",
            });
            console.log(`[DIGEST] call ${sym} ${side} ${hz}m -> ` +
                        (made && made.ok ? made.id : "REFUSED: " + ((made && made.error) || "unknown")));
          } else {
            console.log(`[DIGEST] call dropped: unusable shape ${sym}/${hz}/${spot}`);
          }
        } catch (e) { console.error("[DIGEST] call not recorded:", e.message); }
      }
      /* ⚠ THE BRIEF IS STORED BEFORE IT IS SENT (Jake, 2026-09-07: "a digest tab/page where you
         can manage your daily digest ... where it displays"). Until now the push notification WAS
         the entire artifact — 320 characters, dismissed once, gone permanently — which is how Jake
         met this feature: a message from nothing, findable nowhere. The Digest tab renders from
         this log. Stored before the send loop, deliberately: a brief that failed to deliver is
         still that morning's brief, and the page is where a member goes when the ping did not
         arrive. Last 14 mornings, 30-day expiry, keyed like everything else member-owned. */
      /* The day was claimed before generation, so there is no stamp to write here. */
      try {
        const lk = "digest:log:" + h;
        let log = null;
        try { log = await r.get(lk); } catch (_) { log = null; }
        if (typeof log === "string") { try { log = JSON.parse(log); } catch (_) { log = null; } }
        log = Array.isArray(log) ? log : [];
        log.push({ ts: Date.now(), text, symbols: dg.symbols, focus: dg.focus || null,
                   guard: guard || null });
        await r.set(lk, JSON.stringify(log.slice(-14)), { ex: 30 * 24 * 3600 });
      } catch (_) { /* the log is display; delivery does not wait on it */ }

      /* Only the dashboard the digest was asked for on — same rule, same function, as a fired
         alert. See pushTargets in api/_lib/alerts.js. */
      for (const s of pushTargets(subs, dg.app)) {
        // ⚠ A url, SO TAPPING IT LANDS SOMEWHERE. Without one the service worker falls back to
        // /analyst/live — the dashboard, which shows no digest anywhere — so the notification read
        // as a message from nothing. It opens the Dr. NoVo tab, where the digest is managed.
        // PER SUBSCRIPTION. It was hardcoded to /analyst/live, which a crypto-only member cannot
        // open — Jake: "zero Dr. NoVo features are per app gated". The device's own service-worker
        // scope is stored on the subscription at registration, so this opens the dashboard the
        // person was standing on when they turned push on.
        try { await webpush.sendNotification(s, JSON.stringify({ title: "NoVo — your morning read", body: text.slice(0, 320), tag: "novo-digest", url: pushUrl(s, "novo") })); sent++; }
        catch (_) {}
      }
    } catch (_) {
      /* Anything that threw after the claim was taken gives the day back, for the same reason:
         the window is the retry, and a burnt claim turns a transient failure into a missed morning. */
      try { if (typeof _ck === "string") await r.del(_ck); } catch (_e) {}
      errors++;
    }
  }
  return res.status(200).json({ ok: true, members: idx.length, sent, skipped, errors });
};
