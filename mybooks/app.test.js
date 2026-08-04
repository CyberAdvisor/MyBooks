/**
 * app.test.js
 * Integration tests: loads the real index.html into jsdom, wires up an
 * isolated in-memory IndexedDB per test group (fake-indexeddb), stubs
 * network-dependent calls (api.findMatches/enrichMatchSynopsis,
 * resizeImageToDataUrl), and drives the UI the way a user would - clicks,
 * typed input, file/paste events - then asserts on rendered DOM state and
 * what actually landed in the database.
 *
 * Run with: node app.test.js
 * Requires: npm install jsdom fake-indexeddb
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');

const APP_DIR = __dirname;
const HTML = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const JS_FILES = ['js/logic.js', 'js/db.js', 'js/api.js', 'js/csv.js', 'js/rating.js', 'js/app.js'];

let pass = 0, fail = 0;
const failures = [];

/**
 * Builds a fresh app instance: its own jsdom window/document and its own
 * IndexedDB (a brand new IDBFactory per call, not the shared singleton -
 * this is what keeps tests from leaking data into each other). Runs the
 * app's real init() via a DOMContentLoaded dispatch, then waits for the
 * initial async render to settle before handing control back.
 */
async function createApp() {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  window.indexedDB = new IDBFactory();
  window.IDBKeyRange = IDBKeyRange;
  window.fetch = async (url) => { throw new Error('unexpected real fetch: ' + url); };

  for (const file of JS_FILES) {
    window.eval(fs.readFileSync(path.join(APP_DIR, file), 'utf8'));
  }

  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 15));
  return window;
}

