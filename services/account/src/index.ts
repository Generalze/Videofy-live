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
import { parseOperatorAllowlist } from '@videofy-live/billing-tariff';
import { registerSpecialistRoutes } from './specialist-routes.js';
import { registerSpecialistAdminRoutes } from './specialist-admin-routes.js';
import { SpecialistStore, createInMemorySpecialistPort } from './specialist-store.js';
import { createPostgresSpecialistPort } from './db/specialist-records-postgres.js';
import { TariffStore, createInMemoryTariffPort } from './tariff-store.js';
import { createPostgresTariffPort } from './db/tariff-records-postgres.js';
import { registerTariffRoutes } from './tariff-routes.js';
import { DeviceStore } from './device-store.js';
import { createPostgresDeviceRecords } from './db/device-records-postgres.js';
import { registerDeviceRoutes } from './device-routes.js';
import { PushDispatcher } from './push/push-dispatcher.js';
import { registerPushRoutes } from './push-routes.js';
import { MessageStore, createInMemoryMessagePort } from './message-store.js';
import { createInMemoryMessageActionPort } from './message-actions.js';
import { createPostgresMessageActions } from './db/message-actions-postgres.js';
import { RingRegistry } from './ring-registry.js';
import {
  createInMemoryConversationModePort,
} from './conversation-modes.js';
import { createPostgresConversationModes } from './db/conversation-modes-postgres.js';
import { createTextTranslator } from './translation-client.js';
import {
  createTranslationRouteRegistryFromGate,
  createTranslationRouteRegistryFromRecords,
} from './translation-route-policy.js';
import { loadTranslationRouteRegistry } from '@videofy-live/translation-routes/document-file';
import { createVoiceNoteTranslator } from './voice-note-translation-client.js';
import { registerAvatarRoutes } from './avatar-routes.js';
import {
  ChannelProfiles,
  createFileChannelImageStore,
  createInMemoryChannelProfilePort,
} from './channel-profiles.js';
import { createPostgresChannelProfiles } from './db/channel-profiles-postgres.js';
import { registerChannelRoutes } from './channel-routes.js';
import { registerC7AdvertisingRoutes } from './c7-advertising-routes.js';
import { createC7AdvertisingStore } from './db/c7-advertising-postgres.js';
import { registerVocabularyRoutes } from './vocabulary-routes.js';
import { registerVocabularyInternalRoutes } from './vocabulary-internal-routes.js';
import { registerSponsoredCreativeRoutes } from './sponsored-creative-routes.js';
import { createPostgresSponsoredCreative } from './db/programme-sponsored-creative-postgres.js';
import { createPostgresVocabulary } from './db/programme-vocabulary-postgres.js';
import {
  channelLookup,
  createShellReader,
  readConfiguredOrigin,
  registerShareRoutes,
} from './share-routes.js';
import { createInMemoryCallRecordPort } from './call-records.js';
import { createPostgresCallRecords } from './db/call-records-postgres.js';
import { registerCallHistoryRoutes } from './call-history-routes.js';
import { PresenceRegistry } from './presence.js';
import { createInMemoryChannelFollowPort } from './channel-follows.js';
import { createPostgresChannelFollows } from './db/channel-follows-postgres.js';
import { createInMemoryReportPort } from './reports.js';
import { createPostgresReports } from './db/reports-postgres.js';
import { registerSocialRoutes } from './social-routes.js';
import { createPostgresMessageRecords } from './db/message-records-postgres.js';
import { registerMessageRoutes } from './message-routes.js';
import { createFcmProviderFromEnv } from './push/fcm-provider.js';
import { resolveInternalIngressAuth } from '@videofy-live/service-env';
import { VerificationService } from './verification.js';
import { PasswordResetService } from './password-reset.js';
import { createSecurityLog } from './security-log.js';
import { MfaService, readMfaKeyring } from './mfa-service.js';
import { rejectPassword } from './password.js';
import {
  createEmailProvider,
  createIdentityProvider,
  createPhoneProvider,
  deliveryAvailable,
  describeIdentityProvider,
  describeProvider,
  identityProviderAvailable,
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

/*
 * Identity (KYC), chosen by name like every other provider.
 *
 * It used to be hard-coded synthetic, and synthetic identity is refused in
 * production -- so this service could not boot with C7_ENVIRONMENT=production
 * at all. `C7_IDENTITY_PROVIDER=off` is what closes that, and it closes it the
 * way the 30 Aug 2026 ruling requires: "a missing provider must refuse the
 * capability honestly or fail startup where the capability is mandatory --
 * NEVER a silent fall back to a synthetic/mock provider in production."
 *
 * UNSET still means synthetic, and synthetic still refuses to start in
 * production. Switching identity verification off is a sentence somebody wrote
 * into the environment file; it can never be the result of a forgotten one.
 */
const identityProvider = createIdentityProvider(process.env, environment);

// eslint-disable-next-line no-console
console.log(
  JSON.stringify({
    service: 'account',
    message: 'Verification providers selected',
    environment,
    /*
     * NAMES AND STATES ONLY -- never a key, never a sender id, never a URL
     * carrying credentials. This line is the first thing anybody reads when a
     * deployment behaves oddly, so it says exactly which provider each channel
     * got and whether that channel is offered at all.
     */
    email: describeProvider('email', emailProvider),
    phone: describeProvider('phone', phoneProvider),
    identity: describeIdentityProvider(identityProvider),
  }),
);

// Said separately and in plain words, because a channel that is switched off is
// a product fact the operator must not discover from a support ticket.
for (const [channel, offered] of [
  ['phone', deliveryAvailable(phoneProvider)],
  ['identity', identityProviderAvailable(identityProvider)],
] as const) {
  if (offered) continue;
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      service: 'account',
      message: `${channel} verification is switched OFF; its routes answer 503 and no account is marked verified through it`,
      environment,
    }),
  );
}

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

