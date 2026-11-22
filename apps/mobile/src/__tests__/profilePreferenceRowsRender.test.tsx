/** @author masterzee001 */
/**
 * THE TWO NEW PROFILE SURFACES, RENDERED: the translated-voice row and the
 * ringing readiness row and banner. Every assertion is about what a person
 * would read, what they could press, and what pressing it sends.
 *
 * `expo-audio` and `expo-file-system` are native and are mocked at the
 * module boundary because profileRows.tsx imports them for the voice
 * enrolment row, which is not under test here. Nothing about the rows
 * under test is mocked.
 */
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { nodesWhere, render, textsOf, type TreeNode } from './stubs/render';
import type { RingingReadiness } from '../push/ringingReadiness';

vi.mock('expo-audio', () => ({
  AudioModule: {},
  RecordingPresets: { HIGH_QUALITY: {} },
  setAudioModeAsync: async () => {},
  useAudioRecorder: () => ({}),
}));
vi.mock('expo-file-system', () => ({ File: class {} }));

const { NotificationsRow, RingingRow, TranslatedVoiceRow } = await import('../screens/profileRows');
const { RingingBanner } = await import('../screens/RingingReadiness');

const labels = (tree: TreeNode): string[] =>
  nodesWhere(tree, (node) => typeof node.props['accessibilityLabel'] === 'string').map(
    (node) => node.props['accessibilityLabel'] as string,
  );

const press = async (tree: () => TreeNode, match: (node: TreeNode) => boolean): Promise<void> => {
  const control = nodesWhere(tree(), match)[0];
  if (control === undefined) throw new Error('no such control');
  const onPress = control.props['onPress'] as (() => void) | undefined;
  if (onPress === undefined) throw new Error('control cannot be pressed');
  await act(async () => {
    onPress();
  });
};

/** The chip whose label is this. Chips render as a Pressable around a View around the Text. */
const chip = (label: string) => (node: TreeNode): boolean =>
  node.type === 'Pressable' && textsOf(node).join('') === label;

describe('the translated voice row', () => {
  const api = (reply: { ok: true; value: 'male' | 'female' | null } | { ok: false; status: number; error: string }) => {
    const sent: string[] = [];
    return {
      sent,
      api: {
        setTranslatedVoice: async (voice: 'male' | 'female') => {
          sent.push(voice);
          return reply;
        },
      },
    };
  };

  it('names itself as a voice and shows which one is on file', () => {
    const { tree } = render(<TranslatedVoiceRow api={api({ ok: true, value: 'male' }).api} voice="male" onChanged={() => {}} open onToggle={() => {}} />);
    const texts = textsOf(tree);
    expect(texts).toContain('Translated voice');
    expect(texts).toContain('Your translated words are spoken in a male voice');
    expect(texts).toContain('Male voice');
    expect(texts).toContain('Female voice');
    // R3: a voice preference, never the person's gender.
    for (const text of texts) expect(text).not.toMatch(/gender/iu);
    const active = nodesWhere(tree, (node) => (node.props['accessibilityState'] as { selected?: boolean } | undefined)?.selected === true);
    expect(active.map((node) => textsOf(node).join(''))).toEqual(['Male voice']);
  });

  it('says which voice is used when none was chosen, and marks no chip', () => {
    const { tree } = render(<TranslatedVoiceRow api={api({ ok: true, value: null }).api} voice={null} onChanged={() => {}} open onToggle={() => {}} />);
    expect(textsOf(tree)).toContain('Not chosen yet · a female voice is used');
    const active = nodesWhere(tree, (node) => (node.props['accessibilityState'] as { selected?: boolean } | undefined)?.selected === true);
    expect(active).toHaveLength(0);
  });

  it('sends the tapped voice and reports what the server now holds', async () => {
    const changed: string[] = [];
    const fake = api({ ok: true, value: 'male' });
    const { renderer } = render(<TranslatedVoiceRow api={fake.api} voice="female" onChanged={(voice) => changed.push(voice)} open onToggle={() => {}} />);
    await press(() => renderer.toJSON() as unknown as TreeNode, chip('Male voice'));
    expect(fake.sent).toEqual(['male']);
    expect(changed).toEqual(['male']);
  });

  it('does not re-send the voice already on file', async () => {
    const fake = api({ ok: true, value: 'female' });
    const { renderer } = render(<TranslatedVoiceRow api={fake.api} voice="female" onChanged={() => {}} open onToggle={() => {}} />);
    await press(() => renderer.toJSON() as unknown as TreeNode, chip('Female voice'));
    expect(fake.sent).toEqual([]);
  });

  it('leaves the choice where it was and says so when the server refuses', async () => {
    const changed: string[] = [];
    const fake = api({ ok: false, status: 400, error: 'Choose the male or the female voice.' });
    const { renderer } = render(<TranslatedVoiceRow api={fake.api} voice="female" onChanged={(voice) => changed.push(voice)} open onToggle={() => {}} />);
    const tree = () => renderer.toJSON() as unknown as TreeNode;
    await press(tree, chip('Male voice'));
    expect(changed).toEqual([]);
    expect(textsOf(tree())).toContain('Choose the male or the female voice.');
  });

  it('treats a 200 that names no voice as not saved, rather than believing the tap', async () => {
    const changed: string[] = [];
    const fake = api({ ok: true, value: null });
    const { renderer } = render(<TranslatedVoiceRow api={fake.api} voice="female" onChanged={(voice) => changed.push(voice)} open onToggle={() => {}} />);
    const tree = () => renderer.toJSON() as unknown as TreeNode;
    await press(tree, chip('Male voice'));
    expect(changed).toEqual([]);
    expect(textsOf(tree())).toContain('That could not be saved.');
  });
});

