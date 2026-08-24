/**
 * The approved C7 hero visual.
 *
 * Reproduced from the owner's Ecosystem Reference Showboard; the composition is
 * transcribed in docs/design/C7_SHOWBOARD_REFERENCE.md, which is the thing to
 * read before changing any of this.
 *
 * WHY THIS IS DRAWN RATHER THAN PLACED. The supplied artwork is a small raster
 * and the orbital occupies a fraction of it. A 1440-wide hero needs roughly
 * 1200px across for that element, so the bitmap would mean a ~4x upscale:
 * visibly soft on desktop and openly bad on a 2x display. Drawn, it is sharp at
 * every size, themeable, and costs no network request.
 *
 * THE COMPOSITION, in the order it reads:
 *   - three orbit ellipses at DIFFERENT rotations, crossing each other. Rings
 *     that share a centre and a tilt read as flat contour lines; crossing them
 *     is what makes the eye see a sphere.
 *   - a bright central lens, the brightest object on the page.
 *   - the C7 monogram inside it.
 *   - six satellite badges, deliberately NOT evenly spaced.
 *
 * THE NODES ARE DECORATIVE. They are not derived from ECOSYSTEM_DOMAINS, carry
 * no labels, and are hidden from assistive technology. They are texture that
 * says "a connected system", not a legend somebody can count domains from — the
 * public domain disclosure lives in the cards below, in text, and nothing here
 * touches it.
 */

interface SatelliteNode {
  /** Angle on the ellipse, degrees, 0 = right, measured clockwise. */
  readonly angle: number;
  /** Which orbit it rides, so the six do not sit on one perfect ring. */
  readonly orbit: 0 | 1 | 2 | 3 | 4;
  readonly radius: number;
  readonly tone: string;
  readonly glyph: 'person' | 'group' | 'shield-heart' | 'heart' | 'chart' | 'camera';
}

/**
 * Six, at the clock positions the artwork places them: one at the top, one
 * bottom, and two per side at uneven heights. Evenly spaced dots read as a
 * diagram; this reads as a system.
 */
const SATELLITES: readonly SatelliteNode[] = [
  { angle: -84, orbit: 1, radius: 36, tone: '#8ad8ff', glyph: 'person' },
  { angle: -156, orbit: 0, radius: 35, tone: '#a9c4ff', glyph: 'group' },
  { angle: -26, orbit: 0, radius: 35, tone: '#6ee7d0', glyph: 'shield-heart' },
  { angle: 22, orbit: 0, radius: 33, tone: '#ff9db4', glyph: 'heart' },
  { angle: 158, orbit: 0, radius: 34, tone: '#cfe0ff', glyph: 'chart' },
  { angle: 92, orbit: 1, radius: 34, tone: '#8fb6ff', glyph: 'camera' },
];

const CX = 400;
const CY = 320;
/** Applied to the monogram's own 40x32 artboard. */
const MARK_SCALE = 1.42;

/**
 * NESTED AND COPLANAR, not a crossing cage.
 *
 * An earlier pass tilted three rings against each other to suggest a sphere.
 * The artwork does the opposite: five concentric ellipses sharing one shallow
 * tilt, like a system seen almost edge-on. Crossing them produced a busy
 * knot where the reference has calm, receding rings.
 */
const ORBITS = [
  { rx: 316, ry: 150 },
  { rx: 268, ry: 126 },
  { rx: 220, ry: 102 },
  { rx: 172, ry: 78 },
  { rx: 126, ry: 56 },
] as const;

/** Bright motes riding the paths, as in the artwork. angle in degrees. */
const MOTES: readonly { readonly orbit: number; readonly angle: number }[] = [
  { orbit: 0, angle: 196 },
  { orbit: 1, angle: 12 },
  { orbit: 1, angle: 205 },
  { orbit: 2, angle: 168 },
  { orbit: 2, angle: -18 },
  { orbit: 3, angle: 186 },
];

function pointOn(orbitIndex: number, angleDegrees: number) {
  const orbit = ORBITS[orbitIndex] ?? ORBITS[0]!;
  const radians = (angleDegrees * Math.PI) / 180;
  return {
    x: CX + Math.cos(radians) * orbit.rx,
    y: CY + Math.sin(radians) * orbit.ry,
  };
}

