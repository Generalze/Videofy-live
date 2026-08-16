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

export interface AccountRouteDependencies {
  readonly store: AccountStore;
  readonly secret: Buffer;
  readonly nowSeconds?: () => number;
}

interface Body {
  email?: unknown;
  password?: unknown;
}

function credentials(body: unknown): { email: string; password: string } | null {
  const candidate = (body ?? {}) as Body;
  if (typeof candidate.email !== 'string' || typeof candidate.password !== 'string') return null;
  return { email: candidate.email, password: candidate.password };
}

export function registerAccountRoutes(app: express.Express, deps: AccountRouteDependencies): void {
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  const session = (accountId: string, version: number) => ({
    accountId,
    token: issueSessionToken({
      secret: deps.secret,
      accountId,
      version,
      nowSeconds: nowSeconds(),
    }),
    expiresInSeconds: SESSION_LIFETIME_SECONDS,
  });

  app.post('/accounts', (req, res) => {
    const input = credentials(req.body);
    if (!input) {
      res.status(400).json({ error: 'Enter an email address and a password.' });
      return;
    }
    void deps.store
      .register(input)
      .then((result) => {
        if (!result.ok) {
          // 409 for a taken address, 400 for anything the caller can fix by
          // typing something else.
          res.status(result.reason === 'already-exists' ? 409 : 400).json({ error: result.message });
          return;
        }
        // Signed up and signed in. Making somebody immediately repeat their
        // password to get a session serves nothing but ceremony.
        res.status(201).json(session(result.account.accountId, result.account.tokenVersion));
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
        res.status(200).json(session(result.account.accountId, result.account.tokenVersion));
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
    res.status(200).json({ accountId: account.accountId, email: account.email });
  });

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
