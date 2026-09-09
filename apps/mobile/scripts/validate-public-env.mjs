/** @author masterzee001 */
const REQUIRED = [
  'EXPO_PUBLIC_APP_ENV',
  'EXPO_PUBLIC_GATEWAY_URL',
  'EXPO_PUBLIC_ACCOUNT_URL',
  'EXPO_PUBLIC_INGEST_URL',
  'EXPO_PUBLIC_LISTEN_URL',
  'EXPO_PUBLIC_WEB_URL',
];

const EXPECTED = {
  development: {
    EXPO_PUBLIC_APP_ENV: 'staging',
    EXPO_PUBLIC_GATEWAY_URL: 'https://staging.consummate7.com',
    EXPO_PUBLIC_ACCOUNT_URL: 'https://staging.consummate7.com/auth',
    EXPO_PUBLIC_INGEST_URL: 'https://staging.consummate7.com/media',
    EXPO_PUBLIC_LISTEN_URL: 'https://staging.consummate7.com/listen',
    EXPO_PUBLIC_WEB_URL: 'https://staging.consummate7.com',
    EXPO_PUBLIC_CALL_DIAGNOSTICS: '1',
  },
  preview: {
    EXPO_PUBLIC_APP_ENV: 'staging',
    EXPO_PUBLIC_GATEWAY_URL: 'https://staging.consummate7.com',
    EXPO_PUBLIC_ACCOUNT_URL: 'https://staging.consummate7.com/auth',
    EXPO_PUBLIC_INGEST_URL: 'https://staging.consummate7.com/media',
    EXPO_PUBLIC_LISTEN_URL: 'https://staging.consummate7.com/listen',
    EXPO_PUBLIC_WEB_URL: 'https://staging.consummate7.com',
  },
  'production-apk': {
    EXPO_PUBLIC_APP_ENV: 'production',
    EXPO_PUBLIC_GATEWAY_URL: 'https://consummate7.com',
    EXPO_PUBLIC_ACCOUNT_URL: 'https://consummate7.com/auth',
    EXPO_PUBLIC_INGEST_URL: 'https://consummate7.com/media',
    EXPO_PUBLIC_LISTEN_URL: 'https://consummate7.com/listen',
    EXPO_PUBLIC_WEB_URL: 'https://consummate7.com',
  },
  production: {
    EXPO_PUBLIC_APP_ENV: 'production',
    EXPO_PUBLIC_GATEWAY_URL: 'https://consummate7.com',
    EXPO_PUBLIC_ACCOUNT_URL: 'https://consummate7.com/auth',
    EXPO_PUBLIC_INGEST_URL: 'https://consummate7.com/media',
    EXPO_PUBLIC_LISTEN_URL: 'https://consummate7.com/listen',
    EXPO_PUBLIC_WEB_URL: 'https://consummate7.com',
  },
  'production-diagnostic': {
    EXPO_PUBLIC_APP_ENV: 'production',
    EXPO_PUBLIC_GATEWAY_URL: 'https://consummate7.com',
    EXPO_PUBLIC_ACCOUNT_URL: 'https://consummate7.com/auth',
    EXPO_PUBLIC_INGEST_URL: 'https://consummate7.com/media',
    EXPO_PUBLIC_LISTEN_URL: 'https://consummate7.com/listen',
    EXPO_PUBLIC_WEB_URL: 'https://consummate7.com',
    EXPO_PUBLIC_CALL_DIAGNOSTICS: '1',
    EXPO_PUBLIC_BUILD_LABEL: 'calldiag-v2-20260908',
  },
};

function profileArg() {
  const index = process.argv.indexOf('--profile');
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message) {
  console.error(`mobile public env invalid: ${message}`);
  process.exitCode = 1;
}

const profile =
  process.env.EAS_BUILD_PROFILE || profileArg() || process.env.EXPO_PUBLIC_BUILD_PROFILE || '';
for (const key of REQUIRED) {
  if ((process.env[key] ?? '').trim().length === 0) fail(`${key} is required`);
}
if (process.exitCode !== undefined) process.exit();

const expected = EXPECTED[profile];
if (expected !== undefined) {
  for (const [key, value] of Object.entries(expected)) {
    if ((process.env[key] ?? '').trim() !== value) {
      fail(`${profile} expected ${key}=${value}, got ${process.env[key] ?? '<unset>'}`);
    }
  }
  if (
    profile !== 'development' &&
    profile !== 'production-diagnostic' &&
    process.env.EXPO_PUBLIC_CALL_DIAGNOSTICS === '1'
  ) {
    fail(`${profile} must not enable EXPO_PUBLIC_CALL_DIAGNOSTICS`);
  }
}

if (process.env.EXPO_PUBLIC_APP_ENV === 'production') {
  for (const key of REQUIRED.filter((candidate) => candidate.endsWith('_URL'))) {
    let host = '';
    try {
      host = new URL(process.env[key]).hostname.toLowerCase();
    } catch {
      fail(`${key} must be a valid URL`);
      continue;
    }
    if (host.startsWith('staging.')) fail(`${key} points at staging in production`);
  }
}

if (process.exitCode === undefined) {
  console.log(`mobile public env valid${profile ? ` for ${profile}` : ''}`);
}
