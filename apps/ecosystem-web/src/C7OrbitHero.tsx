/**
 * The approved C7 hero visual.
 *
 * Reproduced from `c7_approved_hero_reference.png`: a large, luminous,
 * dimensional orbital structure — a thick cyan/blue/violet energy ring seen in
 * perspective, a bright C7 core inside it, six satellite nodes riding the
 * ellipse, and atmospheric bloom behind the whole thing.
 *
 * WHY THIS IS DRAWN RATHER THAN PLACED. The supplied artwork is 614x441 and the
 * orbital element occupies roughly 310x220 of it. A 1440-wide hero needs about
 * 1200px across for that element, so the raster would mean a ~4x upscale:
 * visibly soft on desktop and openly bad on a 2x display. Drawing it keeps the
 * approved composition sharp at every size the page is actually viewed at.
 *
 * THE NODES ARE DECORATIVE. They are not derived from ECOSYSTEM_DOMAINS, carry
 * no labels, and are hidden from assistive technology. They are texture that
 * says "a connected system", not a legend somebody can count domains from — the
 * public five-domain disclosure lives in the cards below, in text, and is
 * untouched by anything here.
 */

interface SatelliteNode {
  /** Angle on the ellipse, degrees, 0 = right, measured clockwise. */
  readonly angle: number;
  /** Distance multiplier, so the nodes do not sit on one perfect ring. */
  readonly spread: number;
  readonly radius: number;
  readonly tone: string;
  readonly glyph: 'people' | 'group' | 'shield' | 'pulse' | 'chart' | 'media';
  readonly filled: boolean;
}

/*
 * Six, varied on purpose: different sizes, tones, glyphs and orbital distances.
 * Six identical dots read as a diagram; this reads as a system.
 */
const SATELLITES: readonly SatelliteNode[] = [
  { angle: -96, spread: 0.92, radius: 34, tone: '#7fd4ff', glyph: 'people', filled: true },
  { angle: -160, spread: 1.0, radius: 30, tone: '#9bb8ff', glyph: 'group', filled: false },
  { angle: -28, spread: 1.02, radius: 32, tone: '#6ee7d0', glyph: 'shield', filled: true },
  { angle: 34, spread: 0.96, radius: 27, tone: '#ff9db4', glyph: 'pulse', filled: false },
  { angle: 148, spread: 0.98, radius: 29, tone: '#e6ecff', glyph: 'chart', filled: false },
  { angle: 92, spread: 0.9, radius: 31, tone: '#8fb6ff', glyph: 'media', filled: true },
];

const RX = 330;
const RY = 146;
const CX = 400;
const CY = 300;

function position(node: SatelliteNode) {
  const radians = (node.angle * Math.PI) / 180;
  return {
    x: CX + Math.cos(radians) * RX * node.spread,
    y: CY + Math.sin(radians) * RY * node.spread,
  };
}

