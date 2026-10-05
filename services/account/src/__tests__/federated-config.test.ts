/**
 * Choosing the sign-in providers at startup.
 *
 * The thing being protected here is the state of the deployment, not the
 * behaviour of a request: every assertion is about what happens at boot,
 * because that is the only moment a misconfiguration is cheap to notice. A
 * provider that is on with a value missing must stop the service, not wait
 * for the first person to press the button and be told, wrongly, that their
 * account was rejected.
 */
import { describe, expect, it } from 'vitest';
import {
  createFederatedProviders,
  FederatedConfigurationError,
  type FederatedSignInEnv,
} from '../federated-config.js';

const GOOGLE_WEB = '692573915541-13t0122j4bd8vkgkainvh91cjt9vfdil.apps.googleusercontent.com';
const GOOGLE_ANDROID = '692573915541-sbq8ila7tjkptd9ueqfdan9n6gm5tb81.apps.googleusercontent.com';
const KC_WEB = '11c1340f-cbfa-4de3-b12d-dbe24f77b0d8';

const GOOGLE_ON: FederatedSignInEnv = {
  C7_GOOGLE_SIGN_IN: 'on',
  C7_GOOGLE_WEB_CLIENT_ID: GOOGLE_WEB,
  C7_GOOGLE_ANDROID_CLIENT_ID: GOOGLE_ANDROID,
};

const KINGSCHAT_ON: FederatedSignInEnv = {
  C7_KINGSCHAT_SIGN_IN: 'on',
  C7_KINGSCHAT_API_KEY: 'project-key',
  C7_KINGSCHAT_WEB_CLIENT_ID: KC_WEB,
};

describe('federated provider selection', () => {
  it('is off when nothing is configured, and says so out loud', () => {
    const lines: string[] = [];
    const providers = createFederatedProviders({}, { onSelected: (s) => lines.push(s) });

    expect(providers.google).toBeNull();
    expect(providers.kingschat).toBeNull();
    // An off provider that logs nothing is indistinguishable from one that is
    // on and broken. "Off" has to be a sentence somebody can read in the log.
    expect(lines.join(' ')).toContain('google=off');
    expect(lines.join(' ')).toContain('kingschat=off');
  });

  it('treats an unset switch as off rather than as something to guess at', () => {
    // Differs from the verification providers on purpose: there is no
    // synthetic sign-in, and an accidental `off` costs a button, not an
    // account wrongly marked verified.
    expect(createFederatedProviders({ C7_GOOGLE_SIGN_IN: '' }).google).toBeNull();
    expect(createFederatedProviders({ C7_GOOGLE_SIGN_IN: '  OFF  ' }).google).toBeNull();
  });

  it('refuses a switch value that is neither on nor off', () => {
    // `true` resolving to on would honour a value we never agreed to; to off
    // would be a provider silently absent. Neither.
    for (const value of ['true', '1', 'yes', 'enabled', 'synthetic']) {
      expect(() => createFederatedProviders({ C7_GOOGLE_SIGN_IN: value })).toThrow(
        FederatedConfigurationError,
      );
    }
  });

  it('builds Google from every client id it holds', () => {
    const lines: string[] = [];
    const providers = createFederatedProviders(GOOGLE_ON, { onSelected: (s) => lines.push(s) });
    expect(providers.google).not.toBeNull();
    // Each platform's token names its own client id, and one account service
    // answers all of them.
    expect(lines.join(' ')).toContain('google=on (2 client ids)');
  });

  it('refuses to turn Google on without a web client id', () => {
    expect(() => createFederatedProviders({ C7_GOOGLE_SIGN_IN: 'on' })).toThrow(
      /C7_GOOGLE_WEB_CLIENT_ID/,
    );
    expect(() =>
      createFederatedProviders({ C7_GOOGLE_SIGN_IN: 'on', C7_GOOGLE_WEB_CLIENT_ID: '   ' }),
    ).toThrow(/C7_GOOGLE_WEB_CLIENT_ID/);
  });

  it('allows Google with no mobile apps yet', () => {
    const providers = createFederatedProviders({
      C7_GOOGLE_SIGN_IN: 'on',
      C7_GOOGLE_WEB_CLIENT_ID: GOOGLE_WEB,
    });
    expect(providers.google).not.toBeNull();
  });

  it('builds one KingsChat client per application, keyed by platform', () => {
    const providers = createFederatedProviders({
      ...KINGSCHAT_ON,
      C7_KINGSCHAT_ANDROID_CLIENT_ID: 'df610edb-80bb-4839-b9ba-09abc908f4a3',
    });
    expect(providers.kingschat).not.toBeNull();
    // A KingsChat client id identifies an APPLICATION: redeeming a web code
    // with the Android id is refused by their token endpoint.
    expect([...(providers.kingschat?.keys() ?? [])]).toEqual(['web', 'android']);
  });

  it('refuses to turn KingsChat on without the api key or the web client id', () => {
    expect(() =>
      createFederatedProviders({ C7_KINGSCHAT_SIGN_IN: 'on', C7_KINGSCHAT_WEB_CLIENT_ID: KC_WEB }),
    ).toThrow(/C7_KINGSCHAT_API_KEY/);

    expect(() =>
      createFederatedProviders({ C7_KINGSCHAT_SIGN_IN: 'on', C7_KINGSCHAT_API_KEY: 'k' }),
    ).toThrow(/C7_KINGSCHAT_WEB_CLIENT_ID/);
  });

  it('lets one provider be on while the other is off', () => {
    const onlyGoogle = createFederatedProviders(GOOGLE_ON);
    expect(onlyGoogle.google).not.toBeNull();
    expect(onlyGoogle.kingschat).toBeNull();

    const onlyKingsChat = createFederatedProviders(KINGSCHAT_ON);
    expect(onlyKingsChat.google).toBeNull();
    expect(onlyKingsChat.kingschat).not.toBeNull();
  });

  it('never reports a provider as on when building it failed', () => {
    // The summary line is written after both are built, so a throw means no
    // line at all rather than a log claiming a provider that does not exist.
    const lines: string[] = [];
    expect(() =>
      createFederatedProviders({ C7_KINGSCHAT_SIGN_IN: 'on' }, { onSelected: (s) => lines.push(s) }),
    ).toThrow(FederatedConfigurationError);
    expect(lines).toHaveLength(0);
  });
});
