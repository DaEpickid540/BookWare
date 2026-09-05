// barcode.js — camera barcode scanning for adding books by their back cover.
//
// This file knows about the camera and about barcodes. It does NOT know about
// books, Firestore, or the teacher portal's DOM: it is handed a <video> to draw
// into and calls back with a validated ISBN string. teacher.js drives it,
// books.js turns the ISBN into a book, teacher-api.js writes it.
//
// ─── TWO DECODERS, ON PURPOSE ────────────────────────────────────────────────
// The Barcode Detection API (`BarcodeDetector`) is native, fast, and needs no
// download — but it only exists on Chrome/Edge and Android. iOS Safari, which
// is what half the classroom actually scans with, has no such thing. So there
// is a second path through ZXing, lazy-loaded from jsDelivr only when the
// native one is missing, so Android users never pay for a library they don't
// need.
//
// Neither path is guaranteed: a browser can have no camera API at all, and the
// CDN can be blocked. Every failure here surfaces as a BarcodeError with a
// `hint` telling the teacher to type the ISBN into the search box instead —
// that route always works, and is why scanning is allowed to fail softly.
//
// ─── THINGS THAT WILL BITE YOU ───────────────────────────────────────────────
//   • getUserMedia needs a secure context. https:// or localhost, never a LAN
//     IP over plain http, or the camera silently never starts.
//   • `Permissions-Policy: camera=(self)` must be set in firebase.json. It used
//     to be `camera=()`, which blocks the camera for the page's OWN origin —
//     getUserMedia rejects with NotAllowedError and the browser never even
//     shows the permission prompt, so it reads exactly like the teacher denied
//     it. If scanning stops working with no prompt, check that header first.
//   • ZXing is pinned. jsDelivr is already in the CSP script-src (jsPDF and
//     SheetJS use it too); a different CDN would be blocked with no visible
//     error.

/** Pinned: an unpinned CDN import is a silent breakage waiting for the next
 *  major release. Loaded only when the browser has no native BarcodeDetector,
 *  and only the first time someone actually scans. */
const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/+esm';

/** How often a frame is decoded, in ms. Decoding every frame is wasted work —
 *  a decode costs more than this gap, and nobody holds a paperback steadier
 *  than seven readings a second. */
const FRAME_INTERVAL_MS = 140;

/** Ignore a repeat of the same code for this long. A barcode decodes many
 *  times a second once it is in focus; without this the same ISBN fires a
 *  fresh lookup over and over while the book is still in frame. */
const REPEAT_SUPPRESS_MS = 2500;

export class BarcodeError extends Error {
  constructor(message, { code = 'bw/scan-failed', hint = '' } = {}) {
    super(message);
    this.name = 'BarcodeError';
    this.code = code;
    this.hint = hint;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ISBN validation
// ═══════════════════════════════════════════════════════════════════════════

/** Strip a scanned barcode down to digits, plus a trailing X — a legal ISBN-10
 *  check digit. */
export function normalizeIsbn(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^0-9X]/g, '');
}

function ean13ChecksumOk(digits) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(digits[12]);
}

function isbn10ChecksumOk(chars) {
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(chars[i]) * (10 - i);
  const check = chars[9] === 'X' ? 10 : Number(chars[9]);
  return (sum + check) % 11 === 0;
}

/** True for a barcode that is actually a book.
 *
 *  A shelf of books sits in a classroom full of other barcodes — a laptop
 *  asset tag, a snack wrapper, the teacher's own ID card. Those are all valid
 *  EAN/UPC codes and they all decode cleanly, so "we read a barcode" is a
 *  different question from "this is a book". Bookland is the 978 and 979
 *  prefixes; anything else is a product, and looking one up returns nothing
 *  and reads as a broken scanner. */
