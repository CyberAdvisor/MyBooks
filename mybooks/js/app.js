/**
 * app.js
 * DOM-facing application controller. Wires together db.js, api.js, csv.js,
 * and logic.js to render views and handle user interaction.
 *
 * This file intentionally contains no business logic of its own beyond
 * DOM wiring - all filtering/grouping/parsing/persistence rules live in
 * the modules above, where they're covered by the Node test suite.
 */

// Change this to personalize the heading shown at the top of the Library view
// (e.g. "John's Library"). Leave as 'Library' for the default.
const LIBRARY_NAME = 'Library';

// App version, shown small and light next to the Library title. Bump this
// on every release and add a line below describing what changed - this is
// the running changelog for the whole app.
//
//   v1.0 - Status list now sorts by rating (highest first) before falling
//          back to title, instead of by title alone.
//   v1.1-1.4 - Added, then debugged, automatic Dropbox sync. Reverted in
//          v1.5 - see "Dropbox sync: tried and reverted" in
//          CLAUDE_CONTEXT.md for why and what was ruled out.
//   v1.5 - Removed Dropbox sync entirely. Backup/restore is manual-only
//          again (Backup Now / Restore from Backup File). Script tags in
//          index.html carry a matching ?v= cache-busting suffix, and this
//          version number is the way to confirm a device is actually
//          running the latest deploy rather than a stale cached copy -
//          keep bumping both together on every future change.
const APP_VERSION = 'v1.5';

const COLLAPSE_STATE_KEY = 'book_library_collapsed_sections';
const RATING_OPTIONS = [1, 2, 3, 4, 5];
const STATUS_OPTIONS = logic.STATUS_ORDER; // Reading, To Read, Waiting, Read, Wanted, Shelved
const CATEGORY_STORAGE_KEY = 'book_library_categories';
// Sentinel option value for "+ Add new category..." in the Edit screen's
// category <select> - never a real category name, so it can't collide.
const ADD_NEW_CATEGORY_VALUE = '__add_new_category__';

const SOURCE_STORAGE_KEY = 'book_library_sources';
// Sentinel option value for "+ Add new source..." - same pattern as categories.
const ADD_NEW_SOURCE_VALUE = '__add_new_source__';

// First-run seed for sourceList (below) - only used the very first time the
// app runs on a browser with nothing in localStorage yet. After that,
// sourceList is whatever's actually been persisted (grown/edited from here).
const DEFAULT_SOURCE_SEED = ['Library', 'Kobo', 'Kindle', 'Yomu'];

// In-memory app state
const state = {
  currentDetailId: null,   // id of book shown in detail/edit view
  addMatches: [],           // last set of match candidates shown in Add Book
  previewMatch: null,       // match candidate currently shown in the (unsaved) preview screen
  previewContext: null,     // 'add' | 'refresh' - which flow opened the preview screen, and what its Apply/Add button should do
  refreshMatches: [],       // last set of match candidates shown by "Refresh from Online Sources"
  editCoverValue: '',       // working copy of coverUrl while editing (may be a data: URI)
  searchQuery: '',
  listMode: 'status',       // 'status' | 'authors' | 'categories' | 'series' | 'drilldown'
  drilldownType: null,      // 'author' | 'category' | 'series', when listMode === 'drilldown'
  drilldownValue: null,     // the specific author/category/series name being viewed
};

function loadCollapsedSections() {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_STATE_KEY)) || {};
  } catch (e) {
    return {};
  }
}
function saveCollapsedSections(collapsed) {
  localStorage.setItem(COLLAPSE_STATE_KEY, JSON.stringify(collapsed));
}

/**
 * The category list starts empty and is built up over time - either from
 * values seen during CSV import, or names typed in via "+ Add new
 * category..." on the Edit screen. Kept alphabetically sorted and
 * persisted in localStorage, the same way collapsed-section state is.
 */
function loadCategoryList() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CATEGORY_STORAGE_KEY));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}
function saveCategoryList(list) {
  localStorage.setItem(CATEGORY_STORAGE_KEY, JSON.stringify(list));
}

// In-memory copy of the persisted category list, kept in sync via
// addCategoryIfNew() below. Read by the Categories view and the Edit
// screen's category dropdown.
let categoryList = loadCategoryList();

/**
 * Adds `name` to the category list if it isn't already present
 * (case-insensitively), persists the result, and returns the canonical
 * (already-stored) spelling - the existing entry if one matched, otherwise
 * the trimmed input. Blank input is a no-op and returns ''.
 */
function addCategoryIfNew(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return '';
  const existing = categoryList.find((c) => c.toLowerCase() === trimmed.toLowerCase());
  if (existing) return existing;
  categoryList.push(trimmed);
  categoryList.sort((a, b) => a.localeCompare(b));
  saveCategoryList(categoryList);
  return trimmed;
}

/**
 * Read-only snapshot of the current category list. categoryList itself
 * isn't reachable from outside this file (top-level `let`/`const` bindings
 * aren't exposed as window properties the way function declarations are),
 * so callers - including the test suite - go through this getter instead.
 */
function getCategoryList() {
  return categoryList.slice();
}

/**
 * sourceList: same dynamic/persisted pattern as categoryList (see above),
 * just seeded with DEFAULT_SOURCE_SEED on a brand-new browser instead of
 * starting blank - source is a single-select dropdown identical to
 * Category's, grown the same three ways: CSV import, "+ Add new source..."
 * on the Edit screen, and reset-and-rebuilt on Restore from Backup.
 */
