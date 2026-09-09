/** @author masterzee001 */
/**
 * Public build configuration compiled into the mobile bundle.
 *
 * These values are not secrets. They are plain endpoint selectors, and the
 * correct failure mode is a loud startup/build failure when one is missing
 * rather than silently aiming a production APK at staging.
 */

export type PublicAppEnvironment = 'staging' | 'production';

export interface PublicEnvInput {
  readonly EXPO_PUBLIC_APP_ENV?: string | undefined;
  readonly EXPO_PUBLIC_GATEWAY_URL?: string | undefined;
  readonly EXPO_PUBLIC_ACCOUNT_URL?: string | undefined;
  readonly EXPO_PUBLIC_INGEST_URL?: string | undefined;
  readonly EXPO_PUBLIC_LISTEN_URL?: string | undefined;
  readonly EXPO_PUBLIC_WEB_URL?: string | undefined;
  readonly EXPO_PUBLIC_CALL_DIAGNOSTICS?: string | undefined;
  readonly EXPO_PUBLIC_BUILD_LABEL?: string | undefined;
}

export interface PublicEndpoints {
  readonly appEnv: PublicAppEnvironment;
  readonly gatewayUrl: string;
  readonly accountUrl: string;
  readonly ingestUrl: string;
  readonly listenUrl: string;
  readonly webUrl: string;
  readonly callDiagnostics: boolean;
  readonly buildLabel: string;
}

type UrlKey = Exclude<
  keyof PublicEnvInput,
  'EXPO_PUBLIC_APP_ENV' | 'EXPO_PUBLIC_CALL_DIAGNOSTICS' | 'EXPO_PUBLIC_BUILD_LABEL'
>;

const URL_KEYS: readonly UrlKey[] = [
  'EXPO_PUBLIC_GATEWAY_URL',
  'EXPO_PUBLIC_ACCOUNT_URL',
  'EXPO_PUBLIC_INGEST_URL',
  'EXPO_PUBLIC_LISTEN_URL',
  'EXPO_PUBLIC_WEB_URL',
];

function required(name: keyof PublicEnvInput, value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0)
    throw new Error(
      `Missing ${name}. Mobile builds must name their public endpoint environment explicitly.`,
    );
  return trimmed.replace(/\/+$/, '');
}

function hostOf(name: UrlKey, value: string): string {
  const match = /^https:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(value);
  if (match === null) throw new Error(`${name} must be an https URL.`);
  return (match[1] ?? '').toLowerCase();
}

function appEnvironment(input: PublicEnvInput): PublicAppEnvironment {
  const value = required('EXPO_PUBLIC_APP_ENV', input.EXPO_PUBLIC_APP_ENV);
  if (value === 'staging' || value === 'production') return value;
  throw new Error('EXPO_PUBLIC_APP_ENV must be staging or production.');
}

function validateNotMixed(appEnv: PublicAppEnvironment, endpoints: Record<UrlKey, string>): void {
  for (const key of URL_KEYS) {
    const host = hostOf(key, endpoints[key]);
    if (appEnv === 'production' && host.startsWith('staging.')) {
      throw new Error(`${key} points at a staging host in a production mobile build.`);
    }
    if (appEnv === 'staging' && !host.startsWith('staging.')) {
      throw new Error(`${key} does not point at a staging host in a staging mobile build.`);
    }
  }
}

export function resolvePublicEnv(input: PublicEnvInput): PublicEndpoints {
  const appEnv = appEnvironment(input);
  const endpoints: Record<UrlKey, string> = {
    EXPO_PUBLIC_GATEWAY_URL: required('EXPO_PUBLIC_GATEWAY_URL', input.EXPO_PUBLIC_GATEWAY_URL),
    EXPO_PUBLIC_ACCOUNT_URL: required('EXPO_PUBLIC_ACCOUNT_URL', input.EXPO_PUBLIC_ACCOUNT_URL),
    EXPO_PUBLIC_INGEST_URL: required('EXPO_PUBLIC_INGEST_URL', input.EXPO_PUBLIC_INGEST_URL),
    EXPO_PUBLIC_LISTEN_URL: required('EXPO_PUBLIC_LISTEN_URL', input.EXPO_PUBLIC_LISTEN_URL),
    EXPO_PUBLIC_WEB_URL: required('EXPO_PUBLIC_WEB_URL', input.EXPO_PUBLIC_WEB_URL),
  };
  validateNotMixed(appEnv, endpoints);
  return {
    appEnv,
    gatewayUrl: endpoints.EXPO_PUBLIC_GATEWAY_URL,
    accountUrl: endpoints.EXPO_PUBLIC_ACCOUNT_URL,
    ingestUrl: endpoints.EXPO_PUBLIC_INGEST_URL,
    listenUrl: endpoints.EXPO_PUBLIC_LISTEN_URL,
    webUrl: endpoints.EXPO_PUBLIC_WEB_URL,
    callDiagnostics: input.EXPO_PUBLIC_CALL_DIAGNOSTICS === '1',
    buildLabel: (input.EXPO_PUBLIC_BUILD_LABEL ?? '').trim().slice(0, 80),
  };
}

export const PUBLIC_ENDPOINTS = resolvePublicEnv({
  EXPO_PUBLIC_APP_ENV: process.env['EXPO_PUBLIC_APP_ENV'],
  EXPO_PUBLIC_GATEWAY_URL: process.env['EXPO_PUBLIC_GATEWAY_URL'],
  EXPO_PUBLIC_ACCOUNT_URL: process.env['EXPO_PUBLIC_ACCOUNT_URL'],
  EXPO_PUBLIC_INGEST_URL: process.env['EXPO_PUBLIC_INGEST_URL'],
  EXPO_PUBLIC_LISTEN_URL: process.env['EXPO_PUBLIC_LISTEN_URL'],
  EXPO_PUBLIC_WEB_URL: process.env['EXPO_PUBLIC_WEB_URL'],
  EXPO_PUBLIC_CALL_DIAGNOSTICS: process.env['EXPO_PUBLIC_CALL_DIAGNOSTICS'],
  EXPO_PUBLIC_BUILD_LABEL: process.env['EXPO_PUBLIC_BUILD_LABEL'],
});

export const CALL_DIAGNOSTICS_ENABLED = PUBLIC_ENDPOINTS.callDiagnostics;
