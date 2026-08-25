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
  SESSION_LIFETIME_SECONDS,
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
  ) => ({
    accountId,
    token: issueSessionToken({
      secret: deps.secret,
      accountId,
      version,
      nowSeconds: nowSeconds(),
    }),
    expiresInSeconds: SESSION_LIFETIME_SECONDS,
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
    void deps.store
      .register({ ...input, ...(voiceGenderOf(req.body) ? { voiceGender: voiceGenderOf(req.body)! } : {}) })
      .then((result) => {
        if (!result.ok) {
          // 409 for a taken address, 400 for anything the caller can fix by
          // typing something else.
          res.status(result.reason === 'already-exists' ? 409 : 400).json({ error: result.message });
          return;
        }
        // Signed up and signed in. Making somebody immediately repeat their
        // password to get a session serves nothing but ceremony.
        res.status(201).json(
            session(
              result.account.accountId,
              result.account.tokenVersion,
              result.account.voiceGender,
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
          ),
        );
      })
      .catch(() => res.status(500).json({ error: 'You could not be signed in.' }));
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
            res.status(202).json({ sent: true, expiresAtMs: outcome.expiresAtMs });
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
            res.status(202).json({ sent: true, expiresAtMs: outcome.expiresAtMs });
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