function loadSourceList() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SOURCE_STORAGE_KEY));
    if (Array.isArray(parsed)) return parsed;
  } catch (e) {
    // fall through to the seed below
  }
  // Sorted here (not just left in DEFAULT_SOURCE_SEED's literal order) so
  // sourceList is alphabetically sorted unconditionally from its very first
  // read, the same invariant addSourceIfNew() maintains on every later change.
  return DEFAULT_SOURCE_SEED.slice().sort((a, b) => a.localeCompare(b));
}
function saveSourceList(list) {
  localStorage.setItem(SOURCE_STORAGE_KEY, JSON.stringify(list));
}

let sourceList = loadSourceList();
if (localStorage.getItem(SOURCE_STORAGE_KEY) === null) saveSourceList(sourceList); // persist the seed on first run, so it's stable from here on

function addSourceIfNew(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return '';
  const existing = sourceList.find((s) => s.toLowerCase() === trimmed.toLowerCase());
  if (existing) return existing;
  sourceList.push(trimmed);
  sourceList.sort((a, b) => a.localeCompare(b));
  saveSourceList(sourceList);
  return trimmed;
}

function getSourceList() {
  return sourceList.slice();
}

// ---------- View switching ----------

function showView(viewId) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.getElementById(viewId).classList.add('active');
}

// ---------- List view ----------

/** Top-level entry point: shows the right nav bar, then renders the current mode. */
async function renderListView() {
  updateLibraryNavBar();
  const allBooks = await db.getAllBooks();

  if (allBooks.length === 0 && state.listMode !== 'drilldown') {
    document.getElementById('listContent').innerHTML = '<div class="empty-state">No books yet. Tap "Add" below to get started.</div>';
    return;
  }

  if (state.listMode === 'authors') return renderAuthorsMode(allBooks);
  if (state.listMode === 'categories') return renderCategoriesMode(allBooks);
  if (state.listMode === 'series') return renderSeriesMode(allBooks);
  if (state.listMode === 'drilldown') return renderDrilldownMode(allBooks);
  return renderStatusMode(allBooks);
}

/** Shows/hides the main heading+segmented-control nav vs. the drill-down back+title nav. */
function updateLibraryNavBar() {
  const inDrilldown = state.listMode === 'drilldown';
  document.getElementById('libraryMainNav').style.display = inDrilldown ? 'none' : 'flex';
  document.getElementById('librarySegmented').style.display = inDrilldown ? 'none' : 'flex';
  document.getElementById('librarySearchBar').style.display = (state.listMode === 'status') ? 'flex' : 'none';
  document.getElementById('libraryDrilldownNav').style.display = inDrilldown ? 'flex' : 'none';

  document.querySelectorAll('#librarySegmented .segment').forEach((seg) => {
    seg.classList.toggle('active', seg.dataset.mode === state.listMode);
  });

  if (inDrilldown) {
    document.getElementById('libraryDrilldownTitle').textContent = state.drilldownValue;
  }
}

function renderStatusMode(allBooks) {
  const filtered = logic.filterBooks(allBooks, state.searchQuery);
  const grouped = logic.groupBooksByStatus(filtered);
  const collapsed = loadCollapsedSections();

  const container = document.getElementById('listContent');
  container.innerHTML = '';

  grouped.forEach(({ status, books }) => {
    const isCollapsed = !!collapsed[status];

    const header = document.createElement('div');
    header.className = 'section-header' + (isCollapsed ? ' collapsed' : '');
    header.dataset.status = status;
    header.innerHTML = `
      <div class="title-group">
        <span class="chevron">▾</span>
        <span class="label">${escapeHtml(status)}</span>
      </div>
      <span class="count">${books.length}</span>
    `;
    header.addEventListener('click', () => toggleSection(status));
    container.appendChild(header);

    const body = document.createElement('div');
    body.className = 'section-body' + (isCollapsed ? ' collapsed' : '');
    body.id = `sec-${slug(status)}`;

    if (books.length === 0) {
      container.appendChild(body);
      return;
    }

    const card = document.createElement('div');
    card.className = 'card';
    books.forEach((book) => card.appendChild(buildBookRow(book)));
    body.appendChild(card);
    container.appendChild(body);
  });
}

function renderAuthorsMode(allBooks) {
  const groups = logic.buildAuthorsIndex(allBooks);
  const container = document.getElementById('listContent');
  container.innerHTML = '';

  groups.forEach(({ letter, authors }) => {
    const header = document.createElement('div');
    header.className = 'section-label';
    header.textContent = letter;
    container.appendChild(header);

    const card = document.createElement('div');
    card.className = 'card';
    authors.forEach(({ name, count }) => {
      card.appendChild(buildIndexRow(name, count, 'author'));
    });
    container.appendChild(card);
  });
}

function renderCategoriesMode(allBooks) {
  const categories = logic.buildCategoriesIndex(allBooks, categoryList);
  const container = document.getElementById('listContent');
  container.innerHTML = '';

  const card = document.createElement('div');
  card.className = 'card';
  categories.forEach(({ name, count }) => {
    card.appendChild(buildIndexRow(name, count, 'category'));
  });
  container.appendChild(card);
}

