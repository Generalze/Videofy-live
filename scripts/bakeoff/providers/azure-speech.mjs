// Videofy Live — C-AI1.0 candidate: Azure Speech translation.
//
// HARNESS ONLY. Nothing here is reachable from the call runtime, and it must
// stay that way until this provider has bake-off evidence. The point of C-AI1.0
// is to measure before choosing, so wiring a vendor in early would destroy the
// only thing the milestone produces.
//
// Credentials come from the environment and are never written to the repo:
//   AZURE_SPEECH_KEY     — subscription key
//   AZURE_SPEECH_REGION  — e.g. westeurope
//
// TWO PASSES, REPORTED SEPARATELY (owner decision):
//   default — provider behaviour out of the box. This is the honest comparison
//             point against every other candidate.
//   hinted  — production-optimised with supported phrase hints. Useful, but it
//             is a different measurement and never replaces the raw score.
//
// Phrase hints deliberately exclude HELD_OUT_FROM_HINTS. A recogniser given a
// vocabulary list will recognise the words on it; scoring that as recognition
// quality measures the list. The held-out names are how we tell the difference
// between a provider that hears names and one that was handed the answers.
import { HELD_OUT_FROM_HINTS } from '../corpus.mjs';
import { NO_CAPABILITIES } from '../provider-contract.mjs';

/** Loaded lazily so the harness runs without the SDK installed for other providers. */
async function loadSdk() {
  try {
    return await import('microsoft-cognitiveservices-speech-sdk');
  } catch {
    throw new Error(
      'Azure adapter needs the Speech SDK. Install it as a dev dependency when you are ready to ' +
        'run this candidate:\n  npm install -D microsoft-cognitiveservices-speech-sdk\n' +
        'It is deliberately not a repo dependency: no vendor ships in package.json before the ' +
        'bake-off has chosen one.',
    );
  }
}

const AZURE_LOCALES = { en: 'en-US', es: 'es-ES', fr: 'fr-FR' };
const AZURE_VOICES = {
  en: 'en-US-JennyNeural',
  es: 'es-ES-ElviraNeural',
  fr: 'fr-FR-DeniseNeural',
};

/**
 * Phrase hints for the tuned pass: names the product legitimately knows about
 * ahead of a call — a participant roster, an organisation directory — minus
 * anything held out so the exam is not sat with the answer sheet.
 */
function phraseHintsFor(corpus) {
  const held = new Set(HELD_OUT_FROM_HINTS.map((n) => n.toLowerCase()));
  const hints = new Set();
  for (const utterance of corpus) {
    for (const token of utterance.protectedTokens ?? []) {
      if (/^\d+$/.test(token)) continue; // numbers are not vocabulary
      if (held.has(token.toLowerCase())) continue;
      hints.add(token);
    }
  }
  return [...hints];
}

/**
 * @param {object} options
 * @param {'default'|'hinted'} options.mode
 * @param {string} options.audioDir
 * @param {object[]} options.corpus  Used only to derive phrase hints in hinted mode.
 */
