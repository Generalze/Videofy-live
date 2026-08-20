/** @author masterzee001 */
/**
 * Hanging up.
 *
 * Four adversarial review rounds found nineteen, then five, then four, then
 * five confirmed blockers, and the last two rounds found them almost entirely
 * inside the previous round's fixes — all of them in async teardown. This file
 * pins the five findings of the fourth round against the lifecycle that
 * replaced that code, and then pins the invariants those findings were
 * symptoms of.
 *
 * Every assertion here is written to fail for the RIGHT reason. Counting the
 * frames that arrived is not a test that no frame was lost: it is a test that
 * some frames arrived. The ledger identity below is the real one.
 */
import { describe, expect, it } from 'vitest';
import {
  RecordingMediaAdapterPort,
  type AdapterAudioFrame,
  type MediaAdapterPort,
} from '@videofy-live/media-adapter-port';
import { SipCall, type RtpTarget } from '../call.js';
import { serializeRtpPacket } from '../rtp/packet.js';
import type { LifecycleTimers, LogSink } from '../lifecycle.js';
import type { SipMessage } from '../sip/messages.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The tests speak to a documentation-range peer, so policy must allow it. */
const TEST_POLICY = { allow: ['198.51.100.0/24', '127.0.0.0/8'] };

const OFFER = [
  'v=0',
  'o=caller 1 1 IN IP4 198.51.100.7',
  's=call',
  'c=IN IP4 198.51.100.7',
  't=0 0',
  'm=audio 40000 RTP/AVP 0',
  'a=rtpmap:0 PCMU/8000',
  '',
].join('\r\n');

function invite(callId = 'call-1'): SipMessage {
  return {
    kind: 'request',
    method: 'INVITE',
    requestUri: 'sip:videofy@example.test',
    headers: {
      via: 'SIP/2.0/UDP 198.51.100.7:5060;branch=z9hG4bK1',
      from: '"Ada Caller" <sip:ada@example.test>;tag=abc',
      to: '<sip:videofy@example.test>',
      'call-id': callId,
      cseq: '1 INVITE',
      'content-type': 'application/sdp',
    },
    body: OFFER,
  };
}

/** One 20 ms PCMU packet at the given sequence. */
function rtpFrame(sequence: number, timestamp = sequence * 160, ssrc = 0xaaaa): Buffer {
  return serializeRtpPacket({
    payloadType: 0,
    sequenceNumber: sequence,
    rtpTimestamp: timestamp,
    ssrc,
    payload: Buffer.alloc(160, 0x7f),
  });
}

interface RigOptions {
  port?: MediaAdapterPort;
  log?: LogSink;
  timers?: LifecycleTimers;
  seamCallbackDeadlineMs?: number;
  gracePeriodMs?: number;
  releaseTransport?: () => void;
  /** Omit to use the permissive test policy; pass null for the loopback default. */
  policy?: { allow: readonly string[] } | null;
}

interface Rig {
  call: SipCall;
  port: RecordingMediaAdapterPort;
  sent: Array<{ datagram: Buffer; target: RtpTarget }>;
  sip: SipMessage[];
}

function rig(options: RigOptions = {}): Rig {
  const port = (options.port ?? new RecordingMediaAdapterPort()) as RecordingMediaAdapterPort;
  const sent: Array<{ datagram: Buffer; target: RtpTarget }> = [];
  const sip: SipMessage[] = [];
  const call = new SipCall({
    port,
    localAddress: '203.0.113.5',
    localRtpPort: 30000,
    sendRtp: (datagram, target) => sent.push({ datagram, target }),
    sendSip: (message) => sip.push(message),
    mintParticipantId: () => 'sp_1',
    ...(options.policy === null ? {} : { mediaPolicy: options.policy ?? TEST_POLICY }),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    ...(options.seamCallbackDeadlineMs === undefined
      ? {}
      : { seamCallbackDeadlineMs: options.seamCallbackDeadlineMs }),
    ...(options.gracePeriodMs === undefined ? {} : { gracePeriodMs: options.gracePeriodMs }),
    ...(options.releaseTransport === undefined
      ? {}
      : { releaseTransport: options.releaseTransport }),
  });
  return { call, port, sent, sip };
}