function renderSeriesMode(allBooks) {
  const groups = logic.buildSeriesIndex(allBooks);
  const container = document.getElementById('listContent');
  container.innerHTML = '';

  if (groups.length === 0) {
    container.innerHTML = '<div class="empty-state">No books with a series set yet.</div>';
    return;
  }

  groups.forEach(({ letter, series }) => {
    const header = document.createElement('div');
    header.className = 'section-label';
    header.textContent = letter;
    container.appendChild(header);

    const card = document.createElement('div');
    card.className = 'card';
    series.forEach(({ name, count, author }) => {
      card.appendChild(buildIndexRow(name, count, 'series', author));
    });
    container.appendChild(card);
  });
}

const DRILLDOWN_LOOKUPS = {
  author: logic.booksByAuthor,
  category: logic.booksByCategory,
  series: logic.booksBySeries,
};

// Which segmented-control mode each drilldown type returns to via the
// drilldown "‹ Back" button - not a simple pluralization (category ->
// categories), so kept as an explicit map rather than derived from the string.
const DRILLDOWN_PARENT_MODE = {
  author: 'authors',
  category: 'categories',
  series: 'series',
};

function renderDrilldownMode(allBooks) {
  const books = DRILLDOWN_LOOKUPS[state.drilldownType](allBooks, state.drilldownValue);

  const container = document.getElementById('listContent');
  container.innerHTML = '';

  if (books.length === 0) {
    container.innerHTML = '<div class="empty-state">No books here yet.</div>';
    return;
  }

  const card = document.createElement('div');
  card.className = 'card';
  books.forEach((book) => card.appendChild(buildBookRow(book)));
  container.appendChild(card);
}

function openDrilldown(type, value) {
  state.listMode = 'drilldown';
  state.drilldownType = type;
  state.drilldownValue = value;
  renderListView();
}

/**
 * A simple name/count row used by the Authors, Categories, and Series
 * index views. `subtitle`, when given (currently just Series' author),
 * renders below the name in the same small/light style as a book row's
 * author line (.row-author) - omitted entirely when blank, not shown as
 * an empty line, same convention as buildBookRow's optional lines.
 */
function buildIndexRow(name, count, indexType, subtitle) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.indexType = indexType; // 'author' | 'category' | 'series' - read by the delegated click handler
  row.dataset.indexValue = name;
  const subtitleLine = subtitle ? `<div class="row-author">${escapeHtml(subtitle)}</div>` : '';
  row.innerHTML = `
    <div class="row-text"><div class="row-title">${escapeHtml(name)}</div>${subtitleLine}</div>
    <span class="index-count">${count} ${count === 1 ? 'book' : 'books'}</span>
    <span class="chev-right">›</span>
  `;
  return row;
}

function buildBookRow(book) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.bookId = book.id; // read by the delegated click handler

  const cover = document.createElement('div');
  cover.className = 'cover';
  if (book.coverUrl) cover.style.backgroundImage = `url("${book.coverUrl}")`;
  row.appendChild(cover);

  const text = document.createElement('div');
  text.className = 'row-text';
  const seriesLine = book.series
    ? `<div class="row-series">${escapeHtml(book.series)}${book.seriesNumber ? ' · #' + escapeHtml(String(book.seriesNumber)) : ''}</div>`
    : '';
  // Source line is omitted entirely when the book has no source set - not
  // shown as a blank line or placeholder.
  const sourceLine = book.source
    ? `<div class="row-source">${escapeHtml(book.source)}</div>`
    : '';
  text.innerHTML = `
    <div class="row-title">${escapeHtml(book.title || 'Untitled')}</div>
    <div class="row-author">${escapeHtml(book.author || 'Unknown author')}</div>
    ${seriesLine}
    ${sourceLine}
  `;
  row.appendChild(text);

  // Rating stars whenever the book has one (Read/Shelved books normally)
  if (book.rating) {
    const starsWrap = document.createElement('span');
    starsWrap.className = 'row-rating';
    starsWrap.innerHTML = rating.buildStarsHtml(book.rating);
    row.appendChild(starsWrap);
  }

  const quickAction = logic.getStatusQuickAction(book.status);
  if (quickAction) {
    const btn = document.createElement('button');
    btn.className = 'row-action-btn';
    btn.textContent = quickAction.label;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await db.updateBook(book.id, { status: quickAction.nextStatus });
      renderListView();
    });
    row.appendChild(btn);
  }

  const chev = document.createElement('span');
  chev.className = 'chev-right';
  chev.textContent = '›';
  row.appendChild(chev);

  return row;
}

function toggleSection(status) {
  const collapsed = loadCollapsedSections();
  collapsed[status] = !collapsed[status];
  saveCollapsedSections(collapsed);
  renderListView();
}

