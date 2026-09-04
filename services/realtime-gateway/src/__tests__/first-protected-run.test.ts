/** @author masterzee001 */
/**
 * The first protected run after a fresh gateway process.
 *
 * Every previous test of this seam asked about a run whose delivery answer had
 * already arrived, and every one of them passed while the product leaked. The
 * old rule permitted an unannounced run unless this process had already seen a
 * delayed announcement -- and on a fresh process it had seen none. So the
 * FIRST protected broadcast relayed the broadcaster's audio and video to
 * realtime listeners for the window between publishing and the announcement
 * landing, which is exactly the window a safety delay exists to cover.
 *
 * The run that leaks is the one nobody rehearses: the first after a restart.
 * So these tests start from a process that knows nothing, and they count
 * frames rather than reading source text -- a source-text assertion agreed
 * with the old behaviour perfectly.
 */
import { describe, expect, it } from 'vitest';
import {
  assessProgrammeDelivery,
  programmeDeliveryPolicy,
  type DeliveryChainFacts,
} from '@videofy-live/shared-types';
import { ProgrammeRelayAuthority } from '../programme-relay-authority.js';

const RUN = 'run_first';
const SESSION = 'session_first';

function delivery(over: Partial<DeliveryChainFacts> = {}, runId = RUN) {
  return assessProgrammeDelivery({
    programmeRunId: runId,
    facts: {
      configuredMode: 'delayed',
      originConfigured: true,
      originRunning: true,
      initSegmentReady: true,
      publishedSegments: 12,
      timelineTracked: true,
      bufferState: 'active',
      egressAvailable: true,
      ...over,
    },
    publicManifestUrl: `https://ingest.example/programmes/${runId}/playlist.m3u8`,
  });
}

/**
 * A broadcaster publishing into a gateway, counted at both ends.
 *
 * `relayed` is what a realtime listener would have received. `contributed` is
 * what the protected encoder received. The protected run must have the second
 * at exactly the rate of the source and the first at zero.
 */
function broadcast(authority: ProgrammeRelayAuthority, sessionId = SESSION) {
  let relayed = 0;
  let contributed = 0;
  return {
    frame(): void {
      /*
       * The gateway's real order: the encoder is fed BEFORE the relay guard
       * returns. A contribution placed after the guard would never run for
       * exactly the runs that need it, and a protected broadcast would produce
       * no media at all behind a perfectly healthy gateway.
       */
      contributed += 1;
      if (!authority.mayRelayFrames(sessionId)) return;
      relayed += 1;
    },
    get relayed() {
      return relayed;
    },
    get contributed() {
      return contributed;
    },
  };
}

describe('a fresh gateway, a protected deployment, and the very first run', () => {
  const freshProtectedGateway = () => {
    const authority = new ProgrammeRelayAuthority();
    // The policy arrives on connection, before any run exists. That is the
    // whole fix: it is a fact about configuration, not a memory of history.
    authority.notePolicy(programmeDeliveryPolicy('delayed'));
    return authority;
  };

  it('LEAKS NOT ONE AUDIO OR VIDEO FRAME BEFORE THE ANNOUNCEMENT ARRIVES', () => {
    const authority = freshProtectedGateway();
    // The run is bound. No delivery announcement has been made for it yet.
    authority.admitSession(SESSION, RUN);

    const source = broadcast(authority);
    for (let i = 0; i < 500; i += 1) source.frame();

    expect(source.relayed).toBe(0);
    // And the protected encoder got every one of them.
    expect(source.contributed).toBe(500);
  });

  it('still leaks nothing once the announcement finally lands', () => {
    const authority = freshProtectedGateway();
    authority.admitSession(SESSION, RUN);
    const source = broadcast(authority);
    for (let i = 0; i < 100; i += 1) source.frame();

    authority.noteDelivery(delivery());
    authority.applyToSession(SESSION, authority.decide(RUN).permitted);
    for (let i = 0; i < 100; i += 1) source.frame();

    expect(source.relayed).toBe(0);
    expect(source.contributed).toBe(200);
  });

  it('refuses while the buffer is still filling, which is the opening minute', () => {
    /*
     * The window most likely to be written as an exception by somebody trying
     * to be helpful. A protected broadcast that relayed while its delay filled
     * would deliver the studio for precisely the opening it was configured to
     * cover.
     */
    const authority = freshProtectedGateway();
    authority.noteDelivery(delivery({ publishedSegments: 0 }));
    expect(authority.decide(RUN).permitted).toBe(false);
  });

  it('names the refusal as waiting for authority, not as a protected path', () => {
    // Two different situations with two different fixes: one is a protected
    // programme working, the other is an announcement that has not arrived.
    const authority = freshProtectedGateway();
    expect(authority.decide(RUN).refusal).toBe('awaiting-delivery-authority');
    authority.noteDelivery(delivery());
    expect(authority.decide(RUN).refusal).toBe('delivered-through-the-protected-path');
  });
});

