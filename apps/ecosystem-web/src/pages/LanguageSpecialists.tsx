/** @author masterzee001 */
/**
 * The public recruitment page, at `/language-specialists/`.
 *
 * IT IS A MARKETING PAGE AND IT USES THE MARKETING SYSTEM. The site's own
 * classes -- `.shell`, `.hero`, `.button-primary`, `.section-title`,
 * `.domain-field` -- carry the C7 public language, and this page is a sibling
 * of `/videofy/live/` rather than a visitor from another product. The portal
 * behind the sign-in wall is a different matter and uses the Videofy design
 * system, because that is what a product surface is built from here.
 *
 * WHAT THIS PAGE MUST NOT SAY. No royalties, no rewards, no compensation, no
 * future payment, no employment. Not because the words are awkward but because
 * they are promises C7 has not made, to people who are volunteering their
 * knowledge. `FORBIDDEN_PUBLIC_TERMS` in `@videofy-live/language-specialist`
 * names them and a test asserts this file's rendered markup contains none --
 * copy is edited far more often than it is reviewed, so the guard is mechanical.
 *
 * IT ALSO MUST NOT PROMISE VOICE WORK. The permission a specialist gives is a
 * licence over text they write. A recruitment page that mentions "your voice"
 * would be recruiting for a programme that does not exist under terms nobody
 * has drafted.
 *
 * THE CTA IS THE EXISTING C7 SIGN-IN. There is no second registration form on
 * this page: signed out, "Apply" goes to the one join surface the site has;
 * signed in, it goes to the portal. A second form would be a second place the
 * registration rules live.
 */
import { useEffect, useState } from 'react';
import { ROUTE_PATHS, internalLink, pathLink, type Route } from '../router';
import { hasSession } from '../session';
import { Icon, type IconName } from './icons';

const ACCOUNT_URL = (
  (import.meta.env['VITE_ACCOUNT_URL'] as string | undefined) ?? 'http://localhost:3006'
).replace(/[/]$/u, '');

/**
 * The languages shown in the hero.
 *
 * A STATIC LIST, and deliberately so: this is artwork, it renders before any
 * request completes, and a hero that pops in after a fetch is worse than one
 * that is a frame behind the truth. The AUTHORITATIVE list is fetched below and
 * rendered in the "Languages open now" section; if the two ever disagree, the
 * section is the one that is right, and the discrepancy is visible on the page
 * rather than hidden.
 */
const HERO_LANGUAGES = [
  { label: 'Yorùbá', x: 30, y: 46 },
  { label: 'Hausa', x: 58, y: 26 },
  { label: 'Igbo', x: 36, y: 62 },
  { label: 'Français', x: 72, y: 42 },
  { label: 'Português', x: 66, y: 76 },
];

/** What a specialist is asked to judge. The four columns of the review packet. */
const FACETS: readonly { name: string; body: string; icon: IconName }[] = [
  {
    icon: 'target',
    name: 'Meaning & accuracy',
    body: 'Whether the message still says what it said. A translation that reverses a "not" is the failure that matters most.',
  },
  {
    icon: 'wave',
    name: 'Natural & fluent',
    body: 'Whether it reads like something a person would actually send, rather than something a machine assembled.',
  },
  {
    icon: 'letters',
    name: 'Terms & pronunciation',
    body: 'Whether names, numbers, amounts and codes survive intact, and whether words are said the way they are said.',
  },
  {
    icon: 'globe',
    name: 'Cultural relevance',
    body: 'Whether it lands correctly for the people who speak the language, not merely correctly in the abstract.',
  },
];

/** Eligibility, in the words of the existing reviewer instructions. */
const LOOKING_FOR: readonly { name: string; body: string; icon: IconName }[] = [
  {
    icon: 'person',
    name: 'Native or highly fluent',
    body: 'You speak the language as your own, or well enough that a mistake in it is obvious to you.',
  },
  {
    icon: 'pen',
    name: 'Strong reading and writing',
    body: 'You can write the language as you would really type it, not only speak it.',
  },
  {
    icon: 'translate',
    name: 'Explain meaning in English',
    body: 'You can say what a message MEANS in English. Not a polished translation — the meaning.',
  },
  {
    icon: 'chat',
    name: 'Understands real messaging',
    body: 'You know how people actually write to family, friends and people they do business with.',
  },
  {
    icon: 'flag',
    name: 'Can spot a wrong translation',
    body: 'You can tell when a translation is misleading, not merely awkward, and say which.',
  },
  {
    icon: 'shield',
    name: 'Comfortable with blind review',
    body: 'You are willing to judge translations without being told which system produced them.',
  },
];

