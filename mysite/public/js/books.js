// books.js — Book search helpers
// Primary: Open Library (no API key, CORS-friendly)
// Fallback: Google Books

const OL_SEARCH = 'https://openlibrary.org/search.json';
const OL_COVERS = 'https://covers.openlibrary.org/b';
const GBOOKS    = 'https://www.googleapis.com/books/v1/volumes';

function parseOL(d) {
  if (!d) return null;
  const cover = d.cover_i
    ? `${OL_COVERS}/id/${d.cover_i}-M.jpg?default=false`
    : d.isbn?.[0]
    ? `${OL_COVERS}/isbn/${d.isbn[0]}-M.jpg?default=false`
    : '';
  return {
    sourceId:    d.key ?? '',
    title:       d.title ?? 'Unknown Title',
    author:      (d.author_name ?? []).slice(0, 3).join(', '),
    cover,
    description: d.first_sentence?.[0] ?? '',
    isbn:        d.isbn?.[0] ?? '',
    pageCount:   d.number_of_pages_median ?? null,
    published:   d.first_publish_year ?? '',
    publisher:   (d.publisher ?? [])[0] ?? '',
  };
}

function parseGoogle(item) {
  if (!item?.volumeInfo) return null;
  const v = item.volumeInfo;
  let cover = v.imageLinks?.thumbnail ?? v.imageLinks?.smallThumbnail ?? '';
  cover = cover.replace(/^http:/, 'https:').replace('&edge=curl', '');
  const isbn = (v.industryIdentifiers ?? []).find(x => x.type?.startsWith('ISBN'))?.identifier ?? '';
  return {
    sourceId:    item.id ?? '',
    title:       v.title ?? 'Unknown Title',
    author:      (v.authors ?? []).join(', '),
    cover,
    description: v.description ?? '',
    isbn,
    pageCount:   v.pageCount ?? null,
    published:   v.publishedDate ?? '',
    publisher:   v.publisher ?? '',
  };
}

async function safeFetch(url, label) {
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 8000);
    const res  = await fetch(url, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!res.ok) { console.warn(`[books] ${label} HTTP ${res.status}`); return null; }
    return await res.json();
  } catch (e) {
    console.warn(`[books] ${label} failed:`, e.message ?? e);
    return null;
  }
}

// Dedupe/match key — same ISBN, or same title+author when ISBN is missing.
function matchKey(b) {
  return (b.isbn || `${b.title}|${b.author}`).toLowerCase().replace(/\s+/g, '');
}

// Merge a primary book with a secondary match, filling only blanks from secondary.
function fillGaps(primary, secondary) {
  if (!secondary) return primary;
  return {
    ...primary,
    cover:       primary.cover       || secondary.cover,
    description: primary.description || secondary.description,
    isbn:        primary.isbn        || secondary.isbn,
    pageCount:   primary.pageCount   ?? secondary.pageCount,
    publisher:   primary.publisher   || secondary.publisher,
    published:   primary.published   || secondary.published,
  };
}

// ── Provider-specific fetchers ────────────────────────────────────────────────
async function olSearch(q, max) {
  const data = await safeFetch(
    `${OL_SEARCH}?q=${encodeURIComponent(q)}&limit=${Math.min(max, 20)}&fields=key,title,author_name,cover_i,isbn,first_publish_year,publisher,number_of_pages_median,first_sentence`,
    'OL search',
  );
  return (data?.docs ?? []).map(parseOL).filter(Boolean);
}
async function gSearch(q, max) {
  const data = await safeFetch(
    `${GBOOKS}?q=${encodeURIComponent(q)}&maxResults=${Math.min(max, 40)}&printType=books`,
    'Google search',
  );
  return (data?.items ?? []).map(parseGoogle).filter(Boolean);
}

// ISBN lookup — queries Open Library and Google Books in parallel for redundancy.
// Prefers Open Library, then fills any missing fields (esp. cover) from Google.
export async function lookupISBN(isbn) {
  if (!isbn?.trim()) return null;
  const clean = isbn.trim().replace(/[\s\-]/g, '');
  const [ol, g] = await Promise.all([
    safeFetch(`${OL_SEARCH}?q=isbn:${encodeURIComponent(clean)}&limit=1`, 'OL ISBN')
      .then(d => (d?.docs?.length ? parseOL(d.docs[0]) : null)).catch(() => null),
    safeFetch(`${GBOOKS}?q=isbn:${encodeURIComponent(clean)}&maxResults=1`, 'Google ISBN')
      .then(d => (d?.items?.length ? parseGoogle(d.items[0]) : null)).catch(() => null),
  ]);
  if (ol && g) return fillGaps(ol, g);
  return ol || g || null;
}

// Title/author/keyword search — queries both providers concurrently for redundancy.
// If one provider is down or empty, the other carries the results; when both
// respond, Open Library order is kept and missing covers are cross-filled from
// Google Books, with any Google-only titles appended for extra coverage.
export async function searchBooks(query, max = 10) {
  if (!query?.trim()) return [];
  const q = query.trim();
  const [olRes, gRes] = await Promise.all([
    olSearch(q, max).catch(() => []),
    gSearch(q, max).catch(() => []),
  ]);

  if (!olRes.length) return gRes.slice(0, max);
  if (!gRes.length)  return olRes.slice(0, max);

  const gByKey = new Map(gRes.map(b => [matchKey(b), b]));
  const merged = olRes.map(b => (b.cover ? b : fillGaps(b, gByKey.get(matchKey(b)))));

  const seen = new Set(olRes.map(matchKey));
  for (const g of gRes) {
    if (merged.length >= max) break;
    const k = matchKey(g);
    if (!seen.has(k)) { merged.push(g); seen.add(k); }
  }
  return merged.slice(0, max);
}

export async function lookupById(id) {
  if (!id) return null;
  if (id.startsWith('/works/') || id.startsWith('/books/')) {
    const data = await safeFetch(`https://openlibrary.org${id}.json`, 'OL byId');
    if (!data) return null;
    return parseOL({ key: data.key, title: data.title, cover_i: data.covers?.[0], first_publish_year: data.first_publish_date });
  }
  const data = await safeFetch(`${GBOOKS}/${encodeURIComponent(id)}`, 'Google byId');
  return data ? parseGoogle(data) : null;
}
