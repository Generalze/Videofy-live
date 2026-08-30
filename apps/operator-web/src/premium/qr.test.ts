/** @author masterzee001 */
/**
 * The encoder is checked the way a scanner would check it: read the symbol
 * back. The test walks the data region with its own copy of the placement
 * rules, removes the announced mask, splits the codewords back into blocks,
 * verifies every block's Reed-Solomon syndromes are zero, and then parses
 * the byte-mode header back into the original text. A symbol that passes
 * this decodes on any conforming reader.
 */
import { describe, expect, it } from 'vitest';
import { QR_MAX_VERSION, encodeQr, qrByteCapacity, qrFormatBits, qrMaskBit, qrSvgPath, qrViewBox } from './qr';

const LEVEL_M: readonly (readonly [data: number, ecc: number, blocks: number])[] = [
  [16, 10, 1],
  [28, 16, 1],
  [44, 26, 1],
  [64, 18, 2],
  [86, 24, 2],
  [108, 16, 4],
];
const ALIGNMENT_CENTRE = [0, 18, 22, 26, 30, 34];

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function gfPower(base: number, exponent: number): number {
  let result = 1;
  for (let i = 0; i < exponent; i++) result = gfMultiply(result, base);
  return result;
}

/** Which modules carry function patterns rather than data, from the spec's geometry alone. */
function functionMap(size: number, version: number): boolean[][] {
  const centre = ALIGNMENT_CENTRE[version - 1] ?? 0;
  return Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => {
      if (x < 9 && y < 9) return true; // finder, separator, format copy 1
      if (x >= size - 8 && y < 9) return true; // finder, separator, format copy 2 (row 8)
      if (x < 9 && y >= size - 8) return true; // finder, separator, format copy 2 (column 8), dark module
      if (x === 6 || y === 6) return true; // timing
      if (centre > 0 && Math.abs(x - centre) <= 2 && Math.abs(y - centre) <= 2) return true;
      return false;
    }),
  );
}

/** Read the interleaved codewords back out of a symbol, unmasked. */
function readCodewords(symbol: ReturnType<typeof encodeQr>): number[] {
  const { size, version, mask, modules } = symbol;
  const isFunction = functionMap(size, version);
  const [data, ecc, blocks] = LEVEL_M[version - 1]!;
  const total = data + ecc * blocks;
  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (!isFunction[y]![x] && bits.length < total * 8) {
          const raw = modules[y]![x]!;
          bits.push(raw !== qrMaskBit(mask, x, y) ? 1 : 0);
        }
      }
    }
  }
  const codewords: number[] = [];
  for (let i = 0; i < total; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i * 8 + b]!;
    codewords.push(byte);
  }
  return codewords;
}

function decode(symbol: ReturnType<typeof encodeQr>): { text: string; syndromes: number[][] } {
  const [data, ecc, blockCount] = LEVEL_M[symbol.version - 1]!;
  const interleaved = readCodewords(symbol);
  const blockLength = data / blockCount + ecc;
  const blocks = Array.from({ length: blockCount }, (_, b) =>
    Array.from({ length: blockLength }, (_, i) => interleaved[i * blockCount + b]!),
  );
  const syndromes = blocks.map((block) =>
    Array.from({ length: ecc }, (_, j) =>
      block.reduce((sum, codeword, i) => sum ^ gfMultiply(codeword, gfPower(gfPower(2, j), block.length - 1 - i)), 0),
    ),
  );
  const dataBytes = blocks.flatMap((block) => block.slice(0, data / blockCount));
  const bits = dataBytes.flatMap((byte) => Array.from({ length: 8 }, (_, i) => (byte >>> (7 - i)) & 1));
  const read = (at: number, length: number): number => bits.slice(at, at + length).reduce((v, bit) => (v << 1) | bit, 0);
  expect(read(0, 4)).toBe(0b0100);
  const count = read(4, 8);
  const bytes = Array.from({ length: count }, (_, i) => read(12 + i * 8, 8));
  return { text: new TextDecoder().decode(new Uint8Array(bytes)), syndromes };
}

