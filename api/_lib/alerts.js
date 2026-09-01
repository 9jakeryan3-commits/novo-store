// api/_lib/alerts.js — reader-defined alerts, created in conversation, delivered by push
// and, where the reader has linked one, a Discord DM.
//
// "Tell me if SPY crosses its flip" is a NOTIFICATION, not advice: the reader picks the
// condition, NoVo watches the same published numbers everyone sees, and the message says a
// level was crossed — never what to do about it. Alerts are the reader's own objects: capped
// at MAX_ACTIVE, expiring by default in 7 days, listable and cancellable in a sentence.
//
// Evaluation rides the publishes that already happen: the equity live-state push (~60s) and
// the crypto snapshot push (~5min) each call their evaluator after storing.
//
// FIRING MODES. Level alerts are one-shot by default — a crossing fires once and the alert
// retires, because a level being oscillated through 40 times an hour is noise nobody asked
// for. A level alert created with recurring=true instead RE-ARMS: after firing it stays
// silent until price has come back to the other side AND a cooldown has passed, then it can
// fire again, until it expires. Block alerts are recurring by nature — each fire covers new
// prints only (a watermark walks the tape), with the same cooldown between fires.

const crypto = require("crypto");
const { kv } = require("../_kv.js");

const MAX_ACTIVE = 10;
const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;
const COOLDOWN_MS = 60 * 60 * 1000;        // recurring level alerts: at most one fire an hour
const BLOCK_COOLDOWN_MS = 30 * 60 * 1000;  // block alerts: a whale day is not 40 pushes
const BLOCK_MIN_USD_FLOOR = 100000;        // below this the "block" tape is ordinary prints
const EQ_TICKERS = new Set(["SPY", "QQQ", "IWM"]);
const NAMED_LEVELS = new Set(["flip", "call_wall", "put_wall"]);
// The crypto map publishes these on every coin with a real options book. flip maps to the
// snapshot's flip_zone; max_pain exists on crypto (settled daily at 08:00 UTC) so it earns
// a place the equity set does not give it.
const CRYPTO_NAMED = new Set(["flip", "call_wall", "put_wall", "max_pain"]);

const eh = (email) =>
  crypto.createHash("sha256").update(String(email || "").trim().toLowerCase())
    .digest("hex").slice(0, 16);
const _akey = (e) => "alerts:u:" + eh(e);

async function _load(r, email) {
  let a = null;
  try { a = await r.get(_akey(email)); } catch (_) { a = null; }
  if (typeof a === "string") { try { a = JSON.parse(a); } catch (_) { a = null; } }
  const now = Date.now();
  return (Array.isArray(a) ? a : []).filter((x) => x && x.expires > now && !x.fired);
}

async function _save(r, email, list) {
  try {
    await r.set(_akey(email), JSON.stringify(list), { ex: 30 * 24 * 3600 });
    if (list.length) await r.sadd("alerts:index", eh(email));
    else await r.srem("alerts:index", eh(email));
    if (list.length) await r.set("alerts:e:" + eh(email), String(email).trim().toLowerCase(), { ex: 30 * 24 * 3600 });
  } catch (_) {}
}

function _describe(a) {
  if (a.kind === "equity_level") {
    const lvl = typeof a.level === "number" ? a.level : `its ${String(a.level).replace("_", " ")}`;
    return `${a.ticker} ${a.direction} ${lvl}${a.recurring ? " (recurring)" : ""}`;
  }
  if (a.kind === "vix_level") return `VIX ${a.direction} ${a.level}${a.recurring ? " (recurring)" : ""}`;
  if (a.kind === "crypto_level") {
    const lvl = typeof a.level === "number" ? a.level : `its ${String(a.level).replace("_", " ")}`;
    return `${a.coin} ${a.direction} ${lvl}${a.recurring ? " (recurring)" : ""}`;
  }
  if (a.kind === "crypto_block")
    return `${a.coin === "ANY" ? "any coin" : a.coin}: option blocks over $${(a.min_usd / 1e6).toFixed(a.min_usd >= 1e6 ? 1 : 2).replace(/\.0$/, "")}M`;
  return a.kind;
}

