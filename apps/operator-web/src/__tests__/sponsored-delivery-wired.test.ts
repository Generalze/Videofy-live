/** @author masterzee001 */
/**
 * THE DELIVERY JOIN IS WIRED IN BOTH VIEWER APPS.
 *
 * The end-to-end proof renders `SponsoredSlot` with a creative it fetched
 * itself, which proves the component and the endpoint agree -- and would pass
 * perfectly while listener-web's App still rendered `<SponsoredSlot />` with no
 * creative at all. That is the exact shape of this project's most expensive
 * recurring defect: both halves built, tested, and the join never made.
 *
 * So this asserts the COMPOSITION in each app, as text. Blunt, unmockable, and
 * it fails the moment either client stops passing the creative through.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (...parts: string[]): string => readFileSync(join(REPO, ...parts), 'utf8');

describe('listener-web actually delivers the creative to its slot', () => {
  const app = read('apps', 'listener-web', 'src', 'App.tsx');

  it('reads the delivery endpoint', () => {
    expect(app).toMatch(/import \{[\s\S]{0,120}fetchSponsoredCreative[\s\S]{0,120}\} from '\.\/sponsoredDelivery'/u);
    expect(app).toMatch(/fetchSponsoredCreative\(/u);
  });

  it('passes what it read into the slot, rather than rendering the default', () => {
    // `<SponsoredSlot />` with no prop silently falls back to the house
    // creative forever, which looks exactly like a working advert placement.
    expect(app).toMatch(/<SponsoredSlot creative=\{sponsored\.creative\}/u);
  });

  it('scopes the read to the channel being watched', () => {
    // A creative belongs to ONE programme; carrying the previous channel's
    // advert into the next would deliver an advert nobody bought.
    expect(app).toMatch(/fetchSponsoredCreative\(ACCOUNT_BASE, channelId/u);
  });
});

describe('the canonical placement: display, then advert, then controls', () => {
  const app = read('apps', 'listener-web', 'src', 'App.tsx');

  it('the slot sits BETWEEN the viewer display and the language controls', () => {
    /*
     * THE LOCKED ORDERING. Not merely "somewhere on the page": an advert below
     * the controls, or above the video, is a different product decision than
     * the one that was made. Positions are compared rather than matched
     * individually, because each element existing proves nothing about order.
     */
    const slot = app.indexOf('<SponsoredSlot creative={sponsored.creative}');
    const controls = app.indexOf('className={styles.controlsSection}');
    expect(slot).toBeGreaterThan(-1);
    expect(controls).toBeGreaterThan(-1);
    // The player section closes before the slot opens...
    const playerClose = app.lastIndexOf('</section>', slot);
    expect(playerClose).toBeGreaterThan(-1);
    expect(playerClose).toBeLessThan(slot);
    // ...and the slot comes before the controls.
    expect(slot).toBeLessThan(controls);
  });

  it('is rendered unconditionally, never suppressed by a host flag', () => {
    /*
     * A flag that hid this slot for an embedding app was tried and removed. It
     * put the advert below the whole embedded page on mobile -- under the
     * controls instead of under the display -- and it made the placement
     * conditional on a query parameter, which is one URL away from no advert.
     */
    expect(app).not.toMatch(/nativeAds/u);
    expect(app).not.toMatch(/&&\s*<SponsoredSlot/u);
  });
});

describe('mobile has exactly one sponsored placement, and it is the web one', () => {
  const viewer = read('apps', 'mobile', 'src', 'screens', 'ProgrammeViewerScreen.tsx');
  const directory = read('apps', 'mobile', 'src', 'screens', 'ProgrammesScreen.tsx');

  it('the programme screen embeds the player plainly and adds no advert', () => {
    // The WebView shows listener-web, which draws the canonical slot itself.
    expect(viewer).toMatch(/listenerUrlFor\(LISTEN_URL, channel\.channelId\)/u);
    expect(viewer).not.toMatch(/nativeAds/u);
    expect(viewer).not.toMatch(/<AdSlot/u);
    expect(viewer).not.toMatch(/fetchSponsoredCreative/u);
  });

  it('the directory screen carries no sponsored slot', () => {
    // Slice 1 has ONE placement: below the viewer display. A directory is not
    // a programme and had no creative that could correctly fill it.
    expect(directory).not.toMatch(/<AdSlot/u);
  });

  it('there is no second mobile delivery implementation', () => {
    // Two clients fetching one creative is two things to drift.
    expect(() => read('apps', 'mobile', 'src', 'sponsoredDelivery.ts')).toThrow();
  });

  it('the native primitive is kept but placed nowhere', () => {
    const native = read('apps', 'mobile', 'src', 'ui', 'AdSlot.tsx');
    expect(native).toMatch(/export function AdSlot/u);
    // Not rendered by any screen.
    for (const screen of [viewer, directory]) {
      expect(screen).not.toMatch(/AdSlot/u);
    }
  });
});

describe('neither client keeps its own creative contract any more', () => {
  it('listener-web has no private creative module left', () => {
    // It defined `SponsoredCreative` while mobile defined `AdCreative` with an
    // onPress CALLBACK -- two types for one thing, neither serialisable.
    expect(() => read('apps', 'listener-web', 'src', 'sponsoredCreative.ts')).toThrow();
  });

  it('both slots import the shared, serialisable contract', () => {
    const web = read('apps', 'listener-web', 'src', 'SponsoredSlot.tsx');
    const native = read('apps', 'mobile', 'src', 'ui', 'AdSlot.tsx');
    for (const source of [web, native]) {
      expect(source).toMatch(/from '@videofy-live\/shared-types'/u);
    }
    // No function may live in state that has to cross a wire.
    expect(native).not.toMatch(/onPress\?:\s*\(\)\s*=>/u);
  });

  it('the house creative has exactly one definition in the repository', () => {
    const shared = read('packages', 'shared-types', 'src', 'sponsored-creative.ts');
    expect(shared).toMatch(/export const HOUSE_CREATIVE/u);
    for (const source of [
      read('apps', 'listener-web', 'src', 'SponsoredSlot.tsx'),
      read('apps', 'mobile', 'src', 'ui', 'AdSlot.tsx'),
    ]) {
      // Imported, never re-declared: two copies means two different fallbacks
      // depending on which app you opened.
      expect(source).not.toMatch(/const (HOUSE|HOUSE_CREATIVE)\s*[:=]/u);
    }
  });
});