async function test(label, fn) {
  try {
    await fn();
    pass++;
    console.log('PASS -', label);
  } catch (e) {
    fail++;
    failures.push(label);
    console.log('FAIL -', label);
    console.log('      ', e.message);
  }
}

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function main() {
// ---------- Add Book: search -> preview -> add/cancel ----------

await test('search renders match candidates and clicking one opens a read-only preview (nothing saved yet)', async () => {
  const window = await createApp();
  const d = window.document;
  window.api.findMatches = async () => ([
    { source: 'openlibrary', title: 'Orphans of the Sky', author: 'Robert A. Heinlein', synopsis: '', category: 'Science Fiction', coverUrl: 'https://covers.example/1.jpg', workKey: '/works/OL1W' },
    { source: 'openlibrary', title: 'Orphans of the Sky (Illustrated)', author: 'Robert A. Heinlein', synopsis: 'Illustrated edition.', category: 'Science Fiction', coverUrl: '', workKey: '/works/OL2W' },
  ]);
  window.api.enrichMatchSynopsis = async (m) => (m.synopsis ? m : Object.assign({}, m, { synopsis: 'Generation-ship classic.' }));

  d.getElementById('tabAdd').click();
  d.getElementById('addSearchTitle').value = 'Orphans of the Sky';
  await window.searchAddMatches();
  await wait();

  const items = d.querySelectorAll('#addMatchResults .match-item');
  assert.strictEqual(items.length, 2);

  items[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait();

  assert.ok(d.getElementById('detailView').classList.contains('active'));
  assert.strictEqual(d.getElementById('previewNavRow').style.display, 'flex');
  assert.strictEqual(d.getElementById('viewNavRow').style.display, 'none');
  assert.strictEqual(d.getElementById('detailNotesGroup').style.display, 'none');
  assert.strictEqual(d.getElementById('detailActionsGroup').style.display, 'none');
  assert.ok(d.getElementById('detailHero').textContent.includes('Orphans of the Sky'));
  assert.ok(d.getElementById('detailSynopsis').textContent.includes('Generation-ship classic'));
  assert.strictEqual((await window.db.getAllBooks()).length, 0);

  d.getElementById('previewBackBtn').click();
  assert.ok(d.getElementById('addView').classList.contains('active'));
  assert.strictEqual((await window.db.getAllBooks()).length, 0);
  assert.strictEqual(d.querySelectorAll('#addMatchResults .match-item').length, 2, 'match list survives cancel');

  d.querySelectorAll('#addMatchResults .match-item')[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait();
  d.getElementById('previewAddBtn').click();
  await wait();

  const allBooks = await window.db.getAllBooks();
  assert.strictEqual(allBooks.length, 1);
  assert.strictEqual(allBooks[0].title, 'Orphans of the Sky');
  assert.strictEqual(allBooks[0].category, 'Science Fiction');
  assert.ok(d.getElementById('listView').classList.contains('active'));
  assert.strictEqual(d.getElementById('addSearchTitle').value, '');
});

await test('"Add Without a Match" goes straight into edit mode with the typed title/author', async () => {
  const window = await createApp();
  const d = window.document;
  d.getElementById('tabAdd').click();
  d.getElementById('addSearchTitle').value = 'My Own Notes';
  d.getElementById('addSearchAuthor').value = 'Me';
  d.getElementById('addBlankBtn').click();
  await wait();

  assert.ok(d.getElementById('detailView').classList.contains('active'));
  assert.strictEqual(d.getElementById('editNavRow').style.display, 'flex');
  assert.strictEqual(d.getElementById('editTitle').value, 'My Own Notes');
  const books = await window.db.getAllBooks();
  assert.strictEqual(books.length, 1);
  assert.strictEqual(books[0].title, 'My Own Notes');
});

// ---------- api.js: search failure handling (network/HTTP errors, distinct from zero results) ----------
//
// searchOpenLibrary() throws on a failed request (network error or non-2xx
// HTTP status) rather than silently resolving to [] - see api.js and the
// comments on searchAddMatches/refreshCurrentBookFromOnline in app.js. A
// real Open Library outage (e.g. HTTP 503) previously looked identical to
// "this book genuinely isn't in their database," which read as the app
// being broken. These tests drive it through the real fetch failure path
// (via window.fetch, not by stubbing api.findMatches like the tests
// above), to verify the actual thrown-error contract, not just that some
// UI code happens to handle a stubbed rejection correctly.

await test('api.searchOpenLibrary throws (not resolves to []) on a non-ok HTTP response', async () => {
  const window = await createApp();
  window.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(() => window.api.searchOpenLibrary('Dune', ''), /503/);
});

await test('api.searchOpenLibrary throws (not resolves to []) on a network/fetch failure', async () => {
  const window = await createApp();
  window.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(() => window.api.searchOpenLibrary('Dune', ''));
});

await test('Add Book search shows a distinct failure message on HTTP 503, not "No matches found"', async () => {
  const window = await createApp();
  const d = window.document;
  window.fetch = async () => ({ ok: false, status: 503 });

  d.getElementById('tabAdd').click();
  d.getElementById('addSearchTitle').value = 'Dune';
  await window.searchAddMatches();
  await wait();

  const text = d.getElementById('addMatchResults').textContent;
  assert.ok(text.includes('503'), 'the HTTP status should surface in the message: ' + text);
  assert.ok(!text.includes('No matches found'), 'a failed search must not read the same as a genuine zero-result search');
});

await test('Refresh from Online Sources shows a distinct alert on search failure, not "No matches found"', async () => {
  const window = await createApp();
  const d = window.document;
  window.fetch = async () => { throw new TypeError('Failed to fetch'); };
  let alertMessage = null;
  window.alert = (msg) => { alertMessage = msg; };

  const id = await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'T', author: 'A' }));
  await window.openDetail(id);
  d.getElementById('refreshOnlineBtn').click();
  await wait();

  assert.ok(alertMessage, 'an alert should have been shown for the failed search');
  assert.ok(!alertMessage.includes('No matches found'), 'a failed search must not read the same as a genuine zero-result search');
  assert.strictEqual(d.getElementById('refreshMatchesNavRow').style.display, 'none', 'the picker should never open on a failed search');
});

// ---------- Edit: full field round trip, including cover paste/upload ----------

