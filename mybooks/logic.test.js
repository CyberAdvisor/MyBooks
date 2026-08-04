/**
 * logic.test.js
 * Plain Node unit tests for the pure, DOM/fetch-free modules: logic.js,
 * csv.js, rating.js, and the parsing/selection functions in api.js (the
 * functions in api.js that hit the network are exercised separately, as
 * part of the user flows in app.test.js, with fetch mocked out).
 *
 * Run with: node logic.test.js
 * No dependencies required - these modules only touch plain JS objects.
 */
const assert = require('assert');
const logic = require('./js/logic.js');
const csv = require('./js/csv.js');
const rating = require('./js/rating.js');
const api = require('./js/api.js');

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    fn();
    pass++;
    console.log('PASS -', label);
  } catch (e) {
    fail++;
    console.log('FAIL -', label);
    console.log('      ', e.message);
  }
}

// ---------- logic.js ----------

test('filterBooks: empty query returns everything unchanged', () => {
  const books = [{ title: 'A' }, { title: 'B' }];
  assert.deepStrictEqual(logic.filterBooks(books, ''), books);
  assert.deepStrictEqual(logic.filterBooks(books, '   '), books);
});

test('filterBooks: matches title, author, or category, case-insensitively', () => {
  const books = [
    { title: 'Dune', author: 'Frank Herbert', category: 'Science Fiction' },
    { title: 'Emma', author: 'Jane Austen', category: 'Fiction' },
  ];
  assert.strictEqual(logic.filterBooks(books, 'dune').length, 1);
  assert.strictEqual(logic.filterBooks(books, 'AUSTEN').length, 1);
  assert.strictEqual(logic.filterBooks(books, 'fiction').length, 2); // substring match on both categories
  assert.strictEqual(logic.filterBooks(books, 'nonexistent').length, 0);
});

test('groupBooksByStatus: includes every status even with zero books, sorted alphabetically within each', () => {
  const books = [
    { title: 'Zebra', status: 'Reading' },
    { title: 'Apple', status: 'Reading' },
  ];
  const grouped = logic.groupBooksByStatus(books);
  assert.deepStrictEqual(grouped.map((g) => g.status), logic.STATUS_ORDER);
  const reading = grouped.find((g) => g.status === 'Reading');
  assert.deepStrictEqual(reading.books.map((b) => b.title), ['Apple', 'Zebra']);
  assert.strictEqual(grouped.find((g) => g.status === 'Shelved').books.length, 0);
});

test('groupBooksByStatus: an unrecognized status falls back to "To Read"', () => {
  const grouped = logic.groupBooksByStatus([{ title: 'X', status: 'Not A Real Status' }]);
  assert.strictEqual(grouped.find((g) => g.status === 'To Read').books.length, 1);
});

test('buildAuthorsIndex: groups by first letter, excludes blank authors, counts correctly', () => {
  const books = [
    { author: 'Isaac Asimov' }, { author: 'Isaac Asimov' },
    { author: 'Ann Leckie' }, { author: '' }, { author: '  ' },
  ];
  const groups = logic.buildAuthorsIndex(books);
  assert.deepStrictEqual(groups.map((g) => g.letter), ['A', 'I']);
  assert.deepStrictEqual(groups.find((g) => g.letter === 'A').authors, [{ name: 'Ann Leckie', count: 1 }]);
  assert.deepStrictEqual(groups.find((g) => g.letter === 'I').authors, [{ name: 'Isaac Asimov', count: 2 }]);
});

test('buildCategoriesIndex: fixed list order preserved, zero-count categories included, Uncategorized appended last', () => {
  const books = [
    { title: 'B1', category: 'Fiction' }, { title: 'B2', category: 'Fiction' },
    { title: 'B3', category: '' }, { title: 'B4' }, { title: 'B5', category: 'Science Fiction' },
  ];
  const list = ['Fiction', 'Non-Fiction', 'Science Fiction'];
  const index = logic.buildCategoriesIndex(books, list);
  assert.deepStrictEqual(index.map((c) => c.name), ['Fiction', 'Non-Fiction', 'Science Fiction', 'Uncategorized']);
  assert.strictEqual(index.find((c) => c.name === 'Fiction').count, 2);
  assert.strictEqual(index.find((c) => c.name === 'Non-Fiction').count, 0);
  assert.strictEqual(index.find((c) => c.name === 'Uncategorized').count, 2);
});

test('buildSeriesIndex: groups by first letter, excludes blank series, counts correctly', () => {
  const books = [
    { series: 'The Culture', author: 'Iain M. Banks' }, { series: 'The Culture', author: 'Iain M. Banks' },
    { series: 'Dune', author: 'Frank Herbert' }, { series: '' }, {},
  ];
  const groups = logic.buildSeriesIndex(books);
  assert.deepStrictEqual(groups.map((g) => g.letter), ['D', 'T']);
  assert.deepStrictEqual(groups.find((g) => g.letter === 'D').series, [{ name: 'Dune', count: 1, author: 'Frank Herbert' }]);
  assert.deepStrictEqual(groups.find((g) => g.letter === 'T').series, [{ name: 'The Culture', count: 2, author: 'Iain M. Banks' }]);
});