const readiness = (over: Partial<RingingReadiness> = {}): RingingReadiness => ({
  exemption: 'not-granted',
  bucket: 'rare',
  vendor: null,
  ...over,
});

describe('the ringing banner', () => {
  it('states the measured headline, offers the request, and can be put off', async () => {
    let allowed = 0;
    let dismissed = 0;
    const { tree } = render(<RingingBanner readiness={readiness()} onAllow={() => (allowed += 1)} onOpenSettings={() => {}} onDismiss={() => (dismissed += 1)} />);
    const texts = textsOf(tree);
    expect(texts).toContain('Calls may not ring when the app has been closed for a while');
    expect(texts).toContain('Right now Android files this app as rare, where pushes are rationed.');
    expect(labels(tree)).toEqual(expect.arrayContaining(['Allow background use', 'Not now']));
    await press(() => tree, (node) => node.props['accessibilityLabel'] === 'Allow background use');
    await press(() => tree, (node) => node.props['accessibilityLabel'] === 'Not now');
    expect([allowed, dismissed]).toEqual([1, 1]);
  });

  it('names the vendor setting no app can reach, and opens the app settings for it', async () => {
    let opened = 0;
    const samsung = readiness({ vendor: { vendor: 'Samsung', where: 'Battery > Background usage limits' } });
    const { tree } = render(<RingingBanner readiness={samsung} onAllow={() => {}} onOpenSettings={() => (opened += 1)} onDismiss={() => {}} />);
    const texts = textsOf(tree).join(' ');
    expect(texts).toContain('Samsung phones have a second setting no app can reach');
    expect(texts).toContain('Only you can change it');
    expect(texts).toContain('Swiping the app away from recent apps');
    await press(() => tree, (node) => node.props['accessibilityLabel'] === 'Open app settings');
    expect(opened).toBe(1);
  });

  it('offers no vendor button where no second setting is known', () => {
    const { tree } = render(<RingingBanner readiness={readiness()} onAllow={() => {}} onOpenSettings={() => {}} onDismiss={() => {}} />);
    expect(labels(tree)).not.toContain('Open app settings');
  });

  it('KEEPS the vendor sentence once the exemption is granted, and drops only the request', () => {
    // Granting Android's exemption changes nothing about the Samsung
    // setting; the first version made the whole warning vanish at exactly
    // this moment.
    const granted = readiness({ exemption: 'granted', bucket: 'active', vendor: { vendor: 'Samsung', where: 'Battery > Background usage limits' } });
    const { tree } = render(<RingingBanner readiness={granted} onAllow={() => {}} onOpenSettings={() => {}} onDismiss={() => {}} />);
    expect(textsOf(tree).join(' ')).toContain('Samsung phones have a second setting no app can reach');
    expect(labels(tree)).toContain('Open app settings');
    expect(labels(tree)).not.toContain('Allow background use');
  });

  it('says a FAILED read failed and still offers the request, rather than a clean bill of health', async () => {
    let allowed = 0;
    const unreadable = readiness({ exemption: 'unreadable', bucket: null });
    const { tree } = render(<RingingBanner readiness={unreadable} onAllow={() => (allowed += 1)} onOpenSettings={() => {}} onDismiss={() => {}} />);
    const texts = textsOf(tree);
    expect(texts).toContain('The battery setting could not be read');
    expect(texts.join(' ')).not.toMatch(/no battery budget|nothing to allow/iu);
    await press(() => tree, (node) => node.props['accessibilityLabel'] === 'Allow background use');
    expect(allowed).toBe(1);
  });

  it('never promises that calls will now always ring', () => {
    const { tree } = render(<RingingBanner readiness={readiness()} onAllow={() => {}} onOpenSettings={() => {}} onDismiss={() => {}} />);
    for (const text of textsOf(tree)) expect(text).not.toMatch(/always ring|will ring|now ring/iu);
  });
});