function Glyph({ glyph }: { readonly glyph: SatelliteNode['glyph'] }) {
  /*
    SOLID, not hairline. The artwork's badge icons are filled shapes; drawn as
    thin outlines they vanish at hero scale and the badges read as empty rings.
  */
  const stroke = {
    fill: 'currentColor',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  } as const;
  switch (glyph) {
    case 'person':
      return (
        <g {...stroke}>
          <circle cx="0" cy="-4" r="3.4" />
          <path d="M-6.6 6.4c0-3.4 3-5.6 6.6-5.6s6.6 2.2 6.6 5.6" />
        </g>
      );
    case 'group':
      return (
        <g {...stroke}>
          <circle cx="-4" cy="-3.6" r="3" />
          <circle cx="5.2" cy="-4.6" r="2.4" />
          <path d="M-10 6.2c0-3.1 2.7-5.2 6-5.2s6 2.1 6 5.2" />
          <path d="M3.4 4.2c.2-2.5 2-4.2 4.4-4.2 2.1 0 3.7 1.2 4.2 3.1" />
        </g>
      );
    case 'shield-heart':
      return (
        <g {...stroke}>
          <path d="M0-8.2 7.6-5.4v4.6C7.6 4.2 4.2 7.2 0 8.4-4.2 7.2-7.6 4.2-7.6-.8v-4.6z" />
          <path d="M0 3.4C-2.6 1.6-3.8.6-3.8-1a2 2 0 0 1 3.8-.9 2 2 0 0 1 3.8.9c0 1.6-1.2 2.6-3.8 4.4z" />
        </g>
      );
    case 'heart':
      return (
        <g {...stroke}>
          <path d="M0 7C-4.8 3.6-7.4 1.6-7.4-1.8A3.9 3.9 0 0 1 0-3.6a3.9 3.9 0 0 1 7.4 1.8C7.4 1.6 4.8 3.6 0 7z" />
        </g>
      );
    case 'chart':
      return (
        <g {...stroke}>
          <path d="M-7.6 6.4h15.2" />
          <path d="M-4.6 6.4V-.6M0 6.4v-7.4M4.6 6.4V-4.2" />
        </g>
      );
    case 'camera':
      return (
        <g {...stroke}>
          <rect x="-7.8" y="-4.6" width="15.6" height="11" rx="2.4" />
          <circle cx="0" cy="1" r="3.2" />
          <path d="M-3.4-4.6 -2.2-7h4.4l1.2 2.4" />
        </g>
      );
  }
}