await test('editing and saving persists every field, including a pasted cover image', async () => {
  const window = await createApp();
  const d = window.document;
  let resizeCalls = 0;
  window.resizeImageToDataUrl = async () => { resizeCalls++; return `data:image/jpeg;base64,FAKE${resizeCalls}`; };

  const id = await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'Draft', author: 'Someone' }));
  window.addCategoryIfNew('Fantasy'); // categories start empty - seed one so the select below has it as an option
  await window.openDetail(id);
  await window.enterEditMode();
  assert.ok(d.getElementById('editCover').classList.contains('no-cover'));

  d.getElementById('editTitle').value = 'Final Title';
  d.getElementById('editAuthor').value = 'Final Author';
  d.getElementById('editSeries').value = 'A Series';
  d.getElementById('editSeriesNumber').value = '2';
  d.getElementById('editCategory').value = 'Fantasy';
  d.getElementById('editStatus').value = 'Reading';
  d.getElementById('editRating').value = '4';
  d.getElementById('editSynopsis').value = 'A synopsis.';
  d.getElementById('editNotes').value = 'Some notes.';

  const pasteEvent = new window.Event('paste', { bubbles: true, cancelable: true });
  pasteEvent.clipboardData = { items: [{ type: 'image/png', getAsFile: () => new window.File(['x'], 'p.png', { type: 'image/png' }) }] };
  d.getElementById('editCover').dispatchEvent(pasteEvent);
  await wait();
  assert.ok(!d.getElementById('editCover').classList.contains('no-cover'));

  d.getElementById('editDoneBtn').click();
  await wait();

  const saved = await window.db.getBook(id);
  assert.strictEqual(saved.title, 'Final Title');
  assert.strictEqual(saved.author, 'Final Author');
  assert.strictEqual(saved.series, 'A Series');
  assert.strictEqual(saved.seriesNumber, 2);
  assert.strictEqual(saved.category, 'Fantasy');
  assert.strictEqual(saved.status, 'Reading');
  assert.strictEqual(saved.rating, 4);
  assert.strictEqual(saved.synopsis, 'A synopsis.');
  assert.strictEqual(saved.notes, 'Some notes.');
  assert.strictEqual(saved.coverUrl, 'data:image/jpeg;base64,FAKE1');
});

await test('uploading a cover photo via the file input also persists', async () => {
  const window = await createApp();
  const d = window.document;
  window.resizeImageToDataUrl = async () => 'data:image/jpeg;base64,UPLOADED';

  const id = await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'T', author: 'A' }));
  await window.openDetail(id);
  await window.enterEditMode();

  const file = new window.File(['bytes'], 'cover.jpg', { type: 'image/jpeg' });
  Object.defineProperty(d.getElementById('editCoverFileInput'), 'files', { value: [file], configurable: true });
  d.getElementById('editCoverFileInput').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait();

  d.getElementById('editDoneBtn').click();
  await wait();
  assert.strictEqual((await window.db.getBook(id)).coverUrl, 'data:image/jpeg;base64,UPLOADED');
});

await test('pasting non-image clipboard content is a no-op', async () => {
  const window = await createApp();
  const d = window.document;
  let resizeCalls = 0;
  window.resizeImageToDataUrl = async () => { resizeCalls++; return 'data:x'; };

  const id = await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'T', author: 'A' }));
  await window.openDetail(id);
  await window.enterEditMode();

  const evt = new window.Event('paste', { bubbles: true, cancelable: true });
  evt.clipboardData = { items: [{ type: 'text/plain', getAsFile: () => null }] };
  d.getElementById('editCover').dispatchEvent(evt);
  await wait();

  assert.strictEqual(resizeCalls, 0);
  assert.ok(d.getElementById('editCover').classList.contains('no-cover'));
});

// ---------- Source picker: inline dropdown, not a native prompt() ----------

await test('Source "+ Add" opens an inline menu of remaining options; picking one adds it and closes the menu', async () => {
  const window = await createApp();
  const d = window.document;
  const id = await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'T', author: 'A', source: ['Kindle'] }));
  await window.openDetail(id);
  await window.enterEditMode();

  const chips = d.getElementById('editSourceChips');
  const addChip = chips.querySelector('.chip.add-chip');
  assert.ok(addChip, '"+ Add" chip should be present while any SOURCE_OPTIONS remain unpicked');
  assert.strictEqual(chips.querySelector('.source-menu'), null, 'menu should not be open yet');

  addChip.dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait();
  const menu = chips.querySelector('.source-menu');
  assert.ok(menu, 'clicking + Add should open the inline menu');
  const items = Array.from(menu.querySelectorAll('.source-menu-item')).map((i) => i.textContent);
  assert.deepStrictEqual(items, ['Library', 'Kobo', 'Personal'], 'menu should list exactly the sources not already picked, in SOURCE_OPTIONS order');

  menu.querySelector('.source-menu-item').dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait();
  assert.strictEqual(chips.querySelector('.source-menu'), null, 'menu should close itself after a pick');
  assert.ok(Array.from(chips.querySelectorAll('.chip.removable')).some((c) => c.textContent.includes('Library')), 'Library should now show as a removable chip');

  d.getElementById('editDoneBtn').click();
  await wait();
  assert.deepStrictEqual((await window.db.getBook(id)).source, ['Kindle', 'Library']);
});

