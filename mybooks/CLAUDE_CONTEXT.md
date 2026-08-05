# Context for Claude: "MyBooks" book library tracker

Paste this into a new conversation before asking for changes. It exists so a fresh conversation doesn't have to rediscover the gotchas below the hard way.

This file lives in `mybooks/`, alongside the app it describes. The repo root above it holds a separate, unrelated landing page (`index.html`, `images/`) that mybooks.fyi shows before linking into this app - nothing in this document applies to that landing page.

## What this is

A multi-file (not single-file) HTML/CSS/vanilla-JS app - `index.html`, `style.css`, and six modules under `js/` - that tracks a personal book collection: status (Reading/To Read/Waiting/Read/Wanted/Shelved), ratings, notes, and browsing by Authors, Categories, or Series. No build step, no framework, no bundler. Online search (for adding books and filling in cover/synopsis/category) comes from Open Library, a free/no-key public API. Built for personal, non-technical daily use: simple, readable, no accounts, no ads.

Google Books is deliberately NOT called from the app itself - see "Google Books: script-only, not in-app" below for why, and `refresh_covers_from_google.py` (in this same folder) for where it actually lives.

The Status view's search bar (`logic.filterBooks()`) matches a free-text query against title, author, category, source, synopsis, and notes - a case-insensitive substring check across all six, not a scoped/field-specific search.

## Visual style: dark, iOS-inspired, one palette (not adaptive)

