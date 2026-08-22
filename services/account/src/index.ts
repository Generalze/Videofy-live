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
import { registerAccountRoutes } from './routes.js';

const port = Number(process.env['ACCOUNT_PORT'] ?? 3006);

// Fail closed. A service that invented its own secret would sign tokens every
// other service rejects, and a default baked into the repository is a key that
// every deployment in the world shares.
const secret = requireSessionSecret(process.env['VIDEOFY_AUTH_SECRET'], 'VIDEOFY_AUTH_SECRET');

const app = express();
app.use(express.json({ limit: '16kb' }));

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

registerAccountRoutes(app, { store, secret });

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