// Peek at the live crypto snapshot so a bad coin or a bookless named level fails at CREATION
// with a reason, instead of sitting silent for 7 days. Never blocks creation when the
// snapshot is unreadable — the evaluator is the authority, this is just early honesty.
async function _cryptoSnap(r) {
  try {
    let raw = await r.get("crypto:map:live");
    if (typeof raw === "string") raw = JSON.parse(raw);
    return raw && raw.coins ? raw : null;
  } catch (_) { return null; }
}

async function setAlert(email, { kind, ticker, coin, level, direction, note, recurring, min_usd } = {}) {
  const r = kv();
  if (!r || !email) return { error: "alerts unavailable" };
  kind = String(kind || "").trim();
  direction = String(direction || "").trim().toLowerCase();
  const needsDirection = kind !== "crypto_block";
  if (needsDirection && !["above", "below"].includes(direction))
    return { error: "direction must be above or below" };

  const a = { id: crypto.randomBytes(4).toString("hex"), kind,
              note: String(note || "").slice(0, 120) || null,
              created: Date.now(), expires: Date.now() + DEFAULT_TTL_MS };
  if (needsDirection) a.direction = direction;
  if (recurring === true && kind !== "crypto_block") { a.recurring = true; a.armed = true; }

  if (kind === "equity_level") {
    a.ticker = String(ticker || "").trim().toUpperCase();
    if (!EQ_TICKERS.has(a.ticker)) return { error: "ticker must be SPY, QQQ or IWM" };
    if (typeof level === "number" && isFinite(level) && level > 0) a.level = level;
    else if (NAMED_LEVELS.has(String(level))) a.level = String(level);
    else return { error: "level must be a price or one of flip, call_wall, put_wall" };
  } else if (kind === "vix_level") {
    const v = Number(level);
    if (!isFinite(v) || v <= 0 || v > 200) return { error: "vix level must be a number" };
    a.level = v;
  } else if (kind === "crypto_level") {
    a.coin = String(coin || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!a.coin) return { error: "coin required" };
    const snap = await _cryptoSnap(r);
    if (snap && !snap.coins[a.coin])
      return { error: `${a.coin} is not on the map - name a mapped coin` };
    if (CRYPTO_NAMED.has(String(level))) {
      // A named level only exists where the coin has an options book publishing one.
      if (snap && !(snap.coins[a.coin] && snap.coins[a.coin].gamma))
        return { error: `${a.coin} has no options book, so it has no ${level} - ` +
                        "use a price, or a coin with a gamma panel" };
      a.level = String(level);
    } else {
      const v = Number(level);
      if (!isFinite(v) || v <= 0)
        return { error: "level must be a positive price, or one of flip, call_wall, put_wall, max_pain" };
      a.level = v;
    }
  } else if (kind === "crypto_block") {
    a.coin = String(coin || "ANY").trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || "ANY";
    const v = Number(min_usd == null ? 1e6 : min_usd);
    if (!isFinite(v) || v < BLOCK_MIN_USD_FLOOR)
      return { error: `min_usd must be at least $${BLOCK_MIN_USD_FLOOR.toLocaleString("en-US")} - ` +
                      "the tape below that is ordinary prints, not blocks" };
    a.min_usd = v;
    a.seen_ms = Date.now();   // watermark: only prints AFTER creation can fire
    if (a.coin !== "ANY") {
      const snap = await _cryptoSnap(r);
      if (snap && !snap.coins[a.coin])
        return { error: `${a.coin} is not on the map - name a mapped coin, or ANY` };
      // No tape yet is fine (a book can go quiet); a coin that is mapped but has no options
      // book at all will simply never print a block — say so rather than sit silent.
      if (snap && snap.coins[a.coin] && !snap.coins[a.coin].gamma && !snap.coins[a.coin].option_tape)
        return { error: `${a.coin} has no options book, so it has no block tape - ` +
                        "use ANY, or a coin with a gamma panel" };
    }
  } else {
    return { error: "kind must be equity_level, vix_level, crypto_level or crypto_block" };
  }

  const list = await _load(r, email);
  if (list.length >= MAX_ACTIVE) {
    return { error: `alert cap reached (${MAX_ACTIVE}) - cancel one first`,
             active: list.map((x) => ({ id: x.id, alert: _describe(x) })) };
  }
  list.push(a);
  await _save(r, email, list);

  // A route has to exist for the message to land. Say so NOW, not at fire time.
  let devices = 0;
  try {
    const subs = await r.get("push:u:" + eh(email));
    devices = (typeof subs === "string" ? JSON.parse(subs) : subs || []).length;
  } catch (_) {}
  const discord = !!(await _discordId(r, email));
  const routes = [];
  if (devices) routes.push(`push to ${devices} device${devices > 1 ? "s" : ""}`);
  if (discord) routes.push("a Discord DM");
  return { ok: true, id: a.id, watching: _describe(a),
           expires_in_days: 7,
           one_shot: kind !== "crypto_block" && !a.recurring,
           devices_registered: devices, discord_linked: discord,
           note: routes.length
             ? `fires as ${routes.join(" and ")}${kind !== "crypto_block" && !a.recurring ? ", then retires" : ""}`
             : "SAVED, but no route can reach you - toggle 'Live push alerts' on the " +
               "dashboard once, or link Discord from your welcome email" };
}