await test('Source menu closes without adding anything when clicking outside it', async () => {
  const window = await createApp();
  const d = window.document;
  const id = await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'T', author: 'A' }));
  await window.openDetail(id);
  await window.enterEditMode();

  d.getElementById('editSourceChips').querySelector('.chip.add-chip').dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait();
  assert.ok(d.getElementById('editSourceChips').querySelector('.source-menu'), 'menu should be open');

  d.body.dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait();
  assert.strictEqual(d.getElementById('editSourceChips').querySelector('.source-menu'), null, 'clicking outside the menu should close it');

  d.getElementById('editDoneBtn').click();
  await wait();
  assert.deepStrictEqual((await window.db.getBook(id)).source, [], 'nothing should have been added');
});

await test('Source "+ Add" chip disappears once every option has been picked', async () => {
  const window = await createApp();
  const d = window.document;
  const id = await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'T', author: 'A', source: ['Library', 'Kobo', 'Kindle', 'Personal'] }));
  await window.openDetail(id);
  await window.enterEditMode();
  assert.strictEqual(d.getElementById('editSourceChips').querySelector('.chip.add-chip'), null, 'no options left to add, so the chip itself should be omitted');
});

await test('Cancel discards unsaved edits', async () => {
  const window = await createApp();
  const d = window.document;
  const id = await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'Original', author: 'A' }));
  await window.openDetail(id);
  await window.enterEditMode();
  d.getElementById('editTitle').value = 'Changed but not saved';
  d.getElementById('editCancelBtn').click();
  await wait();
  assert.strictEqual((await window.db.getBook(id)).title, 'Original');
  assert.strictEqual(d.getElementById('viewNavRow').style.display, 'flex');
});

// ---------- Detail actions: mark read, delete ----------

await test('Mark as Read updates status and re-renders the detail view', async () => {
  const window = await createApp();
  const d = window.document;
  const id = await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'T', author: 'A', status: 'To Read' }));
  await window.openDetail(id);
  d.getElementById('markReadBtn').click();
  await wait();
  assert.strictEqual((await window.db.getBook(id)).status, 'Read');
  assert.ok(d.getElementById('detailFields').textContent.includes('Read'));
});

await test('Delete Book removes the record and returns to the Library', async () => {
  const window = await createApp();
  const d = window.document;
  window.confirm = () => true; // simulate the user accepting the confirm() dialog
  const id = await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'T', author: 'A' }));
  await window.openDetail(id);
  d.getElementById('deleteBookBtn').click();
  await wait();
  assert.strictEqual(await window.db.getBook(id), null);
  assert.ok(d.getElementById('listView').classList.contains('active'));
});

// ---------- Library: status grouping, search, Authors/Categories drilldown (incl. Uncategorized) ----------

await test('search filters the Status list live as you type', async () => {
  const window = await createApp();
  const d = window.document;
  await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'Dune', author: 'Frank Herbert' }));
  await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'Emma', author: 'Jane Austen' }));
  await window.renderListView();

  d.getElementById('searchInput').value = 'dune';
  d.getElementById('searchInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait();

  assert.ok(d.getElementById('listContent').textContent.includes('Dune'));
  assert.ok(!d.getElementById('listContent').textContent.includes('Emma'));
});

await test('Book list rows show source as a 4th line only when the book has one', async () => {
  const window = await createApp();
  const d = window.document;
  const withSourceId = await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'Dune', author: 'Frank Herbert', source: ['Kindle', 'Personal'] }));
  const withoutSourceId = await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'Emma', author: 'Jane Austen' }));
  await window.renderListView();

  const rowFor = (id) => d.querySelector(`.row[data-book-id="${id}"]`);
  const sourceLine = rowFor(withSourceId).querySelector('.row-source');
  assert.ok(sourceLine, 'row should have a .row-source line when the book has a source');
  assert.strictEqual(sourceLine.textContent, 'Kindle, Personal');

  assert.strictEqual(rowFor(withoutSourceId).querySelector('.row-source'), null, 'no .row-source element at all when the book has no source');
});

