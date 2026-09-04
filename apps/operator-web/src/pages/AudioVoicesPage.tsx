/** @author masterzee001 */
/**
 * Audio & Voices (step 3 of 6), to the golden master
 * 04-audio-voices-reference.png (founder directive, LOCKED 30 Aug 2026).
 *
 * Presentation only. The mode, the two levels and the subtitles flag are
 * App state; every change goes back through the handlers App already had,
 * which mark the mix as operator-adjusted and broadcast it over
 * operator:audio-mode-preferences to the channel's listeners (see
 * audioMixBroadcast.ts). Nothing here owns state or knows a socket.
 *
 * Classification of the master's controls:
 *   Interpretation | Replacement  REAL   AudioModePreferences.mode
 *   Original audio slider          REAL   originalVolume -> listener original gain
 *   Translated audio slider        REAL   translatedVolume -> listener translated gain
 *   Subtitles enabled              REAL   subtitlesEnabled
 *   Voice rows                     REAL   target-language catalogue (registry state)
 *   Row flag                       REAL   VoiceRow.flag, null in production -> code tag
 *   Standard / Premium chip        REAL   VoiceRow.grade, null in production -> status word
 *   Row chevron (voice picker)     REMOVED  no per-programme voice contract exists, and a
 *                                           control that cannot act must not promise one
 *   View Preflight                 REAL   hash navigation
 *
 * The flag and the grade are drawn only when the row carries them. Nothing
 * in the deployment resolves either today, so buildVoiceRows returns null for
 * both and the real console shows the language code and the availability
 * word. The master's six flagged, graded rows come from the visual fixture,
 * which production has no path to.
 */
import React from 'react';
import type { AudioModePreferences } from '@videofy-live/shared-types';
import { Icon } from '../premium/icons';
import { Button, Chip, Eyebrow, NoticeBar, type Tone } from '../premium/primitives';
import { VOICE_GRADE_WORDS, VOICE_STATUS_WORDS, type VoiceGrade, type VoiceRow, type VoiceStatus } from '../voiceRows';
import styles from './AudioVoicesPage.module.css';

export interface AudioVoicesPageProps {
  readonly mode: AudioModePreferences['mode'];
  readonly onModeChange: (mode: AudioModePreferences['mode']) => void;
  /** 0..1 */
  readonly originalMix: number;
  readonly translatedMix: number;
  readonly onOriginalMixChange: (value: number) => void;
  readonly onTranslatedMixChange: (value: number) => void;
  readonly subtitlesEnabled: boolean;
  readonly onSubtitlesEnabledChange: (enabled: boolean) => void;
  /** Connected listeners right now; decides the wording under the mode control. */
  readonly viewers: number;
  readonly voices: readonly VoiceRow[];
  readonly onViewPreflight: () => void;
}

const STATUS_TONE: Readonly<Record<VoiceStatus, Tone>> = {
  ready: 'success',
  limited: 'info',
  'captions-only': 'neutral',
  waiting: 'warn',
};

const STATUS_SKIN: Readonly<Partial<Record<VoiceStatus, string | undefined>>> = {
  waiting: styles.chipWaiting,
};

const GRADE_TONE: Readonly<Record<VoiceGrade, Tone>> = {
  standard: 'success',
  premium: 'violet',
};

const GRADE_SKIN: Readonly<Record<VoiceGrade, string | undefined>> = {
  standard: styles.chipStandard,
  premium: styles.chipPremium,
};


