// ─────────────────────────────────────────────────────────────────────────────
// books.js — Book search/lookup helpers
//
// Uses Open Library (https://openlibrary.org) as primary — no key, CORS-friendly.
// Falls back to Google Books if Open Library returns nothing.
// All functions ALWAYS return an array/object/null (never throw).
// Logs detailed info to console so issues are debuggable.
// ─────────────────────────────────────────────────────────────────────────────

const OL_SEARCH = "https://openlibrary.org/search.json";
const OL_COVERS = "https://covers.openlibrary.org/b";
const GBOOKS = "https://www.googleapis.com/books/v1/volumes";

// ── Open Library parser ───────────────────────────────────────────────────────
function parseOL(d) {
  if (!d) return null;
  const cover = d.cover_i
    ? `${OL_COVERS}/id/${d.cover_i}-M.jpg`
    : d.isbn?.[0]
    ? `${OL_COVERS}/isbn/${d.isbn[0]}-M.jpg`
    : "";
  return {
    sourceId: d.key ?? "",
    title: d.title ?? "Unknown Title",
    author: (d.author_name ?? []).slice(0, 3).join(", "),
    cover,
    description: d.first_sentence?.[0] ?? "",
    isbn: d.isbn?.[0] ?? "",
    pageCount: d.number_of_pages_median ?? null,
    published: d.first_publish_year ?? "",
    publisher: (d.publisher ?? [])[0] ?? "",
  };
}

// ── Google Books parser ───────────────────────────────────────────────────────
function parseGoogle(item) {
  if (!item?.volumeInfo) return null;
  const v = item.volumeInfo;
  let cover = v.imageLinks?.thumbnail ?? v.imageLinks?.smallThumbnail ?? "";
  cover = cover.replace(/^http:/, "https:").replace("&edge=curl", "");
  const isbn =
    (v.industryIdentifiers ?? []).find((x) => x.type?.startsWith("ISBN"))
      ?.identifier ?? "";
  return {
    sourceId: item.id ?? "",
    title: v.title ?? "Unknown Title",
    author: (v.authors ?? []).join(", "),
    cover,
    description: v.description ?? "",
    isbn,
    pageCount: v.pageCount ?? null,
    published: v.publishedDate ?? "",
    publisher: v.publisher ?? "",
  };
}

// ── Internal fetch with timeout and logging ───────────────────────────────────
async function safeFetch(url, label) {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!res.ok) {
      console.warn(`[books.js] ${label} HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn(`[books.js] ${label} failed:`, e.message ?? e);
    return null;
  }
}

// ── PUBLIC: ISBN lookup ──────────────────────────────────────────────────────
export async function lookupISBN(isbn) {
  if (!isbn?.trim()) return null;
  const clean = isbn.trim().replace(/[\s\-]/g, "");

  const ol = await safeFetch(
    `${OL_SEARCH}?q=isbn:${encodeURIComponent(clean)}&limit=1`,
    "OL ISBN",
  );
  if (ol?.docs?.length) {
    const parsed = parseOL(ol.docs[0]);
    if (parsed) return parsed;
  }

  const g = await safeFetch(
    `${GBOOKS}?q=isbn:${encodeURIComponent(clean)}&maxResults=1`,
    "Google ISBN",
  );
  if (g?.items?.length) return parseGoogle(g.items[0]);

  return null;
}

// ── PUBLIC: free-text search ──────────────────────────────────────────────────
export async function searchBooks(query, max = 10) {
  if (!query?.trim()) return [];
  const q = query.trim();
  console.log(`[books.js] Searching for: "${q}"`);

  const ol = await safeFetch(
    `${OL_SEARCH}?q=${encodeURIComponent(q)}&limit=${Math.min(max, 20)}` +
      `&fields=key,title,author_name,cover_i,isbn,first_publish_year,publisher,number_of_pages_median,first_sentence`,
    "OL search",
  );
  if (ol?.docs?.length) {
    const out = ol.docs.map(parseOL).filter(Boolean);
    console.log(`[books.js] Open Library: ${out.length} results`);
    return out;
  }

  console.log(`[books.js] OL empty — falling back to Google`);
  const g = await safeFetch(
    `${GBOOKS}?q=${encodeURIComponent(q)}&maxResults=${Math.min(
      max,
      40,
    )}&printType=books`,
    "Google search",
  );
  if (g?.items?.length) {
    const out = g.items.map(parseGoogle).filter(Boolean);
    console.log(`[books.js] Google: ${out.length} results`);
    return out;
  }

  console.warn(`[books.js] Both APIs returned 0 results`);
  return [];
}

// ── PUBLIC: lookup by ID ─────────────────────────────────────────────────────
export async function lookupById(id) {
  if (!id) return null;
  if (id.startsWith("/works/") || id.startsWith("/books/")) {
    const data = await safeFetch(
      `https://openlibrary.org${id}.json`,
      "OL byId",
    );
    if (!data) return null;
    return parseOL({
      key: data.key,
      title: data.title,
      cover_i: data.covers?.[0],
      first_publish_year: data.first_publish_date,
    });
  }
  const data = await safeFetch(
    `${GBOOKS}/${encodeURIComponent(id)}`,
    "Google byId",
  );
  return data ? parseGoogle(data) : null;
}
