#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------
// Pure-logic regression tests for Scrybox.
//
// app.js is a single, deliberately un-split IIFE that assumes it's
// running in a browser (it touches `document`/`localforage`/`window` as
// soon as it's evaluated), so it can't just be `require()`d in Node.
// Rather than duplicating its logic here (which would silently drift out
// of sync the next time app.js changes), this file reads the REAL
// app.js source text at test time, extracts specific self-contained
// functions/constants by name via brace-matching, and evaluates just
// those in an isolated sandbox. That means these tests always exercise
// the actual current implementation, with zero changes to app.js and
// zero risk to its runtime behavior.
//
// Run with: node tests/pure-logic.test.js
// (No dependencies beyond Node's built-ins + the CSV export test's use
// of PapaParse, which is already a project dependency loaded via CDN in
// the app itself — see the npm install note below if that test fails.)
// ---------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const APP_JS_PATH = path.join(__dirname, '..', 'app.js');
const source = fs.readFileSync(APP_JS_PATH, 'utf8');

// Finds `function <name>(` or `const <name> = ` in the source and returns
// the full declaration text through its natural end. Functions and
// object/array consts end at a matching `}` (found by brace-depth
// counting, safe here since valid JS always balances braces outside of
// string/regex literals, and none of the extracted declarations below
// have literal unbalanced braces in a string). Simpler consts — a regex
// literal, string, or number — have no braces at all, so those are cut
// off at the first top-level semicolon instead.
function extract(name, kind) {
  const anchorRe = kind === 'function'
    ? new RegExp(`(?:^|[^\\w])function\\s+${name}\\s*\\(`)
    : new RegExp(`(?:^|[^\\w])const\\s+${name}\\s*=`);
  const m = anchorRe.exec(source);
  if (!m) throw new Error(`Could not find ${kind} "${name}" in app.js — has it been renamed or removed?`);
  const anchorIdx = m.index + m[0].indexOf(kind === 'function' ? 'function' : 'const');
  const eqIdx = source.indexOf('=', anchorIdx);
  const afterEq = source.slice(eqIdx + 1).search(/\S/) + eqIdx + 1;
  const firstChar = source[afterEq];

  if (kind === 'function' || firstChar === '{') {
    const braceStart = source.indexOf('{', anchorIdx);
    if (braceStart === -1) throw new Error(`Could not find opening brace for ${kind} "${name}"`);
    let depth = 0;
    let i = braceStart;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) { i++; break; }
      }
    }
    let end = i;
    if (kind === 'const' && source[end] === ';') end++;
    return source.slice(anchorIdx, end);
  }

  // Simple const (regex/string/number literal) — no braces, so just cut
  // at the terminating semicolon.
  const semiIdx = source.indexOf(';', anchorIdx);
  if (semiIdx === -1) throw new Error(`Could not find terminating ";" for const "${name}"`);
  return source.slice(anchorIdx, semiIdx + 1);
}

// Build one shared sandbox with every extracted declaration evaluated in
// dependency order (consts before the functions that reference them).
function loadPureScope() {
  const decls = [
    extract('GUILDS', 'const'),
    extract('ALIASES', 'const'),
    extract('WUBRG', 'const'),
    extract('escapeHtml', 'function'),
    extract('tokenize', 'function'),
    extract('stripQuotes', 'function'),
    extract('parseToken', 'function'),
    extract('expandColorValue', 'function'),
    extract('numCompare', 'function'),
    extract('dateCompare', 'function'),
    extract('timestampSlug', 'function'),
    extract('slugify', 'function'),
    extract('normKey', 'function'),
    extract('buildRowGetter', 'function'),
    extract('groupCardsByName', 'function'),
    extract('priceOf', 'function'),
    extract('numericStat', 'function'),
    extract('colorSortKey', 'function'),
    extract('isLegalInFormat', 'function'),
    extract('cardDetailLine', 'function'),
    extract('DECKLIST_SECTION_HEADERS', 'const'),
    extract('parseDecklistText', 'function')
  ];
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(decls.join('\n\n'), sandbox);
  return sandbox;
}

