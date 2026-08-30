// api/_lib/alerts.js — reader-defined alerts, created in conversation, delivered by push.
//
// "Tell me if SPY crosses its flip" is a NOTIFICATION, not advice: the reader picks the
// condition, NoVo watches the same published numbers everyone sees, and the push says a level
// was crossed — never what to do about it. Alerts are the reader's own objects: capped at
// MAX_ACTIVE, expiring by default in 7 days, listable and cancellable in a sentence.
//
// Evaluation rides the publishes that already happen: the equity live-state push (~60s) and
// the crypto snapshot push (~5min) each call their evaluator after storing. One-shot on
// purpose — a crossing fires once and the alert retires, because a level being oscillated
// through 40 times an hour is noise nobody asked for. Re-arm by asking again.

const crypto = require("crypto");
const { kv } = require("../_kv.js");

const MAX_ACTIVE = 10;
const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;
const EQ_TICKERS = new Set(["SPY", "QQQ", "IWM"]);
const NAMED_LEVELS = new Set(["flip", "call_wall", "put_wall"]);

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
    return `${a.ticker} ${a.direction} ${lvl}`;
  }
  if (a.kind === "vix_level") return `VIX ${a.direction} ${a.level}`;
  if (a.kind === "crypto_level") return `${a.coin} ${a.direction} ${a.level}`;
  return a.kind;
}

async function setAlert(email, { kind, ticker, coin, level, direction, note } = {}) {
  const r = kv();
  if (!r || !email) return { error: "alerts unavailable" };
  kind = String(kind || "").trim();
  direction = String(direction || "").trim().toLowerCase();
  if (!["above", "below"].includes(direction)) return { error: "direction must be above or below" };

  const a = { id: crypto.randomBytes(4).toString("hex"), kind, direction,
              note: String(note || "").slice(0, 120) || null,
              created: Date.now(), expires: Date.now() + DEFAULT_TTL_MS };
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
    const v = Number(level);
    if (!a.coin) return { error: "coin required" };
    if (!isFinite(v) || v <= 0) return { error: "level must be a positive price" };
    a.level = v;
  } else {
    return { error: "kind must be equity_level, vix_level or crypto_level" };
  }

  const list = await _load(r, email);
  if (list.length >= MAX_ACTIVE) {
    return { error: `alert cap reached (${MAX_ACTIVE}) - cancel one first`,
             active: list.map((x) => ({ id: x.id, alert: _describe(x) })) };
  }
  list.push(a);
  await _save(r, email, list);
  // A device has to exist for the push to land. Say so NOW, not at fire time.
  let devices = 0;
  try {
    const subs = await r.get("push:u:" + eh(email));
    devices = (typeof subs === "string" ? JSON.parse(subs) : subs || []).length;
  } catch (_) {}
  return { ok: true, id: a.id, watching: _describe(a),
           expires_in_days: 7, one_shot: true, devices_registered: devices,
           note: devices ? "fires once as a push to your device(s), then retires"
                         : "SAVED, but no device is registered for push - toggle 'Live push " +
                           "alerts' on the dashboard once or this can never reach you" };
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

// ── evaluation ───────────────────────────────────────────────────────────────
async function _evaluate(resolveValue, kinds) {
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
      const cur = resolveValue(a);
      if (cur == null || !isFinite(cur.value) || !isFinite(cur.threshold)) continue;
      const hit = a.direction === "above" ? cur.value >= cur.threshold : cur.value <= cur.threshold;
      if (hit) {
        a.fired = Date.now();
        changed = true;
        await _push(email, "NoVo alert",
          `${_describe(a)} - ${cur.label} is ${cur.value}${a.note ? " · " + a.note : ""}. ` +
          "A level was crossed; what to do about it stays yours.");
      }
    }
    if (changed) await _save(r, email, list.filter((x) => !x.fired));
  }
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
    await _evaluate((a) => {
      if (a.kind === "vix_level") {
        return vix == null ? null : { value: vix, threshold: a.level, label: "VIX" };
      }
      const t = byTk[a.ticker];
      if (!t || !isFinite(Number(t.spot))) return null;
      const spot = Number(t.spot);
      const threshold = typeof a.level === "number" ? a.level
        : a.level === "flip" ? Number(t.flip)
        : a.level === "call_wall" ? Number(t.call_wall)
        : Number(t.put_wall);
      if (!isFinite(threshold) || threshold === 0) return null;
      return { value: spot, threshold: Math.round(threshold * 100) / 100, label: `${a.ticker} spot` };
    }, new Set(["equity_level", "vix_level"]));
  } catch (_) {}
}

// snap = the crypto map snapshot body
async function evaluateCrypto(snap) {
  try {
    await _evaluate((a) => {
      if (a.kind !== "crypto_level") return null;
      const c = snap.coins && snap.coins[a.coin];
      if (!c || !isFinite(Number(c.price))) return null;
      return { value: Number(c.price), threshold: a.level, label: `${a.coin}` };
    }, new Set(["crypto_level"]));
  } catch (_) {}
}

module.exports = { setAlert, listAlerts, cancelAlert, evaluateEquity, evaluateCrypto, eh };