function slug(s) {
  return s.toLowerCase().replace(/\s+/g, '-');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Detail view ----------

async function openDetail(id) {
  state.currentDetailId = id;
  await renderDetailView();
  showView('detailView');
}

async function renderDetailView() {
  const book = await db.getBook(state.currentDetailId);
  if (!book) { showView('listView'); return; }

  setDetailMode('view'); // always open in view mode

  const hero = document.getElementById('detailHero');
  hero.innerHTML = `
    <div class="detail-cover" style="${book.coverUrl ? `background-image:url('${book.coverUrl}')` : ''}"></div>
    <div class="detail-title">${escapeHtml(book.title || 'Untitled')}</div>
    <div class="detail-author">${escapeHtml(book.author || 'Unknown author')}</div>
    <div class="detail-badges">
      <span class="badge badge-status">${escapeHtml(book.status)}</span>
      ${book.rating ? rating.buildStarsHtml(book.rating) : ''}
    </div>
  `;

  document.getElementById('detailFields').innerHTML = `
    <div class="field-row"><span class="field-label">Series</span><span class="field-value">${book.series ? escapeHtml(book.series) + (book.seriesNumber ? ' #' + escapeHtml(String(book.seriesNumber)) : '') : '—'}</span></div>
    <div class="field-row"><span class="field-label">Category</span><span class="field-value">${book.category ? escapeHtml(book.category) : '—'}</span></div>
    <div class="field-row"><span class="field-label">Status</span><span class="field-value">${escapeHtml(book.status)}</span></div>
    <div class="field-row"><span class="field-label">Rating</span><span class="field-value">${book.rating ? rating.buildStarsHtml(book.rating) : '—'}</span></div>
    <div class="field-row"><span class="field-label">Source</span><span class="field-value">${book.source ? escapeHtml(book.source) : '—'}</span></div>
  `;

  document.getElementById('detailSynopsis').textContent = book.synopsis || 'No synopsis.';
  document.getElementById('detailNotes').textContent = book.notes || 'Tap Edit to add notes…';
}

/**
 * Switches the Detail view between its three mutually-exclusive nav/content
 * modes:
 *   'view'    - a saved book, read-only, with Edit button and action buttons
 *   'edit'    - a saved book, editable fields, with Cancel/Done
 *   'preview' - an unsaved match candidate, read-only, with Matches/Add
 *               (Notes and the action buttons don't apply to an unsaved
 *               book, so they're hidden in this mode)
 */
function setDetailMode(mode) {
  document.getElementById('viewNavRow').style.display = mode === 'view' ? 'flex' : 'none';
  document.getElementById('editNavRow').style.display = mode === 'edit' ? 'flex' : 'none';
  document.getElementById('previewNavRow').style.display = mode === 'preview' ? 'flex' : 'none';
  document.getElementById('refreshMatchesNavRow').style.display = mode === 'refresh-matches' ? 'flex' : 'none';
  document.getElementById('viewMode').style.display = (mode === 'view' || mode === 'preview') ? 'block' : 'none';
  document.getElementById('editModeBlock').style.display = mode === 'edit' ? 'block' : 'none';
  document.getElementById('refreshMatchesList').style.display = mode === 'refresh-matches' ? 'block' : 'none';
  document.getElementById('detailNotesGroup').style.display = mode === 'view' ? 'block' : 'none'; // hidden in preview (unsaved book) and refresh-matches/edit (viewMode itself is hidden anyway)
  document.getElementById('detailActionsGroup').style.display = mode === 'view' ? 'block' : 'none';
}

async function enterEditMode() {
  const book = await db.getBook(state.currentDetailId);
  if (!book) return;

  setDetailMode('edit');

  state.editCoverValue = book.coverUrl || '';
  updateEditCoverPreview();
  document.getElementById('editTitle').value = book.title || '';
  document.getElementById('editAuthor').value = book.author || '';
  document.getElementById('editSeries').value = book.series || '';
  document.getElementById('editSeriesNumber').value = book.seriesNumber || '';
  document.getElementById('editSynopsis').value = book.synopsis || '';
  document.getElementById('editNotes').value = book.notes || '';

  buildCategorySelect(book.category);
  buildSelect('editStatus', STATUS_OPTIONS, book.status, false);
  buildSelect('editRating', RATING_OPTIONS, book.rating, true, '—', plainStarsLabel);
  buildSourceSelect(book.source);
}

function buildSelect(elementId, options, selectedValue, allowBlank, blankLabel, labelFn) {
  const select = document.getElementById(elementId);
  select.innerHTML = '';
  if (allowBlank) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = blankLabel || '—';
    select.appendChild(opt);
  }
  options.forEach((val) => {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = labelFn ? labelFn(val) : val;
    if (val === selectedValue) opt.selected = true;
    select.appendChild(opt);
  });
}