/*
 * MEDIA ROUTES PARSE THEIR OWN BODIES. Express runs parsers in mount order,
 * so a global json() mounted here consumes the body before any route-scoped
 * parser ever sees it -- which silently turned the voice-note route's 6mb
 * limit and the avatar route's 4mb limit into this 16kb one. Every real
 * voice note and every real picture died as a 413 while the tiny test bodies
 * passed. The global parser now steps aside for exactly those routes; the
 * 16kb ceiling stays the rule for every identity endpoint.
 */
const OWN_BODY_PARSER = [
  /^\/messages\/with\/[^/]+\/voice$/,
  /^\/profile\/avatar$/,
  /^\/channels\/mine\/(avatar|banner)$/,
];
const identityJson = express.json({
  limit: '16kb',
  verify: (req, _res, buffer) => {
    (req as unknown as { rawBody: string }).rawBody = buffer.toString('utf8');
  },
});
app.use((req, res, next) => {
  if (OWN_BODY_PARSER.some((route) => route.test(req.path))) {
    next();
    return;
  }
  identityJson(req, res, next);
});

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
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

/**
 * The platform's own badge. Env-driven like PLATFORM_OPERATOR_ACCOUNT_IDS:
 * a badge no route can grant is a badge no bug can grant. Empty = nobody.
 */
const officialAccounts: ReadonlySet<string> = new Set(
  (process.env['OFFICIAL_ACCOUNT_IDS'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0),
);

/*
 * PRESENCE is in memory and stays there: a restart forgets who was around,
 * which is the truth. The stores beside it are durable when a database is.
 */
const presence = new PresenceRegistry();

registerAccountRoutes(app, {
  officialAccounts,
  store,
  contacts,
  presence,
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

/*
 * PLATFORM PRICING.
 *
 * The allowlist is read ONCE, here, from the deployment. Empty is the safe
 * state and the default: with no operators configured nobody can change a
 * price, which costs an inconvenience, where the opposite default would hand
 * the price list to anyone holding a session.
 *
 * Note which store this uses. Without a database the tariff lives in memory and
 * is lost on restart -- acceptable for a local run, and the reason the seeded
 * default exists, but it means a price set on an ephemeral deployment does not
 * survive a deploy. The log below says which one is in force rather than
 * leaving that to be discovered.
 */
const platformOperators = parseOperatorAllowlist(process.env['PLATFORM_OPERATOR_ACCOUNT_IDS']);
const tariffs = new TariffStore({
  port: databasePool ? createPostgresTariffPort(databasePool) : createInMemoryTariffPort(),
});
const seededTariff = await tariffs.seedDefault(process.env['BILLING_CURRENCY'] ?? 'USD');
// eslint-disable-next-line no-console
console.log(
  JSON.stringify({
    service: 'account',
    message: 'Tariff ready',
    store: databasePool ? 'postgres' : 'ephemeral',
    seeded: seededTariff !== null,
    version: seededTariff?.version ?? (await tariffs.current())?.version ?? null,
    // A COUNT, not the ids. Naming the people who can change prices in a log
    // line is a list of who to compromise.
    platformOperators: platformOperators.size,
  }),
);
if (platformOperators.size === 0) {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      service: 'account',
      level: 'warn',
      message:
        'No platform operators configured; nobody can change pricing. Set PLATFORM_OPERATOR_ACCOUNT_IDS.',
    }),
  );
}

