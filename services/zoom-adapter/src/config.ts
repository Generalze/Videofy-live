/** @author masterzee001 */
/**
 * Environment for the Zoom RTMS adapter.
 *
 *   ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET   the General app's credentials; the
 *                                         secret keys the RTMS stream
 *                                         signature and nothing else.
 *   ZOOM_WEBHOOK_SECRET_TOKEN             a DIFFERENT secret, keying webhook
 *                                         verification only.
 *   ZOOM_ADAPTER_PORT                     where the webhook listens.
 *
 * No credential is ever logged, and none reaches a browser: this service has
 * no browser surface at all.
 */
export interface ZoomAdapterConfig {
  clientId: string;
  clientSecret: string;
  webhookSecretToken: string;
  port: number;
}

export function readConfig(env: NodeJS.ProcessEnv): ZoomAdapterConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim() ?? '';
    if (value === '') {
      throw new Error(
        `${name} is not set. Create a Zoom General app with RTMS scopes and export its credentials.`,
      );
    }
    return value;
  };
  const rawPort = env['ZOOM_ADAPTER_PORT']?.trim();
  const port = rawPort === undefined || rawPort === '' ? 8795 : Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('ZOOM_ADAPTER_PORT must be a positive integer.');
  }
  return {
    clientId: required('ZOOM_CLIENT_ID'),
    clientSecret: required('ZOOM_CLIENT_SECRET'),
    webhookSecretToken: required('ZOOM_WEBHOOK_SECRET_TOKEN'),
    port,
  };
}
