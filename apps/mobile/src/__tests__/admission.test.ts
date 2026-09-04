/** @author masterzee001 */
import { describe, expect, it } from 'vitest';
import {
  admissionWords,
  knockWords,
  mergeKnock,
  parseAdmission,
  parseConferenceInfo,
  parseKnocking,
  withoutSeat,
} from '../conference/admission';

describe('restricted admission', () => {
  it('reads knocking seats off call:state, deduplicated, unnamed seats kept', () => {
    const seats = parseKnocking({
      knocking: [
        { participantId: 'p2', displayName: 'Ama' },
        { participantId: 'p2', displayName: 'Ama again' },
        { participantId: 'p3' },
        { displayName: 'no id' },
      ],
    });
    expect(seats).toEqual([
      { participantId: 'p2', displayName: 'Ama' },
      { participantId: 'p3', displayName: '' },
    ]);
    expect(parseKnocking({})).toEqual([]);
    expect(parseKnocking(null)).toEqual([]);
  });

  it('merges a call:knock without doubling a seat and removes an answered one', () => {
    const one = mergeKnock([], { callId: 'c', participantId: 'p2', displayName: 'Ama' });
    expect(mergeKnock(one, { participantId: 'p2', displayName: 'Ama' })).toHaveLength(1);
    expect(mergeKnock(one, 'garbage')).toEqual(one);
    expect(withoutSeat(one, 'p2')).toEqual([]);
  });

  it('reads call:admission in both shapes and refuses anything else', () => {
    expect(parseAdmission({ callId: 'c', admitted: true, snapshot: { title: 'T' } })).toEqual({ admitted: true, snapshot: { title: 'T' } });
    expect(parseAdmission({ callId: 'c', admitted: false, reason: 'timeout' })).toEqual({ admitted: false, reason: 'timeout' });
    expect(parseAdmission({ callId: 'c', admitted: false, reason: 'whatever' })).toEqual({ admitted: false, reason: 'refused' });
    expect(parseAdmission({ callId: 'c' })).toBeNull();
    expect(parseAdmission(undefined)).toBeNull();
  });

  it('reads title, privacy and languages defensively', () => {
    expect(parseConferenceInfo({ title: ' Town hall ', privacy: 'restricted', targetLanguages: ['en', 7, 'yo'] })).toEqual({
      title: 'Town hall',
      privacy: 'restricted',
      targetLanguages: ['en', 'yo'],
    });
    expect(parseConferenceInfo({ title: null, privacy: 'secret' })).toEqual({ title: null, privacy: null, targetLanguages: [] });
    expect(parseConferenceInfo(null).targetLanguages).toEqual([]);
  });

  it('says exactly what happened to a joiner', () => {
    expect(admissionWords('pending')).toBe('Waiting for the host to let you in');
    expect(admissionWords({ refused: 'refused' })).toBe('The host did not let you in');
    expect(admissionWords({ refused: 'timeout' })).toBe('Nobody answered');
    expect(admissionWords('admitted')).toBe('');
  });

  it('names the first knocker and counts the rest', () => {
    expect(knockWords([])).toBeNull();
    expect(knockWords([{ participantId: 'p2', displayName: 'Ama' }])).toEqual({ headline: 'Ama wants to join', others: null });
    expect(
      knockWords([
        { participantId: 'p2', displayName: '  ' },
        { participantId: 'p3', displayName: 'Kofi' },
        { participantId: 'p4', displayName: 'Zed' },
      ]),
    ).toEqual({ headline: 'Somebody wants to join', others: '2 more waiting' });
  });
});