const S = loadPureScope();

// ---------------------------------------------------------------------
// Minimal test runner — no framework, just assert + a pass/fail tally.
// ---------------------------------------------------------------------
let passed = 0;
let failed = 0;

// Values crossing back from the vm sandbox are plain objects/arrays built
// with the sandbox's *own* Array/Object constructors, not this file's —
// so assert.deepStrictEqual's realm-sensitive prototype check fails even
// when the data is identical. Round-tripping through JSON strips that
// realm identity and leaves a plain structural comparison, which is all
// these tests actually care about.
function plain(v) { return JSON.parse(JSON.stringify(v)); }
function deepEqual(actual, expected, msg) { assert.deepStrictEqual(plain(actual), plain(expected), msg); }

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err.message}`);
  }
}

console.log('Scrybox pure-logic tests (live-extracted from app.js)\n');

// --- escapeHtml -------------------------------------------------------
test('escapeHtml escapes all five HTML-significant characters', () => {
  assert.strictEqual(S.escapeHtml(`<script>&"'</script>`), '&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;');
});
test('escapeHtml coerces non-strings', () => {
  assert.strictEqual(S.escapeHtml(5), '5');
});

// --- tokenize / stripQuotes / parseToken -------------------------------
test('tokenize splits on whitespace but keeps quoted phrases together', () => {
  deepEqual(S.tokenize('t:creature o:"draw a card" c:rg'), ['t:creature', 'o:"draw a card"', 'c:rg']);
});
test('stripQuotes removes a single matched pair of surrounding quotes', () => {
  assert.strictEqual(S.stripQuotes('"draw a card"'), 'draw a card');
  assert.strictEqual(S.stripQuotes('noquotes'), 'noquotes');
});
test('parseToken parses field:cmp:value with negation', () => {
  deepEqual(S.parseToken('mv>=4'), { field: 'mv', cmp: '>=', value: '4', negate: false });
  deepEqual(S.parseToken('-t:land'), { field: 't', cmp: ':', value: 'land', negate: true });
});
test('parseToken falls back to a bare name search when there is no operator', () => {
  deepEqual(S.parseToken('"Sol Ring"'), { field: 'name', cmp: ':', value: 'sol ring', negate: false });
});

// --- expandColorValue (depends on GUILDS) ------------------------------
test('expandColorValue expands a known guild name to its color letters', () => {
  deepEqual(S.expandColorValue('azorius').sort(), ['u', 'w']);
});
test('expandColorValue passes through raw color letters, dropping non-color chars', () => {
  deepEqual(S.expandColorValue('wrx'), ['w', 'r']);
});

// --- numCompare / dateCompare -------------------------------------------
test('numCompare handles all five comparison operators', () => {
  assert.strictEqual(S.numCompare(4, '>', 3), true);
  assert.strictEqual(S.numCompare(4, '<', 3), false);
  assert.strictEqual(S.numCompare(4, '>=', 4), true);
  assert.strictEqual(S.numCompare(4, '<=', 3), false);
  assert.strictEqual(S.numCompare(4, ':', 4), true);
});
test('dateCompare works on ISO date strings, including partial-date comparisons', () => {
  assert.strictEqual(S.dateCompare('2020-06-01', '>=', '2020-01-01'), true);
  assert.strictEqual(S.dateCompare('2015-01-01', '<', '2020'), true);
});

// --- timestampSlug / slugify --------------------------------------------
test('timestampSlug produces a sortable, filename-safe YYYY-MM-DD_HHMMSS string', () => {
  const slug = S.timestampSlug();
  assert.match(slug, /^\d{4}-\d{2}-\d{2}_\d{6}$/);
});
test('slugify lowercases, collapses non-alphanumerics to single hyphens, and trims edges', () => {
  assert.strictEqual(S.slugify('Esper Removal!! In My Deck'), 'esper-removal-in-my-deck');
  assert.strictEqual(S.slugify('  --Leading/Trailing--  '), 'leading-trailing');
});
test('slugify respects a max length', () => {
  assert.strictEqual(S.slugify('a'.repeat(50), 10).length, 10);
});

