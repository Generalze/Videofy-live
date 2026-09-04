/** @author masterzee001 */
/**
 * The seam between the account service and the translation engine.
 *
 * These pin the ONE thing this client is for: deciding whether what came back
 * is a translation, or words in the sender's own language wearing a
 * translation's label. Everything it cannot verify resolves to null, and null
 * means the messaging path delivers the original and says translation was
 * unavailable.
 */
import { describe, expect, it } from 'vitest';
import { createTextTranslator } from '../translation-client.js';

const route = { provider: 'opus-mt', modelId: 'Helsinki-NLP/opus-mt-en-es' };

function translatorReturning(body: unknown, status = 200) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const request = init as { body: string };
    calls.push({ url: String(url), body: JSON.parse(request.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  }) as unknown as typeof fetch;
  const translator = createTextTranslator({
    mediaIngestUrl: 'http://ingest.test',
    internalToken: 'internal-token',
    fetchImpl,
  });
  return { translator, calls };
}

const input = {
  sourceLanguage: 'en',
  targetLanguage: 'es',
  sourceText: 'Good morning. I will call you later.',
  route,
};

describe('a partly translated message is not a translation', () => {
  it('accepts a message whose every sentence translated', async () => {
    const { translator } = translatorReturning({
      translatedText: 'Buenos dias. Te llamare mas tarde.',
      providerName: 'opus-mt',
      sentenceCount: 2,
      translatedSentenceCount: 2,
    });
    await expect(translator.translate(input)).resolves.toBe('Buenos dias. Te llamare mas tarde.');
  });

  it('REFUSES a message where one sentence failed and came back in the source language', async () => {
    // media-ingest keeps the original sentence so no words are lost. That is
    // right for the text and wrong for the label -- the reader would be shown a
    // mixture and told it was a translation. The counts are the only signal
    // that exists; without them this response is indistinguishable from a
    // complete translation.
    const { translator } = translatorReturning({
      translatedText: 'Buenos dias. I will call you later.',
      providerName: 'opus-mt',
      sentenceCount: 2,
      translatedSentenceCount: 1,
    });
    await expect(translator.translate(input)).resolves.toBeNull();
  });

  it('REFUSES a message where nothing translated at all', async () => {
    const { translator } = translatorReturning({
      translatedText: 'Good morning. I will call you later.',
      providerName: null,
      sentenceCount: 2,
      translatedSentenceCount: 0,
    });
    await expect(translator.translate(input)).resolves.toBeNull();
  });

  it('accepts a response from an engine too old to send counts', async () => {
    // Absent is not a claim of completeness, but refusing every translation
    // from a build that has not been updated yet would be worse than the
    // defect this guard closes. The whole-message echo guard stands behind it.
    const { translator } = translatorReturning({
      translatedText: 'Buenos dias. Te llamare mas tarde.',
      providerName: 'opus-mt',
    });
    await expect(translator.translate(input)).resolves.toBe('Buenos dias. Te llamare mas tarde.');
  });
});

describe('everything unverifiable resolves to null', () => {
  it('a non-2xx answer is not a translation', async () => {
    const { translator } = translatorReturning({ translatedText: 'Buenos dias.' }, 502);
    await expect(translator.translate(input)).resolves.toBeNull();
  });

  it('an empty translation is not a translation', async () => {
    const { translator } = translatorReturning({ translatedText: '' });
    await expect(translator.translate(input)).resolves.toBeNull();
  });

  it('a missing engine URL never reaches the network', async () => {
    const translator = createTextTranslator({
      mediaIngestUrl: undefined,
      internalToken: 'internal-token',
      fetchImpl: (() => {
        throw new Error('must not be called');
      }) as unknown as typeof fetch,
    });
    await expect(translator.translate(input)).resolves.toBeNull();
  });

  it('carries the APPROVED route with the request, so the far end can be held to it', async () => {
    const { translator, calls } = translatorReturning({
      translatedText: 'Buenos dias.',
      sentenceCount: 1,
      translatedSentenceCount: 1,
    });
    await translator.translate(input);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({
      provider: 'opus-mt',
      modelId: 'Helsinki-NLP/opus-mt-en-es',
    });
  });
});
