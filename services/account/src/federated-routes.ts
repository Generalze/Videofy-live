/** @author masterzee001 */
/**
 * The HTTP surface for signing in with Google or KingsChat.
 *
 * Thin, like `routes.ts`: it validates the transport and hands off. Every
 * rule worth disagreeing about lives behind it -- the token check in the
 * verifiers, the claim rule in `federated-identity.ts`, the account decision
 * in `federated-sign-in.ts`.
 *
 * NOTHING HERE LOGS a token, a code, an address or a handoff. A code in an
 * access log is redeemable for an hour; an address in one is a record of who
 * uses this product.
 *
 * THE TWO SHAPES, and why they are not the same shape.
 *
 *   Google is an ID TOKEN the client already holds. The browser or the app
 *   gets it from Google directly, posts it here, and this service verifies it
 *   against Google's published keys. One request, no redirect, no secret, and
 *   the same route serves web and mobile.
 *
 *   KingsChat is a REDIRECT. The person leaves for accounts.kingschat.online
 *   and comes back as a form POST carrying a code, which only this server can
 *   redeem. Three requests, because the person is not on our page for the
 *   middle one -- which is what the handoff exists to bridge.
 */
import type express from 'express';
import {
  issueSessionToken,
  sessionLifetimeSeconds,
  type SessionClass,
} from '@videofy-live/account-tokens';
import type { AccountStore } from './account-store.js';
import type { FederatedSignIn, FederatedSignInOutcome } from './federated-sign-in.js';
import type { ClientPlatform, FederatedProviders } from './federated-config.js';
import { OAuthStateStore, SignInHandoffStore, safeReturnPath } from './oauth-state.js';

/** Where the KingsChat login page lives. Not their API host. */
const KINGSCHAT_LOGIN_URL = 'https://accounts.kingschat.online/log-in';

export interface FederatedRouteDependencies {
  readonly store: AccountStore;
  readonly signIn: FederatedSignIn;
  readonly providers: FederatedProviders;
  /** Signs sessions. The same secret the password routes use. */
  readonly secret: Buffer;
  /**
   * Absolute scheme://host for this deployment, with no path.
   *
   * The callback redirect is built from THIS and never from a request header.
   * A redirect built from the Host header sends somebody who has just signed
   * in to whichever host an attacker put in it, with the handoff attached.
   */
  readonly publicOrigin: string;
  /**
   * The mobile application's url scheme, without `://`.
   *
   * A phone runs the same KingsChat web flow in a system browser, and this is
   * how the result gets back into the app. Fixed in configuration and never
   * read from a request: a caller that could name the scheme to return to
   * would be handing itself an open redirect with a completed login attached.
   */
  readonly appScheme?: string;
  readonly state?: OAuthStateStore;
  readonly handoffs?: SignInHandoffStore;
  readonly nowSeconds?: () => number;
  readonly warn?: (message: string) => void;
}

