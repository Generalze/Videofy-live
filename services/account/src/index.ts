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
import { createFileAccountRecords } from './account-records.js';
import { createCallerResolver, registerAccountRoutes } from './routes.js';
import { OrganizationStore } from './organization-store.js';
import { registerOrganizationRoutes } from './organization-routes.js';
import { VerificationService } from './verification.js';
import {
  assertIdentityProviderAllowed,
  createEmailProvider,
  createPhoneProvider,
  createSyntheticIdentityProvider,
  describeProvider,
  readEnvironment,
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
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

const store = new AccountStore(
  createFileAccountRecords(resolve(process.cwd(), '../../voice-enrollment/accounts.json')),
);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'account', timestamp: new Date().toISOString() });
});

const organizations = new OrganizationStore();

registerAccountRoutes(app, {
  store,
  secret,
  organizations,
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
console.log(JSON.stringify({ service: 'account', message: 'Accounts restored', accounts }));

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