async function listAlerts(email) {
  const r = kv();
  if (!r || !email) return { error: "alerts unavailable" };
  const list = await _load(r, email);
  return { active: list.map((x) => ({ id: x.id, alert: _describe(x), note: x.note,
                                      expires_in_h: Math.round((x.expires - Date.now()) / 3600000) })) };
}

async function cancelAlert(email, { id } = {}) {
  const r = kv();
  if (!r || !email) return { error: "alerts unavailable" };
  let list = await _load(r, email);
  const before = list.length;
  if (String(id).toLowerCase() === "all") list = [];
  else list = list.filter((x) => x.id !== String(id));
  await _save(r, email, list);
  return { ok: true, cancelled: before - list.length, remaining: list.length };
}

// ── delivery ─────────────────────────────────────────────────────────────────
async function _push(email, title, body) {
  const r = kv();
  if (!r) return 0;
  let subs = null;
  try { subs = await r.get("push:u:" + eh(email)); } catch (_) { subs = null; }
  if (typeof subs === "string") { try { subs = JSON.parse(subs); } catch (_) { subs = null; } }
  if (!Array.isArray(subs) || !subs.length) return 0;
  if (!process.env.ANALYST_VAPID_PUBLIC || !process.env.ANALYST_VAPID_PRIVATE) return 0;
  const webpush = require("web-push");
  webpush.setVapidDetails(process.env.ANALYST_VAPID_SUBJECT || "mailto:support@novo-options.trade",
    process.env.ANALYST_VAPID_PUBLIC, process.env.ANALYST_VAPID_PRIVATE);
  let sent = 0;
  for (const s of subs.slice(0, 5)) {
    try {
      await webpush.sendNotification(s, JSON.stringify({ title, body, tag: "novo-alert" }));
      sent++;
    } catch (_) { /* dead sub - left for the next re-subscribe to replace */ }
  }
  return sent;
}

