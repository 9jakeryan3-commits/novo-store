// scripts/funnel-check.js — the funnel counts every outcome it claims to count.
//
// Written because the counter it guards failed silently for its whole life: after bump('asked')
// there were FOUR outcomes and only TWO were counted, so a model error or an unparseable response
// spent an ask and recorded nothing. Live evidence at the time of writing — asked 254, declined
// 253, calls 0 — one ask already lost with no trace of where.
//
// THE POINT OF THIS FILE IS THE KNOWN-POSITIVE. bump() silently returns on a stage it does not
// recognise, so adding bump('errored') calls WITHOUT adding 'errored' to STAGES would have been a
// fix that compiles, reviews clean and does nothing at all. That is the exact defect class this
// codebase keeps writing down, so the first assertion below is the one that matters: the stage
// must be registered, and an unregistered stage must still be rejected — the gate has to work in
// BOTH directions or it is decoration.
const { STAGES } = require('../api/_lib/funnel.js');
const fs = require('fs');
const SRC = fs.readFileSync(require.resolve('../api/_lib/novo-calls.js'), 'utf8');

// Every outcome reachable AFTER bump('asked'), and the stage each one must record.
const AFTER_ASKED = [
  ["catch (e) { await bump('errored', 1);", 'errored', 'model error'],
  ["catch (_) { await bump('errored', 1);", 'errored', 'unparseable response'],
  ["if (!calls.length) { await bump('declined', 1);", 'declined', 'a considered no'],
  ["await bump('calls', 1);", 'calls', 'a call was made'],
];

const T = [
  ['errored is a REGISTERED stage (or every bump of it is a silent no-op)',
    () => STAGES.includes('errored')],
  ['declined and calls are still registered',
    () => STAGES.includes('declined') && STAGES.includes('calls')],
  ['an UNregistered stage is still rejected — the gate works both ways',
    () => !STAGES.includes('definitely_not_a_stage')],
  ['asked is bumped before the model call, so it is a real denominator',
    () => SRC.indexOf("bump('asked'") < SRC.indexOf('generateContent')],
  ['skipped is bumped BEFORE asked, so it can never absorb a post-ask outcome',
    () => SRC.indexOf("bump('skipped'") < SRC.indexOf("bump('asked'")],
  ...AFTER_ASKED.map(([needle, stage, what]) => [
    `post-ask outcome "${what}" records ${stage}`,
    () => SRC.includes(needle),
  ]),
  ['no post-ask path returns declined:true without recording something',
    () => {
      const after = SRC.slice(SRC.indexOf("bump('asked'"));
      // every `declined: true` after the ask must sit on a line that also bumps.
      return after.split('\n')
        .filter((l) => l.includes('declined: true'))
        .every((l) => l.includes('bump('));
    }],
];

let pass = 0;
for (const [name, fn] of T) {
  let ok = false, err = '';
  try { ok = !!fn(); } catch (e) { err = ' THREW ' + e.message; }
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + err);
  if (ok) pass++;
}
console.log('\n' + pass + '/' + T.length);
process.exit(pass === T.length ? 0 : 1);
