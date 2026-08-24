/**
 * The illustrative artwork behind each domain card.
 *
 * DRAWN, NOT PHOTOGRAPHED. The showboard shows a photographic treatment per
 * card — a world map, a shield over circuitry, a luminous plant, a candlestick
 * chart, a lit stage. Sourcing those as images would mean five licences to
 * track, five files to serve, a network request each, and a visible quality
 * cliff on a 2x display. Drawn as SVG they are sharp at any size, weigh
 * nothing, theme with the palette, and a deploy with no internet still renders
 * the page exactly as designed.
 *
 * Each scene is 200x120 and DECORATIVE: hidden from assistive technology,
 * because the card's meaning is entirely in the text beside it. A screen
 * reader announcing "chart" adds nothing to a heading that already says
 * FINANCE & MARKETS.
 */

interface SceneProps {
  readonly id: string;
}

/** Deterministic scatter, so a rebuild does not reshuffle the artwork. */
function pseudoRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function Communication({ id }: SceneProps) {
  // Latitude/longitude arcs read as a globe far more cheaply than a traced
  // coastline, and stay legible at card size where a real map turns to mud.
  const dots = Array.from({ length: 26 }, (_, index) => ({
    x: 18 + pseudoRandom(index + 1) * 164,
    y: 22 + pseudoRandom(index + 41) * 78,
    r: 0.8 + pseudoRandom(index + 77) * 1.5,
  }));
  return (
    <>
      <defs>
        <radialGradient id={`${id}-glow`}>
          <stop offset="0%" stopColor="rgba(110,190,255,0.5)" />
          <stop offset="100%" stopColor="rgba(10,16,32,0)" />
        </radialGradient>
      </defs>
      <ellipse cx="100" cy="62" rx="86" ry="54" fill={`url(#${id}-glow)`} />
      <g fill="none" stroke="rgba(130,200,255,0.34)" strokeWidth="0.7">
        <ellipse cx="100" cy="62" rx="62" ry="42" />
        <ellipse cx="100" cy="62" rx="30" ry="42" />
        <ellipse cx="100" cy="62" rx="62" ry="16" />
        <ellipse cx="100" cy="62" rx="62" ry="30" />
      </g>
      <g fill="rgba(150,215,255,0.85)">
        {dots.map((dot, index) => (
          <circle key={index} cx={dot.x} cy={dot.y} r={dot.r} />
        ))}
      </g>
      <g fill="none" stroke="rgba(120,235,255,0.75)" strokeWidth="0.9">
        <path d="M42 74C70 44 132 44 158 66" />
        <path d="M56 88C82 66 126 62 152 44" />
      </g>
      <g fill="#bfeaff">
        <circle cx="42" cy="74" r="2.4" />
        <circle cx="158" cy="66" r="2.4" />
        <circle cx="56" cy="88" r="2" />
        <circle cx="152" cy="44" r="2" />
      </g>
    </>
  );
}

function Protection({ id }: SceneProps) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-shield`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(120,190,255,0.32)" />
          <stop offset="100%" stopColor="rgba(60,110,220,0.1)" />
        </linearGradient>
        <radialGradient id={`${id}-glow`}>
          <stop offset="0%" stopColor="rgba(90,160,255,0.42)" />
          <stop offset="100%" stopColor="rgba(10,16,32,0)" />
        </radialGradient>
      </defs>
      <ellipse cx="100" cy="60" rx="78" ry="52" fill={`url(#${id}-glow)`} />
      {/* circuitry, behind the shield so it reads as what is being protected */}
      <g fill="none" stroke="rgba(120,180,255,0.3)" strokeWidth="0.7">
        <path d="M16 34h34v20h26" />
        <path d="M184 40h-30v28h-22" />
        <path d="M20 92h40V70" />
        <path d="M180 96h-38V78" />
      </g>
      <g fill="rgba(140,200,255,0.7)">
        <circle cx="16" cy="34" r="1.6" />
        <circle cx="184" cy="40" r="1.6" />
        <circle cx="20" cy="92" r="1.6" />
        <circle cx="180" cy="96" r="1.6" />
      </g>
      <path
        d="M100 16 138 30v28c0 22-16 36-38 44-22-8-38-22-38-44V30z"
        fill={`url(#${id}-shield)`}
        stroke="rgba(160,215,255,0.85)"
        strokeWidth="1.4"
      />
      <path
        d="M86 60 96 70 116 48"
        fill="none"
        stroke="#bfe6ff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  );
}

