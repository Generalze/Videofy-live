/**
 * P6.4-W3.1 — the entry decision.
 *
 * Personal Call and Conference are distinct products under the locked
 * contract, not one setup dashboard trying to represent every state at once.
 * The choice made here shapes everything after it — copy, capacity, and
 * eventually the call surface itself — so it comes first and stands alone.
 */
import type { CallType } from './callTypes';

export type { CallType };

export interface HomeScreenProps {
  onChooseType: (type: CallType) => void;
}

export function HomeScreen(props: HomeScreenProps) {
  return (
    <main className="home-screen">
      <p className="home-eyebrow">Real-time translated calls</p>
      <h1 className="home-title">Videofy Live</h1>
      <p className="home-lede">Talk to anyone, in any language.</p>

      <div className="home-choices">
        <button
          type="button"
          className="home-choice"
          onClick={() => props.onChooseType('personal')}
        >
          <span className="home-choice-name">Personal Call</span>
          <span className="home-choice-hint">One-to-one conversation</span>
        </button>

        <button
          type="button"
          className="home-choice"
          onClick={() => props.onChooseType('conference')}
        >
          <span className="home-choice-name">Conference</span>
          <span className="home-choice-hint">Up to four people</span>
        </button>
      </div>
    </main>
  );
}