// The reader's Discord id, if they linked one. The link flow (api/discord.js) stores it on
// the Stripe customer as metadata.discord_id — the one durable place it already lives — so
// this resolves from Stripe once and caches the verdict either way. "0" = looked, none.
async function _discordId(r, email) {
  const norm = String(email || "").trim().toLowerCase();
  if (!norm) return null;
  const ck = "alerts:d:" + eh(norm);
  try {
    const c = await r.get(ck);
    if (typeof c === "string" && c) return c === "0" ? null : c;
  } catch (_) {}
  let uid = null;
  try {
    if (!process.env.STRIPE_SECRET_KEY) return null;
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    const custs = await stripe.customers.list({ email: norm, limit: 100 });
    for (const c of custs.data) {
      if (c && c.metadata && c.metadata.discord_id) { uid = String(c.metadata.discord_id); break; }
    }
  } catch (e) { console.error("[alerts] discord lookup:", e.message); return null; }
  try { await r.set(ck, uid || "0", { ex: uid ? 7 * 24 * 3600 : 6 * 3600 }); } catch (_) {}
  return uid;
}

// One DM, best effort. The bot already shares the guild with every linked member (the link
// flow joins them), which is what makes the DM channel openable. A member who has DMs off
// simply does not get one — push remains the other route, and neither failure throws.
async function _discordDM(r, email, body) {
  try {
    const bot = process.env.DISCORD_BOT_TOKEN;
    if (!bot) return false;
    const uid = await _discordId(r, email);
    if (!uid) return false;
    const ch = await fetch("https://discord.com/api/v10/users/@me/channels", {
      method: "POST",
      headers: { Authorization: `Bot ${bot}`, "Content-Type": "application/json" },
      body: JSON.stringify({ recipient_id: uid }),
    });
    if (!ch.ok) return false;
    const chan = await ch.json();
    if (!chan || !chan.id) return false;
    const msg = await fetch(`https://discord.com/api/v10/channels/${chan.id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${bot}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: body.slice(0, 1900) }),
    });
    return msg.ok;
  } catch (e) { console.error("[alerts] discord dm:", e.message); return false; }
}

async function _deliver(email, title, body) {
  const r = kv();
  const sent = await _push(email, title, body);
  const dm = r ? await _discordDM(r, email, `**${title}** — ${body}`) : false;
  if (!sent && !dm) console.error("[alerts] fire had no route for", eh(email));
}

// ── evaluation ───────────────────────────────────────────────────────────────
// check(a) returns null (no change), or { fire?: "body text", changed?: true }. It may
// mutate the alert's own state (armed / next_ok / seen_ms / fired) — `changed` persists
// state movement that happened without a fire, like a block watermark walking forward.
async function _evaluate(kinds, check) {
  const r = kv();
  if (!r) return;
  let idx = [];
  try { idx = await r.smembers("alerts:index"); } catch (_) { return; }
  for (const h of (idx || []).slice(0, 500)) {
    let email = null;
    try { email = await r.get("alerts:e:" + h); } catch (_) { continue; }
    if (!email) continue;
    const list = await _load(r, email);
    if (!list.length) { await _save(r, email, []); continue; }
    let changed = false;
    for (const a of list) {
      if (!kinds.has(a.kind)) continue;
      let res = null;
      try { res = check(a); } catch (_) { continue; }
      if (!res) continue;
      if (res.changed) changed = true;
      if (res.fire) {
        changed = true;
        await _deliver(email, "NoVo alert",
          `${res.fire}${a.note ? " · " + a.note : ""}. ` +
          "A condition you set was met; what to do about it stays yours.");
      }
    }
    if (changed) await _save(r, email, list.filter((x) => !x.fired));
  }
}

// A level alert against a live value. One-shot: fire once, retire. Recurring: fire, then
// stay quiet until the value has been seen back on the OTHER side and the cooldown has
// passed — a re-cross is the event, not the value continuing to sit past the line.
function _levelCheck(a, value, threshold, label) {
  if (value == null || !isFinite(value) || !isFinite(threshold) || threshold === 0) return null;
  const hit = a.direction === "above" ? value >= threshold : value <= threshold;
  if (!a.recurring) {
    if (!hit) return null;
    a.fired = Date.now();
    return { fire: `${_describe(a)} - ${label} is ${value}` };
  }
  if (!hit) {
    if (!a.armed) { a.armed = true; return { changed: true }; }
    return null;
  }
  if (!a.armed || (a.next_ok && Date.now() < a.next_ok)) return null;
  a.armed = false;
  a.next_ok = Date.now() + COOLDOWN_MS;
  return { fire: `${_describe(a)} - ${label} is ${value}` };
}

// state = the engine's live-state body: indices[] with snake_case fields, and vol_env_by
// keyed by TICKER (SPY's gauge is VIX — {sym:'VIX', value, pct, tag}).
async function evaluateEquity(state) {
  try {
    const byTk = {};
    for (const t of (state && state.indices) || []) byTk[String(t.ticker || "").toUpperCase()] = t;
    let vix = null;
    const spyG = state && state.vol_env_by && state.vol_env_by.SPY;
    if (spyG && isFinite(Number(spyG.value))) vix = Number(spyG.value);
    await _evaluate(new Set(["equity_level", "vix_level"]), (a) => {
      if (a.kind === "vix_level") {
        return vix == null ? null : _levelCheck(a, vix, a.level, "VIX");
      }
      const t = byTk[a.ticker];
      if (!t || !isFinite(Number(t.spot))) return null;
      const threshold = typeof a.level === "number" ? a.level
        : a.level === "flip" ? Number(t.flip)
        : a.level === "call_wall" ? Number(t.call_wall)
        : Number(t.put_wall);
      return _levelCheck(a, Number(t.spot), Math.round(threshold * 100) / 100, `${a.ticker} spot`);
    });
  } catch (_) {}
}

// snap = the crypto map snapshot body
async function evaluateCrypto(snap) {
  try {
    const coins = (snap && snap.coins) || {};
    await _evaluate(new Set(["crypto_level", "crypto_block"]), (a) => {
      if (a.kind === "crypto_level") {
        const c = coins[a.coin];
        if (!c) return null;
        let threshold;
        if (typeof a.level === "number") threshold = a.level;
        else {
          const g = c.gamma;
          if (!g) return null;
          threshold = a.level === "flip" ? Number(g.flip_zone)
            : a.level === "call_wall" ? Number(g.call_wall)
            : a.level === "put_wall" ? Number(g.put_wall)
            : Number(g.max_pain);
          if (isFinite(threshold)) threshold = Math.round(threshold * 100) / 100;
        }
        return _levelCheck(a, Number(c.price), threshold, `${a.coin}`);
      }
      // crypto_block: walk every coin's published block tape past this alert's watermark.
      const codes = a.coin === "ANY" ? Object.keys(coins) : [a.coin];
      let newest = a.seen_ms || 0;
      let best = null;
      for (const code of codes) {
        const blocks = coins[code] && coins[code].option_tape && coins[code].option_tape.blocks;
        if (!Array.isArray(blocks)) continue;
        for (const b of blocks) {
          const ts = Date.parse(b.ts_utc || "") || 0;
          if (ts <= (a.seen_ms || 0)) continue;
          newest = Math.max(newest, ts);
          if (Number(b.premium_usd) >= a.min_usd && (!best || b.premium_usd > best.premium_usd))
            best = { ...b, _coin: code };
        }
      }
      if (newest <= (a.seen_ms || 0)) return null;
      a.seen_ms = newest;    // never re-reads a print, qualifying or not
      if (!best) return { changed: true };
      if (a.next_ok && Date.now() < a.next_ok) return { changed: true };
      a.next_ok = Date.now() + BLOCK_COOLDOWN_MS;
      const st = best.structure ? ` ${best.structure}` : "";
      return { fire: `${best._coin} block: $${(best.premium_usd / 1e6).toFixed(2)}M premium, ` +
                     `${best.legs} leg${best.legs > 1 ? "s" : ""}${st} (${best.instrument})` };
    });
  } catch (_) {}
}

module.exports = { setAlert, listAlerts, cancelAlert, evaluateEquity, evaluateCrypto, eh };
