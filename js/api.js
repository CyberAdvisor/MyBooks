/**
 * api.js
 * Online source integration: searches Open Library for match candidates
 * and synopsis enrichment when adding or refreshing a book. This is the
 * only network-calling module in the app.
 *
 * Google Books is NOT called from here (or anywhere else in the app) -
 * it's used only via the separate refresh_covers_from_google.py script
 * (repo root), run standalone with your own API key, for bulk-filling
 * covers after a CSV import. That split exists because Google Books'
 * keyless/anonymous quota is a small pool shared across every unkeyed
 * request on the internet, not something scoped to one app or user, so
 * calling it from every visitor's browser was unreliable in practice -
 * see CLAUDE_CONTEXT.md for the full history if you're wondering why
 * this app only has one online source instead of two.
 *
 * Pure parsing/selection logic is separated from fetch calls so it can be
 * unit-tested without a network connection.
 */

/**
 * Picks a cover URL from a list of candidate covers, preferring an ebook
 * edition cover and falling back to a print edition cover.
 * candidates: Array<{ url: string, format: 'ebook' | 'print' | string }>
 * Returns the chosen url, or '' if no candidates.
 */
function chooseCoverUrl(candidates) {
  if (!candidates || candidates.length === 0) return '';
  const ebook = candidates.find((c) => c.format === 'ebook' && c.url);
  if (ebook) return ebook.url;
  const print = candidates.find((c) => c.format === 'print' && c.url);
  if (print) return print.url;
  // Neither explicitly tagged - fall back to the first candidate with a url.
  const any = candidates.find((c) => c.url);
  return any ? any.url : '';
}

/**
 * Parses a raw Open Library search response (docs array) into a normalized
 * list of match candidates for the "Add Book" match picker.
 */
function parseOpenLibraryResults(docs) {
  if (!Array.isArray(docs)) return [];
  return docs.slice(0, 8).map((doc) => {
    const coverCandidates = [];
    if (doc.cover_i) {
      coverCandidates.push({
        url: `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`,
        format: 'print',
      });
    }
    return {
      source: 'openlibrary',
      title: doc.title || '',
      author: Array.isArray(doc.author_name) ? doc.author_name.join(', ') : '',
      synopsis: '', // Open Library search endpoint doesn't return synopsis directly
      category: Array.isArray(doc.subject) ? doc.subject[0] || '' : '',
      coverUrl: chooseCoverUrl(coverCandidates),
      workKey: doc.key || '',
    };
  });
}

/**
 * Searches Open Library by title/author.
 * Returns normalized match candidates (see parseOpenLibraryResults) on
 * success. Throws a short, user-presentable Error on failure - a network
 * error, a CORS block, or a non-2xx HTTP status (e.g. Open Library
 * returning a 503 while overloaded) - rather than swallowing it to an
 * empty array. A genuine zero-result search still resolves to [] normally;
 * only actual failures to reach/use the service throw. This distinction
 * matters to callers: an empty array means "searched fine, nothing
 * matched," while a thrown error means "the search itself didn't
 * complete," and the two need different messaging so a user doesn't read
 * a transient outage as "this app is broken" (see searchAddMatches and
 * refreshCurrentBookFromOnline in app.js, which catch this and show it).
 */
async function searchOpenLibrary(title, author) {
  const params = new URLSearchParams();
  if (title) params.set('title', title);
  if (author) params.set('author', author);
  const url = `https://openlibrary.org/search.json?${params.toString()}`;

  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    // Network failure, or a CORS/extension block that never got an HTTP
    // response at all.
    console.warn(`Open Library search failed: ${e.message} for ${url}`);
    throw new Error("Couldn't reach Open Library - check your connection and try again.");
  }
  if (!res.ok) {
    console.warn(`Open Library search failed: HTTP ${res.status} for ${url}`);
    throw new Error(`Open Library returned an error (HTTP ${res.status}). This is usually temporary - try again in a few minutes.`);
  }
  const data = await res.json();
  return parseOpenLibraryResults(data.docs);
}

/**
 * Lightweight heuristic for "is this text actually English". Open Library
 * work records sometimes have a description in the wrong language attached
 * (e.g. a German edition's blurb on an English work) - there's no reliable
 * per-description language tag to check, so instead we look at how common
 * a set of very frequent English function words are in the text.
 */