test('buildSeriesIndex: author is the most common author for that series; blank when none of its books have one', () => {
  const books = [
    { series: 'Mixed', author: 'Real Author' },
    { series: 'Mixed', author: 'Real Author' },
    { series: 'Mixed', author: 'Ghostwriter' },
    { series: 'No Author Set' },
  ];
  const groups = logic.buildSeriesIndex(books);
  const flat = groups.flatMap((g) => g.series);
  assert.strictEqual(flat.find((s) => s.name === 'Mixed').author, 'Real Author', 'more books credit Real Author, so that wins over Ghostwriter');
  assert.strictEqual(flat.find((s) => s.name === 'No Author Set').author, '');
});

test('booksBySeries: exact trimmed match, sorted by series number (numbered before unnumbered), then title', () => {
  const books = [
    { title: 'Children of Dune', series: 'Dune', seriesNumber: 3 },
    { title: 'Dune', series: 'Dune', seriesNumber: 1 },
    { title: 'Dune Messiah', series: 'Dune', seriesNumber: 2 },
    { title: 'A Dune Companion', series: 'Dune', seriesNumber: null },
    { title: 'Other Series Book', series: 'Foundation', seriesNumber: 1 },
  ];
  const result = logic.booksBySeries(books, 'Dune');
  assert.deepStrictEqual(result.map((b) => b.title), ['Dune', 'Dune Messiah', 'Children of Dune', 'A Dune Companion']);
});

test('booksByAuthor: exact trimmed match, sorted by title', () => {
  const books = [
    { title: 'Zebra', author: 'Ann Leckie' },
    { title: 'Apple', author: ' Ann Leckie ' },
    { title: 'Other', author: 'Someone Else' },
  ];
  const result = logic.booksByAuthor(books, 'Ann Leckie');
  assert.deepStrictEqual(result.map((b) => b.title), ['Apple', 'Zebra']);
});

test('booksByCategory: normal category is an exact match', () => {
  const books = [{ title: 'A', category: 'Fiction' }, { title: 'B', category: 'Non-Fiction' }];
  assert.deepStrictEqual(logic.booksByCategory(books, 'Fiction').map((b) => b.title), ['A']);
});

test('booksByCategory: "Uncategorized" is a virtual bucket, not a literal string match', () => {
  const books = [
    { title: 'Zebra', category: '' },
    { title: 'Apple' }, // no category key at all
    { title: 'Has one', category: 'Fiction' },
  ];
  const result = logic.booksByCategory(books, 'Uncategorized');
  assert.deepStrictEqual(result.map((b) => b.title), ['Apple', 'Zebra']);
});

test('getStatusQuickAction: Reading advances to Read, To Read advances to Reading, Waiting advances to To Read', () => {
  assert.deepStrictEqual(logic.getStatusQuickAction('Reading'), { label: 'Mark Read', nextStatus: 'Read' });
  assert.deepStrictEqual(logic.getStatusQuickAction('To Read'), { label: 'Read Now', nextStatus: 'Reading' });
  assert.deepStrictEqual(logic.getStatusQuickAction('Waiting'), { label: 'To Read', nextStatus: 'To Read' });
});

test('getStatusQuickAction: Read, Wanted, Shelved, and unrecognized statuses get no quick action', () => {
  assert.strictEqual(logic.getStatusQuickAction('Read'), null);
  assert.strictEqual(logic.getStatusQuickAction('Wanted'), null);
  assert.strictEqual(logic.getStatusQuickAction('Shelved'), null);
  assert.strictEqual(logic.getStatusQuickAction('Not A Real Status'), null);
});

test('STATUS_ORDER: Wanted sits directly above Shelved, at the end of the list', () => {
  assert.deepStrictEqual(logic.STATUS_ORDER, ['Reading', 'To Read', 'Waiting', 'Read', 'Wanted', 'Shelved']);
});

// ---------- csv.js ----------

test('csv: round-trips a book through booksToCsv -> csvToBooks', () => {
  const original = [{
    title: 'Dune', author: 'Frank Herbert', status: 'Read',
    synopsis: 'A desert, a prophecy, and House Atreides.',
    source: ['Kindle', 'Personal'], category: 'Science Fiction',
    series: 'Dune', seriesNumber: 1, rating: 5, notes: 'Reread often.',
  }];
  const roundTripped = csv.csvToBooks(csv.booksToCsv(original));
  assert.strictEqual(roundTripped.length, 1);
  assert.strictEqual(roundTripped[0].title, 'Dune');
  assert.deepStrictEqual(roundTripped[0].source, ['Kindle', 'Personal']);
  assert.strictEqual(roundTripped[0].seriesNumber, 1);
  assert.strictEqual(roundTripped[0].rating, 5);
});

