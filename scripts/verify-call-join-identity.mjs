// Videofy Live - does the RUNNING gateway derive voice identity from a token?
//
// Everything else about account identity has been proved against stores and
// contracts. This proves it against the live socket, because the gateway is the
// one place that decides who a speaker is, and a gateway started without
// VIDEOFY_AUTH_SECRET refuses everybody silently — every call would use a
// standard voice and nothing would say why.
//
// The two cases are deliberately compared, because they fail identically to a
// casual look:
//
//   valid token  -> accepted, no rejection flag
//   forged token -> joined anyway, rejection flag set
//
// A gateway with no verifier rejects BOTH, which is exactly the failure this
// exists to catch before somebody spends an afternoon in browsers.
//
// Usage:
//   node scripts/verify-call-join-identity.mjs
import { io } from 'socket.io-client';

const GATEWAY = process.env['GATEWAY_URL'] ?? 'http://localhost:3001';
const ACCOUNTS = process.env['ACCOUNT_URL'] ?? 'http://localhost:3006';
const PASSWORD = 'call join identity passphrase';

async function register() {
  const response = await fetch(`${ACCOUNTS}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `join-${Date.now().toString(36)}@videofy.local`,
      password: PASSWORD,
      voiceGender: 'male',
    }),
  });
  if (response.status !== 201) throw new Error(`account creation failed: ${response.status}`);
  return response.json();
}

function join(payload) {
  return new Promise((resolve, reject) => {
    const socket = io(GATEWAY, { query: { role: 'call-participant' }, transports: ['websocket'] });
    const done = (value) => {
      socket.close();
      resolve(value);
    };
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('join timed out'));
    }, 15_000);
    socket.on('connect', () => {
      socket.emit('call:join', payload, (ack) => {
        clearTimeout(timer);
        done(ack);
      });
    });
    socket.on('connect_error', (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
  });
}

function payloadFor(callId, displayName, sessionToken) {
  return {
    callId,
    displayName,
    speakLanguage: 'en',
    hearLanguage: 'en',
    captionsEnabled: true,
    voiceGender: 'male',
    audioMode: 'translated',
    ...(sessionToken ? { sessionToken } : {}),
  };
}

const account = await register();
const stamp = Date.now().toString(36);

const withValid = await join(payloadFor(`join-ok-${stamp}`, 'Valid', account.token));
const withForged = await join(payloadFor(`join-bad-${stamp}`, 'Forged', 'not.a-real-signature'));
const anonymous = await join(payloadFor(`join-anon-${stamp}`, 'Anonymous'));
// The original hole: a client naming an account it never proved it owns.
const asserted = await join({
  ...payloadFor(`join-claim-${stamp}`, 'Claimer'),
  voiceOwnerId: account.accountId,
});

console.log('\n=== CALL JOIN IDENTITY (live gateway) ===');
console.log(`  valid token   ok=${withValid.ok} rejected=${withValid.voiceIdentityRejected ?? false}`);
console.log(`  forged token  ok=${withForged.ok} rejected=${withForged.voiceIdentityRejected ?? false}`);
console.log(`  anonymous     ok=${anonymous.ok} rejected=${anonymous.voiceIdentityRejected ?? false}`);
console.log(`  claimed owner ok=${asserted.ok} rejected=${asserted.voiceIdentityRejected ?? false}`);

const checks = [
  ['A valid session token is ACCEPTED', withValid.ok === true && !withValid.voiceIdentityRejected],
  ['A forged token still joins the call', withForged.ok === true],
  ['A forged token gets NO voice identity', withForged.voiceIdentityRejected === true],
  ['An anonymous join succeeds', anonymous.ok === true],
  ['An anonymous join claims no identity', !anonymous.voiceIdentityRejected],
  ['Naming an account without proof grants nothing', asserted.ok === true && !asserted.voiceIdentityRejected],
  ['No ack leaks an account id', ![withValid, withForged, anonymous, asserted].some((ack) => JSON.stringify(ack).includes('acct_'))],
];

console.log('');
for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
const passed = checks.filter(([, ok]) => ok).length;
console.log(`Summary: ${passed}/${checks.length} passed`);

if (withValid.voiceIdentityRejected === true) {
  console.log(
    '\nThe gateway rejected a VALID token. It is almost certainly running without\n' +
      'VIDEOFY_AUTH_SECRET, in which case no call can ever use a personal voice.\n' +
      'Restart the gateway so it picks up .env.',
  );
}

process.exit(passed === checks.length ? 0 : 1);
