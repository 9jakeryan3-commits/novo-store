// api/congress-ingest.js — pull new congressional Periodic Transaction Reports into KV.
//
// Runs on a cron. Reads the Clerk of the House annual index, fetches the PTR filings it has not
// seen, extracts their text, parses the transactions, and appends them. Primary source only.
//
// ⚠ NOTHING IS EVER DELETED. Rows append into `congress:tx:<year>` and the year keys carry no TTL.
// Jake's standing rule on this system: "we cannot delete useful data none, at all anyway, that's
// imperative." A disclosure corpus is only worth anything as history — the value of knowing a
// member bought a name is knowing when, against everything else they have ever filed.
//
// ⚠ UNREADABLE FILINGS ARE RECORDED, NOT SKIPPED. Roughly 12% of PTRs are scanned images of
// handwritten forms with no text layer (measured: 45 of 381 in the 2026 index). Those ids go into
// `congress:unparsed:<year>` and their count is served on the payload. A member who filed on paper
// must never render as a member who did not trade, and the only way to guarantee that is to carry
// the number of filings we could not read on the same object as the ones we could.

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { kv } = require('./_kv.js');
const {
  UA, isElectronic, parseTransactions, parseIndex, indexUrl, ptrUrl, memberName,
} = require('./_lib/congress.js');

/* Same gate as crypto-rundown.js, and for the reason written there: a Vercel cron presents
   `Authorization: Bearer $CRON_SECRET`, NOT the x-vercel-cron header. Getting that backwards made
   crypto-rundown 403 on every run it ever made while looking perfectly healthy. */
function authed(req) {
  const auth = String(req.headers['authorization'] || '');
  if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) return true;
  if (req.headers['x-vercel-cron']) return true;
  const want = process.env.OPS_SECRET || process.env.ANALYST_PUBLISH_SECRET || '';
  const got = String(req.headers['x-ops-secret'] || req.headers['x-analyst-secret'] || '');
  if (!want || !got || got.length !== want.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch (_) { return false; }
}

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** Read the single .txt member out of the Clerk's index ZIP. */
function unzipFirstTxt(buf) {
  let i = 0;
  while (i < buf.length - 4) {
    if (buf.readUInt32LE(i) !== 0x04034b50) { i++; continue; }
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString('latin1');
    const start = i + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + compSize);
    if (/\.txt$/i.test(name)) return (method === 0 ? data : zlib.inflateRawSync(data)).toString('utf8');
    i = start + compSize;
  }
  throw new Error('no .txt member in the index zip');
}

module.exports = async function handler(req, res) {
  if (!authed(req)) return res.status(403).json({ error: 'forbidden' });
  const r = kv();
  if (!r) return res.status(503).json({ error: 'kv unavailable' });

  const year = parseInt(req.query.year || '', 10) || new Date().getUTCFullYear();
  // A cron run only has a handful of new filings; a backfill is explicit and bounded.
  const budget = Math.max(1, Math.min(parseInt(req.query.max || '', 10) || 25, 200));
  const started = Date.now();

  let index;
  try {
    index = parseIndex(unzipFirstTxt(await get(indexUrl(year))));
  } catch (e) {
    return res.status(502).json({ error: 'index fetch failed', detail: String(e.message || e) });
  }

  const ptrs = index.filter((x) => x.FilingType === 'P');
  const seenKey = `congress:seen:${year}`;
  const seen = new Set(await r.smembers(seenKey).catch(() => []));

  const todo = ptrs.filter((x) => !seen.has(String(x.DocID)));
  // newest first: if the budget runs out, the panel is still current at the recent end
  todo.sort((a, b) => Date.parse(b.FilingDate) - Date.parse(a.FilingDate));

  const { extractText, getDocumentProxy } = require('unpdf');
  const fresh = [];
  const unreadable = [];
  const failed = [];
  let processed = 0;

  for (const f of todo.slice(0, budget)) {
    const doc = String(f.DocID);
    processed++;
    if (!isElectronic(doc)) {
      // a paper scan - recorded so it is visible, and marked seen so it is not retried forever
      unreadable.push(doc);
      await r.sadd(seenKey, doc).catch(() => {});
      await r.sadd(`congress:unparsed:${year}`, doc).catch(() => {});
      continue;
    }
    let rows = [];
    let chars = 0;
    try {
      const pdf = await getDocumentProxy(new Uint8Array(await get(ptrUrl(year, doc))));
      const text = (await extractText(pdf, { mergePages: true })).text || '';
      chars = text.trim().length;
      rows = parseTransactions(text);
    } catch (e) {
      failed.push(`${doc}: ${String(e.message || e).slice(0, 80)}`);
      continue;                                  // NOT marked seen - a transient error must retry
    }
    if (chars > 400 && rows.length === 0) {
      /* Text present, nothing parsed. That is a parser regression, not a member who did nothing,
         and it must not be silently absorbed: leave it UNSEEN so the next run retries it, and
         report it. This is the exact failure the parse-check guards against. */
      failed.push(`${doc}: ${chars} chars of text, 0 transactions parsed`);
      continue;
    }
    const member = memberName(f);
    for (const t of rows) {
      fresh.push({
        ...t,
        doc_id: doc,
        member,
        state_district: f.StateDst || null,
        filed: f.FilingDate || null,
        chamber: 'house',
        source: `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${doc}.pdf`,
      });
    }
    await r.sadd(seenKey, doc).catch(() => {});
  }

  if (fresh.length) {
    // append-only, newest last; the read endpoint sorts and slices
    await r.rpush(`congress:tx:${year}`, ...fresh.map((x) => JSON.stringify(x))).catch(() => {});
  }
  const meta = {
    last_run: new Date().toISOString(),
    year,
    ptrs_in_index: ptrs.length,
    remaining: Math.max(0, todo.length - processed),
    added: fresh.length,
    unreadable: unreadable.length,
    failed: failed.length,
    ms: Date.now() - started,
  };
  await r.set(`congress:meta:${year}`, JSON.stringify(meta)).catch(() => {});

  return res.status(200).json({ ...meta, failures: failed.slice(0, 10) });
};