registerTariffRoutes(app, {
  tariffs,
  platformOperators,
  // The SAME caller resolver as every other surface, for the same reason.
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

/*
 * DEVICES. Without this a phone cannot ring: the app is backgrounded, the
 * screen is off, and a push notification addressed to a provider token is the
 * only way to reach it.
 */
const devices = new DeviceStore(
  databasePool ? { port: createPostgresDeviceRecords(databasePool) } : {},
);
const restoredDevices = await devices.hydrate();
// eslint-disable-next-line no-console
console.log(
  JSON.stringify({
    service: 'account',
    message: 'Devices restored',
    devices: restoredDevices,
    store: databasePool ? 'postgres' : 'ephemeral',
  }),
);

registerDeviceRoutes(app, {
  devices,
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

/*
 * PUSH.
 *
 * No provider is configured yet, and the dispatcher says so on every attempt
 * rather than reporting a delivery that never happened. A deployment that
 * cannot push looks exactly like one nobody happened to call -- phones simply
 * do not ring, and every service reports itself healthy. `configured` is the
 * flag to check, and the boot line below is the one that answers it.
 */
/*
 * FCM covers Android and web. iOS ringing needs a direct APNs provider with
 * PushKit -- FCM cannot send a VoIP push -- so an iPhone will show as an
 * unreachable platform in the dispatch summary until that is added, rather than
 * silently failing to ring.
 */
const pushProviders = [createFcmProviderFromEnv(process.env)].filter(
  (provider): provider is NonNullable<typeof provider> => provider !== null,
);

const push = new PushDispatcher({
  devices,
  providers: pushProviders,
  onEvent: (event, detail) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ service: 'account', event, ...detail }));
  },
});
// eslint-disable-next-line no-console
console.log(
  JSON.stringify({
    service: 'account',
    message: 'Push dispatcher ready',
    configured: push.configured,
    providers: pushProviders.map((provider) => provider.name),
    note: push.configured ? undefined : 'No push provider: phones cannot be rung.',
  }),
);

/*
 * CALL HISTORY. A finished direct call is part of the account pair's
 * relationship, like a message; the gateway reports it here over the
 * internal token and both people read it in their conversation.
 */
const callRecords = databasePool
  ? createPostgresCallRecords(databasePool)
  : createInMemoryCallRecordPort();

registerCallHistoryRoutes(app, {
  calls: callRecords,
  auth: resolveInternalIngressAuth(process.env),
  onEvent: (event, detail) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ service: 'account', event, ...detail }));
  },
});

registerPushRoutes(app, {
  push,
  auth: resolveInternalIngressAuth(process.env),
  onEvent: (event, detail) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ service: 'account', event, ...detail }));
  },
});

/*
 * MESSAGING. Lives here because its permission model IS the contact graph and
 * its delivery IS the push dispatcher -- both already in this process. Recorded
 * as a deliberate seam: if message traffic outgrows identity traffic, the
 * store and routes lift out together.
 */
/*
 * The translation route document, loaded ONCE at boot. Fail-closed by design:
 * an unreadable or invalid document produces no registry and therefore no
 * approved route, and messaging delivers originals rather than translating on
 * a document nobody could check. The log names the ORIGIN of the document and
 * how many problems it had -- never the path and never a file's contents,
 * because this service does not print env values.
 */