function pct(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

/* ------------------------------------------------------------------- Flags */

/**
 * The flags 04 draws, as bands rather than artwork: each is a list of
 * [fill, offset, size] along one axis of a 3 x 2 field. DECORATION beside a
 * language name; a row without a flag shows its language code instead.
 */
interface FlagBands {
  readonly axis: 'h' | 'v';
  readonly bands: readonly (readonly [string, number, number])[];
}

const THIRDS: readonly (readonly [number, number])[] = [
  [0, 1 / 3],
  [1 / 3, 1 / 3],
  [2 / 3, 1 / 3],
];

function thirds(a: string, b: string, c: string): readonly (readonly [string, number, number])[] {
  return THIRDS.map(([at, size], index) => [[a, b, c][index] as string, at, size] as const);
}

const FLAG_BANDS: Readonly<Record<string, FlagBands>> = {
  ES: { axis: 'h', bands: [['#c60b1e', 0, 0.25], ['#ffc400', 0.25, 0.5], ['#c60b1e', 0.75, 0.25]] },
  FR: { axis: 'v', bands: thirds('#002395', '#ffffff', '#ed2939') },
  DE: { axis: 'h', bands: thirds('#000000', '#dd0000', '#ffce00') },
  NG: { axis: 'v', bands: thirds('#008751', '#ffffff', '#008751') },
  SL: { axis: 'h', bands: thirds('#1eb53a', '#ffffff', '#0072c6') },
};

/** The Union Flag, drawn as its saltires and cross rather than as an image. */
function UnionFlag(): React.ReactElement {
  return (
    <>
      <rect width={60} height={30} fill="#012169" />
      <path d="M0 0 L60 30 M60 0 L0 30" stroke="#ffffff" strokeWidth={7} />
      <path d="M0 0 L60 30 M60 0 L0 30" stroke="#c8102e" strokeWidth={3} />
      <path d="M30 0 V30 M0 15 H60" stroke="#ffffff" strokeWidth={11} />
      <path d="M30 0 V30 M0 15 H60" stroke="#c8102e" strokeWidth={6} />
    </>
  );
}

function VoiceFlag({ code, label }: { readonly code: string; readonly label: string }): React.ReactElement | null {
  const key = code.toUpperCase();
  const bands = FLAG_BANDS[key];
  if (key !== 'GB' && bands === undefined) return null;
  return (
    <svg className={styles.voiceFlag} viewBox="0 0 60 30" preserveAspectRatio="none" role="img" aria-label={`${label} flag`}>
      {key === 'GB' || bands === undefined ? (
        <UnionFlag />
      ) : (
        bands.bands.map(([fill, at, size]) =>
          bands.axis === 'h' ? (
            <rect key={`${fill}${at}`} x={0} y={at * 30} width={60} height={size * 30} fill={fill} />
          ) : (
            <rect key={`${fill}${at}`} x={at * 60} y={0} width={size * 60} height={30} fill={fill} />
          ),
        )
      )}
    </svg>
  );
}

/* ---------------------------------------------------------------- Spectrum */

/** Deterministic pseudo-random in [0, 1): the same seed draws the same spectrum every render. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ASIDE_BARS = 55;
const ASIDE_PITCH = 9;
const ASIDE_HEIGHT = 144;

/**
 * The decorative spectrum to the right of the page title: 04's 2px teal bars
 * on a 9px pitch over a 495 x 144 field, swelling once past the middle and
 * tailing off to either side.
 * DECORATION ONLY: seeded, never fed by audio, hidden from assistive tech.
 */
export function AudioVoicesAside(): React.ReactElement {
  const random = mulberry32(9);
  const width = ASIDE_BARS * ASIDE_PITCH;
  const rects: React.ReactElement[] = [];
  for (let i = 0; i < ASIDE_BARS; i++) {
    const t = i / (ASIDE_BARS - 1);
    const envelope = Math.exp(-(((t - 0.56) / 0.28) ** 2));
    const spike = Math.pow(random(), 1.6);
    const h = Math.max(2, Math.round(ASIDE_HEIGHT * envelope * (0.2 + spike * 0.8)));
    rects.push(
      <rect
        key={i}
        x={i * ASIDE_PITCH}
        y={(ASIDE_HEIGHT - h) / 2}
        width={2}
        height={h}
        rx={1}
        fill="currentColor"
        opacity={0.35 + envelope * 0.65}
      />,
    );
    const echo = Math.max(1, Math.round(h * 0.34));
    rects.push(
      <rect key={`e${i}`} x={i * ASIDE_PITCH} y={ASIDE_HEIGHT * 0.72} width={2} height={echo} rx={1} fill="currentColor" opacity={0.12 + envelope * 0.14} />,
    );
  }
  return (
    <div className={styles.aside}>
      <svg className={styles.asideWave} viewBox={`0 0 ${width} ${ASIDE_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true" focusable="false" style={{ height: ASIDE_HEIGHT }}>
        {rects}
      </svg>
    </div>
  );
}

function LevelRow({
  id,
  label,
  value,
  tone,
  icon,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly tone: 'teal' | 'violet';
  readonly icon: React.ReactNode;
  readonly onChange: (value: number) => void;
}): React.ReactElement {
  const percent = pct(value);
  return (
    <div className={styles.level}>
      <span className={`${styles.levelIcon} ${tone === 'teal' ? styles.levelIconTeal : styles.levelIconViolet}`} aria-hidden="true">
        {icon}
      </span>
      <div className={styles.levelBody}>
        <div className={styles.levelHead}>
          <label htmlFor={id} className={styles.levelLabel}>
            {label}
          </label>
          <output htmlFor={id} className={`${styles.levelValue} ${tone === 'teal' ? styles.levelValueTeal : styles.levelValueViolet}`}>
            {percent}%
          </output>
        </div>
        <input
          id={id}
          type="range"
          min={0}
          max={100}
          step={5}
          value={percent}
          onChange={(event) => onChange(Number(event.target.value) / 100)}
          className={`${styles.slider} ${tone === 'teal' ? styles.sliderTeal : styles.sliderViolet}`}
          style={{ '--fill': `${percent}%` } as React.CSSProperties}
          aria-valuetext={`${percent}%`}
        />
        <div className={styles.marks} aria-hidden="true">
          <span>0%</span>
          <span>100%</span>
        </div>
      </div>
    </div>
  );
}

function VoiceRowItem({ row }: { readonly row: VoiceRow }): React.ReactElement {
  const graded = row.grade !== null;
  const word = graded ? VOICE_GRADE_WORDS[row.grade as VoiceGrade] : VOICE_STATUS_WORDS[row.status];
  const tone = graded ? GRADE_TONE[row.grade as VoiceGrade] : STATUS_TONE[row.status];
  const skin = (graded ? GRADE_SKIN[row.grade as VoiceGrade] : STATUS_SKIN[row.status]) ?? '';
  const flag = row.flag === null ? null : <VoiceFlag code={row.flag} label={row.label} />;
  return (
    <li className={styles.voiceRow}>
      {flag ?? (
        <span className={styles.voiceTag} aria-hidden="true">
          {row.code.slice(0, 3).toUpperCase()}
        </span>
      )}
      <span className={styles.voiceText}>
        <span className={styles.voiceName}>{row.label}</span>
        <span className={styles.voiceProvider}>{row.provider ?? 'Provider not reported yet'}</span>
      </span>
      <Chip tone={tone} className={`${styles.voiceChip} ${skin}`} title={row.reason}>
        {word}
      </Chip>
      {/*
        * NO CHEVRON. A disabled "choose voice" control sat here, permanently
        * un-pressable, promising an action nothing in this deployment can
        * perform: there is no per-programme voice contract, and the registry
        * picks the voice for each language.
        *
        * A control that cannot act must not look like one. It is removed
        * rather than styled quieter, and the fact it was carrying -- that the
        * choice is not the operator's -- is stated once for the whole list
        * instead of implied by every greyed-out row.
        */}
    </li>
  );
}

export function AudioVoicesPage({
  mode,
  onModeChange,
  originalMix,
  translatedMix,
  onOriginalMixChange,
  onTranslatedMixChange,
  subtitlesEnabled,
  onSubtitlesEnabledChange,
  viewers,
  voices,
  onViewPreflight,
}: AudioVoicesPageProps): React.ReactElement {
  const applied =
    viewers > 0
      ? `Applied to ${viewers === 1 ? 'the 1 viewer' : `all ${viewers} viewers`} watching now, and to viewers as they connect.`
      : 'Applied to viewers as they connect; nobody is watching yet.';

  return (
    <>
      <div className={styles.grid}>
        <section className={styles.panel} aria-labelledby="audio-mode-eyebrow">
          <div className={styles.panelBody}>
            <Eyebrow id="audio-mode-eyebrow" tone="muted" className={styles.eyebrow}>
              Audio mode
            </Eyebrow>
            <div className={styles.segmented} role="group" aria-label="Operator audio mode">
              <button
                type="button"
                className={mode === 'interpretation' ? styles.segmentActive : styles.segment}
                onClick={() => onModeChange('interpretation')}
                aria-pressed={mode === 'interpretation'}
              >
                <Icon name="waveform" size={18} />
                Interpretation
              </button>
              <button
                type="button"
                className={mode === 'replacement' ? styles.segmentActive : styles.segment}
                onClick={() => onModeChange('replacement')}
                aria-pressed={mode === 'replacement'}
              >
                <Icon name="swap" size={18} />
                Replacement
              </button>
            </div>
            <p className={styles.applied}>{applied}</p>
            <Chip tone="violet" className={styles.mixChip}>
              Original audio {pct(originalMix)}%
            </Chip>
            <hr className={styles.rule} />
            <LevelRow id="audio-original-level" label="Original audio" value={originalMix} tone="teal" icon={<Icon name="mic" size={22} />} onChange={onOriginalMixChange} />
            <LevelRow id="audio-translated-level" label="Translated audio" value={translatedMix} tone="violet" icon={<Icon name="waveform" size={22} />} onChange={onTranslatedMixChange} />
          </div>
          <div className={styles.panelFoot}>
            <label className={styles.subtitles}>
              <input type="checkbox" checked={subtitlesEnabled} onChange={(event) => onSubtitlesEnabledChange(event.target.checked)} className={styles.checkbox} />
              <span className={styles.subtitlesText}>
                <span className={styles.subtitlesLabel}>Subtitles enabled</span>
                <span className={styles.subtitlesNote}>
                  {subtitlesEnabled ? 'Subtitles will be shown to viewers in their selected language.' : 'Viewers will hear the programme without subtitles.'}
                </span>
              </span>
            </label>
          </div>
        </section>

        <section className={styles.panel} aria-labelledby="voices-eyebrow">
          <div className={styles.panelBody}>
            <Eyebrow id="voices-eyebrow" tone="muted" className={styles.eyebrow}>
              Voices
            </Eyebrow>
            <p className={styles.voicesLede}>
              Each target language uses a voice selected by the deployment&rsquo;s registry.
              <br />
              Status reflects current voice availability.
              {/*
                * SAID PLAINLY RATHER THAN LEFT TO BE INFERRED. Nothing on this
                * deployment resolves a commercial grade, so the chip shows
                * availability instead. Without this line an operator reading
                * "Available" could reasonably assume a grade had been assessed
                * and found unremarkable, which is a different claim.
                */}
              <br />
              Voices are not commercially graded on this deployment, and the voice for a
              language is not an operator choice.
            </p>
            {voices.length === 0 ? (
              <p className={styles.voicesEmpty}>No target languages yet. Add them under Languages and their voices appear here.</p>
            ) : (
              <ul className={styles.voiceList} aria-label="Voices per target language">
                {voices.map((row) => (
                  <VoiceRowItem key={row.code} row={row} />
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      <NoticeBar
        className={styles.notice}
        icon={<Icon name="info" size={22} />}
        action={
          <Button variant="secondary" className={styles.noticeButton} icon={<Icon name="shield-check" size={18} />} iconAfter={<Icon name="chevron-right" size={16} />} onClick={onViewPreflight}>
            View Preflight
          </Button>
        }
      >
        Voices are provisioned per language. Changes may take a few moments to apply.
      </NoticeBar>
    </>
  );
}