export function isBookIsbn(raw) {
  const s = normalizeIsbn(raw);
  if (s.length === 13) return /^97[89]/.test(s) && ean13ChecksumOk(s);
  if (s.length === 10) return isbn10ChecksumOk(s);
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// Decoders
// ═══════════════════════════════════════════════════════════════════════════

/** Formats worth trying. Deliberately narrow: the more formats a decoder is
 *  asked to consider, the slower each frame is and the more junk it finds in
 *  the noise of a moving camera. Books are EAN-13; EAN-8 and the UPCs are here
 *  only because older library stickers occasionally use them. */
const FORMATS_NATIVE = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];

async function makeNativeDecoder() {
  if (typeof globalThis.BarcodeDetector !== 'function') return null;
  let supported = [];
  try {
    supported = await globalThis.BarcodeDetector.getSupportedFormats();
  } catch { return null; }
  const formats = FORMATS_NATIVE.filter(f => supported.includes(f));
  if (!formats.length) return null;

  const detector = new globalThis.BarcodeDetector({ formats });
  // Reads the <video> directly — no canvas round trip, which is most of why
  // this path is the fast one.
  return async function decodeNative(video) {
    const hits = await detector.detect(video);
    return hits?.[0]?.rawValue ?? null;
  };
}

let zxingPromise = null;
function loadZxing() {
  zxingPromise ??= import(/* @vite-ignore */ ZXING_URL).catch(err => {
    zxingPromise = null;   // let a later attempt retry rather than caching the failure
    throw err;
  });
  return zxingPromise;
}

async function makeZxingDecoder() {
  let Z;
  try {
    Z = await loadZxing();
  } catch (err) {
    console.warn('[barcode] ZXing failed to load:', err?.message ?? err);
    throw new BarcodeError("This browser can't scan barcodes", {
      code: 'bw/no-decoder',
      hint: 'type the ISBN into the search box above instead',
    });
  }

  const hints = new Map();
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
    Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8,
    Z.BarcodeFormat.UPC_A,  Z.BarcodeFormat.UPC_E,
  ]);
  hints.set(Z.DecodeHintType.TRY_HARDER, true);

  const reader = new Z.MultiFormatReader();
  reader.setHints(hints);

  // One canvas for the whole session. Allocating a 720p canvas seven times a
  // second is how you make a phone hot and the preview stutter.
  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d', { willReadFrequently: true });
  let gray     = null;

  return function decodeZxing(video) {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return null;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      gray = new Uint8ClampedArray(w * h);
    }
    ctx.drawImage(video, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);

    // ZXing's own luminance weights, in fixed point. RGBLuminanceSource can do
    // this itself from packed RGB, but only for an Int32Array — building one of
    // those is a second full-size copy per frame for the same answer.
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = (data[p] * 306 + data[p + 1] * 601 + data[p + 2] * 117) >> 10;
    }

    const bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(
      new Z.RGBLuminanceSource(gray, w, h),
    ));
    try {
      return reader.decode(bitmap)?.getText() ?? null;
    } catch {
      // NotFoundException, on a frame with no barcode in it — which is most
      // frames. Not an error worth reporting.
      return null;
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Scanner
// ═══════════════════════════════════════════════════════════════════════════

/** True when this browser could plausibly scan. Cheap and synchronous, for
 *  deciding whether to offer a Scan button at all. */
export function isScanSupported() {
  return Boolean(
    globalThis.isSecureContext &&
    navigator.mediaDevices?.getUserMedia &&
    typeof HTMLCanvasElement !== 'undefined',
  );
}

function cameraError(err) {
  const name = err?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new BarcodeError('Camera access was blocked', {
      code: 'bw/camera-denied',
      hint: 'allow the camera for this site in your browser settings, then try again',
    });
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new BarcodeError('No camera was found on this device', {
      code: 'bw/no-camera',
      hint: 'scan from a phone or tablet, or type the ISBN into the search box',
    });
  }
  if (name === 'NotReadableError') {
    return new BarcodeError('The camera is already in use', {
      code: 'bw/camera-busy',
      hint: 'close any other app or tab using the camera, then try again',
    });
  }
  return new BarcodeError(err?.message || "The camera couldn't be started", {
    code: 'bw/camera-failed',
    hint: 'type the ISBN into the search box above instead',
  });
}

