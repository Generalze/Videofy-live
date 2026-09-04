/** @author masterzee001 */
/**
 * A PROVIDER SELECTOR THAT IS PRESENT AND BLANK.
 *
 * Production media-ingest restarted 7418 times against this. Its env file
 * carried `TRANSCRIPTION_PROVIDER=` and `STREAMING_TRANSCRIPTION_PROVIDER=`
 * with nothing after the `=`, contradicting the template shipped beside it
 * (which sets `deepgram-nova`). `process.env['X'] ?? 'default'` treats absent
 * as unset and present-but-empty as the empty string, so the default never
 * applied and the service died on `received ""` -- a message that names the
 * value and not the cause.
 *
 * What these pin is the DISTINCTION, in both directions:
 *   absent            -> the documented default applies
 *   present and blank -> refused, by a message that says the name is empty
 *
 * Blank stays a refusal on purpose. Reading it as "the default" is how an
 * unapproved provider reaches production without appearing in any diff.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, selectorOrDefault } from '../config.js';

const TOUCHED = [
  'AI_RUNTIME_PROFILE',
  'TRANSCRIPTION_PROVIDER',
  'STREAMING_TRANSCRIPTION_PROVIDER',
  'STREAMING_SYNTHESIS_PROVIDER',
  'TRANSLATION_PROVIDER',
  'C7_ENVIRONMENT',
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((name) => [name, process.env[name]]));
  for (const name of TOUCHED) delete process.env[name];
  process.env['AI_RUNTIME_PROFILE'] = 'development-demo';
});

afterEach(() => {
  for (const name of TOUCHED) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('absent and blank are different, and the difference is the whole point', () => {
  // Pinned against the helper rather than through loadConfig, deliberately.
  // loadConfig calls loadRootEnv, which fills any UNSET name from the
  // repository's own .env -- so "absent" would mean whatever a developer's
  // local file happens to say, and this test would pass or fail by working
  // directory. It did exactly that once before this comment existed.
  const CHOICES = ['off', 'mock', 'faster-whisper'] as const;

  it('an absent name takes the documented default', () => {
    delete process.env['VIDEOFY_TEST_SELECTOR'];
    expect(selectorOrDefault('VIDEOFY_TEST_SELECTOR', 'off', CHOICES)).toBe('off');
  });

  it('a name that is present and blank is refused instead', () => {
    process.env['VIDEOFY_TEST_SELECTOR'] = '';
    try {
      expect(() => selectorOrDefault('VIDEOFY_TEST_SELECTOR', 'off', CHOICES)).toThrow(
        /VIDEOFY_TEST_SELECTOR is present but empty/,
      );
    } finally {
      delete process.env['VIDEOFY_TEST_SELECTOR'];
    }
  });

  it('a real value is returned trimmed', () => {
    process.env['VIDEOFY_TEST_SELECTOR'] = '  faster-whisper  ';
    try {
      expect(selectorOrDefault('VIDEOFY_TEST_SELECTOR', 'off', CHOICES)).toBe('faster-whisper');
    } finally {
      delete process.env['VIDEOFY_TEST_SELECTOR'];
    }
  });

  it('the refusal lists every permitted value, so the fix is in the message', () => {
    process.env['VIDEOFY_TEST_SELECTOR'] = '';
    try {
      expect(() => selectorOrDefault('VIDEOFY_TEST_SELECTOR', 'off', CHOICES)).toThrow(
        /"off", "mock", "faster-whisper"/,
      );
    } finally {
      delete process.env['VIDEOFY_TEST_SELECTOR'];
    }
  });
});

describe('a selector that is present and blank is refused, by name', () => {
  it('TRANSCRIPTION_PROVIDER= says it is empty, not that "" is an unknown provider', () => {
    process.env['TRANSCRIPTION_PROVIDER'] = '';
    expect(() => loadConfig()).toThrow(/TRANSCRIPTION_PROVIDER is present but empty/);
  });

  it('the refusal names what to write instead, including the default', () => {
    process.env['TRANSCRIPTION_PROVIDER'] = '';
    expect(() => loadConfig()).toThrow(/remove the line entirely to accept the default "mock"/);
  });

  it('whitespace is blank too -- it is harder to see in a file, not more of a choice', () => {
    process.env['TRANSCRIPTION_PROVIDER'] = '   ';
    expect(() => loadConfig()).toThrow(/present but empty/);
  });

  it('STREAMING_TRANSCRIPTION_PROVIDER= is refused the same way', () => {
    process.env['STREAMING_TRANSCRIPTION_PROVIDER'] = '';
    expect(() => loadConfig()).toThrow(/STREAMING_TRANSCRIPTION_PROVIDER is present but empty/);
  });

  it('STREAMING_SYNTHESIS_PROVIDER= is refused the same way', () => {
    process.env['STREAMING_SYNTHESIS_PROVIDER'] = '';
    expect(() => loadConfig()).toThrow(/STREAMING_SYNTHESIS_PROVIDER is present but empty/);
  });

  it('TRANSLATION_PROVIDER= is refused the same way', () => {
    process.env['TRANSLATION_PROVIDER'] = '';
    expect(() => loadConfig()).toThrow(/TRANSLATION_PROVIDER is present but empty/);
  });

  it('BLANK IS NEVER READ AS THE DEFAULT, even where the default would be safe', () => {
    // `off` is a perfectly safe value and the documented default. It is still
    // not what a blank line means: a selector nobody filled in is a deployment
    // that has not decided, and deciding on its behalf is how an unapproved
    // provider arrives without a diff.
    process.env['STREAMING_TRANSCRIPTION_PROVIDER'] = '';
    expect(() => loadConfig()).toThrow();
  });
});

describe('the production refusals still stand', () => {
  it('mock live transcription is refused in production', () => {
    process.env['C7_ENVIRONMENT'] = 'production';
    process.env['TRANSCRIPTION_PROVIDER'] = 'off';
    process.env['STREAMING_TRANSCRIPTION_PROVIDER'] = 'mock';
    expect(() => loadConfig()).toThrow(/fabricates/);
  });

  it('mock batch transcription is refused in production', () => {
    process.env['C7_ENVIRONMENT'] = 'production';
    process.env['TRANSCRIPTION_PROVIDER'] = 'mock';
    expect(() => loadConfig()).toThrow(/fabricates transcripts/);
  });
});