/**
 * The one assertion this whole redesign exists to make true: every frame that
 * left a buffer was either delivered or counted as discarded, and none is
 * still owed. A frame may be lost; it may not be lost silently.
 *
 * ADAPTED after the receipt-ledger change. The identity below begins at
 * EXTRACTION, so it is blind to everything upstream of it — a packet a buffer
 * evicted, resynced away, or carried off when it was replaced never entered
 * the equation, and the equation balanced anyway. It is kept because it is
 * still true and still worth pinning; it is no longer the whole claim.
 */
function expectLedgerBalances(call: SipCall): void {
  const m = call.measurements;
  expect({
    extracted: m.framesExtracted,
    accountedFor: m.framesDelivered + m.framesDiscarded,
    stillOwed: call.owedFrames,
  }).toEqual({
    extracted: m.framesExtracted,
    accountedFor: m.framesExtracted,
    stillOwed: 0,
  });
  // The stronger claim: every packet taken off the WIRE is still somewhere
  // this call can name. Nothing can be lost between arrival and extraction.
  const ledger = call.mediaLedger;
  expect({
    accepted: ledger.accepted,
    accountedFor: ledger.accountedFor,
    unaccountedFor: ledger.unaccountedFor,
    extractedAgreesWithBuffers: ledger.extracted,
  }).toEqual({
    accepted: ledger.accepted,
    accountedFor: ledger.accepted,
    unaccountedFor: 0,
    extractedAgreesWithBuffers: m.framesExtracted,
  });
  expect(ledger.balanced).toBe(true);
}

/** A seam that takes its time, so a hangup can land between two frames. */
class SlowSeam extends RecordingMediaAdapterPort {
  constructor(private readonly delayMs = 5) {
    super();
  }

  override async pushAudio(sessionId: string, frame: AdapterAudioFrame): Promise<void> {
    await sleep(this.delayMs);
    await super.pushAudio(sessionId, frame);
  }
}

/** A seam that accepts the call and then simply stops answering. */
class SilentSeam extends RecordingMediaAdapterPort {
  override async pushAudio(): Promise<void> {
    return new Promise<void>(() => {});
  }
}

describe('round-4 finding A: a hangup landing mid-pump', () => {
  it('PIN: a graceful close mid-pump delivers every extracted frame, and the ledger proves it', async () => {
    const seam = new SlowSeam(5);
    const { call } = rig({ port: seam });
    await call.onInvite(invite());
    for (let sequence = 1; sequence <= 3; sequence += 1) call.onRtpDatagram(rtpFrame(sequence));

    const pumping = call.pump();
    // Mid-pump: the first frame is inside the seam callback right now.
    await sleep(2);
    const closing = call.close('caller hung up');
    await Promise.all([pumping, closing]);

    const m = call.measurements;
    // Three packets went in. The predecessor delivered one and lost two with
    // `lost: 0` and `evicted: 0` — untraceably, on every hangup that landed
    // mid-pump. A graceful close owes the listener all three.
    expect(m.framesExtracted).toBe(3);
    expect(m.framesDelivered).toBe(3);
    expect(m.framesDiscarded).toBe(0);
    expect(seam.frames).toHaveLength(3);
    expectLedgerBalances(call);
  });

  it('PIN: an ABORT mid-pump keeps the undelivered frames COUNTED rather than merely gone', async () => {
    const seam = new SlowSeam(5);
    const { call } = rig({ port: seam });
    await call.onInvite(invite());
    for (let sequence = 1; sequence <= 3; sequence += 1) call.onRtpDatagram(rtpFrame(sequence));

    const pumping = call.pump();
    await sleep(2);
    const closing = call.close('compromised', 'abort');
    await Promise.all([pumping, closing]);

    const m = call.measurements;
    expect(m.framesExtracted).toBe(3);
    // The point is not how many survived the escalation — it is that the
    // difference is written down somewhere.
    expect(m.framesDiscarded).toBeGreaterThan(0);
    expect(m.framesDelivered).toBeLessThan(3);
    expectLedgerBalances(call);
    expect(call.lifecycleState).toBe('closed');
  });

  it('PIN: media order stays monotonic when a close joins a pump in flight', async () => {
    const seam = new SlowSeam(3);
    const { call } = rig({ port: seam });
    await call.onInvite(invite());
    for (let sequence = 1; sequence <= 6; sequence += 1) call.onRtpDatagram(rtpFrame(sequence));

    const pumping = call.pump();
    await sleep(2);
    await Promise.all([pumping, call.close('caller hung up')]);

    const times = seam.frames.map((frame) => frame.platformTimestampMs);
    // A listener forgives a gap; two halves of a sentence arriving swapped is
    // worse than either half being lost.
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(times).size).toBe(times.length);
    expectLedgerBalances(call);
  });
});

