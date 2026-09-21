/** @author masterzee001 */
/**
 * REACT NATIVE, AS MUCH OF IT AS A RENDERED TEST NEEDS -- and not one export more.
 *
 * WHY THIS EXISTS. Three review rounds in a row said the same thing: the call
 * screen's components were tested by matching SOURCE TEXT, and a one-line early
 * return or a swapped prop passes every source-text assertion while cutting the
 * thing the test was written to protect. Twenty-two mutants planted in the
 * screen, the components and the styles survived a green suite. The only
 * instrument that can see a prop is one that RENDERS, so `react-test-renderer`
 * is now a devDependency (never a dependency: `dependencies` ships in the APK)
 * and the components are rendered for real.
 *
 * WHY A STUB AND NOT THE REAL PACKAGE. `react-native`'s entry point is Flow
 * source. esbuild -- which is what vitest transforms with -- cannot parse Flow,
 * so importing it in node fails at transform time before any test runs. The
 * usual answers are a metro-based jest preset (this app has no jest) or
 * `@testing-library/react-native` (which itself requires that preset). What
 * every one of those ends at is the same place: the RN primitives these screens
 * use are HOST components, and a host component in a test renderer is just a
 * name and a bag of props.
 *
 * SO THE STUB IS DELIBERATELY DUMB. `View` is the string 'View'. It does not
 * lay anything out, it measures nothing, and it must never grow an opinion:
 * anything it decided would be a decision the device does not make. What the
 * rendered tree gives is exactly what the reviews asked for -- which component
 * was drawn, with which props, in which order -- and that is what a mutant
 * changes.
 *
 * `Animated` is the one part with behaviour, and only the part the components
 * observe: a `Value` that can be set, interpolated and stopped, and drivers
 * that can be started and stopped. Whether the pulse is RUNNING is what the F5
 * regression turned on, so `Animated.Value` records it and the tests read it.
 */
import { createElement, type ReactNode } from 'react';

export const View = 'View';
export const Text = 'Text';
export const Image = 'Image';
export const ScrollView = 'ScrollView';
export const ActivityIndicator = 'ActivityIndicator';

export type StyleProp = unknown;

/**
 * THE WINDOW, AS A TEST TELLS IT.
 *
 * The stub measures nothing and must not start now, so this does not guess a
 * screen: it reports whatever `setWindowSize` last said, and the default is the
 * 360x800 Android phone every layout figure in this app was computed against.
 * A test that cares about a narrower screen says so before it mounts.
 */
let windowSize = { width: 360, height: 800, scale: 2, fontScale: 1 };

export function setWindowSize(next: { readonly width: number; readonly height: number }): void {
  windowSize = { ...windowSize, width: next.width, height: next.height };
}

export function useWindowDimensions(): {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly fontScale: number;
} {
  return windowSize;
}

/** What a Pressable's `style` callback is handed. RN's own shape, pressed only. */
interface PressableState {
  readonly pressed: boolean;
}

/**
 * A Pressable renders as itself, with its style resolved in the UNPRESSED
 * state -- the state a screenshot of the screen would be in.
 */
export function Pressable(props: {
  readonly style?: StyleProp | ((state: PressableState) => StyleProp);
  readonly children?: ReactNode;
  readonly [key: string]: unknown;
}): ReturnType<typeof createElement> {
  const { style, children, ...rest } = props;
  const resolved = typeof style === 'function' ? style({ pressed: false }) : style;
  return createElement('Pressable', { ...rest, style: resolved }, children);
}

export const StyleSheet = {
  /**
   * IDENTITY. Real RN hands back the same objects too (it stopped returning
   * opaque numbers years ago), and a test that can read a style is a test that
   * can catch a style deleted -- `flexWrap` and `maxWidth` were both removable
   * with the suite green.
   */
  create<T extends Record<string, object>>(sheet: T): T {
    return sheet;
  },
  absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const,
  flatten(style: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const walk = (value: unknown): void => {
      if (value === null || value === undefined || value === false) return;
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry);
        return;
      }
      if (typeof value === 'object') Object.assign(out, value as Record<string, unknown>);
    };
    walk(style);
    return out;
  },
};

/** A running driver, as the components hold it: started once, stopped on cleanup. */
export interface AnimatedDriver {
  start(): void;
  stop(): void;
}

class AnimatedValue {
  value: number;
  /** True between `start()` and `stop()` on any driver built from this value. */
  running = false;
  /** Every `setValue`, in order: a reset is a fact a test can check. */
  readonly writes: number[] = [];

  constructor(value: number) {
    this.value = value;
  }

  setValue(next: number): void {
    this.value = next;
    this.writes.push(next);
  }

  stopAnimation(callback?: (value: number) => void): void {
    this.running = false;
    callback?.(this.value);
  }

  interpolate(config: {
    readonly inputRange: readonly number[];
    readonly outputRange: readonly (number | string)[];
  }): { readonly __interpolated: true; readonly inputRange: readonly number[]; readonly outputRange: readonly (number | string)[] } {
    return { __interpolated: true, inputRange: config.inputRange, outputRange: config.outputRange };
  }
}

function driverFor(values: readonly AnimatedValue[]): AnimatedDriver {
  return {
    start(): void {
      for (const value of values) value.running = true;
    },
    stop(): void {
      for (const value of values) value.running = false;
    },
  };
}

interface TimingConfig {
  readonly toValue: number;
  readonly duration: number;
}

export const Animated = {
  Value: AnimatedValue,
  View: function AnimatedView(props: {
    readonly children?: ReactNode;
    readonly [key: string]: unknown;
  }): ReturnType<typeof createElement> {
    const { children, ...rest } = props;
    return createElement('Animated.View', rest, children);
  },
  timing(value: AnimatedValue, config: TimingConfig): AnimatedDriver {
    // The duration is the platform's business; the driver only records that
    // something was started, which is what the components are asked about.
    void config.duration;
    return driverFor([value]);
  },
  sequence(drivers: readonly AnimatedDriver[]): AnimatedDriver {
    return {
      start: () => drivers.forEach((driver) => driver.start()),
      stop: () => drivers.forEach((driver) => driver.stop()),
    };
  },
  loop(driver: AnimatedDriver): AnimatedDriver {
    return driver;
  },
};

const easingFn = (value: number): number => value;
export const Easing = {
  quad: easingFn,
  linear: easingFn,
  out: (fn: typeof easingFn) => fn,
  inOut: (fn: typeof easingFn) => fn,
};
