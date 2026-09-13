/* Sabotage tests for the comment stripper.
 *
 * Every case is a place a naive stripper eats code. To prove the tests are not passing
 * vacuously, each one ALSO runs through NAIVE — the obvious regex approach — and the suite
 * reports how many cases naive destroys. A test suite that both implementations pass is not
 * testing anything.
 */
const { stripJs, stripCss, stripHtml } = require('./strip-comments.js');

const NAIVE = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?:^|[^:])\/\/.*$/gm, '');

let pass = 0, fail = 0, naiveBroke = 0;

function t(name, input, mustContain, mustNotContain) {
  let got, err = null;
  try { got = stripJs(input); } catch (e) { err = e; got = '<<THREW: ' + e.message + '>>'; }

  const okKeep = mustContain.every(x => got.includes(x));
  const okDrop = (mustNotContain || []).every(x => !got.includes(x));
  const ok = !err && okKeep && okDrop;

  let nv; try { nv = NAIVE(input); } catch (e) { nv = ''; }
  const naiveOk = mustContain.every(x => nv.includes(x)) && (mustNotContain || []).every(x => !nv.includes(x));
  if (!naiveOk) naiveBroke++;

  if (ok) { pass++; console.log('  ok    ' + name + (naiveOk ? '' : '   [naive stripper FAILS this]')); }
  else {
    fail++;
    console.log('  FAIL  ' + name);
    if (err) console.log('        threw: ' + err.message);
    mustContain.filter(x => !got.includes(x)).forEach(x => console.log('        lost:  ' + JSON.stringify(x)));
    (mustNotContain || []).filter(x => got.includes(x)).forEach(x => console.log('        kept:  ' + JSON.stringify(x)));
    console.log('        got:   ' + JSON.stringify(got.slice(0, 160)));
  }
}

console.log('THE TRAPS OVERWATCH NAMED');
t('template literal containing a block comment',
  'const a = `keep /* not a comment */ this`; /* drop me */ const b = 1;',
  ['`keep /* not a comment */ this`', 'const b = 1;'], ['drop me']);

t('template literal containing a line comment',
  'const u = `https://example.com/path`; // drop\nconst v = 2;',
  ['`https://example.com/path`', 'const v = 2;'], ['// drop']);

t('regex literal containing a double slash',
  'const re = /https?:\\/\\//; // drop\nre.test(x);',
  ['/https?:\\/\\//', 're.test(x);'], ['// drop']);

t('regex literal containing a slash-star',
  'const r2 = /a\\/\\*b/; /* drop */ r2.test(y);',
  ['/a\\/\\*b/', 'r2.test(y);'], ['drop */']);

console.log('\nSTRINGS AND DIVISION');
t('string containing a url',
  "var s = 'http://novo-options.trade/x'; // drop\nuse(s);",
  ["'http://novo-options.trade/x'", 'use(s);'], ['// drop']);

t('division is not a regex',
  'var r = a / b / c; // drop\nuse(r);',
  ['a / b / c'], ['// drop']);

t('division after a closing paren',
  'var r = (a + b) / 2; // drop\nuse(r);',
  ['(a + b) / 2'], ['// drop']);

t('regex after an if-paren',
  'if (x) /ab+c/.test(s); // drop\ndone();',
  ['/ab+c/.test(s);', 'done();'], ['// drop']);

t('regex after return',
  'function f(){ return /x\\/y/; } // drop',
  ['/x\\/y/'], ['// drop']);

console.log('\nNESTING AND EDGE CASES');
t('template with ${} containing a string with a slash',
  'const q = `a${ b["//x"] }c`; /* drop */ end();',
  ['`a${ b["//x"] }c`', 'end();'], ['drop */']);

t('nested template literals',
  'const z = `outer ${ `inner // not a comment` } done`; // drop\nq();',
  ['`inner // not a comment`', 'q();'], ['// drop\n']);

t('comment containing an apostrophe',
  "// don't let this unbalance the quote state\nvar ok = 1;",
  ['var ok = 1;'], ["don't"]);

t('block comment keeps a newline for ASI',
  'var a = 1\n/* multi\nline */\nvar b = 2',
  ['var a = 1', 'var b = 2'], ['multi']);

t('escaped backtick inside template',
  'const e = `a\\`b // still template`; // drop\nz();',
  ['z();'], ['// drop']);

t('regex character class containing a slash',
  'var m = /[/]/; // drop\nuse(m);',
  ['use(m);'], ['// drop']);

console.log('\nCSS');
(function () {
  const css = '.a { color: red; } /* drop */ .b::after { content: "/* not a comment */"; }';
  const got = stripCss(css);
  const ok = got.includes('content: "/* not a comment */"') && !got.includes('drop');
  ok ? (pass++, console.log('  ok    css string containing comment markers'))
     : (fail++, console.log('  FAIL  css string containing comment markers -> ' + got));
})();

console.log('\nHTML WRAPPER');
(function () {
  const html = [
    '<!-- drop this -->',
    '<pre><!-- keep: this is content --></pre>',
    '<script src="x.js"></script>',
    '<script type="application/json">{"a":1}</script>',
    '<script>var a = 1; // drop\nvar b = `//keep`;</script>',
    '<style>.x{color:red} /* drop */</style>'
  ].join('\n');
  const got = stripHtml(html);
  const checks = [
    ['html comment removed', !got.includes('drop this')],
    ['pre content preserved', got.includes('keep: this is content')],
    ['json script untouched', got.includes('{"a":1}')],
    ['js comment removed', !got.includes('// drop')],
    ['template preserved', got.includes('`//keep`')],
    ['css comment removed', !got.includes('/* drop */')]
  ];
  checks.forEach(([n, v]) => v ? (pass++, console.log('  ok    ' + n)) : (fail++, console.log('  FAIL  ' + n)));
})();

console.log('\nFAIL-LOUD');
(function () {
  let threw = false;
  try { stripJs('var a = "unterminated'); } catch (e) { threw = true; }
  threw ? (pass++, console.log('  ok    throws on unterminated string'))
        : (fail++, console.log('  FAIL  returned output for unterminated string'));
  threw = false;
  try { stripJs('/* never closed'); } catch (e) { threw = true; }
  threw ? (pass++, console.log('  ok    throws on unterminated block comment'))
        : (fail++, console.log('  FAIL  returned output for unterminated block comment'));
})();

console.log('\nPOSITIVE CONTROL — it must actually remove something');
(function () {
  const src = 'var a = 1; // gone\n/* also gone */\nvar b = 2;';
  const got = stripJs(src);
  const shrank = got.length < src.length && !got.includes('gone');
  shrank ? (pass++, console.log('  ok    comments are genuinely removed (' + src.length + ' -> ' + got.length + ')'))
         : (fail++, console.log('  FAIL  stripper is a no-op — every test above is vacuous'));
})();

console.log('\n' + '='.repeat(64));
console.log('pass ' + pass + '   fail ' + fail);
console.log('cases the NAIVE regex stripper gets wrong: ' + naiveBroke +
            (naiveBroke ? '   <- the suite discriminates' : '   <- SUITE IS NOT DISCRIMINATING'));
process.exit(fail ? 1 : 0);
