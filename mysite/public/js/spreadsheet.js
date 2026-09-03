// spreadsheet.js — read a classroom-library export (.xlsx / .xls / .csv) and
// turn it into books BookWare can import.
//
// No DOM, no Firestore: this file only understands spreadsheets. teacher.js
// drives it and teacher-api.js writes the result.
//
// ─── WHAT THESE EXPORTS ACTUALLY LOOK LIKE ──────────────────────────────────
// The format this was built against (a Booksource/OpenLibrary-style export)
// has a "Holdings" sheet with one ROW PER PHYSICAL COPY — four copies of The
// Martian are four identical rows, not one row with a quantity. Importing that
// naively gives four separate shelf entries for one book, which is exactly the
// duplicate mess the Merge button exists to clean up. So rows are grouped here
// and the group size becomes `copies`.
//
// Two more quirks worth knowing, both handled below:
//   • ISBNs arrive as floats in scientific notation ("9.780439023528E12"),
//     because the exporting app wrote them as numbers.
//   • A "Status" column may say "Checked out", naming a student who does not
//     exist in BookWare. Those copies import as available — see importBooks().

import { normBookKey } from './teacher-api.js';

/** Pinned, and loaded only when someone actually imports a file — the library
 *  is ~400 KB and most sessions never touch it. jsDelivr is already in the
 *  script-src allowlist in firebase.json (the PDF export uses it too); a new
 *  CDN would be blocked with no visible error. */
const SHEETJS_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm';

let sheetjs = null;
async function loadSheetJs() {
  if (!sheetjs) sheetjs = await import(/* @vite-ignore */ SHEETJS_URL);
  return sheetjs;
}

export class SpreadsheetError extends Error {
  constructor(message, hint = '') {
    super(message);
    this.name = 'SpreadsheetError';
    this.hint = hint;
  }
}

// Header synonyms. Exports disagree on wording, so match loosely rather than
// demanding one exact spelling.
const FIELDS = {
  title:       ['title', 'book', 'book title', 'name'],
  author:      ['author', 'authors', 'by'],
  isbn:        ['isbn', 'isbn13', 'isbn 13', 'isbn-13', 'barcode'],
  coverUrl:    ['cover image url', 'cover', 'cover url', 'image', 'image url', 'thumbnail'],
  description: ['synopsis', 'description', 'summary', 'blurb'],
  status:      ['status', 'availability'],
  copies:      ['copies', 'quantity', 'qty', 'count'],
};

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Every cell value, as a trimmed string.
 *
 *  A spreadsheet cell is not necessarily text. A book called "1776" is stored
 *  as the NUMBER 1776, and a date-like title can arrive as a Date — so
 *  `(cell ?? '').trim()` throws "trim is not a function" on exactly one row in
 *  a 436-row file and takes the whole import down with it. Coerce first,
 *  always. (ISBN deliberately does NOT go through here: normalizeIsbn needs to
 *  know whether it was handed a number, to recover stripped leading zeros.) */
const str = (v) => (v === null || v === undefined) ? '' : String(v).trim();

/** Map a sheet's header row onto our field names. */
function mapHeaders(headerRow) {
  const map = {};
  headerRow.forEach((raw, i) => {
    const h = norm(raw);
    if (!h) return;
    for (const [field, names] of Object.entries(FIELDS)) {
      if (map[field] === undefined && names.includes(h)) { map[field] = i; return; }
    }
  });
  return map;
}

/** Normalise an ISBN cell.
 *
 *  Accepts a real number, a scientific-notation string, or a hyphenated one.
 *  Anything that isn't a plausible ISBN becomes '' rather than garbage — the
 *  field is optional, and a wrong ISBN is worse than none. */
export function normalizeIsbn(value) {
  if (value === null || value === undefined || value === '') return '';
  let s = String(value).trim();

  // "9.780439023528E12" and friends: written as a number by the exporter.
  const numeric = /e\+?\d+$/i.test(s) || typeof value === 'number';
  if (numeric) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) {
      // Safe: a 13-digit ISBN is well inside Number's exact-integer range.
      s = Math.round(n).toString();
    }
  }
  s = s.replace(/[^0-9Xx]/g, '').toUpperCase();

  // Storing an ISBN as a NUMBER silently eats its leading zeros, and most
  // US ISBN-10s start with 0 — "0061097314" comes back as 61097314. Pad those
  // back out. Verified against the ISBN-10 check digit on real data, so this
  // reconstructs the true ISBN rather than inventing one. Only done for values
  // that arrived as numbers: a genuine 9-character string is just malformed.
  // (ISBN-13s always begin 978/979, so they never lose digits this way, and an
  // ISBN-10 ending in X can't be a number in the first place.)
  if (numeric && s.length >= 8 && s.length <= 9) s = s.padStart(10, '0');

  if (s.length !== 10 && s.length !== 13) return '';
  return s;
}

