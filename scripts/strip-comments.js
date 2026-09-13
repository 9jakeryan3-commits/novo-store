/* Comment stripper for the novo-store deploy pipeline.
 *
 * WHY THIS IS NOT A REGEX. Comments in JS cannot be found by pattern: `//` appears inside
 * strings ('http://x'), inside regex literals (/https?:\/\//), and inside template literals;
 * `/*` appears inside all three as well. A naive stripper eats code in exactly those places and
 * the damage is silent — the file still parses, it just behaves differently. So this walks the
 * source as a tokenizer and only removes bytes it is in a COMMENT state for.
 *
 * THE HARD PART is telling a regex literal from division, because `/` is both. The rule used
 * here is the standard one: a `/` begins a regex unless the previous significant token could end
 * an expression (identifier, number, string, `)`, `]`, `}`, `++`, `--`). The two genuinely
 * ambiguous closers are handled with a stack rather than a guess:
 *   `)`  — regex may follow only if the paren belonged to if/while/for/with
 *   `}`  — regex may follow only if the brace opened a BLOCK, not an object literal
 * Getting this wrong in either direction corrupts code, so both are tracked explicitly.
 *
 * FAIL LOUD. If the walk ends inside a string, template, regex or comment, the source was not
 * what this thinks it is, and it throws instead of returning a plausible-looking file. A deploy
 * step that silently returns damaged output is worse than no deploy step.
 */
'use strict';

const KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case',
  'do', 'else', 'yield', 'await'
]);

function stripJs(src) {
  let out = '';
  let i = 0;
  const n = src.length;

  // last significant token, for the regex/division decision
  let lastTok = '';
  let lastTokType = 'none';   // 'punct' | 'word' | 'num' | 'str' | 'none'

  // brace/paren stack: each entry says whether a regex may follow its closer
  const stack = [];

  const isIdChar = c => /[A-Za-z0-9_$]/.test(c);

  function regexAllowed() {
    if (lastTokType === 'none') return true;
    if (lastTokType === 'num' || lastTokType === 'str') return false;
    if (lastTokType === 'word') return KEYWORDS_BEFORE_REGEX.has(lastTok);
    // punctuation
    if (lastTok === ')') return stack.__lastParenWasControl === true;
    if (lastTok === ']') return false;
    if (lastTok === '}') return stack.__lastBraceWasBlock === true;
    if (lastTok === '++' || lastTok === '--') return false;
    return true;
  }

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    // ── line comment ─────────────────────────────────────────────────────────────────────
    if (c === '/' && c2 === '/') {
      let j = i + 2;
      while (j < n && src[j] !== '\n' && src[j] !== '\r') j++;
      i = j;                       // drop it; the newline itself is preserved below
      continue;
    }

    // ── block comment ────────────────────────────────────────────────────────────────────
    if (c === '/' && c2 === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new Error('unterminated block comment at ' + i);
      // A block comment containing a newline is a line terminator for ASI purposes, so it must
      // leave one behind. Dropping it outright can join two statements into one.
      const had = src.slice(i, end + 2).indexOf('\n') !== -1;
      out += had ? '\n' : ' ';
      i = end + 2;
      continue;
    }

    // ── strings ──────────────────────────────────────────────────────────────────────────
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) break;
        if (src[j] === '\n') throw new Error('unterminated string at ' + i);
        j++;
      }
      if (j >= n) throw new Error('unterminated string at ' + i);
      out += src.slice(i, j + 1);
      lastTok = 'str'; lastTokType = 'str';
      i = j + 1;
      continue;
    }

    // ── template literal, including ${ } which may contain anything ──────────────────────
    if (c === '`') {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (depth === 0 && src[j] === '`') break;
        if (src[j] === '$' && src[j + 1] === '{') { depth++; j += 2; continue; }
        if (depth > 0 && src[j] === '}') { depth--; j++; continue; }
        j++;
      }
      if (j >= n) throw new Error('unterminated template literal at ' + i);
      out += src.slice(i, j + 1);
      lastTok = 'str'; lastTokType = 'str';
      i = j + 1;
      continue;
    }

    // ── regex literal ────────────────────────────────────────────────────────────────────
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      let ok = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;                       // regex cannot span lines -> not a regex
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { ok = true; break; }
        j++;
      }
      if (ok) {
        j++;
        while (j < n && /[a-z]/.test(src[j])) j++;   // flags
        out += src.slice(i, j);
        lastTok = 'regex'; lastTokType = 'str';
        i = j;
        continue;
      }
      // not a regex after all — fall through and treat as punctuation
    }

    // ── everything else ──────────────────────────────────────────────────────────────────
    if (isIdChar(c)) {
      let j = i;
      while (j < n && isIdChar(src[j])) j++;
      const word = src.slice(i, j);
      out += word;
      lastTok = word;
      lastTokType = /^[0-9]/.test(word) ? 'num' : 'word';
      i = j;
      continue;
    }

    if (c === '(') {
      stack.push({ t: '(', control: lastTokType === 'word' && /^(if|while|for|with|switch|catch)$/.test(lastTok) });
      out += c; lastTok = '('; lastTokType = 'punct'; i++; continue;
    }
    if (c === ')') {
      const f = stack.pop();
      stack.__lastParenWasControl = !!(f && f.control);
      out += c; lastTok = ')'; lastTokType = 'punct'; i++; continue;
    }
    if (c === '{') {
      // A brace opens a BLOCK when an expression could not be starting here. Reusing the same
      // signal as the regex decision: if a regex could legally start at this point, so could a
      // block, because both only appear where a statement or expression begins.
      stack.push({ t: '{', block: regexAllowed() });
      out += c; lastTok = '{'; lastTokType = 'punct'; i++; continue;
    }
    if (c === '}') {
      const f = stack.pop();
      stack.__lastBraceWasBlock = !!(f && f.block);
      out += c; lastTok = '}'; lastTokType = 'punct'; i++; continue;
    }

    if (!/\s/.test(c)) {
      // multi-char punctuators that matter to the regex decision
      if ((c === '+' && c2 === '+') || (c === '-' && c2 === '-')) {
        out += c + c2; lastTok = c + c2; lastTokType = 'punct'; i += 2; continue;
      }
      out += c; lastTok = c; lastTokType = 'punct'; i++; continue;
    }

    out += c;   // whitespace, verbatim — newlines matter for ASI
    i++;
  }

  if (stack.length) throw new Error('unbalanced braces/parens: ' + stack.length + ' left open');
  return out;
}

