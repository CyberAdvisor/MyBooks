# MyBooks contributor guide

## Project layout

This repository is a static GitHub Pages site with no build system or package
manifest.

- The repository root contains the `mybooks.fyi` landing page (`index.html`,
  `style.css`, and `images/`). Keep landing-page work separate from app work.
- `mybooks/` is the self-hostable MyBooks application. It is plain HTML, CSS,
  and browser JavaScript; it is the code path described by the README.
- Both locations currently contain app-like files. Before editing a duplicated
  file, determine which deployed/self-hosted surface the request targets; do
  not copy changes between the root and `mybooks/` by default.
- `CNAME` configures the GitHub Pages custom domain. Do not change it unless
  the hosting domain is explicitly in scope.

## Application boundaries (`mybooks/`)

Keep responsibilities separated:

- `js/app.js`: DOM rendering, navigation, events, and application wiring only.
- `js/logic.js`: pure filtering, grouping, indexing, and status rules.
- `js/db.js`: Promise-based IndexedDB persistence. Build new books from
  `db.emptyBook()`.
- `js/api.js`: Open Library integration and pure result-parsing helpers.
- `js/csv.js`: the app's custom CSV import/export format.
- `js/rating.js`: pure star-rating helpers.

Modules must continue to export for both environments: `module.exports` for
Node tests and `window.<module>` for the browser. Put new business rules in a
testable module rather than in `app.js`.

## Product and data constraints

- Library data is local-only IndexedDB (`book_library` / `books`); it has no
  backend, account, or sync. Preserve backup/restore compatibility.
- Treat `coverUrl` as either an HTTPS URL or a `data:` URI. Covers pasted or
  uploaded through the UI must be resized before persistence.
- The browser app uses Open Library only. Do not add Google Books browser calls
  or embed an API key. `refresh_covers_from_google.py` is the opt-in,
  standalone bulk-cover tool and must keep using a user-supplied key.
- Open Library search failures are errors, not empty result sets. UI callers
  must handle them distinctly from a successful zero-match search.
- Refreshing online metadata may fill only empty synopsis, category, and cover
  fields; it must not overwrite user data.
- Categories are user-managed and `Uncategorized` is a virtual view for blank
  categories, not a normal stored category. Reuse the existing helpers and
  sentinels instead of duplicating their behavior.
- Preserve the dark fixed-theme design. App color changes belong in the
  `:root` custom properties in `mybooks/style.css`, not scattered hex values.

## Testing and verification

From `mybooks/`:

```sh
node logic.test.js
npm install jsdom fake-indexeddb
node app.test.js
python3 refresh_covers_from_google.py --help
```

`logic.test.js` has no third-party dependencies. `app.test.js` is an
integration suite that needs `jsdom` and `fake-indexeddb`; avoid committing
`node_modules/`. Add or update the focused test for behavior changes, then run
the relevant suite(s). The app must be served over HTTPS for realistic
IndexedDB and Open Library testing; do not validate those paths only via
`file://`.

## Working conventions

- Read `README.md` and `mybooks/CLAUDE_CONTEXT.md` before changes that touch
  app behavior; the latter records important compatibility decisions.
- Keep the application framework-free and dependency-light unless the request
  explicitly justifies a change.
- Preserve the custom CSV column order and use `db.makeDedupeKey()` for
  duplicate comparisons.
- Make minimal, focused edits. Do not commit generated backups, downloaded
  covers, API keys, or user library exports.
