/**
 * rating.js
 * Pure logic for the 1-5 integer star rating: tier-color mapping and
 * star-glyph rendering. Kept DOM-free so it's directly unit-testable.
 */

const RATING_MIN = 1;
const RATING_MAX = 5;

/**
 * Maps a 1-5 rating to a color tier: 1-2 = red, 3 = yellow, 4-5 = green.
 * Returns '' for no rating (null/undefined/0).
 */
function getRatingColorClass(rating) {
  if (!rating) return '';
  if (rating <= 2) return 'stars-red';
  if (rating === 3) return 'stars-yellow';
  return 'stars-green';
}

/**
 * Builds a small HTML snippet of filled/empty star glyphs for a rating,
 * wrapped in a span carrying the tier color class. Returns '' if there's
 * no rating to show.
 */
function buildStarsHtml(rating) {
  if (!rating) return '';
  const colorClass = getRatingColorClass(rating);
  let stars = '';
  for (let i = 1; i <= RATING_MAX; i++) {
    stars += i <= rating ? '\u2605' : '\u2606'; // ★ : ☆
  }
  return `<span class="stars ${colorClass}">${stars}</span>`;
}

/** Clamps and validates a rating value to an integer in [1, 5], or null. */
function normalizeRating(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Math.round(Number(value));
  if (Number.isNaN(num)) return null;
  if (num < RATING_MIN) return RATING_MIN;
  if (num > RATING_MAX) return RATING_MAX;
  return num;
}

const ratingExports = { RATING_MIN, RATING_MAX, getRatingColorClass, buildStarsHtml, normalizeRating };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ratingExports;
} else if (typeof window !== 'undefined') {
  window.rating = ratingExports;
}