describe('round-4 finding B: a throwing log sink', () => {
  it('PIN: a log sink that always throws cannot prevent teardown or make a call unclosable', async () => {
    class BrokenIngress extends RecordingMediaAdapterPort {
      override async pushAudio(): Promise<void> {
        throw new Error('engine ingress down');
      }
    }
    const seam = new BrokenIngress();
    const { call } = rig({
      port: seam,
      // Every log site in the adapter is reached below, and every one throws.
      log: () => {
        throw new Error('log sink down');
      },
      // The default loopback policy refuses the offered address, which logs.
      policy: null,
    });

    await call.onInvite(invite());
    expect(call.measurements.refusedMediaDestinations).toBe(1);

    // The UDP handler documents itself as never throwing. An SSRC change logs.
    call.onRtpDatagram(rtpFrame(1, 160, 0xaaaa));
    expect(() => call.onRtpDatagram(rtpFrame(2, 320, 0xbbbb))).not.toThrow();

    // The drain fails and logs; the discard logs; the seam notification logs.
    await expect(call.close('caller hung up')).resolves.toBeUndefined();
    expect(call.isClosed).toBe(true);
    expect(call.resourcesReleased).toBe(true);
    expect(seam.closes).toHaveLength(1);

    // The old failure was second-order: `closing` was never reset, so every
    // later close adopted a rejected promise and the call could never close.
    await expect(call.close('again')).resolves.toBeUndefined();
    expect(seam.closes).toHaveLength(1);
    expectLedgerBalances(call);
  });
});

describe('round-4 finding C: an abort behind an in-flight graceful close', () => {
  it('PIN: the abort escalates the machine and its reason is what the seam is told', async () => {
    const { call, port } = rig();
    await call.onInvite(invite());
    call.onRtpDatagram(rtpFrame(1));
    call.onRtpDatagram(rtpFrame(2));

    const graceful = call.close('bye');
    const abort = call.close('compromised: media policy refusal', 'abort');
    await Promise.all([graceful, abort]);

    // The escalation is an edge the machine actually took, in order — not an
    // outcome inferred from how many frames happened to arrive.
    expect(call.lifecycle.transitions).toEqual([
      { from: 'active', to: 'draining' },
      { from: 'draining', to: 'aborting' },
      { from: 'aborting', to: 'terminating' },
      { from: 'terminating', to: 'closed' },
    ]);
    // The predecessor discarded the second caller's mode and reason: it
    // pushed two frames into the seam and filed the hangup as "bye".
    expect(port.closes).toEqual([
      { sessionId: call.sessionId, reason: 'compromised: media policy refusal' },
    ]);
    expect(call.terminationIntent).toEqual({
      mode: 'abort',
      reason: 'compromised: media policy refusal',
    });
    // A call being destroyed because it is compromised does not get to speak.
    expect(port.frames).toHaveLength(0);
    expect(call.measurements.framesExtracted).toBeGreaterThan(0);
    expect(call.measurements.framesDelivered).toBe(0);
    expectLedgerBalances(call);
  });

  it('PIN: an abort still escalates a graceful close that is already awaiting a slow seam', async () => {
    const seam = new SlowSeam(15);
    const { call } = rig({ port: seam });
    await call.onInvite(invite());
    for (let sequence = 1; sequence <= 4; sequence += 1) call.onRtpDatagram(rtpFrame(sequence));

    const graceful = call.close('bye');
    // The drain is inside the seam callback for frame one by now.
    await sleep(5);
    const abort = call.close('compromised', 'abort');
    await Promise.all([graceful, abort]);

    expect(call.lifecycle.transitions.map((t) => t.to)).toEqual([
      'draining',
      'aborting',
      'terminating',
      'closed',
    ]);
    // Delivery stopped at the escalation rather than running to the end.
    expect(seam.frames.length).toBeLessThan(4);
    expect(seam.closes).toEqual([{ sessionId: call.sessionId, reason: 'compromised' }]);
    expectLedgerBalances(call);
  });
});