/** Plain-text (uncolored) star glyphs for use inside a <select> option label. */
function plainStarsLabel(n) {
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

/**
 * Builds the Edit screen's category <select>: a blank option, every entry
 * in categoryList (kept sorted by addCategoryIfNew), then a trailing
 * "+ Add new category..." sentinel option handled by
 * handleCategorySelectChange.
 */
function buildCategorySelect(selectedValue) {
  buildSelect('editCategory', categoryList, selectedValue, true);
  const addOpt = document.createElement('option');
  addOpt.value = ADD_NEW_CATEGORY_VALUE;
  addOpt.textContent = '+ Add new category…';
  document.getElementById('editCategory').appendChild(addOpt);
}

/**
 * Handles selecting "+ Add new category..." in the Edit screen's category
 * dropdown: prompts for a name, adds it to the persisted category list (or
 * reuses a case-insensitive match), and rebuilds the select with it chosen.
 * Cancelling, or entering blank text, reverts the select to its blank
 * option rather than leaving the sentinel selected.
 */
function handleCategorySelectChange(event) {
  if (event.target.value !== ADD_NEW_CATEGORY_VALUE) return;
  const name = prompt('New category name:');
  const added = addCategoryIfNew(name);
  buildCategorySelect(added); // added === '' when cancelled/blank -> reselects the blank option
}

/**
 * Builds the Edit screen's source <select> - identical pattern to
 * buildCategorySelect(): a blank option, every entry in sourceList, then a
 * trailing "+ Add new source..." sentinel. Single-select, unlike the old
 * chip-based multi-select this replaced (see CLAUDE_CONTEXT.md for why -
 * the chip popover was clipped to invisibility on iPhone by an ancestor's
 * overflow:hidden, and a single value covers the common case anyway).
 */
function buildSourceSelect(selectedValue) {
  buildSelect('editSource', sourceList, selectedValue, true);
  const addOpt = document.createElement('option');
  addOpt.value = ADD_NEW_SOURCE_VALUE;
  addOpt.textContent = '+ Add new source…';
  document.getElementById('editSource').appendChild(addOpt);
}

/** Handles "+ Add new source..." - same prompt/add/reselect flow as handleCategorySelectChange(). */
function handleSourceSelectChange(event) {
  if (event.target.value !== ADD_NEW_SOURCE_VALUE) return;
  const name = prompt('New source name:');
  const added = addSourceIfNew(name);
  buildSourceSelect(added);
}

/**
 * Cover image editing (Edit Book view). A cover can be set two ways -
 * clicking the thumbnail and pasting (Cmd/Ctrl+V) a copied image, or
 * choosing a file via the Upload Photo button - both funnel through
 * resizeImageToDataUrl() and land in state.editCoverValue, the single
 * working copy saveEdit() persists from. There's no separate "remove"
 * control: clearing state.editCoverValue isn't exposed in the UI, so once
 * a cover is set it can only be replaced, not cleared, in this version.
 */
const MAX_COVER_DIMENSION = 600; // long-edge cap, in pixels, for uploaded/pasted covers

function updateEditCoverPreview() {
  const el = document.getElementById('editCover');
  el.style.backgroundImage = state.editCoverValue ? `url('${state.editCoverValue}')` : '';
  el.classList.toggle('no-cover', !state.editCoverValue);
}

/**
 * Downscales an image Blob/File to at most MAX_COVER_DIMENSION on its long
 * edge and re-encodes it as a JPEG data URL, so a full-resolution phone
 * photo doesn't get stored as-is in IndexedDB. Falls back to the original
 * (un-resized) data URL if canvas processing fails for any reason.
 */
function resizeImageToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve('');
    reader.onload = () => {
      const original = reader.result;
      const img = new Image();
      img.onerror = () => resolve(original);
      img.onload = () => {
        const scale = Math.min(1, MAX_COVER_DIMENSION / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        try {
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        } catch (e) {
          resolve(original); // canvas tainted/unsupported - use the un-resized image instead
        }
      };
      img.src = original;
    };
    reader.readAsDataURL(blob);
  });
}

async function handleCoverFileSelected(event) {
  const file = event.target.files[0];
  event.target.value = ''; // allow re-selecting the same file later
  if (!file) return;
  state.editCoverValue = await resizeImageToDataUrl(file);
  updateEditCoverPreview();
}

async function handleCoverPaste(event) {
  const items = (event.clipboardData && event.clipboardData.items) || [];
  const imageItem = Array.from(items).find((item) => item.type.indexOf('image/') === 0);
  if (!imageItem) return; // no image on the clipboard - nothing to do
  event.preventDefault();
  const file = imageItem.getAsFile();
  if (!file) return;
  state.editCoverValue = await resizeImageToDataUrl(file);
  updateEditCoverPreview();
}


async function saveEdit() {
  const seriesNumberRaw = document.getElementById('editSeriesNumber').value;
  const changes = {
    title: document.getElementById('editTitle').value.trim(),
    author: document.getElementById('editAuthor').value.trim(),
    coverUrl: state.editCoverValue,
    series: document.getElementById('editSeries').value.trim(),
    seriesNumber: seriesNumberRaw ? Number(seriesNumberRaw) : null,
    category: document.getElementById('editCategory').value,
    status: document.getElementById('editStatus').value,
    rating: rating.normalizeRating(document.getElementById('editRating').value),
    source: document.getElementById('editSource').value,
    synopsis: document.getElementById('editSynopsis').value,
    notes: document.getElementById('editNotes').value,
  };
  await db.updateBook(state.currentDetailId, changes);
  await renderDetailView();
}

async function deleteCurrentBook() {
  if (!confirm('Delete this book permanently? This cannot be undone.')) return;
  await db.deleteBook(state.currentDetailId);
  state.currentDetailId = null;
  showView('listView');
  renderListView();
}

async function markCurrentBookRead() {
  await db.updateBook(state.currentDetailId, { status: 'Read' });
  renderDetailView();
}

/**
 * "Refresh from Online Sources" - searches for this book and, if there are
 * any matches, shows them as a picker (via the same match-card styling as
 * Add Book) rather than silently taking the top result. This always shows
 * the picker even for a single match, for consistency with Add Book's own
 * always-preview behavior.
 *
 * api.findMatches now throws (rather than resolving to []) when the search
 * itself fails to complete - a network error or a non-2xx response from
 * Open Library (e.g. a 503 while it's overloaded) - as opposed to a
 * genuine zero-result search, which still resolves to []. The two need
 * different messaging: a failed search shouldn't look identical to "no
 * matches," or a transient outage reads as "this app is broken."
 */