// --- normKey / buildRowGetter / ALIASES (CSV import column matching) ---
test('normKey lowercases and strips non-alphanumerics, matching ManaBox header variants', () => {
  assert.strictEqual(S.normKey('Set Code'), 'setcode');
  assert.strictEqual(S.normKey('Collector Number'), 'collectornumber');
  assert.strictEqual(S.normKey(' Purchase-Price '), 'purchaseprice');
});
test('buildRowGetter resolves every ManaBox export column Scrybox recognizes', () => {
  const sampleRow = {
    'Name': 'Sol Ring', 'Set code': 'CMR', 'Set name': 'Commander Legends',
    'Collector number': '123', 'Foil': 'foil', 'Rarity': 'uncommon', 'Quantity': '2',
    'Scryfall ID': 'abc-123', 'Language': 'en', 'Binder Name': 'My EDH Deck', 'Binder Type': 'deck'
  };
  const get = S.buildRowGetter(sampleRow);
  assert.strictEqual(get(sampleRow, 'name'), 'Sol Ring');
  assert.strictEqual(get(sampleRow, 'setcode'), 'CMR');
  assert.strictEqual(get(sampleRow, 'collector'), '123');
  assert.strictEqual(get(sampleRow, 'scryfallid'), 'abc-123');
  assert.strictEqual(get(sampleRow, 'bindername'), 'My EDH Deck');
  assert.strictEqual(get(sampleRow, 'bindertype'), 'deck');
});
test('buildRowGetter also resolves the CSV export column names Scrybox itself writes (round-trip)', () => {
  // These are the exact headers exportResultsAsManaBoxCsv() writes — this
  // test is the regression guard for "the export format actually
  // re-imports," since it exercises the real column-matching logic rather
  // than a separately maintained assumption about which aliases match.
  const exportedRow = {
    'Name': 'Sol Ring', 'Set code': 'CMR', 'Set name': 'Commander Legends',
    'Collector number': '123', 'Foil': 'normal', 'Rarity': 'uncommon', 'Quantity': 3,
    'ManaBox ID': '', 'Scryfall ID': 'abc-123', 'Purchase price': '', 'Misprint': '',
    'Altered': '', 'Condition': '', 'Language': 'en', 'Purchase price currency': '',
    'Binder Name': 'Scrybox Collection', 'Binder Type': 'binder'
  };
  const get = S.buildRowGetter(exportedRow);
  assert.strictEqual(get(exportedRow, 'name'), 'Sol Ring');
  assert.strictEqual(get(exportedRow, 'quantity'), 3);
  assert.strictEqual(get(exportedRow, 'bindertype'), 'binder');
  // "Binder Type" values Scrybox itself writes must never contain "list" —
  // the importer treats that as a virtual ManaBox List and silently skips
  // the row entirely, which would make round-tripping our own export lossy.
  assert.ok(!String(get(exportedRow, 'bindertype')).toLowerCase().includes('list'));
});