describe('round-4 finding D: a seam that never answers', () => {
  it('PIN: a hanging pushAudio costs one deadline, not the call', async () => {
    const { call, port } = rig({ port: new SilentSeam(), seamCallbackDeadlineMs: 30 });
    await call.onInvite(invite());
    call.onRtpDatagram(rtpFrame(1));

    const a = call.close('caller hung up');
    const b = call.close('rtp socket error');

    // While teardown is wedged on the seam, the call must not claim to be
    // closed. The predecessor reported `isClosed` true here with `closes: 0`.
    await sleep(5);
    expect(call.isClosed).toBe(false);
    expect(call.resourcesReleased).toBe(false);
    expect(call.lifecycleState).toBe('draining');

    const outcome = await Promise.race([
      Promise.all([a, b]).then(() => 'settled'),
      sleep(600).then(() => 'wedged'),
    ]);
    expect(outcome).toBe('settled');
    expect(call.isClosed).toBe(true);
    expect(call.resourcesReleased).toBe(true);
    expect(port.closes).toHaveLength(1);
    // The frame the seam never took is discarded and counted, not forgotten.
    expect(call.measurements.framesDiscarded).toBe(1);
    expectLedgerBalances(call);
  });

  it('PIN: a drain wedged behind a hanging pump is escalated, and every owed frame is counted', async () => {
    const seam = new SilentSeam();
    const { call } = rig({ port: seam, seamCallbackDeadlineMs: 300, gracePeriodMs: 60 });
    await call.onInvite(invite());
    for (let sequence = 1; sequence <= 3; sequence += 1) call.onRtpDatagram(rtpFrame(sequence));

    // The pump extracts all three and then stops answering on the first.
    const pumping = call.pump();
    await sleep(2);
    // Two more arrive while the call is still live, and stay in the buffer
    // because nothing is able to run a pump.
    for (let sequence = 4; sequence <= 5; sequence += 1) call.onRtpDatagram(rtpFrame(sequence));
    // The teardown drain queues behind that pump and never gets to run, so
    // the flush that would normally empty the buffer never happens either.
    await call.close('caller hung up');

    expect(call.lifecycle.transitions.map((t) => t.to)).toEqual([
      'draining',
      'aborting',
      'terminating',
      'closed',
    ]);
    const m = call.measurements;
    // Three the pump had taken custody of, plus the two still sitting in a
    // buffer nobody ever flushed. The mode said "graceful", the machine had
    // escalated, and neither of those is permission to lose audio quietly.
    expect(m.framesExtracted).toBe(5);
    expect(m.framesDelivered).toBe(0);
    // Two queued, one in flight and two unflushed: ownership of the frame
    // inside the seam callback moved to teardown, counted exactly once.
    expect(m.framesDiscarded).toBe(5);
    expectLedgerBalances(call);

    // The abandoned push eventually gives up and must not count anything a
    // second time.
    await pumping;
    expect(call.measurements.framesDiscarded).toBe(5);
    expectLedgerBalances(call);
  });

  it('PIN: a hanging closeSession does not keep the call from being closed', async () => {
    class SilentGoodbye extends RecordingMediaAdapterPort {
      override async closeSession(): Promise<void> {
        return new Promise<void>(() => {});
      }
    }
    const { call, port } = rig({ port: new SilentGoodbye(), seamCallbackDeadlineMs: 30 });
    await call.onInvite(invite());

    const outcome = await Promise.race([
      call.close('caller hung up').then(() => 'settled'),
      sleep(600).then(() => 'wedged'),
    ]);
    expect(outcome).toBe('settled');
    // No application callback may prevent final resource release.
    expect(call.resourcesReleased).toBe(true);
    expect(call.isClosed).toBe(true);
    expect(port.leaves).toHaveLength(1);
  });
});