async function refreshCurrentBookFromOnline() {
  const book = await db.getBook(state.currentDetailId);
  let matches;
  try {
    matches = await api.findMatches(book.title, book.author);
  } catch (e) {
    alert(`Couldn't search Open Library: ${e.message}`);
    return;
  }
  if (matches.length === 0) {
    alert('No matches found online for this book.');
    return;
  }
  state.refreshMatches = matches;
  renderRefreshMatchesList(matches);
  setDetailMode('refresh-matches');
}

function renderRefreshMatchesList(matches) {
  const container = document.getElementById('refreshMatchesList');
  container.innerHTML = '';
  matches.forEach((match, idx) => {
    const item = document.createElement('div');
    item.className = 'match-item';
    item.innerHTML = `
      <div class="cover" style="${match.coverUrl ? `background-image:url('${match.coverUrl}')` : ''}"></div>
      <div class="match-text">
        <div class="match-title">${escapeHtml(match.title)}</div>
        <div class="match-author">${escapeHtml(match.author)}</div>
        <div class="match-source-tag">via Open Library</div>
      </div>
    `;
    item.addEventListener('click', () => openRefreshPreview(idx));
    container.appendChild(item);
  });
}

/** Opens the shared preview screen for a candidate picked from the refresh matches list. */
async function openRefreshPreview(idx) {
  const rawMatch = state.refreshMatches[idx];
  const enriched = await api.enrichMatchSynopsis(rawMatch);
  state.previewMatch = enriched;
  state.previewContext = 'refresh';
  renderMatchPreview(enriched);
  setDetailMode('preview');
}

/** "Cancel" from the refresh matches list - discards the search and returns to the saved book. */
function cancelRefreshMatches() {
  state.refreshMatches = [];
  renderDetailView();
}

/**
 * "Apply" (preview screen, refresh context) - fills only this book's
 * currently-empty fields from the previewed match, same rule
 * api.fillEmptyFields always uses: never overwrites a field the user has
 * already filled in themselves.
 */
async function applyRefreshMatch() {
  const match = state.previewMatch;
  if (!match) return;
  const book = await db.getBook(state.currentDetailId);
  const changes = api.fillEmptyFields(book, match);
  if (Object.keys(changes).length === 0) {
    alert('No new information to fill in from this match (all fields already filled).');
  } else {
    if (changes.category) addCategoryIfNew(changes.category); // same reason as addBookFromPreview - a filled-in category needs to land in categoryList too
    await db.updateBook(state.currentDetailId, changes);
  }
  state.previewMatch = null;
  state.previewContext = null;
  state.refreshMatches = [];
  await renderDetailView(); // back to the real book, in view mode
}

// ---------- Add Book view ----------

/**
 * api.findMatches now throws (rather than resolving to []) when the search
 * itself fails to complete, as opposed to a genuine zero-result search,
 * which still resolves to [] - see the comment on
 * refreshCurrentBookFromOnline above for why these need different
 * messaging. The catch block here shows the failure inline in the results
 * area (rather than an alert) so it reads the same way a "no matches"
 * result would, just with a distinguishable reason.
 */
async function searchAddMatches() {
  const title = document.getElementById('addSearchTitle').value.trim();
  const author = document.getElementById('addSearchAuthor').value.trim();
  if (!title && !author) {
    alert('Enter a title and/or author to search.');
    return;
  }
  const resultsEl = document.getElementById('addMatchResults');
  resultsEl.innerHTML = '<div class="section-note">Searching…</div>';

  let matches;
  try {
    matches = await api.findMatches(title, author);
  } catch (e) {
    resultsEl.innerHTML = `<div class="section-note">Couldn't search Open Library: ${escapeHtml(e.message)} You can still add this book manually below.</div>`;
    return;
  }
  state.addMatches = matches;

  if (matches.length === 0) {
    resultsEl.innerHTML = '<div class="section-note">No matches found. You can add this book manually below.</div>';
    return;
  }

  resultsEl.innerHTML = '';
  matches.forEach((match, idx) => {
    const item = document.createElement('div');
    item.className = 'match-item';
    item.innerHTML = `
      <div class="cover" style="${match.coverUrl ? `background-image:url('${match.coverUrl}')` : ''}"></div>
      <div class="match-text">
        <div class="match-title">${escapeHtml(match.title)}</div>
        <div class="match-author">${escapeHtml(match.author)}</div>
        <div class="match-source-tag">via Open Library</div>
      </div>
    `;
    item.addEventListener('click', () => openMatchPreview(idx));
    resultsEl.appendChild(item);
  });
}

/**
 * Shows a match candidate in the Detail view's read-only "preview" mode so
 * the user can review it (cover, title, author, category, synopsis) before
 * deciding whether to add it. Nothing is persisted until Add is tapped.
 */
async function openMatchPreview(idx) {
  const rawMatch = state.addMatches[idx];
  const enriched = await api.enrichMatchSynopsis(rawMatch);
  state.previewMatch = enriched;
  state.previewContext = 'add';
  renderMatchPreview(enriched);
  showView('detailView');
}

/**
 * Renders a match candidate into the Detail view's read-only preview
 * fields. Shared by both flows that reach this screen (Add Book and
 * Refresh from Online Sources) - state.previewContext ('add' | 'refresh')
 * determines what the right-hand nav button says and does; see
 * confirmMatchPreview().
 */
