/**
 * db.js
 * IndexedDB persistence layer for the Book Library app.
 * All functions return Promises. No DOM/UI code lives here.
 */

const DB_NAME = 'book_library';
const DB_VERSION = 1;
const STORE_NAME = 'books';

let dbPromise = null;

/**
 * Opens (and lazily initializes) the IndexedDB database.
 * Safe to call repeatedly - the connection is cached.
 */
function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: 'id',
          autoIncrement: true,
        });
        store.createIndex('title', 'title', { unique: false });
        store.createIndex('author', 'author', { unique: false });
        store.createIndex('category', 'category', { unique: false });
        store.createIndex('status', 'status', { unique: false });
      }
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });

  return dbPromise;
}

/** Returns a fresh, empty book record with all fields defaulted. */
function emptyBook() {
  return {
    title: '',
    author: '',
    status: 'To Read',
    synopsis: '',
    source: 'Kindle', // single value, one of sourceList (app.js) - not where the data came from, where the book itself lives
    category: '',
    series: '',
    seriesNumber: null,
    rating: null,      // one of: 'No Good' | 'Read Once' | 'Read Again' | 'Favorite' | null
    notes: '',
    coverUrl: '',
  };
}

/** Adds a new book record. Returns the new record's id. */
async function addBook(book) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).add(book);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Fetches a single book by id. Resolves null if not found. */
async function getBook(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/** Fetches every book record. */
async function getAllBooks() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/** Applies a partial update (merge) to an existing book record. */
async function updateBook(id, changes) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) {
        reject(new Error(`Book id ${id} not found`));
        return;
      }
      const merged = Object.assign({}, existing, changes, { id });
      const putReq = store.put(merged);
      putReq.onsuccess = () => resolve(merged);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

/** Permanently deletes a book record. */
async function deleteBook(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Wipes all book records. Used internally by restore-from-backup. */
async function clearAllBooks() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Bulk-inserts books (used by CSV import and backup restore), skipping any
 * record whose title+author (case-insensitive, trimmed) already exists.
 * Returns { added: number, skipped: Array<{title, author}> }.
 */
async function bulkAddBooks(newBooks) {
  const existing = await getAllBooks();
  const existingKeys = new Set(
    existing.map((b) => makeDedupeKey(b.title, b.author))
  );

  const added = [];
  const skipped = [];

  for (const book of newBooks) {
    const key = makeDedupeKey(book.title, book.author);
    if (existingKeys.has(key)) {
      skipped.push({ title: book.title, author: book.author });
      continue;
    }
    existingKeys.add(key); // guard against duplicates within the same import batch
    await addBook(Object.assign({}, emptyBook(), book));
    added.push(book);
  }

  return { added: added.length, skipped };
}

/** Normalizes title+author into a comparable dedupe key. Exported for testing. */
function makeDedupeKey(title, author) {
  return `${String(title || '').trim().toLowerCase()}|${String(author || '').trim().toLowerCase()}`;
}

// Exported as a single namespaced object: `db.openDB()`, `db.addBook()`, etc.
// In the browser this becomes `window.db`; under Node (tests) it's module.exports.
const dbExports = {
  openDB,
  emptyBook,
  addBook,
  getBook,
  getAllBooks,
  updateBook,
  deleteBook,
  clearAllBooks,
  bulkAddBooks,
  makeDedupeKey,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = dbExports;
} else if (typeof window !== 'undefined') {
  window.db = dbExports;
}