const routeRegistry = loadTranslationRouteRegistry();
// eslint-disable-next-line no-console
console.log(
  JSON.stringify({
    service: 'account',
    event: 'translation.routes.loaded',
    ok: routeRegistry.ok ? 1 : 0,
    routes: routeRegistry.ok ? routeRegistry.registry.routes().length : 0,
    problems: routeRegistry.ok ? 0 : routeRegistry.problems.length,
  }),
);

const messages = new MessageStore({
  port: databasePool ? createPostgresMessageRecords(databasePool) : createInMemoryMessagePort(),
  // The reader's own facts (hides, reactions, pins, mute) MUST follow the
  // records into the database: left to the store's in-memory default they
  // would vanish on every restart while every health signal said fine.
  actions: databasePool
    ? createPostgresMessageActions(databasePool)
    : createInMemoryMessageActionPort(),
});

registerMessageRoutes(app, {
  store,
  contacts,
  messages,
  push,
  calls: callRecords,
  // Ephemeral by design: see the registry's own docstring.
  rings: new RingRegistry(),
  officialAccounts,
  conversationModes: databasePool
    ? createPostgresConversationModes(databasePool)
    : createInMemoryConversationModePort(),
  /*
   * Media-ingest owns the providers; this service holds no vendor keys. An
   * unset URL or token simply means translated mode delivers originals --
   * stated in the client as "translation unavailable", never a lost message.
   */
  /*
   * WHICH ROUTES MESSAGING MAY TRANSLATE ON (founder's ruling 30 Aug 2026).
   *
   * The route registry package is authoritative for approval; the messaging
   * policy adds only the rules this service owns -- the same-language
   * bypass, OPUS-MT first, and no automatic cloud route. A document that
   * cannot be read or does not validate yields NO registry, and the
   * fail-closed empty list below approves nothing: every cross-language
   * message then goes out as written, marked honestly unavailable. That is
   * the correct behaviour when the file describing what may be translated
   * cannot be trusted -- not a reason to translate anyway.
   */
  translationRoutes: routeRegistry.ok
    ? createTranslationRouteRegistryFromGate(routeRegistry.registry)
    : createTranslationRouteRegistryFromRecords([]),
  translator: createTextTranslator({
    mediaIngestUrl: process.env['MEDIA_INGEST_URL'],
    internalToken: process.env['INTERNAL_WEBRTC_TOKEN'],
  }),
  voiceTranslator: createVoiceNoteTranslator({
    mediaIngestUrl: process.env['MEDIA_INGEST_URL'],
    internalToken: process.env['INTERNAL_WEBRTC_TOKEN'],
  }),
  mediaDir: process.env['MESSAGE_MEDIA_DIR'] ?? resolve('data', 'message-media'),
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

/*
 * THE SOCIAL SURFACE: presence, profile extras, suggestions, channel
 * follows with the live push, reports, counts. Same graph, same push
 * dispatcher, same internal seam as call history.
 */
registerSocialRoutes(app, {
  store,
  contacts,
  presence,
  follows: databasePool ? createPostgresChannelFollows(databasePool) : createInMemoryChannelFollowPort(),
  reports: databasePool ? createPostgresReports(databasePool) : createInMemoryReportPort(),
  push,
  calls: callRecords,
  messages,
  officialAccounts,
  internalAuth: resolveInternalIngressAuth(process.env),
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

/* Profile pictures. Same caller resolver, own directory. */
registerAvatarRoutes(app, {
  avatarDir: process.env['AVATAR_MEDIA_DIR'] ?? resolve('data', 'avatars'),
  callerAccountId: createCallerResolver({
    store,
    secret,
    nowSeconds: () => Math.floor(Date.now() / 1000),
  }),
});
/*
 * CHANNEL IDENTITY. Founder directive (LOCKED, 30 Aug 2026): every entitled
 * operator lands on their own persistent channel, and that identity must
 * "persist outside gateway memory". The profile rows follow the accounts
 * into Postgres; the pictures follow the avatars onto disk.
 */
const channelProfiles = new ChannelProfiles({
  port: databasePool ? createPostgresChannelProfiles(databasePool) : createInMemoryChannelProfilePort(),
  images: createFileChannelImageStore(
    process.env['CHANNEL_MEDIA_DIR'] ?? resolve('data', 'channel-media'),
  ),
});
/*
 * C7'S OWN ADVERTISING SURFACE. Internal, because these responses carry
 * advertiser names, priorities and caps -- the facts that make the platform
 * sellable and that a broadcaster reading them would make it unsellable.
 *
 * REGISTERED ONLY WITH A REAL DATABASE. Campaigns and impressions are
 * commercial records; a file-backed development store would answer "no
 * campaigns" to every decision and read exactly like a working deployment with
 * nothing sold. Absent, the routes do not exist and the decision engine is
 * told so at its own boot.
 */
if (databasePool !== null) {
  registerC7AdvertisingRoutes(app, {
    store: createC7AdvertisingStore(databasePool),
    internalAuth: resolveInternalIngressAuth(process.env),
  });
}

registerChannelRoutes(app, {
  profiles: channelProfiles,
  store,
  internalAuth: resolveInternalIngressAuth(process.env),
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

/*
 * PROGRAMME VOCABULARY, operator CRUD.
 *
 * Registered only with a database. Vocabulary that vanished on restart would be
 * worse than none: an operator would enter a presenter's name, watch it work,
 * and find it silently gone next week with no error to explain it.
 *
 * `mayAdminister` reuses the CHANNEL ownership that already exists rather than
 * inventing an admin concept. A programme is administered by whoever owns the
 * channel it belongs to, which is the answer the platform already gives to the
 * same question everywhere else.
 */
if (databasePool) {
  registerVocabularyRoutes(app, {
    vocabulary: createPostgresVocabulary(databasePool),
    callerAccountId: createCallerResolver({
      store,
      secret,
      nowSeconds: () => Math.floor(Date.now() / 1000),
    }),
    mayAdminister: async (accountId, programmeId) => {
      const owned = await channelProfiles.mine(accountId);
      return owned !== null && owned.channelId === programmeId;
    },
    onEvent: (event, detail) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ service: 'account', event, ...detail }));
    },
  });
  /*
   * AND THE MACHINE SIDE OF THE SAME AUTHORITY. Media ingest reads a resolved
   * snapshot through this, once per recognition session; without it the
   * operator's vocabulary reaches nothing.
   */
  registerVocabularyInternalRoutes(app, {
    vocabulary: createPostgresVocabulary(databasePool),
    internalAuth: resolveInternalIngressAuth(process.env),
    onEvent: (event, detail) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ service: 'account', event, ...detail }));
    },
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    service: 'account',
    message: 'Programme vocabulary routes ready',
    persistence: 'postgres',
  }));

  /*
   * THE SPONSORED CREATIVE, operator and delivery.
   *
   * Same authority as vocabulary for the operator half. The delivery half is
   * public and read-only, and its `programmeExists` is the CHANNEL PROFILE
   * lookup rather than a constant true: a house creative exists for every
   * programme, so without a real existence check any mistyped id would answer
   * with a plausible advert instead of a 404.
   */
  registerSponsoredCreativeRoutes(app, {
    creatives: createPostgresSponsoredCreative(databasePool),
    callerAccountId: createCallerResolver({
      store,
      secret,
      nowSeconds: () => Math.floor(Date.now() / 1000),
    }),
    mayAdminister: async (accountId, programmeId) => {
      const owned = await channelProfiles.mine(accountId);
      return owned !== null && owned.channelId === programmeId;
    },
    programmeExists: async (programmeId) =>
      (await channelProfiles.byId(programmeId)) !== null,
    onEvent: (event, detail) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ service: 'account', event, ...detail }));
    },
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    service: 'account',
    message: 'Sponsored creative routes ready',
    persistence: 'postgres',
  }));
} else {
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify({
    service: 'account',
    level: 'warn',
    message:
      'Programme vocabulary and the sponsored creative are UNAVAILABLE: no ' +
      'database. Neither set of routes is registered, so the console reports ' +
      'each capability as absent rather than accepting configuration it would ' +
      'lose on restart. Viewers still receive the house creative, which needs ' +
      'no storage.',
  }));
}

