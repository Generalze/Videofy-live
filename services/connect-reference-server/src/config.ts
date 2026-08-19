/** @author masterzee001 */
/**
 * Environment for the Connect Reference server. Four knobs, read once at boot:
 *
 *   VIDEOFY_API_KEY      required — the vfk_ project key. Held server-side
 *                        only; it never reaches a browser and is never logged.
 *   VIDEOFY_CONNECT_URL  optional — origin of the Videofy Connect API
 *                        (default http://localhost:3001).
 *   REF_ROOMS_PATH        optional — where the durable room registry lives
 *                        (default ./connect-reference-rooms.json, resolved
 *                        against the process working directory; prefer an
 *                        ABSOLUTE path so restarts from a different directory
 *                        keep finding the same rooms).
 *   PORT                 optional — where this server listens (default 8790).
 */

export const DEFAULT_CONNECT_URL = 'http://localhost:3001';
export const DEFAULT_PORT = 8790;
export const DEFAULT_ROOMS_PATH = './connect-reference-rooms.json';

export interface ReferenceConfig {
  apiKey: string;
  connectUrl: string;
  roomsPath: string;
  port: number;
}

export function readConfig(env: Record<string, string | undefined>): ReferenceConfig {
  const apiKey = env['VIDEOFY_API_KEY']?.trim() ?? '';
  if (apiKey === '') {
    throw new Error(
      'VIDEOFY_API_KEY is not set. Provision a Videofy Connect project and export ' +
        'the vfk_ key it prints before starting the Connect Reference server.',
    );
  }

  const rawUrl = env['VIDEOFY_CONNECT_URL']?.trim();
  const connectUrl = (rawUrl === undefined || rawUrl === '' ? DEFAULT_CONNECT_URL : rawUrl)
    // A trailing slash would double up when the SDK appends /v1 paths.
    .replace(/\/+$/, '');

  const rawRoomsPath = env['REF_ROOMS_PATH']?.trim();
  const roomsPath = rawRoomsPath === undefined || rawRoomsPath === '' ? DEFAULT_ROOMS_PATH : rawRoomsPath;

  const rawPort = env['PORT']?.trim();
  const port = rawPort === undefined || rawPort === '' ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  return { apiKey, connectUrl, roomsPath, port };
}
