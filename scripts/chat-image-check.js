/* The chat transcript must survive the image feature.

   Jake reported that an uploaded picture never appeared in the thread ("I wasnt even sure if it
   sent"). Fixing that meant putting a thumbnail into every 'you' turn AND into the stored
   transcript -- which made the localStorage write big enough to hit the quota for the first time.
   The old body was a bare `try { setItem } catch(_){}`, so a full store would have silently
   stopped persisting the CONVERSATION in order to make room for a PICTURE.

   These checks exist so that trade can never happen. The ladder degrades in one direction only,
   and its last rung has to leave the user no worse off than before images existed. Every case
   asserts the REASON it passed, and the function under test is extracted from the SHIPPED html
   rather than retyped -- a test against a copy proves nothing about the file that deploys.

   SHOWN TO FAIL: reverting saveTurns to the old bare try/catch fails 9 of these.

   Run: node scripts/chat-image-check.js
*/
const fs = require("fs");
const path = require("path");

// Both chat surfaces are hand-copied twins, so BOTH are checked. A fix that lands in one and not
// the other is the most productive defect shape in this estate.
const FILES = ["analyst-live.html", "crypto-live.html"]
  .map((f) => path.join(__dirname, "..", "public", f));

function extract(file) {
  const h = fs.readFileSync(file, "utf8");
  const start = h.indexOf("  function saveTurns(){");
  if (start < 0) { console.error("could not find saveTurns in " + file); process.exit(1); }
  const end = h.indexOf("\n  }", start) + 4;
  return h.slice(start, end).replace(/\r\n/g, "\n");
}

let fails = 0;
function check(name, cond, detail) {
  console.log((cond ? "  PASS  " : "  FAIL  ") + name + (detail ? "   [" + detail + "]" : ""));
  if (!cond) fails++;
}

function build(fnSrc, quotaAfter) {
  const store = {};
  let writes = 0, rejected = 0;
  const localStorage = {
    setItem(k, v) {
      writes++;
      if (v.length > quotaAfter) {
        rejected++;
        const e = new Error("QuotaExceededError"); e.name = "QuotaExceededError"; throw e;
      }
      store[k] = v;
    },
  };
  const added = [];
  const add = (cls, text) => { added.push(text); return {}; };
  // Built ONCE and reused across calls: on the real page saveTurns is a single declaration, so
  // state hung off it (the _warned flag) survives between saves. Rebuilding per call would reset
  // that flag and make a working guard look broken -- which it did, on the first run of this file.
  const turnsRef = [];
  const saveTurns = new Function(
    "localStorage", "CHAT_KEY", "CHAT_MAX", "TURNS", "add",
    fnSrc + "; return saveTurns;"
  )(localStorage, "novo_ask_log", 40, turnsRef, add);
  return {
    store, added,
    stats: () => ({ writes, rejected }),
    run: (turns) => { turnsRef.length = 0; turnsRef.push.apply(turnsRef, turns); return saveTurns(); },
  };
}

const BIG = "x".repeat(4000);   // stands in for a base64 thumbnail
const turnsWith = (n, imgs) => Array.from({ length: n }, (_, i) => (
  i < imgs ? { r: "you", x: "q" + i, t: i, img: BIG } : { r: "novo", x: "a" + i, t: i }));

function runAll(fnSrc) {
  console.log("\n=== 1. plenty of room: everything persists, images included ===");
  {
    const h = build(fnSrc, 1e9);
    h.run(turnsWith(6, 3));
    const saved = JSON.parse(h.store["novo_ask_log"] || "null");
    check("the write lands", !!saved);
    check("all three thumbs survive", !!saved && saved.turns.filter((t) => t.img).length === 3,
          "imgs=" + (saved ? saved.turns.filter((t) => t.img).length : "none"));
    check("only one setItem was needed", h.stats().writes === 1, "writes=" + h.stats().writes);
  }

  console.log("\n=== 2. tight quota: OLDEST thumbs drop, newest kept, text intact ===");
  {
    const h = build(fnSrc, 5200);
    h.run(turnsWith(6, 3));
    // Tolerate a MISSING key rather than crashing on it: the pre-fix code swallowed the quota
    // error and wrote nothing, and that must surface as a legible FAIL, not a stack trace. A
    // suite whose failure mode is a crash cannot be read by whoever runs it next.
    const saved = JSON.parse(h.store["novo_ask_log"] || "null");
    check("a write eventually lands", !!saved,
          saved ? "" : "nothing persisted - the quota error was swallowed");
    check("text of every turn survives", !!saved && saved.turns.length === 6,
          "turns=" + (saved ? saved.turns.length : "none"));
    const kept = saved ? saved.turns.map((t, i) => (t.img ? i : -1)).filter((i) => i >= 0) : [];
    check("some thumbs were dropped", !!saved && kept.length < 3, "kept=" + JSON.stringify(kept));
    check("the NEWEST thumb is the one kept",
          !!saved && (kept.length === 0 || Math.max.apply(null, kept) === 2),
          "kept indices=" + JSON.stringify(kept));
    check("it retried rather than giving up", h.stats().rejected >= 1,
          "rejected=" + h.stats().rejected);
  }

  console.log("\n=== 3. no room for any image: text-only write still succeeds ===");
  {
    const h = build(fnSrc, 900);
    h.run(turnsWith(6, 3));
    const saved = JSON.parse(h.store["novo_ask_log"] || "null");
    check("the transcript is still saved", !!saved, "saved=" + !!saved);
    check("it is text-only", !!saved && saved.turns.every((t) => !t.img));
    check("no turn was lost to make room", !!saved && saved.turns.length === 6,
          "turns=" + (saved ? saved.turns.length : "none"));
    check("the user was NOT warned, because the text write worked", h.added.length === 0,
          "warnings=" + h.added.length);
  }

  console.log("\n=== 4. Safari private mode: EVERY write throws ===");
  {
    const h = build(fnSrc, -1);
    h.run(turnsWith(6, 3));
    check("nothing is persisted", !h.store["novo_ask_log"]);
    check("the user IS told, rather than it failing silently", h.added.length === 1,
          "warnings=" + h.added.length);
    const before = h.stats().writes;
    h.run(turnsWith(6, 3));
    check("the warning is not repeated on every save", h.added.length === 1,
          "warnings after 2nd save=" + h.added.length);
    check("the retry loop is BOUNDED, not unbounded", h.stats().writes - before < 20,
          "writes on 2nd save=" + (h.stats().writes - before));
  }

  console.log("\n=== 5. the ladder never loses turns to satisfy a write ===");
  {
    const h = build(fnSrc, 300);
    h.run(turnsWith(10, 5));
    check("no partial-history write was persisted", !h.store["novo_ask_log"],
          "a write that cannot fit must fail loudly, not save half the thread");
  }
}

for (const f of FILES) {
  console.log("\n########## " + path.basename(f) + " ##########");
  runAll(extract(f));
}
console.log(fails ? "\n" + fails + " FAILED\n" : "\nOK - both chat surfaces pass\n");
process.exit(fails ? 1 : 0);