/**
 * Start scanning into `video`, calling `onCode(isbn)` for each new book found.
 *
 * Returns a `stop()` function, and calling it is not optional: the camera light
 * stays on and the track stays live until every track is stopped, which on a
 * phone is both alarming and a battery drain. Callers must stop from every exit
 * path — closing the modal, leaving the page, signing out.
 *
 * @param {object} opts
 * @param {HTMLVideoElement}       opts.video        preview element for the stream
 * @param {(isbn: string) => void} opts.onCode       called with a validated ISBN
 * @param {(err: Error) => void}   [opts.onError]    fatal only; scanning has stopped
 * @param {(code: string) => void} [opts.onNonBook]  decoded, but not a book barcode
 * @param {() => void}             [opts.onReady]    preview live, frames being read
 * @returns {Promise<() => void>} stop
 */
export async function startScanner({ video, onCode, onError, onNonBook, onReady }) {
  if (!video) throw new BarcodeError('No preview element was given');
  if (!isScanSupported()) {
    throw new BarcodeError("This browser can't use the camera", {
      code: 'bw/unsupported',
      hint: 'type the ISBN into the search box above instead',
    });
  }

  let stream  = null;
  let stopped = false;
  let timer   = null;

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    // Detach the element before killing the tracks, or Safari leaves the last
    // frame frozen in place the next time the modal opens.
    try { video.pause(); } catch { /* already gone */ }
    video.srcObject = null;
    stream?.getTracks()?.forEach(t => { try { t.stop(); } catch { /* already ended */ } });
    stream = null;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // `ideal`, not `exact`: `exact` throws OverconstrainedError on a laptop,
      // which has only a front camera and is a perfectly reasonable thing to
      // scan with when a teacher is sitting at their desk.
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
  } catch (err) {
    throw cameraError(err);
  }
  if (stopped) { stop(); return stop; }   // closed while the prompt was still up

  video.srcObject = stream;
  video.setAttribute('playsinline', '');  // iOS fullscreens the preview without it
  video.muted = true;
  try {
    await video.play();
  } catch (err) {
    stop();
    throw cameraError(err);
  }

  let decode;
  try {
    decode = (await makeNativeDecoder()) ?? (await makeZxingDecoder());
  } catch (err) {
    stop();
    throw err;
  }
  if (stopped) { stop(); return stop; }

  onReady?.();

  let lastCode = '';
  let lastAt   = 0;

  async function tick() {
    if (stopped) return;
    try {
      const raw = await decode(video);
      if (raw) {
        const now  = Date.now();
        const code = normalizeIsbn(raw);
        const isRepeat = code === lastCode && now - lastAt < REPEAT_SUPPRESS_MS;
        if (!isRepeat) {
          lastCode = code; lastAt = now;
          if (isBookIsbn(code)) onCode?.(code);
          else                  onNonBook?.(code);
        }
      }
    } catch (err) {
      // A per-frame failure is normal: nothing in shot, or a half-drawn frame
      // mid-resize. Only a dead stream is fatal, and that arrives as the track
      // ending rather than as a throw here.
      console.debug('[barcode] frame skipped:', err?.message ?? err);
    }
    if (!stopped) timer = setTimeout(tick, FRAME_INTERVAL_MS);
  }
  tick();

  // Camera access can be revoked, or a webcam unplugged, mid-scan. Without
  // this the preview simply freezes and the modal looks hung.
  stream.getVideoTracks().forEach(track => {
    track.addEventListener('ended', () => {
      if (stopped) return;
      stop();
      onError?.(new BarcodeError('The camera stopped', {
        code: 'bw/camera-ended',
        hint: 'try scanning again, or type the ISBN into the search box',
      }));
    });
  });

  return stop;
}
