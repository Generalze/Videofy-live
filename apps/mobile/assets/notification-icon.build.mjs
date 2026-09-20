// @owner masterzee001
/**
 * Builds assets/notification-icon.png -- the Android notification small icon.
 *
 *   node apps/mobile/assets/notification-icon.build.mjs
 *
 * WHY THIS EXISTS. The first notification icon (09011da, 18 Sep 2026) was cut
 * by hand out of the launcher lockup's alpha channel, and nothing recorded how.
 * The founder's review on 20 Sep 2026 found two faults in it and neither could
 * be corrected without redoing the crop blind, so the geometry now lives here
 * as the source of truth and the PNG is its output.
 *
 * WHAT WAS WRONG, measured from the 09011da asset:
 *
 *   - IT WAS THE WRONG MARK. That crop came from the launcher lockup (a teal
 *     C, a white 7 and a teal dot laid out side by side), not from the site
 *     favicon. src/ui/c7.tsx states the rule -- "THE MARK IS THE WEBSITE
 *     FAVICON" -- and the favicon has no teal in it at all, which is why the
 *     #3ec9c0 tint it was given looked nothing like the browser tab.
 *
 *   - IT RENDERED AT HALF SIZE. The old source was ALREADY a 96 x 96 square,
 *     so the plugin's resize (`resizeMode: 'cover'` to 24/36/48/72/96 px, one
 *     per density -- expo-notifications/plugin/build/withNotificationsAndroid.js)
 *     was a plain proportional downscale: nothing was squeezed or cropped.
 *     The glyph was simply small ON that square. Its measured alpha bounding
 *     box was 73 x 41 inside the 96: 43% of the available height, about 10dp
 *     of the 24 Android draws on screen. (An earlier note here blamed a
 *     "squash" of the 1.78:1 lockup; that mechanism was wrong.)
 *
 * KEEP THE SOURCE SQUARE. Because the resize is 'cover', a NON-square source
 * is the hazard: it is scaled to fill the square and centre-CROPPED, which
 * silently cuts off the ends of a wide glyph. This script always emits a
 * square, and the glyph is fitted inside it; do not replace the output with a
 * hand-made non-square image.
 *
 * THE FIX. The favicon's own two strokes -- ecosystem-web/public/c7-mark.svg,
 * the same path data src/ui/c7.tsx draws -- are very nearly square (49.0 x
 * 47.1 in the 64-unit viewBox), so they fill the canvas. Scaled to the
 * Material system-icon keyline (20 of 24, i.e. 160 of 192 here) the glyph
 * lands at 160 x 154 px: 80% of the height against the old 43%.
 *
 * ANDROID DISCARDS THE COLOUR CHANNELS of a small icon and tints the alpha
 * silhouette with the colour declared in app.json, so this is drawn as pure
 * white on transparent and the two strokes merge into one shape. The C's
 * counter is a hole in the alpha, which is what keeps it readable at 24dp.
 *
 * The output is 192 px: twice xxxhdpi, so every density Expo generates is a
 * downsample and none is ever enlarged.
 *
 * WHICH NOTIFICATIONS THIS ICON REACHES -- read before judging it on a phone.
 * app.json hands this PNG and its colour to the expo-notifications plugin,
 * which writes them as the app's DEFAULT notification icon and colour. That
 * default applies only to notifications Android (or expo-notifications)
 * draws itself: every push sent WITH a `notification` block -- messages,
 * contact requests, new-device sign-ins, channel-live, and the like
 * (services/account/src/push/fcm-provider.ts builds that block for every
 * kind except 'call').
 *
 * IT DOES NOT REACH THE CALL NOTIFICATIONS. A call push is sent DATA-ONLY
 * (fcm-provider.ts: `dataOnly = notification.kind === 'call'`), Android draws
 * nothing for it, and the native module posts the ring itself with its own
 * icon, set explicitly in
 * modules/videofy-call/android/.../IncomingCallService.kt:
 *
 *   - the incoming-call (ring) notification .......... android.R.drawable.sym_call_incoming
 *   - the silent "Checking a call" stand-in .......... android.R.drawable.sym_call_incoming
 *   - the "Missed call" stub for an expired push ..... android.R.drawable.sym_call_missed
 *
 * Those three keep Android's stock telephone glyph regardless of anything in
 * this file or app.json. So after a build, the RING -- the notification most
 * often seen -- will look exactly as it did before; that is not this change
 * failing. Whether the ring should carry the C7 mark is a separate decision
 * about the native module, not yet made.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------- geometry
// Transcribed from apps/ecosystem-web/public/c7-mark.svg, viewBox 0 0 64 64.
//   <path d="M45.5 17.6 A19.8 19.8 0 1 0 45.5 46.4" stroke-width="7.5" stroke-linecap="square"/>
//   <path d="M34.5 17.6 H52 L40 50"                 stroke-width="7.5" stroke-linejoin="miter" stroke-linecap="square"/>
const HALF = 7.5 / 2;

const R = 19.8;
const P1 = { x: 45.5, y: 17.6 };
const P2 = { x: 45.5, y: 46.4 };
// The endpoints share an x, so the centre lies on their midline; the chord
// half-length and the radius give the offset.
const halfChord = (P2.y - P1.y) / 2;
const ARC_C = { x: P1.x - Math.sqrt(R * R - halfChord * halfChord), y: (P1.y + P2.y) / 2 };
const TH1 = Math.atan2(P1.y - ARC_C.y, P1.x - ARC_C.x);
const TH2 = Math.atan2(P2.y - ARC_C.y, P2.x - ARC_C.x);
// large-arc=1 with sweep=0 means the drawn arc is everything EXCEPT the wedge
// between TH1 and TH2 -- that wedge is the C's opening on the right.

const BAR_START = { x: 34.5, y: 17.6 };
const JOIN = { x: 52, y: 17.6 };
const STEM_END = { x: 40, y: 50 };

function unit(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  return { x: dx / len, y: dy / len, len };
}
const dBar = unit(BAR_START, JOIN);
const dStem = unit(JOIN, STEM_END);

/** The normal on the outside of the corner -- the side the miter spike grows from. */
function outerNormal(d, towards) {
  const n = { x: d.y, y: -d.x };
  return d.x * towards.y - d.y * towards.x > 0 ? n : { x: -n.x, y: -n.y };
}
const nBar = outerNormal(dBar, dStem);
const nStem = outerNormal(dStem, { x: -dBar.x, y: -dBar.y });
const QBar = { x: JOIN.x + HALF * nBar.x, y: JOIN.y + HALF * nBar.y };
const QStem = { x: JOIN.x + HALF * nStem.x, y: JOIN.y + HALF * nStem.y };
/** Where the two outer edges meet: the miter tip. */
const MITER = (() => {
  const denom = dBar.x * dStem.y - dBar.y * dStem.x;
  const t = ((QStem.x - QBar.x) * dStem.y - (QStem.y - QBar.y) * dStem.x) / denom;
  return { x: QBar.x + t * dBar.x, y: QBar.y + t * dBar.y };
})();