export function registerFederatedRoutes(
  app: express.Express,
  deps: FederatedRouteDependencies,
): void {
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const state = deps.state ?? new OAuthStateStore();
  const handoffs = deps.handoffs ?? new SignInHandoffStore();
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const origin = deps.publicOrigin.replace(/\/+$/, '');
  const appScheme = (deps.appScheme ?? 'videofy').replace(/:.*$/, '');

  /**
   * Where a finished KingsChat login sends the browser.
   *
   * ONE function for both surfaces and both outcomes, so the app path cannot
   * drift away from the web one -- which is how a second surface normally
   * ends up without the fragment, or without the error, or with the handoff
   * in a query string.
   */
  const landing = (
    attempt: { readonly surface: 'web' | 'app'; readonly returnPath: string } | null,
    result: { readonly handoff: string } | { readonly error: string },
  ): string => {
    const fragment = 'handoff' in result ? `#c7_handoff=${result.handoff}` : '';
    const query = 'error' in result ? `?error=${encodeURIComponent(result.error)}` : '';
    /*
     * The app gets a fixed path on its own scheme. An unknown attempt also
     * lands here on the web, because without the attempt there is nothing
     * that says a phone started it -- and defaulting to the app scheme on a
     * value we cannot verify would be exactly the trust this avoids.
     */
    if (attempt?.surface === 'app') return `${appScheme}://auth${query}${fragment}`;
    /*
     * THE SIGN-IN PANEL IS A SECTION OF THE HOME PAGE, NOT A PAGE.
     *
     * This read `/sign-in`, which is not a route this site has -- the app
     * serves `/`, `/videofy/`, `/videofy/live/`, `/app/`, and two specialist
     * paths. Every failed provider sign-in therefore landed on a 404 saying
     * "That page does not exist", which reads as the whole site being broken
     * rather than one login not completing.
     *
     * Both halves of this had been built and tested -- the callback sends a
     * reason, and JoinC7 reads `?error=` and renders the wording -- and they
     * were joined by a path that was never checked against the router. The
     * `#join` anchor is what puts the panel, and the message, on screen
     * instead of the top of the marketing page.
     */
    if ('error' in result) return `${origin}/${query}#join`;
    return `${origin}${attempt === null ? '/' : attempt.returnPath}${fragment}`;
  };

  const session = (accountId: string, version: number, sessionClass: SessionClass) => {
    const account = deps.store.get(accountId);
    return {
      accountId,
      token: issueSessionToken({
        secret: deps.secret,
        accountId,
        version,
        nowSeconds: nowSeconds(),
        sessionClass,
      }),
      expiresInSeconds: sessionLifetimeSeconds(sessionClass),
      ...(account?.voiceGender ? { voiceGender: account.voiceGender } : {}),
    };
  };

  const sessionClassOf = (body: unknown): SessionClass =>
    (body as { client?: unknown } | undefined)?.client === 'device' ? 'device' : 'browser';

  /**
   * Translate a sign-in outcome into a response.
   *
   * One place, so the web callback and the mobile post cannot drift into
   * telling people different things about the same refusal.
   */
  const refusalStatus = (reason: Extract<FederatedSignInOutcome, { kind: 'refused' }>['reason']) =>
    reason === 'account-not-created' ? 503 : 409;

  /**
   * WHICH PROVIDERS THIS DEPLOYMENT ACTUALLY HAS.
   *
   * The sign-in page asks rather than hard-coding its buttons. A button
   * rendered for a provider that is switched off is a button that answers
   * 503, and the person pressing it has no way to tell that from their own
   * account being rejected -- so they try again, and blame themselves.
   */
  app.get('/oauth/providers', (_req, res) => {
    res.status(200).json({
      google: deps.providers.google !== null,
      kingschat: deps.providers.kingschat !== null,
    });
  });

  /**
   * Google, for every surface.
   *
   * The client obtains the ID token from Google itself and posts it here. We
   * never see a Google access token, never ask for one, and hold no Google
   * credential -- the signature and the audience are the whole proof.
   */
  app.post('/oauth/google', (req, res) => {
    const verifier = deps.providers.google;
    if (verifier === null) {
      // Honestly unavailable, per the house rule: refuse the capability out
      // loud rather than pretend to provide it.
      res.status(503).json({ error: 'Signing in with Google is not available here.' });
      return;
    }

    const idToken = (req.body as { idToken?: unknown } | undefined)?.idToken;
    if (typeof idToken !== 'string' || idToken.length === 0) {
      res.status(400).json({ error: 'Sign in with Google again to continue.' });
      return;
    }

    void (async () => {
      const verified = await verifier.verify(idToken);
      if (!verified.ok) {
        if (verified.reason === 'keys-unavailable') {
          // Our outage, not their token. Telling somebody their sign-in was
          // rejected sends them to fix something that is not broken.
          warn('google sign-in: could not reach Google to verify the token');
          res.status(503).json({ error: 'We could not verify that just now. Please try again.' });
          return;
        }
        /*
         * Every other refusal gets ONE message. Saying which check failed
         * would tell somebody probing us whether an audience matched or a
         * signature did, which is a map of what to forge next.
         */
        res.status(401).json({ error: 'That Google sign-in could not be verified.' });
        return;
      }

      const outcome = await deps.signIn.signIn({
        provider: 'google',
        subject: verified.subject,
        email: verified.email,
        emailVerified: verified.emailVerified,
        displayName: verified.displayName,
      });

      if (outcome.kind === 'refused') {
        res.status(refusalStatus(outcome.reason)).json({ error: outcome.message });
        return;
      }
      res
        .status(outcome.created ? 201 : 200)
        .json(session(outcome.account.accountId, outcome.account.tokenVersion, sessionClassOf(req.body)));
    })().catch(() => {
      res.status(500).json({ error: 'You could not be signed in.' });
    });
  });

  /**
   * Begin a KingsChat login.
   *
   * Returns the url rather than redirecting, so the page keeps control of the
   * navigation and the caller cannot be bounced somewhere by a bare GET.
   */
  app.get('/oauth/kingschat/start', (req, res) => {
    const clients = deps.providers.kingschat;
    const client = clients?.get(platformOf(req.query.platform));
    if (!clients || !client) {
      res.status(503).json({ error: 'Signing in with KingsChat is not available here.' });
      return;
    }

    const returnPath = typeof req.query.returnPath === 'string' ? req.query.returnPath : undefined;
    /*
     * Validated here, on the way out, which is the only moment the value is
     * one we chose. On the way back it is a string the provider echoed.
     *
     * The surface is recorded now for the same reason. A phone says so when
     * it STARTS, and the callback reads it from here rather than from the
     * request it receives -- which is a request the provider makes.
     */
    const surface = req.query.client === 'device' ? 'app' : 'web';
    const token = state.issue('kingschat', safeReturnPath(returnPath), surface);

    const url = new URL(KINGSCHAT_LOGIN_URL);
    url.searchParams.set('clientId', client.clientId);
    // Their name for the CSRF parameter. Echoed back verbatim at the callback.
    url.searchParams.set('origin', token);
    res.status(200).json({ authorizationUrl: url.toString() });
  });

  /**
   * The KingsChat callback: a browser form POST carrying `code` and `origin`.
   *
   * It answers with a REDIRECT rather than JSON, because the person's browser
   * is navigating here and whatever this returns is what they look at.
   */
  app.post('/oauth/kingschat/callback', (req, res) => {
    const body = (req.body ?? {}) as { code?: unknown; origin?: unknown };
    const clients = deps.providers.kingschat;
    const client = clients?.get('web');
    if (!clients || !client) {
      res.redirect(302, landing(null, { error: 'unavailable' }));
      return;
    }

    /*
     * THE CSRF CHECK, and the whole reason `origin` is round-tripped.
     *
     * Without it, an attacker completes a login with THEIR KingsChat account,
     * catches the code, and gets a victim's browser to deliver it here. The
     * victim is then signed in as the attacker, and everything they go on to
     * do happens inside an account the attacker can read.
     *
     * NOTE FOR WHOEVER USES "Test Redirect URL" in the developer portal: it
     * sends origin=kingschat-redirect-url-test, which this refuses, exactly
     * as it should. That refusal is the check working, not a broken callback.
     */
    const presented = typeof body.origin === 'string' ? body.origin : null;
    const attempt = state.consume(presented);
    if (attempt === null || attempt.provider !== 'kingschat') {
      /*
       * SAID OUT LOUD, because the first live failure could not be explained
       * from the logs: this refusal redirected silently, so the only evidence
       * was a person reporting a page they had landed on.
       *
       * The TOKEN IS NOT LOGGED -- it is a live credential until it is spent,
       * and one in a log file outlives the minute it was good for. What is
       * logged is the shape: whether anything was presented at all, how many
       * logins are currently in flight, and the portal's own test marker,
       * which is the single most likely cause of a refusal that looks
       * mysterious.
       */
      warn(
        `kingschat callback refused: no matching login attempt ` +
          `(presented=${presented === null ? 'none' : `${presented.length} chars`}, ` +
          `pending=${state.pendingCount}` +
          `${presented === 'kingschat-redirect-url-test' ? ', portal Test Redirect URL' : ''})`,
      );
      res.redirect(302, landing(null, { error: 'expired' }));
      return;
    }

    const code = typeof body.code === 'string' ? body.code : '';
    if (code.length === 0) {
      res.redirect(302, landing(attempt, { error: 'cancelled' }));
      return;
    }

    void (async () => {
      const verified = await client.verify(code);
      if (!verified.ok) {
        /*
         * Their failures and ours are separated here because they lead
         * somewhere different: `code-rejected` means start again, while
         * `client-rejected` and `api-key-rejected` mean this deployment is
         * misconfigured and starting again will never help.
         */
        const broken =
          verified.reason === 'client-rejected' ||
          verified.reason === 'api-key-rejected' ||
          verified.reason === 'provider-unavailable';
        res.redirect(302, landing(attempt, { error: broken ? 'unavailable' : 'expired' }));
        return;
      }

      const outcome = await deps.signIn.signIn({
        provider: 'kingschat',
        subject: verified.subject,
        email: verified.email,
        emailVerified: verified.emailVerified,
        displayName: verified.displayName,
      });

      if (outcome.kind === 'refused') {
        // The reason, not the message: a query string is a url, and a url
        // ends up in history and logs. The page holds the wording.
        res.redirect(302, landing(attempt, { error: outcome.reason }));
        return;
      }

      /*
       * IN THE FRAGMENT, never the query string. A fragment is not sent to
       * any server, so it cannot land in an access log or a Referer header on
       * the way to the page that consumes it.
       */
      const handoff = handoffs.issue(outcome.account.accountId, outcome.account.tokenVersion);
      res.redirect(302, landing(attempt, { handoff }));
    })().catch(() => {
      res.redirect(302, landing(attempt, { error: 'unavailable' }));
    });
  });

  /**
   * Exchange the handoff for a real session.
   *
   * The page reads the fragment, posts it here, and clears it from the url.
   * Valid once, for a minute.
   */
  app.post('/oauth/handoff', (req, res) => {
    const token = (req.body as { handoff?: unknown } | undefined)?.handoff;
    const held = handoffs.consume(typeof token === 'string' ? token : null);
    if (held === null) {
      res.status(401).json({ error: 'That sign-in has expired. Please try again.' });
      return;
    }

    /*
     * Re-read the account rather than trusting what was stored a minute ago.
     * A sign-out-everywhere in the meantime bumps the token version, and
     * minting a session from the stale one would hand back a session the
     * person has just revoked.
     */
    const account = deps.store.get(held.accountId);
    if (!account || account.tokenVersion !== held.tokenVersion) {
      res.status(401).json({ error: 'That sign-in has expired. Please try again.' });
      return;
    }
    res.status(200).json(session(account.accountId, account.tokenVersion, sessionClassOf(req.body)));
  });
}

/** Which application a caller is, defaulting to the web one. */
function platformOf(value: unknown): ClientPlatform {
  return value === 'android' || value === 'ios' ? value : 'web';
}
