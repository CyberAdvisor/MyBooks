/**
 * csv.js
 * CSV import/export for book records. Format is designed from scratch
 * (not matched to any external tool's export schema).
 *
 * Column order: title,author,status,synopsis,source,category,series,seriesNumber,rating,notes
 * - "source" holds a single value (e.g. "Kindle") - one selection only, same as "category".
 *   A cell with an old-style semicolon-separated list (from before source was single-select)
 *   is still readable on import: only the first value is kept.
 * - Fields containing commas, quotes, or newlines are double-quote wrapped per CSV spec
 */

const CSV_COLUMNS = [
  'title', 'author', 'status', 'synopsis', 'source',
  'category', 'series', 'seriesNumber', 'rating', 'notes',
];

/** Escapes a single CSV field per RFC 4180. */
function escapeCsvField(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Serializes an array of book records into a CSV string (with header row). */
function booksToCsv(books) {
  const header = CSV_COLUMNS.join(',');
  const rows = books.map((book) => {
    const record = {
      title: book.title,
      author: book.author,
      status: book.status,
      synopsis: book.synopsis,
      source: book.source || '',
      category: book.category,
      series: book.series,
      seriesNumber: book.seriesNumber,
      rating: book.rating,
      notes: book.notes,
    };
    return CSV_COLUMNS.map((col) => escapeCsvField(record[col])).join(',');
  });
  return [header, ...rows].join('\n');
}

/**
 * Parses a single CSV line into an array of field strings, honoring quoted
 * fields (including embedded commas and escaped double-quotes).
 */
function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++; // skip the escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Parses a full CSV string (header + rows) into an array of book-shaped
 * objects. Unknown/missing columns are tolerated; "source" keeps only its
 * first value if the cell holds an old-style semicolon-separated list.
 */
function csvToBooks(csvText) {
  const lines = csvText.split(/\r\n|\n|\r/).filter((line) => line.trim() !== '');
  if (lines.length === 0) return [];

  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const books = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const record = {};
    header.forEach((col, idx) => {
      record[col] = values[idx] !== undefined ? values[idx] : '';
    });

    books.push({
      title: record.title || '',
      author: record.author || '',
      status: record.status || 'To Read',
      synopsis: record.synopsis || '',
      source: record.source ? record.source.split(';')[0].trim() : '',
      category: record.category || '',
      series: record.series || '',
      seriesNumber: record.seriesNumber ? Number(record.seriesNumber) || record.seriesNumber : null,
      rating: record.rating ? Number(record.rating) || null : null,
      notes: record.notes || '',
    });
  }

  return books;
}

const csvExports = { CSV_COLUMNS, escapeCsvField, booksToCsv, parseCsvLine, csvToBooks };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = csvExports;
} else if (typeof window !== 'undefined') {
  window.csv = csvExports;
}
