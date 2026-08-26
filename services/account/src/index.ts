/** @author masterzee001 */
/**
 * The Videofy account service.
 *
 * It exists so that "whose voice is this" has an answer that belongs to a
 * person rather than to a browser profile. Everything it issues is a signed
 * session token that other services verify locally, so a call cannot become
 * unjoinable because sign-in is restarting.
 */
// FIRST import: loads .env before any module below reads process.env.
import '@videofy-live/service-env/auto';
import express from 'express';
import { resolve } from 'node:path';
import { requireSessionSecret } from '@videofy-live/account-tokens';
import { AccountStore } from './account-store.js';
import type { Pool } from 'pg';
import { createFileAccountRecords } from './account-records.js';
import { assertDatabaseReachable, createDatabasePool, requireDatabaseUrl } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { createPostgresAccountRecords } from './db/account-records-postgres.js';
import {
  createEphemeralOrganizationRecords,
  createPostgresOrganizationRecords,
} from './db/organization-records-postgres.js';
import { IdentityChangeService } from './identity-change-service.js';
import { createCallerResolver, registerAccountRoutes } from './routes.js';
import { CORRELATION_HEADER, correlationMiddleware } from './request-context.js';
import { ContactStore, createEphemeralContactRecords } from './contact-store.js';
import { createPostgresContactRecords } from './db/contact-records-postgres.js';
import { OrganizationStore } from './organization-store.js';
import { registerOrganizationRoutes } from './organization-routes.js';
import { VerificationService } from './verification.js';
import { PasswordResetService } from './password-reset.js';
import { createSecurityLog } from './security-log.js';
import { MfaService, readMfaKeyring } from './mfa-service.js';
import { rejectPassword } from './password.js';
import {
  assertIdentityProviderAllowed,
  createEmailProvider,
  createPhoneProvider,
  createSyntheticIdentityProvider,
  describeProvider,
  RECOVERY_PEPPER_MIN_LENGTH,
  createMemoryAbuseLimiter,
  readEnvironment,
  type PolicyRequirement,
} from '@videofy-live/account-trust';

const port = Number(process.env['ACCOUNT_PORT'] ?? 3006);

// Fail closed. A service that invented its own secret would sign tokens every
// other service rejects, and a default baked into the repository is a key that
// every deployment in the world shares.
const secret = requireSessionSecret(process.env['VIDEOFY_AUTH_SECRET'], 'VIDEOFY_AUTH_SECRET');

/**
 * Verification delivery.
 *
 * FAIL CLOSED: `assertProviderAllowed` throws at startup if a synthetic
 * provider is configured while the environment is production. Deliberately a
 * boot-time refusal rather than a check at send time -- discovering it on the
 * first real signup means the service already started, already looked healthy,
 * and already told somebody their account was created.
 *
 * There is no real email or SMS vendor wired yet. When one is chosen it
 * implements the same interface and this is the only place that changes.
 */
const environment = readEnvironment(process.env['C7_ENVIRONMENT']);

/*
 * Provider selection throws on anything ambiguous: an unrecognised name, a
 * missing credential, or synthetic in production. Every one of those would
 * otherwise end the same way -- a system that believes it verified somebody.
 */
const emailProvider = createEmailProvider(process.env, environment);
const phoneProvider = createPhoneProvider(process.env, environment);

// Identity stays synthetic deliberately: real KYC waits on a chosen provider
// AND approved legal/policy content, and is refused in production until then.
const identityProvider = createSyntheticIdentityProvider();
assertIdentityProviderAllowed(identityProvider, environment);

// eslint-disable-next-line no-console
console.log(
  JSON.stringify({
    service: 'account',
    message: 'Verification providers selected',
    environment,
    email: describeProvider('email', emailProvider),
    phone: describeProvider('phone', phoneProvider),
    identity: { provider: identityProvider.name, synthetic: identityProvider.synthetic },
  }),
);

/*
 * The secret the identity provider signs its callbacks with.
 *
 * Absent, the callback route refuses everything rather than accepting unsigned
 * results -- an unauthenticated endpoint that can mark accounts verified is the
 * entire attack this design exists to prevent.
 */
const identityCallbackSecret = process.env['C7_IDENTITY_CALLBACK_SECRET'];

const app = express();
/*
 * The raw body is captured because the identity callback's signature covers the
 * exact bytes the provider sent. Re-serialising a parsed object produces
 * different bytes -- different key order, different spacing -- and a signature
 * that can never match.
 */
/*
 * Correlation first, before body parsing and before the routes.
 *
 * A request that is rejected by the body parser -- oversized, malformed -- is
 * still a request worth being able to find later, and a flood of them is
 * itself a signal. Registered after the parser, those would be the only
 * requests with no id, which is precisely backwards.
 */
app.use(correlationMiddleware());

app.use(
  express.json({
    limit: '16kb',
    verify: (req, _res, buffer) => {
      (req as unknown as { rawBody: string }).rawBody = buffer.toString('utf8');
    },
  }),
);

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  // Without this a browser cannot READ the correlation id off the response, so
  // somebody reporting a problem has no id to quote and the whole point of
  // echoing it is lost.
  res.setHeader('Access-Control-Expose-Headers', CORRELATION_HEADER);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