await test('Categories view includes an Uncategorized bucket and drilling into it works', async () => {
  const window = await createApp();
  const d = window.document;
  await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'Has Category', author: 'A', category: 'Fiction' }));
  await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'No Category', author: 'B' }));

  d.getElementById('tabLibrary').click();
  d.querySelector('#librarySegmented .segment[data-mode="categories"]').click();
  await wait();

  const uncategorizedRow = Array.from(d.querySelectorAll('#listContent .row')).find((r) => r.dataset.indexValue === 'Uncategorized');
  assert.ok(uncategorizedRow, 'Uncategorized row should be present in the Categories list');

  uncategorizedRow.dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait();
  assert.ok(d.getElementById('listContent').textContent.includes('No Category'));
  assert.ok(!d.getElementById('listContent').textContent.includes('Has Category'));
});

await test('Series index groups by first letter, drilling in orders by series number, and the back button returns to Series', async () => {
  const window = await createApp();
  const d = window.document;
  await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'Dune Messiah', author: 'Frank Herbert', series: 'Dune', seriesNumber: 2 }));
  await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'Dune', author: 'Frank Herbert', series: 'Dune', seriesNumber: 1 }));
  await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'Standalone', author: 'Someone Else' })); // no series - shouldn't appear in this view at all

  d.getElementById('tabLibrary').click();
  d.querySelector('#librarySegmented .segment[data-mode="series"]').click();
  await wait();

  const seriesRow = Array.from(d.querySelectorAll('#listContent .row')).find((r) => r.dataset.indexValue === 'Dune');
  assert.ok(seriesRow, 'Dune should appear as a series in the index');
  assert.strictEqual(d.querySelectorAll('#listContent .row').length, 1, 'Standalone has no series, so it should not add a second index row');

  seriesRow.dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait();
  const titles = Array.from(d.querySelectorAll('#listContent .row-title')).map((el) => el.textContent);
  assert.deepStrictEqual(titles, ['Dune', 'Dune Messiah'], 'drilldown should list books in series-number order, not alphabetical');

  d.getElementById('libraryDrilldownBackBtn').click();
  await wait();
  assert.ok(d.querySelector('#librarySegmented .segment[data-mode="series"]').classList.contains('active'), 'back button should return to the Series index specifically, not Authors/Categories');
});

// ---------- CSV import ----------

await test('CSV import adds new books and skips duplicate title+author pairs', async () => {
  const window = await createApp();
  const d = window.document;
  await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'Dune', author: 'Frank Herbert' }));

  const csvText = 'title,author,status\nDune,Frank Herbert,Read\nFoundation,Isaac Asimov,To Read';
  const fakeFile = { text: async () => csvText };
  await window.handleCsvImport({ target: { files: [fakeFile], value: 'x' } });
  await wait();

  const books = await window.db.getAllBooks();
  assert.strictEqual(books.length, 2, 'Dune should be skipped as a duplicate, Foundation added');
  assert.ok(d.getElementById('importRecap').textContent.includes('1 book(s) added'));
  assert.ok(d.getElementById('importRecap').textContent.includes('skipped'));
});

// ---------- Category list: starts empty, grows from import and from editing ----------

await test('categories start empty, and CSV import folds new category values into the list', async () => {
  const window = await createApp();
  assert.deepStrictEqual(Array.from(window.getCategoryList()), [], 'category list should start empty');

  const csvText = "title,author,category\nDune,Frank Herbert,Science Fiction\nEmma,Jane Austen,Fiction\nUntitled,Nobody,";
  const fakeFile = { text: async () => csvText };
  await window.handleCsvImport({ target: { files: [fakeFile], value: 'x' } });
  await wait();

  assert.deepStrictEqual(Array.from(window.getCategoryList()), ['Fiction', 'Science Fiction'], 'both non-blank categories added, alphabetically, blank ignored');
});

await test('CSV import reuses an existing category case-insensitively instead of adding a duplicate', async () => {
  const window = await createApp();
  window.addCategoryIfNew('Fiction');

  const csvText = 'title,author,category\nEmma,Jane Austen,fiction';
  const fakeFile = { text: async () => csvText };
  await window.handleCsvImport({ target: { files: [fakeFile], value: 'x' } });
  await wait();

  assert.deepStrictEqual(Array.from(window.getCategoryList()), ['Fiction'], 'differently-cased match should not create a second entry');
});

