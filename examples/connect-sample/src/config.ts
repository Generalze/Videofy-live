/** @author masterzee001 */
/**
 * Environment for the sample partner server.
 *
 * Exactly three knobs, all read once at startup:
 *   VIDEOFY_API_KEY      required — the vfk_ project key minted by
 *                        `npm run connect:project:create`. Held server-side
 *                        only; it never reaches a page and is never logged.
 *   VIDEOFY_CONNECT_URL  optional — the Videofy gateway origin. The /v1 API
 *                        and the realtime endpoint share it.
 *   PORT                 optional — where this sample listens. Must match the
 *                        origin the project was provisioned with, because the
 *                        gateway authorizes browser joins by Origin.
 */

export const DEFAULT_VIDEOFY_URL = 'http://localhost:3001';
export const DEFAULT_PORT = 4173;

export interface SampleConfig {
  apiKey: string;
  videofyUrl: string;
  port: number;
}

export function readSampleConfig(env: Record<string, string | undefined>): SampleConfig {
  const apiKey = env['VIDEOFY_API_KEY']?.trim() ?? '';
  if (apiKey === '') {
    throw new Error(
      'VIDEOFY_API_KEY is not set. Provision a project first (from the repo root: ' +
        'npm run connect:project:create -- --name sample --origin http://localhost:4173) ' +
        'and export the vfk_ key it prints.',
    );
  }

  const rawUrl = env['VIDEOFY_CONNECT_URL']?.trim();
  const videofyUrl = (rawUrl === undefined || rawUrl === '' ? DEFAULT_VIDEOFY_URL : rawUrl)
    // A trailing slash would double up when the SDK appends /v1 paths.
    .replace(/\/+$/, '');

  const rawPort = env['PORT']?.trim();
  const port = rawPort === undefined || rawPort === '' ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  return { apiKey, videofyUrl, port };
}