const isCheckedOut = (status) => /check(ed)?\s*-?\s*out|on loan|borrowed|out\b/i.test(String(status ?? ''));

/** Rows → one entry per distinct book, with a copy count.
 *
 *  Grouped on title+author using the same normalisation the shelf uses, so a
 *  file whose rows say "The Hobbit" and "hobbit, the" collapses the way the
 *  teacher expects, and so an imported book matches an existing shelf entry. */
export function groupRows(rows) {
  const groups = new Map();
  let skipped = 0;

  for (const r of rows) {
    const title = str(r.title);
    if (!title) { skipped++; continue; }
    const author = str(r.author);
    const key = `${normBookKey(title)}|${normBookKey(author)}`;

    // An explicit Copies column wins; otherwise each row IS one copy.
    const n = Number(r.copies);
    const copies = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;

    const g = groups.get(key);
    if (g) {
      g.copies += copies;
      if (isCheckedOut(r.status)) g.checkedOut += copies;
      // Fill gaps from later rows — the first row of a group isn't always the
      // most complete one.
      g.isbn        ||= normalizeIsbn(r.isbn);
      g.coverUrl    ||= str(r.coverUrl);
      g.description ||= str(r.description);
      g.author      ||= author;
    } else {
      groups.set(key, {
        title, author,
        isbn:        normalizeIsbn(r.isbn),
        coverUrl:    str(r.coverUrl),
        description: str(r.description),
        copies,
        checkedOut:  isCheckedOut(r.status) ? copies : 0,
      });
    }
  }
  return { entries: [...groups.values()], skipped };
}

/** Parse a File/Blob into `{ entries, stats, sheetName, headers }`.
 *
 *  Throws SpreadsheetError with a hint the UI can show directly. */
export async function parseLibraryFile(file) {
  if (!file) throw new SpreadsheetError('No file chosen');
  if (file.size > 12 * 1024 * 1024) {
    throw new SpreadsheetError('That file is too large', 'imports are capped at 12 MB');
  }

  let XLSX;
  try {
    XLSX = await loadSheetJs();
  } catch (err) {
    console.error('[spreadsheet] could not load the parser:', err);
    throw new SpreadsheetError('Could not load the spreadsheet reader',
      'check your connection; the reader loads from a CDN the first time you import');
  }

  let wb;
  try {
    wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  } catch (err) {
    console.error('[spreadsheet] parse failed:', err);
    throw new SpreadsheetError("That file couldn't be read as a spreadsheet",
      'export it again as .xlsx or .csv and retry');
  }

  // Prefer a sheet actually called Holdings/Books/Library; otherwise the first.
  const preferred = wb.SheetNames.find(n => /holding|book|librar|catalog|inventor/i.test(n));
  const sheetName = preferred ?? wb.SheetNames[0];
  if (!sheetName) throw new SpreadsheetError('That workbook has no sheets in it');

  // header:1 gives raw arrays, so we can find the header row ourselves rather
  // than trusting row 1 — some exports carry a title banner above it.
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, blankrows: false, raw: true });
  if (!grid.length) throw new SpreadsheetError(`The "${sheetName}" sheet is empty`);

  let headerIdx = -1, map = {};
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    const m = mapHeaders(grid[i] ?? []);
    if (m.title !== undefined) { headerIdx = i; map = m; break; }
  }
  if (headerIdx === -1) {
    throw new SpreadsheetError('Could not find a Title column',
      `looked at the first rows of "${sheetName}". The sheet needs a header row with at least a Title column`);
  }

  const rows = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const row = grid[i] ?? [];
    const pick = (f) => (map[f] === undefined ? '' : row[map[f]]);
    if (!str(pick('title')) && !str(pick('isbn'))) continue; // blank line
    rows.push({
      title:       str(pick('title')),
      author:      str(pick('author')),
      isbn:        pick('isbn'),          // raw on purpose — see normalizeIsbn
      coverUrl:    str(pick('coverUrl')),
      description: str(pick('description')),
      status:      str(pick('status')),
      copies:      pick('copies'),
    });
  }

  const { entries, skipped } = groupRows(rows);
  entries.sort((a, b) => a.title.localeCompare(b.title));

  return {
    sheetName,
    sheetNames: wb.SheetNames,
    headers: (grid[headerIdx] ?? []).map(h => String(h ?? '')),
    entries,
    stats: {
      rows: rows.length,
      books: entries.length,
      copies: entries.reduce((n, e) => n + e.copies, 0),
      checkedOut: entries.reduce((n, e) => n + e.checkedOut, 0),
      withIsbn: entries.filter(e => e.isbn).length,
      withCover: entries.filter(e => e.coverUrl).length,
      skipped,
    },
  };
}
