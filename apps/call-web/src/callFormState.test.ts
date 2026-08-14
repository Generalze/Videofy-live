import { describe, expect, it } from 'vitest';
import {
  createInitialCallJoinForm,
  generateCallCode,
  isCallJoinFormValid,
  normalizeCallCode,
  validateCallJoinForm,
  withHearLanguage,
  withSpeakLanguage,
} from './callFormState';

describe('createInitialCallJoinForm', () => {
  it('defaults the hear language to the speak language', () => {
    const form = createInitialCallJoinForm();

    expect(form.speakLanguage).toBe('en');
    expect(form.hearLanguage).toBe(form.speakLanguage);
    expect(form.hearChosenExplicitly).toBe(false);
  });

  it('starts with captions on, a standard voice and translated audio', () => {
    const form = createInitialCallJoinForm();

    expect(form.captionsEnabled).toBe(true);
    expect(form.voiceGender).toBe('female');
    expect(form.audioMode).toBe('translated');
    expect(form.displayName).toBe('');
    expect(form.callCode).toBe('');
  });
});

describe('language coupling', () => {
  it('keeps the hear language following the speak language until chosen', () => {
    const form = withSpeakLanguage(createInitialCallJoinForm(), 'es');

    expect(form.speakLanguage).toBe('es');
    expect(form.hearLanguage).toBe('es');
  });

  it('stops following the speak language once hear is chosen explicitly', () => {
    let form = withHearLanguage(createInitialCallJoinForm(), 'es');
    form = withSpeakLanguage(form, 'es');
    form = withSpeakLanguage(form, 'en');

    expect(form.speakLanguage).toBe('en');
    expect(form.hearLanguage).toBe('es');
  });

  it('treats re-selecting the same hear language as an explicit choice', () => {
    let form = withHearLanguage(createInitialCallJoinForm(), 'en');
    form = withSpeakLanguage(form, 'es');

    expect(form.hearLanguage).toBe('en');
  });
});

describe('generateCallCode', () => {
  it('produces a readable word-word-number code', () => {
    expect(generateCallCode(() => 0)).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
    expect(generateCallCode(() => 0.999)).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
  });

  it('is deterministic for a fixed random source', () => {
    const first = generateCallCode(() => 0.5);
    const second = generateCallCode(() => 0.5);

    expect(first).toBe(second);
  });

  it('always passes its own validation', () => {
    const form = {
      ...createInitialCallJoinForm(),
      displayName: 'Zoe',
      callCode: generateCallCode(),
    };

    expect(validateCallJoinForm(form).callCode).toBeNull();
  });
});

describe('normalizeCallCode', () => {
  it('lowercases, trims and dashes whitespace', () => {
    expect(normalizeCallCode('  Blue Sky 42 ')).toBe('blue-sky-42');
  });

  it('strips characters outside letters, numbers and dashes', () => {
    expect(normalizeCallCode('calm_river!!42')).toBe('calm-river42');
  });

  it('collapses runs of dashes and trims leading or trailing dashes', () => {
    expect(normalizeCallCode('--calm---river--')).toBe('calm-river');
  });
});

describe('validateCallJoinForm', () => {
  const validForm = () => ({
    ...createInitialCallJoinForm(),
    displayName: 'Zoe',
    callCode: 'calm-river-42',
  });

  it('accepts a complete form', () => {
    const errors = validateCallJoinForm(validForm());

    expect(errors).toEqual({ displayName: null, callCode: null });
    expect(isCallJoinFormValid(errors)).toBe(true);
  });

  it('requires a display name', () => {
    const errors = validateCallJoinForm({ ...validForm(), displayName: '   ' });

    expect(errors.displayName).not.toBeNull();
    expect(isCallJoinFormValid(errors)).toBe(false);
  });

  it('limits display names to 40 characters', () => {
    const errors = validateCallJoinForm({ ...validForm(), displayName: 'z'.repeat(41) });

    expect(errors.displayName).not.toBeNull();
  });

  it('requires a call code of at least 4 normalized characters', () => {
    expect(validateCallJoinForm({ ...validForm(), callCode: '' }).callCode).not.toBeNull();
    expect(validateCallJoinForm({ ...validForm(), callCode: ' a!b ' }).callCode).not.toBeNull();
    expect(validateCallJoinForm({ ...validForm(), callCode: 'ab12' }).callCode).toBeNull();
  });
});
