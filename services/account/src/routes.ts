/** @author masterzee001 */
/**
 * The sign-up and sign-in surface.
 *
 * Thin on purpose: it validates the transport and hands off, exactly as the
 * voice enrollment route does, because a second place that knows the rules is a
 * second place that can disagree with the first.
 *
 * NOTHING here logs a password, an email or a token. An email address in a log
 * line is a record of who uses this product, and a token in one is a working
 * credential sitting in a file that outlives the session it belonged to.
 */
import type express from 'express';
import {
  bearerToken,
  issueSessionToken,
  sessionLifetimeSeconds,
  type SessionClass,
  verifySessionToken,
} from '@videofy-live/account-tokens';
import type { AccountRecord, AccountStore } from './account-store.js';
import type { VerificationService } from './verification.js';
import {
  STEP_UP_FRESHNESS_MS,
  abuseKey,
  outstandingConsents,
  resolveTrustState,
  satisfiesStepUp,
  type AccountTrust,
  type PolicyRequirement,
  type StepUpOperation,
} from '@videofy-live/account-trust';
import type { PasswordResetService } from './password-reset.js';
import { clientIpOf } from './client-ip.js';
import type { MfaService } from './mfa-service.js';
import {
  checkDisplayName,
  checkUsernameShape,
  readDiscoveryMode,
  DISPLAY_NAME_REFUSAL_MESSAGES,
  USERNAME_REFUSAL_MESSAGES,
} from '@videofy-live/account-trust';
import type { ContactStore } from './contact-store.js';
import type { PresenceRegistry } from './presence.js';
import type { IdentityChangeService } from './identity-change-service.js';
import { recordSecurity } from './security-log.js';
import { correlationIdOf } from './request-context.js';
import type {
  AbuseLimiterPort,
  AbuseSurface,
  SecurityEventSink,
} from '@videofy-live/account-trust';
import {
  entitlementForPackage,
  grantedCapabilities,
  organizationWorkspaceId,
  personalWorkspaceId,
} from '@videofy-live/workspace-authority';

export interface AccountRouteDependencies {
  readonly store: AccountStore;
  /**
   * Accounts that carry the official C7 badge -- the platform's own voice.
   * Env-driven and read-only at runtime, like the platform-operator
   * allowlist: a badge that any code path could grant is a badge that will
   * eventually be granted by a bug. Empty set means nobody is official.
   */
  readonly officialAccounts?: ReadonlySet<string>;
  /** Present once organizations exist; the shell renders without it. */
  readonly organizations?: {
    organizationsFor(accountId: string): readonly {
      organizationId: string;
      displayName: string;
      role: string;
      state: string;
    }[];
  };
  readonly secret: Buffer;
  readonly nowSeconds?: () => number;
  /** Absent in tests that only exercise sign-in; the routes then 404. */
  readonly verification?: VerificationService;
  /** Absent until an email provider exists; the reset routes then 404. */
  readonly passwordReset?: PasswordResetService;
  /**
   * Policy versions this deployment requires.
   *
   * EMPTY MEANS NOTHING IS REQUIRED, and that is the honest default: consent
   * cannot be demanded until approved policy CONTENT exists to consent to.
   * Configuring a version before the document is written would collect
   * agreement to nothing, which is worse than collecting none.
   */
  readonly requiredPolicies?: readonly PolicyRequirement[];
  /**
   * Abuse limiting. Absent means UNLIMITED, and the composition root always
   * supplies one -- optional here only so the many tests that exercise a single
   * route are not each obliged to construct a limiter.
   */
  readonly abuse?: AbuseLimiterPort;
  readonly security?: SecurityEventSink;
  /** Salt for hashing addresses in security events. */
  readonly targetSalt?: string;
  readonly nowMs?: () => number;
  /** Absent until a keyring is configured; the MFA routes then 404. */
  readonly mfa?: MfaService;
  /**
   * Absent until delivery providers exist; the identity-change routes then 404.
   *
   * A 404 rather than a permissive fallback: an endpoint that changes the
   * address password reset is sent to must not exist in a half-configured
   * deployment.
   */
  readonly identityChange?: IdentityChangeService;
  /** Absent means the contact routes 404 rather than pretending to have a graph. */
  readonly contacts?: ContactStore;
  /**
   * Presence, shown to accepted contacts only. Absent means the contact
   * list and profiles simply omit it -- never a made-up 'away'.
   */
  readonly presence?: PresenceRegistry;
}

interface Body {
  email?: unknown;
  password?: unknown;
  voiceGender?: unknown;
}

/** Only the two values, and only when stated. Anything else is "not stated". */
function voiceGenderOf(body: unknown): 'male' | 'female' | undefined {
  const candidate = (body ?? {}) as Body;
  return candidate.voiceGender === 'male' || candidate.voiceGender === 'female'
    ? candidate.voiceGender
    : undefined;
}

function credentials(body: unknown): { email: string; password: string } | null {
  const candidate = (body ?? {}) as Body;
  if (typeof candidate.email !== 'string' || typeof candidate.password !== 'string') return null;
  return { email: candidate.email, password: candidate.password };
}

/**
 * Which session class a sign-in asks for. `client: 'device'` is the phone
 * (a long, renewable session that lasts until sign-out -- founder ruling
 * 29 Aug 2026); anything else, including nothing, is a browser session.
 */
function requestedSessionClass(body: unknown): SessionClass {
  const candidate = (body ?? {}) as { client?: unknown };
  return candidate.client === 'device' ? 'device' : 'browser';
}

/**
 * An account id from a request body, or null.
 *
 * Shape-checked rather than trusted: these ids address a person, and a caller
 * that can put arbitrary text here is a caller that can probe what the store
 * does with it.
 */
function parseAccountIdBody(body: unknown): string | null {
  const candidate = (body as { accountId?: unknown } | undefined)?.accountId;
  if (typeof candidate !== 'string') return null;
  return /^acct_[0-9a-f]{16}$/.test(candidate) ? candidate : null;
}

/**
 * Resolve the caller from a request, or null.
 *
 * Exported so the organization routes use the SAME implementation. Two ways of
 * deciding who is calling is two chances to disagree, and the disagreement
 * would be an authentication bypass.
 */
/**
 * Who is making this request, and what is already known about them.
 *
 * WHY AN OBJECT AND NOT AN ACCOUNT ID. The resolver has just verified a token
 * and loaded the record to check its version, so every fact here is already in
 * hand. Returning only the id threw that away and left each route to fetch the
 * same record again — and, more importantly, left nowhere to put the things
 * that are about to need somewhere: whether a second factor is enrolled, when
 * it was last satisfied, and which policy versions this account has accepted.
 *
 * Widening it is deliberately done ONCE, before those features exist, because
 * every route reads a caller and threading a new parameter through all of them
 * per feature is how a codebase acquires four ways of asking the same question.
 */
export interface Caller {
  readonly accountId: string;
  /**
   * The record, as loaded during verification.
   *
   * A snapshot, not a live handle: a route that mutates the account must go
   * through the store and re-read, or it will write back a stale copy of every
   * field it did not intend to touch.
   */
  readonly record: AccountRecord;
  /** Trust components, normalised — never read `record.trust` directly. */
  readonly trust: AccountTrust;
}

export function createCallerResolver(deps: {
  store: AccountStore;
  secret: Buffer;
  nowSeconds: () => number;
}) {
  return (req: express.Request): Caller | null => {
    const token = bearerToken(req.header('authorization'));
    if (!token) return null;
    const verified = verifySessionToken({
      secret: deps.secret,
      token,
      nowSeconds: deps.nowSeconds(),
    });
    if (!verified.ok) return null;
    const account = deps.store.get(verified.claims.accountId);
    // The version check is what makes "sign out everywhere" and a password
    // reset actually end existing sessions, rather than merely issuing a new
    // token alongside the ones an attacker already holds.
    if (!account || account.tokenVersion !== verified.claims.version) return null;
    return {
      accountId: account.accountId,
      record: account,
      trust: deps.store.trustOf(account.accountId),
    };
  };
}

