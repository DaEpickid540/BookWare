// ─────────────────────────────────────────────────────────────────────────────
// books.js — Book search/lookup helpers
//
// Uses Open Library (https://openlibrary.org) as primary — no API key,
// CORS-friendly, free, no quota. Falls back to Google Books if needed.
// ─────────────────────────────────────────────────────────────────────────────

const OL_SEARCH = "https://openlibrary.org/search.json";
const OL_COVERS = "https://covers.openlibrary.org/b";
const GBOOKS = "https://www.googleapis.com/books/v1/volumes";

// ── Parse an Open Library search doc ──────────────────────────────────────────
function parseOLDoc(doc) {
  if (!doc) return null;

  // Cover from cover_i (cover edition ID) — most reliable
  const cover = doc.cover_i
    ? `${OL_COVERS}/id/${doc.cover_i}-M.jpg`
    : doc.isbn?.[0]
    ? `${OL_COVERS}/isbn/${doc.isbn[0]}-M.jpg`
    : "";

  return {
    googleId: doc.key ?? "", // e.g. "/works/OL45804W"
    title: doc.title ?? "Unknown Title",
    author: (doc.author_name ?? []).slice(0, 3).join(", "),
    cover,
    description: doc.first_sentence?.[0] ?? "",
    isbn: doc.isbn?.[0] ?? "",
    pageCount: doc.number_of_pages_median ?? null,
    published: doc.first_publish_year ?? "",
    publisher: (doc.publisher ?? [])[0] ?? "",
  };
}

// ── Parse a Google Books volume (fallback) ────────────────────────────────────
function parseGoogle(item) {
  if (!item?.volumeInfo) return null;
  const v = item.volumeInfo;
  let cover = v.imageLinks?.thumbnail ?? v.imageLinks?.smallThumbnail ?? "";
  cover = cover.replace(/^http:/, "https:").replace("&edge=curl", "");
  const isbn =
    (v.industryIdentifiers ?? []).find((x) => x.type?.startsWith("ISBN"))
      ?.identifier ?? "";
  return {
    googleId: item.id ?? "",
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

// ── ISBN lookup (single result) ──────────────────────────────────────────────
export async function lookupISBN(isbn) {
  if (!isbn?.trim()) return null;
  const cleanIsbn = isbn.trim().replace(/[\s\-]/g, "");

  // Try Open Library first
  try {
    const res = await fetch(
      `${OL_SEARCH}?q=isbn:${encodeURIComponent(cleanIsbn)}&limit=1`,
    );
    if (res.ok) {
      const data = await res.json();
      if (data.docs?.length) return parseOLDoc(data.docs[0]);
    }
  } catch (e) {
    console.warn("Open Library ISBN lookup failed, trying Google:", e);
  }

  // Fall back to Google Books
  try {
    const res = await fetch(
      `${GBOOKS}?q=isbn:${encodeURIComponent(cleanIsbn)}&maxResults=1`,
    );
    if (res.ok) {
      const data = await res.json();
      if (data.items?.length) return parseGoogle(data.items[0]);
    }
  } catch (e) {
    console.error("Google Books ISBN lookup failed:", e);
  }

  return null;
}

// ── Text search (title, author, keyword) ─────────────────────────────────────
export async function searchBooks(query, max = 10) {
  if (!query?.trim()) return [];
  const q = query.trim();

  // Try Open Library first
  try {
    const res = await fetch(
      `${OL_SEARCH}?q=${encodeURIComponent(q)}&limit=${Math.min(
        max,
        20,
      )}&fields=key,title,author_name,cover_i,isbn,first_publish_year,publisher,number_of_pages_median,first_sentence`,
    );
    if (res.ok) {
      const data = await res.json();
      if (data.docs?.length) {
        return data.docs.map(parseOLDoc).filter(Boolean);
      }
    }
  } catch (e) {
    console.warn("Open Library search failed, trying Google:", e);
  }

  // Fall back to Google Books
  try {
    const res = await fetch(
      `${GBOOKS}?q=${encodeURIComponent(q)}&maxResults=${Math.min(
        max,
        40,
      )}&printType=books`,
    );
    if (res.ok) {
      const data = await res.json();
      return (data.items ?? []).map(parseGoogle).filter(Boolean);
    }
  } catch (e) {
    console.error("Google Books search failed:", e);
  }

  return [];
}

// ── Lookup by ID — handles both OL keys and Google volume IDs ────────────────
export async function lookupById(id) {
  if (!id) return null;
  // Open Library key starts with /works/ or /books/
  if (id.startsWith("/works/") || id.startsWith("/books/")) {
    try {
      const res = await fetch(`https://openlibrary.org${id}.json`);
      if (!res.ok) return null;
      const data = await res.json();
      return parseOLDoc({
        key: data.key,
        title: data.title,
        cover_i: data.covers?.[0],
        first_publish_year: data.first_publish_date,
      });
    } catch {
      return null;
    }
  }
  // Otherwise treat as Google Books ID
  try {
    const res = await fetch(`${GBOOKS}/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    return parseGoogle(await res.json());
  } catch {
    return null;
  }
}
