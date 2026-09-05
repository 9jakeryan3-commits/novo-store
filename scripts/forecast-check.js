#!/usr/bin/env node
// scripts/forecast-check.js — the forecast contract's sabotage suite: calendar + anchors + validation.
// forecast.js is the ONE source both ledger doors import; this suite is what keeps it honest.
// Includes the real case that forced v2 (Labor Day weekend -> Tuesday) and a DST boundary.
const F = require('../api/_lib/forecast.js');
let f = 0; const t = (l, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) { f++; console.log('FAIL', l, '->', g, 'want', w); } else console.log('ok  ', l); };

const sat = Date.UTC(2026, 8, 5, 20, 0); // Sat Sep 5 2026, 16:00 EDT — Labor Day weekend
t('Labor Day weekend -> Tuesday open', F.nextSessionOpen(sat), Date.UTC(2026, 8, 8, 13, 30));
t('Sunday night -> Tuesday open', F.nextSessionOpen(Date.UTC(2026, 8, 7, 2, 0)), Date.UTC(2026, 8, 8, 13, 30));
t('mid-session -> next day open', F.nextSessionOpen(Date.UTC(2026, 8, 8, 15, 0)), Date.UTC(2026, 8, 9, 13, 30));
t('pre-open -> same-day open', F.nextSessionOpen(Date.UTC(2026, 8, 8, 12, 0)), Date.UTC(2026, 8, 8, 13, 30));
t('at the open exactly -> next day', F.nextSessionOpen(Date.UTC(2026, 8, 8, 13, 30)), Date.UTC(2026, 8, 9, 13, 30));
t('DST-end weekend -> Monday EST open', F.nextSessionOpen(Date.UTC(2026, 9, 31, 18, 0)), Date.UTC(2026, 10, 2, 14, 30));
t('Thanksgiving skip -> Friday open', F.nextSessionOpen(Date.UTC(2026, 10, 26, 1, 0)), Date.UTC(2026, 10, 27, 14, 30));

const row = F.validateForecast({ claim: 'x', confidence: 65, ticker: 'SPY', metric: 'spot_above', level: 769, horizon_min: 60, anchor: 'next_open' });
t('validate accepts next_open', !!row, true);
row.asked_at = sat;
t('resolveAt = Tue open + 60min', F.resolveAt(row), Date.UTC(2026, 8, 8, 14, 30));
const rowNow = F.validateForecast({ claim: 'x', confidence: 65, ticker: 'SPY', metric: 'spot_above', level: 769, horizon_min: 60 });
rowNow.asked_at = 1000000;
t('anchor default now', rowNow.anchor, 'now');
t('resolveAt now-anchored', F.resolveAt(rowNow), 1000000 + 60 * 60000);
t('next_open horizon 5 ok', !!F.validateForecast({ claim: 'x', confidence: 55, ticker: 'QQQ', metric: 'spot_below', level: 700, horizon_min: 5, anchor: 'next_open' }), true);
t('now horizon 5 rejected', F.validateForecast({ claim: 'x', confidence: 55, ticker: 'QQQ', metric: 'spot_below', level: 700, horizon_min: 5 }), null);
t('bad anchor rejected', F.validateForecast({ claim: 'x', confidence: 55, ticker: 'QQQ', metric: 'spot_below', level: 700, horizon_min: 60, anchor: 'next_close' }), null);
t('multi-day still rejected', F.validateForecast({ claim: 'x', confidence: 65, ticker: 'SPY', metric: 'spot_above', level: 769, horizon_min: 1440, anchor: 'next_open' }), null);

console.log(f ? f + ' FAILURE(S)' : 'forecast v2 suite: ALL PASS (15)');
process.exit(f ? 1 : 0);