function isProbablyEnglish(text) {
  if (!text) return false;
  const words = text.toLowerCase().match(/[a-z']+/g) || [];
  if (words.length < 5) return false;
  const commonEnglishWords = new Set([
    'the', 'and', 'of', 'in', 'to', 'is', 'was', 'with', 'that', 'his',
    'her', 'this', 'an', 'on', 'for', 'as', 'at', 'by', 'from', 'it',
    'he', 'she', 'they', 'their', 'a', 'but', 'are', 'who', 'when',
  ]);
  const matches = words.filter((w) => commonEnglishWords.has(w)).length;
  return matches / words.length > 0.08;
}

/** Extracts a description string from an Open Library work/edition JSON object. */
function extractDescription(data) {
  if (!data || !data.description) return '';
  return typeof data.description === 'string' ? data.description : (data.description.value || '');
}

/**
 * Fetches an English-language description/synopsis for an Open Library work.
 * The search.json endpoint used by searchOpenLibrary does not include
 * descriptions, so this hits the separate /works/{id}.json endpoint.
 * If the work-level description is missing or fails the English check,
 * this checks up to 5 editions in turn (some works only carry a
 * description on one specific edition, sometimes in another language).
 *
 * Unlike searchOpenLibrary, failures here stay silent (return '') rather
 * than throwing - this is a secondary enrichment step for a match that
 * already succeeded, so losing just the synopsis shouldn't block the
 * whole Add Book / Refresh flow the way a failed primary search should.
 */
async function fetchOpenLibraryDescription(workKey) {
  if (!workKey) return '';

  try {
    const workRes = await fetch(`https://openlibrary.org${workKey}.json`);
    if (workRes.ok) {
      const workDesc = extractDescription(await workRes.json());
      if (workDesc && isProbablyEnglish(workDesc)) return workDesc;
    }
  } catch (e) {
    // Network/CORS failure reaching Open Library - fall through to editions.
  }

  try {
    const editionsRes = await fetch(`https://openlibrary.org${workKey}/editions.json?limit=5`);
    if (!editionsRes.ok) return '';
    const editionsData = await editionsRes.json();
    const entries = editionsData.entries || [];
    for (const edition of entries) {
      if (!edition.key) continue;
      const editionRes = await fetch(`https://openlibrary.org${edition.key}.json`);
      if (!editionRes.ok) continue;
      const desc = extractDescription(await editionRes.json());
      if (desc && isProbablyEnglish(desc)) return desc;
    }
    return '';
  } catch (e) {
    return '';
  }
}

/**
 * Ensures a match candidate has a synopsis by trying Open Library's work
 * endpoint (see fetchOpenLibraryDescription). Returns the match unchanged
 * if it already has one, or if nothing usable was found - there's no
 * further fallback source. Returns a new match object (does not mutate
 * the input).
 */
async function enrichMatchSynopsis(match) {
  if (match.synopsis) return match;
  if (match.workKey) {
    const description = await fetchOpenLibraryDescription(match.workKey);
    if (description) return Object.assign({}, match, { synopsis: description });
  }
  return match;
}

/**
 * Searches Open Library for match candidates (see parseOpenLibraryResults).
 * Thin wrapper kept as a named function (rather than callers using
 * searchOpenLibrary directly) so the two call sites (searchAddMatches in
 * Add Book, refreshCurrentBookFromOnline in Refresh) have a stable name to
 * call even if the underlying source ever changes. Propagates
 * searchOpenLibrary's thrown errors unchanged - see that function's
 * comment for why failures throw instead of resolving to [].
 */
async function findMatches(title, author) {
  return searchOpenLibrary(title, author);
}

/**
 * Given an existing book record and a normalized match candidate, returns
 * only the fields that are currently empty on the book, filled from the
 * candidate. Never overwrites a field that already has a value.
 * This is the core "refresh" rule and is kept as pure logic for testability.
 */
function fillEmptyFields(existingBook, candidate) {
  const fillable = ['synopsis', 'category', 'coverUrl'];
  const changes = {};
  for (const field of fillable) {
    const current = existingBook[field];
    const isEmpty = current === undefined || current === null || current === '';
    if (isEmpty && candidate[field]) {
      changes[field] = candidate[field];
    }
  }
  return changes;
}

const apiExports = {
  chooseCoverUrl,
  parseOpenLibraryResults,
  searchOpenLibrary,
  findMatches,
  fillEmptyFields,
  extractDescription,
  isProbablyEnglish,
  fetchOpenLibraryDescription,
  enrichMatchSynopsis,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = apiExports;
} else if (typeof window !== 'undefined') {
  window.api = apiExports;
}