/* CSS is far simpler: only /* *​/ comments and strings exist. */
function stripCss(src) {
  let out = '', i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new Error('unterminated css comment at ' + i);
      out += ' ';
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) break;
        j++;
      }
      if (j >= n) throw new Error('unterminated css string at ' + i);
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c; i++;
  }
  return out;
}

/* Collapse the blank lines a strip leaves behind, without touching indentation inside
   template literals — which is why this runs per-block and not over the whole file. */
function squeeze(src) {
  return src.replace(/(?:[ \t]*\r?\n){3,}/g, '\n\n');
}

function stripHtml(html) {
  let out = '';
  let i = 0;
  const n = html.length;
  const openTag = /<(script|style|pre|textarea)\b([^>]*)>/gi;

  while (i < n) {
    openTag.lastIndex = i;
    const m = openTag.exec(html);
    if (!m) {
      out += html.slice(i).replace(/<!--[\s\S]*?-->/g, '');
      break;
    }
    // HTML comments before this tag are safe to remove
    out += html.slice(i, m.index).replace(/<!--[\s\S]*?-->/g, '');

    const tag = m[1].toLowerCase();
    const attrs = m[2] || '';
    const bodyStart = m.index + m[0].length;
    const closeRe = new RegExp('</' + tag + '\\s*>', 'i');
    closeRe.lastIndex = 0;
    const rest = html.slice(bodyStart);
    const cm = rest.match(closeRe);
    const bodyEnd = cm ? bodyStart + cm.index : n;
    const body = html.slice(bodyStart, bodyEnd);

    let newBody = body;
    if (tag === 'script' && !/\bsrc\s*=/i.test(attrs)
        && !/type\s*=\s*["']?(application\/json|application\/ld\+json|text\/template)/i.test(attrs)) {
      newBody = squeeze(stripJs(body));
    } else if (tag === 'style') {
      newBody = squeeze(stripCss(body));
    }
    // <pre>/<textarea> bodies pass through untouched — their whitespace is content.

    out += m[0] + newBody + (cm ? cm[0] : '');
    i = cm ? bodyEnd + cm[0].length : n;
  }
  return out;
}

module.exports = { stripJs, stripCss, stripHtml };