test('csv: fields with commas, quotes, and semicolons in source are handled', () => {
  const original = [{
    title: 'Thinking, Fast and Slow', author: 'Daniel "The Nobel Laureate" Kahneman',
    status: 'To Read', synopsis: '', source: ['Library'], category: '', series: '', seriesNumber: null, rating: null, notes: '',
  }];
  const csvText = csv.booksToCsv(original);
  const roundTripped = csv.csvToBooks(csvText);
  assert.strictEqual(roundTripped[0].title, 'Thinking, Fast and Slow');
  assert.strictEqual(roundTripped[0].author, 'Daniel "The Nobel Laureate" Kahneman');
});

test('csv: missing optional columns default sensibly', () => {
  const [book] = csv.csvToBooks('title,author\nEmma,Jane Austen');
  assert.strictEqual(book.status, 'To Read');
  assert.deepStrictEqual(book.source, []);
  assert.strictEqual(book.seriesNumber, null);
  assert.strictEqual(book.rating, null);
});

// ---------- rating.js ----------

test('rating: color tiers are 1-2 red, 3 yellow, 4-5 green, none for falsy', () => {
  assert.strictEqual(rating.getRatingColorClass(1), 'stars-red');
  assert.strictEqual(rating.getRatingColorClass(2), 'stars-red');
  assert.strictEqual(rating.getRatingColorClass(3), 'stars-yellow');
  assert.strictEqual(rating.getRatingColorClass(4), 'stars-green');
  assert.strictEqual(rating.getRatingColorClass(5), 'stars-green');
  assert.strictEqual(rating.getRatingColorClass(0), '');
  assert.strictEqual(rating.getRatingColorClass(null), '');
});

test('rating: normalizeRating clamps to [1,5] and rounds, or returns null', () => {
  assert.strictEqual(rating.normalizeRating(3.6), 4);
  assert.strictEqual(rating.normalizeRating(-2), 1);
  assert.strictEqual(rating.normalizeRating(9), 5);
  assert.strictEqual(rating.normalizeRating(''), null);
  assert.strictEqual(rating.normalizeRating(null), null);
  assert.strictEqual(rating.normalizeRating('not a number'), null);
});

test('rating: buildStarsHtml renders filled/empty stars and empty string for no rating', () => {
  assert.strictEqual(rating.buildStarsHtml(0), '');
  const html = rating.buildStarsHtml(3);
  assert.ok(html.includes('stars-yellow'));
  assert.strictEqual((html.match(/★/g) || []).length, 3); // 3 filled stars
  assert.strictEqual((html.match(/☆/g) || []).length, 2); // 2 empty stars
});

// ---------- api.js (pure parsing/selection only - no network) ----------

test('api: chooseCoverUrl prefers ebook over print, falls back to any candidate', () => {
  assert.strictEqual(api.chooseCoverUrl([]), '');
  assert.strictEqual(api.chooseCoverUrl([{ url: 'print.jpg', format: 'print' }, { url: 'ebook.jpg', format: 'ebook' }]), 'ebook.jpg');
  assert.strictEqual(api.chooseCoverUrl([{ url: 'print.jpg', format: 'print' }]), 'print.jpg');
  assert.strictEqual(api.chooseCoverUrl([{ url: 'other.jpg', format: 'weird' }]), 'other.jpg');
});

test('api: parseOpenLibraryResults normalizes docs into match candidates, capped at 8', () => {
  const docs = Array.from({ length: 10 }, (_, i) => ({
    title: `Book ${i}`, author_name: ['Author One', 'Author Two'], cover_i: i + 1, subject: ['Sci-Fi'],
  }));
  const results = api.parseOpenLibraryResults(docs);
  assert.strictEqual(results.length, 8);
  assert.strictEqual(results[0].source, 'openlibrary');
  assert.strictEqual(results[0].author, 'Author One, Author Two');
  assert.strictEqual(results[0].category, 'Sci-Fi');
  assert.ok(results[0].coverUrl.includes('covers.openlibrary.org'));
});

test('api: isProbablyEnglish distinguishes English text from non-English/gibberish', () => {
  assert.strictEqual(api.isProbablyEnglish('The quick brown fox and the lazy dog were friends.'), true);
  assert.strictEqual(api.isProbablyEnglish('Der schnelle braune Fuchs sprang.'), false);
  assert.strictEqual(api.isProbablyEnglish(''), false);
  assert.strictEqual(api.isProbablyEnglish('xyz'), false); // too few words
});

test('api: fillEmptyFields only fills currently-empty fields, never overwrites', () => {
  const existing = { synopsis: 'Already has one', category: '', coverUrl: null };
  const candidate = { synopsis: 'New synopsis', category: 'Fantasy', coverUrl: 'cover.jpg' };
  const changes = api.fillEmptyFields(existing, candidate);
  assert.deepStrictEqual(changes, { category: 'Fantasy', coverUrl: 'cover.jpg' });
  assert.strictEqual(changes.synopsis, undefined); // existing synopsis preserved
});

test('api: extractDescription handles both string and {value} shapes', () => {
  assert.strictEqual(api.extractDescription({ description: 'plain string' }), 'plain string');
  assert.strictEqual(api.extractDescription({ description: { value: 'wrapped' } }), 'wrapped');
  assert.strictEqual(api.extractDescription({}), '');
  assert.strictEqual(api.extractDescription(null), '');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
