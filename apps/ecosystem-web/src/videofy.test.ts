/**
 * Videofy family truth, and the three-layer routing.
 *
 * The risk this suite exists for: four unshipped products presented beautifully
 * alongside one shipped product. Good art direction makes everything look
 * available, and "Coming soon" in small grey text is not a defence — so
 * availability is a typed field with exactly one holder, checked here.
 */
import { describe, expect, it } from 'vitest';
import {
  COMMUNICATION_SURFACES,
  LISTENING_MODES,
  LIVE_EXPERIENCES,
  UPLOADED_PROGRAMME_FLOW,
  VIDEOFY_FAMILY,
  VIDEOFY_STATUS_LABEL,
} from './videofy';
import { ROUTE_PATHS, routeFromPath } from './router';

describe('Videofy family', () => {
  it('PIN: exactly one product is available, and it is VIDEOFY-LIVE', () => {
    const available = VIDEOFY_FAMILY.filter((product) => product.status === 'available');
    expect(available).toHaveLength(1);
    expect(available[0]?.name).toBe('VIDEOFY-LIVE');
  });

  it('PIN: Studio, Watch, Promote and Vid AI are never presented as shipped', () => {
    for (const id of ['studio', 'watch', 'promote', 'vid-ai']) {
      const product = VIDEOFY_FAMILY.find((candidate) => candidate.id === id);
      expect(product, id).toBeDefined();
      expect(product?.status, id).not.toBe('available');
      // No destination either. A link to "explore" something unbuilt is an
      // implicit claim that there is something there to explore.
      expect(product?.explorePath, id).toBeNull();
    }
  });

  it('only the shipped product has somewhere to go', () => {
    const withPaths = VIDEOFY_FAMILY.filter((product) => product.explorePath !== null);
    expect(withPaths).toHaveLength(1);
    expect(withPaths[0]?.explorePath).toBe('/videofy/live/');
  });

  it('every status has a label, and none of them reads as available', () => {
    expect(VIDEOFY_STATUS_LABEL.available).toBe('Available now');
    expect(VIDEOFY_STATUS_LABEL['coming-soon']).toBe('Coming soon');
    expect(VIDEOFY_STATUS_LABEL['in-development']).toBe('In development');
  });

  it('PIN: the brand is spelled with the letter O throughout the family', () => {
    expect(JSON.stringify(VIDEOFY_FAMILY)).not.toContain('VIDE0FY');
    expect(JSON.stringify(VIDEOFY_FAMILY)).toContain('VIDEOFY-LIVE');
  });
});

describe('Videofy-Live product truth', () => {
  it('PIN: call copy does not claim instant, simultaneous replacement', () => {
    const call = LIVE_EXPERIENCES.find((experience) => experience.id === 'call');
    expect(call?.body.toLowerCase()).toContain('progressively');
    // The overstatement this replaced. Translated speech begins before a
    // sentence ends; it does not arrive while the speaker is still saying it,
    // and promising that sets up the product to be judged as broken on first
    // use.
    for (const claim of [
      'while they are still talking',
      'instantly',
      'simultaneous',
      'zero delay',
      'no delay',
      'real time replacement',
    ]) {
      expect(call?.body.toLowerCase(), claim).not.toContain(claim);
    }
  });

  it('covers all three live experiences', () => {
    expect(LIVE_EXPERIENCES.map((experience) => experience.id)).toEqual([
      'call',
      'conference',
      'programme',
    ]);
  });

  it('uses the real listening-mode vocabulary', () => {
    expect(LISTENING_MODES.map((mode) => mode.name)).toEqual([
      'Original',
      'Interpretation',
      'Replacement',
    ]);
  });

  it('treats an uploaded programme as a source, not a separate product', () => {
    expect(UPLOADED_PROGRAMME_FLOW.length).toBeGreaterThanOrEqual(4);
    expect(UPLOADED_PROGRAMME_FLOW.join(' ').toLowerCase()).toContain('uploaded');
  });

  it('PIN: carrier, OEM and mobile reach are never classified as working', () => {
    const working = COMMUNICATION_SURFACES.filter((surface) => surface.reach === 'working')
      .map((surface) => surface.label.toLowerCase())
      .join(' ');

    for (const term of ['gsm', 'pstn', 'carrier', 'oem', 'phone platform', 'mobile']) {
      expect(working, `"${term}" must not be a working surface`).not.toContain(term);
    }
    // And the things that DO work are still claimed, so the split is honest in
    // both directions rather than merely cautious.
    expect(working).toContain('browser');
    expect(working).toContain('sip / rtp media');
    expect(working).toContain('uploaded programmes');
  });

  it('PIN: the mobile app is in development, and carrier reach is expansion', () => {
    const byLabel = new Map(
      COMMUNICATION_SURFACES.map((surface) => [surface.label, surface.reach]),
    );
    expect(byLabel.get('Native mobile app')).toBe('in-development');
    expect(byLabel.get('GSM / PSTN carriers')).toBe('network-expansion');
    expect(byLabel.get('OEM / phone platforms')).toBe('network-expansion');
  });
});

describe('three-layer routing', () => {
  it('maps each layer to its own path', () => {
    expect(ROUTE_PATHS.c7).toBe('/');
    expect(ROUTE_PATHS.videofy).toBe('/videofy/');
    expect(ROUTE_PATHS['videofy-live']).toBe('/videofy/live/');
  });

  it('resolves paths with or without a trailing slash', () => {
    expect(routeFromPath('/')).toBe('c7');
    expect(routeFromPath('/videofy')).toBe('videofy');
    expect(routeFromPath('/videofy/')).toBe('videofy');
    expect(routeFromPath('/videofy/live')).toBe('videofy-live');
    expect(routeFromPath('/videofy/live/')).toBe('videofy-live');
  });

  it('PIN: the deeper route wins over the shallower one', () => {
    // /videofy/live/ must never resolve to the family page. A prefix test in
    // the wrong order would do exactly that, and the symptom is a product page
    // nobody can reach while every link on the site looks correct.
    expect(routeFromPath('/videofy/live/')).not.toBe('videofy');
  });

  it('falls back to the C7 page for anything unrecognised', () => {
    expect(routeFromPath('/nonsense')).toBe('c7');
    expect(routeFromPath('/videofyx')).toBe('c7');
  });
});
