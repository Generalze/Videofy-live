/** @author masterzee001 */
/**
 * The packets in docs/certification/review-packets, read by a service for the
 * first time. These tests open the REAL files: a fixture would prove the
 * parser reads fixtures.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readQaSetDefinition } from '@videofy-live/language-specialist';
import { packetToQaSetDefinition, parseCsv } from '../qa-set-packets.js';
import { main, parseEngineFlag } from '../qa-set-packet-cli.js';

const here = dirname(fileURLToPath(import.meta.url));
const packets = join(here, '..', '..', '..', '..', 'docs', 'certification', 'review-packets');
const digest = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex');

const OPUS_FR = {
  'en->fr': { provider: 'opus-mt', model: 'Helsinki-NLP/opus-mt-en-fr', modelVersion: 'dd7f6540' },
  'fr->en': { provider: 'opus-mt', model: 'Helsinki-NLP/opus-mt-fr-en', modelVersion: 'c4aed37b' },
};

describe('parseCsv', () => {
  it('handles quoted commas, doubled quotes, CRLF and a BOM', () => {
    expect(parseCsv('﻿a,b\r\n1,"x, y"\r\n2,"say ""hi"""\n')).toEqual([
      ['a', 'b'],
      ['1', 'x, y'],
      ['2', 'say "hi"'],
    ]);
  });
});

describe('the French packet', () => {
  it('reads all forty items as one engine in two directions, and passes readQaSetDefinition', () => {
    const file = join(packets, 'review-fr.csv');
    if (!existsSync(file)) throw new Error(`the packet is missing: ${file}`);
    const result = packetToQaSetDefinition({
      language: 'fr',
      version: 'review-packets/2026-09-25',
      sourceReference: 'docs/certification/review-packets/review-fr.csv',
      reviewCsv: readFileSync(file, 'utf8'),
      singleEngineTag: 'opus',
      engines: { opus: OPUS_FR },
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.definition.items).toHaveLength(40);
    expect(result.definition.items.filter((i) => i.direction === 'en->fr')).toHaveLength(20);
    expect(result.definition.items.filter((i) => i.direction === 'fr->en')).toHaveLength(20);
    expect(result.definition.engines.map((e) => e.model).sort()).toEqual([
      'Helsinki-NLP/opus-mt-en-fr',
      'Helsinki-NLP/opus-mt-fr-en',
    ]);
    /* Row 25 is the known "demain" loss; it is in the set as written. */
    const demain = result.definition.items.find((i) => i.ordinal === 25);
    expect(demain?.sourceText).toBe('On se voit demain matin.');
    expect(demain?.candidateText).toBe("I'll see you in the morning.");

    const reading = readQaSetDefinition(result.definition, digest);
    expect(reading.ok, JSON.stringify(reading)).toBe(true);
  });

  it('refuses a single-engine packet with no engine named', () => {
    const result = packetToQaSetDefinition({
      language: 'fr',
      version: 'v',
      sourceReference: 'r',
      reviewCsv: readFileSync(join(packets, 'review-fr.csv'), 'utf8'),
      engines: { opus: OPUS_FR },
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems[0]).toMatch(/singleEngineTag/u);
  });
});