/** Inside the stroke band running `lo..hi` along `d` from `from`. */
function inBand(p, from, d, lo, hi) {
  const vx = p.x - from.x;
  const vy = p.y - from.y;
  const along = vx * d.x + vy * d.y;
  const across = vx * -d.y + vy * d.x;
  return along >= lo && along <= hi && Math.abs(across) <= HALF;
}

function inTriangle(p, a, b, c) {
  const s = (a.x - c.x) * (p.y - c.y) - (a.y - c.y) * (p.x - c.x);
  const t = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  if (s < 0 !== t < 0 && s !== 0 && t !== 0) return false;
  const u = (c.x - b.x) * (p.y - b.y) - (c.y - b.y) * (p.x - b.x);
  return u === 0 || u < 0 === s + t <= 0;
}

/** Is this point inked, in the SVG's 64-unit space? */
function inked(p) {
  const d = Math.hypot(p.x - ARC_C.x, p.y - ARC_C.y);
  if (Math.abs(d - R) <= HALF) {
    const th = Math.atan2(p.y - ARC_C.y, p.x - ARC_C.x);
    if (!(th > TH1 && th < TH2)) return true;
  }
  // The arc's two square caps, each a HALF-deep block past its endpoint.
  const t1 = { x: Math.sin(TH1), y: -Math.cos(TH1) };
  if (inBand(p, P1, { x: -t1.x, y: -t1.y }, 0, HALF)) return true;
  const t2 = { x: Math.sin(TH2), y: -Math.cos(TH2) };
  if (inBand(p, P2, t2, 0, HALF)) return true;
  // The 7's bar and stem: square cap at each free end, flat into the join.
  if (inBand(p, BAR_START, dBar, -HALF, dBar.len)) return true;
  if (inBand(p, JOIN, dStem, 0, dStem.len + HALF)) return true;
  // The miter wedge. It must include the corner vertex itself, or the spike
  // only touches the bar at a single point and leaves a notch.
  if (inTriangle(p, JOIN, QBar, MITER)) return true;
  if (inTriangle(p, JOIN, MITER, QStem)) return true;
  return false;
}

// ----------------------------------------------------------------- raster
const SIZE = 192;
/** Material system icons keep a 2dp keyline inside the 24dp box. */
const LIVE = (SIZE * 20) / 24;
const SAMPLES = 4; // 4x4 per pixel -- the edges must stay antialiased at 24dp

// Measure the glyph from the shape rather than assuming the viewBox is tight.
let minX = Infinity;
let maxX = -Infinity;
let minY = Infinity;
let maxY = -Infinity;
for (let x = 0; x <= 64; x += 0.01) {
  for (let y = 0; y <= 64; y += 0.01) {
    if (!inked({ x, y })) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
}
const scale = LIVE / Math.max(maxX - minX, maxY - minY);
const offX = (SIZE - (maxX - minX) * scale) / 2 - minX * scale;
const offY = (SIZE - (maxY - minY) * scale) / 2 - minY * scale;

const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let hit = 0;
    for (let sy = 0; sy < SAMPLES; sy++) {
      for (let sx = 0; sx < SAMPLES; sx++) {
        const x = (px + (sx + 0.5) / SAMPLES - offX) / scale;
        const y = (py + (sy + 0.5) / SAMPLES - offY) / scale;
        if (inked({ x, y })) hit++;
      }
    }
    const i = (py * SIZE + px) * 4;
    // White on transparent: Android throws the colour away and tints the alpha.
    pixels[i] = 255;
    pixels[i + 1] = 255;
    pixels[i + 2] = 255;
    pixels[i + 3] = Math.round((hit / (SAMPLES * SAMPLES)) * 255);
  }
}

// -------------------------------------------------------------- png encode
const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, payload) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const stride = SIZE * 4;
const raw = Buffer.alloc(SIZE * (stride + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (stride + 1)] = 0; // filter type 0
  pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), 'notification-icon.png');
writeFileSync(out, png);
process.stdout.write(
  `${out}\n` +
    `  canvas ${SIZE}x${SIZE}, glyph ${Math.round((maxX - minX) * scale)}x${Math.round((maxY - minY) * scale)} ` +
    `(${(((maxX - minX) * scale) / SIZE * 100).toFixed(1)}% x ${(((maxY - minY) * scale) / SIZE * 100).toFixed(1)}%)\n`,
);
