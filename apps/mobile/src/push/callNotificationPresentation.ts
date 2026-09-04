/** @author masterzee001 */
/**
 * How a notification is presented while the app is in the FOREGROUND.
 *
 * A CALL is presented by the incoming-call screen, which is what sends the
 * ringing acknowledgement; showing the OS banner as well would be two
 * presentations of one call. The sound stays with the OS (it is the ring).
 * Everything else keeps the ordinary banner + list behaviour.
 *
 * Pure so it can be pinned: the invariant "RINGING means a device is
 * presenting the call" starts with this decision.
 */
export interface ForegroundPresentation {
  readonly shouldShowBanner: boolean;
  readonly shouldShowList: boolean;
  readonly shouldPlaySound: boolean;
  readonly shouldSetBadge: boolean;
}

export function foregroundPresentationFor(
  data: Record<string, unknown> | null | undefined,
): ForegroundPresentation {
  const isCall = data?.['kind'] === 'call';
  return {
    shouldShowBanner: !isCall,
    shouldShowList: !isCall,
    shouldPlaySound: true,
    shouldSetBadge: false,
  };
}
