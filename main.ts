// png-squeeze-01 entry: a small lossless PNG re-encoder.
//
// Reads /input/<id>/image.png (1280x720 RGBA screenshots) and writes
// /output/<id>/image.png, as small as possible, losslessly.
//
// How it works, per image:
//   1. Decode the input PNG with a decoder written here (chunk walk, zlib
//      inflate, row unfiltering for all five filter types).
//   2. Analyse the pixels: how many distinct RGBA colours, whether every
//      pixel is grey, whether every pixel is opaque, and whether a single
//      fully-transparent colour value could be keyed with tRNS instead of
//      an alpha channel.
//   3. Pick the cheapest colour form: palette (type 3) when there are at
//      most 256 colours, grey (type 0) / grey+alpha (type 4) for grey
//      images, RGB (type 2, with a tRNS key when one exists) for opaque
//      colour, RGBA (type 6) otherwise.
//   4. For each form, filter every row several ways and keep the smallest
//      deflate of them: per-row filter by minimum signed-byte sum, per-row
//      filter by a byte-histogram entropy estimate, per-row filter by the
//      fewest distinct neighbouring byte pairs, per-row filter by brute
//      force (each trial row deflated against the 32 KiB before it), and
//      each of the five filters fixed on every row. Each candidate is deflated with zlib level 9,
//      memLevel 9, and the smallest whole file (chunks included) wins; the
//      winner is then tried once more with zlib's filtered strategy.
//   5. Verify the winner by decoding it again and comparing every pixel
//      with the input; if that ever failed, fall back to a stored RGBA
//      copy so the answer is always a valid image.
//
// Determinism: no clock, no randomness, no environment-dependent choice;
// the same input always produces the same bytes. The work per image is
// fixed, so the run fits its wall budget by construction.

import { inflateSync, deflateSync, constants as zlibConstants } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------- CRC-32

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ------------------------------------------------------------ PNG decode

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Decode any PNG the contest accepts into {width, height, colourType, rgba}.
function decodePng(bytes) {
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error(type + ' CRC');
    at += 12 + len;
    if (type === 'IHDR') {
      header = {
        width: view.getUint32(at - len - 4 + 0) || 0,
        height: 0,
        colourType: data[9],
      };
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header.width = dv.getUint32(0);
      header.height = dv.getUint32(4);
      if (data[8] !== 8) throw new Error('bit depth is not 8');
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') ended = true;
    else throw new Error('unexpected chunk ' + type);
  }
  if (!header || !ended || idat.length === 0) throw new Error('incomplete PNG');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error('inflated size mismatch');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    } else throw new Error('bad filter ' + ft);
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error('palette index out of range');
      rgba[d] = palette[e * 3];
      rgba[d + 1] = palette[e * 3 + 1];
      rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { width, height, colourType, rgba };
}

// ------------------------------------------------------------ PNG encode