export function C7OrbitHero() {
  return (
    <div className="orbit-hero">
      {/*
        role="presentation" and aria-hidden: this is atmosphere. Everything it
        would "say" is already said in semantic text elsewhere on the page, and
        announcing six anonymous shapes to a screen reader is noise, not
        information.
      */}
      <svg
        viewBox="30 20 740 600"
        className="orbit-hero-svg"
        role="presentation"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          {/* The signature of the approved visual: violet at the near edge,
              through blue, to a white-hot crest and cyan on the far side. */}
          <linearGradient id="c7-rim" x1="0.05" y1="0.95" x2="0.95" y2="0.05">
            <stop offset="0%" stopColor="#b465ff" />
            <stop offset="24%" stopColor="#7c6bff" />
            <stop offset="50%" stopColor="#7fc4ff" />
            <stop offset="70%" stopColor="#ffffff" />
            <stop offset="100%" stopColor="#22d3ee" />
          </linearGradient>
          <linearGradient id="c7-rim-soft" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="rgba(180,101,255,0.9)" />
            <stop offset="52%" stopColor="rgba(127,196,255,0.95)" />
            <stop offset="100%" stopColor="rgba(34,211,238,0.9)" />
          </linearGradient>
          <linearGradient id="c7-orbit-stroke" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="rgba(124,168,255,0.05)" />
            <stop offset="30%" stopColor="rgba(150,200,255,0.42)" />
            <stop offset="70%" stopColor="rgba(120,220,255,0.34)" />
            <stop offset="100%" stopColor="rgba(124,168,255,0.05)" />
          </linearGradient>
          <radialGradient id="c7-bloom">
            <stop offset="0%" stopColor="rgba(196,230,255,0.78)" />
            <stop offset="34%" stopColor="rgba(136,120,248,0.34)" />
            <stop offset="100%" stopColor="rgba(8,11,20,0)" />
          </radialGradient>
          <radialGradient id="c7-field">
            <stop offset="0%" stopColor="rgba(96,140,240,0.22)" />
            <stop offset="100%" stopColor="rgba(5,7,12,0)" />
          </radialGradient>
          <radialGradient id="c7-core-fill">
            <stop offset="0%" stopColor="rgba(38,54,96,0.98)" />
            <stop offset="100%" stopColor="rgba(7,10,18,0.99)" />
          </radialGradient>
          <filter id="c7-blur-lg" x="-70%" y="-70%" width="240%" height="240%">
            <feGaussianBlur stdDeviation="28" />
          </filter>
          <filter id="c7-blur-sm" x="-70%" y="-70%" width="240%" height="240%">
            <feGaussianBlur stdDeviation="9" />
          </filter>
          <filter id="c7-node-glow" x="-90%" y="-90%" width="280%" height="280%">
            <feGaussianBlur stdDeviation="4.5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* atmosphere */}
        <ellipse cx={CX} cy={CY} rx="430" ry="330" fill="url(#c7-field)" />

        {/*
          The cage. Three rings, three tilts. Drawn BEFORE the lens so the
          bright core sits in front of them, which is what gives the depth.
        */}
        {ORBITS.map((orbit, index) => (
          <ellipse
            key={`orbit-${index}`}
            cx={CX}
            cy={CY}
            rx={orbit.rx}
            ry={orbit.ry}
            fill="none"
            stroke="url(#c7-orbit-stroke)"
            strokeWidth={1.1}
            className="orbit-path"
          />
        ))}

        {/* motes riding the paths */}
        {MOTES.map((mote, index) => {
          const { x, y } = pointOn(mote.orbit, mote.angle);
          return (
            <circle key={`mote-${index}`} cx={x} cy={y} r="2.2" fill="rgba(190,230,255,0.9)" />
          );
        })}

        {/* the bloom behind the lens, which is what makes it read as energy
            rather than as a drawn outline */}
        <ellipse cx={CX} cy={CY} rx="250" ry="150" fill="url(#c7-bloom)" />
        <ellipse
          cx={CX}
          cy={CY}
          rx="104"
          ry="46"
          fill="none"
          stroke="url(#c7-rim-soft)"
          strokeWidth="26"
          filter="url(#c7-blur-lg)"
          opacity="0.8"
        />

        {/*
          A PLINTH below, a bright RING above.
          The artwork is not one lens: a wide dark disc sits under the mark
          like a base, and the luminous ring is smaller and higher, which is
          what makes the C7 read as floating above it rather than embedded in
          it.
        */}
        <ellipse cx={CX} cy={CY + 34} rx="168" ry="60" fill="rgba(3,6,14,0.94)" filter="url(#c7-blur-sm)" />
        <ellipse
          cx={CX}
          cy={CY + 34}
          rx="168"
          ry="60"
          fill="none"
          stroke="rgba(150,200,255,0.22)"
          strokeWidth="1.2"
        />

        <ellipse cx={CX} cy={CY} rx="104" ry="46" fill="url(#c7-core-fill)" />
        <ellipse
          cx={CX}
          cy={CY}
          rx="104"
          ry="46"
          fill="none"
          stroke="url(#c7-rim)"
          strokeWidth="14"
          filter="url(#c7-blur-sm)"
          opacity="0.95"
        />
        <ellipse
          cx={CX}
          cy={CY}
          rx="104"
          ry="46"
          fill="none"
          stroke="url(#c7-rim)"
          strokeWidth="4"
          className="orbit-rim"
        />

        {/* the luminous C7 core */}
        <ellipse cx={CX} cy={CY} rx="76" ry="36" fill="rgba(160,200,255,0.26)" filter="url(#c7-blur-sm)" />
        {/*
          Centred on the GLYPH's own bounding box, not on a guessed offset.
          The artwork spans x 25.7-65.3 and y 17.6-50 in its own coordinates,
          so its centre is (45.5, 33.8); translating by half the viewport
          instead left the monogram sitting ~25px right of the lens, which
          reads as a mistake even to someone who never saw the reference.
        */}
        <g transform={`translate(${CX - 45.5 * MARK_SCALE} ${CY - 33.8 * MARK_SCALE}) scale(${MARK_SCALE})`}>
          <path
            d="M45.5 17.6 A19.8 19.8 0 1 0 45.5 46.4"
            fill="none"
            stroke="url(#c7-rim)"
            strokeWidth="7.5"
            strokeLinecap="square"
          />
          <path
            d="M34.5 17.6 H52 L40 50"
            fill="none"
            stroke="#ffffff"
            strokeWidth="7.5"
            strokeLinejoin="miter"
            strokeLinecap="square"
          />
        </g>

        {/* six satellites, uneven on purpose */}
        {SATELLITES.map((node, index) => {
          const { x, y } = pointOn(node.orbit, node.angle);
          return (
            <g
              key={`${node.glyph}-${index}`}
              className="orbit-node"
              style={{ animationDelay: `${index * 0.55}s` }}
            >
              <circle cx={x} cy={y} r={node.radius} fill="rgba(10,15,27,0.95)" />
              <circle
                cx={x}
                cy={y}
                r={node.radius}
                fill="none"
                stroke={node.tone}
                strokeWidth="1.6"
                opacity="0.92"
                filter="url(#c7-node-glow)"
              />
              <g transform={`translate(${x} ${y})`} style={{ color: node.tone }}>
                <Glyph glyph={node.glyph} />
              </g>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
