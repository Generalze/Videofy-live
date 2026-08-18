/** @owner masterzee001 */
import { VideofyCallEngine } from './call';
import { defaultConnectSdkDeps } from './deps';
import type { ConnectSdkDeps } from './deps';
import { VideofyConnectError } from './errors';
import { decodeConnectTokenClaims } from './tokenClaims';
import type { VideofyClient, VideofyClientConfig } from './publicTypes';

/**
 * The public entry point. `baseUrl` is the Videofy gateway origin; everything
 * else about the platform is defaulted for a real browser.
 */
export function createVideofyClient(config: VideofyClientConfig): VideofyClient {
  return createVideofyClientWith(config, defaultConnectSdkDeps(config));
}

/**
 * INTERNAL seam (not exported from the package): the same client with every
 * platform dependency injectable, which is how the node test suite drives the
 * whole join/resume/teardown orchestration against fakes.
 */
export function createVideofyClientWith(
  config: VideofyClientConfig,
  deps: ConnectSdkDeps,
): VideofyClient {
  if (typeof config?.baseUrl !== 'string' || config.baseUrl.trim().length === 0) {
    throw new VideofyConnectError('INVALID_REQUEST', 'A gateway baseUrl is required.');
  }
  return {
    async join(options) {
      const claims = decodeConnectTokenClaims(options?.token ?? '');
      if (claims === null) {
        throw new VideofyConnectError(
          'AUTH_INVALID_TOKEN',
          'The join token is not a valid Videofy Connect token.',
        );
      }
      const call = new VideofyCallEngine(config, deps, claims, options.token, options.media);
      try {
        await call.start();
      } catch (error) {
        call.dispose();
        throw error;
      }
      return call;
    },
  };
}
