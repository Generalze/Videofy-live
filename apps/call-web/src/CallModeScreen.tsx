import type { CallMode, CallType } from './callTypes';

/**
 * P6.4-W3.1/W5 — Call Mode selection.
 *
 * The contract: Normal is a direct original-voice call with the translation
 * engine fully inactive — no STT, no translation, no TTS, no personal voice.
 * That server behaviour exists now (W5: callMode is call-global, owner
 * authority, engine retired when normal), so Normal is a real choice. The
 * hint copy states what each mode does; it sells neither.
 */
export interface CallModeScreenProps {
  callType: CallType;
  onChooseMode: (mode: CallMode) => void;
  onBack: () => void;
}

export function CallModeScreen(props: CallModeScreenProps) {
  const noun = props.callType === 'conference' ? 'conference' : 'call';
  return (
    <main className="mode-screen">
      <button type="button" className="mode-back" onClick={props.onBack}>
        ← Back
      </button>
      <h1 className="mode-title">
        {props.callType === 'conference' ? 'New Conference' : 'New Personal Call'}
      </h1>
      <p className="mode-lede">How should this {noun} work?</p>

      <div className="mode-choices">
        <button
          type="button"
          className="mode-choice"
          onClick={() => props.onChooseMode('normal')}
        >
          <span className="mode-choice-name">Normal</span>
          <span className="mode-choice-hint">
            Direct call, original voices — no translation
          </span>
        </button>

        <button
          type="button"
          className="mode-choice"
          onClick={() => props.onChooseMode('translated')}
        >
          <span className="mode-choice-name">Translated</span>
          <span className="mode-choice-hint">
            Live translation, captions and translated voices
          </span>
        </button>
      </div>
    </main>
  );
}
