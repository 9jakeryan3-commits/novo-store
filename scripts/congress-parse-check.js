/* congress-parse-check.js — prove the PTR parser against the live House Clerk source.
 *
 * This is the check that makes api/_lib/congress.js trustworthy, and it is written to FAIL rather
 * than to reassure. The failure mode it exists to catch is specific and quiet: an electronic
 * filing that yields zero transactions looks identical to a member who did not trade. Every
 * defect found while building this parser had exactly that shape —
 *
 *   - requiring a "(TICKER)" returned 0 rows for a real filing of municipal bonds, which have no
 *     ticker at all;
 *   - anchoring on the "Transactions" heading matched nothing, because the headings are set in a
 *     CID font with no ToUnicode map and extract as NUL bytes;
 *   - the same NUL bytes render as spaces in a terminal, so a filter written against whitespace
 *     looked correct on screen and matched nothing.
 *
 * So: a text-bearing filing that parses to zero rows is an ERROR here, not a data point.
 *
 * Usage:  node scripts/congress-parse-check.js [sampleSize]
 */
const { extractText, getDocumentProxy } = require('unpdf');
const zlib = require('node:zlib');
const {
  UA, isElectronic, parseTransactions, parseIndex, indexUrl, ptrUrl, memberName, lagDays,
} = require('../api/_lib/congress.js');

const YEAR = new Date().getUTCFullYear();
const SAMPLE = parseInt(process.argv[2] || '60', 10);

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

/* The Clerk ships the index as a ZIP of two files. One small member, stored or deflated - reading
   it with zlib avoids a dependency for the sake of one archive. */
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
    if (/\.txt$/i.test(name)) {
      return (method === 0 ? data : zlib.inflateRawSync(data)).toString('utf8');
    }
    i = start + compSize;
  }
  throw new Error('no .txt member in the index zip');
}

(async () => {
  console.log('  source: %s', indexUrl(YEAR));
  const idx = parseIndex(unzipFirstTxt(await get(indexUrl(YEAR))));
  const ptr = idx.filter((r) => r.FilingType === 'P');
  const elec = ptr.filter((r) => isElectronic(r.DocID));
  const paper = ptr.filter((r) => !isElectronic(r.DocID));
  console.log('  %d filings in the %d index; %d are PTRs', idx.length, YEAR, ptr.length);
  console.log('  electronic (parseable): %d    paper scans (cannot be read): %d\n',
    elec.length, paper.length);

  // newest first - the recent end is what the panel shows and what breaks first
  const pick = elec.slice().sort((a, b) => Date.parse(b.FilingDate) - Date.parse(a.FilingDate))
    .slice(0, SAMPLE);

  let totalRows = 0;
  let withTicker = 0;
  const emptyTextual = [];
  const fetchErr = [];
  const lags = [];

  for (const r of pick) {
    let text = '';
    try {
      const pdf = await getDocumentProxy(new Uint8Array(await get(ptrUrl(YEAR, r.DocID))));
      text = (await extractText(pdf, { mergePages: true })).text || '';
    } catch (e) {
      fetchErr.push(`${r.DocID}: ${e.message}`);
      continue;
    }
    const rows = parseTransactions(text);
    totalRows += rows.length;
    withTicker += rows.filter((x) => x.ticker).length;
    rows.forEach((x) => { const l = lagDays(x); if (l != null) lags.push(l); });

    // THE ASSERTION THIS FILE EXISTS FOR
    if (text.trim().length > 400 && rows.length === 0) {
      emptyTextual.push(`${r.DocID} ${memberName(r)} (${text.trim().length} chars of text)`);
    }
  }

  lags.sort((a, b) => a - b);
  const pct = (p) => (lags.length ? lags[Math.min(lags.length - 1, Math.floor(lags.length * p))] : null);

  console.log('  sampled %d electronic filings', pick.length);
  console.log('    transactions parsed : %d', totalRows);
  console.log('    with a ticker       : %d  (the rest are bonds, funds and notes - no ticker exists)', withTicker);
  console.log('    disclosure lag days : min %s  median %s  p90 %s  max %s',
    lags[0], pct(0.5), pct(0.9), lags[lags.length - 1]);
  if (fetchErr.length) {
    console.log('\n  fetch errors (%d):', fetchErr.length);
    fetchErr.slice(0, 5).forEach((e) => console.log('    ' + e));
  }

  let bad = 0;
  if (emptyTextual.length) {
    bad = 1;
    console.log('\n  !! %d filing(s) HAVE TEXT BUT PARSED TO ZERO TRANSACTIONS:', emptyTextual.length);
    emptyTextual.slice(0, 10).forEach((e) => console.log('     ' + e));
    console.log('     Each of these renders as "this member did not trade" and that may be false.');
  }
  if (totalRows === 0) {
    bad = 1;
    console.log('\n  !! zero transactions across the whole sample - the parser is not working');
  }
  console.log('\n  %s', bad ? 'FAIL' : 'PASS - every text-bearing filing produced transactions');
  process.exit(bad);
})().catch((e) => { console.error('  !! ' + e.message); process.exit(1); });
