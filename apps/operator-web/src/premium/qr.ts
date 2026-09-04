/** @author masterzee001 */
/**
 * A small QR encoder: byte mode, error-correction level M, versions 1 to 6.
 *
 * The operator shell needs one QR code -- the channel's public link
 * (founder directive, LOCKED 30 Aug 2026: "View channel / Edit channel / Copy
 * channel link / Share / QR"). A link is at most ~100 bytes, which version 6
 * at level M carries with room to spare, so the encoder stops there rather
 * than shipping the 40-version tables for a code nobody will print.
 *
 * ISO/IEC 18004 throughout: byte mode, Reed-Solomon over GF(2^8) with the
 * 0x11D polynomial, the eight standard masks scored by the four penalty
 * rules, BCH-protected format information. No dependency: the only QR
 * package in node_modules is a transitive dependency of a tool, and a
 * console must not lean on something a tool could stop installing.
 */

export interface QrMatrix {
  /** Modules per side (21 for version 1, +4 per version). */
  readonly size: number;
  readonly version: number;
  /** The mask pattern the encoder chose, 0-7. */
  readonly mask: number;
  /** modules[row][column]; true is a dark module. */
  readonly modules: readonly (readonly boolean[])[];
}

export const QR_MAX_VERSION = 6;

/** Level M, byte mode: [data codewords, error-correction codewords per block, blocks], by version. */
const LEVEL_M: readonly (readonly [dataCodewords: number, eccPerBlock: number, blocks: number])[] = [
  [16, 10, 1], // v1, 26 codewords
  [28, 16, 1], // v2, 44
  [44, 26, 1], // v3, 70
  [64, 18, 2], // v4, 100
  [86, 24, 2], // v5, 134
  [108, 16, 4], // v6, 172
];

/** Byte-mode capacity at level M: the data codewords minus the 12-bit mode and count header. */
export function qrByteCapacity(version: number): number {
  const row = LEVEL_M[version - 1];
  if (row === undefined) throw new Error(`QR version ${version} is outside 1-${QR_MAX_VERSION}.`);
  return row[0] - 2;
}

/** The centre of the single alignment pattern for versions 2-6 (version 1 has none). */
const ALIGNMENT_CENTRE: readonly number[] = [0, 18, 22, 26, 30, 34];

/* ------------------------------------------------------------------ GF(256) */

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** The Reed-Solomon generator polynomial of the given degree, highest power first, monic. */
function rsGenerator(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < degree) result[j] = result[j]! ^ result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], generator: readonly number[]): number[] {
  const result = new Array<number>(generator.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    for (let j = 0; j < generator.length; j++) result[j] = result[j]! ^ gfMultiply(generator[j]!, factor);
  }
  return result;
}

/* ------------------------------------------------------------- bit packing */

class BitBuffer {
  readonly bits: number[] = [];

  append(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }

  toBytes(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (this.bits[i + j] ?? 0);
      out.push(byte);
    }
    return out;
  }
}

function versionFor(byteLength: number): number {
  for (let version = 1; version <= QR_MAX_VERSION; version++) {
    if (byteLength <= qrByteCapacity(version)) return version;
  }
  throw new Error(`QR text of ${byteLength} bytes exceeds version ${QR_MAX_VERSION} at level M (${qrByteCapacity(QR_MAX_VERSION)} bytes).`);
}

function dataCodewords(bytes: readonly number[], version: number): number[] {
  const capacityBits = LEVEL_M[version - 1]![0] * 8;
  const buffer = new BitBuffer();
  buffer.append(0b0100, 4); // byte mode
  buffer.append(bytes.length, 8); // versions 1-9 carry an 8-bit count
  for (const byte of bytes) buffer.append(byte, 8);
  buffer.append(0, Math.min(4, capacityBits - buffer.bits.length)); // terminator
  while (buffer.bits.length % 8 !== 0) buffer.bits.push(0);
  for (let pad = 0xec; buffer.bits.length < capacityBits; pad ^= 0xec ^ 0x11) buffer.append(pad, 8);
  return buffer.toBytes();
}

/**
 * Split the data into blocks, append each block's error-correction codewords
 * and interleave. Every level-M version up to 6 has equal-length blocks, so
 * the short/long block distinction of larger versions does not arise here.
 */
function withErrorCorrection(data: readonly number[], version: number): number[] {
  const [, eccPerBlock, blockCount] = LEVEL_M[version - 1]!;
  const blockLength = data.length / blockCount;
  const generator = rsGenerator(eccPerBlock);
  const blocks: number[][] = [];
  for (let b = 0; b < blockCount; b++) {
    const chunk = data.slice(b * blockLength, (b + 1) * blockLength);
    blocks.push([...chunk, ...rsRemainder(chunk, generator)]);
  }
  const out: number[] = [];
  const total = blockLength + eccPerBlock;
  for (let i = 0; i < total; i++) for (const block of blocks) out.push(block[i]!);
  return out;
}

