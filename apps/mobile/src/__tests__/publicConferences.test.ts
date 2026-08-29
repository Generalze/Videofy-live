/** @author masterzee001 */
import { describe, expect, it } from 'vitest';
import {
  agoWords,
  conferenceTitle,
  fetchPublicConferences,
  parsePublicConferences,
  peopleWords,
  startedWords,
} from '../conference/publicConferences';

describe('public conferences', () => {
  it('reads the gateway listing shape and drops malformed rows', () => {
    const rows = parsePublicConferences({
      calls: [
        { callId: 'calm-river-12', title: 'Town hall', participantCount: 3, createdAtMs: 1000 },
        { callId: 'amber-summit-40', title: null, participantCount: 1, createdAtMs: 2000 },
        { callId: '', title: null, participantCount: 1, createdAtMs: 3 },
        { callId: 'x', participantCount: 'many' },
      ],
    });
    expect(rows.map((row) => row.callId)).toEqual(['calm-river-12', 'amber-summit-40']);
    expect(parsePublicConferences(null)).toEqual([]);
    expect(parsePublicConferences({ calls: 'nope' })).toEqual([]);
  });

  it('names an unnamed room honestly', () => {
    expect(conferenceTitle(null)).toBe('Untitled conference');
    expect(conferenceTitle('  ')).toBe('Untitled conference');
    expect(conferenceTitle(' Faith Live ')).toBe('Faith Live');
  });

  it('counts people and says how long ago in spoken units', () => {
    expect(peopleWords(1)).toBe('1 person');
    expect(peopleWords(4)).toBe('4 people');
    const now = 10_000_000;
    expect(agoWords(now - 20_000, now)).toBe('just now');
    expect(agoWords(now - 3 * 60_000, now)).toBe('3 min ago');
    expect(agoWords(now - 2 * 3_600_000, now)).toBe('2 h ago');
    expect(agoWords(now - 26 * 3_600_000, now)).toBe('1 day ago');
    expect(startedWords(now - 60_000, now)).toBe('started 1 min ago');
  });

  it('fetches /calls/public and treats a failure as an empty listing', async () => {
    const calls: string[] = [];
    const ok = await fetchPublicConferences('https://gw.example', (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ calls: [{ callId: 'a-b-1', title: null, participantCount: 2, createdAtMs: 1 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch);
    expect(calls).toEqual(['https://gw.example/calls/public']);
    expect(ok).toHaveLength(1);
    const down = await fetchPublicConferences('https://gw.example', (async () => {
      throw new Error('offline');
    }) as typeof fetch);
    expect(down).toEqual([]);
    const refused = await fetchPublicConferences('https://gw.example', (async () => new Response('{}', { status: 503 })) as typeof fetch);
    expect(refused).toEqual([]);
  });
});
