/** @author masterzee001 */
/**
 * The browser features the channel identity menu uses -- the clipboard and
 * the Web Share API -- behind one small interface, so the menu can be
 * rendered and tested without a window and so "Share" can say honestly
 * whether it shares or copies.
 */

export interface ChannelMenuBrowser {
  readonly copyText: (text: string) => Promise<void>;
  /** Present only where the Web Share API exists. */
  readonly share?: ((data: { readonly title: string; readonly url: string }) => Promise<void>) | undefined;
}

export function defaultChannelMenuBrowser(): ChannelMenuBrowser {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const copyText = async (text: string): Promise<void> => {
    if (nav?.clipboard?.writeText === undefined) throw new Error('Clipboard unavailable');
    await nav.clipboard.writeText(text);
  };
  const share =
    nav !== undefined && typeof nav.share === 'function'
      ? async (data: { readonly title: string; readonly url: string }): Promise<void> => {
          await nav.share(data);
        }
      : undefined;
  return { copyText, share };
}