/* ------------------------------------------------------------------ matrix */

class Matrix {
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];

  constructor(version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.isFunction[y]![x] = true;
  }

  drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
          this.setFunction(x, y, distance !== 2 && distance !== 4);
        }
      }
    }
  }

  drawAlignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  drawFunctionPatterns(version: number): void {
    for (let i = 0; i < this.size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);
    const centre = ALIGNMENT_CENTRE[version - 1] ?? 0;
    if (centre > 0) this.drawAlignment(centre, centre);
    this.drawFormat(0); // reserves the format areas; rewritten once the mask is chosen
  }

  drawFormat(mask: number): void {
    const bits = qrFormatBits(mask);
    const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
    this.setFunction(8, 7, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setFunction(this.size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFunction(8, this.size - 15 + i, bit(i));
    this.setFunction(8, this.size - 8, true); // the one module that is always dark
  }

  drawCodewords(codewords: readonly number[]): void {
    let i = 0;
    const totalBits = codewords.length * 8;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < this.size; vertical++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vertical : vertical;
          if (!this.isFunction[y]![x] && i < totalBits) {
            this.modules[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.isFunction[y]![x] && qrMaskBit(mask, x, y)) this.modules[y]![x] = !this.modules[y]![x];
      }
    }
  }

  penalty(): number {
    const N1 = 3;
    const N2 = 3;
    const N3 = 40;
    const N4 = 10;
    let score = 0;
    const lines: boolean[][] = [];
    for (let y = 0; y < this.size; y++) lines.push(this.modules[y]!);
    for (let x = 0; x < this.size; x++) lines.push(this.modules.map((row) => row[x]!));
    for (const line of lines) {
      let run = 1;
      for (let i = 1; i <= line.length; i++) {
        if (i < line.length && line[i] === line[i - 1]) {
          run++;
          continue;
        }
        if (run >= 5) score += N1 + run - 5;
        run = 1;
      }
      const text = line.map((dark) => (dark ? '1' : '0')).join('');
      for (const pattern of ['10111010000', '00001011101']) {
        for (let at = text.indexOf(pattern); at !== -1; at = text.indexOf(pattern, at + 1)) score += N3;
      }
    }
    for (let y = 0; y + 1 < this.size; y++) {
      for (let x = 0; x + 1 < this.size; x++) {
        const a = this.modules[y]![x];
        if (a === this.modules[y]![x + 1] && a === this.modules[y + 1]![x] && a === this.modules[y + 1]![x + 1]) score += N2;
      }
    }
    let dark = 0;
    for (const row of this.modules) for (const module of row) if (module) dark++;
    const total = this.size * this.size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    score += k * N4;
    return score;
  }
}

/** The 15 BCH-protected format bits for level M and the given mask (level M encodes as 00). */
export function qrFormatBits(mask: number): number {
  const data = (0b00 << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return ((data << 10) | remainder) ^ 0x5412;
}

/** Whether mask pattern `mask` flips the module at column x, row y. */
export function qrMaskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      throw new Error(`Mask ${mask} is not one of 0-7.`);
  }
}

/** Encode UTF-8 text as a level-M byte-mode symbol, choosing the smallest version and the best mask. */
export function encodeQr(text: string): QrMatrix {
  const bytes = [...new TextEncoder().encode(text)];
  const version = versionFor(bytes.length);
  const codewords = withErrorCorrection(dataCodewords(bytes, version), version);

  const matrix = new Matrix(version);
  matrix.drawFunctionPatterns(version);
  matrix.drawCodewords(codewords);

  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    matrix.applyMask(mask);
    matrix.drawFormat(mask);
    const score = matrix.penalty();
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
    }
    matrix.applyMask(mask); // XOR is its own inverse
  }
  matrix.applyMask(bestMask);
  matrix.drawFormat(bestMask);

  return {
    size: matrix.size,
    version,
    mask: bestMask,
    modules: matrix.modules.map((row) => [...row]),
  };
}

/** One SVG path drawing every dark module as a unit square, for a viewBox of `0 0 size size`. */
export function qrSvgPath(matrix: QrMatrix): string {
  const parts: string[] = [];
  matrix.modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x} ${y}h1v1h-1z`);
    });
  });
  return parts.join('');
}

/** The standard four-module quiet zone, as a viewBox string. */
export function qrViewBox(matrix: QrMatrix, quietZone = 4): string {
  return `${-quietZone} ${-quietZone} ${matrix.size + quietZone * 2} ${matrix.size + quietZone * 2}`;
}
