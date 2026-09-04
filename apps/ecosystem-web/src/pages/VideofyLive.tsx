/**
 * LAYER 3 — the VIDEOFY-LIVE product page.
 *
 * Its job is understanding, and then wanting to use it. This is the only page
 * that explains the product, and the only one rich enough to show it working.
 *
 * The demonstrations are STAGED PRODUCT SURFACES, not diagrams with arrows:
 * they show what a session looks like. They are also not screenshots — nothing
 * here claims to be a recording of a real call, and no fabricated participant
 * is presented as a customer.
 */
import { hasSession } from '../session';
import { Reveal } from '../components';
import {
  COMMUNICATION_SURFACES,
  LANGUAGE_ROLLOUT_NOTE,
  LISTENING_MODES,
  LIVE_EXPERIENCES,
  SURFACE_REACH_LABEL,
  UPLOADED_PROGRAMME_FLOW,
  VALIDATED_LANGUAGES,
  type SurfaceReach,
} from '../videofy';
import { VIDEOFY_CAPABILITIES } from '../domains';

function SpeechWave({ active = true }: { readonly active?: boolean }) {
  return (
    <span className={`wave${active ? ' wave-live' : ''}`} aria-hidden="true">
      {[0, 1, 2, 3, 4, 5, 6].map((bar) => (
        <span key={bar} style={{ animationDelay: `${bar * 0.12}s` }} />
      ))}
    </span>
  );
}

/** A person in a staged session. Initials, not stock photography. */
function Seat({
  initials,
  name,
  language,
  role,
  speaking,
}: {
  readonly initials: string;
  readonly name: string;
  readonly language: string;
  readonly role: 'Speaking' | 'Listening';
  readonly speaking?: boolean;
}) {
  return (
    <div className={`seat${speaking ? ' seat-speaking' : ''}`}>
      <span className="seat-avatar" aria-hidden="true">
        {initials}
      </span>
      <span className="seat-meta">
        <span className="seat-name">{name}</span>
        <span className="seat-lang">
          {role}: {language}
        </span>
      </span>
    </div>
  );
}

function CallDemo() {
  return (
    <div className="stage stage-call">
      <div className="stage-bar">
        <span className="stage-live">
          <span className="stage-live-dot" aria-hidden="true" />
          Live
        </span>
        <span className="stage-timer">00:02:34</span>
      </div>
      <div className="stage-body stage-two">
        <Seat initials="AM" name="Amara" language="English" role="Speaking" speaking />
        <div className="stage-flow" aria-hidden="true">
          <SpeechWave />
          <span className="stage-flow-label">interpreting</span>
        </div>
        <Seat initials="LC" name="Lucía" language="Spanish" role="Listening" />
      </div>
      <div className="stage-captions">
        <p className="caption-line caption-source">“It’s really good to finally meet you.”</p>
        <p className="caption-line caption-target">“Es un placer conocerte por fin.”</p>
      </div>
      <div className="stage-controls" aria-hidden="true">
        <span className="ctrl" />
        <span className="ctrl" />
        <span className="ctrl ctrl-end" />
        <span className="ctrl" />
      </div>
    </div>
  );
}

function ConferenceDemo() {
  // Spanish only. A row of five flags makes a better screenshot and is a claim
  // that five languages work in production today -- the kind of claim a visitor
  // tests by picking one.
  const listeners = [
    { initials: 'JD', name: 'Jonas', language: 'Spanish' },
    { initials: 'RK', name: 'Rina', language: 'Spanish' },
    { initials: 'TB', name: 'Tobi', language: 'English' },
  ];
  return (
    <div className="stage stage-conference">
      <div className="stage-bar">
        <span className="stage-live">
          <span className="stage-live-dot" aria-hidden="true" />
          Live
        </span>
        <span className="stage-count">18 participants</span>
      </div>
      <div className="stage-body stage-fan">
        <div className="fan-speaker">
          <Seat initials="MK" name="Michael" language="English" role="Speaking" speaking />
          <SpeechWave />
        </div>
        <ul className="fan-listeners">
          {listeners.map((listener) => (
            <li key={listener.initials}>
              <Seat
                initials={listener.initials}
                name={listener.name}
                language={listener.language}
                role="Listening"
              />
            </li>
          ))}
        </ul>
      </div>
      <p className="stage-note">One spoken source, delivered in each participant’s selected supported language.</p>
    </div>
  );
}

