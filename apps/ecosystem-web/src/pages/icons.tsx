/** @author masterzee001 */
/**
 * Line glyphs for the Language Specialist page.
 *
 * INLINE SVG, ONE STROKE WEIGHT, NO ICON FONT AND NO DEPENDENCY. Ten small
 * marks do not justify a package, and an icon font would download a file to
 * draw ten shapes and render as boxes while it loaded. They are `currentColor`
 * throughout so a tile decides its own tint.
 *
 * `aria-hidden` on every one. Each sits beside a real heading that says the same
 * thing; announced, they would make a screen reader read every tile title twice.
 * An icon that carries meaning nothing else carries would need a label — none
 * here does, and that is a property worth keeping.
 *
 * The 24-unit grid and 1.6 stroke match the operator console's own icon set, so
 * the two surfaces do not disagree about what a C7 line icon looks like.
 */

export type IconName =
  | 'target'
  | 'wave'
  | 'letters'
  | 'globe'
  | 'person'
  | 'pen'
  | 'translate'
  | 'chat'
  | 'flag'
  | 'shield';

const PATHS: Readonly<Record<IconName, JSX.Element>> = {
  /* Meaning and accuracy: a mark and the point it has to hit. */
  target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 1.6v2.6M12 19.8v2.6M1.6 12h2.6M19.8 12h2.6" />
    </>
  ),
  /* Natural and fluent: speech, as a waveform rather than a bubble. */
  wave: (
    <>
      <path d="M3 12h2M8 12h2M13 12h2M18 12h3" />
      <path d="M5 7.5v9M10 5v14M15 8.5v7M18 10v4" />
    </>
  ),
  /* Terms and pronunciation: characters that must survive intact. */
  letters: (
    <>
      <path d="M4 17 8 7l4 10M5.4 14h5.2" />
      <path d="M20 8.5v9M20 8.5c-2.6 0-4 1.6-4 4.5s1.4 4.5 4 4.5" />
    </>
  ),
  /* Cultural relevance: the world the language is spoken in. */
  globe: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M3.6 12h16.8" />
      <path d="M12 3.6c2.4 2.5 3.6 5.3 3.6 8.4s-1.2 5.9-3.6 8.4c-2.4-2.5-3.6-5.3-3.6-8.4S9.6 6.1 12 3.6Z" />
    </>
  ),
  /* Native or highly fluent: a person. */
  person: (
    <>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M5 20c0-3.6 3.1-5.6 7-5.6s7 2 7 5.6" />
    </>
  ),
  /* Strong reading and writing. */
  pen: (
    <>
      <path d="M4 20l1-4 11-11 3 3L8 19l-4 1Z" />
      <path d="M14.5 6.5l3 3" />
    </>
  ),
  /* Explain meaning in English: one thing said as another. */
  translate: (
    <>
      <path d="M3 6h9M7.5 4v2M10 6c0 4-3 7-7 7" />
      <path d="M5 9.5c1.6 2.6 3.9 4.2 6.5 4.6" />
      <path d="M13 21l4-10 4 10M14.6 17.4h4.8" />
    </>
  ),
  /* Understands real messaging. */
  chat: (
    <>
      <path d="M4 5.5h16v11H9.5L5 20.5V16.5H4Z" />
      <path d="M8 9.5h8M8 12.5h5" />
    </>
  ),
  /* Can spot a wrong translation. */
  flag: (
    <>
      <path d="M6 21V4" />
      <path d="M6 5h11l-2 3.5L17 12H6Z" />
    </>
  ),
  /* Comfortable with blind review: what is withheld is protected. */
  shield: (
    <>
      <path d="M12 3l7 2.6v5.6c0 4.2-2.8 7.7-7 9.8-4.2-2.1-7-5.6-7-9.8V5.6Z" />
      <path d="M9.2 12.2l2 2 3.6-4" />
    </>
  ),
};

export function Icon({ name }: { readonly name: IconName }) {
  return (
    <svg
      className="ls-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
