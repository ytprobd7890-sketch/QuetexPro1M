/**
 * Generates the PWA icons without any dependency:
 * rasterises a green "Q" mark at 2× and box-downsamples for anti-aliasing,
 * then writes the PNG by hand (zlib + CRC32).
 *
 *   node scripts/make-icons.mjs
 */

import zlib from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

/* ----------------------------- PNG writer ----------------------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ------------------------------ drawing ------------------------------- */

const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function render(size) {
  const ss = 2;                       // supersampling factor
  const S = size * ss;
  const buf = Buffer.alloc(size * size * 4);
  const acc = new Float32Array(S * S * 4);

  const cx = S * 0.5, cy = S * 0.47;
  const rOut = S * 0.30, rIn = S * 0.185, rMid = (rOut + rIn) / 2, rHalf = (rOut - rIn) / 2;

  // tail capsule (bottom-right of the ring)
  const a = { x: cx + S * 0.185, y: cy + S * 0.185 };
  const b = { x: cx + S * 0.315, y: cy + S * 0.315 };
  const capR = S * 0.052;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x - cx, dy = y - cy;
      const d = Math.hypot(dx, dy);
      const ring = 1 - smoothstep(rHalf - ss * 1.2, rHalf + ss * 1.2, Math.abs(d - rMid));

      // distance to the tail segment
      const vx = b.x - a.x, vy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / (vx * vx + vy * vy)));
      const px = a.x + t * vx, py = a.y + t * vy;
      const tc = 1 - smoothstep(capR - ss * 1.2, capR + ss * 1.2, Math.hypot(x - px, y - py));

      const mark = Math.max(ring, tc);

      // background: subtle diagonal gradient
      const g = (x / S) * 0.5 + (y / S) * 0.5;
      let r = 6 + g * 6;
      let gr = 11 + g * 16;
      let bl = 15 + g * 12;

      // neon mark
      const mr = 46, mg = 230, mb = 168;
      r = r * (1 - mark) + mr * mark;
      gr = gr * (1 - mark) + mg * mark;
      bl = bl * (1 - mark) + mb * mark;

      const i = (y * S + x) * 4;
      acc[i] += r; acc[i + 1] += gr; acc[i + 2] += bl; acc[i + 3] += 255;
    }
  }

  // box downsample
  const n = ss * ss;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, al = 0;
      for (let oy = 0; oy < ss; oy++) {
        for (let ox = 0; ox < ss; ox++) {
          const i = ((y * ss + oy) * S + (x * ss + ox)) * 4;
          r += acc[i]; g += acc[i + 1]; b += acc[i + 2]; al += acc[i + 3];
        }
      }
      const i = (y * size + x) * 4;
      buf[i] = Math.round(r / n);
      buf[i + 1] = Math.round(g / n);
      buf[i + 2] = Math.round(b / n);
      buf[i + 3] = Math.round(al / n);
    }
  }

  return encodePng(size, size, buf);
}

mkdirSync(new URL('../icons/', import.meta.url), { recursive: true });
for (const size of [180, 192, 512]) {
  const png = render(size);
  const path = new URL(`../icons/icon-${size}.png`, import.meta.url);
  writeFileSync(path, png);
  console.log(`icons/icon-${size}.png  ${(png.length / 1024).toFixed(1)} KB`);
}

// Android launcher densities
const mipmaps = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [density, size] of Object.entries(mipmaps)) {
  const dir = new URL(`../android/app/src/main/res/mipmap-${density}/`, import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL('ic_launcher.png', dir), render(size));
  console.log(`android mipmap-${density}/ic_launcher.png (${size}px)`);
}
