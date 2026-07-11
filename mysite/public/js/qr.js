// qr.js — client-side QR code generation for invite links.
//
// Replaces the retired Google Image Charts endpoint (chart.googleapis.com),
// which was shut down and now fails for every request — meaning every invite
// QR rendered as a broken image. Generating locally also keeps invite tokens
// on-device instead of sending them to a third-party image service.
//
// The `qrcode` library is lazy-loaded from jsDelivr (already allowlisted in
// the CSP for jsPDF) only the first time a QR is actually requested.

let qrLibPromise = null;
function qrLib() {
  qrLibPromise ??= import('https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm')
    .then(m => m.default ?? m);
  return qrLibPromise;
}

/** Render `text` as a QR code into the given <img> element (as a data: URL). */
export async function setQrImage(imgEl, text, size = 220) {
  if (!imgEl || !text) return;
  try {
    const QRCode = await qrLib();
    imgEl.src = await QRCode.toDataURL(text, { width: size, margin: 1 });
    imgEl.dataset.qrReady = '1';
  } catch (err) {
    console.error('[qr] failed to generate QR code:', err);
  }
}