/*
 * THE SHARE PAGE for /streams/<handle>, server-rendered.
 *
 * FOUNDER REPORT (30 Aug 2026): "the logo preview is not on the link when the
 * preview loads." /streams/<handle> is the link the operator console's Copy,
 * Share and QR all produce, and it was served as the raw listener bundle --
 * whose head carries no Open Graph tags, so WhatsApp (which never runs
 * JavaScript) had nothing to draw a card from. The edge now sends /streams/*
 * here, rewritten to /share/streams/*, and this route injects a real head into
 * the real listener shell. See share-routes.ts for why an unknown handle is a
 * 200 rather than a 404.
 *
 * LISTENER_SHELL_PATH names the built shell. It is configurable because
 * production and staging keep their web roots apart, and the route degrades to
 * a minimal branded page rather than a 500 when the file cannot be read -- a
 * web root that has not been staged yet must not take the sharing surface down.
 */
const listenerShellPath =
  process.env['LISTENER_SHELL_PATH'] ??
  resolve(process.env['WWW_DIR'] ?? '/srv/videofy/www', 'listener-web', 'index.html');
registerShareRoutes(app, {
  channels: channelLookup(channelProfiles),
  readShell: createShellReader(listenerShellPath),
  // og:url must name the ONE address the link is shared as. Absent, the
  // request's own forwarded host is used, which is right for staging before
  // its canonical hostname is settled.
  configuredOrigin: readConfiguredOrigin(process.env['C7_PUBLIC_ORIGIN']),
  // Both Caddyfiles mount this service at /auth; the avatar URL in og:image
  // has to carry that prefix or a crawler cannot fetch the picture.
  accountBasePath: process.env['ACCOUNT_PUBLIC_BASE_PATH'] ?? '/auth',
  viewerBasePath: process.env['VIEWER_BASE_PATH'] ?? '/listen',
  onEvent: (event, detail) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ service: 'account', event, ...detail }));
  },
});
// eslint-disable-next-line no-console
console.log(
  JSON.stringify({
    service: 'account',
    message: 'Share pages ready',
    shell: listenerShellPath,
  }),
);
// eslint-disable-next-line no-console
console.log(
  JSON.stringify({
    service: 'account',
    message: 'Messaging ready',
    store: databasePool ? 'postgres' : 'ephemeral',
  }),
);

