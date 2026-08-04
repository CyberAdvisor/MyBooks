# MyBooks

A simple personal book tracker: keep a list of what you're reading, waiting on, and have finished, with ratings, notes, and covers - no account, no ads, no social feed.

This repo has two parts: a landing page at the root (`index.html`, what mybooks.fyi shows first) and the actual app in `mybooks/`. If you just want the app - to self-host your own private copy without the marketing page - everything you need is inside `mybooks/`.

## What it does

- **Library**, grouped by Status (Reading / To Read / Waiting / Read / Archive) with collapsible sections and a search bar, or browsed by an Authors or Categories index (books with no category fall under "Uncategorized" rather than disappearing from that view). Each row shows title, author, and - when set - series and where you have it (Kindle, Kobo, etc.); rows don't grow blank lines for fields that aren't set. Each book also gets a one-tap quick action to advance it: "Read Now" moves a To Read book into Reading, "To Read" moves a Waiting book into To Read, and "Mark Read" finishes a book you're Reading.
- **Add a book** by searching [Open Library](https://openlibrary.org) - a free public database, no account or API key needed. Clicking a match shows a read-only preview (cover, title, author, category, synopsis) before anything is saved, so you can compare candidates and pick the right edition; nothing is added until you tap Add. You can also add a blank entry manually if there's no good match. (Google Books isn't used for search - see "Filling in covers after a CSV import" below for where it does come in.)
- **Full detail/edit screen** - title, author, series and series number, category, status, star rating (1-5, color-coded), where you have it (Kindle, Kobo, Library, Personal, or add your own), synopsis, and free-text notes
- **Cover images** - set one by clicking the cover and pasting a copied image, or by uploading a photo; both are automatically resized before being stored so a full-resolution phone photo doesn't bloat your library data
- **Refresh from Online Sources** on any book's detail screen - searches again and shows a match picker (even if there's just one result) so you can choose the right edition, then fills in whichever of synopsis/category/cover is still empty from your pick - never overwrites something you've already filled in yourself
- **Import** books in bulk from a CSV file (a ready-to-use example is included: `sample-import.csv`); duplicate title+author pairs are skipped automatically. The CSV format doesn't carry cover images, so imported books start without one - see "Filling in covers after a CSV import" below for how to add them, one at a time or in bulk. There's no fixed category list - it starts empty and grows from whatever category values your CSV rows carry, plus anything you add later via "+ Add new category..." on the Edit screen.
- **Backup / Restore** - export your whole library as a JSON file, or restore from a previously exported one (this replaces everything currently on the device with the backup's contents)

## How it's built

Plain HTML, CSS, and JavaScript, split into a handful of small files - no build step, no framework, no bundler:

```
index.html          Landing page (this is what mybooks.fyi shows first)
images/              Screenshots used on the landing page
CNAME                GitHub Pages custom domain config (mybooks.fyi)
mybooks/             The actual app - this is the part you'd self-host on its own
  index.html          Markup for every screen (Library, Detail/Edit, Add Book, Import, Backup)
  style.css           Visual styling
  js/logic.js         Pure filtering/grouping/indexing - no DOM, no network
  js/db.js            IndexedDB persistence (add/get/update/delete, dedupe-aware bulk add)
  js/api.js           Open Library search and synopsis enrichment
  js/csv.js           CSV import/export
  js/rating.js        1-5 star rating rendering
  js/app.js           Wires everything above to the UI - no business logic of its own
```

It calls the Open Library public API directly from your browser when you search for a book or tap Refresh from Online Sources. No other network calls are made from the app itself - Google Books is used only by a separate, standalone script (see "Filling in covers after a CSV import" below), not from the browser.

## Data storage — read this

**Your library is stored only in your browser's IndexedDB on your device.** This means:

- **No automatic backup or sync, and no account.** There's no server storing anything about your library.
- **Browsers can clear it unexpectedly**, especially on iOS - storage can be evicted under storage pressure, after a restart, or after a period of inactivity. This is a platform limitation, not something the app can prevent.
- **Manual backup/restore is built in** for exactly this reason: open the Backup tab, tap "Backup Now" to download a dated `.json` file, and restore from it later if your library ever disappears.
- **No sharing between devices.** Adding a book on your phone doesn't make it appear on your laptop - each browser/device has its own separate library, though you can move a backup file between devices manually (AirDrop, iCloud Drive, email, whatever you'd normally use to move a file).
- **Your library is never sent anywhere** except the two APIs above, and only when you actively search or refresh - the data about what you own, are reading, or rated never leaves your device otherwise.
- **The code being public does not expose your data** - see the hosting note below.

## Hosting your own copy on GitHub Pages

Recommended over opening `index.html` directly as a downloaded file - iOS Safari specifically can block both IndexedDB and outgoing search requests from a `file://` page, even though desktop browsers usually tolerate it.