/*
 * WHERE ACCOUNTS LIVE, chosen explicitly rather than inferred.
 *
 * The same shape as the verification providers above: a named selector, an
 * unrecognised value refuses to start, and the prototype option is REFUSED in
 * production. Inferring the store from whether DATABASE_URL happens to be set
 * would mean a missing variable silently downgrades a production service to a
 * JSON file, which is exactly the kind of quiet fallback this file exists to
 * prevent everywhere else.
 *
 * `file` is a development prototype. Its own header says so, and it rewrites
 * every account on every write.
 */
const accountStoreKind = (process.env['C7_ACCOUNT_STORE'] ?? 'file').trim().toLowerCase();
if (accountStoreKind !== 'file' && accountStoreKind !== 'postgres') {
  throw new Error(
    `C7_ACCOUNT_STORE="${accountStoreKind}" is not a store. Use "file" or "postgres".`,
  );
}
if (accountStoreKind === 'file' && environment === 'production') {
  throw new Error(
    'C7_ACCOUNT_STORE=file is a development prototype and is refused in production. ' +
      'It keeps password hashes unencrypted in a JSON file and rewrites every account on ' +
      'every write. Set C7_ACCOUNT_STORE=postgres and DATABASE_URL.',
  );
}

let databasePool: Pool | null = null;
let records;
if (accountStoreKind === 'postgres') {
  databasePool = createDatabasePool({
    connectionString: requireDatabaseUrl(process.env['DATABASE_URL'], 'DATABASE_URL'),
  });
  // Creating a pool connects to nothing, so a wrong host or password would stay
  // invisible until somebody's first sign-in. Prove it now.
  await assertDatabaseReachable(databasePool);
  const outcome = await migrate(databasePool);
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      service: 'account',
      message: 'Schema migrations',
      applied: outcome.applied,
      alreadyApplied: outcome.alreadyApplied.length,
    }),
  );
  records = createPostgresAccountRecords(databasePool);
} else {
  records = createFileAccountRecords(resolve(process.cwd(), '../../voice-enrollment/accounts.json'));
}

const store = new AccountStore(records);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'account', timestamp: new Date().toISOString() });
});

/*
 * Organizations get the same store as accounts, or the same ephemeral default.
 *
 * Until this line existed, organizations had NO persistence whatsoever -- three
 * in-memory Maps, destroyed by every restart and every deploy.
 */
const organizations = new OrganizationStore(
  () => Date.now(),
  databasePool
    ? createPostgresOrganizationRecords(databasePool)
    : createEphemeralOrganizationRecords(),
);
const restored = await organizations.hydrate();
// eslint-disable-next-line no-console
console.log(
  JSON.stringify({ service: 'account', message: 'Organizations restored', ...restored }),
);

/*
 * Required policy versions, from configuration.
 *
 * EMPTY BY DEFAULT and honestly so: consent cannot be demanded until approved
 * policy CONTENT exists to consent to. Setting a version before the document is
 * written would collect agreement to nothing, which is worse than collecting
 * none -- it produces records that look like evidence and are not.
 *
 * Format: "terms-of-service:2026-01-15,privacy-policy:2026-01-15"
 */
const requiredPolicies = (process.env['C7_REQUIRED_POLICIES'] ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0)
  .map((entry) => {
    const [policyType, requiredVersion] = entry.split(':');
    if (!policyType || !requiredVersion) {
      // A malformed entry must not silently become "nothing required". Refusing
      // at boot is the only moment somebody is looking.
      throw new Error(
        `C7_REQUIRED_POLICIES entry "${entry}" is not policyType:version. ` +
          'A malformed entry would silently require nothing.',
      );
    }
    return { policyType, requiredVersion } as PolicyRequirement;
  });

/*
 * The abuse limiter, and an honest note about what it is.
 *
 * IN MEMORY, so behind more than one instance an attacker gets the limit
 * multiplied by the instance count. This deployment runs one instance, which
 * makes it correct today and makes it the first thing to replace when that
 * stops being true -- the port exists so the replacement is a different
 * implementation rather than a different call site.
 */
const abuse = createMemoryAbuseLimiter();

/*
 * Salt for hashing addresses in security events, so velocity per address is
 * countable without the address being retained.
 *
 * ABSENT MEANS ADDRESSES ARE OMITTED, never logged in the clear as a fallback.
 * A log of who signs up is a record of who uses this product, and it is read by
 * far more people than can read the database.
 */
const targetSalt = process.env['C7_SECURITY_TARGET_SALT'];
if (targetSalt !== undefined && targetSalt.trim().length < 16) {
  throw new Error(
    'C7_SECURITY_TARGET_SALT must be at least 16 characters, or unset. ' +
      'A short salt on a digest of an email address is reversible by anybody ' +
      'holding a list of email addresses, which is everybody.',
  );
}

const security = createSecurityLog(targetSalt ? { targetSalt } : {});

