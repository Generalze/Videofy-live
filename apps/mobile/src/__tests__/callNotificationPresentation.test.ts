/** @author masterzee001 */
import { describe, expect, it } from 'vitest';
import { foregroundPresentationFor } from '../push/callNotificationPresentation';

describe('foregroundPresentationFor', () => {
  it('a call in the foreground is presented by the incoming screen, not a banner; the ring stays', () => {
    expect(foregroundPresentationFor({ kind: 'call', callId: 'ring-1' })).toEqual({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: true,
      shouldSetBadge: false,
    });
  });

  it('everything else keeps the ordinary banner and list', () => {
    expect(foregroundPresentationFor({ kind: 'message' }).shouldShowBanner).toBe(true);
    expect(foregroundPresentationFor(null).shouldShowList).toBe(true);
  });
});