**If you just want the app** (no landing page, no marketing copy - just the tracker), upload only what's inside `mybooks/` (`index.html`, `style.css`, the `js/` folder, `sample-import.csv`) to the root of your repo, so the app itself is what visitors land on:

1. Go to [github.com/new](https://github.com/new), create a **public** repository, and don't initialize it with any files.
2. On the repo page, choose **uploading an existing file**, drag in the contents of `mybooks/`, and commit.
3. Go to **Settings → Pages**, set Source to **Deploy from a branch**, branch `main`, folder `/ (root)`, and save.
4. After a minute or so, GitHub gives you a URL like `https://yourusername.github.io/your-repo-name/`. Open that on your phone, then use Safari's **Share → Add to Home Screen** for an app-like icon.

**If you want the landing page too** (mirroring how mybooks.fyi itself is laid out), upload this entire folder as-is - `index.html` and `images/` stay at the repo root, `mybooks/` stays as a subfolder - and the app ends up one level down at `your-site-url/mybooks/`.

### Or use an already-hosted copy

A shared instance is planned at **<https://mybooks.fyi>** (the app itself lives at `mybooks.fyi/mybooks/` - the root domain shows a short landing page first) for anyone who'd rather skip hosting it themselves. Your library is still private and local to your own device even using a shared instance - the app has no backend and no database of its own. Every request it makes (aside from the Open Library lookups) stays in your browser's IndexedDB, regardless of which server happens to be serving the static files. The same storage-eviction caveat above still applies either way, since that's about your browser's storage, not about who's hosting the page.

## Customizing this with Claude

This app was built with [Claude](https://claude.ai). To make changes (add a feature, change the design, fix something), the easiest path is to start a new conversation with Claude and give it context, since a fresh conversation won't know this app's history or the decisions baked into it.

**Included in `mybooks/` for that purpose:**

- `CLAUDE_CONTEXT.md` - a technical primer describing the app's architecture, data model, and a handful of non-obvious gotchas (documented so they don't get silently reintroduced by a future change)
- `logic.test.js` - Node unit tests for the pure logic/CSV/rating/API-parsing functions
- `app.test.js` - integration tests that load the real app into a simulated browser and click through actual user flows

**To customize:**

1. Open a new conversation with Claude.
2. Paste in the contents of `mybooks/CLAUDE_CONTEXT.md`, or attach the file with "here's the context for an app I'm working on."
3. Attach (or paste) `mybooks/index.html` and the `mybooks/js/` files, and describe the change you want.
4. Ask Claude to test its changes - `logic.test.js` and `app.test.js` are there so a change can be checked against behavior that's already been verified, rather than guessing. (Running `app.test.js` requires `npm install jsdom fake-indexeddb` first, from inside `mybooks/`.)
5. Once you have updated files, upload them to your GitHub repo (Add file → Upload files, replacing the old ones) to deploy the change.

## Limitations

- No login, no cloud sync, no cross-device support
- No notifications - you have to open the app to see what's new
- Relies entirely on Open Library data for in-app search - if a book isn't in their database, their data has gaps (missing synopsis, wrong cover, etc.), or their service is temporarily down or overloaded, that carries through to the app. A failed search shows a clear "couldn't reach Open Library" message rather than looking like a broken/empty result, but there's no fallback source - you can still add a book manually via "Add Without a Match" while it's down.
- A cover can be replaced but not cleared once one is set, in this version

## Filling in covers after a CSV import

Importing a CSV brings in title, author, status, notes, and the rest - but not a cover image, since the format doesn't carry one. Two ways to add them afterward:

**One at a time**: open a book's detail screen, tap Edit, and either paste a copied cover image onto the cover thumbnail or use Upload Photo. Fine for a handful of books.

**In bulk, for a whole library at once**: use the standalone `mybooks/refresh_covers_from_google.py` script together with a free Google Books API key. This is the only place Google Books data enters this app at all - it's not called from the browser, for reasons covered in `CLAUDE_CONTEXT.md`.

1. Get a free key: [console.cloud.google.com](https://console.cloud.google.com) → create/select a project → enable the **Books API** → **Credentials** → **Create Credentials → API key**. No billing required.
2. In the app, go to **Backup** and tap **Backup Now** to export your library as a `.json` file.
3. Run the script against that file:
   ```
   python3 refresh_covers_from_google.py backup.json --api-key YOUR_KEY_HERE
   ```
   This only fills in covers that are currently missing - it won't touch books that already have one (add `--force` to replace existing covers too). It writes a new file (`backup_updated.json` by default) rather than overwriting your original export.
4. Back in the app's Backup tab, use **Restore from Backup File** and pick the updated file. This replaces your whole library with its contents, so make sure it's the updated export, not an older one.

Requires Python 3.7+, no packages to install. If you hit `CERTIFICATE_VERIFY_FAILED` on macOS with a python.org install, run `/Applications/Python\ 3.x/Install\ Certificates.command` once (adjust the version number) - that's a one-time system fix for that Python install, not specific to this script.

## License

MIT - see `LICENSE`.