describe('round-4 finding E: close re-entered from a seam callback', () => {
  it('PIN: a seam that hangs up while being handed a frame does not deadlock teardown', async () => {
    let call!: SipCall;
    let reentries = 0;
    class HangsUpMidFrame extends RecordingMediaAdapterPort {
      override async pushAudio(sessionId: string, frame: AdapterAudioFrame): Promise<void> {
        await super.pushAudio(sessionId, frame);
        reentries += 1;
        // The exact cycle that used to wedge: teardown, pump chain, pushAudio,
        // the shared close promise, teardown.
        await call.close('the seam asked to end the call');
      }
    }
    const seam = new HangsUpMidFrame();
    call = rig({ port: seam }).call;
    await call.onInvite(invite());
    call.onRtpDatagram(rtpFrame(1));

    const outcome = await Promise.race([
      call.close('caller hung up').then(() => 'settled'),
      sleep(600).then(() => 'wedged'),
    ]);
    expect(outcome).toBe('settled');
    expect(reentries).toBeGreaterThan(0);
    // It was converted to a signal rather than becoming a second wait.
    expect(call.lifecycle.reentrantSignals).toBeGreaterThan(0);
    expect(call.isClosed).toBe(true);
    expect(seam.closes).toHaveLength(1);
    expectLedgerBalances(call);
  });

  it('PIN: the FIRST close may come from inside a live pump and still tear the call down', async () => {
    let call!: SipCall;
    class HangsUpOnFirstFrame extends RecordingMediaAdapterPort {
      override async pushAudio(sessionId: string, frame: AdapterAudioFrame): Promise<void> {
        await super.pushAudio(sessionId, frame);
        // No teardown is running yet: this signal has to start one, and the
        // caller cannot be the thing that waits for it.
        await call.close('the seam asked to end the call');
      }
    }
    const seam = new HangsUpOnFirstFrame();
    call = rig({ port: seam }).call;
    await call.onInvite(invite());
    call.onRtpDatagram(rtpFrame(1));

    const outcome = await Promise.race([
      call
        .pump()
        .then(() => call.close('joining the lifecycle the pump started'))
        .then(() => 'settled'),
      sleep(600).then(() => 'wedged'),
    ]);
    expect(outcome).toBe('settled');
    expect(call.isClosed).toBe(true);
    expect(seam.closes).toEqual([
      { sessionId: call.sessionId, reason: 'the seam asked to end the call' },
    ]);
    expectLedgerBalances(call);
  });
});

