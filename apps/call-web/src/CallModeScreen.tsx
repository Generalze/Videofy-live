import type { CallType } from './HomeScreen';

/**
 * P6.4-W3.1 — Call Mode selection, structurally.
 *
 * The contract: Normal is a direct original-voice call with the translation
 * engine fully inactive — no STT, no translation, no TTS, no personal voice.
 * That server behaviour is W5's, and it does not exist yet. So Normal is shown
 * and honestly disabled rather than being faked: a "Normal" call that secretly
 * ran the translation engine underneath would be exactly the kind of quiet
 * contradiction this redesign exists to remove.
 */
export interface CallModeScreenProps {
  callType: CallType;
  onChooseTranslated: () => void;
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
        <button type="button" className="mode-choice" disabled aria-disabled="true">
          <span className="mode-choice-name">Normal</span>
          <span className="mode-choice-hint">
            Direct call, original voices only — arrives with the Call Mode update
          </span>
        </button>

        <button type="button" className="mode-choice" onClick={props.onChooseTranslated}>
          <span className="mode-choice-name">Translated</span>
          <span className="mode-choice-hint">
            Live translation, captions and translated voices
          </span>
        </button>
      </div>
    </main>
  );
}
