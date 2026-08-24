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
  readonly orbit: 0 | 1 | 2;
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
  { angle: -90, orbit: 1, radius: 30, tone: '#7fd4ff', glyph: 'person' },
  { angle: -158, orbit: 0, radius: 29, tone: '#9bb8ff', glyph: 'group' },
  { angle: -32, orbit: 0, radius: 29, tone: '#6ee7d0', glyph: 'shield-heart' },
  { angle: 26, orbit: 0, radius: 26, tone: '#ff9db4', glyph: 'heart' },
  { angle: 152, orbit: 0, radius: 27, tone: '#e6ecff', glyph: 'chart' },
  { angle: 90, orbit: 1, radius: 28, tone: '#8fb6ff', glyph: 'camera' },
];

const CX = 400;
const CY = 320;

/** rx, ry and tilt. The differing tilts are the whole trick. */
const ORBITS = [
  { rx: 300, ry: 168, rotate: -7 },
  { rx: 246, ry: 205, rotate: 15 },
  { rx: 208, ry: 132, rotate: -3 },
] as const;

function position(node: SatelliteNode) {
  const orbit = ORBITS[node.orbit];
  const radians = (node.angle * Math.PI) / 180;
  const tilt = (orbit.rotate * Math.PI) / 180;
  const x = Math.cos(radians) * orbit.rx;
  const y = Math.sin(radians) * orbit.ry;
  // Rotated with the ring it rides, or the badges float off their own orbit.
  return {
    x: CX + x * Math.cos(tilt) - y * Math.sin(tilt),
    y: CY + x * Math.sin(tilt) + y * Math.cos(tilt),
  };
}

function Glyph({ glyph }: { readonly glyph: SatelliteNode['glyph'] }) {
  const stroke = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
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
            <stop offset="0%" stopColor="rgba(170,215,255,0.62)" />
            <stop offset="34%" stopColor="rgba(126,110,240,0.28)" />
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
            transform={`rotate(${orbit.rotate} ${CX} ${CY})`}
            fill="none"
            stroke="url(#c7-orbit-stroke)"
            strokeWidth={index === 1 ? 1.5 : 1.1}
            className="orbit-path"
          />
        ))}

        {/* the bloom behind the lens, which is what makes it read as energy
            rather than as a drawn outline */}
        <ellipse cx={CX} cy={CY} rx="255" ry="165" fill="url(#c7-bloom)" />
        <ellipse
          cx={CX}
          cy={CY}
          rx="152"
          ry="64"
          fill="none"
          stroke="url(#c7-rim-soft)"
          strokeWidth="30"
          filter="url(#c7-blur-lg)"
          opacity="0.8"
        />

        {/* shadow under the lens */}
        <ellipse cx={CX} cy={CY + 52} rx="160" ry="40" fill="rgba(2,4,9,0.92)" filter="url(#c7-blur-sm)" />

        {/* the lens: dark well, blurred rim, then the crisp rim on top */}
        <ellipse cx={CX} cy={CY} rx="152" ry="64" fill="url(#c7-core-fill)" />
        <ellipse
          cx={CX}
          cy={CY}
          rx="152"
          ry="64"
          fill="none"
          stroke="url(#c7-rim)"
          strokeWidth="12"
          filter="url(#c7-blur-sm)"
          opacity="0.92"
        />
        <ellipse
          cx={CX}
          cy={CY}
          rx="152"
          ry="64"
          fill="none"
          stroke="url(#c7-rim)"
          strokeWidth="4.5"
          className="orbit-rim"
        />

        {/* the luminous C7 core */}
        <ellipse cx={CX} cy={CY} rx="92" ry="44" fill="rgba(130,165,255,0.16)" filter="url(#c7-blur-sm)" />
        <g transform={`translate(${CX - 56} ${CY - 56}) scale(1.78)`}>
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
          const { x, y } = position(node);
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