describe('what the three states actually mean', () => {
  it('rejects NEW media the moment shutdown begins, while still delivering what was admitted', async () => {
    const { call, port } = rig();
    await call.onInvite(invite());
    call.onRtpDatagram(rtpFrame(1));
    call.onRtpDatagram(rtpFrame(2));

    const closing = call.close('caller hung up');
    expect(call.lifecycleState).toBe('draining');
    expect(call.isAcceptingMedia).toBe(false);
    expect(call.isDeliveringMedia).toBe(true);
    // Arrives after the hangup: refused at the door, not buffered and then
    // dropped somewhere unaccountable.
    call.onRtpDatagram(rtpFrame(3));
    await closing;

    expect(call.measurements.packetsRejectedAfterShutdown).toBe(1);
    // It never reached the buffer at all.
    expect(call.measurements.jitter.received).toBe(2);
    expect(call.measurements.framesExtracted).toBe(2);
    expect(port.frames).toHaveLength(2);
    expectLedgerBalances(call);
  });

  it('stops egress at the same moment as ingress, so the two halves cannot disagree', async () => {
    const { call, sent } = rig();
    await call.onInvite(invite());
    call.sendToEndpoint(new Int16Array(640));
    expect(sent).toHaveLength(2);

    const closing = call.close('caller hung up');
    call.sendToEndpoint(new Int16Array(640));
    await closing;
    expect(sent).toHaveLength(2);
  });

  it('reports CLOSED only after resources are genuinely released', async () => {
    let releasedTransport = 0;
    const { call } = rig({
      port: new SlowSeam(10),
      releaseTransport: () => {
        releasedTransport += 1;
      },
    });
    await call.onInvite(invite());
    call.onRtpDatagram(rtpFrame(1));

    const closing = call.close('caller hung up');
    // Shutdown has begun and nothing is released yet.
    expect(call.isClosed).toBe(false);
    expect(call.resourcesReleased).toBe(false);
    expect(releasedTransport).toBe(0);

    await closing;
    expect(call.isClosed).toBe(true);
    expect(call.resourcesReleased).toBe(true);
    expect(releasedTransport).toBe(1);
  });

  it('leaves no deadline timer behind it', async () => {
    const live = new Set<ReturnType<typeof setTimeout>>();
    const timers: LifecycleTimers = {
      setTimer(handler, delayMs) {
        const handle = setTimeout(() => {
          live.delete(handle);
          handler();
        }, delayMs);
        live.add(handle);
        return handle;
      },
      clearTimer(handle) {
        const typed = handle as ReturnType<typeof setTimeout>;
        live.delete(typed);
        clearTimeout(typed);
      },
    };
    const { call } = rig({ timers });
    await call.onInvite(invite());
    call.onRtpDatagram(rtpFrame(1));
    await call.pump();
    await call.close('caller hung up');

    expect(call.isClosed).toBe(true);
    expect(live.size).toBe(0);
  });
});