await test('Edit screen: "+ Add new category..." prompts, adds the category, and selects it', async () => {
  const window = await createApp();
  const d = window.document;
  const id = await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'Draft', author: 'Someone' }));
  await window.openDetail(id);
  await window.enterEditMode();

  window.prompt = () => 'Poetry';
  const select = d.getElementById('editCategory');
  select.value = '__add_new_category__' /* must match ADD_NEW_CATEGORY_VALUE in app.js */;
  select.dispatchEvent(new window.Event('change', { bubbles: true }));

  assert.deepStrictEqual(Array.from(window.getCategoryList()), ['Poetry']);
  assert.strictEqual(select.value, 'Poetry', 'the newly-added category should end up selected');

  d.getElementById('editDoneBtn').click();
  await wait();
  assert.strictEqual((await window.db.getBook(id)).category, 'Poetry');
});

await test('Edit screen: cancelling "+ Add new category..." reverts the select to blank', async () => {
  const window = await createApp();
  const d = window.document;
  const id = await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'Draft', author: 'Someone' }));
  await window.openDetail(id);
  await window.enterEditMode();

  window.prompt = () => null; // user hit Cancel
  const select = d.getElementById('editCategory');
  select.value = '__add_new_category__' /* must match ADD_NEW_CATEGORY_VALUE in app.js */;
  select.dispatchEvent(new window.Event('change', { bubbles: true }));

  assert.deepStrictEqual(Array.from(window.getCategoryList()), [], 'nothing should be added on cancel');
  assert.strictEqual(select.value, '', 'select should fall back to the blank option');
});

// ---------- Backup / Restore ----------

await test('Restore replaces the entire library with the contents of the backup file', async () => {
  const window = await createApp();
  await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'Will Be Replaced', author: 'A' }));

  const backupBooks = [Object.assign(window.db.emptyBook(), { id: 999, title: 'From Backup', author: 'B' })];
  window.confirm = () => true;
  window.alert = () => {};
  const fakeFile = { text: async () => JSON.stringify(backupBooks) };
  await window.handleRestoreFile({ target: { files: [fakeFile], value: 'x' } });
  await wait();

  const books = await window.db.getAllBooks();
  assert.strictEqual(books.length, 1);
  assert.strictEqual(books[0].title, 'From Backup');
});

await test('Restore rebuilds the category list from the backup, replacing whatever was there before', async () => {
  const window = await createApp();
  window.addCategoryIfNew('Old Category'); // present before the restore - should not survive it

  const backupBooks = [
    Object.assign(window.db.emptyBook(), { id: 1, title: 'A', author: 'X', category: 'Science Fiction' }),
    Object.assign(window.db.emptyBook(), { id: 2, title: 'B', author: 'Y', category: 'Fiction' }),
    Object.assign(window.db.emptyBook(), { id: 3, title: 'C', author: 'Z', category: '' }), // blank - should not add an entry
  ];
  window.confirm = () => true;
  window.alert = () => {};
  const fakeFile = { text: async () => JSON.stringify(backupBooks) };
  await window.handleRestoreFile({ target: { files: [fakeFile], value: 'x' } });
  await wait();

  assert.deepStrictEqual(
    Array.from(window.getCategoryList()),
    ['Fiction', 'Science Fiction'],
    'category list should be rebuilt purely from the restored books - alphabetical, blanks skipped, old categories gone'
  );
});

await test('Restore onto a category list that already matches leaves it alphabetically deduped, not doubled', async () => {
  const window = await createApp();
  window.addCategoryIfNew('Fiction');

  const backupBooks = [Object.assign(window.db.emptyBook(), { id: 1, title: 'A', author: 'X', category: 'Fiction' })];
  window.confirm = () => true;
  window.alert = () => {};
  const fakeFile = { text: async () => JSON.stringify(backupBooks) };
  await window.handleRestoreFile({ target: { files: [fakeFile], value: 'x' } });
  await wait();

  assert.deepStrictEqual(Array.from(window.getCategoryList()), ['Fiction']);
});


// ---------- Refresh from Online Sources: match picker ----------

