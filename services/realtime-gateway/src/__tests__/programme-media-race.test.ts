/** @author masterzee001 */
/**
 * Media that arrives before anything has classified the session.
 *
 * THE RACE MY OWN FIRST-RUN TEST DID NOT MEET. It called `admitSession` and
 * then produced frames, so it proved "unknown delivery after admission is
 * safe" and never "media arriving before admission is safe". Those are
 * different windows, and the second one was open: the per-frame set listed the
 * FORBIDDEN, so a session nobody had classified relayed by default, and the
 * gateway's own guard returned true for a session with no run on the reasoning
 * that it must be an ordinary call.
 *
 * It is not an ordinary call. This path carries backend PROGRAMME media --
 * calls have their own runtime and their own receive peers -- so a session
 * with no run is a programme whose operator configuration has not arrived yet.
 * That is precisely the moment a broadcaster can publish into.
 *
 * The fix is not a sleep, an ordering promise, or an earlier admit call. The
 * set now lists what has been positively OPENED, so the question the media
 * path asks is "has anything cleared this?" and before any classification the
 * answer is no. There is no window left to arrive in, which is why these tests
 * never have to be careful about ordering.
 */
import { describe, expect, it } from 'vitest';
import {
  assessProgrammeDelivery,
  programmeDeliveryPolicy,
  type DeliveryChainFacts,
} from '@videofy-live/shared-types';
import { ProgrammeRelayAuthority } from '../programme-relay-authority.js';

const RUN = 'run_race';
const SESSION = 'session_race';

function delivery(mode: 'live' | 'delayed', over: Partial<DeliveryChainFacts> = {}) {
  return assessProgrammeDelivery({
    programmeRunId: RUN,
    facts: {
      configuredMode: mode,
      originConfigured: true,
      originRunning: true,
      initSegmentReady: true,
      publishedSegments: 12,
      timelineTracked: true,
      bufferState: 'active',
      egressAvailable: true,
      ...over,
    },
    publicManifestUrl: `https://ingest.example/programmes/${RUN}/playlist.m3u8`,
  });
}

/**
 * The gateway's real frame order, both media kinds.
 *
 * The encoder is fed BEFORE the relay guard returns, because the guard returns
 * early for a protected run -- a contribution placed after it would never run
 * for exactly the runs that need it.
 */
function publish(authority: ProgrammeRelayAuthority, kind: 'audio' | 'video', frames: number) {
  let contributed = 0;
  let relayed = 0;
  for (let i = 0; i < frames; i += 1) {
    contributed += 1;
    if (!authority.mayRelayFrames(SESSION)) continue;
    relayed += 1;
  }
  return { kind, contributed, relayed };
}

describe('media that beats the run binding', () => {
  for (const kind of ['audio', 'video'] as const) {
    it(`RELAYS NO ${kind.toUpperCase()} FRAME BEFORE THE RUN IS BOUND, on a protected deployment`, () => {
      const authority = new ProgrammeRelayAuthority();
      authority.notePolicy(programmeDeliveryPolicy('delayed'));
      // No run. No delivery announcement. A broadcaster is already publishing.
      const result = publish(authority, kind, 500);
      expect(result.relayed).toBe(0);
      // And the protected encoder still receives every frame: suppressing the
      // audience must not suppress the contribution, or a protected broadcast
      // produces no media at all behind a healthy gateway.
      expect(result.contributed).toBe(500);
    });

    it(`RELAYS NO ${kind.toUpperCase()} FRAME BEFORE THE RUN IS BOUND, on a gateway told nothing`, () => {
      // No policy either. The state that produced the leak, and the one a
      // fresh process is in for its first moments.
      const authority = new ProgrammeRelayAuthority();
      expect(publish(authority, kind, 500).relayed).toBe(0);
    });
  }

  it('still relays nothing once the run binds while delivery is unknown', () => {
    const authority = new ProgrammeRelayAuthority();
    authority.notePolicy(programmeDeliveryPolicy('delayed'));
    authority.admitSession(SESSION, RUN);
    expect(publish(authority, 'audio', 200).relayed).toBe(0);
    expect(publish(authority, 'video', 200).relayed).toBe(0);
  });

  it('still relays nothing once authoritative DELAYED arrives', () => {
    const authority = new ProgrammeRelayAuthority();
    authority.notePolicy(programmeDeliveryPolicy('delayed'));
    authority.admitSession(SESSION, RUN);
    authority.noteDelivery(delivery('delayed'));
    authority.applyToSession(SESSION, authority.decide(RUN).permitted);
    expect(publish(authority, 'audio', 200).relayed).toBe(0);
    expect(publish(authority, 'video', 200).relayed).toBe(0);
  });

  it('OPENS ONLY WHEN AUTHORITATIVE LIVE SAYS SO, AND NOT ONE FRAME EARLIER', () => {
    const authority = new ProgrammeRelayAuthority();
    authority.notePolicy(programmeDeliveryPolicy('delayed'));
    authority.admitSession(SESSION, RUN);

    const before = publish(authority, 'audio', 100);
    authority.noteDelivery(delivery('live'));
    authority.applyToSession(SESSION, authority.decide(RUN).permitted);
    const after = publish(authority, 'audio', 100);

    expect(before.relayed).toBe(0);
    expect(after.relayed).toBe(100);
  });
});