function renderMatchPreview(match) {
  document.getElementById('detailHero').innerHTML = `
    <div class="detail-cover" style="${match.coverUrl ? `background-image:url('${match.coverUrl}')` : ''}"></div>
    <div class="detail-title">${escapeHtml(match.title || 'Untitled')}</div>
    <div class="detail-author">${escapeHtml(match.author || 'Unknown author')}</div>
  `;

  document.getElementById('detailFields').innerHTML = `
    <div class="field-row"><span class="field-label">Category</span><span class="field-value">${match.category ? escapeHtml(match.category) : '—'}</span></div>
  `;

  document.getElementById('detailSynopsis').textContent = match.synopsis || 'No synopsis available.';
  document.getElementById('previewAddBtn').textContent = state.previewContext === 'refresh' ? 'Apply' : 'Add';

  setDetailMode('preview');
}

/**
 * "‹ Matches" - discards the preview without persisting anything. Where it
 * returns to depends on which flow opened the preview: the Add Book match
 * list (still populated as-is) or the Refresh from Online Sources picker.
 */
function cancelMatchPreview() {
  state.previewMatch = null;
  if (state.previewContext === 'refresh') {
    setDetailMode('refresh-matches'); // refreshMatchesList is still populated from before
  } else {
    showView('addView');
  }
  state.previewContext = null;
}

/** Dispatches the preview screen's right-hand nav button to the right flow. */
async function confirmMatchPreview() {
  if (state.previewContext === 'refresh') {
    await applyRefreshMatch();
  } else {
    await addBookFromPreview();
  }
}

/** "Add" - persists the previewed match as a new book, then returns to the Library. */
async function addBookFromPreview() {
  const match = state.previewMatch;
  if (!match) return;

  const newBook = Object.assign(db.emptyBook(), {
    title: match.title,
    author: match.author,
    synopsis: match.synopsis || '',
    category: match.category || '',
    coverUrl: match.coverUrl || '',
  });
  addCategoryIfNew(newBook.category); // a category from Open Library still needs to land in categoryList, not just on the book, or the Categories view will never show it (same fix as CSV import/Restore)
  await db.addBook(newBook);

  state.previewMatch = null;
  state.previewContext = null;
  state.addMatches = [];
  document.getElementById('addSearchTitle').value = '';
  document.getElementById('addSearchAuthor').value = '';
  document.getElementById('addMatchResults').innerHTML = '';

  showView('listView');
  await renderListView();
}

async function addBookBlank() {
  const title = document.getElementById('addSearchTitle').value.trim();
  const author = document.getElementById('addSearchAuthor').value.trim();
  const newBook = Object.assign(db.emptyBook(), { title, author });
  await addBookAndGoToDetail(newBook);
}

async function addBookAndGoToDetail(newBook) {
  const id = await db.addBook(newBook);
  document.getElementById('addSearchTitle').value = '';
  document.getElementById('addSearchAuthor').value = '';
  document.getElementById('addMatchResults').innerHTML = '';
  await openDetail(id);
  await enterEditMode();
  return id;
}

// ---------- Import (CSV) view ----------

async function handleCsvImport(event) {
  const file = event.target.files[0];
  if (!file) return;
  const text = await file.text();
  const parsedBooks = csv.csvToBooks(text);
  parsedBooks.forEach((book) => { addCategoryIfNew(book.category); addSourceIfNew(book.source); });
  const result = await db.bulkAddBooks(parsedBooks);

  const recap = document.getElementById('importRecap');
  let html = `<div class="recap-line"><strong>${result.added} book(s) added.</strong></div>`;
  if (result.skipped.length > 0) {
    html += `<div class="recap-line">${result.skipped.length} skipped as duplicates:</div>`;
    result.skipped.forEach((s) => {
      html += `<div class="recap-line recap-skip">${escapeHtml(s.title)} — ${escapeHtml(s.author)}</div>`;
    });
  }
  recap.innerHTML = html;
  event.target.value = ''; // allow re-selecting the same file later
  renderListView();
}

// ---------- Backup / Restore view ----------