/*
 * THE LANGUAGE SPECIALIST PROGRAMME.
 *
 * Mounted here, on the account service, because a Language Specialist is a ROLE
 * ON A C7 ACCOUNT and not a separate population. A second service would mean a
 * second identity, a second session and a second place to be wrong about who is
 * calling; the caller resolver below is the same one every other route family
 * on this process uses, for the reason its own comment gives.
 *
 * The operator half reuses the platform allowlist that governs pricing. It is
 * the only privilege concept in this deployment that is not a customer role,
 * and inventing a specialist-admin role beside it would be a second door into
 * the same room.
 */
const specialists = new SpecialistStore({
  port: databasePool ? createPostgresSpecialistPort(databasePool) : createInMemorySpecialistPort(),
  onEvent: (event, detail) => {
    /*
     * IDS, LANGUAGE CODES, COUNTS AND THE CORPUS HASH. Never a source message,
     * never an English meaning, never a corrected translation, never the
     * applicant's own words about themselves. A log line is shipped, indexed
     * and retained, and it is readable by far more people than the database is;
     * a contributor's writing in one is a second copy of the corpus that
     * outlives the request that made it.
     */
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ service: 'account', event, ...detail }));
  },
});

registerSpecialistRoutes(app, {
  specialists,
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

registerSpecialistAdminRoutes(app, {
  specialists,
  callerAccountId: createCallerResolver({
    store,
    secret,
    nowSeconds: () => Math.floor(Date.now() / 1000),
  }),
  /* The SAME set that governs pricing. See platform-operator.ts. */
  platformOperators,
  onEvent: (event, detail) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ service: 'account', event, ...detail }));
  },
});

// eslint-disable-next-line no-console
console.log(
  JSON.stringify({
    service: 'account',
    message: 'Language Specialist programme ready',
    store: databasePool ? 'postgres' : 'ephemeral',
    // A COUNT, not the ids. Naming the people who can decide somebody's
    // qualification in a log line is a list of who to compromise.
    platformOperators: platformOperators.size,
  }),
);

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
