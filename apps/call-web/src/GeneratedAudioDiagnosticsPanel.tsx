import { useState } from 'react';
import {
  formatDiagnostics,
  type GeneratedAudioDiagnosticEntry,
} from '@videofy-live/call-client-core';

/**
 * TEMPORARY on-device diagnostic surface — P6.3 pre-M1.
 *
 * The generated-audio failure only reproduces on a real Android phone, so this
 * has to be readable ON the phone. Requiring Android remote DevTools would mean
 * a cable and a second machine for every corpus run, which is how a
 * "reproduce it once more" turns into an afternoon.
 *
 * Shown only under `?diag=audio`. It is not part of the participant UI and
 * carries no user-facing wording.
 */
export interface GeneratedAudioDiagnosticsPanelProps {
  entries: readonly GeneratedAudioDiagnosticEntry[];
  latestFailure: GeneratedAudioDiagnosticEntry | null;
  onClear: () => void;
}

export function GeneratedAudioDiagnosticsPanel(
  props: GeneratedAudioDiagnosticsPanelProps,
): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = formatDiagnostics(props.entries);

  const handleCopy = (): void => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <section className="audio-diagnostics" aria-label="Generated audio diagnostics">
      <header className="audio-diagnostics__header">
        <strong>generated-audio diagnostics</strong>
        <span className="audio-diagnostics__count">{props.entries.length} events</span>
        <button type="button" onClick={() => setCollapsed((value) => !value)}>
          {collapsed ? 'show' : 'hide'}
        </button>
        <button type="button" onClick={handleCopy}>
          {copied ? 'copied' : 'copy'}
        </button>
        <button type="button" onClick={props.onClear}>
          clear
        </button>
      </header>
      {/*
        The classification is the point of the whole wave: "Enable audio"
        currently appears for a play() rejection AND for a media error, and
        those are unrelated faults.
      */}
      <p className="audio-diagnostics__reason">
        {props.latestFailure
          ? `${props.latestFailure.reason} — ${props.latestFailure.event}${
              props.latestFailure.errorName ? ` (${props.latestFailure.errorName})` : ''
            }`
          : 'no failure recorded'}
      </p>
      {collapsed ? null : <pre className="audio-diagnostics__log">{text}</pre>}
    </section>
  );
}