async function handleBackupNow() {
  const books = await db.getAllBooks();
  const json = JSON.stringify(books, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateStr = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `book-library-backup-${dateStr}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Wipes local book data and replaces it wholesale with the given array,
 * rebuilding categoryList/sourceList from scratch to match. Used by
 * Restore from Backup File - see CLAUDE_CONTEXT.md's "Restore is the one
 * place the category list gets reset" section for why this resets rather
 * than merges.
 */
async function replaceAllBooksWithBackup(books) {
  await db.clearAllBooks();
  categoryList = [];
  saveCategoryList(categoryList);
  sourceList = [];
  saveSourceList(sourceList);
  for (const book of books) {
    const { id, ...rest } = book; // let IndexedDB assign fresh ids
    await db.addBook(Object.assign(db.emptyBook(), rest));
    addCategoryIfNew(rest.category);
    addSourceIfNew(rest.source);
  }
}

async function handleRestoreFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (!confirm('Restoring will replace all current book data with the contents of this backup. Continue?')) {
    event.target.value = '';
    return;
  }
  const text = await file.text();
  let books;
  try {
    books = JSON.parse(text);
    if (!Array.isArray(books)) throw new Error('Backup file is not a valid book list.');
  } catch (e) {
    alert('Could not read this backup file: ' + e.message);
    event.target.value = '';
    return;
  }
  await replaceAllBooksWithBackup(books);
  event.target.value = '';
  alert(`Restored ${books.length} book(s).`);
  renderListView();
}

// ---------- Wiring ----------

function wireEvents() {
  // Tab bar navigation
  document.getElementById('tabLibrary').addEventListener('click', () => {
    state.listMode = 'status';
    showView('listView');
    renderListView();
  });
  document.getElementById('tabAdd').addEventListener('click', () => { showView('addView'); });
  document.getElementById('tabImport').addEventListener('click', () => showView('importView'));
  document.getElementById('tabBackup').addEventListener('click', () => showView('backupView'));

  // Search
  document.getElementById('searchInput').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderListView();
  });

  // Status / Authors / Categories / Series segmented control
  document.querySelectorAll('#librarySegmented .segment').forEach((seg) => {
    seg.addEventListener('click', () => {
      state.listMode = seg.dataset.mode;
      renderListView();
    });
  });

  // Drill-down back button: return to whichever index (authors/categories/series) led here
  document.getElementById('libraryDrilldownBackBtn').addEventListener('click', () => {
    state.listMode = DRILLDOWN_PARENT_MODE[state.drilldownType];
    state.drilldownType = null;
    state.drilldownValue = null;
    renderListView();
  });

  // Delegated click handling for all list rows (book rows + Authors/Categories/Series index rows).
  // Attached once to the container, which is never replaced - only its children are
  // rebuilt on each render, so this avoids re-attaching (and any risk of losing) a
  // listener on every individual row every time the list re-renders.
  document.getElementById('listContent').addEventListener('click', (e) => {
    if (e.target.closest('.row-action-btn')) return; // handled by its own listener
    const row = e.target.closest('.row');
    if (!row) return;
    if (row.dataset.bookId) {
      openDetail(Number(row.dataset.bookId));
    } else if (row.dataset.indexType) {
      openDrilldown(row.dataset.indexType, row.dataset.indexValue);
    }
  });

  // Detail view nav
  document.getElementById('detailBackBtn').addEventListener('click', () => { showView('listView'); renderListView(); });
  document.getElementById('editEnterBtn').addEventListener('click', enterEditMode);
  document.getElementById('editCancelBtn').addEventListener('click', renderDetailView);
  document.getElementById('editDoneBtn').addEventListener('click', saveEdit);
  document.getElementById('markReadBtn').addEventListener('click', markCurrentBookRead);
  document.getElementById('refreshOnlineBtn').addEventListener('click', refreshCurrentBookFromOnline);
  document.getElementById('deleteBookBtn').addEventListener('click', deleteCurrentBook);
  document.getElementById('editCoverFileInput').addEventListener('change', handleCoverFileSelected);
  document.getElementById('editCover').addEventListener('paste', handleCoverPaste);
  document.getElementById('editCategory').addEventListener('change', handleCategorySelectChange);
  document.getElementById('editSource').addEventListener('change', handleSourceSelectChange);

  // Detail view - match preview mode (reached from Add Book or Refresh from Online Sources)
  document.getElementById('previewBackBtn').addEventListener('click', cancelMatchPreview);
  document.getElementById('previewAddBtn').addEventListener('click', confirmMatchPreview);

  // Detail view - refresh matches picker (reached from "Refresh from Online Sources")
  document.getElementById('refreshMatchesCancelBtn').addEventListener('click', cancelRefreshMatches);

  // Add Book view
  document.getElementById('addSearchBtn').addEventListener('click', searchAddMatches);
  document.getElementById('addBlankBtn').addEventListener('click', addBookBlank);

  // Import view
  document.getElementById('csvFileInput').addEventListener('change', handleCsvImport);

  // Backup view
  document.getElementById('backupNowBtn').addEventListener('click', handleBackupNow);
  document.getElementById('restoreFileInput').addEventListener('change', handleRestoreFile);
}

/**
 * One-time-per-book migration for source's old array shape (source used to
 * be a multi-select array, e.g. ['Kindle', 'Personal'], before it became a
 * single-select string). Any book still holding an array gets rewritten to
 * just its first entry - matches the "keep the first one" rule CSV import
 * and Restore already apply going forward (see csv.js/handleRestoreFile).
 * Runs on every startup but is a cheap no-op once every book has already
 * been migrated, since Array.isArray(book.source) is false from then on.
 */
async function migrateLegacyArraySource() {
  const books = await db.getAllBooks();
  for (const book of books) {
    if (Array.isArray(book.source)) {
      await db.updateBook(book.id, { source: book.source[0] || '' });
    }
  }
}

let appInitialized = false;

async function init() {
  if (appInitialized) return; // guard against duplicate DOMContentLoaded firings
  appInitialized = true;

  document.getElementById('libraryTitle').textContent = LIBRARY_NAME;
  document.getElementById('libraryVersion').textContent = APP_VERSION;
  wireEvents();
  try {
    await migrateLegacyArraySource();
    await renderListView();
    showView('listView');
  } catch (err) {
    // Surface startup failures instead of leaving the screen blank.
    // Most common cause: IndexedDB is unavailable (e.g. the page was opened
    // directly from disk as a file:// URL, where some browsers block it).
    document.getElementById('listContent').innerHTML = `
      <div class="empty-state">
        <strong>Couldn't start the app.</strong><br><br>
        ${escapeHtml(err.message || String(err))}<br><br>
        This usually happens when the page is opened directly from a file
        (file://) rather than served over http/https - some browsers block
        local storage in that mode. Try hosting it (e.g. GitHub Pages) or
        opening it via a local web server.
      </div>
    `;
    showView('listView');
    console.error('App failed to initialize:', err);
  }
}

document.addEventListener('DOMContentLoaded', init);