/*
 * MFA, which exists only if a keyring and a recovery pepper are BOTH configured.
 *
 * Half-configured resolves to ABSENT rather than to a partly-working factor.
 * Enrolling somebody against a keyring that cannot be rotated, or storing
 * recovery hashes under a pepper that was never set, produces an account whose
 * second factor is unusable in a way nobody discovers until they need it.
 *
 * Absent means the routes 404. That is honest -- the feature is not configured
 * -- and it is safe, because nothing else depends on MFA existing.
 */
const mfaKeyring = readMfaKeyring(process.env['C7_MFA_KEYRING']);
const recoveryPepper = process.env['C7_MFA_RECOVERY_PEPPER']?.trim();
if (mfaKeyring && (!recoveryPepper || recoveryPepper.length < RECOVERY_PEPPER_MIN_LENGTH)) {
  throw new Error(
    `C7_MFA_KEYRING is set but C7_MFA_RECOVERY_PEPPER is missing or shorter than ` +
      `${RECOVERY_PEPPER_MIN_LENGTH} characters. Recovery codes carry about 33 bits of ` +
      'entropy: hashed without a real pepper, a stolen table is an offline brute force.',
  );
}
const mfa =
  mfaKeyring && recoveryPepper
    ? new MfaService({ store, keyring: mfaKeyring, recoveryPepper })
    : undefined;

// eslint-disable-next-line no-console
console.log(
  JSON.stringify({
    service: 'account',
    message: 'Second factor',
    configured: mfa !== undefined,
    ...(mfaKeyring ? { keys: mfaKeyring.keyIds.length, currentKey: mfaKeyring.currentKeyId } : {}),
  }),
);

/*
 * The contact graph.
 *
 * DURABLE WHEN A DATABASE IS CONFIGURED, and the reason is a security property
 * rather than convenience: this graph is what gates personal calls and
 * messages. Held only in memory it empties on every deploy, and an empty graph
 * does not fail closed -- it loses every connection people made and discards
 * the consent each one represented.
 *
 * Ephemeral remains the fallback for a deployment with no database, which is
 * what tests and a bare local run want, and what production must never be.
 */
const contacts = new ContactStore(
  () => Date.now(),
  databasePool ? createPostgresContactRecords(databasePool) : createEphemeralContactRecords(),
);
const restoredContacts = await contacts.hydrate();
// eslint-disable-next-line no-console
console.log(
  JSON.stringify({
    service: 'account',
    message: 'Contacts restored',
    contacts: restoredContacts,
    store: databasePool ? 'postgres' : 'ephemeral',
  }),
);

registerAccountRoutes(app, {
  store,
  contacts,
  secret,
  organizations,
  abuse,
  security,
  ...(mfa ? { mfa } : {}),
  /*
   * Changing a verified address needs a second factor to step up against, so
   * this is wired only when MFA is. Offered without it, the flow would demand a
   * step-up that no account could ever satisfy -- an endpoint that exists and
   * always refuses, which reads as a bug rather than as the deliberate absence
   * of a prerequisite.
   */
  ...(mfa
    ? {
        identityChange: new IdentityChangeService({
          store,
          emailProvider,
          phoneProvider,
          mfa,
          security,
          ...(targetSalt ? { targetSalt } : {}),
        }),
      }
    : {}),
  ...(targetSalt ? { targetSalt } : {}),
  passwordReset: new PasswordResetService({
    store,
    emailProvider,
    rejectPassword,
    onEvent: (event, detail) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ service: 'account', message: event, ...detail }));
    },
  }),
  requiredPolicies,
  verification: new VerificationService({
    store,
    emailProvider,
    phoneProvider,
    identityProvider,
    ...(identityCallbackSecret ? { identityCallbackSecret } : {}),
    // Event names and channels only. A verification log must never become a
    // record of which addresses exist, nor a place a token can be recovered.
    onEvent: (event, detail) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ service: 'account', event, ...detail }));
    },
  }),
});

registerOrganizationRoutes(app, {
  store,
  organizations,
  // The SAME caller resolver the account routes use. Two ways of deciding who
  // is calling is two chances to disagree, and the disagreement is a bypass.
  callerAccountId: createCallerResolver({
    store,
    secret,
    nowSeconds: () => Math.floor(Date.now() / 1000),
  }),
  onEvent: (event, detail) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ service: 'account', event, ...detail }));
  },
});

const accounts = await store.hydrate();
// A count, never an address. A log of who has an account is a record of who
// uses this product.
// eslint-disable-next-line no-console
console.log(
  JSON.stringify({ service: 'account', message: 'Accounts restored', accounts, store: accountStoreKind }),
);

// Loopback by default. The account service is reached through the reverse
// proxy, so binding every interface only widens what can be reached
// directly if a firewall rule is ever wrong.
// 127.0.0.1, NOT 'localhost'. On a dual-stack host 'localhost' can
// resolve to ::1 first, and Node then binds ONLY IPv6 loopback -- every
// client connecting to 127.0.0.1 gets connection refused while the
// service looks perfectly healthy in its own logs. Proven on the staging
// box: `listen(port, 'localhost')` produced a [::1]-only listener.
const host = process.env['ACCOUNT_HOST'] ?? '127.0.0.1';

app.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ service: 'account', message: 'Account service started', port }));
});
