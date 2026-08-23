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
import type { AccountStore } from './account-store.js';
import type { VerificationService } from './verification.js';
import { resolveTrustState } from '@videofy-live/account-trust';
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
export function createCallerResolver(deps: {
  store: AccountStore;
  secret: Buffer;
  nowSeconds: () => number;
}) {
  return (req: express.Request): string | null => {
    const token = bearerToken(req.header('authorization'));
    if (!token) return null;
    const verified = verifySessionToken({
      secret: deps.secret,
      token,
      nowSeconds: deps.nowSeconds(),
    });
    if (!verified.ok) return null;
    const account = deps.store.get(verified.claims.accountId);
    if (!account || account.tokenVersion !== verified.claims.version) return null;
    return account.accountId;
  };
}

export function registerAccountRoutes(app: express.Express, deps: AccountRouteDependencies): void {
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

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
      const accountId = callerAccountId(req);
      if (accountId === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      res.status(200).json(verification.status(accountId));
    });

    app.post('/verification/email', (req, res) => {
      const accountId = callerAccountId(req);
      if (accountId === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      void verification
        .requestEmailVerification(accountId)
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
      const accountId = callerAccountId(req);
      if (accountId === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      const token = (req.body as { token?: unknown } | undefined)?.token;
      if (typeof token !== 'string' || token.length === 0 || token.length > 512) {
        res.status(400).json({ error: 'That verification link is not valid.' });
        return;
      }
      void verification
        .confirmEmail(accountId, token)
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
      const accountId = callerAccountId(req);
      if (accountId === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      const phone = (req.body as { phone?: unknown } | undefined)?.phone;
      if (typeof phone !== 'string' || phone.length > 32) {
        res.status(400).json({ error: 'Enter a phone number in international format.' });
        return;
      }
      void verification
        .requestPhoneVerification(accountId, phone)
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
      const accountId = callerAccountId(req);
      if (accountId === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      void verification
        .startIdentityVerification(accountId)
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
      const accountId = callerAccountId(req);
      if (accountId === null) {
        res.status(401).json({ error: 'Sign in to continue.' });
        return;
      }
      const code = (req.body as { code?: unknown } | undefined)?.code;
      if (typeof code !== 'string' || !/^\d{4,8}$/.test(code)) {
        res.status(400).json({ error: 'Enter the code we sent you.' });
        return;
      }
      void verification
        .confirmPhone(accountId, code)
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
  app.get('/me', (req, res) => {
    const accountId = callerAccountId(req);
    if (accountId === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    const account = deps.store.get(accountId);
    if (!account) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    const trust = deps.store.trustOf(accountId);
    const capabilities = [
      ...grantedCapabilities({ accountId, trust, workspaceKind: 'personal' }),
    ];
    const personalEntitlement = entitlementForPackage({
      workspaceId: personalWorkspaceId(accountId),
      packageId: 'personal',
    });
    res.status(200).json({
      accountId,
      email: account.email,
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
          workspaceId: personalWorkspaceId(accountId),
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
        ...(deps.organizations?.organizationsFor(accountId) ?? []).map((organization) => ({
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
