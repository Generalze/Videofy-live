/** @author masterzee001 */
/**
 * THE VOICE ON THE JOIN, decided where it can be tested.
 *
 * WHY THIS FILE EXISTS. The fix of 27 Sep 2026 made the session keep the
 * account's translated voice and made the call screen send whatever it was
 * handed. Every line JOINING the two lived in App.tsx: read the session's
 * voice into state on sign-in, spread it onto the call screen, write a change
 * back to the session. Nothing tests App.tsx. A reviewer replaced the spread
 * with the literal `translatedVoice="female"` -- restoring the exact defect
 * the fix removed, every speaker rendered in the default voice -- and the
 * full suite stayed green; emptying the change handler survived the same
 * way. That is the third feature to land in the shell unguarded, and this
 * is the same answer callScreenModel and incomingCallRouting already gave:
 * the shell obeys a module, and the module is proven.
 *
 * WHAT THE SHELL IS LEFT WITH. One object, created once beside the session
 * manager. The call screen is handed `joinProps()`; the profile row is handed
 * `accept`; the sign-in effect calls `refresh()`; a `watch` keeps the shell's
 * render in step. None of those lines chooses a voice. A source guard
 * (src/__tests__/appShellSeams.test.ts) then holds the shell to exactly
 * that, so the reviewer's two edits fail the suite rather than pass it.
 *
 * WHAT IT DECIDES. The join carries the session's voice and nothing else:
 * never a literal, never a remembered copy the session has moved on from.
 * When the account has no voice on file the join carries NO voice at all,
 * so the shared form's default applies and is STATED as such on the profile
 * (translatedVoiceSubtitle) rather than being sent as if chosen.
 *
 * A VOICE, NOT A GENDER. See ./translatedVoice.
 */
import type { TranslatedVoice } from './translatedVoice';

/** What the seam needs of the session manager, and no more. */
export interface TranslatedVoiceSession {
  /** The voice the server last said, or null when signed out or not known. */
  translatedVoice(): TranslatedVoice | null;
  /** The server accepted a change; the next join must carry it. */
  rememberTranslatedVoice(voice: TranslatedVoice): void;
}

/** The props the call screen is spread with. The key is ABSENT, not undefined, when there is no voice. */
export type JoinVoiceProps = { readonly translatedVoice: TranslatedVoice } | Record<never, never>;

export interface TranslatedVoiceSeam {
  /** The voice for the join, read from the session at the moment of asking. */
  joinProps(): JoinVoiceProps;
  /** The voice as the session holds it now; what the profile row shows. */
  current(): TranslatedVoice | null;
  /** The server accepted a change: the session keeps it and every watcher is told. */
  accept(voice: TranslatedVoice): void;
  /** A session came or went (sign-in, sign-out, restore): re-read and tell the watchers. */
  refresh(): void;
  /** Told the current value now and on every change; returns the unsubscribe. */
  watch(listener: (voice: TranslatedVoice | null) => void): () => void;
}

export function createTranslatedVoiceSeam(session: TranslatedVoiceSession): TranslatedVoiceSeam {
  const watchers = new Set<(voice: TranslatedVoice | null) => void>();
  const tell = (): void => {
    const voice = session.translatedVoice();
    for (const watcher of watchers) watcher(voice);
  };
  return {
    joinProps(): JoinVoiceProps {
      const voice = session.translatedVoice();
      return voice === null ? {} : { translatedVoice: voice };
    },
    current(): TranslatedVoice | null {
      return session.translatedVoice();
    },
    accept(voice: TranslatedVoice): void {
      session.rememberTranslatedVoice(voice);
      tell();
    },
    refresh(): void {
      tell();
    },
    watch(listener): () => void {
      watchers.add(listener);
      listener(session.translatedVoice());
      return () => {
        watchers.delete(listener);
      };
    },
  };
}