describe('teardown under concurrency', () => {
  it('a BYE and a media error in the same tick produce one teardown at the stronger reason', async () => {
    let releasedTransport = 0;
    const { call, port } = rig({
      releaseTransport: () => {
        releasedTransport += 1;
      },
    });
    await call.onInvite(invite());
    call.onRtpDatagram(rtpFrame(1));

    const bye = call.close('caller hung up');
    const mediaError = call.close('rtp socket error', 'abort');
    await expect(Promise.all([bye, mediaError])).resolves.toEqual([undefined, undefined]);

    // Exactly one coordinator: one release, one leave, one close.
    expect(releasedTransport).toBe(1);
    expect(port.leaves).toHaveLength(1);
    expect(port.closes).toEqual([{ sessionId: call.sessionId, reason: 'rtp socket error' }]);
    expect(call.lifecycle.refusedTransitions).toBe(0);
    expectLedgerBalances(call);
  });

  it('five closers, one of them re-entrant, still release exactly once', async () => {
    let call!: SipCall;
    let releasedTransport = 0;
    class ChattySeam extends RecordingMediaAdapterPort {
      override async pushAudio(sessionId: string, frame: AdapterAudioFrame): Promise<void> {
        await super.pushAudio(sessionId, frame);
        await call.close('and the seam too');
      }
    }
    call = rig({
      port: new ChattySeam(),
      releaseTransport: () => {
        releasedTransport += 1;
      },
    }).call;
    await call.onInvite(invite());
    call.onRtpDatagram(rtpFrame(1));

    await Promise.all([
      call.close('bye'),
      call.close('rtp socket error'),
      call.close('supervisor'),
      call.close('timer'),
    ]);
    await call.close('and once more, afterwards');

    expect(releasedTransport).toBe(1);
    expect(call.isClosed).toBe(true);
    expectLedgerBalances(call);
  });

  it('a close racing a pump neither loses a frame nor delivers one twice', async () => {
    const seam = new SlowSeam(2);
    const { call } = rig({ port: seam });
    await call.onInvite(invite());
    for (let sequence = 1; sequence <= 8; sequence += 1) call.onRtpDatagram(rtpFrame(sequence));

    // Three pumps and a close, all overlapping.
    const work = [call.pump(), call.pump(), call.close('caller hung up'), call.pump()];
    await Promise.all(work);

    const times = seam.frames.map((frame) => frame.platformTimestampMs);
    expect(new Set(times).size).toBe(times.length);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(call.measurements.framesDelivered).toBe(seam.frames.length);
    expectLedgerBalances(call);
  });

  it('a rejecting seam callback is contained: the call still closes and the frame is counted', async () => {
    class HostileSeam extends RecordingMediaAdapterPort {
      override async pushAudio(): Promise<void> {
        throw new Error('engine ingress down');
      }

      override async participantLeft(): Promise<void> {
        throw new Error('seam handler exploded');
      }
    }
    const seam = new HostileSeam();
    const { call } = rig({ port: seam });
    await call.onInvite(invite());
    call.onRtpDatagram(rtpFrame(1));

    await expect(call.close('caller hung up')).resolves.toBeUndefined();
    expect(seam.closes).toHaveLength(1);
    expect(call.resourcesReleased).toBe(true);
    expect(call.measurements.framesDiscarded).toBe(1);
    expectLedgerBalances(call);
  });

  it('two independent calls closing at once cannot touch each other', async () => {
    const quiet = rig({ port: new SilentSeam(), seamCallbackDeadlineMs: 30 });
    const ordinary = rig();
    await quiet.call.onInvite(invite('call-a'));
    await ordinary.call.onInvite(invite('call-b'));
    quiet.call.onRtpDatagram(rtpFrame(1));
    ordinary.call.onRtpDatagram(rtpFrame(1));

    await Promise.all([
      quiet.call.close('compromised', 'abort'),
      ordinary.call.close('caller hung up'),
    ]);

    // Different paths, different reasons, different ledgers — and neither
    // call's seam heard a word about the other.
    expect(quiet.call.lifecycle.transitions.map((t) => t.to)).toEqual([
      'aborting',
      'terminating',
      'closed',
    ]);
    expect(ordinary.call.lifecycle.transitions.map((t) => t.to)).toEqual([
      'draining',
      'terminating',
      'closed',
    ]);
    expect(quiet.port.frames).toHaveLength(0);
    expect(ordinary.port.frames).toHaveLength(1);
    expect(quiet.port.closes).toEqual([
      { sessionId: quiet.call.sessionId, reason: 'compromised' },
    ]);
    expect(ordinary.port.closes).toEqual([
      { sessionId: ordinary.call.sessionId, reason: 'caller hung up' },
    ]);
    expectLedgerBalances(quiet.call);
    expectLedgerBalances(ordinary.call);
  });

  it('one call hanging on its seam does not delay another call closing', async () => {
    const wedged = rig({ port: new SilentSeam(), seamCallbackDeadlineMs: 400 });
    const healthy = rig();
    await wedged.call.onInvite(invite('call-a'));
    await healthy.call.onInvite(invite('call-b'));
    wedged.call.onRtpDatagram(rtpFrame(1));
    healthy.call.onRtpDatagram(rtpFrame(1));

    const slowClose = wedged.call.close('caller hung up');
    await healthy.call.close('caller hung up');

    // The healthy call finished while the other is still inside its deadline.
    expect(healthy.call.isClosed).toBe(true);
    expect(wedged.call.isClosed).toBe(false);
    expect(wedged.call.lifecycleState).toBe('draining');
    await slowClose;
    expect(wedged.call.isClosed).toBe(true);
  });
});