function Glyph({ glyph }: { readonly glyph: SatelliteNode['glyph'] }) {
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 } as const;
  switch (glyph) {
    case 'people':
      return (
        <g {...stroke}>
          <circle cx="0" cy="-4" r="3.4" />
          <path d="M-7 6c0-3.6 3.1-6 7-6s7 2.4 7 6" />
        </g>
      );
    case 'group':
      return (
        <g {...stroke}>
          <circle cx="-4" cy="-4" r="3" />
          <circle cx="5" cy="-5" r="2.4" />
          <path d="M-10 6c0-3.2 2.7-5.4 6-5.4s6 2.2 6 5.4" />
          <path d="M3 4.4c.2-2.6 2.1-4.4 4.6-4.4 2.2 0 3.9 1.3 4.4 3.3" />
        </g>
      );
    case 'shield':
      return (
        <g {...stroke}>
          <path d="M0-8 8-5v4.6C8 4.4 4.4 7.4 0 8.6-4.4 7.4-8 4.4-8-.4V-5z" />
          <path d="M-3.2 0 -.8 2.5 3.6 -2.2" />
        </g>
      );
    case 'pulse':
      return (
        <g {...stroke}>
          <path d="M-8 0h3.4l2 -4.4 3 8.4 2.2 -4h5.4" />
        </g>
      );
    case 'chart':
      return (
        <g {...stroke}>
          <path d="M-8 6h16" />
          <path d="M-5 6V-1M0 6v-7.6M5 6V-4" />
        </g>
      );
    case 'media':
      return (
        <g {...stroke}>
          <rect x="-8" y="-6" width="16" height="12" rx="2.2" />
          <path d="M-2 -2.4 3 0 -2 2.4z" />
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
        viewBox="40 40 720 520"
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
            <stop offset="26%" stopColor="#7c6bff" />
            <stop offset="52%" stopColor="#7fc4ff" />
            <stop offset="72%" stopColor="#ffffff" />
            <stop offset="100%" stopColor="#22d3ee" />
          </linearGradient>
          <linearGradient id="c7-rim-soft" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="rgba(180,101,255,0.85)" />
            <stop offset="55%" stopColor="rgba(127,196,255,0.9)" />
            <stop offset="100%" stopColor="rgba(34,211,238,0.85)" />
          </linearGradient>
          <radialGradient id="c7-bloom">
            <stop offset="0%" stopColor="rgba(150,200,255,0.55)" />
            <stop offset="38%" stopColor="rgba(126,110,240,0.26)" />
            <stop offset="100%" stopColor="rgba(8,11,20,0)" />
          </radialGradient>
          <radialGradient id="c7-field">
            <stop offset="0%" stopColor="rgba(96,140,240,0.24)" />
            <stop offset="100%" stopColor="rgba(5,7,12,0)" />
          </radialGradient>
          <linearGradient id="c7-disc" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(24,34,62,0.96)" />
            <stop offset="100%" stopColor="rgba(7,10,18,0.99)" />
          </linearGradient>
          <filter id="c7-blur-lg" x="-70%" y="-70%" width="240%" height="240%">
            <feGaussianBlur stdDeviation="26" />
          </filter>
          <filter id="c7-blur-sm" x="-70%" y="-70%" width="240%" height="240%">
            <feGaussianBlur stdDeviation="9" />
          </filter>
          <filter id="c7-node-glow" x="-90%" y="-90%" width="280%" height="280%">
            <feGaussianBlur stdDeviation="4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* atmosphere */}
        <ellipse cx={CX} cy={CY} rx="420" ry="285" fill="url(#c7-field)" />

        {/* faint outer orbits */}
        <ellipse cx={CX} cy={CY} rx={RX + 62} ry={RY + 30} className="orbit-path orbit-path-far" />
        <ellipse cx={CX} cy={CY} rx={RX} ry={RY} className="orbit-path" />
        <ellipse cx={CX} cy={CY} rx={RX - 96} ry={RY - 44} className="orbit-path" />

        {/* the bloom behind the ring, which is what makes it read as energy
            rather than as a drawn outline */}
        <ellipse cx={CX} cy={CY} rx="250" ry="150" fill="url(#c7-bloom)" />
        <ellipse
          cx={CX}
          cy={CY}
          rx="168"
          ry="74"
          fill="none"
          stroke="url(#c7-rim-soft)"
          strokeWidth="26"
          filter="url(#c7-blur-lg)"
          opacity="0.75"
        />

        {/* shadow under the disc */}
        <ellipse cx={CX} cy={CY + 58} rx="176" ry="46" fill="rgba(2,4,9,0.9)" filter="url(#c7-blur-sm)" />

        {/* the disc, then the thick energy ring around it */}
        <ellipse cx={CX} cy={CY} rx="168" ry="74" fill="url(#c7-disc)" />
        <ellipse
          cx={CX}
          cy={CY}
          rx="168"
          ry="74"
          fill="none"
          stroke="url(#c7-rim)"
          strokeWidth="11"
          filter="url(#c7-blur-sm)"
          opacity="0.9"
        />
        <ellipse
          cx={CX}
          cy={CY}
          rx="168"
          ry="74"
          fill="none"
          stroke="url(#c7-rim)"
          strokeWidth="5"
          className="orbit-rim"
        />

        {/* the luminous C7 core */}
        <ellipse cx={CX} cy={CY} rx="96" ry="46" fill="rgba(120,150,255,0.14)" filter="url(#c7-blur-sm)" />
        <g transform={`translate(${CX - 58} ${CY - 58}) scale(1.82)`}>
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

        {/* six satellites, varied so they read as a system rather than a legend */}
        {SATELLITES.map((node, index) => {
          const { x, y } = position(node);
          return (
            <g key={`${node.glyph}-${index}`} className="orbit-node" style={{ animationDelay: `${index * 0.6}s` }}>
              <line x1={CX} y1={CY} x2={x} y2={y} className="orbit-link" />
              <circle
                cx={x}
                cy={y}
                r={node.radius}
                fill={node.filled ? 'rgba(16,24,44,0.94)' : 'rgba(9,13,22,0.72)'}
              />
              <circle
                cx={x}
                cy={y}
                r={node.radius}
                fill="none"
                stroke={node.tone}
                strokeWidth={node.filled ? 1.8 : 1.2}
                opacity={node.filled ? 0.95 : 0.6}
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