Every color in `style.css` routes through the `:root` custom properties at the top of the file (`--bg`, `--card`, `--blue`, `--label`, etc., plus a few fill/tint helpers: `--fill`, `--fill-raised`, `--blue-tint`, `--placeholder`). The app is dark-themed, fixed - it doesn't switch based on `prefers-color-scheme` or a toggle, it's just always dark. If you touch color anywhere, change the variable in `:root`, not a one-off hex value in a selector; a `grep -n "#" style.css` should only ever turn up the `:root` block itself (plus the star-rating red/yellow/green tiers, which are intentionally hardcoded since they're semantic tier colors, not theme colors). The root landing page (`index.html`, one level up) is a separate file with its own independent copy of a similar dark palette - the two aren't linked, so a change to one doesn't propagate to the other.

## Architecture: why it's six files, not one

Unlike some similar single-file Claude-built apps, this one deliberately separates DOM wiring from logic:

- `js/logic.js` - pure functions: filtering, grouping, Authors/Categories/Series indexing. No DOM, no fetch, no IndexedDB.
- `js/db.js` - IndexedDB persistence (CRUD + dedupe-aware bulk add). Browser-API-dependent but DOM-free; testable under Node with `fake-indexeddb`.
- `js/api.js` - Open Library search and synopsis enrichment (the only online source the app itself calls - see below). The parsing/selection functions (`parseOpenLibraryResults`, `chooseCoverUrl`, `fillEmptyFields`, `isProbablyEnglish`, etc.) are pure and Node-testable; the functions that actually call `fetch` are not (they're exercised in `app.test.js` with `api.findMatches`/`api.enrichMatchSynopsis` stubbed at the module level, not by mocking raw HTTP responses).
- `js/csv.js` - CSV import/export, a from-scratch format (not matched to any external tool's schema).
- `js/rating.js` - the 1-5 star rating: color-tier mapping and glyph rendering.
- `js/app.js` - the DOM controller. Wires the above to the UI. **Should contain no business logic of its own** - if you're adding a filtering/parsing/persistence rule, it almost certainly belongs in one of the modules above, not inline in `app.js`, so it stays covered by `logic.test.js` rather than only by the slower `app.test.js` integration tests.

Every module exports the same way: `module.exports` under Node (for tests), `window.<name>` in the browser (e.g. `window.logic`, `window.db`). If you add a new module, follow that exact pattern - see the bottom of any existing `js/*.js` file.

## Data model

Each book, persisted in IndexedDB (database `book_library`, object store `books`, auto-incrementing `id` key), looks like:

```js
{
  id: 1,                    // auto-assigned by IndexedDB
  title: '', author: '',
  status: 'To Read',        // one of logic.STATUS_ORDER: Reading, To Read, Waiting, Read, Wanted, Shelved
  synopsis: '', notes: '',
  source: 'Kindle',          // single string, one of sourceList (app.js) or '' - where you have/read it, not where the data came from. Defaults to 'Kindle' on a new book (db.emptyBook()).
  category: '',              // '' means uncategorized - see below
  series: '', seriesNumber: null,
  rating: null,               // integer 1-5, or null
  coverUrl: '',                // an https:// URL (from search) OR a data: URI (pasted/uploaded) - same field either way, see below
}
```

`db.emptyBook()` is the canonical default shape - always build new records by spreading over it (`Object.assign(db.emptyBook(), {...})`), not by hand, so a future new field gets a sane default everywhere automatically.

### Why IndexedDB, not localStorage

Chosen up front for `coverUrl` support - a pasted/uploaded cover can be a multi-hundred-KB `data:` URI, and `localStorage` has a small (typically ~5MB *total*) synchronous string quota that covers would burn through fast. IndexedDB has a much larger (browser-dependent, typically hundreds of MB+) asynchronous quota, which is why every `db.js` function returns a Promise.

## The category list: user-built, not fixed

There's no hardcoded list of categories. `categoryList` (`app.js`) starts empty and is persisted to `localStorage` (`CATEGORY_STORAGE_KEY`), growing five ways, all funneling through `addCategoryIfNew()`: CSV import folds in any non-blank `category` values it sees (called from `handleCsvImport()`); Restore from Backup rebuilds it from scratch from the restored books (see below - this one resets rather than folds in); the Edit screen's category `<select>` has a trailing "+ Add new category..." option (`ADD_NEW_CATEGORY_VALUE` sentinel, handled by `handleCategorySelectChange()`) that prompts for a name and adds it; `addBookFromPreview()` (Add Book, after picking a search match) registers `match.category`; and `applyRefreshMatch()` (Refresh from Online Sources) registers `changes.category` when `api.fillEmptyFields()` fills one in. **Any code path that sets a book's `category` from an external source (search, import, restore, etc.) needs an `addCategoryIfNew()` call alongside it** - it's not automatic just because the field got written to IndexedDB. Without it, a book can carry a real `category` value that was never added to `categoryList`: `buildCategoriesIndex()` only shows entries actually in `categoryList` (plus the synthetic "Uncategorized" bucket for books with none), so such a book has nowhere to be counted and silently vanishes from the Categories view entirely - not even landing in "Uncategorized", since it does have a category, just an unregistered one. `addCategoryIfNew()` dedupes case-insensitively and keeps the list alphabetically sorted; `getCategoryList()` is the read-only accessor other code (and the test suite) should use, since `categoryList` itself is a `let` binding and so isn't reachable as `window.categoryList`.

**Restore is the one place the category list gets reset, not just added to.** `handleRestoreFile()` sets `categoryList = []` (and persists that immediately, before the restore loop) rather than calling `addCategoryIfNew()` on top of whatever was already there, then rebuilds it purely from the restored books' `category` fields. This matches Restore's existing "replace all current book data" semantics (see its own confirm() prompt) - a backup file only contains the books array (see `handleBackupNow()` - there's no separately-exported category list), so the category list is derived data that should end up reflecting exactly what's in the restored books, not a merge with pre-restore categories that may no longer apply to anything. Without this reset step, restoring onto a fresh browser (or one with different existing categories) would leave the Categories view showing only "Uncategorized" until something re-populated it by hand.

## The "Uncategorized" virtual category

`category: ''` is a valid, common state (a book added via "Add Without a Match" starts uncategorized, and search matches don't always carry a category). The Categories view needs somewhere to show these books, but `''` is deliberately **not** a real entry in `categoryList` or something a user can pick from the Edit screen's Category dropdown.

Instead, `logic.buildCategoriesIndex()` always appends a synthetic `{ name: 'Uncategorized', count: <n> }` entry after the real categories, and `logic.booksByCategory()` treats the literal string `'Uncategorized'` as a special case matching `!b.category` rather than doing its normal exact match. If a user ever adds a real category actually named "Uncategorized", this collides - `addCategoryIfNew()` doesn't guard against that name specifically.

## The Series index: like Authors, not like Categories

`logic.buildSeriesIndex(books)` is a copy-paste sibling of `buildAuthorsIndex()` - alphabetically grouped by first letter, one entry per distinct trimmed `series` value with a book count - and `logic.booksBySeries(books, name)` an exact-match sibling of `booksByAuthor()`, except sorted by `seriesNumber` first (numbered entries before unnumbered, then by number) rather than by title alone, so a drilldown reads in reading order. Unlike Categories, there's **no "no series" bucket** - a blank/missing `series` just means the book doesn't show up in the Series index at all, the same way a blank author is silently excluded from the Authors index. `series` is optional per-book metadata (like `source`), not a required classification (like `category`, which is why Categories alone gets the "Uncategorized" catch-all).

Each entry in `buildSeriesIndex()`'s output also carries `author` - the most common (trimmed) author among that series' books, picked by a small internal tally rather than assuming the first book found is representative. It's shown as a subtitle under the series name (`buildIndexRow()` in `app.js` gained a fourth, optional `subtitle` param for this, rendered with the `.row-author` class - the same small/light style a book row uses for its own author line - and omitted as a whole `<div>`, not an empty one, when there's nothing to show). Series are effectively always single-author in practice, so "most common" and "the" author agree almost all the time; this only matters on an edge case (co-author swap partway through a series, a stray typo) and isn't meant to be authoritative for those - just a reasonable label, not a data-integrity check.

Wiring in `app.js`: `state.listMode` can be `'series'` (alongside `'status'`/`'authors'`/`'categories'`/`'drilldown'`) and `state.drilldownType` can be `'series'` (alongside `'author'`/`'category'`). Two small lookup maps drive the three-way dispatch: `DRILLDOWN_LOOKUPS` (type -> the `logic.booksBy*` function to call) drives `renderDrilldownMode()`, and `DRILLDOWN_PARENT_MODE` (type -> which segmented-control mode the "‹ Back" button returns to) drives the drilldown back button. If you add a fourth browsable dimension, extend those two maps plus `renderListView()`'s dispatch and the `<button class="segment" data-mode="...">` row in `index.html` - that's the whole surface area.

## Add Book: preview before persisting

Clicking a search match does **not** immediately save it. `openMatchPreview()` shows the candidate (cover/title/author/category/synopsis) in the Detail view's third nav mode (`setDetailMode('preview')`, alongside the existing `'view'`/`'edit'` modes) with `‹ Matches` / `Add` in the nav bar - nothing is written to IndexedDB until `Add` is tapped (`addBookFromPreview()`). `‹ Matches` just discards the preview and returns to the still-populated match list.

`setDetailMode()` also toggles `#detailNotesGroup` and `#detailActionsGroup` (Mark as Read / Refresh / Delete) to hidden during `'preview'` - those don't apply to a book that isn't saved yet. If you add another field to the read-only Detail view, decide whether it belongs in preview mode too and update `renderMatchPreview()` accordingly (it currently only shows title/author/cover/category/synopsis, deliberately less than the full `renderDetailView()`).

"Add Without a Match" (blank entry) does **not** go through preview - it calls `addBookAndGoToDetail()` directly into edit mode, since there's no candidate to review.

## Cover images: paste, upload, resize - and no way to clear

A cover can be set two ways in Edit mode, both landing in the same place:

- **Paste**: click the cover thumbnail (it's `tabindex="0"` specifically so it can receive focus and therefore a `paste` event) and Cmd/Ctrl+V an image copied from anywhere. `handleCoverPaste()` reads `event.clipboardData.items`, looks for an `image/*` item, and bails out (no `preventDefault()`, no state change) if there isn't one - so pasting text elsewhere on the page is unaffected.
- **Upload**: the "Upload Photo" button is a `<label for="editCoverFileInput">` over a hidden `<input type="file">` (same pattern as the existing CSV/backup file pickers) - `handleCoverFileSelected()` handles the `change` event.

Both paths call `resizeImageToDataUrl(blob)`, which downscales to at most `MAX_COVER_DIMENSION` (600px) on the long edge and re-encodes as JPEG at quality 0.85 via an offscreen `<canvas>`, before storing the result as `state.editCoverValue` - **this is what keeps a full-resolution phone photo from bloating IndexedDB.** If canvas processing fails for any reason, it falls back to the original un-resized data URL rather than losing the image entirely.

`state.editCoverValue` is the single working copy of the cover during an edit session - initialized from `book.coverUrl` in `enterEditMode()`, updated live by both paste and upload, read directly by `saveEdit()`. There is **deliberately no URL text field and no "Remove Cover" control** - this was scoped down explicitly (see chat history / product decisions below if you have access to it, otherwise: it's a known, accepted limitation, not an oversight). If you're asked to add cover removal, the simplest fix is setting `state.editCoverValue = ''` from a new button and calling `updateEditCoverPreview()`.

## Source: single-select dropdown, identical mechanism to Category

`source` is a single string (one of `sourceList`, or `''`), not an array - a book has exactly one source, edited via a plain `<select id="editSource">` (no intermediate `state` field; `saveEdit()` reads it directly). `sourceList` (`app.js`) is a dynamic, `localStorage`-persisted list (`SOURCE_STORAGE_KEY`) that works exactly like `categoryList`: grown via `addSourceIfNew()` from CSV import, the Edit screen's "+ Add new source..." sentinel (`buildSourceSelect()`/`handleSourceSelectChange()`, a copy-paste sibling of `buildCategorySelect()`/`handleCategorySelectChange()`), and reset-and-rebuilt on Restore from Backup. The one difference from `categoryList`: `sourceList` seeds itself with `DEFAULT_SOURCE_SEED` (`['Library', 'Kobo', 'Kindle', 'Yomu']`), sorted alphabetically, the first time it's loaded on a browser with nothing in `localStorage` yet, rather than starting blank - `loadSourceList()` falls back to the sorted seed (and immediately persists it) instead of `[]`. `db.emptyBook()` defaults a new book's `source` to `'Kindle'`.

A book can only ever have one source, by design - if a need for multiple sources per book comes up, a native `<select multiple>` is worth trying before any hand-rolled popover/chip UI; a popover-based approach here previously had a real, hard-to-spot bug (a `.field-group` ancestor's `overflow: hidden` silently clipped it off-screen on narrower viewports) that `app.test.js` couldn't catch, since jsdom doesn't do real CSS layout/paint - it only confirmed elements existed in the DOM, not that they were visibly on-screen. Any future popover/menu in this app should be checked by hand for the same risk.

Some books may still hold source in the old array shape (from before source was single-select) if their data predates this change. `migrateLegacyArraySource()`, called from `init()` before the first render, scans every book and rewrites any `Array.isArray(book.source)` record to `book.source[0] || ''` via `db.updateBook()` - cheap to leave running on every startup, since it's a no-op once a book's `source` is already a string.

## Status list quick-action buttons

Each book row in the Status list view (not Authors/Categories/Series) gets an optional one-tap button, driven entirely by `logic.getStatusQuickAction(status)` (returns `{ label, nextStatus }` or `null`): Reading -> "Mark Read" -> `Read`; To Read -> "Read Now" -> `Reading`; Waiting -> "To Read" -> `To Read`; Read, Wanted, and Shelved get no button at all. `buildBookRow()` in `app.js` is the only caller, taking just the book. If you add a new status to `STATUS_ORDER`, decide whether it needs an entry in `STATUS_QUICK_ACTIONS` too - it won't get a button by default; a status with no automatic "next step" signal to hang a button on (like `Wanted`) should stay out of `STATUS_QUICK_ACTIONS` deliberately. The CSS class is `.row-action-btn` - the delegated click handler in `wireEvents()` checks for this class to avoid also triggering the row's own "open detail" click.

Current order: `Reading, To Read, Waiting, Read, Wanted, Shelved`. `Wanted` is for books you'd like to add to your library but don't own yet (distinct from `Waiting`, which is for a copy already being acquired - a hold placed, a pre-order, etc.); `Shelved` is for books you own but don't intend to read (e.g. no longer relevant). Both are grouped at the end since they're "not actively being read" states, `Wanted` first (earliest lifecycle stage: want it, don't have it) and `Shelved` last (have it, not reading it). Since `status` is stored as this literal string in IndexedDB, renaming or removing a status is a breaking change for any book already persisted with the old value - `groupBooksByStatus()` silently reassigns any status not in `STATUS_ORDER` to "To Read" rather than erroring, so a rename that needs to preserve existing data will want a one-time migration pass in `init()` (rewriting old values via `db.updateBook()`, the same pattern `migrateLegacyArraySource()` uses for `source` - see above).

`buildBookRow()` builds its text block from up to four conditional lines - title, author, series (`.row-series`, only when `book.series` is set), and source (`.row-source`, only when `book.source` is set). Both series and source are omitted as whole `<div>`s when unset, not rendered as empty lines - don't change either to a fallback like `'—'` without checking `app.test.js`'s "show source as a 4th line only when the book has one" test, which asserts `.row-source` is `null` (not just empty) when there's no source.

## Refresh from Online Sources: shares the Add Book preview screen

Like Add Book, tapping "Refresh from Online Sources" on a saved book's Detail screen does not silently apply anything. `refreshCurrentBookFromOnline()` searches (`api.findMatches`) and, if there's at least one result, shows a picker (`setDetailMode('refresh-matches')`, a fourth Detail-view nav/content mode alongside `'view'`/`'edit'`/`'preview'`, rendered into `#refreshMatchesList` via `renderRefreshMatchesList()`) - this happens even for exactly one match, for consistency with Add Book's own always-preview behavior. Zero matches still shows the original "No matches found" alert with no picker.

Picking a candidate (`openRefreshPreview()`) reuses the exact same preview screen Add Book uses (`renderMatchPreview()`, `setDetailMode('preview')`) rather than a separate implementation - the two flows are distinguished by `state.previewContext` (`'add'` | `'refresh'`), which `renderMatchPreview()` reads to relabel the right-hand nav button ("Add" vs "Apply") and `confirmMatchPreview()` reads to dispatch to the right action (`addBookFromPreview()` vs `applyRefreshMatch()`). `cancelMatchPreview()` similarly branches on `previewContext` for where "‹ Matches" returns to - the Add Book match list, or back to `refresh-matches` (the picker list is left populated, not re-fetched).

`applyRefreshMatch()` runs the picked match through `api.fillEmptyFields()` - only ever fills fields that are currently empty on the book, never overwrites something already there - and shows a "no new information" alert if the picked match had nothing left to offer. If you add a new mode to the Detail view in the future, remember `setDetailMode()` is the single place that owns showing/hiding all four nav rows and both content containers (`viewMode`, which preview also uses, and `editModeBlock`) - don't toggle `style.display` on these elements anywhere else, or modes will drift out of sync with each other.

## api.js: search failures throw, they don't degrade to an empty result

- **`searchOpenLibrary()` throws on failure - a rejected `fetch` (network/CORS) or a non-ok HTTP status (e.g. Open Library returning 503 while overloaded) - instead of resolving to `[]`.** Only a genuine zero-result search (a successful request that just found nothing) resolves to `[]`; anything that failed to complete throws an `Error` with a short, already-user-presentable message (still `console.warn`s the fuller technical detail first, for debugging) - this keeps "the service is down, try later" distinguishable from "this book genuinely isn't in Open Library's database" rather than both reading as the same silent nothing. Both call sites - `searchAddMatches` in Add Book and `refreshCurrentBookFromOnline` in Refresh - catch this and show it distinctly from the "No matches found" message (inline in the results area for Add Book, via `alert()` for Refresh, matching how each flow already surfaces the zero-result case). If you add a third caller of `findMatches`/`searchOpenLibrary`, it needs the same try/catch - don't let a thrown error surface as an unhandled rejection.
- **`enrichMatchSynopsis`/`fetchOpenLibraryDescription` deliberately still fail silently** (return `''`/the match unchanged) rather than throwing - unlike the primary search, this is enrichment on a match that already succeeded, so losing just the synopsis shouldn't block the whole Add Book / Refresh flow the way a failed primary search should.
- **Search** (`findMatches`) is a thin wrapper around `searchOpenLibrary()` - kept as a named function (rather than callers using `searchOpenLibrary` directly) so the two call sites (`searchAddMatches` in Add Book, `refreshCurrentBookFromOnline` in Refresh) have a stable name to call even if the underlying source ever changes. It propagates `searchOpenLibrary`'s thrown errors unchanged.
- **`isProbablyEnglish()`** exists because Open Library work records sometimes have a description in the wrong language attached (e.g. a German edition's blurb on an English work), with no reliable per-description language tag to check against. It's a heuristic - frequency of common English function words - not a real language detector. Both the work-level and per-edition description fetches are filtered through it, and a non-English match is treated the same as no match (keeps searching editions).
- **`fillEmptyFields()`** (used by "Refresh from Online Sources" on the Detail screen) only ever fills currently-empty fields (`synopsis`, `category`, `coverUrl`) - it will never overwrite something the user already entered, even with better data from a fresh search.
## Google Books: script-only, not in-app

Google Books is deliberately not called from the app itself, either as a search fallback or to prefer its covers over Open Library's (Open Library covers are frequently reader-submitted photos of a physical, often well-worn copy - Google Books' tend to be cleaner). The reason: Google Books' keyless/anonymous quota is a small pool shared across *every* unkeyed request on the internet, not scoped per-app or per-user, so it's already exhausted (HTTP 429) for most users before the app would ever get a chance to use it - a personal API key fixes this, but baking one key into shared/distributed code just moves the same shared-quota problem onto that one key instead, which doesn't scale for a hosted instance with multiple visitors.

Google Books is still available, just outside the browser: `refresh_covers_from_google.py` (repo root) is a standalone Python script, unrelated to any file in `js/`, that reads a Backup-exported JSON file, looks up each book missing a cover via the Google Books API using a personal API key you supply yourself, and writes an updated JSON file to Restore back into the app. If you're asked to "add Google Books back to search" or similar, revisit this tradeoff explicitly rather than just re-adding the old code - the shared-quota problem is real and will resurface identically.

## CSV format

Custom, not matched to Goodreads/LibraryThing/any external export schema. Column order: `title,author,status,synopsis,source,category,series,seriesNumber,rating,notes`. `source` holds a single value (e.g. `Kindle`) - same as `category`, one selection only; an old-style semicolon-separated cell (`Kindle;Personal`, from before source was single-select) still imports fine, keeping just the first value. Standard RFC 4180 quoting for commas/quotes/newlines. Import (`db.bulkAddBooks`) skips any row whose `title`+`author` (trimmed, case-insensitive) already exists - `db.makeDedupeKey()` is the single source of truth for that comparison; use it rather than re-implementing the normalization if you touch dedupe logic elsewhere. `sample-import.csv` in the repo root is a ready-to-use example covering quoted fields and blank optional fields.

## Hosting requirement: must be served over https, not opened as a local file

Two independent reasons, both platform limitations rather than app bugs:

1. **IndexedDB can be unavailable under `file://`** in some browsers - `init()` in `app.js` specifically catches startup failures and shows a message pointing this out, rather than leaving a blank screen.
2. **iOS Safari blocks `fetch()` to remote APIs from `file://` pages** (confirmed pattern in similar apps) - this would silently break the Add Book search feature (the Open Library call) on an iPhone even if IndexedDB itself happened to work.

Desktop browsers are generally more forgiving of both than iOS Safari. If you're testing a change that touches network requests or IndexedDB and it needs to work on iPhone, test it from a real `https://` URL (e.g. `npx serve .`, or a pushed GitHub Pages deploy), not just by double-clicking `index.html`.

## Testing

- `logic.test.js` - plain Node unit tests for `logic.js`, `csv.js`, `rating.js`, and the pure parsing/selection functions in `api.js`. No dependencies needed. Run with `node logic.test.js`.
- `app.test.js` - integration tests that load the real `index.html` into `jsdom`, give each test its own isolated in-memory IndexedDB (a fresh `fake-indexeddb` `IDBFactory` per test - important: reusing the shared singleton would leak data between tests), stub out `api.findMatches`/`api.enrichMatchSynopsis`/`resizeImageToDataUrl` (network and canvas/Image aren't meaningfully testable headlessly) for most tests, and simulate real user flows via actual DOM events. A few tests instead stub `window.fetch` directly (rather than `api.findMatches`) specifically to exercise `api.js`'s real fetch-failure/throw behavior end-to-end, not just that some UI code handles a stubbed rejection correctly. Run with `node app.test.js` (requires `npm install jsdom fake-indexeddb`).

If you make a change, run both files and add a test for whatever you changed before considering it done - an untested field that's rendered somewhere but not actually persisted (or vice versa) is an easy mistake to make silently, and exactly the kind of thing this suite exists to catch.

## Design constraints (user preference, stated explicitly)

- Test that code actually works before presenting it as done.
- Refactor rather than accumulate dead/unused code; keep files internally documented, logically and simply structured.
- No opinions or commentary injected into responses beyond what's explicitly asked for.
- Confirm the approach before writing code for anything non-trivial, rather than guessing at scope.