describe('the queue of pump tasks is bounded, like every other queue here', () => {
  it('PIN: a timer driver against a wedged seam cannot grow the delivery chain', async () => {
    // The production driver is documented in this file as setInterval(() =>
    // call.pump(), 20) with no await and no catch. Against a seam slower than
    // real time that appended ~50 tasks a second and completed one, so the
    // chain grew without bound until the process died — while the ledger
    // stayed perfectly balanced, every frame counted as discarded, which is
    // exactly why nothing else here noticed.
    const { call } = rig({ port: new SilentSeam(), seamCallbackDeadlineMs: 30 });
    await call.onInvite(invite());
    call.onAck();
    for (let sequence = 1; sequence <= 20; sequence += 1) call.onRtpDatagram(rtpFrame(sequence));

    // 500 ticks of the driver, fired the way the driver fires them.
    for (let tick = 0; tick < 500; tick += 1) void call.pump();

    // At most one running and one waiting, whatever the driver does. Asserting
    // the queue DEPTH is the point: a count of frames or a balanced ledger is
    // true the whole time this defect is killing the process.
    expect(call.queuedDeliveries).toBeLessThanOrEqual(2);
    expect(call.measurements.coalescedPumps).toBeGreaterThan(400);

    // And the folding loses no work: a pump drains everything available, so
    // the survivor does what all 500 would have done.
    await call.close('caller hung up');
    expect(call.queuedDeliveries).toBe(0);
    expectLedgerBalances(call);
  });

  it('PIN: a pump folded into one already in flight still has its work done', async () => {
    // Folding must never DROP work, only avoid repeating it. A pump that is
    // already running has taken its snapshot of the buffer; media arriving
    // after that needs a SUCCESSOR to drain it, so the flag has to clear when
    // a task starts, not when it finishes. Clearing on completion swallows
    // the request outright and leaves that audio sitting until something else
    // happens to pump — and if the driver has stopped, that is never.
    const { call, port } = rig({ port: new SlowSeam(20) });
    await call.onInvite(invite());
    call.onAck();
    call.onRtpDatagram(rtpFrame(1));
    const first = call.pump();
    await sleep(5);
    // Arrives while the first pump is parked inside the seam.
    call.onRtpDatagram(rtpFrame(2));
    const second = call.pump();
    await Promise.all([first, second]);

    expect(port.frames).toHaveLength(2);
    expect(call.queuedDeliveries).toBeLessThanOrEqual(2);
  });

  it('a healthy call still pumps every time it is asked', async () => {
    // The bound must not become a throttle. With nothing in flight, each pump
    // runs on its own and nothing is folded away.
    const { call, port } = rig();
    await call.onInvite(invite());
    call.onAck();
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      call.onRtpDatagram(rtpFrame(sequence));
      await call.pump();
    }
    expect(port.frames).toHaveLength(3);
    expect(call.measurements.coalescedPumps).toBe(0);
    expect(call.queuedDeliveries).toBe(0);
  });
});

describe('the seam is only told what actually happened', () => {
  it('does not report a participant leaving who was never announced as joining', async () => {
    class RefusingSeam extends RecordingMediaAdapterPort {
      override async participantJoined(): Promise<void> {
        throw new Error('seam refused the participant');
      }
    }
    const seam = new RefusingSeam();
    const { call } = rig({ port: seam });
    await expect(call.onInvite(invite())).rejects.toThrow('seam refused the participant');

    await call.close('never really started');
    expect(seam.leaves).toHaveLength(0);
    // The session was opened, so it is still closed: releasing something the
    // seam may half-hold is not the same as inventing a departure.
    expect(seam.closes).toHaveLength(1);
    expect(call.isClosed).toBe(true);
  });

  it('a re-INVITE arriving during teardown is refused rather than reviving the call', async () => {
    const { call, sip } = rig({ port: new SlowSeam(10) });
    await call.onInvite(invite());
    call.onRtpDatagram(rtpFrame(1));

    const closing = call.close('caller hung up');
    await call.onInvite(invite());
    await closing;

    expect(sip.at(-1)?.statusCode).toBe(481);
    // One session, one join: the retransmit opened nothing.
    expect(call.lifecycle.transitions.map((t) => t.to)).toEqual([
      'draining',
      'terminating',
      'closed',
    ]);
  });
});
