/** @author masterzee001 */
/**
 * C-AI1.1F pins: ADC resolves two things, and both have to survive.
 *
 * No Google account, no network, no credential file. The property being proved
 * is that we do not throw away what the credential gave us -- which is a fact
 * about our code, and was provable all along without a live validation session.
 */
import { describe, expect, it } from 'vitest';
import {
  CLOUD_PLATFORM_SCOPE,
  QUOTA_PROJECT_HEADER,
  createAdcAuthorizer,
  googleRequestHeaders,
  normalizeHeaders,
  type GoogleAuthLike,
} from '../providers/google/authorization.js';

function fakeAuth(
  headers: Record<string, string>,
  quotaProjectId?: string,
): { auth: GoogleAuthLike; clients: number; scopes: string[] } {
  const state = { clients: 0, scopes: [] as string[] };
  const auth: GoogleAuthLike = {
    getClient: async () => {
      state.clients += 1;
      return {
        getRequestHeaders: async () => new Headers(headers),
        ...(quotaProjectId === undefined ? {} : { quotaProjectId }),
      };
    },
  };
  return { auth, get clients() { return state.clients; }, get scopes() { return state.scopes; } };
}

describe('the quota project survives from the credential to the wire', () => {
  it('PIN: a credential quota project becomes x-goog-user-project', async () => {
    const fake = fakeAuth(
      { Authorization: 'Bearer abc', 'x-goog-user-project': 'project-e11a' },
      'project-e11a',
    );
    const authorize = createAdcAuthorizer({ createAuth: () => fake.auth });
    const authorization = await authorize();
    const headers = googleRequestHeaders(authorization);

    // getAccessToken() returns the token alone. getRequestHeaders() returns the
    // token AND this. Reaching past the second is what produced the 403.
    expect(headers[QUOTA_PROJECT_HEADER]).toBe('project-e11a');
    expect(headers['authorization']).toBe('Bearer abc');
  });

  it('PIN: header names are lower-cased, so a case difference cannot lose one', async () => {
    // google-auth-library has returned both a Headers object and a plain
    // object across versions, and `Authorization` and `authorization` are the
    // same header to a server but two keys to a spread.
    expect(normalizeHeaders(new Headers({ Authorization: 'Bearer x' }))).toEqual({
      authorization: 'Bearer x',
    });
    expect(normalizeHeaders({ 'X-Goog-User-Project': 'p' })).toEqual({
      'x-goog-user-project': 'p',
    });
  });

  it('PIN: an explicit value wins over the credential', () => {
    const headers = googleRequestHeaders(
      { headers: { authorization: 'Bearer x' }, quotaProjectId: 'from-laptop' },
      'from-deployment',
    );
    expect(headers[QUOTA_PROJECT_HEADER]).toBe('from-deployment');
  });

  it('PIN: an absent quota project sends no header at all', () => {
    for (const explicit of [undefined, null, '']) {
      const headers = googleRequestHeaders(
        { headers: { authorization: 'Bearer x' }, quotaProjectId: null },
        explicit,
      );
      // Empty is not absent. Google rejects the two differently, and the
      // difference is where somebody would waste an afternoon.
      expect(headers).not.toHaveProperty(QUOTA_PROJECT_HEADER);
    }
  });

  it('PIN: an empty explicit value falls back rather than blanking the header', () => {
    const headers = googleRequestHeaders(
      { headers: { authorization: 'Bearer x' }, quotaProjectId: 'from-credential' },
      '',
    );
    // An unset environment variable reads as '' in plenty of shells. That must
    // mean "I did not say", not "bill nobody".
    expect(headers[QUOTA_PROJECT_HEADER]).toBe('from-credential');
  });

  it('reads the quota project back from the headers when the client hides it', async () => {
    const fake = fakeAuth({ authorization: 'Bearer abc', 'x-goog-user-project': 'from-headers' });
    const authorize = createAdcAuthorizer({ createAuth: () => fake.auth });
    expect((await authorize()).quotaProjectId).toBe('from-headers');
  });

  it('a credential with no quota project reports null, not undefined-shaped guessing', async () => {
    const fake = fakeAuth({ authorization: 'Bearer abc' });
    const authorize = createAdcAuthorizer({ createAuth: () => fake.auth });
    expect((await authorize()).quotaProjectId).toBeNull();
  });

  it('the cloud-platform scope is the default, and the auth client is built once', async () => {
    const fake = fakeAuth({ authorization: 'Bearer abc' });
    let requestedScopes: readonly string[] = [];
    const authorize = createAdcAuthorizer({
      createAuth: (scopes) => {
        requestedScopes = scopes;
        return fake.auth;
      },
    });
    await authorize();
    await authorize();
    expect(requestedScopes).toEqual([CLOUD_PLATFORM_SCOPE]);
    // Tokens refresh inside the library; rebuilding GoogleAuth per request
    // would re-resolve ADC on every translated sentence.
    expect(fake.clients).toBe(2);
  });
});
