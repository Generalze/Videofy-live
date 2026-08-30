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
 *   Row chevron (voice picker)     FUTURE disabled; no per-programme voice contract
 *   View Preflight                 REAL   hash navigation
 */
import React from 'react';
import type { AudioModePreferences } from '@videofy-live/shared-types';
import { Icon } from '../premium/icons';
import { Button, Chip, Eyebrow, NoticeBar, WaveBars, type Tone } from '../premium/primitives';
import { VOICE_STATUS_WORDS, type VoiceRow, type VoiceStatus } from '../voiceRows';
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

const VOICE_PICKER_HINT = 'Per-programme voice choice is not available yet; the registry chooses the voice for each language.';

function pct(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

/** The decorative spectrum to the right of the page title. Decoration only. */
export function AudioVoicesAside(): React.ReactElement {
  return (
    <div className={styles.aside}>
      <WaveBars seed={4} bars={110} height={124} palette="teal" />
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
            </p>
            {voices.length === 0 ? (
              <p className={styles.voicesEmpty}>No target languages yet. Add them under Languages and their voices appear here.</p>
            ) : (
              <ul className={styles.voiceList} aria-label="Voices per target language">
                {voices.map((row) => (
                  <li key={row.code} className={styles.voiceRow}>
                    <span className={styles.voiceTag} aria-hidden="true">
                      {row.code.slice(0, 3).toUpperCase()}
                    </span>
                    <span className={styles.voiceText}>
                      <span className={styles.voiceName}>{row.label}</span>
                      <span className={styles.voiceProvider}>{row.provider ?? 'Provider not reported yet'}</span>
                    </span>
                    <Chip tone={STATUS_TONE[row.status]} className={styles.voiceChip} title={row.reason}>
                      {VOICE_STATUS_WORDS[row.status]}
                    </Chip>
                    <button type="button" className={styles.voiceMore} disabled aria-disabled="true" title={VOICE_PICKER_HINT} aria-label={`Choose voice for ${row.label}: not available`}>
                      <Icon name="chevron-right" size={18} />
                    </button>
                  </li>
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