describe('encodeQr', () => {
  it.each([
    ['Hi', 1],
    ['https://c7.example/streams/resume_channel', 3],
    ['résumé → café à la Videofy Live, @handle', 4],
    ['x'.repeat(84), 5],
    [`https://videofy.example.org/streams/${'a'.repeat(70)}`, 6],
  ])('round-trips %j through version %i and leaves every block with zero syndromes', (text, version) => {
    const symbol = encodeQr(text);
    expect(symbol.version).toBe(version);
    expect(symbol.size).toBe(version * 4 + 17);
    const decoded = decode(symbol);
    expect(decoded.text).toBe(text);
    for (const block of decoded.syndromes) expect(block.every((s) => s === 0)).toBe(true);
  });

  it('chooses the smallest version that fits and refuses text past version 6', () => {
    expect(qrByteCapacity(1)).toBe(14);
    expect(qrByteCapacity(QR_MAX_VERSION)).toBe(106);
    expect(encodeQr('a'.repeat(14)).version).toBe(1);
    expect(encodeQr('a'.repeat(15)).version).toBe(2);
    expect(encodeQr('a'.repeat(42)).version).toBe(3);
    expect(encodeQr('a'.repeat(43)).version).toBe(4);
    expect(encodeQr('a'.repeat(106)).version).toBe(6);
    expect(() => encodeQr('a'.repeat(107))).toThrow(/version 6/);
  });

  it('draws the three finder patterns, the timing lines and the dark module', () => {
    const { size, modules } = encodeQr('finder');
    const finderAt = (cx: number, cy: number): void => {
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const ring = Math.max(Math.abs(dx), Math.abs(dy));
          expect(modules[cy + dy]![cx + dx]).toBe(ring !== 2);
        }
      }
    };
    finderAt(3, 3);
    finderAt(size - 4, 3);
    finderAt(3, size - 4);
    for (let i = 8; i < size - 8; i++) {
      expect(modules[6]![i]).toBe(i % 2 === 0);
      expect(modules[i]![6]).toBe(i % 2 === 0);
    }
    expect(modules[size - 8]![8]).toBe(true);
  });

  it('writes the same BCH-protected format information in both copies, naming level M and the chosen mask', () => {
    const symbol = encodeQr('format');
    const { size, modules, mask } = symbol;
    const expected = qrFormatBits(mask);
    const copyOne: number[] = [];
    for (let i = 0; i <= 5; i++) copyOne.push(modules[i]![8] ? 1 : 0);
    copyOne.push(modules[7]![8] ? 1 : 0, modules[8]![8] ? 1 : 0, modules[8]![7] ? 1 : 0);
    for (let i = 9; i < 15; i++) copyOne.push(modules[8]![14 - i] ? 1 : 0);
    const copyTwo: number[] = [];
    for (let i = 0; i < 8; i++) copyTwo.push(modules[8]![size - 1 - i] ? 1 : 0);
    for (let i = 8; i < 15; i++) copyTwo.push(modules[size - 15 + i]![8] ? 1 : 0);
    const value = (bits: number[]): number => bits.reduce((v, bit, i) => v | (bit << i), 0);
    expect(value(copyOne)).toBe(expected);
    expect(value(copyTwo)).toBe(expected);
    // Level M is 00 in the top two data bits once the 0x5412 mask is removed.
    expect(((expected ^ 0x5412) >>> 13) & 0b11).toBe(0b00);
    expect(((expected ^ 0x5412) >>> 10) & 0b111).toBe(mask);
  });

  it('renders one unit square per dark module inside a four-module quiet zone', () => {
    const symbol = encodeQr('svg');
    const dark = symbol.modules.flat().filter(Boolean).length;
    expect(qrSvgPath(symbol).match(/M\d+ \d+h1v1h-1z/g)?.length).toBe(dark);
    expect(qrViewBox(symbol)).toBe(`-4 -4 ${symbol.size + 8} ${symbol.size + 8}`);
  });
});