export function registerAccountRoutes(app: express.Express, deps: AccountRouteDependencies): void {
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const nowMs = deps.nowMs ?? (() => Date.now());

  /**
   * One guard for every limited surface.
   *
   * KEYED ON WHAT THE REQUEST ACTUALLY CARRIES. Where a caller is
   * authenticated the account is the honest key -- an attacker who rotates
   * addresses is still one account. Where they are not, the address is all
   * there is, and `abuseKey` refuses a key built from nothing rather than
   * inventing a shared bucket that would put the whole internet in one queue.
   *
   * Returns true when the request was REFUSED and a response has been sent, so
   * a call site is one line and cannot forget to stop.
   */
  const refusedForAbuse = (
    req: express.Request,
    res: express.Response,
    surface: AbuseSurface,
    parts: { account?: string | null | undefined; target?: string | null | undefined },
  ): boolean => {
    if (!deps.abuse) return false;
    const ip = clientIpOf(req);
    let key: string;
    try {
      /*
       * THE KEY MUST NOT CONTAIN ANYTHING THE CALLER CHOOSES PER REQUEST.
       *
       * This originally included the submitted address, and the tests showed
       * the limit never firing: registration varies the address every attempt,
       * so every attempt got its own bucket. A key an attacker can change for
       * free is not a limit, it is bookkeeping.
       *
       * So: the ACCOUNT when the caller is authenticated -- an attacker who
       * rotates addresses is still one account -- and otherwise the source
       * address, which costs something to change. `parts.target` is carried
       * only for the security event, never for the key.
       */
      key = abuseKey(parts.account ? { account: parts.account } : { ip });
    } catch {
      // Nothing identifying at all. Rather than share one bucket, this is
      // allowed through: an unkeyable request is a bug in the caller, and
      // failing closed here would take the whole surface down for everybody.
      return false;
    }

    const decision = deps.abuse.consume({ surface, key, nowMs: nowMs() });
    if (decision.ok) return false;

    if (deps.security) {
      recordSecurity(deps.security, {
        kind: decision.reason === 'challenge-required' ? 'abuse.challengeRequired' : 'abuse.rateLimited',
        correlationId: correlationIdOf(res),
        atMs: nowMs(),
        ...(parts.account ? { accountId: parts.account } : {}),
        ...(parts.target ? { target: parts.target } : {}),
        ...(deps.targetSalt ? { salt: deps.targetSalt } : {}),
        ...(ip ? { sourceIp: ip } : {}),
      });
    }

    // Retry-After in SECONDS, and rounded up: rounding down tells a caller to
    // retry a moment before the bucket has refilled, which produces a second
    // refusal and looks like the limit is broken.
    res.setHeader('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)));
    res.status(429).json({
      error:
        decision.reason === 'challenge-required'
          ? 'Too many attempts. Wait a moment and try again.'
          : 'Too many attempts. Wait a moment and try again.',
      retryAfterMs: decision.retryAfterMs,
    });
    return true;
  };


  const session = (
    accountId: string,
    version: number,
    voiceGender: 'male' | 'female' | undefined,
    sessionClass: SessionClass = 'browser',
  ) => ({
    accountId,
    token: issueSessionToken({
      secret: deps.secret,
      accountId,
      version,
      nowSeconds: nowSeconds(),
      sessionClass,
    }),
    expiresInSeconds: sessionLifetimeSeconds(sessionClass),
    // Returned so the call form can default to the voice this person chose,
    // instead of everybody starting out sounding female.
    ...(voiceGender ? { voiceGender } : {}),
  });

  app.post('/accounts', (req, res) => {
    // Keyed on the address as well as the source: creating many accounts from
    // one address and one account from many addresses are different abuses,
    // and the address is the one an attacker cannot rotate for free.
    const attempted = credentials(req.body);
    if (refusedForAbuse(req, res, 'account.create', { target: attempted?.email ?? null })) return;
    const input = credentials(req.body);
    if (!input) {
      res.status(400).json({ error: 'Enter an email address and a password.' });
      return;
    }

    /*
     * THE HANDLE IS CHOSEN HERE, not afterwards.
     *
     * Left until later people forget, and an account with no handle exists but
     * cannot be added by anybody. Auto-assigning one instead is worse under the
     * never-reuse rule: the first thing somebody does with a handle they did
     * not pick is change it, and that burns the original forever.
     */
    const requestedUsername = (req.body as { username?: unknown } | undefined)?.username;
    if (typeof requestedUsername !== 'string') {
      res.status(400).json({ error: 'Choose a C7 username.' });
      return;
    }
    const shape = checkUsernameShape(requestedUsername);
    if (!shape.ok) {
      res.status(400).json({ error: USERNAME_REFUSAL_MESSAGES[shape.reason] });
      return;
    }

    void deps.store
      .register({
        ...input,
        username: shape.username,
        usernameKey: shape.key,
        ...(voiceGenderOf(req.body) ? { voiceGender: voiceGenderOf(req.body)! } : {}),
      })
      .then((result) => {
        if (!result.ok) {
          // 409 for anything already claimed -- an address or a handle -- and
          // 400 for what the caller can fix by typing something else.
          const conflict =
            result.reason === 'already-exists' ||
            result.reason === 'username-taken' ||
            result.reason === 'username-previously-used';
          res.status(conflict ? 409 : 400).json({ error: result.message });
          return;
        }
        /*
         * SEND THE VERIFICATION EMAIL. On the SERVER, because registration is
         * the only moment we know an account was just created and nobody has
         * proven the address yet.
         *
         * This used to be nobody's job. Registration created the account and
         * returned a session; the verification endpoint existed and waited to
         * be called; and no client called it. Both halves worked and the thing
         * they were meant to add up to -- somebody receiving an email -- never
         * happened. Leaving it to the client means every future client has to
         * remember, and the one that forgets fails exactly this quietly.
         *
         * NOT AWAITED, and failure does not change the response. The account
         * exists and the session is valid whatever the provider does; a
         * delivery outage must not turn a successful registration into a 500
         * and an account the person cannot sign in to. If it fails there is a
         * resend endpoint, which is the designed path for a bounce anyway.
         */
        if (deps.verification) {
          void deps.verification
            .requestEmailVerification(result.account.accountId)
            .catch(() => undefined);
        }

        // Signed up and signed in. Making somebody immediately repeat their
        // password to get a session serves nothing but ceremony.
        res.status(201).json(
            session(
              result.account.accountId,
              result.account.tokenVersion,
              result.account.voiceGender,
              requestedSessionClass(req.body),
            ),
          );
      })
      .catch(() => res.status(500).json({ error: 'Your account could not be created.' }));
  });

  app.post('/sessions', (req, res) => {
    /*
     * The existing account-level lockout in AccountStore slows a brute force
     * against ONE account. This limits the other shape: one attacker trying one
     * password against many accounts, which never trips a per-account counter.
     */
    const attempt = credentials(req.body);
    if (refusedForAbuse(req, res, 'account.authenticate', { target: attempt?.email ?? null }))
      return;
    const input = credentials(req.body);
    if (!input) {
      res.status(400).json({ error: 'Enter your email address and password.' });
      return;
    }
    void deps.store
      .authenticate(input)
      .then((result) => {
        if (!result.ok) {
          // One message for a wrong password and an unknown address alike. The
          // store already refuses to distinguish them; saying it differently
          // here would undo that.
          res.status(result.reason === 'locked' ? 429 : 401).json({
            error:
              result.reason === 'locked'
                ? 'Too many attempts. Try again in a few minutes.'
                : 'That email address and password do not match.',
          });
          return;
        }
        res.status(200).json(
          session(
            result.account.accountId,
            result.account.tokenVersion,
            result.account.voiceGender,
            requestedSessionClass(req.body),
          ),
        );
      })
      .catch(() => res.status(500).json({ error: 'You could not be signed in.' }));
  });

  /**
   * A fresh token of the SAME class, for a session that is still valid.
   *
   * This is what makes a device session last until sign-out: the phone renews
   * while it is used, and a token that stops being renewed simply ages out.
   * The class comes from the presented token, never the body, so a browser
   * token cannot renew itself into a device one. The version check is the
   * same one `/sessions/current` makes: a revoked session cannot renew.
   */
  app.post('/sessions/renew', (req, res) => {
    const token = bearerToken(req.header('authorization'));
    const verified = token ? verifySessionToken({ secret: deps.secret, token, nowSeconds: nowSeconds() }) : null;
    if (!verified?.ok) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    const account = deps.store.get(verified.claims.accountId);
    if (!account || account.tokenVersion !== verified.claims.version) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    res.status(200).json(session(account.accountId, account.tokenVersion, account.voiceGender, verified.claims.sessionClass));
  });

  /**
   * Who this token says you are.
   *
   * The one place that checks `ver` against the account, which is what makes
   * "sign out everywhere" real: other services verify signature and expiry only
   * and cannot know about a revocation until the token ages out.
   */
  app.get('/sessions/current', (req, res) => {
    const token = bearerToken(req.header('authorization'));
    if (!token) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    const verified = verifySessionToken({ secret: deps.secret, token, nowSeconds: nowSeconds() });
    if (!verified.ok) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    const account = deps.store.get(verified.claims.accountId);
    if (!account || account.tokenVersion !== verified.claims.version) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    // The account id is the caller's own, and the email is the one they typed.
    // Nothing else about the account is anybody's business over HTTP.
    res.status(200).json({
      accountId: account.accountId,
      email: account.email,
      ...(account.voiceGender ? { voiceGender: account.voiceGender } : {}),
    });
  });

  /**
   * The caller's own account id, or null.
   *
   * Every verification route runs through this. The account is taken from the
   * SIGNED TOKEN and never from the body: a route that accepted an accountId
   * would let anybody request or confirm verification for somebody else.
   */
  const callerAccountId = createCallerResolver({
    store: deps.store,
    secret: deps.secret,
    nowSeconds,
  });

  if (deps.verification) {
    const verification = deps.verification;

    /** Where the registered shell learns what still needs doing. */
    app.get('/verification', (req, res) => {
      const caller = callerAccountId(req);
      if (caller === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      res.status(200).json(verification.status(caller.accountId));
    });

    app.post('/verification/email', (req, res) => {
      const caller = callerAccountId(req);
      // Each send costs a third party's delivery fee, to an address the
      // requester does not have to own.
      if (refusedForAbuse(req, res, 'verification.emailResend', { account: caller?.accountId }))
        return;
      if (caller === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      void verification
        .requestEmailVerification(caller.accountId)
        .then((outcome) => {
          if (outcome.ok) {
            // Deliberately no token in the response. Returning one would turn
            // this endpoint into a way to verify an address without ever
            // receiving the message sent to it.
            res.status(202).json({
              sent: true,
              expiresAtMs: outcome.expiresAtMs,
              /*
               * Whether anything actually left the building. A synthetic
               * provider reports every send as delivered, so without this the
               * client shows "check your inbox" for a message that was never
               * sent -- which is precisely how a registration on staging came
               * to sit waiting for an email that did not exist.
               */
              ...(outcome.synthetic ? { deliverable: false as const } : {}),
            });
            return;
          }
          if (outcome.reason === 'throttled') {
            res
              .status(429)
              .json({ error: 'Wait a moment before asking again.', retryAfterMs: outcome.retryAfterMs });
            return;
          }
          if (outcome.reason === 'already-verified') {
            res.status(409).json({ error: 'That address is already verified.' });
            return;
          }
          res.status(502).json({ error: 'The message could not be sent. Try again shortly.' });
        })
        .catch(() => res.status(500).json({ error: 'The message could not be sent.' }));
    });

    app.post('/verification/email/confirm', (req, res) => {
      const caller = callerAccountId(req);
      if (caller === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      const token = (req.body as { token?: unknown } | undefined)?.token;
      if (typeof token !== 'string' || token.length === 0 || token.length > 512) {
        res.status(400).json({ error: 'That verification link is not valid.' });
        return;
      }
      void verification
        .confirmEmail(caller.accountId, token)
        .then((outcome) => {
          if (outcome.ok) {
            res.status(200).json({ verified: true, state: outcome.state });
            return;
          }
          // ONE message for every failure reason. Distinguishing expired from
          // wrong from already-used tells someone probing links which of their
          // guesses was closest.
          res.status(400).json({ error: 'That verification link is not valid or has expired.' });
        })
        .catch(() => res.status(500).json({ error: 'Verification could not be completed.' }));
    });

    app.post('/verification/phone', (req, res) => {
      const caller = callerAccountId(req);
      if (refusedForAbuse(req, res, 'verification.phoneRequest', { account: caller?.accountId }))
        return;
      if (caller === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      const phone = (req.body as { phone?: unknown } | undefined)?.phone;
      if (typeof phone !== 'string' || phone.length > 32) {
        res.status(400).json({ error: 'Enter a phone number in international format.' });
        return;
      }
      void verification
        .requestPhoneVerification(caller.accountId, phone)
        .then((outcome) => {
          if (outcome.ok) {
            res.status(202).json({
              sent: true,
              expiresAtMs: outcome.expiresAtMs,
              ...(outcome.synthetic ? { deliverable: false as const } : {}),
            });
            return;
          }
          if (outcome.reason === 'throttled') {
            res
              .status(429)
              .json({ error: 'Wait a moment before asking again.', retryAfterMs: outcome.retryAfterMs });
            return;
          }
          if (outcome.reason === 'invalid-target') {
            res.status(400).json({ error: 'Enter a phone number in international format.' });
            return;
          }
          if (outcome.reason === 'already-verified') {
            res.status(409).json({ error: 'That number is already verified.' });
            return;
          }
          res.status(502).json({ error: 'The code could not be sent. Try again shortly.' });
        })
        .catch(() => res.status(500).json({ error: 'The code could not be sent.' }));
    });

    app.post('/verification/identity', (req, res) => {
      const caller = callerAccountId(req);
      if (caller === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      void verification
        .startIdentityVerification(caller.accountId)
        .then((outcome) => {
          if (outcome.ok) {
            // A redirect to the provider's hosted flow. C7 never sees the
            // document, which is the whole point of keeping a reference.
            res.status(200).json({
              redirectUrl: outcome.session.redirectUrl,
              expiresAtMs: outcome.session.expiresAtMs,
              /*
               * Whether this check can actually conclude. A synthetic provider
               * hands back a redirect no callback will ever follow up, so the
               * console must say so rather than showing a check that looks
               * live. Sent only when the answer is no, so a real deployment
               * never carries the field and an older client keeps working.
               */
              ...(verification.identityDeliverability() === 'real'
                ? {}
                : { deliverable: false as const }),
            });
            return;
          }
          if (outcome.reason === 'already-verified') {
            res.status(409).json({ error: 'Your identity is already verified.' });
            return;
          }
          if (outcome.reason === 'in-progress') {
            res.status(409).json({ error: 'An identity check is already in progress.' });
            return;
          }
          res.status(503).json({ error: 'Identity verification is not available yet.' });
        })
        .catch(() => res.status(500).json({ error: 'Identity verification could not be started.' }));
    });

    app.post('/verification/phone/confirm', (req, res) => {
      const caller = callerAccountId(req);
      if (caller === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      const code = (req.body as { code?: unknown } | undefined)?.code;
      if (typeof code !== 'string' || !/^\d{4,8}$/.test(code)) {
        res.status(400).json({ error: 'Enter the code we sent you.' });
        return;
      }
      void verification
        .confirmPhone(caller.accountId, code)
        .then((outcome) => {
          if (outcome.ok) {
            res.status(200).json({ verified: true, state: outcome.state });
            return;
          }
          res.status(400).json({ error: 'That code is not valid or has expired.' });
        })
        .catch(() => res.status(500).json({ error: 'Verification could not be completed.' }));
    });
  }

  /**
   * What the registered shell needs to render itself.
   *
   * Capabilities are computed SERVER-SIDE and sent for RENDERING only. The
   * client uses them to decide what to show; it never uses them to decide what
   * is allowed, because every protected action is authorized again at the point
   * it happens. Hiding a button is courtesy, not security.
   */
  if (deps.passwordReset) {
    const passwordReset = deps.passwordReset;

    /*
     * UNAUTHENTICATED, and deliberately incurious about who is asking.
     *
     * Always 202 with the same body. An unknown address, a throttled one and a
     * real one are indistinguishable, because this endpoint is otherwise a
     * "does this person have an account here" oracle that anybody may query as
     * often as they like.
     */
    app.post('/accounts/password-reset', (req, res) => {
      const email = (req.body as { email?: unknown } | undefined)?.email;
      /*
       * Refused with 429 rather than the usual 202. That IS a difference an
       * attacker can observe -- but only after they have already made enough
       * requests to trip the limit, by which point they have told us far more
       * than the response tells them. The alternative, silently swallowing
       * everything past the limit, gives a flood no back-pressure at all.
       */
      if (
        refusedForAbuse(req, res, 'account.passwordReset', {
          target: typeof email === 'string' ? email : null,
        })
      )
        return;
      if (typeof email !== 'string' || email.length === 0 || email.length > 320) {
        // Even a malformed address gets the same answer. Rejecting only the
        // invalid ones tells a caller which strings are addresses we would
        // look up, which is a smaller oracle but an oracle.
        res.status(202).json({ status: 'accepted' });
        return;
      }
      void passwordReset
        .request(email)
        .then(() => res.status(202).json({ status: 'accepted' }))
        .catch(() => res.status(202).json({ status: 'accepted' }));
    });

    app.post('/accounts/password-reset/complete', (req, res) => {
      const body = req.body as { email?: unknown; token?: unknown; password?: unknown } | undefined;
      if (
        typeof body?.email !== 'string' ||
        typeof body.token !== 'string' ||
        typeof body.password !== 'string' ||
        body.token.length === 0 ||
        body.token.length > 512
      ) {
        res.status(400).json({ error: 'That reset link is not valid or has expired.' });
        return;
      }
      void passwordReset
        .complete({ email: body.email, token: body.token, password: body.password })
        .then((outcome) => {
          if (outcome.ok) {
            // No session is issued. Somebody who has just reset a password
            // should sign in with it -- and if this was an attacker completing
            // a reset, handing them a live session here would be the last step
            // of the takeover.
            res.status(200).json({ reset: true });
            return;
          }
          if (outcome.reason === 'weak-password') {
            res.status(400).json({ error: 'Choose a longer password.' });
            return;
          }
          // ONE message for expired, wrong, already-used and unknown account.
          res.status(400).json({ error: 'That reset link is not valid or has expired.' });
        })
        .catch(() => res.status(500).json({ error: 'The reset could not be completed.' }));
    });
  }

  /** Record acceptance of a policy version. Authenticated: consent is personal. */
  app.post('/accounts/consents', (req, res) => {
    const caller = callerAccountId(req);
    if (caller === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    const body = req.body as { policyType?: unknown; policyVersion?: unknown } | undefined;
    const required = deps.requiredPolicies ?? [];
    const match = required.find(
      (requirement) =>
        requirement.policyType === body?.policyType &&
        requirement.requiredVersion === body?.policyVersion,
    );
    if (!match) {
      /*
       * Only a CURRENTLY REQUIRED version may be accepted. Without this the
       * endpoint accepts any string as a policy version, and an account could
       * hold a consent record for a document that was never published -- which
       * looks exactly like valid evidence until somebody asks to see the
       * document.
       */
      res.status(400).json({ error: 'That is not a policy version currently in force.' });
      return;
    }
    void deps.store
      .acceptPolicy(caller.accountId, match.policyType, match.requiredVersion)
      .then((updated) => {
        if (!updated) {
          res.status(401).json({ error: 'Sign in to continue.' });
          return;
        }
        res.status(200).json({
          accepted: { policyType: match.policyType, policyVersion: match.requiredVersion },
          outstanding: outstandingConsents({
            required: deps.requiredPolicies ?? [],
            held: updated.consents ?? [],
            accountId: caller.accountId,
          }),
        });
      })
      .catch(() => res.status(500).json({ error: 'That could not be recorded.' }));
  });

  if (deps.mfa) {
    const mfa = deps.mfa;

    /**
     * Demand a fresh second factor.
     *
     * satisfiesStepUp decides, not this file: it knows that MFA must be ACTIVE,
     * that evidence must exist, and how old is too old. Duplicating any of that
     * here would be a second opinion that eventually disagrees with the first.
     */
    const requireStepUp = (
      res: express.Response,
      caller: Caller,
      operation: StepUpOperation,
    ): boolean => {
      const decision = satisfiesStepUp({
        operation,
        mfaState: mfa.stateOf(caller.accountId),
        evidence: deps.store.stepUpEvidenceOf(caller.accountId),
        nowMs: nowMs(),
      });
      if (decision.ok) return false;

      if (deps.security) {
        recordSecurity(deps.security, {
          kind: 'stepUp.required',
          correlationId: correlationIdOf(res),
          atMs: nowMs(),
          accountId: caller.accountId,
          reasonCode: decision.reason,
        });
      }
      // 403 rather than 401: they ARE authenticated. A 401 sends a client to
      // the sign-in screen, which fixes nothing and loses whatever they were
      // part-way through doing.
      res
        .status(403)
        .json({ error: 'Confirm your second factor to continue.', reason: decision.reason });
      return true;
    };

    /** Begin enrolment. Returns the secret ONCE, inside the otpauth URI. */
    app.post('/accounts/mfa', (req, res) => {
      const caller = callerAccountId(req);
      if (caller === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      void mfa
        .begin(caller.accountId, caller.record.email)
        .then((outcome) => {
          if (!outcome.ok) {
            res.status(409).json({ error: 'A second factor is already set up.' });
            return;
          }
          /*
           * The ONLY response that ever carries the secret or the recovery
           * codes. Nothing re-reads them: losing them means disabling the
           * factor and enrolling again, which is a deliberate act requiring
           * step-up -- rather than an endpoint that hands a bearer credential
           * to anybody holding a session.
           */
          res
            .status(201)
            .json({ otpauthUri: outcome.otpauthUri, recoveryCodes: outcome.recoveryCodes });
        })
        .catch(() => res.status(500).json({ error: 'Enrolment could not be started.' }));
    });

    /** Confirm enrolment with a live code, proving the authenticator holds it. */
    app.post('/accounts/mfa/confirm', (req, res) => {
      const caller = callerAccountId(req);
      if (caller === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      const code = (req.body as { code?: unknown } | undefined)?.code;
      if (typeof code !== 'string' || code.length === 0 || code.length > 16) {
        res.status(400).json({ error: 'That code is not valid.' });
        return;
      }
      void mfa
        .confirm(caller.accountId, code)
        .then((outcome) => {
          if (!outcome.ok) {
            res.status(400).json({ error: 'That code is not valid.' });
            return;
          }
          if (deps.security) {
            recordSecurity(deps.security, {
              kind: 'mfa.enrolled',
              correlationId: correlationIdOf(res),
              atMs: nowMs(),
              accountId: caller.accountId,
            });
          }
          res.status(200).json({ enrolled: true });
        })
        .catch(() => res.status(500).json({ error: 'Enrolment could not be confirmed.' }));
    });

    /**
     * Satisfy a step-up.
     *
     * Accepts a TOTP code OR a recovery code, because somebody who has lost
     * their authenticator still has to reach the operation that turns it off.
     * Without that, a lost phone is a permanently unusable account and the
     * support process that grows in its place is a far weaker second factor
     * than the one it replaced.
     */
    app.post('/accounts/step-up', (req, res) => {
      const caller = callerAccountId(req);
      if (caller === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      // Reuses the OTP-verify surface deliberately: this is a guess at a
      // six-digit secret, and its cap is what makes six digits acceptable at
      // all. That surface is never challengeable.
      if (refusedForAbuse(req, res, 'verification.phoneVerify', { account: caller.accountId })) {
        return;
      }
      const body = req.body as { code?: unknown; recoveryCode?: unknown } | undefined;

      const grant = async (): Promise<'totp' | 'recovery-code' | null> => {
        if (typeof body?.code === 'string' && mfa.verify(caller.accountId, body.code)) {
          return 'totp';
        }
        if (
          typeof body?.recoveryCode === 'string' &&
          (await mfa.consumeRecovery(caller.accountId, body.recoveryCode))
        ) {
          return 'recovery-code';
        }
        return null;
      };

      void grant()
        .then(async (method) => {
          if (method === null) {
            if (deps.security) {
              recordSecurity(deps.security, {
                kind: 'mfa.challengeFailed',
                correlationId: correlationIdOf(res),
                atMs: nowMs(),
                accountId: caller.accountId,
              });
            }
            res.status(400).json({ error: 'That code is not valid.' });
            return;
          }
          await deps.store.grantStepUp(caller.accountId, method);
          if (deps.security) {
            recordSecurity(deps.security, {
              kind: 'stepUp.satisfied',
              correlationId: correlationIdOf(res),
              atMs: nowMs(),
              accountId: caller.accountId,
            });
          }
          // No token comes back. The grant lives server-side precisely so it
          // can be revoked the instant anything changes; handing out a bearer
          // value would undo exactly that.
          res.status(200).json({ steppedUp: true, freshForMs: STEP_UP_FRESHNESS_MS });
        })
        .catch(() => res.status(500).json({ error: 'That could not be confirmed.' }));
    });

    /** Turn the factor off. Requires a fresh step-up, which it declares itself. */
    app.delete('/accounts/mfa', (req, res) => {
      const caller = callerAccountId(req);
      if (caller === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      if (requireStepUp(res, caller, 'account.disableMfa')) return;
      void mfa
        .disable(caller.accountId)
        .then(() => {
          if (deps.security) {
            recordSecurity(deps.security, {
              kind: 'mfa.disabled',
              correlationId: correlationIdOf(res),
              atMs: nowMs(),
              accountId: caller.accountId,
            });
          }
          res.status(200).json({ enrolled: false });
        })
        .catch(() => res.status(500).json({ error: 'That could not be changed.' }));
    });
  }

  const identityChange = deps.identityChange;
  if (identityChange) {
    /**
     * Begin changing a verified email or phone number.
     *
     * WHY THIS IS NOT A PROFILE EDIT. A verified address is the thing password
     * reset is sent to. Treated as an ordinary field update, an attacker
     * holding a live session and nothing else could point recovery at an
     * address they control and own the account permanently.
     *
     * Step-up is required BEFORE anything is sent, so a stolen session cannot
     * even cause a message to be delivered to an attacker-chosen address.
     */
    app.post('/accounts/identity-change', (req, res) => {
      const caller = callerAccountId(req);
      if (caller === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      // Each attempt costs a delivery fee to an address the requester does not
      // have to own -- the same exposure the verification resend surface has.
      if (refusedForAbuse(req, res, 'verification.emailResend', { account: caller.accountId })) {
        return;
      }

      const body = req.body as { channel?: unknown; target?: unknown } | undefined;
      const channel = body?.channel;
      if (channel !== 'email' && channel !== 'phone') {
        res.status(400).json({ error: 'Choose email or phone.' });
        return;
      }
      if (typeof body?.target !== 'string' || body.target.length === 0 || body.target.length > 320) {
        res.status(400).json({ error: 'That address is not valid.' });
        return;
      }

      void identityChange
        .begin(caller.accountId, channel, body.target, correlationIdOf(res))
        .then((outcome) => {
          if (outcome.ok) {
            // No token in the response. Returning one would let a stolen
            // session complete the change without ever reading the message.
            res.status(202).json({ sent: true, expiresAtMs: outcome.expiresAtMs });
            return;
          }
          if (outcome.reason === 'step-up-required') {
            res.status(403).json({
              error: 'Confirm your second factor before changing this.',
              stepUpRequired: true,
            });
            return;
          }
          if (outcome.reason === 'unchanged') {
            res.status(409).json({ error: 'That is already your address.' });
            return;
          }
          if (outcome.reason === 'delivery-failed') {
            res.status(502).json({ error: 'The message could not be sent. Try again shortly.' });
            return;
          }
          /*
           * ONE ANSWER for an invalid address and for one already registered to
           * somebody else. Telling them apart turns this endpoint into a way to
           * ask whether a given person has an account.
           */
          res.status(400).json({ error: 'That address cannot be used.' });
        })
        .catch(() => res.status(500).json({ error: 'That change could not be started.' }));
    });

    /**
     * Complete the change with the token sent to the NEW address.
     *
     * The old address stays authoritative right up to this call, and is warned
     * immediately after it -- that warning is the only message in the whole
     * sequence that reaches somebody who has not been compromised.
     */
    app.post('/accounts/identity-change/confirm', (req, res) => {
      const caller = callerAccountId(req);
      if (caller === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      // A six-digit phone code is guessable without a cap on attempts. This is
      // the same surface the OTP check uses, and it is never challengeable.
      if (refusedForAbuse(req, res, 'verification.phoneVerify', { account: caller.accountId })) {
        return;
      }

      const token = (req.body as { token?: unknown } | undefined)?.token;
      if (typeof token !== 'string' || token.length === 0 || token.length > 512) {
        res.status(400).json({ error: 'That confirmation is not valid.' });
        return;
      }

      void identityChange
        .confirm(caller.accountId, token, correlationIdOf(res))
        .then((outcome) => {
          if (outcome.ok) {
            res.status(200).json({
              changed: true,
              channel: outcome.channel,
              /*
               * Announced, because it is about to happen to the caller. An
               * email change revokes every session including this one, and a
               * client that is not told simply appears to break.
               */
              sessionsRevoked: outcome.sessionsRevoked,
            });
            return;
          }
          if (outcome.reason === 'no-pending-change') {
            res.status(409).json({ error: 'There is no change waiting to be confirmed.' });
            return;
          }
          // One message for expired, wrong, replayed and already-taken alike.
          res.status(400).json({ error: 'That confirmation is not valid or has expired.' });
        })
        .catch(() => res.status(500).json({ error: 'That change could not be completed.' }));
    });
  }

  /**
   * Claim the handle people add you by.
   *
   * Separate from the display name below, and the separation is the control:
   * if people were added by the name shown in calls, a fraudster sets theirs to
   * match somebody trusted and gets added by mistake.
   */
  app.post('/accounts/username', (req, res) => {
    const caller = callerAccountId(req);
    if (caller === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    // Claiming is cheap to attempt and its refusals are informative, so the
    // rate it can be attempted at is what stops it becoming a way to map which
    // handles exist.
    if (refusedForAbuse(req, res, 'account.create', { account: caller.accountId })) return;

    const requested = (req.body as { username?: unknown } | undefined)?.username;
    if (typeof requested !== 'string') {
      res.status(400).json({ error: USERNAME_REFUSAL_MESSAGES['bad-shape'] });
      return;
    }
    const shape = checkUsernameShape(requested);
    if (!shape.ok) {
      res.status(400).json({ error: USERNAME_REFUSAL_MESSAGES[shape.reason] });
      return;
    }

    void deps.store
      .claimUsername(caller.accountId, shape.username, shape.key)
      .then((claim) => {
        if (claim.ok) {
          res.status(200).json({ username: claim.record.username });
          return;
        }
        if (claim.reason === 'unknown-account') {
          res.status(401).json({ error: 'Sign in to continue.' });
          return;
        }
        // 409 for both: taken and previously-used are the same answer to the
        // person choosing, and distinguishing them would confirm that a
        // particular handle once belonged to somebody.
        res.status(409).json({ error: USERNAME_REFUSAL_MESSAGES[claim.reason] });
      })
      .catch(() => res.status(500).json({ error: 'That username could not be saved.' }));
  });

  /** Set the label shown in calls. Not an identity; nobody is found by it. */
  app.post('/accounts/display-name', (req, res) => {
    const caller = callerAccountId(req);
    if (caller === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    const requested = (req.body as { displayName?: unknown } | undefined)?.displayName;
    if (typeof requested !== 'string') {
      res.status(400).json({ error: DISPLAY_NAME_REFUSAL_MESSAGES.empty });
      return;
    }
    const checked = checkDisplayName(requested);
    if (!checked.ok) {
      res.status(400).json({ error: DISPLAY_NAME_REFUSAL_MESSAGES[checked.reason] });
      return;
    }

    void deps.store
      .setDisplayName(caller.accountId, checked.displayName)
      .then((record) => {
        if (!record) {
          res.status(401).json({ error: 'Sign in to continue.' });
          return;
        }
        res.status(200).json({ displayName: record.displayName });
      })
      .catch(() => res.status(500).json({ error: 'That name could not be saved.' }));
  });

  /**
   * The language this person's calls enter with. Speak and hear both preload
   * from it on the join screen; either can still be changed per call.
   */
  app.post('/accounts/default-language', (req, res) => {
    const caller = callerAccountId(req);
    if (caller === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    const requested = (req.body as { defaultLanguage?: unknown } | undefined)?.defaultLanguage;
    if (requested !== 'en' && requested !== 'es' && requested !== 'fr') {
      res.status(400).json({ error: 'Pick one of the supported languages.' });
      return;
    }
    void deps.store
      .setDefaultLanguage(caller.accountId, requested)
      .then((record) => {
        if (!record) {
          res.status(401).json({ error: 'Sign in to continue.' });
          return;
        }
        res.status(200).json({ defaultLanguage: record.defaultLanguage ?? null });
      })
      .catch(() => res.status(500).json({ error: 'That could not be saved.' }));
  });

  /**
   * Refine the finer language facts independently: the language you SPEAK
   * and the language you PREFER TO HEAR. The primary route above seeds both;
   * this one never touches the primary.
   */
  app.post('/accounts/languages', (req, res) => {
    const caller = callerAccountId(req);
    if (caller === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    const body = (req.body ?? {}) as { spokenLanguage?: unknown; listeningLanguage?: unknown };
    const valid = (value: unknown): value is 'en' | 'es' | 'fr' =>
      value === 'en' || value === 'es' || value === 'fr';
    if (
      (body.spokenLanguage !== undefined && !valid(body.spokenLanguage)) ||
      (body.listeningLanguage !== undefined && !valid(body.listeningLanguage)) ||
      (body.spokenLanguage === undefined && body.listeningLanguage === undefined)
    ) {
      res.status(400).json({ error: 'Pick one of the supported languages.' });
      return;
    }
    void deps.store
      .setLanguages(caller.accountId, {
        ...(valid(body.spokenLanguage) ? { spokenLanguage: body.spokenLanguage } : {}),
        ...(valid(body.listeningLanguage) ? { listeningLanguage: body.listeningLanguage } : {}),
      })
      .then((record) => {
        if (!record) {
          res.status(401).json({ error: 'Sign in to continue.' });
          return;
        }
        res.status(200).json({
          spokenLanguage: record.spokenLanguage ?? null,
          listeningLanguage: record.listeningLanguage ?? null,
        });
      })
      .catch(() => res.status(500).json({ error: 'That could not be saved.' }));
  });

  /**
   * Choose whether your handle can be found at all.
   *
   * OFF IS THE DEFAULT and stays the default: this endpoint is how somebody
   * opts IN, and turning it back off is always available. The stored value is
   * read through readDiscoveryMode everywhere, so anything that is not exactly
   * 'discoverable' -- including a value written by a future version this one
   * does not understand -- resolves to private.
   */
  app.post('/accounts/discovery', (req, res) => {
    const caller = callerAccountId(req);
    if (caller === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    const requested = (req.body as { discoverable?: unknown } | undefined)?.discoverable;
    if (typeof requested !== 'boolean') {
      res.status(400).json({ error: 'Choose whether people can find you by username.' });
      return;
    }

    void deps.store
      .setDiscoveryMode(caller.accountId, requested ? 'discoverable' : 'private')
      .then((record) => {
        if (!record) {
          res.status(401).json({ error: 'Sign in to continue.' });
          return;
        }
        res
          .status(200)
          .json({ discoverable: readDiscoveryMode(record.discoveryMode) === 'discoverable' });
      })
      .catch(() => res.status(500).json({ error: 'That setting could not be saved.' }));
  });

  /**
   * Find somebody by username, in order to add them.
   *
   * PRIVATE BY DEFAULT, which is the whole reason this endpoint is careful. An
   * account that has not opted into being discoverable is not findable here at
   * all -- not "found but hidden", not a different error: the same answer as a
   * username nobody holds. Anything else makes this a way to ask whether a
   * given person has a C7 account, which is exactly what private mode exists to
   * withhold, and a fraudster mapping who is reachable is the first step of the
   * thing the contact gate is for.
   *
   * Signed in only. An endpoint that resolves handles to people should not be
   * available to whoever finds the URL.
   */
  app.get('/accounts/lookup', (req, res) => {
    const caller = callerAccountId(req);
    if (caller === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    /*
     * `contact.search`, not the sign-in surface. Searching for people and
     * guessing passwords are different abuses with different shapes, and
     * sharing a budget means a burst of one silently spends the other's.
     */
    if (refusedForAbuse(req, res, 'contact.search', { account: caller.accountId })) return;

    const requested = req.query['username'];
    if (typeof requested !== 'string') {
      res.status(400).json({ error: 'Enter a username to look up.' });
      return;
    }
    const shape = checkUsernameShape(requested);
    if (!shape.ok) {
      // Same answer as not-found. A shape refusal here would tell a caller
      // which strings are worth trying.
      res.status(404).json({ found: false });
      return;
    }

    const holder = deps.store.findByUsernameKey(shape.key);
    if (!holder || readDiscoveryMode(holder.discoveryMode) !== 'discoverable') {
      res.status(404).json({ found: false });
      return;
    }

    /*
     * The username is echoed back in ITS spelling, not the caller's. Somebody
     * who typed `z0emeak` should see `zoemeak` and be able to tell they have
     * found the person they meant rather than a lookalike.
     */
    res.status(200).json({
      found: true,
      username: holder.username,
      displayName: holder.displayName ?? null,
    });
  });

  const contacts = deps.contacts;
  if (contacts) {
    /**
     * Who you can reach, and who is waiting on you.
     *
     * Names come from the ACCOUNT RECORD at read time rather than being copied
     * onto the edge when it was made. A display name people can change would
     * otherwise be frozen at the moment somebody added them, and the stale copy
     * is what a stranger would be recognised by.
     */
    app.get('/contacts', (req, res) => {
      const caller = callerAccountId(req);
      if (caller === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }

      const describe = (otherAccountId: string) => {
        const other = deps.store.get(otherAccountId);
        return {
          accountId: otherAccountId,
          username: other?.username ?? null,
          displayName: other?.displayName ?? null,
          official: deps.officialAccounts?.has(otherAccountId) ?? false,
          // The language they SPEAK: what a call with them sounds like.
          // Public, like the username. Never the listening preference.
          spokenLanguage: other?.spokenLanguage ?? other?.defaultLanguage ?? null,
        };
      };
      // Presence ONLY on accepted contacts. A pending request is not yet a
      // relationship that earns knowing whether somebody is around.
      const presence = deps.presence;
      const describeContact = (otherAccountId: string) => {
        const other = deps.store.get(otherAccountId);
        return {
          ...describe(otherAccountId),
          ...(presence && other
            ? { presence: presence.stateOf(otherAccountId, other.availability) }
            : {}),
        };
      };

      res.status(200).json({
        contacts: contacts
          .contactsOf(caller.accountId)
          .map((edge) => describeContact(contacts.other(edge, caller.accountId))),
        /*
         * Only requests somebody else sent. A request you sent is not something
         * you can act on, and listing it as answerable invites a client to
         * offer accepting your own.
         */
        requests: contacts.pendingFor(caller.accountId).map((edge) => ({
          ...describe(edge.requestedBy),
          requestedAtMs: edge.requestedAtMs,
        })),
        sent: contacts
          .sentBy(caller.accountId)
          .map((edge) => describe(contacts.other(edge, caller.accountId))),
      });
    });

    /**
     * Ask somebody to be a contact, by username.
     *
     * PRIVATE ACCOUNTS ARE UNREACHABLE HERE, and answer exactly as a username
     * nobody holds. That is the point of private mode: an account that has not
     * opted into being found must not be findable by trying, and a different
     * answer for "exists but private" would make it findable by trying.
     *
     * The route to a private account is an invite they issued, which is consent
     * given in advance rather than requested after the fact.
     */
    /*
     * ANOTHER PERSON'S PROFILE, AS THIS VIEWER MAY SEE IT (founder ruling
     * 29 Aug). The same door as adding them: a stranger who is not
     * discoverable answers 404 exactly like a nonexistent account, so this
     * route is not an oracle for who is on the platform. A contact, a
     * pending request in either direction, or somebody you blocked is
     * always visible to you. What is shown: the two identity fields, the
     * platform badge, discoverability, the language they SPEAK (what a call
     * sounds like) -- never the language they prefer to listen in -- and
     * the relationship from the viewer's side.
     */
    app.get('/profiles/:accountId', (req, res) => {
      const caller = callerAccountId(req);
      if (caller === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      const targetId = String(req.params['accountId'] ?? '');
      const target = deps.store.get(targetId);
      const edge = targetId === caller.accountId ? null : contacts.edgeBetween(caller.accountId, targetId);
      const relationship: 'contact' | 'requested' | 'incoming' | 'blocked' | 'none' =
        edge === null
          ? 'none'
          : edge.state === 'accepted'
            ? 'contact'
            : edge.state === 'pending'
              ? edge.requestedBy === caller.accountId
                ? 'requested'
                : 'incoming'
              : edge.blockedBy === caller.accountId
                ? 'blocked'
                : 'none';
      // Blocked BY them reads as no relationship, and their visibility falls
      // back to discoverability -- being blocked must not be detectable here.
      const visible =
        target !== undefined &&
        target !== null &&
        (targetId === caller.accountId ||
          relationship !== 'none' ||
          readDiscoveryMode(target.discoveryMode) === 'discoverable');
      if (!visible) {
        res.status(404).json({ error: 'Not found.' });
        return;
      }
      res.status(200).json({
        accountId: targetId,
        username: target.username ?? null,
        displayName: target.displayName ?? null,
        official: deps.officialAccounts?.has(targetId) ?? false,
        discoverable: readDiscoveryMode(target.discoveryMode) === 'discoverable',
        spokenLanguage: target.spokenLanguage ?? target.defaultLanguage ?? null,
        bio: target.bio ?? '',
        relationship,
        // Presence is a contact's privilege; a stranger's profile has none.
        ...(relationship === 'contact' && deps.presence
          ? { presence: deps.presence.stateOf(targetId, target.availability) }
          : {}),
      });
    });

    app.post('/contacts/request', (req, res) => {
      const caller = callerAccountId(req);
      if (caller === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      if (refusedForAbuse(req, res, 'contact.request', { account: caller.accountId })) return;

      const requested = (req.body as { username?: unknown } | undefined)?.username;
      if (typeof requested !== 'string') {
        res.status(404).json({ found: false });
        return;
      }
      const shape = checkUsernameShape(requested);
      if (!shape.ok) {
        res.status(404).json({ found: false });
        return;
      }

      const target = deps.store.findByUsernameKey(shape.key);
      if (!target || readDiscoveryMode(target.discoveryMode) !== 'discoverable') {
        res.status(404).json({ found: false });
        return;
      }

      void contacts
        .request(caller.accountId, target.accountId)
        .then((outcome) => {
          /*
           * A BLOCKED SENDER IS ANSWERED LIKE A SUCCESS. If they were told,
           * blocking becomes detectable, and a detectable block is a signal
           * rather than a protection -- somebody would learn exactly who has
           * shut them out and could act on it elsewhere.
           *
           * `already-requested` is answered the same way for the same reason it
           * is not an error: nothing changed, and saying so distinguishes
           * "waiting on them" from "they never saw it".
           */
          if (outcome.ok || outcome.reason === 'blocked' || outcome.reason === 'already-requested') {
            res.status(202).json({ requested: true });
            return;
          }
          if (outcome.reason === 'already-contacts') {
            res.status(409).json({ error: 'You are already contacts.' });
            return;
          }
          res.status(400).json({ error: 'That request could not be sent.' });
        })
        .catch(() => res.status(500).json({ error: 'That request could not be sent.' }));
    });

    /**
     * Mint an invite link.
     *
     * THE ONLY ROUTE TO A PRIVATE ACCOUNT, which is what every account is by
     * default. Somebody who has not opted into being findable cannot be
     * requested by username at all, so a link they issue is how they choose to
     * be reachable -- consent given in advance rather than asked for afterwards.
     *
     * THE TOKEN IS RETURNED ONCE AND NEVER AGAIN. It is not stored in plaintext,
     * so it cannot be re-read later even by its issuer: a link recoverable from
     * storage would be a standing key to somebody's contact list. The issuer
     * copies it now or mints another.
     */
    app.post('/contacts/invites', (req, res) => {
      const caller = callerAccountId(req);
      if (caller === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      if (refusedForAbuse(req, res, 'contact.invite', { account: caller.accountId })) return;

      void contacts
        .issueInvite(caller.accountId)
        .then((issued) => {
          res.status(201).json({
            inviteId: issued.invite.inviteId,
            /* Shown once. See above. */
            token: issued.token,
            expiresAtMs: issued.invite.challenge.expiresAtMs,
          });
        })
        .catch(() => res.status(500).json({ error: 'That link could not be created.' }));
    });

    /** The issuer's own live links, without their tokens. */
    app.get('/contacts/invites', (req, res) => {
      const caller = callerAccountId(req);
      if (caller === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }

      res.status(200).json({
        invites: contacts.invitesOf(caller.accountId).map((invite) => ({
          inviteId: invite.inviteId,
          expiresAtMs: invite.challenge.expiresAtMs,
          usable: contacts.usable(invite),
          revoked: invite.revokedAtMs !== null,
          /*
           * No token, ever. This endpoint exists so somebody can see which of
           * their links are still live and withdraw one -- not to recover a
           * link they failed to copy.
           */
        })),
      });
    });

    /** Withdraw an unused link. Contacts already made through it are untouched. */
    app.post('/contacts/invites/revoke', (req, res) => {
      const caller = callerAccountId(req);
      if (caller === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      const inviteId = (req.body as { inviteId?: unknown } | undefined)?.inviteId;
      if (typeof inviteId !== 'string' || inviteId.length === 0 || inviteId.length > 128) {
        res.status(400).json({ error: 'That link could not be withdrawn.' });
        return;
      }

      void contacts
        .revokeInvite(inviteId, caller.accountId)
        .then((outcome) => {
          // A missing invite and somebody else's answer identically, so this
          // cannot be used to discover which invite ids exist.
          if (!outcome.ok) {
            res.status(400).json({ error: 'That link could not be withdrawn.' });
            return;
          }
          res.status(200).json({ revoked: true });
        })
        .catch(() => res.status(500).json({ error: 'That link could not be withdrawn.' }));
    });

    /**
     * Redeem a link, becoming contacts directly.
     *
     * NO PENDING REQUEST FOLLOWS. The issuer consented by minting it and the
     * redeemer consented by using it, so there is nothing left to approve.
     *
     * ONE ANSWER FOR EVERY REFUSAL -- expired, revoked, already used, wrong
     * token, unknown id, and blocked all read the same. Telling them apart
     * tells somebody holding a guessed link which part they got right, and
     * "already used" in particular would confirm that a real link existed.
     */
    app.post('/contacts/invites/redeem', (req, res) => {
      const caller = callerAccountId(req);
      if (caller === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      if (refusedForAbuse(req, res, 'contact.request', { account: caller.accountId })) return;

      const body = req.body as { inviteId?: unknown; token?: unknown } | undefined;
      if (
        typeof body?.inviteId !== 'string' ||
        typeof body.token !== 'string' ||
        body.inviteId.length === 0 ||
        body.token.length === 0 ||
        body.token.length > 512
      ) {
        res.status(400).json({ error: 'That invite link is not valid or has expired.' });
        return;
      }

      void contacts
        .redeemInvite(body.inviteId, body.token, caller.accountId)
        .then((outcome) => {
          if (!outcome.ok) {
            res.status(400).json({ error: 'That invite link is not valid or has expired.' });
            return;
          }
          const issuer = deps.store.get(outcome.issuerAccountId);
          res.status(200).json({
            connected: true,
            contact: {
              accountId: outcome.issuerAccountId,
              username: issuer?.username ?? null,
              displayName: issuer?.displayName ?? null,
            },
          });
        })
        .catch(() => res.status(500).json({ error: 'That invite could not be redeemed.' }));
    });

    /** Accept a request somebody sent you. Only the recipient may. */
    app.post('/contacts/accept', (req, res) => {
      const caller = callerAccountId(req);
      if (caller === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      const other = parseAccountIdBody(req.body);
      if (other === null) {
        res.status(400).json({ error: 'That request could not be accepted.' });
        return;
      }

      void contacts
        .accept(caller.accountId, other)
        .then((outcome) => {
          if (outcome.ok) {
            res.status(200).json({ accepted: true });
            return;
          }
          // One answer for every refusal. Distinguishing "no such request" from
          // "not yours to accept" tells a caller which account ids have pending
          // requests, which is the graph being read by guessing.
          res.status(400).json({ error: 'That request could not be accepted.' });
        })
        .catch(() => res.status(500).json({ error: 'That request could not be accepted.' }));
    });

    /**
     * Block somebody.
     *
     * Available with no prior relationship: nobody should have to receive a
     * request before they are allowed to refuse receiving one.
     */
    app.post('/contacts/block', (req, res) => {
      const caller = callerAccountId(req);
      if (caller === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      const other = parseAccountIdBody(req.body);
      if (other === null) {
        res.status(400).json({ error: 'That block could not be applied.' });
        return;
      }

      void contacts
        .block(caller.accountId, other)
        .then((outcome) => {
          if (outcome.ok) {
            res.status(200).json({ blocked: true });
            return;
          }
          res.status(400).json({ error: 'That block could not be applied.' });
        })
        .catch(() => res.status(500).json({ error: 'That block could not be applied.' }));
    });

    /**
     * Remove a contact, or lift a block you applied.
     *
     * ONE ENDPOINT FOR BOTH because both end in the same state: no
     * relationship. Lifting a block does NOT restore the contact they used to
     * be -- somebody who blocked a contact and later relents has not thereby
     * agreed to resume, and reinstating them would decide that for them.
     */
    app.post('/contacts/remove', (req, res) => {
      const caller = callerAccountId(req);
      if (caller === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      const other = parseAccountIdBody(req.body);
      if (other === null) {
        res.status(400).json({ error: 'That could not be removed.' });
        return;
      }

      void contacts
        .remove(caller.accountId, other)
        .then((outcome) => {
          if (outcome.ok) {
            res.status(200).json({ removed: true });
            return;
          }
          // The blocked party trying to lift their own block lands here, and is
          // told nothing about why.
          res.status(400).json({ error: 'That could not be removed.' });
        })
        .catch(() => res.status(500).json({ error: 'That could not be removed.' }));
    });
  }

  app.get('/me', (req, res) => {
    const caller = callerAccountId(req);
    if (caller === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    // Both already in hand from the resolver, which loaded the record to check
    // its token version. Fetching them again was the duplication that widening
    // the caller exists to remove.
    const account = caller.record;
    const trust = caller.trust;
    const capabilities = [
      ...grantedCapabilities({ accountId: caller.accountId, trust, workspaceKind: 'personal' }),
    ];
    const personalEntitlement = entitlementForPackage({
      workspaceId: personalWorkspaceId(caller.accountId),
      packageId: 'personal',
    });
    res.status(200).json({
      accountId: caller.accountId,
      email: account.email,
      /*
       * The two identity fields, kept apart here as everywhere else. `username`
       * is what people add you by; `displayName` is what they see in a call and
       * resolves to nobody. Sending them as one object would be the first step
       * back toward treating them as one thing.
       */
      profile: {
        username: account.username ?? null,
        displayName: account.displayName ?? null,
        defaultLanguage: account.defaultLanguage ?? null,
        spokenLanguage: account.spokenLanguage ?? account.defaultLanguage ?? null,
        listeningLanguage: account.listeningLanguage ?? account.defaultLanguage ?? null,
        /** The platform's own badge; env-granted, never client-settable. */
        official: deps.officialAccounts?.has(caller.accountId) ?? false,
        /*
         * Reported as the resolved answer, not the raw stored string. A client
         * deciding for itself what counts as discoverable is a second
         * implementation of a privacy rule.
         */
        discoverable: readDiscoveryMode(account.discoveryMode) === 'discoverable',
        bio: account.bio ?? '',
        availability: account.availability ?? 'auto',
        notificationsEnabled: account.notificationsEnabled !== false,
      },
      /*
       * What this person still has to accept. Derived, never stored: publishing
       * a new policy version re-opens consent by itself, with no migration and
       * no backfill, because nothing was ever collapsed into a boolean.
       */
      outstandingConsents: outstandingConsents({
        required: deps.requiredPolicies ?? [],
        held: account.consents ?? [],
        accountId: caller.accountId,
      }),
      trust: {
        state: resolveTrustState(trust),
        email: trust.email,
        phone: trust.phone,
        identity: trust.identity,
        risk: trust.risk,
        restriction: trust.restriction,
      },
      workspaces: [
        {
          workspaceId: personalWorkspaceId(caller.accountId),
          kind: 'personal',
          displayName: 'Personal',
          // A personal workspace gets calls. Conferences and programmes belong
          // to an organization plan, and a missing entitlement is not a
          // formality to be defaulted around.
          entitlement: {
            product: personalEntitlement.product,
            enabled: personalEntitlement.enabled,
            capabilities: [...personalEntitlement.capabilities],
          },
        },
        // ONLY organizations the server confirms membership in. A switcher
        // populated from anything else is a way to ask for access you do not
        // have, and be shown the option.
        ...(deps.organizations?.organizationsFor(caller.accountId) ?? []).map((organization) => ({
          workspaceId: organizationWorkspaceId(organization.organizationId),
          kind: 'organization' as const,
          displayName: organization.displayName,
          organizationId: organization.organizationId,
          role: organization.role,
          state: organization.state,
        })),
      ],
      capabilities,
    });
  });

  if (deps.verification) {
    const verification = deps.verification;

    /**
     * The identity provider's callback. MACHINE TO MACHINE.
     *
     * POST only, authenticated by an HMAC over the RAW body, and never by a
     * session — the caller is a server, not a person. No browser can reach a
     * verification outcome through here, which is the property that makes the
     * whole identity model worth anything.
     *
     * Always answers 200 for an authenticated-but-unusable callback (duplicate,
     * stale, illegal transition). A provider that receives an error retries,
     * and retrying a callback that was correctly refused is a loop.
     */
    app.post('/provider-callbacks/identity', (req, res) => {
      const raw =
        typeof (req as { rawBody?: unknown }).rawBody === 'string'
          ? ((req as { rawBody?: string }).rawBody as string)
          : JSON.stringify(req.body ?? {});
      const signature = req.header('x-c7-signature') ?? undefined;

      void verification
        .handleIdentityCallback(raw, signature)
        .then((outcome) => {
          if (outcome.ok) {
            res.status(200).json({ received: true });
            return;
          }
          if (outcome.reason === 'bad-signature') {
            // The only reason worth an error: an unauthenticated caller should
            // be told nothing and should certainly not be retried against.
            res.status(401).json({ error: 'unauthorised' });
            return;
          }
          res.status(200).json({ received: true, applied: false });
        })
        .catch(() => res.status(500).json({ error: 'callback failed' }));
    });
  }

  /** Sign out everywhere: invalidates every token this account has been issued. */
  app.delete('/sessions', (req, res) => {
    const token = bearerToken(req.header('authorization'));
    const verified = token
      ? verifySessionToken({ secret: deps.secret, token, nowSeconds: nowSeconds() })
      : null;
    if (!verified?.ok) {
      // Signing out is idempotent and must never fail loudly: a client with a
      // token this service will not accept has already achieved the outcome.
      res.status(204).end();
      return;
    }
    void deps.store
      .signOutEverywhere(verified.claims.accountId)
      .then(() => res.status(204).end())
      .catch(() => res.status(204).end());
  });
}
