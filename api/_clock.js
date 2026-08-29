// api/_clock.js — NoVo's grasp of *when it is*.
//
// This exists because the Analyst had none. `Date` appeared in analyst-ask.js only for cache TTLs
// and JWT expiry; the model was never told the date, so it inferred "today" from the newest dated
// artifact it could see — the last logged session. On Saturday 2026-08-22 it answered "Today is
// August 21, 2026", because Friday's session was the freshest thing in its context. Confidently
// wrong about the one fact a market analyst can never be wrong about.
//
// Everything here is computed in America/New_York via Intl, so DST is handled by the platform
// rather than by an offset we would have to maintain. NYSE holidays are rule-based, so they are
// derived rather than hardcoded to a year — a baked 2026 table would silently rot on 1 Jan.

const TZ = 'America/New_York';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** Wall-clock parts in New York for a given instant. */
function etParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const p = {};
  for (const { type, value } of f.formatToParts(d)) p[type] = value;
  const y = +p.year, m = +p.month, day = +p.day;
  let hour = +p.hour;
  if (hour === 24) hour = 0;              // Intl emits 24 for midnight under hour12:false
  const min = +p.minute;
  // Day-of-week from the calendar date itself, so it cannot disagree with the date we print.
  const dow = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
  return { y, m, d: day, hour, min, dow, minutes: hour * 60 + min };
}

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const dowOf = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

/** nth weekday of a month, e.g. nth(2026, 1, 1, 3) = 3rd Monday of January. */
function nth(y, m, weekday, n) {
  const first = dowOf(y, m, 1);
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

/** Last given weekday of a month (Memorial Day). */
function last(y, m, weekday) {
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return days - ((dowOf(y, m, days) - weekday + 7) % 7);
}

/** Anonymous Gregorian computus — needed only for Good Friday. */
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const dd = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - dd - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { m: month, d: day };
}

/** A weekend-date shifted to the observed weekday, the way the NYSE observes fixed holidays. */
function observed(y, m, d) {
  const w = dowOf(y, m, d);
  if (w === 6) return iso(y, m, d - 1);   // Saturday -> observed Friday
  if (w === 0) return iso(y, m, d + 1);   // Sunday   -> observed Monday
  return iso(y, m, d);
}

/** Full-closure NYSE holidays for a year, as { 'YYYY-MM-DD': 'Name' }. */
function holidays(y) {
  const h = {};
  h[observed(y, 1, 1)] = "New Year's Day";
  h[iso(y, 1, nth(y, 1, 1, 3))] = 'Martin Luther King Jr. Day';
  h[iso(y, 2, nth(y, 2, 1, 3))] = "Presidents' Day";
  const e = easter(y);
  const gf = new Date(Date.UTC(y, e.m - 1, e.d - 2));
  h[iso(gf.getUTCFullYear(), gf.getUTCMonth() + 1, gf.getUTCDate())] = 'Good Friday';
  h[iso(y, 5, last(y, 5, 1))] = 'Memorial Day';
  h[observed(y, 6, 19)] = 'Juneteenth';
  h[observed(y, 7, 4)] = 'Independence Day';
  h[iso(y, 9, nth(y, 9, 1, 1))] = 'Labor Day';
  h[iso(y, 11, nth(y, 11, 4, 4))] = 'Thanksgiving';
  h[observed(y, 12, 25)] = 'Christmas Day';
  return h;
}

/** 1:00pm ET early closes: the day after Thanksgiving, and Christmas Eve when it is a weekday. */
function earlyCloses(y) {
  const s = new Set();
  const tg = nth(y, 11, 4, 4);
  s.add(iso(y, 11, tg + 1));
  const ce = dowOf(y, 12, 24);
  if (ce !== 0 && ce !== 6) s.add(iso(y, 12, 24));
  const j3 = dowOf(y, 7, 3);
  if (j3 !== 0 && j3 !== 6 && dowOf(y, 7, 4) !== 0 && dowOf(y, 7, 4) !== 6) s.add(iso(y, 7, 3));
  return s;
}

function isTradingDay(y, m, d) {
  const w = dowOf(y, m, d);
  if (w === 0 || w === 6) return false;
  return !holidays(y)[iso(y, m, d)];
}

/** The next date the market opens, starting the day AFTER the given date. */
function nextTradingDay(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  for (let i = 0; i < 10; i++) {
    dt.setUTCDate(dt.getUTCDate() + 1);
    const [yy, mm, dd] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
    if (isTradingDay(yy, mm, dd)) return { y: yy, m: mm, d: dd };
  }
  return null;
}

const pretty = (y, m, d) => `${DAYS[dowOf(y, m, d)]}, ${d} ${MONTHS[m - 1]} ${y}`;

