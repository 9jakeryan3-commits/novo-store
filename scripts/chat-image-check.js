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

// All THREE chat surfaces are hand-copied twins, so ALL THREE are checked. A fix that lands in one
// and not the others is the most productive defect shape in this estate.
//
// ⚠ js/novo-chat.js WAS MISSING FROM THIS LIST UNTIL 2026-09-12, and that is worse than not having
// the check: a guard reporting green over an unguarded file buys confidence it has not earned. The
// Trader dashboard's copy could have drifted on every assertion below and this suite stayed green.
//
// ⚠ AND IT IS NOT GENERATED, whatever older notes say. There is no generator in the tree, no script
// writes this file, and `git log -S build_chat_module` across all branches returns nothing — it was
// never committed, so "regenerate and diff" has nothing to regenerate with. novo-chat.js's own
// header is the authority: a ONE-TIME mechanical extraction, after which "a chat fix goes in three
// places". Verified 2026-09-12: all three files extract saveTurns to a byte-identical 1,039 chars,
// which is what makes one FILES list able to cover them.
const FILES = ["analyst-live.html", "crypto-live.html", "js/novo-chat.js"]
  .map((f) => path.join(__dirname, "..", "public", f));

/* A MISSING FUNCTION IS A FINDING, NOT A CRASH. This used to process.exit on the first copy that
   lacked something, so the copies after it were never checked at all -- and the run read as one
   broken file rather than as "two of three have the fix". Since drift between the three copies is
   the entire defect class this suite exists for, it has to REPORT the gap and keep going. */
function one(h, file, decl) {
  const start = h.indexOf(decl);
  if (start < 0) return null;
  const end = h.indexOf("\n  }", start) + 4;
  return h.slice(start, end).replace(/\r\n/g, "\n");
}

/* Both functions, because saveTurns CALLS releaseOldImages. Extracting only saveTurns left the
   helper out of the sandbox's scope and every copy died on a ReferenceError -- a suite that goes
   red for a reason that has nothing to do with the behaviour it is checking. */
function extract(file) {
  const h = fs.readFileSync(file, "utf8");
  const rel = one(h, file, "  function releaseOldImages(){");
  const sav = one(h, file, "  function saveTurns(){");
  if (!sav) return { miss: "saveTurns" };
  if (!rel) return { miss: "releaseOldImages" };
  return { src: rel + "\n" + sav, rel: rel, raw: h };
}

/* ⚠ THE SANDBOX CANNOT SEE HALF OF THIS FIX, AND THE HALF IT CANNOT SEE IS THE HALF THAT LEAKS.
   A pasted chart is retained THREE ways per turn: the base64 on the turn object, the same string
   as the <img> src, and a third copy captured by the onclick closure. Section 0 runs against a
   document stub, so it only ever proves the FIRST one is released -- and a port that adds
   releaseOldImages and nothing else passes it while freeing nothing:

     onclick closing over `img`   -> the handler holds the string for the life of the node, and the
                                     heap shows the array entry and the src released while still
                                     holding megabytes
     no data-turn-t on the <img>  -> the querySelector matches nothing, so the node is never
                                     replaced: the turn object loses its image while the picture
                                     stays on screen

   Sabotage-tested 2026-09-12 -- with the suite otherwise green, removing data-turn-t passed, and
   restoring the capturing onclick passed. Both are source-text facts, so they are asserted as
   source text rather than pretended to be behaviour. */