/**
 * The five steps, and step 5 is the honest one.
 *
 * It says "help improve" rather than naming a role, a schedule or a
 * relationship, because none of those has been agreed. An overstated step 5 is
 * the easiest place on this page for a promise to appear by accident.
 */
const STEPS = [
  { name: 'Apply', body: 'Create or sign in to your C7 account and tell us which languages you speak.' },
  { name: 'Assessment', body: 'Complete a short language assessment. For some languages it starts with writing fifteen short messages.' },
  { name: 'Review', body: 'We read what you submitted. Nothing you send is edited afterwards; it is locked as you sent it.' },
  { name: 'Qualify', body: 'Qualification is decided per language, and you are told the outcome for each one.' },
  { name: 'Contribute', body: 'Qualified specialists help C7 improve multilingual communication in the languages they qualified in.' },
];

interface ProgrammeLanguage {
  readonly language: string;
  readonly englishName: string;
  readonly nativeName: string;
  readonly requiresSourceElicitation: boolean;
}

/**
 * The dotted-world artwork behind the hero language chips.
 *
 * Inline SVG rather than an image: it is two colours from the page's own
 * palette, it has to recolour with the theme, and a PNG of a dot grid is a
 * download that will look wrong on a high-density screen. `aria-hidden`,
 * because it says nothing a screen reader needs -- the language names beside it
 * are real text.
 */
function LanguageField() {
  const dots: { cx: number; cy: number; on: boolean }[] = [];
  for (let row = 0; row < 16; row += 1) {
    for (let column = 0; column < 34; column += 1) {
      /*
       * A deterministic mask, not Math.random(): the artwork must be identical
       * on every render and in every screenshot, or a visual diff reports a
       * change on a page nobody edited.
       */
      const wave = Math.sin(column * 0.42) * 2.6 + Math.cos(row * 0.55) * 2.2;
      const on = (column * 7 + row * 13 + Math.round(wave) + 40) % 5 < 3;
      dots.push({ cx: 12 + column * 20, cy: 14 + row * 20, on });
    }
  }
  return (
    <svg className="ls-field" viewBox="0 0 700 330" aria-hidden="true" focusable="false">
      {dots.map((dot, index) => (
        <circle
          key={index}
          cx={dot.cx}
          cy={dot.cy}
          r={dot.on ? 2.1 : 1.2}
          className={dot.on ? 'ls-field-dot ls-field-dot-on' : 'ls-field-dot'}
        />
      ))}
    </svg>
  );
}

