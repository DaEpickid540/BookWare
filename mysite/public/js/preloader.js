// preloader.js — removes the full-page loading screen once a portal's first
// real screen of data is ready. Import and call hidePreloader() at that point;
// never earlier, or the splash just flashes past the slow Firestore round trip
// it exists to cover.
export function hidePreloader() {
  const el = document.getElementById('preloader');
  if (!el) return;
  el.classList.add('preloader--out');
  setTimeout(() => el.remove(), 300);
}

// Safety net: if something throws before hidePreloader() is ever called (a
// crash during auth or the first data load), don't leave the user staring at
// a spinner forever with no way to know the page died.
window.addEventListener('unhandledrejection', () => hidePreloader());
window.addEventListener('error', () => hidePreloader());
