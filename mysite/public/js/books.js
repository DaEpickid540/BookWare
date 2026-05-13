export async function lookupISBN(isbn) {
  const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(
    isbn,
  )}`;
  const res = await fetch(url);
  const data = await res.json();

  if (!data.items || data.items.length === 0) return null;

  const info = data.items[0].volumeInfo;

  return {
    title: info.title || "",
    author: info.authors ? info.authors.join(", ") : "",
    cover: info.imageLinks?.thumbnail || "",
    description: info.description || "",
  };
}