function domWiring(file, raw) {
  const name = path.basename(file);
  const capture = /im\.onclick\s*=\s*function\(\)\s*\{[^}]*window\.open\(\s*img\b/.test(raw);
  const thisSrc = /im\.onclick\s*=\s*function\(\)\s*\{[^}]*window\.open\(\s*this\.src\b/.test(raw);
  const tagged = /im\.setAttribute\(\s*['"]data-turn-t['"]/.test(raw);
  const queried = /img\[data-turn-t=/.test(raw);
  check("onclick reads this.src, not a captured string   [" + name + "]", thisSrc && !capture,
        capture ? "closes over img - that closure is the third copy" : (thisSrc ? "ok" : "no onclick found"));
  check("the <img> carries data-turn-t                   [" + name + "]", tagged,
        tagged ? "ok" : "without it releaseOldImages can never find the node it must replace");
  check("releaseOldImages looks the node up by that tag  [" + name + "]", queried);
}

const donors = new Map();
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
  /* releaseOldImages reaches for the log node. There is no DOM here, and its whole body sits in a
     try/catch, so WITHOUT a stub it would throw on document and be swallowed -- the release would
     silently not happen and this suite would report a pass for a function that never ran.
     getElementById returning null is the honest stand-in: the DOM half no-ops and the turn-object
     half still runs, which is the half a sandbox can test. Nodes and placeholders are covered
     separately against a real browser. */
  const document = { getElementById: () => null };
  const saveTurns = new Function(
    "localStorage", "CHAT_KEY", "CHAT_MAX", "TURNS", "add", "document",
    fnSrc + "; return saveTurns;"
  )(localStorage, "novo_ask_log", 40, turnsRef, add, document);
  return {
    store, added,
    stats: () => ({ writes, rejected }),
    // The LIVE array, not a copy. releaseOldImages mutates TURNS in place, and that mutation is
    // the whole point of it -- what goes to localStorage was already trimmed before the fix.
    turns: turnsRef,
    run: (turns) => { turnsRef.length = 0; turnsRef.push.apply(turnsRef, turns); return saveTurns(); },
  };
}

const BIG = "x".repeat(4000);   // stands in for a base64 thumbnail
const turnsWith = (n, imgs) => Array.from({ length: n }, (_, i) => (
  i < imgs ? { r: "you", x: "q" + i, t: i, img: BIG } : { r: "novo", x: "a" + i, t: i }));

function runAll(fnSrc) {
  /* ⚠ THIS SECTION EXISTS BECAUSE THE SUITE PASSED WITHOUT IT. Sabotage-tested 2026-09-12 by
     gutting releaseOldImages to `if (1) return;` in a real copy: every other check below still
     passed. They are all about what reaches localStorage, and saveTurns ALREADY trimmed that with
     TURNS.slice(-CHAT_MAX) long before this fix existed. The leak was in the in-memory TURNS array,
     which nothing here looked at -- so the fix was unasserted and a regression would have been
     invisible. The control matters as much as the assertion: a releaseOldImages that dropped
     EVERY image would satisfy the first check on its own. */
  console.log("\n=== 0. in-memory retention: old images released, recent ones kept ===");
  {
    const h = build(fnSrc, 1e9);
    h.run(turnsWith(45, 45));                   // 45 turns, all with images; CHAT_MAX is 40
    const old = h.turns.slice(0, 5).filter((t) => t.img).length;    // outside the window
    const recent = h.turns.slice(-40).filter((t) => t.img).length;  // inside it
    check("images outside the window are released", old === 0, "still holding=" + old);
    check("images inside the window are untouched", recent === 40, "kept=" + recent + "/40");
    check("no turn was dropped, only its image", h.turns.length === 45, "turns=" + h.turns.length);
    check("every turn still has its text", h.turns.filter((t) => t.x).length === 45,
          "with text=" + h.turns.filter((t) => t.x).length);
  }

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

/* ⚠ A HARD FLOOR, NOT A COMMENT. This suite covered ONE of three copies until 2026-09-12 and read
   green the entire time; the chat lives in three files and a guard that quietly checks one of them
   is the same defect it exists to catch. If a copy is added, raise this. If one disappears, that is
   a finding, not a convenience. */
const FLOOR = 3;
if (FILES.length < FLOOR) {
  console.error("\n  FAIL  corpus -- " + FILES.length + " chat surface(s), floor is " + FLOOR);
  console.error("        A shrinking corpus passes quietly. Fix the list or lower the floor on purpose.\n");
  process.exit(1);
}
console.log("  corpus: " + FILES.length + " chat surfaces (floor " + FLOOR + ")");

for (const f of FILES) {
  if (!fs.existsSync(f)) { console.error("\n  FAIL  missing chat surface: " + f + "\n"); process.exit(1); }
  console.log("\n########## " + path.basename(f) + " ##########");
  const ex = extract(f);
  if (ex.miss) {
    check(ex.miss + " is present in this copy", false,
          "this copy has not received the fix - the remaining copies are still checked below");
    continue;
  }
  runAll(ex.src);
  console.log("\n=== 6. DOM wiring the sandbox cannot reach ===");
  domWiring(f, ex.raw);
  donors.set(path.basename(f), ex.rel);
}

/* ⚠ COPYING FROM A COPY THAT HAS ALREADY DRIFTED PROPAGATES THE DRIFT, AND EVERY PER-FILE CHECK
   ABOVE STILL GOES GREEN -- three identical-and-wrong copies pass every parity check there is.
   Temi's habit, added after porting this fix into crypto-live: assert the donors agree BEFORE
   trusting any of them. The three copies are meant to be byte-identical; if they are not, one of
   them received a fix the others did not, which is the entire defect class this suite exists for. */
console.log("\n########## all copies agree ##########");
{
  const names = [...donors.keys()];
  const sizes = names.map((n) => n + "=" + donors.get(n).length);
  const first = donors.get(names[0]);
  const same = names.every((n) => donors.get(n) === first);
  check("releaseOldImages is byte-identical across all copies", names.length > 0 && same, sizes.join("  "));
}
console.log(fails ? "\n" + fails + " FAILED\n" : "\nOK - all " + FILES.length + " chat surfaces pass\n");
process.exit(fails ? 1 : 0);