function ProgrammeDemo() {
  return (
    <div className="stage stage-programme">
      <div className="programme-surface" aria-hidden="true">
        <span className="programme-live">
          <span className="stage-live-dot" />
          Live
        </span>
        <span className="programme-title">Sample programme — Opening session</span>
        <SpeechWave />
      </div>
      <div className="programme-controls">
        <fieldset className="mode-set">
          <legend>Choose your audio</legend>
          {LISTENING_MODES.map((mode, index) => (
            <label key={mode.name} className="mode-option">
              <input type="radio" name="listening-mode" defaultChecked={index === 1} readOnly />
              <span className="mode-name">{mode.name}</span>
              <span className="mode-desc">{mode.description}</span>
            </label>
          ))}
        </fieldset>
        <div className="lang-set">
          <span className="lang-label">Listen in</span>
          <ul className="lang-list">
            {VALIDATED_LANGUAGES.map((language, index) => (
              <li key={language} className={index === 1 ? 'lang-on' : undefined}>
                {language}
              </li>
            ))}
          </ul>
          <span className="lang-note">
            Captions available alongside any mode. {LANGUAGE_ROLLOUT_NOTE}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * The convergence visual.
 *
 * Grouped by REACH, and each group is labelled with what that reach means.
 * A planned environment cannot be styled into looking shipped, because the
 * label sits above the group rather than in a legend somewhere else on the
 * page — and a legend is exactly the part people do not read.
 */
function ConvergenceFigure() {
  const groups: readonly SurfaceReach[] = ['working', 'in-development', 'network-expansion'];
  return (
    <Reveal className="converge">
      <div className="converge-groups">
        {groups.map((reach) => (
          <div key={reach} className={`converge-group converge-${reach}`}>
            <p className="converge-heading">{SURFACE_REACH_LABEL[reach]}</p>
            <ul className="converge-list">
              {COMMUNICATION_SURFACES.filter((surface) => surface.reach === reach).map(
                (surface) => (
                  <li key={surface.label}>{surface.label}</li>
                ),
              )}
            </ul>
          </div>
        ))}
      </div>
      <div className="converge-spine" aria-hidden="true">
        <span />
      </div>
      <div className="converge-core">VIDEOFY-LIVE</div>
      <div className="converge-spine" aria-hidden="true">
        <span />
      </div>
      <p className="converge-out">People understanding each other, in a language they can follow</p>
    </Reveal>
  );
}

/*
 * THE FUNNEL, NOT A TRAPDOOR. "Start a live conversation" used to drop
 * everybody -- signed in or not -- straight onto the call product. Signed
 * out, the honest primary action is joining C7; the call page would only
 * refuse to host anyway, one screen later and with less explanation. JOINING
 * somebody else's call stays open to everybody by design, so that door
 * remains, named for what it is.
 */
function primaryCta(): { href: string; label: string } {
  return hasSession()
    ? { href: '/call/', label: 'Start a live conversation' }
    : { href: '/#join', label: 'Join C7 to start calls' };
}

export function VideofyLive() {
  return (
    <>
      <header className="hero hero-live">
        <div className="hero-field hero-field-live" aria-hidden="true" />
        <div className="shell hero-shell">
          <p className="hero-eyebrow">Videofy · Available now</p>
          <h1 className="hero-title hero-title-live">VIDEOFY-LIVE</h1>
          <p className="hero-sub hero-sub-live">
            Speak naturally.
            <br />
            <span className="hero-title-accent">Understand globally.</span>
          </p>
          <p className="hero-lede">
            Real-time multilingual voice communication and interpretation across conversations,
            conferences and live programmes.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href={primaryCta().href}>
              {primaryCta().label}
            </a>
            <a className="button button-ghost" href="#experiences">
              Explore how it works
            </a>
            {!hasSession() && (
              <a className="button button-ghost" href="/call/">
                Have an invite? Join a call
              </a>
            )}
          </div>
        </div>
      </header>

      <section id="experiences" className="experiences">
        <div className="shell">
          {LIVE_EXPERIENCES.map((experience, index) => (
            <Reveal
              key={experience.id}
              as="article"
              className={`experience${index % 2 === 1 ? ' experience-flip' : ''}`}
            >
              <div className="experience-copy">
                <p className="section-field">{experience.eyebrow}</p>
                <h2 className="experience-title">{experience.title}</h2>
                <p className="experience-body">{experience.body}</p>
              </div>
              <div className="experience-stage">
                <p className="demo-label">Product demo — sample experience</p>
                {experience.id === 'call' ? <CallDemo /> : null}
                {experience.id === 'conference' ? <ConferenceDemo /> : null}
                {experience.id === 'programme' ? <ProgrammeDemo /> : null}
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="uploaded">
        <div className="shell">
          <p className="section-field">Uploaded programmes</p>
          <h2 className="section-title">A recording is a programme too.</h2>
          <p className="section-lede">
            A programme you upload travels the same path as a live one, and arrives in the language
            the listener chose.
          </p>
          <Reveal as="ol" className="flow">
            {UPLOADED_PROGRAMME_FLOW.map((step, index) => (
              <li key={step} className="flow-step">
                <span className="flow-index" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="flow-label">{step}</span>
              </li>
            ))}
          </Reveal>
        </div>
      </section>

      <section className="universality">
        <div className="shell">
          <p className="section-field">Where it reaches</p>
          <h2 className="section-title">Built to span how people actually communicate.</h2>
          <p className="section-lede">
            Videofy-Live runs in the browser today and carries translated media over SIP and RTP.
            The environments below are grouped by what is working now and what is being built
            toward.
          </p>
          <ConvergenceFigure />
        </div>
      </section>

      <section className="truth">
        <div className="shell">
          <div className="truth-grid">
            {VIDEOFY_CAPABILITIES.map((group) => (
              <Reveal key={group.heading} className="truth-group">
                <h3 className="truth-heading">{group.heading}</h3>
                <p className="truth-qualifier">{group.qualifier}</p>
                <ul className="truth-list">
                  {group.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </Reveal>
            ))}
          </div>
          <div className="truth-cta">
            <a className="button button-primary" href={primaryCta().href}>
              {primaryCta().label}
            </a>
            <a className="button button-ghost" href="/listen/">
              Open the programme viewer
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