await test('Refresh shows a match picker (even for a single match) and Apply fills only empty fields', async () => {
  const window = await createApp();
  const d = window.document;
  window.api.findMatches = async () => ([
    { source: 'openlibrary', title: 'Dune', author: 'Frank Herbert', synopsis: 'A desert planet epic.', category: 'Science Fiction', coverUrl: 'https://covers.example/dune.jpg' },
  ]);
  window.api.enrichMatchSynopsis = async (m) => m;

  const id = await window.db.addBook(Object.assign(window.db.emptyBook(), {
    title: 'Dune', author: 'Frank Herbert', category: 'Already Set', // category pre-filled - should NOT be overwritten
  }));
  await window.openDetail(id);
  d.getElementById('refreshOnlineBtn').click();
  await wait();

  assert.strictEqual(d.getElementById('refreshMatchesNavRow').style.display, 'flex');
  const items = d.querySelectorAll('#refreshMatchesList .match-item');
  assert.strictEqual(items.length, 1, 'picker shows even a single match rather than auto-applying it');

  items[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait();

  assert.strictEqual(d.getElementById('previewNavRow').style.display, 'flex');
  assert.strictEqual(d.getElementById('previewAddBtn').textContent, 'Apply', 'button reads Apply, not Add, in refresh context');

  d.getElementById('previewAddBtn').click();
  await wait();

  const saved = await window.db.getBook(id);
  assert.strictEqual(saved.category, 'Already Set', 'pre-filled category was not overwritten');
  assert.strictEqual(saved.synopsis, 'A desert planet epic.', 'empty synopsis was filled from the match');
  assert.strictEqual(saved.coverUrl, 'https://covers.example/dune.jpg', 'empty cover was filled from the match');
  assert.ok(d.getElementById('viewNavRow').style.display === 'flex', 'returns to the normal view screen');
});

await test('Refresh with multiple matches lets you pick which one to apply', async () => {
  const window = await createApp();
  const d = window.document;
  window.api.findMatches = async () => ([
    { source: 'openlibrary', title: 'Foundation', author: 'Isaac Asimov', synopsis: '', category: 'Wrong Edition Category', coverUrl: '' },
    { source: 'openlibrary', title: 'Foundation (Anniversary Edition)', author: 'Isaac Asimov', synopsis: 'The right one.', category: 'Science Fiction', coverUrl: '' },
  ]);
  window.api.enrichMatchSynopsis = async (m) => m;

  const id = await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'Foundation', author: 'Isaac Asimov' }));
  await window.openDetail(id);
  d.getElementById('refreshOnlineBtn').click();
  await wait();

  const items = d.querySelectorAll('#refreshMatchesList .match-item');
  assert.strictEqual(items.length, 2);

  items[1].dispatchEvent(new window.Event('click', { bubbles: true })); // pick the second candidate
  await wait();
  assert.ok(d.getElementById('detailSynopsis').textContent.includes('The right one.'));

  d.getElementById('previewAddBtn').click();
  await wait();
  const saved = await window.db.getBook(id);
  assert.strictEqual(saved.category, 'Science Fiction', 'the picked match\'s fields were applied, not the first one\'s');
});

await test('Refresh: "‹ Matches" from preview returns to the picker list, not the book', async () => {
  const window = await createApp();
  const d = window.document;
  window.api.findMatches = async () => ([
    { source: 'openlibrary', title: 'A', author: 'B', synopsis: '', category: '', coverUrl: '' },
    { source: 'openlibrary', title: 'A2', author: 'B', synopsis: '', category: '', coverUrl: '' },
  ]);
  window.api.enrichMatchSynopsis = async (m) => m;

  const id = await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'A', author: 'B' }));
  await window.openDetail(id);
  d.getElementById('refreshOnlineBtn').click();
  await wait();
  d.querySelectorAll('#refreshMatchesList .match-item')[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait();

  d.getElementById('previewBackBtn').click();
  await wait();
  assert.strictEqual(d.getElementById('refreshMatchesNavRow').style.display, 'flex', 'back to the picker list, not the saved book view');
  assert.strictEqual(d.querySelectorAll('#refreshMatchesList .match-item').length, 2, 'list is still populated');
});

await test('Refresh: Cancel from the picker list discards the search and shows the unchanged book', async () => {
  const window = await createApp();
  const d = window.document;
  window.api.findMatches = async () => ([{ source: 'openlibrary', title: 'A', author: 'B', synopsis: '', category: '', coverUrl: '' }]);

  const id = await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'Original Title', author: 'B' }));
  await window.openDetail(id);
  d.getElementById('refreshOnlineBtn').click();
  await wait();
  d.getElementById('refreshMatchesCancelBtn').click();
  await wait();

  assert.strictEqual(d.getElementById('viewNavRow').style.display, 'flex');
  assert.ok(d.getElementById('detailHero').textContent.includes('Original Title'));
  assert.strictEqual((await window.db.getBook(id)).title, 'Original Title', 'nothing was changed');
});