// --- groupCardsByName / priceOf / numericStat / colorSortKey -----------
test('groupCardsByName collapses same-named printings and sums quantities', () => {
  const cards = [
    { name: 'Sol Ring', set_name: 'Commander Legends', qtyFoil: 1, qtyNonfoil: 2 },
    { name: 'Sol Ring', set_name: 'Alpha', qtyFoil: 0, qtyNonfoil: 1 },
    { name: 'Lightning Bolt', set_name: 'Beta', qtyFoil: 0, qtyNonfoil: 4 }
  ];
  const groups = S.groupCardsByName(cards);
  assert.strictEqual(groups.length, 2);
  const solRing = groups.find((g) => g.name === 'Sol Ring');
  assert.strictEqual(solRing.versions.length, 2);
  assert.strictEqual(solRing.totalQtyFoil, 1);
  assert.strictEqual(solRing.totalQtyNonfoil, 3);
});
test('priceOf falls back through usd -> usd_foil -> 0', () => {
  assert.strictEqual(S.priceOf({ prices: { usd: '1.50' } }), 1.5);
  assert.strictEqual(S.priceOf({ prices: { usd_foil: '3.00' } }), 3);
  assert.strictEqual(S.priceOf({ prices: {} }), 0);
});
test('numericStat treats non-numeric power/toughness (*, X, etc.) as lower than any real value', () => {
  assert.strictEqual(S.numericStat('4'), 4);
  assert.strictEqual(S.numericStat('*'), -1);
});
test('colorSortKey orders colorless < mono (WUBRG) < multicolor', () => {
  const colorless = S.colorSortKey({ color_identity: [] });
  const mono = S.colorSortKey({ color_identity: ['R'] });
  const multi = S.colorSortKey({ color_identity: ['R', 'G'] });
  assert.ok(colorless < mono);
  assert.ok(mono < multi);
});

// --- isLegalInFormat -----------------------------------------------------
test('isLegalInFormat treats both "legal" and "restricted" as playable', () => {
  const card = { legalities: { vintage: 'restricted', standard: 'not_legal', modern: 'banned' } };
  assert.strictEqual(S.isLegalInFormat(card, 'vintage'), true);
  assert.strictEqual(S.isLegalInFormat(card, 'standard'), false);
  assert.strictEqual(S.isLegalInFormat(card, 'modern'), false);
});
test('isLegalInFormat is permissive (true) when no format filter is active', () => {
  assert.strictEqual(S.isLegalInFormat({ legalities: {} }, ''), true);
});

// --- cardDetailLine (shared export/AI-prompt line format) ----------------
test('cardDetailLine formats a creature with power/toughness', () => {
  const line = S.cardDetailLine({
    name: 'Grizzly Bears', mana_cost: '{1}{G}', color_identity: ['G'],
    type_line: 'Creature — Bear', power: '2', toughness: '2', oracle_text: ''
  }, 3);
  assert.strictEqual(line, '3x Grizzly Bears | {1}{G} | G | Creature — Bear [2/2] | (no rules text)');
});
test('cardDetailLine formats a planeswalker with loyalty instead of P/T', () => {
  const line = S.cardDetailLine({
    name: 'Test Walker', mana_cost: '{3}{U}', color_identity: ['U'],
    type_line: 'Planeswalker — Test', loyalty: '5', oracle_text: 'Draw a card.\nThen discard.'
  }, 1);
  assert.strictEqual(line, '1x Test Walker | {3}{U} | U | Planeswalker — Test [Loyalty 5] | Draw a card. Then discard.');
});

// --- parseDecklistText (bulk decklist import) -----------------------------
test('parseDecklistText parses quantity-prefixed lines, with or without "x"', () => {
  deepEqual(S.parseDecklistText('1 Sol Ring\n2x Lightning Bolt\nMox Sapphire'), [
    { qty: 1, name: 'Sol Ring' },
    { qty: 2, name: 'Lightning Bolt' },
    { qty: 1, name: 'Mox Sapphire' }
  ]);
});
test('parseDecklistText drops blank lines, "//"/"#" comments, and bare section headers', () => {
  const text = [
    'Commander:', '1 Atraxa, Praetors\' Voice', '', '// Ramp package', '1x Sol Ring',
    '# also a comment', 'Sideboard', '1 Arcane Signet'
  ].join('\n');
  const names = S.parseDecklistText(text).map((e) => e.name);
  deepEqual(names, ['Atraxa, Praetors\' Voice', 'Sol Ring', 'Arcane Signet']);
});
test('parseDecklistText strips a leading "SB:" marker rather than dropping the card', () => {
  deepEqual(S.parseDecklistText('SB: 1 Swords to Plowshares'), [{ qty: 1, name: 'Swords to Plowshares' }]);
});

// ---------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