describe('the ringing row on the profile', () => {
  it('shows the granted reading WITHOUT the request button, and still names the vendor setting', () => {
    const granted = readiness({ exemption: 'granted', bucket: 'active', vendor: { vendor: 'Xiaomi', where: 'Security > Autostart' } });
    const { tree } = render(<RingingRow readiness={granted} onAllow={() => {}} onOpenSettings={() => {}} open onToggle={() => {}} />);
    const texts = textsOf(tree);
    expect(texts).toContain('Ringing');
    expect(texts).toContain('Allowed to run in the background');
    expect(texts).toContain('Right now Android files this app as active.');
    expect(labels(tree)).not.toContain('Allow background use');
    expect(labels(tree)).toContain('Open app settings');
    expect(textsOf(tree).join(' ')).toContain('Xiaomi phones have a second setting no app can reach');
  });

  it('offers the request when Android was read as not exempt', () => {
    const { tree } = render(<RingingRow readiness={readiness()} onAllow={() => {}} onOpenSettings={() => {}} open onToggle={() => {}} />);
    expect(labels(tree)).toContain('Allow background use');
  });

  it('says the setting has not been read yet when there is no reading, and claims nothing', () => {
    const { tree } = render(<RingingRow readiness={null} onAllow={() => {}} onOpenSettings={() => {}} open onToggle={() => {}} />);
    const texts = textsOf(tree);
    expect(texts).toContain('Not read yet');
    expect(texts).toContain('The battery setting has not been read yet.');
    expect(labels(tree)).not.toContain('Allow background use');
  });

  it('says a build without the native layer cannot measure this, rather than showing granted', () => {
    const { tree } = render(<RingingRow readiness={readiness({ exemption: 'unknown', bucket: null })} onAllow={() => {}} onOpenSettings={() => {}} open onToggle={() => {}} />);
    expect(textsOf(tree)).toContain('This build cannot read the battery setting');
    expect(labels(tree)).not.toContain('Allow background use');
  });

  it('says a FAILED read failed, offers the request, and does not say the Android has no such setting', async () => {
    let allowed = 0;
    const { tree } = render(<RingingRow readiness={readiness({ exemption: 'unreadable', bucket: 'restricted' })} onAllow={() => (allowed += 1)} onOpenSettings={() => {}} open onToggle={() => {}} />);
    const texts = textsOf(tree);
    expect(texts).toContain('The battery setting could not be read');
    expect(texts).not.toContain('This Android version has no battery budget for apps');
    // The bucket was read by the same layer, so it is still shown.
    expect(texts.join(' ')).toContain('restricted');
    await press(() => tree, (node) => node.props['accessibilityLabel'] === 'Allow background use');
    expect(allowed).toBe(1);
  });

  it('is where both the request and the vendor sentence live at any time, banner or no banner', () => {
    // Not exempt, on a Tecno: both the button and the sentence, from the profile alone.
    const both = readiness({ exemption: 'not-granted', vendor: { vendor: 'Tecno', where: 'Phone Master > Auto-start management' } });
    const { tree } = render(<RingingRow readiness={both} onAllow={() => {}} onOpenSettings={() => {}} open onToggle={() => {}} />);
    expect(labels(tree)).toContain('Allow background use');
    expect(labels(tree)).toContain('Open app settings');
    expect(textsOf(tree).join(' ')).toContain('Tecno phones have a second setting no app can reach');
  });
});

/**
 * THE CLAIM TWO ROWS ABOVE THE FIX.
 *
 * While the Ringing row was being built to read Android's battery setting
 * rather than assume it, the Notifications row directly above it said "This
 * phone can ring for calls and messages" whenever the device registered, and
 * "Calls always ring" underneath. Neither sentence was read from anything.
 *
 * Registering proves the server can ADDRESS this phone. It says nothing about
 * whether Android will wake it, and on three real calls the push was accepted
 * by Google in under a second, the handset never woke, and every one rang out.
 * Nothing failed when those sentences were removed, because nothing tested
 * them -- which is why they lasted.
 */
describe('the notifications row does not promise a ringing phone', () => {
  const notifications = (): TreeNode =>
    render(
      <NotificationsRow
        api={{ updateProfile: async () => ({ ok: true, value: undefined }) } as never}
        notificationsEnabled
        deviceOutcome={{ ok: true, deviceId: 'dev_1' }}
        onRetryDevice={async () => {}}
        onChanged={() => {}}
        open
        onToggle={() => {}}
      />,
    ).tree;

  it('NEVER says calls always ring', () => {
    const said = textsOf(notifications()).join(' ');
    expect(said).not.toMatch(/always ring/iu);
    expect(said).not.toMatch(/can ring for calls/iu);
  });

  it('says only what registering established', () => {
    expect(textsOf(notifications()).join(' ')).toContain('registered to receive them');
  });

  it('sends the reader to the row that actually reads the setting', () => {
    expect(textsOf(notifications()).join(' ')).toMatch(/Ringing/u);
  });
});
