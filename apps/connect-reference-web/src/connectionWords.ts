// owner: masterzee001
/**
 * Connection states in product words. The SDK's state names are public
 * vocabulary, but a person in a meeting deserves sentences, not enum
 * members — and no internal wording may ever reach the page.
 */
import type { ConnectionState } from '@videofy/connect';

export function connectionWords(state: ConnectionState): string {
  switch (state) {
    case 'connecting':
      return 'Taking your seat…';
    case 'connected':
      return 'Live';
    case 'reconnecting':
      return 'Connection wobbled — holding your seat…';
    case 'restoring':
      return 'Almost back — restoring your seat…';
    case 'suspended':
      return 'Paused while this tab is in the background';
    case 'ended':
      return 'This room has closed';
    default:
      return 'Working…';
  }
}