export function LanguageSpecialists({
  navigate,
}: {
  readonly navigate: (route: Route, hash?: string) => void;
}) {
  const [languages, setLanguages] = useState<readonly ProgrammeLanguage[] | null>(null);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    setAuthed(hasSession());
  }, []);

  useEffect(() => {
    let cancelled = false;
    /*
     * The programme description is PUBLIC and unauthenticated. Adding a seventh
     * language should be a deployment, not a release of this bundle, so the
     * list below is the server's and not a copy of it.
     */
    void fetch(`${ACCOUNT_URL}/specialists/programme`)
      .then(async (response) => (response.ok ? ((await response.json()) as { languages: ProgrammeLanguage[] }) : null))
      .then((body) => {
        if (!cancelled && body !== null) setLanguages(body.languages);
      })
      .catch(() => {
        /* The page is complete without it; the section simply does not render. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * Signed out, "Apply" is the site's ONE join surface. Signed in, it is the
   * portal. Deciding here rather than in the button keeps both CTAs on the page
   * in agreement with each other.
   */
  const applyProps = authed
    ? pathLink(ROUTE_PATHS.specialist)
    : internalLink('c7', navigate, '#join');

  /*
   * A DIV, not a <main>. App.tsx already wraps every route in one `<main
   * id="main">`, which is what the skip link targets. A second one here nested
   * a landmark inside a landmark and put the id on two elements, so the skip
   * link had an ambiguous target and a screen reader was offered two "main"
   * regions on one page. Every other page in this app renders sections into the
   * shell's main for exactly this reason.
   */
  return (
    <div className="page ls">
      <section className="hero ls-hero">
        <div className="shell hero-shell ls-hero-shell">
          <div className="ls-hero-copy">
            <p className="ls-eyebrow">Become a C7 Language Specialist</p>
            <h1 className="hero-title ls-title">
              Help C7 improve
              <br />
              <span className="ls-title-accent">multilingual communication</span>
            </h1>
            <p className="hero-lede ls-lede">
              Join a network of language experts who help C7 evaluate translation quality, natural
              wording, terminology, pronunciation and cultural accuracy — in the languages they
              speak and write fluently.
            </p>
            <div className="hero-actions">
              <a className="button button-primary" {...applyProps}>
                Apply as a Language Specialist
              </a>
              <a className="button button-ghost" href="#what-we-look-for">
                Learn more
              </a>
            </div>
          </div>

          <div className="ls-hero-art" aria-hidden="true">
            <LanguageField />
            {HERO_LANGUAGES.map((language) => (
              <span
                key={language.label}
                className="ls-chip"
                style={{ left: `${language.x}%`, top: `${language.y}%` }}
              >
                {language.label}
              </span>
            ))}
          </div>
        </div>

        <div className="shell ls-facets">
          {FACETS.map((facet) => (
            <article className="ls-facet" key={facet.name}>
              <span className="ls-badge">
                <Icon name={facet.icon} />
              </span>
              <h2 className="ls-facet-name">{facet.name}</h2>
              <p className="ls-facet-body">{facet.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="ls-section" id="what-we-look-for">
        <div className="shell">
          <p className="section-field">Eligibility</p>
          <h2 className="section-title">Who we are looking for</h2>
          <p className="section-lede">
            You do not need a linguistics qualification. You need to know the language well enough
            that a wrong translation is obvious to you, and to be able to say why.
          </p>
          <div className="ls-grid">
            {LOOKING_FOR.map((entry) => (
              <article className="ls-card" key={entry.name}>
                <span className="ls-badge">
                  <Icon name={entry.icon} />
                </span>
                <h3 className="ls-card-name">{entry.name}</h3>
                <p className="ls-card-body">{entry.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {languages === null ? null : (
        <section className="ls-section ls-section-tight">
          <div className="shell">
            <p className="section-field">Open now</p>
            <h2 className="section-title">Languages accepting applications</h2>
            <ul className="ls-languages">
              {languages.map((language) => (
                <li className="ls-language" key={language.language}>
                  <span className="ls-language-native">{language.nativeName}</span>
                  <span className="ls-language-english">{language.englishName}</span>
                  {language.requiresSourceElicitation ? (
                    /*
                     * Said plainly on the public page, because it is the part
                     * that costs a volunteer twenty minutes and it should not
                     * be a surprise discovered after signing up.
                     */
                    <span className="ls-language-note">Begins with writing 15 short messages</span>
                  ) : (
                    <span className="ls-language-note">Begins with a translation review</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <section className="ls-section">
        <div className="shell">
          <p className="section-field">The process</p>
          <h2 className="section-title">How it works</h2>
          <ol className="ls-steps">
            {STEPS.map((step, index) => (
              <li className="ls-step" key={step.name}>
                <span className="ls-step-index">{index + 1}</span>
                <h3 className="ls-step-name">{step.name}</h3>
                <p className="ls-step-body">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="ls-section ls-close">
        <div className="shell ls-close-shell">
          <h2 className="section-title">Apply as a Language Specialist</h2>
          <p className="section-lede">
            {authed
              ? 'You are signed in to C7. Continue to the specialist portal to choose your languages.'
              : 'You need a C7 account. It is the same account you would use for any other C7 product.'}
          </p>
          <div className="hero-actions">
            <a className="button button-primary" {...applyProps}>
              {authed ? 'Open the specialist portal' : 'Create your C7 account'}
            </a>
            <a className="button button-outline" href="mailto:languages@consummate7.com">
              languages@consummate7.com
            </a>
          </div>
          {/*
            The boundary, stated to the people it protects rather than buried in
            a policy. Somebody deciding whether to contribute their writing is
            entitled to know, before they sign up, that it is not a voice
            programme and that nothing here enrols them in one.
          */}
          <p className="ls-boundary">
            Language Specialists contribute their knowledge of written and spoken language. This is
            not a voice programme: nothing here collects, records or uses anyone&rsquo;s voice, and
            any future voice participation would be a separate invitation with its own agreement.
          </p>
        </div>
      </section>
    </div>
  );
}