function chunkBytes(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

// Assemble a PNG: IHDR, optional PLTE, optional tRNS, one IDAT, IEND.
function buildPng(width, height, colourType, plte, trns, idat) {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = colourType;
  const parts = [new Uint8Array(SIGNATURE), chunkBytes('IHDR', ihdr)];
  if (plte !== null) parts.push(chunkBytes('PLTE', plte));
  if (trns !== null) parts.push(chunkBytes('tRNS', trns));
  parts.push(chunkBytes('IDAT', idat));
  parts.push(chunkBytes('IEND', new Uint8Array(0)));
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// A stored (uncompressed) RGBA PNG of the input pixels: the fallback.
function storedPng(rgba, width, height) {
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const zlib = new Uint8Array(2 + raw.length + 5 * blocks + 4);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  let at = 2;
  for (let k = 0; k < blocks; k++) {
    const from = k * 65535;
    const len = Math.min(65535, raw.length - from);
    zlib[at] = k === blocks - 1 ? 1 : 0;
    zlib[at + 1] = len & 0xff;
    zlib[at + 2] = len >>> 8;
    zlib[at + 3] = ~len & 0xff;
    zlib[at + 4] = (~len >>> 8) & 0xff;
    zlib.set(raw.subarray(from, from + len), at + 5);
    at += 5 + len;
  }
  // Adler-32 of the raw data.
  let a = 1;
  let b = 0;
  for (let i = 0; i < raw.length; ) {
    const end = Math.min(raw.length, i + 5552);
    for (; i < end; i++) {
      a += raw[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  new DataView(zlib.buffer).setUint32(at, ((b << 16) | a) >>> 0);
  return buildPng(width, height, 6, null, null, zlib);
}

// ------------------------------------------------------------- analysis

// What the image holds: opaque? grey? its colours when there are <= 256.
function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const r = rgba[d];
    const g = rgba[d + 1];
    const b = rgba[d + 2];
    const a = rgba[d + 3];
    if (a !== 255) opaque = false;
    if (r !== g || r !== b) grey = false;
    if (!many) {
      const word = (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
      const k = counts.get(word);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(word, 1);
      } else counts.set(word, k + 1);
    }
  }
  return { opaque, grey, colours: many ? null : counts };
}

// The one fully-transparent colour value the image may key by tRNS
// instead of carrying an alpha channel: every non-opaque pixel is that
// exact value at alpha 0, and no opaque pixel shares the value.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

// ------------------------------------------------------------ colour forms

// The image's samples in colour type ct (0, 2, 4 or 6) from its RGBA.
function channelSamples(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

// Palette entries in trial order: transparent entries first (by alpha),
// then by `order` ('count': most used first; 'luminance': darkest first).
function paletteForm(rgba, counts, order) {
  const cols = [];
  for (const [word, count] of counts) {
    cols.push({
      r: word & 0xff,
      g: (word >>> 8) & 0xff,
      b: (word >>> 16) & 0xff,
      a: (word >>> 24) & 0xff,
      word,
      count,
    });
  }
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  cols.sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0;
    const ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map();
  const plte = new Uint8Array(cols.length * 3);
  let transparent = 0;
  cols.forEach((c, i) => {
    index.set(c.word, i);
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(cols.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    indices[i] = index.get((rgba[d] | (rgba[d + 1] << 8) | (rgba[d + 2] << 16) | (rgba[d + 3] << 24)) >>> 0);
  }
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

// The forms to try for an image, each {colourType, bpp, samples, plte, trns}.
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    forms.push(paletteForm(rgba, colours, 'count'));
    forms.push(paletteForm(rgba, colours, 'luminance'));
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: channelSamples(rgba, ct), plte: null, trns });
  return forms;
}

// -------------------------------------------------------------- filtering

// c * log2(c), for c up to the widest row: the entropy estimate's table.
// For a row of n bytes with counts c[v], its entropy in bits is
// log2(n) - (1/n) * sum_v c[v]*log2(c[v]); n is the same for every filter
// of the row, so the filter with the largest sum has the lowest entropy.
const LOGC = (() => {
  const t = new Float64Array(5121);
  for (let c = 1; c < t.length; c++) t[c] = c * Math.log2(c);
  return t;
})();

// Filter every row of `samples` (height rows of width*bpp) five ways into
// five buffers, and pick each row's filter twice: once by the smallest
// signed-byte sum, once by the largest entropy score. Returns the five
// buffers and the two per-row choice arrays.
function trialFilters(samples, width, height, bpp) {
  const stride = width * bpp;
  const bufs = [];
  for (let t = 0; t < 5; t++) bufs.push(new Uint8Array(height * stride));
  const choiceSum = new Uint8Array(height);
  const choiceEnt = new Uint8Array(height);
  const hist = new Uint32Array(5 * 256);
  const sums = new Float64Array(5);
  const ents = new Float64Array(5);
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const rowAt = y * stride;
    hist.fill(0);
    sums[0] = sums[1] = sums[2] = sums[3] = sums[4] = 0;
    const b0 = bufs[0];
    const b1 = bufs[1];
    const b2 = bufs[2];
    const b3 = bufs[3];
    const b4 = bufs[4];
    for (let i = 0; i < stride; i++) {
      const x = cur[i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      const f0 = x;
      const f1 = (x - a) & 0xff;
      const f2 = (x - b) & 0xff;
      const f3 = (x - ((a + b) >> 1)) & 0xff;
      const f4 = (x - paeth(a, b, c)) & 0xff;
      b0[rowAt + i] = f0;
      b1[rowAt + i] = f1;
      b2[rowAt + i] = f2;
      b3[rowAt + i] = f3;
      b4[rowAt + i] = f4;
      sums[0] += f0 < 128 ? f0 : 256 - f0;
      sums[1] += f1 < 128 ? f1 : 256 - f1;
      sums[2] += f2 < 128 ? f2 : 256 - f2;
      sums[3] += f3 < 128 ? f3 : 256 - f3;
      sums[4] += f4 < 128 ? f4 : 256 - f4;
      hist[f0]++;
      hist[256 + f1]++;
      hist[512 + f2]++;
      hist[768 + f3]++;
      hist[1024 + f4]++;
    }
    let bestSum = 0;
    let bestEnt = 0;
    for (let t = 0; t < 5; t++) {
      if (sums[t] < sums[bestSum]) bestSum = t;
      let s = 0;
      const h = hist.subarray(t * 256, t * 256 + 256);
      for (let v = 0; v < 256; v++) s += LOGC[h[v]];
      ents[t] = s;
      if (s > ents[bestEnt]) bestEnt = t;
    }
    choiceSum[y] = bestSum;
    choiceEnt[y] = bestEnt;
  }
  return { bufs, choiceSum, choiceEnt };
}

// The filtered raw data (filter byte + row, per row) for a per-row choice.
function assemble(bufs, choice, width, height, bpp) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const t = choice[y];
    raw[y * (stride + 1)] = t;
    raw.set(bufs[t].subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return raw;
}

// The filtered raw data for one fixed filter on every row.
function assembleFixed(bufs, t, width, height, bpp) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = t;
    raw.set(bufs[t].subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return raw;
}

// Each row's filter by brute force: deflate the row's five trial
// versions (filter byte included) against the 32 KiB of raw data written
// just before it, and keep the version that compresses smallest. This is
// the most direct measure of what the final deflate will do with the row,
// and it is worth its cost because the work is fixed per image.
function bruteChoices(bufs, width, height, bpp) {
  const stride = width * bpp;
  const choice = new Uint8Array(height);
  const raw = new Uint8Array(height * (stride + 1));
  const trial = new Uint8Array(stride + 1);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    const before = raw.subarray(Math.max(0, at - 32768), at);
    let bestT = 0;
    let bestLen = Infinity;
    for (let t = 0; t < 5; t++) {
      trial[0] = t;
      trial.set(bufs[t].subarray(y * stride, (y + 1) * stride), 1);
      const len = deflateSync(
        trial,
        before.length === 0
          ? { level: 4, memLevel: 9 }
          : { level: 4, memLevel: 9, dictionary: before },
      ).length;
      if (len < bestLen) {
        bestLen = len;
        bestT = t;
      }
    }
    choice[y] = bestT;
    raw[at] = bestT;
    raw.set(bufs[bestT].subarray(y * stride, (y + 1) * stride), at + 1);
  }
  return choice;
}

// Each row's filter by the fewest distinct pairs of neighbouring bytes:
// a row whose filtered bytes repeat the same pairs compresses well. The
// stamp array marks which pairs this row has seen, per filter in turn.
function pairsChoices(bufs, width, height, bpp) {
  const stride = width * bpp;
  const choice = new Uint8Array(height);
  const seen = new Uint32Array(65536);
  let stamp = 0;
  const counts = new Uint32Array(5);
  for (let y = 0; y < height; y++) {
    counts[0] = counts[1] = counts[2] = counts[3] = counts[4] = 0;
    for (let t = 0; t < 5; t++) {
      const row = bufs[t].subarray(y * stride, (y + 1) * stride);
      stamp++;
      let n = 0;
      let prev = row[0];
      for (let i = 1; i < stride; i++) {
        const pair = (prev << 8) | row[i];
        if (seen[pair] !== stamp) {
          seen[pair] = stamp;
          n++;
        }
        prev = row[i];
      }
      counts[t] = n;
    }
    let best = 0;
    for (let t = 1; t < 5; t++) if (counts[t] < counts[best]) best = t;
    choice[y] = best;
  }
  return choice;
}

// ------------------------------------------------------------- per image

const ZLIB_OPTS = { level: 9, memLevel: 9 };
const ZLIB_FILTERED = { level: 9, memLevel: 9, strategy: zlibConstants.Z_FILTERED };

// Encode one image, returning the smallest verified PNG of it.
function encodeImage(rgba, width, height) {
  const forms = formsOf(rgba);
  let best = null;
  for (const form of forms) {
    const { bufs, choiceSum, choiceEnt } = trialFilters(form.samples, width, height, form.bpp);
    const choicePairs = pairsChoices(bufs, width, height, form.bpp);
    const overhead = (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
    const candidates = [
      assemble(bufs, choiceSum, width, height, form.bpp),
      assemble(bufs, choiceEnt, width, height, form.bpp),
      assemble(bufs, choicePairs, width, height, form.bpp),
    ];
    // Brute force costs five small deflates a row, so it runs only on the
    // channel forms, where it has won; on palette rows the heuristics
    // already pick the same filters it would.
    if (form.colourType !== 3) {
      candidates.push(assemble(bufs, bruteChoices(bufs, width, height, form.bpp), width, height, form.bpp));
    }
    for (let t = 0; t < 5; t++) candidates.push(assembleFixed(bufs, t, width, height, form.bpp));
    for (const raw of candidates) {
      const zlib = deflateSync(raw, ZLIB_OPTS);
      const total = zlib.length + overhead;
      if (best === null || total < best.total) best = { total, form, raw, zlib };
    }
  }
  // One more try on the winner: zlib's filtered strategy, which suits
  // data that is mostly small filtered bytes.
  const alt = deflateSync(best.raw, ZLIB_FILTERED);
  if (alt.length < best.zlib.length) best = { total: best.total - best.zlib.length + alt.length, form: best.form, raw: best.raw, zlib: alt };
  const png = buildPng(width, height, best.form.colourType, best.form.plte, best.form.trns, best.zlib);
  // Verify losslessness against the input pixels before trusting it.
  const decoded = decodePng(png);
  if (decoded.width !== width || decoded.height !== height || decoded.rgba.length !== rgba.length) {
    return storedPng(rgba, width, height);
  }
  for (let i = 0; i < rgba.length; i++) {
    if (decoded.rgba[i] !== rgba[i]) return storedPng(rgba, width, height);
  }
  return png;
}

// ------------------------------------------------------------------ main

for (const id of readdirSync(INPUT_DIR).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), encodeImage(image.rgba, image.width, image.height));
}
