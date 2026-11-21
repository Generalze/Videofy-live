/** @author masterzee001 */
/**
 * The "or sign in with" row.
 *
 * WHAT THIS COMPONENT REFUSES TO DO. It never draws a button for a provider
 * this deployment does not have. Both switches ship off, so for most of this
 * feature's life the honest render is nothing at all -- and a button that
 * answers 503 is worse than a missing one, because the person pressing it
 * cannot tell a switched-off provider from their own account being rejected.
 * They try again, and conclude the fault is theirs.
 *
 * It also renders nothing while it is still asking. A row that appears a
 * second after the page settles moves the password button out from under
 * somebody's cursor.
 */
import { useEffect, useRef, useState } from 'react';
import {
  fetchProviders,
  kingsChatLoginUrl,
  loadGoogleIdentityServices,
  providerRowPlan,
  signInWithGoogle,
  type AvailableProviders,
} from './federatedSignIn';
import type { SessionResult } from './JoinC7';

export interface ProviderSignInProps {
  readonly accountUrl: string;
  /** Where to land after a KingsChat round trip. A path, never a url. */
  readonly returnPath?: string;
  readonly onSignedIn: (session: SessionResult) => void;
  readonly onError: (message: string) => void;
  /** The web client id, needed by Google's own script. Public by design. */
  readonly googleClientId?: string;
  /** Test seam: the providers to render, skipping the fetch. */
  readonly providers?: AvailableProviders;
}

export function ProviderSignIn({
  accountUrl,
  returnPath,
  onSignedIn,
  onError,
  googleClientId,
  providers: given,
}: ProviderSignInProps) {
  const [providers, setProviders] = useState<AvailableProviders | null>(given ?? null);
  const [busy, setBusy] = useState(false);
  const googleSlot = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (given) return;
    let live = true;
    void fetchProviders({ accountUrl }).then((result) => {
      // Guarded because a person who navigates away mid-request should not
      // cause a state write on an unmounted component.
      if (live) setProviders(result);
    });
    return () => {
      live = false;
    };
  }, [accountUrl, given]);

  /*
   * Google's button is rendered by Google's own script, into the slot below.
   * The script is only fetched when there is actually a Google button to
   * draw -- it is third-party code with the run of the page, and it has no
   * business loading for visitors who are never offered it.
   */
  useEffect(() => {
    if (!providers?.google || !googleClientId) return;
    let live = true;
    void loadGoogleIdentityServices().then((gsi) => {
      if (!live || !gsi || !googleSlot.current) return;
      gsi.accounts.id.initialize({
        client_id: googleClientId,
        /*
         * No auto_select. Signing somebody in because a browser remembered
         * them, without them asking, is a decision the person did not make --
         * and on a shared machine it is the wrong person.
         */
        auto_select: false,
        cancel_on_tap_outside: true,
        callback: (response) => {
          const idToken = response.credential;
          if (typeof idToken !== 'string' || idToken.length === 0) {
            onError('That Google sign-in could not be completed.');
            return;
          }
          setBusy(true);
          void signInWithGoogle({ accountUrl, idToken })
            .then((result) => {
              if (result.ok) onSignedIn(result.session);
              else onError(result.reason);
            })
            .finally(() => setBusy(false));
        },
      });
      gsi.accounts.id.renderButton(googleSlot.current, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        text: 'continue_with',
        width: 280,
      });
    });
    return () => {
      live = false;
    };
  }, [providers, googleClientId, accountUrl, onSignedIn, onError]);

  async function goToKingsChat() {
    setBusy(true);
    try {
      const url = await kingsChatLoginUrl({
        accountUrl,
        ...(returnPath === undefined ? {} : { returnPath }),
      });
      if (url === null) {
        onError('Signing in with KingsChat is not available right now.');
        return;
      }
      /*
       * A full navigation, and `assign` rather than `replace`: somebody who
       * changes their mind on the KingsChat page should be able to come back
       * with the browser's own back button.
       */
      window.location.assign(url);
    } finally {
      setBusy(false);
    }
  }

  // The decision itself lives in `providerRowPlan`, where it can be tested
  // without a DOM. Still asking and nothing on offer both render nothing.
  const plan = providerRowPlan(providers, googleClientId);
  if (!plan.showRow) return null;

  return (
    <div className="join-providers">
      <p className="join-providers-label" aria-hidden="true">
        or continue with
      </p>
      {plan.showGoogle ? (
        // Google renders its own button in here; nothing of ours goes inside.
        <div className="join-provider-slot" ref={googleSlot} />
      ) : null}
      {plan.showKingsChat ? (
        <button
          type="button"
          className="button button-wide join-provider-button"
          disabled={busy}
          onClick={() => void goToKingsChat()}
        >
          {busy ? 'Working…' : 'Continue with KingsChat'}
        </button>
      ) : null}
    </div>
  );
}