describe('a gateway nobody has told anything', () => {
  it('REFUSES A PROGRAMME RUN WITH NO DELIVERY AUTHORITY AT ALL', () => {
    /*
     * No policy and no announcement. The old rule resolved this as permitted,
     * which is the bet that produced the leak; taking it again with less
     * information is not better. A programme nobody has established the rules
     * for does not go out over the realtime path.
     */
    const authority = new ProgrammeRelayAuthority();
    authority.admitSession(SESSION, RUN);
    const source = broadcast(authority);
    for (let i = 0; i < 250; i += 1) source.frame();
    expect(source.relayed).toBe(0);
    expect(authority.decide(RUN).refusal).toBe('no-delivery-authority');
  });

  it('does not govern a session that is not a programme at all', () => {
    // An ordinary call. This authority never governed those and must not
    // start: failing closed over calls would break the product to protect a
    // subsystem they do not use.
    const authority = new ProgrammeRelayAuthority();
    expect(authority.mayRelayFrames('an-ordinary-call')).toBe(true);
  });
});

describe('TRUE LIVE keeps working', () => {
  const liveDeployment = () => {
    const authority = new ProgrammeRelayAuthority();
    authority.notePolicy(programmeDeliveryPolicy('live'));
    return authority;
  };

  it('relays an unannounced run on a deployment that does not protect', () => {
    const authority = liveDeployment();
    authority.admitSession(SESSION, RUN);
    const source = broadcast(authority);
    for (let i = 0; i < 300; i += 1) source.frame();
    expect(source.relayed).toBe(300);
  });

  it('relays a run whose answer says live', () => {
    const authority = liveDeployment();
    authority.noteDelivery(delivery({ configuredMode: 'live' }));
    authority.admitSession(SESSION, RUN);
    const source = broadcast(authority);
    for (let i = 0; i < 300; i += 1) source.frame();
    expect(source.relayed).toBe(300);
  });

  it('releases a session whose live answer arrives after its listeners did', () => {
    /*
     * On a protected DEPLOYMENT a live run is still refused until its own
     * answer arrives -- correctly. The peer must then be built, because for a
     * listener already watching, "at the next join" is never.
     */
    const authority = new ProgrammeRelayAuthority();
    authority.notePolicy(programmeDeliveryPolicy('delayed'));
    authority.admitSession(SESSION, RUN);
    expect(authority.mayRelayFrames(SESSION)).toBe(false);

    authority.noteDelivery(delivery({ configuredMode: 'live' }));
    authority.applyToSession(SESSION, authority.decide(RUN).permitted);
    expect(authority.mayRelayFrames(SESSION)).toBe(true);
  });
});

describe('a run does not change what it is', () => {
  it('REFUSES TO DOWNGRADE A PROTECTED RUN TO LIVE', () => {
    /*
     * A stale announcement, a restarted reporter, two messages arriving out of
     * order. Any of them would release the very material the run is holding,
     * mid-broadcast, to an audience that was told it was protected.
     */
    const authority = new ProgrammeRelayAuthority();
    authority.notePolicy(programmeDeliveryPolicy('delayed'));
    authority.noteDelivery(delivery());
    authority.admitSession(SESSION, RUN);

    const accepted = authority.noteDelivery(delivery({ configuredMode: 'live' }));
    expect(accepted).toBe(false);
    expect(authority.decide(RUN).permitted).toBe(false);

    const source = broadcast(authority);
    for (let i = 0; i < 200; i += 1) source.frame();
    expect(source.relayed).toBe(0);
  });

  it('lets a protected run change readiness without becoming relayable', () => {
    const authority = new ProgrammeRelayAuthority();
    authority.notePolicy(programmeDeliveryPolicy('delayed'));
    authority.noteDelivery(delivery());
    // The chain breaks. Still delayed, still refused: a protected path that
    // has failed must not fall back to relaying the source.
    expect(authority.noteDelivery(delivery({ bufferState: 'failed' }))).toBe(true);
    expect(authority.decide(RUN).permitted).toBe(false);
  });

  it('announces a later run of the same channel on its own terms', () => {
    const authority = new ProgrammeRelayAuthority();
    authority.notePolicy(programmeDeliveryPolicy('delayed'));
    authority.noteDelivery(delivery());
    authority.forgetRun(RUN);
    // A fresh airing is a fresh run: the previous one's binding must not
    // decide it, in either direction.
    expect(authority.decide(RUN).refusal).toBe('awaiting-delivery-authority');
  });
});

describe('a peer that must not merely fall silent', () => {
  it('reports the transition so the caller can tear the peer down', () => {
    /*
     * A peer that exists and is expected not to carry frames is one bug away
     * from carrying them, and the bug would be invisible until an audience
     * heard the studio.
     */
    const authority = new ProgrammeRelayAuthority();
    authority.notePolicy(programmeDeliveryPolicy('live'));
    authority.admitSession(SESSION, RUN);
    expect(authority.mayRelayFrames(SESSION)).toBe(true);

    const nowForbidden = authority.applyToSession(SESSION, false);
    expect(nowForbidden).toBe(true);
    // Idempotent: a second refusal is not a second teardown.
    expect(authority.applyToSession(SESSION, false)).toBe(false);
  });
});
