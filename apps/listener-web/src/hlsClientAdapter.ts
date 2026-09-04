/** @author masterzee001 */
/**
 * The one place hls.js is spoken to.
 *
 * Everything else in the delayed path talks to `HlsClientLike`, a four-method
 * port. That is not ceremony: it is what lets the controller's states, its
 * teardown and its refusal to fall back to realtime be tested without a
 * browser, and it is what keeps a library upgrade to this file.
 *
 * CREDENTIALS TRAVEL AS CREDENTIALS. The manifest, the initialisation segment
 * and every media fragment go through the same authorised requests as any
 * other call to this service -- cookies on the request, and a bearer token in
 * a header when the viewer holds a session. Nothing that grants access is put
 * in a URL: media URLs are logged by proxies, kept in browser history, and
 * pasted into messages, and a token in one is a token handed to whoever reads
 * any of those.
 *
 * NATIVE PLAYBACK CANNOT DO THIS. A media element given a manifest URL sends
 * cookies and nothing else, so a deployment whose protected programmes need a
 * bearer token has to admit native viewers by cookie or not at all. That is a
 * property of the platform rather than a decision made here, and it is written
 * down so nobody concludes the header path was forgotten.
 */

import Hls from 'hls.js';
import type { HlsClientLike, MediaElementLike } from './delayedProgrammePlayer';

export interface HlsClientOptions {
  /** A viewer's session token, when they hold one. Never placed in a URL. */
  readonly bearerToken?: string | null | undefined;
}

/** Whether this browser can run the MSE path at all. */
export function hlsClientSupported(): boolean {
  return Hls.isSupported();
}

export function createHlsClient(options: HlsClientOptions = {}): HlsClientLike {
  const hls = new Hls({
    /*
     * Cookies on every request, and the session token as a header. The same
     * authorisation the egress applies to any other caller: there is no media
     * URL that is a credential, so a link somebody copies out of the network
     * tab grants nothing.
     */
    xhrSetup: (xhr: XMLHttpRequest, url: string) => {
      xhr.withCredentials = true;
      void url;
      const token = options.bearerToken;
      if (token !== null && token !== undefined && token !== '') {
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      }
    },
    /*
     * NO SEEKING PAST WHAT IS PUBLIC. The manifest contains only released
     * material, so its end IS the audience's position -- but a client that
     * chases the live edge aggressively will sit on the newest fragment and
     * stall every time the cursor has not moved yet. A few seconds back is
     * where a protected viewer belongs anyway.
     */
    liveSyncDurationCount: 3,
    /*
     * Left to the client's own recovery. Bounded, because a protected
     * programme that retries for ever looks identical to one that is playing,
     * and the viewer deserves to be told which it is.
     */
    manifestLoadingMaxRetry: 4,
    levelLoadingMaxRetry: 4,
    fragLoadingMaxRetry: 4,
  });

  return {
    loadSource(url: string): void {
      hls.loadSource(url);
    },
    attachMedia(element: MediaElementLike): void {
      hls.attachMedia(element as unknown as HTMLMediaElement);
    },
    onError(listener: (fatal: boolean) => void): void {
      hls.on(Hls.Events.ERROR, (_event: unknown, data: { fatal?: boolean }) => {
        listener(data.fatal === true);
      });
    },
    destroy(): void {
      hls.destroy();
    },
  };
}