function Health({ id }: SceneProps) {
  return (
    <>
      <defs>
        <radialGradient id={`${id}-glow`}>
          <stop offset="0%" stopColor="rgba(120,240,180,0.44)" />
          <stop offset="100%" stopColor="rgba(8,20,16,0)" />
        </radialGradient>
        <linearGradient id={`${id}-leaf`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="rgba(90,220,160,0.9)" />
          <stop offset="100%" stopColor="rgba(190,255,220,0.95)" />
        </linearGradient>
      </defs>
      <ellipse cx="100" cy="74" rx="76" ry="46" fill={`url(#${id}-glow)`} />
      <path d="M100 108V56" stroke="rgba(150,240,200,0.85)" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M100 68C100 68 74 66 66 46c22-6 34 6 34 22z"
        fill={`url(#${id}-leaf)`}
        opacity="0.92"
      />
      <path
        d="M100 60C100 60 126 56 134 36c-22-6-34 6-34 24z"
        fill={`url(#${id}-leaf)`}
        opacity="0.78"
      />
      <path
        d="M100 84C100 84 80 82 74 66c16-4 26 4 26 18z"
        fill={`url(#${id}-leaf)`}
        opacity="0.6"
      />
      {/* motes: the "living system" note the artwork carries */}
      <g fill="rgba(190,255,225,0.8)">
        {Array.from({ length: 9 }, (_, index) => (
          <circle
            key={index}
            cx={40 + pseudoRandom(index + 3) * 120}
            cy={20 + pseudoRandom(index + 19) * 70}
            r={0.7 + pseudoRandom(index + 31) * 1.1}
          />
        ))}
      </g>
    </>
  );
}

function Finance({ id }: SceneProps) {
  // Deterministic, and shaped as a rising series: the artwork shows a market,
  // not noise.
  const candles = Array.from({ length: 11 }, (_, index) => {
    const drift = index * 4.4;
    const jitter = pseudoRandom(index + 7) * 18;
    const open = 88 - drift - jitter * 0.35;
    const close = open - 6 - pseudoRandom(index + 23) * 12;
    const up = close < open;
    return {
      x: 20 + index * 16,
      top: Math.min(open, close) - 5 - pseudoRandom(index + 13) * 7,
      bottom: Math.max(open, close) + 5 + pseudoRandom(index + 29) * 7,
      open,
      close,
      up,
    };
  });
  return (
    <>
      <defs>
        <radialGradient id={`${id}-glow`}>
          <stop offset="0%" stopColor="rgba(90,220,170,0.3)" />
          <stop offset="100%" stopColor="rgba(10,18,26,0)" />
        </radialGradient>
      </defs>
      <ellipse cx="100" cy="66" rx="84" ry="50" fill={`url(#${id}-glow)`} />
      <g stroke="rgba(140,170,210,0.14)" strokeWidth="0.6">
        {[28, 48, 68, 88].map((y) => (
          <path key={y} d={`M12 ${y}h176`} />
        ))}
      </g>
      {candles.map((candle, index) => {
        const tone = candle.up ? '#4fd6a3' : '#ff8d9c';
        return (
          <g key={index} stroke={tone} fill={tone}>
            <path d={`M${candle.x} ${candle.top}V${candle.bottom}`} strokeWidth="0.9" />
            <rect
              x={candle.x - 3.4}
              y={Math.min(candle.open, candle.close)}
              width="6.8"
              height={Math.max(2.5, Math.abs(candle.close - candle.open))}
              rx="1"
              opacity="0.92"
            />
          </g>
        );
      })}
    </>
  );
}

function Media({ id }: SceneProps) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-beam`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(190,130,255,0.5)" />
          <stop offset="100%" stopColor="rgba(190,130,255,0)" />
        </linearGradient>
        <radialGradient id={`${id}-glow`}>
          <stop offset="0%" stopColor="rgba(200,120,255,0.42)" />
          <stop offset="100%" stopColor="rgba(14,10,26,0)" />
        </radialGradient>
      </defs>
      <ellipse cx="100" cy="46" rx="86" ry="44" fill={`url(#${id}-glow)`} />
      {/* stage beams */}
      <g fill={`url(#${id}-beam)`}>
        <path d="M62 8 40 92h26L78 8z" />
        <path d="M100 6 88 92h24L112 6z" opacity="0.85" />
        <path d="M138 8 160 92h-26L122 8z" opacity="0.75" />
      </g>
      {/* crowd */}
      <g fill="rgba(10,14,28,0.92)">
        <path d="M0 104c14-10 22-4 30-9s16 3 24-3 18 5 26-1 18 6 26 1 18 4 26-2 18 7 26 2 22 6 22 6v16H0z" />
      </g>
      <g fill="rgba(230,200,255,0.55)">
        {Array.from({ length: 14 }, (_, index) => (
          <circle
            key={index}
            cx={10 + index * 13.5 + pseudoRandom(index + 5) * 6}
            cy={100 + pseudoRandom(index + 11) * 6}
            r="1.5"
          />
        ))}
      </g>
    </>
  );
}

const SCENES: Record<string, (props: SceneProps) => JSX.Element> = {
  communication: Communication,
  protection: Protection,
  'health-safety-environment': Health,
  finance: Finance,
  media: Media,
};

export function DomainArt({ domainId }: { readonly domainId: string }) {
  const Scene = SCENES[domainId];
  if (Scene === undefined) return null;
  return (
    <div className="domain-art" aria-hidden="true">
      <svg viewBox="0 0 200 120" preserveAspectRatio="xMidYMid slice" focusable="false">
        <Scene id={`art-${domainId}`} />
      </svg>
    </div>
  );
}