export function createAzureSpeechProvider({ mode = 'default', audioDir, corpus = [] }) {
  const key = process.env['AZURE_SPEECH_KEY'];
  const region = process.env['AZURE_SPEECH_REGION'];
  let sdk = null;
  let audioSeconds = 0;
  let translatedCharacters = 0;
  let synthesizedSeconds = 0;

  return {
    name: `azure-speech-${mode}`,
    capabilities: {
      ...NO_CAPABILITIES,
      streamingAudioInput: true,
      partialTranscript: true,
      streamingTranslation: true,
      streamingAudioOutput: true,
      automaticLanguageDetection: true,
      multipleTargetLanguages: true,
    },

    async setUp() {
      if (!key || !region) {
        throw new Error(
          'AZURE_SPEECH_KEY and AZURE_SPEECH_REGION must be set in the environment. ' +
            'Do not put them in .env.example or any committed file.',
        );
      }
      sdk = await loadSdk();
    },

    async run(utterance) {
      const config = sdk.SpeechTranslationConfig.fromSubscription(key, region);
      config.speechRecognitionLanguage = AZURE_LOCALES[utterance.sourceLanguage];
      config.addTargetLanguage(utterance.targetLanguage);
      config.voiceName = AZURE_VOICES[utterance.targetLanguage];

      const audio = sdk.AudioConfig.fromWavFileInput(
        await readWav(`${audioDir}/${utterance.id}.wav`),
      );
      const recognizer = new sdk.TranslationRecognizer(config, audio);

      if (mode === 'hinted') {
        const list = sdk.PhraseListGrammar.fromRecognizer(recognizer);
        for (const phrase of phraseHintsFor(corpus)) list.addPhrase(phrase);
      }

      const startedAt = Date.now();
      const timings = {};
      let segmentCount = 0;
      let transcript = '';
      let translation = '';

      recognizer.recognizing = (_sender, event) => {
        // The stage a batch pipeline structurally cannot report.
        timings.firstPartialTranscriptMs ??= Date.now() - startedAt;
        if (event.result?.translations?.get(utterance.targetLanguage)) {
          timings.firstTranslatedTextMs ??= Date.now() - startedAt;
        }
      };
      recognizer.synthesizing = (_sender, event) => {
        if ((event.result?.audio?.byteLength ?? 0) > 0) {
          timings.firstTranslatedAudioMs ??= Date.now() - startedAt;
          synthesizedSeconds += event.result.audio.byteLength / (16000 * 2);
        }
      };

      await new Promise((resolve, reject) => {
        recognizer.recognized = (_sender, event) => {
          const text = event.result?.text?.trim();
          if (!text) return;
          segmentCount += 1;
          timings.stableTranscriptMs ??= Date.now() - startedAt;
          transcript = transcript ? `${transcript} ${text}` : text;
          const translated = event.result.translations?.get(utterance.targetLanguage);
          if (translated) {
            timings.firstTranslatedTextMs ??= Date.now() - startedAt;
            translation = translation ? `${translation} ${translated}` : translated;
            translatedCharacters += translated.length;
          }
        };
        recognizer.sessionStopped = () => {
          recognizer.stopContinuousRecognitionAsync(() => resolve(), reject);
        };
        recognizer.canceled = (_sender, event) => {
          if (event.reason === sdk.CancellationReason.Error) {
            reject(new Error(`Azure cancelled: ${event.errorDetails}`));
            return;
          }
          recognizer.stopContinuousRecognitionAsync(() => resolve(), reject);
        };
        recognizer.startContinuousRecognitionAsync(() => undefined, reject);
      });

      timings.utteranceCompleteMs = Date.now() - startedAt;
      audioSeconds += await wavDurationSeconds(`${audioDir}/${utterance.id}.wav`);

      return {
        transcript,
        translation: translation || null,
        segmentCount: Math.max(1, segmentCount),
        timings,
      };
    },

    usage() {
      // Rates are LEFT AT ZERO on purpose. They belong to the account actually
      // being billed, and a guessed list price in the report would look like a
      // measurement. Supply them at run time to get a real cost verdict.
      return {
        speechInputMinutes: audioSeconds / 60,
        speechInputRate: Number(process.env['AZURE_SPEECH_RATE_PER_MINUTE'] ?? 0),
        translationUnits: translatedCharacters / 1_000_000,
        translationRate: Number(process.env['AZURE_TRANSLATION_RATE_PER_MILLION_CHARS'] ?? 0),
        synthesizedMinutes: synthesizedSeconds / 60,
        synthesizedRate: Number(process.env['AZURE_TTS_RATE_PER_MINUTE'] ?? 0),
        sessionCharge: 0,
        targetLanguages: 1,
        conversationMinutes: audioSeconds / 60,
        note:
          Number(process.env['AZURE_SPEECH_RATE_PER_MINUTE'] ?? 0) === 0
            ? 'rates not supplied — cost reads as unmeasured rather than as free'
            : undefined,
      };
    },
  };
}

async function readWav(path) {
  const { readFile } = await import('node:fs/promises');
  return readFile(path);
}

async function wavDurationSeconds(path) {
  const { stat } = await import('node:fs/promises');
  const { size } = await stat(path);
  // 16 kHz mono 16-bit, less the 44-byte header.
  return Math.max(0, (size - 44) / (16000 * 2));
}