await test('Refresh: zero matches shows an alert and never opens the picker', async () => {
  const window = await createApp();
  const d = window.document;
  window.api.findMatches = async () => [];
  let alertMessage = null;
  window.alert = (msg) => { alertMessage = msg; };

  const id = await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'Obscure Book', author: 'Nobody' }));
  await window.openDetail(id);
  d.getElementById('refreshOnlineBtn').click();
  await wait();

  assert.ok(alertMessage && alertMessage.includes('No matches found'));
  assert.strictEqual(d.getElementById('refreshMatchesNavRow').style.display, 'none');
});

await test('Refresh: applying a match with nothing new to offer shows the existing "no new information" alert', async () => {
  const window = await createApp();
  const d = window.document;
  window.api.findMatches = async () => ([{ source: 'openlibrary', title: 'T', author: 'A', synopsis: '', category: '', coverUrl: '' }]);
  window.api.enrichMatchSynopsis = async (m) => m;
  let alertMessage = null;
  window.alert = (msg) => { alertMessage = msg; };

  // Book already has every fillable field set, so the match (all blank) has nothing to offer
  const id = await window.db.addBook(Object.assign(window.db.emptyBook(), {
    title: 'T', author: 'A', synopsis: 'Already have one', category: 'Already Set', coverUrl: 'https://already.example/c.jpg',
  }));
  await window.openDetail(id);
  d.getElementById('refreshOnlineBtn').click();
  await wait();
  d.querySelectorAll('#refreshMatchesList .match-item')[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait();
  d.getElementById('previewAddBtn').click();
  await wait();

  assert.ok(alertMessage && alertMessage.includes('No new information'));
  const saved = await window.db.getBook(id);
  assert.strictEqual(saved.synopsis, 'Already have one', 'unchanged');
});

// ---------- Status list quick-action buttons ----------

await test('Status list quick actions: "Read Now" (To Read) and "To Read" (Waiting) buttons advance status correctly', async () => {
  const window = await createApp();
  const d = window.document;
  const toReadId = await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'A', author: 'X', status: 'To Read' }));
  const waitingId = await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'B', author: 'Y', status: 'Waiting' }));
  const readingId = await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'C', author: 'Z', status: 'Reading' }));
  await window.renderListView();

  const rowFor = (id) => d.querySelector(`.row[data-book-id="${id}"]`);

  const toReadBtn = rowFor(toReadId).querySelector('.row-action-btn');
  assert.strictEqual(toReadBtn.textContent, 'Read Now');
  toReadBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait();
  assert.strictEqual((await window.db.getBook(toReadId)).status, 'Reading', '"Read Now" moves To Read -> Reading');

  const waitingBtn = rowFor(waitingId).querySelector('.row-action-btn');
  assert.strictEqual(waitingBtn.textContent, 'To Read');
  waitingBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait();
  assert.strictEqual((await window.db.getBook(waitingId)).status, 'To Read', '"To Read" moves Waiting -> To Read');

  const readingBtn = rowFor(readingId).querySelector('.row-action-btn');
  assert.strictEqual(readingBtn.textContent, 'Mark Read', 'Reading keeps its existing "Mark Read" action, unchanged');
  readingBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await wait();
  assert.strictEqual((await window.db.getBook(readingId)).status, 'Read');
});

await test('Status list quick actions: Read, Wanted, and Shelved rows show no action button', async () => {
  const window = await createApp();
  const d = window.document;
  const readId = await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'A', author: 'X', status: 'Read' }));
  const wantedId = await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'B', author: 'Y', status: 'Wanted' }));
  const shelvedId = await window.db.addBook(Object.assign(window.db.emptyBook(), { title: 'C', author: 'Z', status: 'Shelved' }));
  await window.renderListView();

  const rowFor = (id) => d.querySelector(`.row[data-book-id="${id}"]`);
  assert.strictEqual(rowFor(readId).querySelector('.row-action-btn'), null);
  assert.strictEqual(rowFor(wantedId).querySelector('.row-action-btn'), null);
  assert.strictEqual(rowFor(shelvedId).querySelector('.row-action-btn'), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log('Failed:', failures.join(', '));
process.exit(fail === 0 ? 0 : 1);
}

main();
