/** @author masterzee001 */
/**
 * Safe-area insets, on a build that may not carry the module yet.
 *
 * The app draws edge-to-edge on modern Android, so the bottom of the window
 * sits UNDER the phone's own navigation area -- which is exactly how the tab
 * bar ended up sharing pixels with the system bar. The real answer is
 * react-native-safe-area-context, a NATIVE module that exists only in an APK
 * built after it was added; on an older build the require throws, so it is
 * loaded lazily and the fallback is a constant generous enough for both
 * gesture pills and three-button bars. Same pattern as every other
 * hardware-adjacent surface here: a named fallback, never a crash.
 */
import { type JSX, type ReactNode } from 'react';

interface SafeAreaModule {
  SafeAreaProvider: (props: { children: ReactNode }) => JSX.Element;
  useSafeAreaInsets: () => { top: number; bottom: number; left: number; right: number };
}

let safeArea: SafeAreaModule | null = null;
try {
  // OPTIONAL AT RUNTIME: a build without the package must still start, which
  // an import cannot express -- it would fail at module load, not here.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  safeArea = require('react-native-safe-area-context') as SafeAreaModule;
} catch {
  safeArea = null;
}

/** Covers gesture pills (~24) and classic three-button bars (~48). */
const FALLBACK_BOTTOM = 34;
const FALLBACK_TOP = 40;

export function InsetsProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  if (safeArea === null) return <>{children}</>;
  const Provider = safeArea.SafeAreaProvider;
  return <Provider>{children}</Provider>;
}

/**
 * The module presence is fixed for the app's whole life, so exactly one
 * branch of this hook ever runs in a given process -- the conditional call
 * is safe.
 */
export function useBottomInset(): number {
  if (safeArea === null) return FALLBACK_BOTTOM;
  const insets = safeArea.useSafeAreaInsets();
  return Math.max(insets.bottom, 12);
}

export function useTopInset(): number {
  if (safeArea === null) return FALLBACK_TOP;
  const insets = safeArea.useSafeAreaInsets();
  return Math.max(insets.top, 24);
}
