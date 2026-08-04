/**
 * logic.js
 * Pure, DOM-free helper functions used by the UI layer (render.js).
 * Kept separate so they can be unit-tested directly under Node.
 */

const STATUS_ORDER = ['Reading', 'To Read', 'Waiting', 'Read', 'Wanted', 'Shelved'];

/**
 * The quick-action button shown on a book's row in the Status list view -
 * what it says and what status tapping it sets. Read, Wanted, and Shelved
 * don't get one (nothing further to advance them to from the list view).
 */
const STATUS_QUICK_ACTIONS = {
  'Reading': { label: 'Mark Read', nextStatus: 'Read' },
  'To Read': { label: 'Read Now', nextStatus: 'Reading' },
  'Waiting': { label: 'To Read', nextStatus: 'To Read' },
};

/** Returns the quick-action { label, nextStatus } for a status, or null if it doesn't get one. */
function getStatusQuickAction(status) {
  return STATUS_QUICK_ACTIONS[status] || null;
}

/**
 * Filters books by a free-text query against title, author, or category
 * (case-insensitive substring match). Empty/blank query returns all books.
 */
function filterBooks(books, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return books;
  return books.filter((b) => {
    return (
      (b.title || '').toLowerCase().includes(q) ||
      (b.author || '').toLowerCase().includes(q) ||
      (b.category || '').toLowerCase().includes(q)
    );
  });
}

/**
 * Groups books by Status into the fixed display order, each group's books
 * sorted alphabetically by title. Statuses with zero books are still
 * included (as empty arrays) so the UI can render a "0" count section.
 */
function groupBooksByStatus(books) {
  const groups = {};
  STATUS_ORDER.forEach((status) => { groups[status] = []; });

  books.forEach((book) => {
    const status = STATUS_ORDER.includes(book.status) ? book.status : 'To Read';
    groups[status].push(book);
  });

  STATUS_ORDER.forEach((status) => {
    groups[status].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  });

  return STATUS_ORDER.map((status) => ({ status, books: groups[status] }));
}

/**
 * Builds an alphabetically-grouped Authors index from a list of books:
 * one entry per distinct (trimmed) author string, with a book count,
 * grouped by first letter. Blank author strings are excluded.
 * Sorted first-name-first (the raw author string as entered) - no
 * last-name extraction or multi-author splitting.
 */
function buildAuthorsIndex(books) {
  const counts = new Map();
  books.forEach((book) => {
    const name = (book.author || '').trim();
    if (!name) return;
    counts.set(name, (counts.get(name) || 0) + 1);
  });

  const authors = Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const groups = [];
  let currentLetter = null;
  authors.forEach((author) => {
    const letter = author.name.charAt(0).toUpperCase();
    if (letter !== currentLetter) {
      groups.push({ letter, authors: [] });
      currentLetter = letter;
    }
    groups[groups.length - 1].authors.push(author);
  });
  return groups;
}

/**
 * Builds the Categories index from the fixed category list, in the given
 * (fixed) order, with a book count per category. Categories with zero
 * matching books are still included, at count 0. An "Uncategorized" entry
 * is always appended last, counting books with no category set - without
 * it those books would have nowhere to show up in this view.
 */
function buildCategoriesIndex(books, categoryList) {
  const named = categoryList.map((name) => ({
    name,
    count: books.filter((b) => b.category === name).length,
  }));
  const uncategorizedCount = books.filter((b) => !b.category).length;
  return [...named, { name: 'Uncategorized', count: uncategorizedCount }];
}

/**
 * Builds an alphabetically-grouped Series index from a list of books, the
 * same shape as buildAuthorsIndex: one entry per distinct (trimmed) series
 * name, with a book count, grouped by first letter. Blank series are
 * excluded entirely - series is optional per-book metadata, like source,
 * so there's no "no series" bucket the way Categories has "Uncategorized".
 */
function buildSeriesIndex(books) {
  const counts = new Map();
  books.forEach((book) => {
    const name = (book.series || '').trim();
    if (!name) return;
    counts.set(name, (counts.get(name) || 0) + 1);
  });

  const series = Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const groups = [];
  let currentLetter = null;
  series.forEach((s) => {
    const letter = s.name.charAt(0).toUpperCase();
    if (letter !== currentLetter) {
      groups.push({ letter, series: [] });
      currentLetter = letter;
    }
    groups[groups.length - 1].series.push(s);
  });
  return groups;
}

/** Books by a specific author (exact, trimmed match), sorted alphabetically by title. */
function booksByAuthor(books, authorName) {
  return books
    .filter((b) => (b.author || '').trim() === authorName)
    .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
}

/**
 * Books in a specific series (exact, trimmed match), sorted by series
 * number when present (numbered before unnumbered), then by title.
 */
function booksBySeries(books, seriesName) {
  return books
    .filter((b) => (b.series || '').trim() === seriesName)
    .sort((a, b) => {
      const an = a.seriesNumber, bn = b.seriesNumber;
      if (an != null && bn != null) return an - bn;
      if (an != null) return -1;
      if (bn != null) return 1;
      return (a.title || '').localeCompare(b.title || '');
    });
}

/**
 * Books in a specific category, sorted alphabetically by title.
 * "Uncategorized" is a virtual category matching any book with no
 * category set, rather than an exact match against that literal string.
 */
function booksByCategory(books, categoryName) {
  const matchesCategory = categoryName === 'Uncategorized'
    ? (b) => !b.category
    : (b) => b.category === categoryName;
  return books.filter(matchesCategory).sort((a, b) => (a.title || '').localeCompare(b.title || ''));
}

const logicExports = {
  STATUS_ORDER, filterBooks, groupBooksByStatus,
  buildAuthorsIndex, buildCategoriesIndex, buildSeriesIndex,
  booksByAuthor, booksByCategory, booksBySeries,
  getStatusQuickAction,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = logicExports;
} else if (typeof window !== 'undefined') {
  window.logic = logicExports;
}
