/**
 * P6.4-W5 — Create or Join, once the product is chosen.
 *
 * Creating and joining are different jobs. A creator decides how the call
 * works, so the create path continues to Call Mode with a code already
 * generated for it. A joiner accepts a call that already exists — its type
 * and mode are the call's, not theirs (the wire snapshot is authoritative) —
 * so the join path goes straight to pre-join with the code field leading.
 */
import type { CallType } from './callTypes';

/** How this browser is entering the call: making it, or entering a code. */
export type CallJoinIntent = 'create' | 'join';

export interface CreateJoinScreenProps {
  callType: CallType;
  /**
   * Create path. The caller generates the call code (`generateCallCode` in
   * callFormState), records the 'create' intent, and advances to Call Mode.
   */
  onCreate: () => void;
  /** Join path. Records the 'join' intent and advances straight to pre-join. */
  onJoin: () => void;
  onBack: () => void;
}

export function CreateJoinScreen(props: CreateJoinScreenProps) {
  const personal = props.callType === 'personal';
  return (
    <main className="createjoin-screen">
      <button type="button" className="createjoin-back" onClick={props.onBack}>
        ← Back
      </button>
      <h1 className="createjoin-title">{personal ? 'Personal Call' : 'Conference'}</h1>
      <p className="createjoin-lede">
        {personal
          ? 'A one-to-one call. Start a new one, or join with a code you were given.'
          : 'A conference for up to four people. Start a new one, or join with a code you were given.'}
      </p>

      <div className="createjoin-choices">
        <button type="button" className="createjoin-choice" onClick={props.onCreate}>
          <span className="createjoin-choice-name">Create new call</span>
          <span className="createjoin-choice-hint">
            {personal
              ? 'You get a code to share with the other person.'
              : 'You get a code to share with up to three guests.'}
          </span>
        </button>

        <button type="button" className="createjoin-choice" onClick={props.onJoin}>
          <span className="createjoin-choice-name">Join with a code</span>
          <span className="createjoin-choice-hint">Enter the code someone shared with you.</span>
        </button>
      </div>
    </main>
  );
}