function hhmm(mins) {
  const h = Math.floor(mins / 60), mm = mins % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${ap}`;
}

/**
 * Where we are in the trading day, resolved rather than guessed.
 * Phases: weekend | holiday | overnight | premarket | open | afterhours | closed
 */
function marketState(d = new Date()) {
  const p = etParts(d);
  const key = iso(p.y, p.m, p.d);
  const holiday = holidays(p.y)[key] || null;
  const early = earlyCloses(p.y).has(key);
  const close = early ? 13 * 60 : 16 * 60;
  const weekend = p.dow === 0 || p.dow === 6;

  let phase, note;
  if (weekend) { phase = 'weekend'; note = 'the market is closed for the weekend'; }
  else if (holiday) { phase = 'holiday'; note = `the market is closed for ${holiday}`; }
  else if (p.minutes < 4 * 60) { phase = 'overnight'; note = 'overnight — the market is closed'; }
  else if (p.minutes < 9 * 60 + 30) { phase = 'premarket'; note = 'pre-market — the regular session has not opened yet'; }
  else if (p.minutes < close) { phase = 'open'; note = early ? 'the market is OPEN (early close at 1:00 PM ET today)' : 'the market is OPEN'; }
  else if (p.minutes < 20 * 60) { phase = 'afterhours'; note = 'after hours — the regular session has closed'; }
  else { phase = 'closed'; note = 'the market is closed for the day'; }

  const nxt = (phase === 'premarket' || phase === 'overnight')
    ? { y: p.y, m: p.m, d: p.d }
    : nextTradingDay(p.y, p.m, p.d);

  return {
    date: key,
    weekday: DAYS[p.dow],
    pretty: pretty(p.y, p.m, p.d),
    timeET: hhmm(p.minutes),
    phase, note, holiday, earlyClose: early,
    isTradingDay: isTradingDay(p.y, p.m, p.d),
    nextOpen: nxt ? `${pretty(nxt.y, nxt.m, nxt.d)}, 9:30 AM ET` : null,
    minutesToClose: phase === 'open' ? close - p.minutes : null,
  };
}

/**
 * The authoritative NOW block for a model prompt.
 *
 * `lastSessionDate` (YYYY-MM-DD, optional) names the session the dealer map came from. Passing it
 * matters: without it a model looking at Friday's map on a Saturday concludes it is Friday. Naming
 * the gap explicitly is what stops the inference.
 */
function nowBlock(lastSessionDate, surface) {
  const s = marketState();
  const isCrypto = surface === 'crypto';
  const L = [
    'RIGHT NOW (authoritative — this is the current date and time; NEVER infer either from the data below):',
    `  Today is ${s.pretty}.`,
    `  Current time: ${s.timeET} (US Eastern).`,
  ];

  // TWO MARKETS, TWO CLOCKS. This block only ever described the NYSE, so a question asked on the
  // 24/7 crypto dashboard came back with "the market is closed for the weekend ... enjoy the weekend
  // off the screen" while that same page was rendering live funding and $2.9M of liquidations from
  // the last 24 hours. The equity session is still worth naming there — it is often the reason
  // crypto is the only thing printing — but on that surface it is CONTEXT, never the status of the
  // screen the reader is looking at.
  if (isCrypto) {
    L.push('  Crypto status: OPEN. Crypto trades 24/7 — no close, no weekend, no holiday, no session to wait for.',
      '  Never tell a reader on this dashboard that the market is closed, that nothing happens until an open,',
      '  or to step away until Monday. Something is always trading and this map is always live.',
      `  US equity session (CONTEXT ONLY — not the market on this screen): ${s.note}.`);
    if (s.phase !== 'open' && s.nextOpen) L.push(`  US equities next open: ${s.nextOpen}.`);
  } else {
    L.push(`  Market status: ${s.note.charAt(0).toUpperCase() + s.note.slice(1)}.`);
    if (s.phase === 'open' && s.minutesToClose != null) {
      L.push(`  ${Math.floor(s.minutesToClose / 60)}h ${s.minutesToClose % 60}m left in the session.`);
    } else if (s.nextOpen) {
      L.push(`  Next open: ${s.nextOpen}.`);
    }
    L.push('  Crypto trades 24/7 and is open right now regardless of the equity session above.');
  }

  if (lastSessionDate && lastSessionDate !== s.date) {
    L.push(`  The EQUITY dealer map below is from the last completed session (${lastSessionDate}), NOT from today.`,
      '  Do not report that session\'s date as today\'s date.');
  }
  return L.join('\n') + '\n\n';
}

module.exports = { etParts, marketState, nowBlock, holidays, earlyCloses, isTradingDay, nextTradingDay };