describe('the Yoruba packet', () => {
  const engines = {
    opus: {
      'en->yo': { provider: 'opus-mt', model: 'Helsinki-NLP/opus-mt-en-alv', modelVersion: 'r1' },
      'yo->en': { provider: 'opus-mt', model: 'Helsinki-NLP/opus-mt-yo-en', modelVersion: 'r2' },
    },
    m2m100: { '*': { provider: 'm2m100', model: 'facebook/m2m100_418M', modelVersion: 'r3' } },
  };

  it('PIN: joins 136 items to the answer key: 68 OPUS-MT and 68 M2M100, engine per item', () => {
    // The blind head-to-head. A set that lost the answer key would score two
    // engines as one; a set that read the engine off the review file would
    // have shown it to the reviewer.
    const result = packetToQaSetDefinition({
      language: 'yo',
      version: 'review-packets/2026-08-31',
      sourceReference: 'docs/certification/review-packets/review-yo.csv',
      reviewCsv: readFileSync(join(packets, 'review-yo.csv'), 'utf8'),
      answerKeyCsv: readFileSync(join(packets, 'ANSWER-KEY-yo.csv'), 'utf8'),
      engines,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.definition.items).toHaveLength(136);
    expect(result.definition.items.filter((i) => i.provider === 'opus-mt')).toHaveLength(68);
    expect(result.definition.items.filter((i) => i.provider === 'm2m100')).toHaveLength(68);
    /* Item 1 is m2m100 yo->en and item 2 is opus yo->en, per the key. */
    expect(result.definition.items[0]).toMatchObject({ ordinal: 1, direction: 'yo->en', provider: 'm2m100' });
    expect(result.definition.items[1]).toMatchObject({
      ordinal: 2,
      direction: 'yo->en',
      provider: 'opus-mt',
      model: 'Helsinki-NLP/opus-mt-yo-en',
    });
    expect(result.definition.engines).toHaveLength(3);
    expect(readQaSetDefinition(result.definition, digest).ok).toBe(true);
  });

  it('PIN: an engine tag with no mapping for a direction is refused, never guessed', () => {
    const result = packetToQaSetDefinition({
      language: 'yo',
      version: 'v',
      sourceReference: 'r',
      reviewCsv: readFileSync(join(packets, 'review-yo.csv'), 'utf8'),
      answerKeyCsv: readFileSync(join(packets, 'ANSWER-KEY-yo.csv'), 'utf8'),
      engines: { opus: engines.opus },
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems.some((p) => p.includes('"m2m100"'))).toBe(true);
  });

  it('the Hausa and Igbo packets read the same way', () => {
    for (const language of ['ha', 'ig']) {
      const result = packetToQaSetDefinition({
        language,
        version: 'v',
        sourceReference: 'r',
        reviewCsv: readFileSync(join(packets, `review-${language}.csv`), 'utf8'),
        answerKeyCsv: readFileSync(join(packets, `ANSWER-KEY-${language}.csv`), 'utf8'),
        engines: {
          opus: { '*': { provider: 'opus-mt', model: `opus-${language}`, modelVersion: 'r' } },
          m2m100: { '*': { provider: 'm2m100', model: 'facebook/m2m100_418M', modelVersion: 'r' } },
        },
      });
      expect(result.ok, language).toBe(true);
      expect(result.ok && result.definition.items.length, language).toBe(136);
    }
  });
});

describe('the command line', () => {
  it('parses --engine TAG@DIRECTION=PROVIDER/MODEL@VERSION with slashes in the model id', () => {
    expect(parseEngineFlag('opus@en->fr=opus-mt/Helsinki-NLP/opus-mt-en-fr@dd7f6540')).toEqual({
      tag: 'opus',
      direction: 'en->fr',
      provider: 'opus-mt',
      model: 'Helsinki-NLP/opus-mt-en-fr',
      modelVersion: 'dd7f6540',
    });
    expect(() => parseEngineFlag('opus=x')).toThrow(/direction/u);
    expect(() => parseEngineFlag('opus@*=nomodel')).toThrow(/PROVIDER\/MODEL@VERSION/u);
  });

  it('prints the body the admin endpoint takes, from the real French packet', () => {
    const out = main([
      '--language', 'fr',
      '--review', join(packets, 'review-fr.csv'),
      '--version', 'review-packets/2026-09-25',
      '--single-engine', 'opus',
      '--engine', 'opus@en->fr=opus-mt/Helsinki-NLP/opus-mt-en-fr@dd7f6540',
      '--engine', 'opus@fr->en=opus-mt/Helsinki-NLP/opus-mt-fr-en@c4aed37b',
    ]);
    const body = JSON.parse(out);
    expect(body.items).toHaveLength(40);
    expect(readQaSetDefinition(body, digest).ok).toBe(true);
  });
});
