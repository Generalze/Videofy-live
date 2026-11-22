/** @author masterzee001 */
/**
 * react-native-svg, as host component names.
 *
 * Same reasoning as the react-native stub beside it: the drawing is native and
 * a node test cannot see pixels, but every number the ring arc asserts --
 * radius, dash, the head's coordinates, the label naming what it measures --
 * is a PROP, and a prop is exactly what a mutant changes. The arithmetic behind
 * those numbers is proven separately in callRingGeometry.test.ts; this is how a
 * test sees whether the component asked for it.
 */
export const Svg = 'Svg';
export const Circle = 'Circle';
export const Line = 'Line';
export const Path = 'Path';
export const Rect = 'Rect';
export const G = 'G';
export const Defs = 'Defs';
export const Ellipse = 'Ellipse';
export const RadialGradient = 'RadialGradient';
export const Stop = 'Stop';
export default Svg;