describe('a peer built before authority exists', () => {
  it('cannot carry frames merely because it exists', () => {
    /*
     * Peer creation and frame carriage are two separate gates on purpose. A
     * peer that exists and is expected not to carry frames is one bug away
     * from carrying them, so the frame path does not trust that the peer
     * gate ran -- it asks again, per frame, and defaults to no.
     */
    const authority = new ProgrammeRelayAuthority();
    authority.notePolicy(programmeDeliveryPolicy('delayed'));
    // Whatever built a peer, nothing has opened this session's frame path.
    expect(authority.mayRelayFrames(SESSION)).toBe(false);
    expect(publish(authority, 'audio', 50).relayed).toBe(0);
  });

  it('is torn down when a run turns out to be protected', () => {
    const authority = new ProgrammeRelayAuthority();
    authority.notePolicy(programmeDeliveryPolicy('live'));
    authority.applyToSession(SESSION, true);
    expect(authority.mayRelayFrames(SESSION)).toBe(true);

    // The run binds, and it is protected after all.
    authority.noteDelivery(delivery('delayed'));
    const wasOpen = authority.applyToSession(SESSION, authority.decide(RUN).permitted);
    expect(wasOpen).toBe(true);
    expect(authority.mayRelayFrames(SESSION)).toBe(false);
  });
});

describe('a run is what it is, in both directions', () => {
  it('refuses DELAYED becoming LIVE', () => {
    // Releasing the very material the run is holding, mid-broadcast, to an
    // audience that was told it was protected.
    const authority = new ProgrammeRelayAuthority();
    authority.noteDelivery(delivery('delayed'));
    expect(authority.noteDelivery(delivery('live'))).toBe(false);
    expect(authority.decide(RUN).permitted).toBe(false);
  });

  it('REFUSES LIVE BECOMING DELAYED', () => {
    /*
     * Only the other direction used to be refused, on the grounds that this
     * one leaks nothing -- true, and not the point. A run that can change what
     * it is has no fixed answer, and an audience told they were watching live
     * being silently moved behind a 45-second buffer is its own broken
     * promise. If the mode is to change, that is a new run.
     */
    const authority = new ProgrammeRelayAuthority();
    authority.noteDelivery(delivery('live'));
    expect(authority.noteDelivery(delivery('delayed'))).toBe(false);
    expect(authority.decide(RUN).permitted).toBe(true);
  });

  it('lets readiness change freely within one mode', () => {
    // The MODE is decided once. How ready that mode is may change as often as
    // the chain does.
    const authority = new ProgrammeRelayAuthority();
    authority.noteDelivery(delivery('delayed'));
    expect(authority.noteDelivery(delivery('delayed', { bufferState: 'failed' }))).toBe(true);
    expect(authority.decide(RUN).permitted).toBe(false);
  });
});

describe('a deployment that protects nothing still works', () => {
  it('relays once a live deployment has classified the session', () => {
    const authority = new ProgrammeRelayAuthority();
    authority.notePolicy(programmeDeliveryPolicy('live'));
    authority.admitSession(SESSION, RUN);
    expect(publish(authority, 'audio', 300).relayed).toBe(300);
    expect(publish(authority, 'video', 300).relayed).toBe(300);
  });

  it('treats an unbound session by the policy, not by the missing run', () => {
    const live = new ProgrammeRelayAuthority();
    live.notePolicy(programmeDeliveryPolicy('live'));
    expect(live.decideUnbound().permitted).toBe(true);

    const protectedDeployment = new ProgrammeRelayAuthority();
    protectedDeployment.notePolicy(programmeDeliveryPolicy('delayed'));
    expect(protectedDeployment.decideUnbound().permitted).toBe(false);

    // And a gateway nobody has told anything refuses, rather than guessing
    // that silence means an ordinary broadcast.
    expect(new ProgrammeRelayAuthority().decideUnbound().permitted).toBe(false);
    expect(new ProgrammeRelayAuthority().decideUnbound().refusal).toBe('no-delivery-authority');
  });
});
