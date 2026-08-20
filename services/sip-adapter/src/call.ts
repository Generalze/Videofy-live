/** @author masterzee001 */
/**
 * One SIP call: a dialog, an RTP stream, and the seam between them.
 *
 * This is the only place the two halves meet, and it meets them narrowly.
 * Signalling decides who is on the call; media carries what they said; the
 * seam receives normalized 16 kHz mono audio attributed to a Videofy
 * participant. Nothing here knows what language anyone is speaking, which
 * providers exist, or what the engine will do with the audio — a call from
 * Lagos to Madrid and a call between two identical English speakers take
 * exactly the same path through this file.
 *
 * Ending a call is delegated in its entirety to `CallLifecycle`. This file
 * knows how to deliver a frame, release a buffer and tell the seam; it does
 * not decide when. That separation is the point: teardown used to be seven
 * overlapping mechanisms here, and every defect found in four adversarial
 * rounds lived in the gaps between them rather than inside any one.
 */
import {
  CODECS,
  codecForPayloadType,
  decodeToEngineFormat,
  encodeFromEngineFormat,
  UnsupportedCodecError,
  type Codec,
} from './codec/index.js';
import { JitterBuffer, type EmittedPacket, type JitterStats } from './rtp/jitter-buffer.js';
import { parseRtpPacket, serializeRtpPacket, RtpParseError } from './rtp/packet.js';
import { LOOPBACK_ONLY, maySendMediaTo, type MediaDestinationPolicy } from './media-policy.js';
import { SipDialog, type DialogSnapshot } from './sip/dialog.js';
import { buildSdp, type SipMessage } from './sip/messages.js';
import {
  CallLifecycle,
  guardedLogger,
  invokeBounded,
  SYSTEM_TIMERS,
  type LifecycleState,
  type LifecycleTimers,
  type LogSink,
  type TerminationIntent,
  type TerminationMode,
} from './lifecycle.js';
import type { AdapterAudioFrame, MediaAdapterPort } from '@videofy-live/media-adapter-port';

/** Where audio must be sent for this call. */
export interface RtpTarget {
  address: string;
  port: number;
}

/**
 * A packet this call has taken custody of, and the codec it was RECEIVED
 * under.
 *
 * The codec travels WITH the media rather than being read again at playout. A
 * re-INVITE re-negotiates the codec on a dialog that already exists, and it
 * can land while frames extracted under the previous one are still queued;
 * re-reading `this.codec` at delivery decoded PCMU bytes with a PCMA table and
 * handed the engine confident noise. Nothing counted it, because nothing was
 * lost — the frame count was identical and every ledger balanced. Audio that
 * arrives corrupted is not cheaper than audio that does not arrive; it is
 * worse, because the engine will transcribe it.
 */
interface OwnedFrame {
  readonly emitted: EmittedPacket;
  readonly codec: Codec;
  /**
   * Which continuous run of the sender this packet came from.
   *
   * Not the SSRC. RFC 3550 lets a sender restart its sequence numbers and its
   * timestamp base while KEEPING its SSRC, and an SBC or media gateway
   * restarting its RTP sender routinely does — the jitter buffer has an
   * explicit resync for exactly that case. Keying the media clock by SSRC
   * therefore measured the restarted stream against the base of the one it
   * replaced: 20 ms after the last good frame, the seam was handed a
   * timestamp 45 HOURS later, still perfectly monotonic, so every ordering
   * assertion in the suite was satisfied by it.
   */
  readonly generation: number;
}

/**
 * The media ledger, evaluated at an instant.
 *
 * Every packet this call accepted off the wire is in exactly one of these
 * buckets. `balanced` is the assertion; the rest exist so that when it is
 * false, the reader can see WHERE the media went instead of only that a
 * number disagreed.
 */
export interface MediaLedger {
  /** Packets admitted into a jitter buffer. The denominator. */
  accepted: number;
  delivered: number;
  discarded: number;
  /** Packets a buffer received and threw away — live and retired buffers alike. */
  droppedInBuffer: number;
  /** Packets still sitting in the live jitter buffer. */
  held: number;
  /**
   * Every datagram this call was handed, whether it took custody or not.
   *
   * `balanced` answers a CUSTODY question and cannot answer this one: a
   * datagram refused before custody — malformed, an unnegotiated payload
   * type, arriving before negotiation, arriving after shutdown — never enters
   * `accepted`, so the identity stays perfectly true while every word is
   * being thrown away one line above where the denominator starts counting.
   * A codec that had been dragged backwards by a stale offer produced exactly
   * that: ten packets in, none delivered, `balanced: true`.
   */
  arrived: number;
  /** arrived − accepted. Where a negotiation fault shows up, since custody cannot. */
  refusedBeforeCustody: number;
  /** Extracted from a buffer, not yet delivered or discarded. */
  owed: number;
  /** Packets that left a buffer, as the BUFFERS counted them leaving. */
  extracted: number;
  accountedFor: number;
  /** accepted − accountedFor. Non-zero means media went missing unobserved. */
  unaccountedFor: number;
  balanced: boolean;
}

export interface SipCallDeps {
  port: MediaAdapterPort;
  /** Our own advertised media address and bound port. */
  localAddress: string;
  localRtpPort: number;
  sendRtp(datagram: Buffer, target: RtpTarget): void;
  sendSip(message: SipMessage): void;
  now?: () => number;
  mintParticipantId?: () => string;
  log?: LogSink;
  /**
   * Where media may be sent. Defaults to loopback: an unauthenticated caller
   * must never be able to choose an arbitrary UDP destination.
   */
  mediaPolicy?: MediaDestinationPolicy;
  /** Deadline timers, injectable so a suite need not spend real time. */
  timers?: LifecycleTimers;
  /** How long ONE seam callback may take before we stop waiting for it. */
  seamCallbackDeadlineMs?: number;
  /**
   * How long the whole opening handshake — openSession then participantJoined
   * — may take before the call is refused. Longer than a single callback,
   * because it is two of them and a real gateway may genuinely be slow;
   * comfortably shorter than a UAC's 32-second Timer B, so the caller learns
   * the answer from us rather than from its own clock.
   */
  seamHandshakeDeadlineMs?: number;
  /** How long the whole graceful drain may take before it is escalated. */
  gracePeriodMs?: number;
  /** How long the seam may take to be told the call ended. */
  terminationDeadlineMs?: number;
  /**
   * Release transport resources this call was GIVEN — its RTP socket, its
   * pump timer. The adapter does not create them, so it does not reach into
   * them; their owner hands in the one function that frees them and the
   * lifecycle calls it exactly once, before the call may report itself closed.
   */
  releaseTransport?: () => void;
}

export interface CallMeasurements {
  /** Transcode cost only — decode+resample in, resample+encode out. */
  transcodeInMsTotal: number;
  transcodeOutMsTotal: number;
  framesIn: number;
  framesOut: number;
  /**
   * The media ledger, and where it now begins.
   *
   * It used to begin at EXTRACTION:
   *
   *     framesExtracted === framesDelivered + framesDiscarded
   *
   * which proves custody only from the moment a packet leaves a buffer. That
   * is a real property and it still holds — but it is silent about everything
   * upstream of it. A packet destroyed BEFORE extraction never entered the
   * equation at all: evicted under bounds, thrown away by a resync, or
   * carried off wholesale when a re-INVITE replaced the buffer holding it. So
   * nine packets in and five frames out balanced perfectly at 5 === 5 + 0
   * while 80 ms of speech was gone, and the ledger — the instrument built
   * precisely to make missing audio visible — reported health.
   *
   * The identity now begins at RECEIPT, and holds at every instant rather
   * than only at CLOSED:
   *
   *     packetsAccepted
   *       === framesDelivered
   *         + framesDiscarded
   *         + packets a buffer dropped
   *         + packets a buffer still holds
   *         + frames still owed
   *
   * `mediaLedger` evaluates it. The denominator is now what arrived, not what
   * we chose to pick up: audio may go missing, but it may not go missing
   * anywhere this equation cannot see.
   */
  /** Packets admitted into a jitter buffer — the ledger's denominator. */
  packetsAccepted: number;
  /** Packets that left a buffer into this call's custody. */
  framesExtracted: number;
  framesDelivered: number;
  framesDiscarded: number;
  /** Datagrams that arrived after this call stopped accepting media. */
  packetsRejectedAfterShutdown: number;
  /**
   * Datagrams that arrived before any codec was negotiated. Counted in their
   * own right: this is a signalling fault, not an unsupported payload type,
   * and reading the two as one number hides the first behind the second.
   */
  packetsBeforeNegotiation: number;
  /**
   * Time from datagram arrival to the frame reaching the seam. This is NOT
   * "SIP transport latency": it is dominated by the jitter buffer's TARGET
   * delay, which is a chosen budget rather than a measured cost. The parts
   * below separate what we chose from what we actually paid.
   */
  transportMsTotal: number;
  /** How long packets really sat in the buffer, target included. */
  bufferResidenceMsTotal: number;
  /** Handing the frame to the seam — the port's own cost, not ours. */
  seamHandoffMsTotal: number;
  /** The configured jitter target, so the report can subtract a chosen budget. */
  jitterTargetMs: number;
  malformedPackets: number;
  unsupportedPayloadPackets: number;
  /** SDP destinations policy refused; a spike here is someone probing. */
  refusedMediaDestinations: number;
  /** In-dialog requests refused as stale; a spike here is a replay. */
  staleRequests: number;
  /** Times a sender re-based its media clock and the timeline was continued. */
  mediaClockRebases: number;
  /**
   * Pump requests folded into one already queued. A steady rise here is a
   * seam running slower than real time, which is worth seeing before it is
   * worth panicking about.
   */
  coalescedPumps: number;
  /** Opening handshakes the seam never completed; a spike here is a sick seam. */
  seamHandshakeTimeouts: number;
  jitter: JitterStats;
}

/** A fresh, zeroed set of media counters. */
function zeroedMediaCounters(): JitterStats {
  return {
    received: 0,
    emitted: 0,
    duplicates: 0,
    reordered: 0,
    lost: 0,
    tooLate: 0,
    evicted: 0,
    discarded: 0,
    jitterMs: 0,
    maxDepth: 0,
    resyncs: 0,
  };
}

/** 20 ms at 16 kHz — the packetization the engine and telephony both use. */
const ENGINE_SAMPLES_PER_FRAME = 320;
const RTP_SAMPLES_PER_FRAME = 160; // the same 20 ms at the 8 kHz codec clock

export class SipCall {
  private readonly deps: SipCallDeps;
  private readonly now: () => number;
  private readonly log: LogSink;
  private readonly timers: LifecycleTimers;
  private readonly seamCallbackDeadlineMs: number;
  private readonly seamHandshakeDeadlineMs: number;
  readonly dialog: SipDialog;

  /**
   * The single teardown authority for this call. Everything that wants the
   * call to end — a BYE, an RTP socket error, a policy refusal, the seam
   * itself — signals it here. Nothing else releases anything.
   */
  readonly lifecycle: CallLifecycle;

  private codec: Codec | null = null;
  private jitter: JitterBuffer | null = null;
  private target: RtpTarget | null = null;
  private released = false;
  /** Whether the seam was actually told someone joined; only then is a leave true. */
  private participantAnnounced = false;
  /**
   * The in-flight seam handshake: openSession, then participantJoined.
   *
   * ONE promise for both, because they are one event as far as the seam is
   * concerned and tracking them separately produced the same defect twice.
   * Teardown waits for it rather than racing it: without that, the seam could
   * observe openSession:start → closeSession → openSession:done and be left
   * holding a live session Videofy believes it released, or — with only the
   * open tracked — receive participantJoined AFTER closeSession, a person
   * joining a call it has already been told is over. Both are the same shape
   * of failure, on the far side of a boundary where we cannot go and clean up.
   */
  private handshake: Promise<void> | null = null;
  /** Whether the seam actually acknowledged the session; only then is it certain. */
  private sessionOpened = false;
  private releaseTransport: (() => void) | undefined;

  /** Our sender state. Independent of anything the far end sends us. */
  private outboundSequence = Math.floor(Math.random() * 0xffff);
  private outboundTimestamp = 0;
  private readonly outboundSsrc = Math.floor(Math.random() * 0xffffffff) >>> 0;
  private outboundRemainder = new Int16Array(0);

  /** Media clock of the remote stream, held so gaps stay measurable. */
  private lastRemoteSsrc: number | null = null;
  /**
   * RFC 3550 requires a RANDOM initial RTP timestamp, and a restarted stream
   * gets a new one. Emitting the raw value would hand the seam a media time
   * anywhere within six days of nowhere, and jump it arbitrarily mid-call.
   * Latched here so the seam receives time measured from this call's start.
   *
   * One base PER STREAM. Latching a single base lazily at pump time took it
   * from whichever packet happened to run first — which, right after an SSRC
   * change, is a leftover packet of the OLD stream. Every packet of the new
   * stream was then measured against the old stream's random base, stamping
   * frames tens of hours out.
   */
  private readonly streamBases = new Map<
    number,
    { base: number; offsetMs: number; lastMediaMs: number; lastArrivalMs: number }
  >();
  /**
   * How far a frame's media time may outrun the wall clock before we stop
   * believing it belongs to the same run. Generous: real speech gaps move
   * both clocks together, and a re-base misses by hours.
   */
  private static readonly RUN_CONTINUITY_LIMIT_MS = 30_000;
  /**
   * The sender's current run. Incremented whenever the far end demonstrably
   * restarted — a new SSRC, or a resync on the same one — so that a frame is
   * always measured against the base of the run it actually came from.
   */
  private streamGeneration = 0;
  /** Whether any run has ever been timed, which is not the same as "none held". */
  private anyStreamLatched = false;
  private lastRemoteSsrcTimestamp = 0;
  /** Media time of the last frame actually delivered, for stream carry-over. */
  private lastEmittedMediaTimeMs = 0;

  /**
   * Media that has LEFT the jitter buffer and not yet reached the seam.
   *
   * There is exactly one of these, and it is the only place an extracted
   * packet may live. The predecessor copied playable packets into a local
   * array inside the pump and cleared the carry-over queue, so a hangup
   * landing between two frames left them owned by nobody: the drain flushed a
   * buffer they were no longer in, and no counter moved. A frame is here, or
   * in flight, or counted.
   */
  private readonly pending: OwnedFrame[] = [];
  /** The one frame currently being handed over, owned until the push settles. */
  private inFlight: OwnedFrame | null = null;
  /**
   * The pending queue holds media, so it is bounded like the buffer it came
   * from. A peer varying SSRC on every packet would otherwise grow it without
   * limit while the jitter buffer reported a healthy 200.
   */
  private static readonly MAX_PENDING = 200;

  readonly measurements: CallMeasurements = {
    transcodeInMsTotal: 0,
    transcodeOutMsTotal: 0,
    framesIn: 0,
    framesOut: 0,
    packetsAccepted: 0,
    framesExtracted: 0,
    framesDelivered: 0,
    framesDiscarded: 0,
    packetsRejectedAfterShutdown: 0,
    packetsBeforeNegotiation: 0,
    transportMsTotal: 0,
    bufferResidenceMsTotal: 0,
    seamHandoffMsTotal: 0,
    jitterTargetMs: 60,
    malformedPackets: 0,
    unsupportedPayloadPackets: 0,
    refusedMediaDestinations: 0,
    staleRequests: 0,
    mediaClockRebases: 0,
    coalescedPumps: 0,
    seamHandshakeTimeouts: 0,
    jitter: zeroedMediaCounters(),
  };

  /**
   * The counters of every jitter buffer this call has RETIRED.
   *
   * `measurements.jitter` used to be a mirror of the live buffer's stats,
   * assigned wholesale on every pump. That is fine while a call has one
   * buffer for its whole life and catastrophic the moment it does not: a
   * re-INVITE built a fresh buffer, the next pump copied its zeroed counters
   * over the top, and a call that had received eight packets reported one.
   * The history of a call cannot live inside an object the call is allowed to
   * replace.
   */
  private readonly retiredJitter: JitterStats = zeroedMediaCounters();

  constructor(deps: SipCallDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    // Wrapped once, here. Every log line in this file goes through it,
    // including the ones inside the UDP handler that documents itself as
    // never throwing — a throwing log sink was enough to make a call
    // permanently unclosable and to throw into a socket callback.
    this.log = guardedLogger(deps.log);
    this.timers = deps.timers ?? SYSTEM_TIMERS;
    this.seamCallbackDeadlineMs = deps.seamCallbackDeadlineMs ?? 1000;
    this.seamHandshakeDeadlineMs = deps.seamHandshakeDeadlineMs ?? 5000;
    this.releaseTransport = deps.releaseTransport;
    this.dialog = new SipDialog(
      deps.mintParticipantId ? { mintParticipantId: deps.mintParticipantId } : {},
    );
    this.lifecycle = new CallLifecycle({
      steps: {
        drain: () => this.drainForTeardown(),
        discard: (intent) => this.discardPending(intent),
        release: () => this.releaseOwnedResources(),
        notify: (intent) => this.notifySeam(intent),
      },
      ...(deps.timers === undefined ? {} : { timers: deps.timers }),
      ...(deps.gracePeriodMs === undefined ? {} : { gracePeriodMs: deps.gracePeriodMs }),
      ...(deps.terminationDeadlineMs === undefined
        ? {}
        : { terminationDeadlineMs: deps.terminationDeadlineMs }),
      ...(deps.log === undefined ? {} : { log: deps.log }),
    });
  }

  /**
   * OUR id for this call, minted locally. The SIP Call-ID is chosen by the
   * caller and is therefore untrusted input: using it verbatim would let a
   * peer name — or collide with — another call's session on the seam, and
   * would push an external identifier across a boundary whose whole purpose
   * is that external identifiers stay adapter metadata.
   */
  private readonly localSessionId = `sc_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

  get sessionId(): string {
    return this.localSessionId;
  }

  get participantId(): string {
    return this.dialog.snapshot().participantId;
  }

  /**
   * Handle an INVITE: negotiate a codec, open the seam session, and answer.
   * Codec selection happens exactly once, here — by the time audio flows there
   * is nothing left to decide, so no packet can trigger a guess.
   */
  /**
   * Refuse this INVITE, and decide what refusing it costs.
   *
   * A failed RENEGOTIATION changes nothing: 488 means "not this offer", not
   * "this call is over", and the session already running carries on.
   *
   * An INITIAL INVITE is the opposite. The call never existed, and it has to
   * END — through the lifecycle, because that is the only thing that releases
   * the RTP socket and pump timer this call was handed. A 488 is a FINAL
   * response, so the peer ACKs and never sends a BYE: there is no second
   * chance to notice. Every refusal path used to have to remember this for
   * itself, and the one that did not — an offer with no audio m-line — leaked
   * a bound socket, a timer and a live call to any unauthenticated caller,
   * repeatable at will.
   */
  private refuseInvite(
    message: SipMessage,
    status: number,
    reason: string,
    isRenegotiation: boolean,
    why: string,
  ): void {
    this.respond(message, status, reason);
    if (isRenegotiation) {
      this.log('sip re-INVITE refused; the existing session carries on', {
        sessionId: this.sessionId,
        why,
      });
      return;
    }
    this.dialog.terminate();
    void this.close(why, 'abort');
  }

  async onInvite(message: SipMessage): Promise<void> {
    // Whether there is an established call to protect, read BEFORE anything
    // below can change it.
    const isRenegotiation = this.codec !== null;
    try {
      await this.negotiate(message, isRenegotiation);
    } catch (error) {
      // A THROWN failure of an initial INVITE — a malformed dialog, a seam
      // that refused the session or the participant — leaves a call nobody
      // will ever hang up, for the same reason a 488 does: the outcome is
      // final and no BYE is coming. Ending it here is what releases the
      // transport. A renegotiation that throws leaves the live call alone.
      if (!isRenegotiation) {
        this.dialog.terminate();
        void this.close('invite failed', 'abort');
      }
      throw error;
    }
  }

  private async negotiate(message: SipMessage, isRenegotiation: boolean): Promise<void> {
    // A hung-up DIALOG stays hung up: SIP retransmits, so an INVITE for this
    // Call-ID can arrive after a BYE, and without this the seam session would
    // re-open and a dead call would hold resources nobody is using. The test
    // is whether the call still ACCEPTS anything, not whether teardown has
    // finished — a call halfway through its drain is just as finished to a
    // new INVITE as one that is fully closed.
    //
    // Scoped to the dialog on purpose. A genuinely NEW call from the same
    // endpoint carries a different Call-ID and must still be able to start —
    // it simply belongs to a different SipCall, not this terminated one.
    if (!this.lifecycle.acceptingMedia) {
      const sameDialog = this.dialog.matches(message);
      this.respond(message, sameDialog ? 481 : 500, sameDialog ? 'Call/Transaction Does Not Exist' : 'Server Internal Error');
      return;
    }
    // A re-INVITE re-negotiates media on a dialog that already exists. The
    // seam session and the participant were opened by the first INVITE and
    // must not be opened twice — the person did not join the call again.
    // RFC 3261 §12.2.2. Refused BEFORE `receiveInvite`, which overwrites the
    // dialog's stored offer with whatever arrived — after which negotiation is
    // re-run from a message the dialog has already moved past.
    if (this.dialog.isStaleRequest(message)) {
      this.log('sip refused an INVITE the dialog has already passed', { sessionId: this.sessionId });
      this.measurements.staleRequests += 1;
      this.respond(message, 500, 'Server Internal Error');
      return;
    }
    // A RETRANSMIT, absorbed BEFORE anything is negotiated. A UAC repeats its
    // INVITE every T1 until it gets a response, so a seam that takes longer
    // than half a second to open guarantees a second INVITE arrives while the
    // first is still parked on the handshake below.
    //
    // The absorption used to sit further down, after a codec had been chosen
    // and `this.codec`, the jitter buffer and `this.target` had all been
    // reassigned from the retransmit's own offer. If that offer differed at
    // all — an SBC re-offering while its far leg is still answering — the
    // first INVITE then sent a 200 OK advertising ITS codec while the call had
    // quietly switched to the other one, and every packet the peer sent was
    // refused as unnegotiated. Answering nothing is only safe if nothing was
    // changed on the way to not answering.
    //
    // The test is `participantAnnounced`, not `sessionOpened`: the handshake
    // is not finished until the seam has been told WHO is on the call. An
    // openSession that succeeded followed by a participantJoined that failed
    // used to pass this guard, so the retransmit was answered 200 and the
    // call went fully live pushing speech for a participant the seam had
    // never heard of.
    if (this.handshake !== null && !this.participantAnnounced && this.dialog.matches(message)) {
      // 100 Trying is not a final response, so it cannot collide with the 200
      // the first INVITE will send. It is what SIP prescribes for "received,
      // still working", and it stops the retransmit timer without committing
      // to an answer we are not yet entitled to give.
      this.respond(message, 100, 'Trying');
      return;
    }
    const snapshot = this.dialog.receiveInvite(message);
    const offered = snapshot.remoteSdp?.audio;
    if (offered === undefined || offered === null) {
      this.refuseInvite(message, 488, 'Not Acceptable Here', isRenegotiation, 'no audio offered');
      return;
    }
    const chosen = this.chooseCodec(offered.payloadTypes);
    if (chosen === null) {
      // Refuse rather than transcode something we never agreed to carry.
      this.refuseInvite(
        message,
        488,
        'Not Acceptable Here',
        isRenegotiation,
        'no acceptable codec offered',
      );
      return;
    }
    const previousCodec = this.codec;
    const previousJitter = this.jitter;
    this.codec = chosen;
    if (previousJitter === null || previousCodec === null) {
      this.jitter = new JitterBuffer({}, chosen.clockRate);
    } else if (previousCodec.payloadType !== chosen.payloadType) {
      // The codec changed under media that is already held. Those packets
      // arrived as the OLD codec, so they are taken into custody bound to it
      // before anything can decode them as the new one.
      // RELEASED, not flushed. `flush()` also forgets the play pointer, which
      // is right at hangup and wrong here: this buffer is being kept, and a
      // re-INVITE does not restart the sender's sequence space.
      this.admit(previousJitter.releaseHeld(), previousCodec);
      // RETUNED, not replaced. A renegotiation can change what an RTP tick is
      // worth; it does not make this a different sender, and building a fresh
      // buffer for it discarded both the audio held and the call's whole
      // measured history. A re-INVITE is a renegotiation, not a new call, and
      // a call does not get to forget its own first half.
      previousJitter.retune(chosen.clockRate);
    }
    // Otherwise the buffer is KEPT. A hold/unhold re-INVITE that renegotiates
    // to the same codec used to destroy it — dropping everything it held,
    // uncounted, and resetting the call's statistics to zero — for no reason
    // beyond the assignment sitting on the path that both INVITEs take.
    this.publishJitterStats();
    // Port 0 is the documented way to say HOLD. Beyond that, the address the
    // caller named is checked against POLICY — the call is still answered, but
    // media goes nowhere we were not configured to send it.
    const policy = this.deps.mediaPolicy ?? LOOPBACK_ONLY;
    // A UDP port is sixteen bits. `parseSdp` hands back whatever integer the
    // offer names, and an out-of-range one reaches dgram.send as a synchronous
    // RangeError — thrown out of `sendToEndpoint`, which is called from the
    // engine side, so one malformed SDP line from an unauthenticated caller
    // stops that call's outbound audio for good.
    const reachable = Number.isInteger(offered.port) && offered.port > 0 && offered.port <= 65535;
    const permitted = reachable && maySendMediaTo(offered.address, policy);
    if (!reachable ? offered.port !== 0 : !permitted) {
      this.log('sip media destination refused by policy', { sessionId: this.sessionId });
      this.measurements.refusedMediaDestinations += 1;
    }
    this.target = permitted ? { address: offered.address, port: offered.port } : null;

    if (!isRenegotiation) {
      const handshake = Promise.resolve(
        this.deps.port.openSession({
          sessionId: this.sessionId,
          platformSessionRef: snapshot.identity.callId,
        }),
      ).then(async () => {
        this.sessionOpened = true;
        // A close can land while the seam is still opening; introducing a
        // participant to a call that is already ending would announce someone
        // who will never speak.
        if (!this.lifecycle.acceptingMedia) return;
        await this.deps.port.participantJoined(
          this.sessionId,
          snapshot.participantId,
          snapshot.remoteDisplayName,
        );
        // Only now is a matching participantLeft owed at teardown.
        this.participantAnnounced = true;
      });
      this.handshake = handshake;
      // Teardown may end up being the only thing that ever awaits this. A
      // rejection with nobody attached takes the process down for a seam that
      // merely said no.
      handshake.catch(() => {});
      // BOUNDED, like every other call across this seam.
      //
      // This was the one bare await left in the file, and a seam that simply
      // stops answering is the failure mode everything else here is built
      // around. Parked on it, `onInvite` never returns and no 200 OK is ever
      // sent — so no ACK and no BYE ever arrive, the lifecycle never leaves
      // ACTIVE, and nothing inside this object will ever call close(). The
      // RTP socket, the pump timer, the buffers and the call itself leak, one
      // set per INVITE, for as long as the seam is degraded, and they do not
      // come back when it recovers. A hanging callback is indistinguishable
      // from a slow one until a deadline says otherwise, and without a
      // deadline it is indistinguishable from a slow one forever.
      const settled = await invokeBounded(
        () => handshake,
        this.seamHandshakeDeadlineMs,
        this.timers,
      );
      if (settled === 'rejected') {
        // ANSWERED before rethrowing. A retransmit absorbed with 100 Trying
        // has already moved the caller's transaction from Calling into
        // Proceeding, where its Timer B no longer applies — so a silent
        // rejection leaves that transaction with a provisional and no final,
        // forever. The caller holds ringback for minutes on a call the seam
        // refused in under a second, no failover fires, and the carrier leg
        // stays pinned for the life of the hung transaction. The sibling
        // timeout branch below has always said 504 rather than nothing; a
        // refusal has to be just as final.
        this.respond(message, 503, 'Service Unavailable');
        // Rethrown deliberately. A seam that REFUSES a call must fail loudly:
        // the caller of onInvite learns why, and the catch there ends the call
        // and releases what it was holding.
        await handshake;
      }
      if (settled === 'timed-out') {
        this.log('sip seam did not complete the opening handshake in time', {
          sessionId: this.sessionId,
          deadlineMs: this.seamHandshakeDeadlineMs,
        });
        this.measurements.seamHandshakeTimeouts += 1;
        // 504 rather than silence: the caller is told, once, that this call is
        // not happening, and the lifecycle releases the transport.
        this.refuseInvite(message, 504, 'Server Time-out', isRenegotiation, 'seam handshake timed out');
        return;
      }
    }

    // Re-read after every await above: a close can land at any of them.
    //
    // Answering 200 here would advertise media for a call that no longer
    // exists — but answering NOTHING is worse, and that is what this did. A
    // retransmit absorbed with 100 Trying has already moved the caller's
    // transaction into Proceeding, where it has no timer of its own, so
    // silence holds ringback on a call that is already closed and released
    // and pins the carrier leg behind it.
    //
    // This is the THIRD exit from the same await. The other two learned to
    // answer — 503 when the seam refuses, 504 when it never replies — and
    // this one was left silent because each was fixed as it was reported
    // rather than by auditing every way out.
    if (!this.lifecycle.acceptingMedia) {
      this.respond(message, 487, 'Request Terminated');
      return;
    }
    this.respond(message, 200, 'OK', buildSdp({
      address: this.deps.localAddress,
      port: this.deps.localRtpPort,
      payloadType: chosen.payloadType,
      codecName: chosen.name,
      clockRate: chosen.clockRate,
      sessionId: Math.floor(this.now() / 1000),
    }));
  }

  /** Offer order is the peer's preference; we honour it among what we support. */
  private chooseCodec(offeredPayloadTypes: readonly number[]): Codec | null {
    for (const payloadType of offeredPayloadTypes) {
      const codec = codecForPayloadType(payloadType);
      if (codec !== null) return codec;
    }
    return null;
  }

  onAck(): DialogSnapshot {
    return this.dialog.receiveAck();
  }

  /** A datagram arrived. Never throws: bad packets are counted, not fatal. */
  onRtpDatagram(datagram: Buffer): void {
    // New media is refused the moment shutdown begins — not when it finishes.
    // Admitting a packet into a buffer that teardown has already flushed is
    // how audio arrives for a session the seam has been told is over.
    if (!this.lifecycle.acceptingMedia) {
      this.measurements.packetsRejectedAfterShutdown += 1;
      return;
    }
    let packet;
    try {
      packet = parseRtpPacket(datagram, this.now());
    } catch (error) {
      if (error instanceof RtpParseError) {
        this.measurements.malformedPackets += 1;
        return;
      }
      throw error;
    }
    const codec = this.codec;
    const jitter = this.jitter;
    if (codec === null || jitter === null) {
      // Media for a call that has not agreed to carry any yet.
      this.measurements.packetsBeforeNegotiation += 1;
      return;
    }
    if (packet.payloadType !== codec.payloadType) {
      // A payload type we did not negotiate. Counted and dropped — decoding it
      // as if it were the agreed codec would produce confident noise.
      this.measurements.unsupportedPayloadPackets += 1;
      return;
    }
    // An SSRC change is a MEDIA event: a re-INVITE, a device swap, a gateway
    // restarting its sender. The dialog says who is on the call, so the
    // participant does not change — only the stream's continuity does.
    if (this.lastRemoteSsrc !== null && packet.ssrc !== this.lastRemoteSsrc) {
      this.log('sip rtp ssrc changed; same participant, new stream', { sessionId: this.sessionId });
      // Bound to the codec in force NOW, which is the one the outgoing
      // stream's packets arrived under — a renegotiation flushes the buffer
      // before it changes the codec, so nothing older than this can be here.
      // Whatever was held was still spoken. It is carried into the pending
      // queue rather than dropped, and the buffer keeps its counters so the
      // call's measurements stay true across the restart.
      //
      // Continue from what was actually DELIVERED, not from a timestamp of a
      // stream that may never have been drained. The new stream's offset is
      // derived when its base is latched, so no value needs carrying across
      // the change itself.
      this.admit(jitter.resetStream(), codec);
      // AFTER the admit: everything just taken into custody belongs to the run
      // that is ending, and must keep being measured against its base.
      this.streamGeneration += 1;
    }
    this.lastRemoteSsrc = packet.ssrc;
    this.lastRemoteSsrcTimestamp = packet.rtpTimestamp;
    // From this line the packet is this call's, and the ledger's denominator
    // says so. Counting at PUSH rather than at extraction is the whole point
    // of the change: everything that happens to this packet afterwards has to
    // add back up to this number, including everything the buffer does to it.
    this.measurements.packetsAccepted += 1;
    const resyncsBefore = jitter.stats.resyncs;
    jitter.push(packet);
    if (jitter.stats.resyncs !== resyncsBefore) {
      // The SENDER re-anchored without changing its SSRC. The buffer already
      // re-anchors its sequence for this and counts what it threw away; the
      // media clock has to re-anchor too, or every packet from here on is
      // measured against a base the sender abandoned. Anything already
      // extracted keeps the previous generation and its own correct base.
      this.log('sip rtp sender re-anchored on the same ssrc; new media run', {
        sessionId: this.sessionId,
      });
      this.streamGeneration += 1;
    }
  }

  /** The chain that makes delivery single-file. See `enqueueDelivery`. */
  private deliveryChain: Promise<void> = Promise.resolve();

  /**
   * Release everything the jitter buffer will now allow, transcode it, and
   * hand it to the seam. Driven by a timer in production and directly in
   * tests, so playout never depends on a packet happening to arrive.
   *
   * Serialized: overlapping callers queue behind each other. Media order is a
   * hard invariant — a listener can forgive a gap, but two halves of a
   * sentence arriving swapped is worse than either half being lost.
   */
  async pump(): Promise<void> {
    // COALESCED, and this is a bound, not an optimisation.
    //
    // A pump drains everything currently available, so a second one queued
    // behind the first would only do the first one's work over again. The
    // production driver is a timer that neither awaits nor catches — this
    // file prescribes exactly that shape — so whenever a delivery task
    // outlasts one tick, appending unconditionally grew the chain by ~50
    // links a second while completing one. Every other media queue here is
    // deliberately bounded (maxPackets and maxBytes in the buffer,
    // MAX_PENDING in the call); the queue of pump TASKS was not, and it ends
    // in the process running out of memory. The ledger stays perfectly
    // balanced throughout, every frame counted as discarded, which is why
    // nothing else notices.
    //
    // A seam that never settles is only the extreme case: any seam
    // sustainedly slower than real time diverges the same way.
    const queued = this.queuedPump;
    if (queued !== null) {
      this.measurements.coalescedPumps += 1;
      return queued;
    }
    const next = this.enqueueDelivery(() => {
      // Cleared as the task STARTS, so a pump requested while this one runs
      // still queues one successor rather than being swallowed. At most one
      // running and one waiting, whatever the driver does.
      this.queuedPump = null;
      return this.pumpOnce();
    });
    this.queuedPump = next;
    return next;
  }

  /** The pump waiting behind the running one, if any. See `pump`. */
  private queuedPump: Promise<void> | null = null;
  /** Delivery tasks appended to the chain and not yet settled. */
  private outstandingDeliveries = 0;

  /**
   * How many delivery tasks are queued right now. Bounded by construction —
   * a test that asserts this stays small is asserting the chain cannot grow.
   */
  get queuedDeliveries(): number {
    return this.outstandingDeliveries;
  }

  /**
   * Everything that hands frames to the seam goes through here, including the
   * teardown drain. One queue, one order, one place where a frame can be in
   * flight. The returned promise never rejects: a pump driven by setInterval
   * attaches no catch, and an unhandled rejection there would take the process
   * down for one unhappy frame.
   */
  private enqueueDelivery(task: () => Promise<void>): Promise<void> {
    this.outstandingDeliveries += 1;
    const next = this.deliveryChain
      // Run inside the call's own context so that a close raised from within
      // a delivery callback is recognised as re-entrant rather than joining a
      // teardown queue that this very task is blocking.
      .then(() => this.lifecycle.runOwnedWork(task))
      .catch((error: unknown) => {
        this.log('sip call delivery task failed', {
          message: error instanceof Error ? error.message : 'unknown',
        });
      })
      .finally(() => {
        this.outstandingDeliveries -= 1;
      });
    this.deliveryChain = next;
    return next;
  }

  private async pumpOnce(): Promise<void> {
    const jitter = this.jitter;
    const codec = this.codec;
    // Once shutdown begins, only teardown moves packets out of the buffer:
    // two flushes racing is how the same audio was counted twice and the
    // remainder counted not at all.
    if (jitter !== null && codec !== null && this.lifecycle.acceptingMedia) {
      this.admit(jitter.drain(this.now()), codec);
      this.publishJitterStats();
    }
    await this.deliverPending();
  }

  /**
   * Take custody of packets leaving the buffer. From this line they are this
   * call's responsibility, and the ledger says so.
   */
  private admit(emitted: readonly EmittedPacket[], codec: Codec): void {
    if (emitted.length === 0) return;
    const generation = this.streamGeneration;
    for (const packet of emitted) this.pending.push({ emitted: packet, codec, generation });
    this.measurements.framesExtracted += emitted.length;
    let overflowed = 0;
    while (this.pending.length > SipCall.MAX_PENDING) {
      this.pending.shift();
      this.measurements.framesDiscarded += 1;
      overflowed += 1;
    }
    if (overflowed > 0) {
      this.log('sip call pending media queue overflowed; oldest audio dropped', {
        frames: overflowed,
      });
    }
  }

  /**
   * Deliver owned frames, in order, for as long as delivery is permitted.
   *
   * The loop re-reads the lifecycle every frame rather than capturing a
   * boolean, because a graceful close can be escalated to an abort between
   * two frames and the second half of that hangup must not be delivered.
   */
  private async deliverPending(): Promise<void> {
    // Re-read every frame, like the lifecycle. Audio must not reach the seam
    // before the seam has been told both that this session exists AND who is
    // speaking on it — a frame carries a participantId, and pushing one for a
    // participant the seam never received a join for hands the engine words
    // it cannot route, on the far side of a boundary we cannot reach back
    // across. Frames simply wait here: they stay owned, the ledger still
    // balances, and the next pump delivers them once the handshake lands.
    while (this.pending.length > 0 && this.lifecycle.deliveringMedia && this.participantAnnounced) {
      const owned = this.pending.shift();
      if (owned === undefined) break;
      // Ownership moves from the queue to this slot and stays explicit until
      // the push settles. A frame between the buffer and the seam belongs to
      // exactly one place, and teardown can see it there.
      this.inFlight = owned;
      const packet = owned.emitted.packet;
      // The codec this packet ARRIVED under, carried with it since admission
      // rather than read from a field a re-INVITE is allowed to change.
      const codec = owned.codec;
      const decoded = decodeToEngineFormat(codec, packet.payload, this.now);
      this.measurements.transcodeInMsTotal += decoded.elapsedMs;
      this.measurements.framesIn += 1;

      const frame: AdapterAudioFrame = {
        participantId: this.participantId,
        samples: decoded.samples,
        sampleRate: 16000,
        channelCount: 1,
        // The media clock converted to milliseconds — NOT arrival time, which
        // would make every network hiccup look like the speaker paused.
        platformTimestampMs: this.mediaTimeMs(
          packet.rtpTimestamp,
          codec.clockRate,
          owned.generation,
          packet.arrivedAtMs,
        ),
      };
      // Residence: arrival to the moment it became playable.
      const readyAt = this.now();
      this.measurements.bufferResidenceMsTotal += readyAt - packet.arrivedAtMs;
      // The seam is application code. It may reject, and it may simply never
      // answer — which is indistinguishable from slow until a deadline says
      // otherwise. One frame costs one deadline, never the call.
      const outcome = await invokeBounded(
        () => this.deps.port.pushAudio(this.sessionId, frame),
        this.seamCallbackDeadlineMs,
        this.timers,
      );
      if (this.inFlight !== owned) {
        // Teardown accounted for this frame while the push was still in
        // flight. Counting it again would make the ledger lie the other way.
        return;
      }
      this.inFlight = null;
      if (outcome !== 'ok') {
        this.measurements.framesDiscarded += 1;
        this.log('sip seam did not take a frame; discarded rather than retried', { outcome });
        // A seam that stopped answering will not answer the next frame, and a
        // retry would decode the same 20 ms twice into the same counters.
        return;
      }
      this.measurements.framesDelivered += 1;
      const handedOffAt = this.now();
      this.lastEmittedMediaTimeMs = frame.platformTimestampMs;
      this.measurements.seamHandoffMsTotal += handedOffAt - readyAt;
      this.measurements.transportMsTotal += handedOffAt - packet.arrivedAtMs;
    }
  }

  /**
   * Send engine audio back to the caller. Accepts any frame length and
   * re-packetizes to exactly 20 ms, because RTP timing is ours to keep: a
   * short frame must not become a short packet with a wrong timestamp step.
   */
  sendToEndpoint(samples: Int16Array): void {
    // A call that has begun hanging up does not speak. Egress is stopped at
    // the same moment ingress is, so the two halves cannot disagree about
    // whether the call is still live.
    if (!this.lifecycle.acceptingMedia || this.codec === null || this.target === null) return;
    const pending = new Int16Array(this.outboundRemainder.length + samples.length);
    pending.set(this.outboundRemainder);
    pending.set(samples, this.outboundRemainder.length);

    let offset = 0;
    while (pending.length - offset >= ENGINE_SAMPLES_PER_FRAME) {
      const slice = pending.subarray(offset, offset + ENGINE_SAMPLES_PER_FRAME);
      offset += ENGINE_SAMPLES_PER_FRAME;
      const encoded = encodeFromEngineFormat(this.codec, slice, this.now);
      this.measurements.transcodeOutMsTotal += encoded.elapsedMs;
      this.measurements.framesOut += 1;
      this.deps.sendRtp(
        serializeRtpPacket({
          payloadType: this.codec.payloadType,
          sequenceNumber: this.outboundSequence,
          rtpTimestamp: this.outboundTimestamp,
          ssrc: this.outboundSsrc,
          payload: encoded.payload,
        }),
        this.target,
      );
      this.outboundSequence = (this.outboundSequence + 1) & 0xffff;
      // Advances by SAMPLES at the codec clock, never by wall-clock time.
      this.outboundTimestamp = (this.outboundTimestamp + RTP_SAMPLES_PER_FRAME) >>> 0;
    }
    this.outboundRemainder = pending.slice(offset);
  }

  /**
   * Hang up. This is a SIGNAL, not the teardown itself: it says what should
   * happen and how strongly, and the lifecycle decides the rest. Calling it
   * twice, calling it from inside a seam callback, and calling it from two
   * handlers in the same tick are all ordinary.
   */
  async close(reason: string, mode: TerminationMode = 'graceful'): Promise<void> {
    return this.lifecycle.requestClose(reason, mode);
  }

  // --- the four teardown steps ---------------------------------------------

  /**
   * Deliver what the caller already said. Flushing it into the void loses the
   * last words of every call, which is exactly the audio a listener most
   * notices missing.
   *
   * It joins the delivery chain rather than racing it, so a hangup landing
   * mid-pump queues behind that pump instead of interleaving frames with it.
   */
  private async drainForTeardown(): Promise<void> {
    await this.enqueueDelivery(async () => {
      const jitter = this.jitter;
      const codec = this.codec;
      if (jitter !== null && codec !== null) {
        this.admit(jitter.flush(), codec);
        this.publishJitterStats();
      }
      await this.deliverPending();
    });
  }

  /**
   * Everything extracted and never delivered, released and COUNTED. After an
   * abort this is the buffered speech of a call we have just declared
   * untrustworthy; after a graceful close it is whatever the seam would not
   * take in time. Either way it does not leave silently.
   */
  private discardPending(intent: TerminationIntent): void {
    const jitter = this.jitter;
    const codec = this.codec;
    // Whatever is still in the buffer is extracted here purely so it can be
    // COUNTED, rather than freed by the garbage collector with no record that
    // it ever existed. Unconditional on purpose: an abort never ran the
    // drain, and a graceful close escalated at its grace period may not have
    // reached the drain either — the mode says whether we tried to deliver,
    // never whether we are allowed to lose audio quietly.
    //
    // Without a codec there is nothing to bind the frames to, so they stay in
    // the buffer and `release` counts them as the buffer abandoning them. The
    // ledger sees them either way; only the bucket differs.
    if (jitter !== null && codec !== null) this.admit(jitter.flush(), codec);
    const orphaned = this.pending.length + (this.inFlight === null ? 0 : 1);
    this.pending.length = 0;
    this.inFlight = null;
    if (orphaned === 0) return;
    this.measurements.framesDiscarded += orphaned;
    this.log('sip call discarded undelivered media at teardown', {
      frames: orphaned,
      mode: intent.mode,
    });
  }

  /**
   * Release everything this call owns. Nothing here awaits, nothing here can
   * throw, and nothing application-supplied stands between the call and this
   * line — a telecom session that half-dies consumes a server while serving
   * nobody, and a callback must never be the reason it does.
   */
  private releaseOwnedResources(): void {
    this.dialog.terminate();
    const jitter = this.jitter;
    // RETIRED, not merely dereferenced. A buffer that still held audio would
    // otherwise take both its contents and its counters out of the ledger
    // with it, which is the exact shape of the failure this accounting exists
    // to catch — and the last place in the call where it could still happen.
    if (jitter !== null) this.retireJitterBuffer(jitter);
    this.jitter = null;
    this.publishJitterStats();
    this.codec = null;
    this.target = null;
    this.outboundRemainder = new Int16Array(0);
    this.lastRemoteSsrc = null;
    this.lastRemoteSsrcTimestamp = 0;
    this.streamBases.clear();
    const release = this.releaseTransport;
    // Exactly once, and the field is cleared BEFORE the call so a throwing
    // hook cannot be attempted twice.
    this.releaseTransport = undefined;
    if (release !== undefined) {
      try {
        release();
      } catch (error) {
        this.log('sip call transport release failed; resources may leak upstream', {
          message: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
    this.released = true;
  }

  /**
   * Tell the seam. It is application code on the far side of a boundary, so
   * both calls are bounded and neither result changes what has already been
   * released. The reason is read HERE, as late as possible: an abort that
   * overtook a graceful close must reach the seam as the abort's reason, not
   * as the "bye" it replaced.
   */
  private async notifySeam(intent: TerminationIntent): Promise<void> {
    const sessionId = this.sessionId;
    const participantId = this.participantId;
    const handshake = this.handshake;
    if (handshake === null) {
      // No INVITE was ever answered, so the seam has never heard of this call.
      // Closing a session that was never opened is not harmless noise: it is a
      // message about a session the seam would have to invent to understand.
      this.log('sip call ended before any seam session was opened', { reason: intent.reason });
      return;
    }
    // The WHOLE handshake, not just the open. Waiting only for openSession
    // let a slow participantJoined resolve after teardown had already sent
    // closeSession, so the seam was told someone joined a call it had been
    // told was over. Bounded like every other seam interaction — a handshake
    // that never answers costs one deadline, not the call.
    // The HANDSHAKE budget, not the single-callback one. These are two
    // deadlines on the same promise, and they cannot both be right: the call
    // kept a handshake alive for five seconds while teardown buried it at
    // one, so an ordinary slow-but-healthy openSession was declared timed out
    // here and closeSession went out while it was still in flight — the exact
    // openSession:start → closeSession → openSession:done ordering the rest of
    // this method exists to prevent.
    const settled = await invokeBounded(
      () => handshake,
      this.seamHandshakeDeadlineMs,
      this.timers,
    );
    if (settled === 'rejected' && !this.sessionOpened) {
      // The seam refused the SESSION outright, so there is nothing to close
      // and nobody to say goodbye to. A handshake that failed at the
      // participant step is different: that session does exist.
      this.log('sip seam refused the session; nothing to close', { reason: intent.reason });
      return;
    }
    if (settled === 'timed-out') {
      // Unknown, which is not the same as absent. The seam may well have
      // created the session before it stopped answering, and leaking a live
      // session is worse than one redundant close.
      this.log('sip seam handshake never answered; closing on a best-effort basis', {
        reason: intent.reason,
      });
    }
    if (this.participantAnnounced && participantId !== '') {
      const left = await invokeBounded(
        () => this.deps.port.participantLeft(sessionId, participantId),
        this.seamCallbackDeadlineMs,
        this.timers,
      );
      if (left !== 'ok') {
        this.log('sip seam participantLeft did not complete; continuing teardown', {
          outcome: left,
        });
      }
    }
    const closed = await invokeBounded(
      () => this.deps.port.closeSession(sessionId, intent.reason),
      this.seamCallbackDeadlineMs,
      this.timers,
    );
    if (closed !== 'ok') {
      this.log('sip seam closeSession did not complete', { outcome: closed });
    }
  }

  // --- what the call will admit to ------------------------------------------

  /**
   * True only once resources are genuinely released. It used to become true
   * the instant a hangup started, which meant a wedged teardown reported a
   * closed call while it still held a session, a buffer and a socket.
   */
  get isClosed(): boolean {
    return this.lifecycle.isClosed;
  }

  get lifecycleState(): LifecycleState {
    return this.lifecycle.state;
  }

  get isAcceptingMedia(): boolean {
    return this.lifecycle.acceptingMedia;
  }

  get isDeliveringMedia(): boolean {
    return this.lifecycle.deliveringMedia;
  }

  /** Proof, for tests and operators, that release actually ran. */
  get resourcesReleased(): boolean {
    return this.released;
  }

  get terminationIntent(): TerminationIntent | null {
    return this.lifecycle.terminationIntent;
  }

  /** Frames still owned by this call and not yet delivered or discarded. */
  get owedFrames(): number {
    return this.pending.length + (this.inFlight === null ? 0 : 1);
  }

  /** Whether the seam actually acknowledged opening this call's session. */
  get seamSessionOpened(): boolean {
    return this.sessionOpened;
  }

  /**
   * The ledger, evaluated now.
   *
   * Two identities, and the second is the one the old ledger was missing.
   * `accepted === accountedFor` says every packet taken off the wire is still
   * somewhere we can name. `extracted === framesExtracted` says every packet
   * a buffer handed out was actually caught — which is what a re-INVITE
   * replacing a buffer mid-call used to break, silently, while the first
   * identity was not being asked at all.
   */
  get mediaLedger(): MediaLedger {
    const live = this.jitter;
    const liveStats = live === null ? null : live.stats;
    const droppedInBuffer = this.retiredJitter.discarded + (liveStats?.discarded ?? 0);
    const extracted = this.retiredJitter.emitted + (liveStats?.emitted ?? 0);
    const held = live === null ? 0 : live.depth;
    const owed = this.owedFrames;
    const m = this.measurements;
    const accountedFor = m.framesDelivered + m.framesDiscarded + droppedInBuffer + held + owed;
    const refusedBeforeCustody =
      m.malformedPackets +
      m.unsupportedPayloadPackets +
      m.packetsBeforeNegotiation +
      m.packetsRejectedAfterShutdown;
    return {
      accepted: m.packetsAccepted,
      arrived: m.packetsAccepted + refusedBeforeCustody,
      refusedBeforeCustody,
      delivered: m.framesDelivered,
      discarded: m.framesDiscarded,
      droppedInBuffer,
      held,
      owed,
      extracted,
      accountedFor,
      unaccountedFor: m.packetsAccepted - accountedFor,
      balanced: m.packetsAccepted === accountedFor && extracted === m.framesExtracted,
    };
  }

  /**
   * Publish the call's cumulative media statistics: every retired buffer plus
   * the live one. Never an assignment FROM a buffer — that is what let a
   * replaced buffer reset a call's history to zero.
   */
  private publishJitterStats(): void {
    const live = this.jitter === null ? null : this.jitter.stats;
    const base = this.retiredJitter;
    const published = this.measurements.jitter;
    published.received = base.received + (live?.received ?? 0);
    published.emitted = base.emitted + (live?.emitted ?? 0);
    published.duplicates = base.duplicates + (live?.duplicates ?? 0);
    published.reordered = base.reordered + (live?.reordered ?? 0);
    published.lost = base.lost + (live?.lost ?? 0);
    published.tooLate = base.tooLate + (live?.tooLate ?? 0);
    published.evicted = base.evicted + (live?.evicted ?? 0);
    published.discarded = base.discarded + (live?.discarded ?? 0);
    published.resyncs = base.resyncs + (live?.resyncs ?? 0);
    published.maxDepth = Math.max(base.maxDepth, live?.maxDepth ?? 0);
    // Jitter is a smoothed CURRENT reading, not a total. The live buffer's
    // figure is the true one while it has seen traffic; the last retired
    // buffer's is the best remaining answer once it has not.
    published.jitterMs = live !== null && live.received > 0 ? live.jitterMs : base.jitterMs;
  }

  /**
   * Fold a buffer's whole history into this call's, and account for anything
   * it was still holding. After this the buffer may be dropped: everything it
   * knew is somewhere the call can still see.
   */
  private retireJitterBuffer(buffer: JitterBuffer): void {
    const abandoned = buffer.abandon();
    if (abandoned > 0) {
      this.log('sip call retired a jitter buffer that still held audio', { packets: abandoned });
    }
    const s = buffer.stats;
    const base = this.retiredJitter;
    base.received += s.received;
    base.emitted += s.emitted;
    base.duplicates += s.duplicates;
    base.reordered += s.reordered;
    base.lost += s.lost;
    base.tooLate += s.tooLate;
    base.evicted += s.evicted;
    base.discarded += s.discarded;
    base.resyncs += s.resyncs;
    base.maxDepth = Math.max(base.maxDepth, s.maxDepth);
    base.jitterMs = s.jitterMs;
  }

  /**
   * Media time relative to this call, in milliseconds. The first packet of a
   * stream anchors the base; a restarted stream continues from where the last
   * one stopped rather than teleporting.
   */
  private mediaTimeMs(
    rtpTimestamp: number,
    clockRate: number,
    generation: number,
    arrivedAtMs: number,
  ): number {
    let stream = this.streamBases.get(generation);
    if (stream !== undefined) {
      const elapsed = (rtpTimestamp - stream.base) >>> 0;
      const candidateMs = stream.offsetMs + Math.round((elapsed / clockRate) * 1000);
      // Has the sender re-based its timestamp?
      //
      // Advancing the run on an SSRC change and on a jitter-buffer resync was
      // not enough, and the reason is that those answer a SEQUENCE question
      // while this is a TIMESTAMP question. A sender can re-base its clock
      // with the same SSRC and a sequence that never leaves the accept
      // window; and a codec-changing re-INVITE flushes the buffer, which
      // clears its sequence anchor and makes a resync structurally impossible
      // from then on. Either way the run kept a base the sender had
      // abandoned, and every later frame was stamped about 45 hours out —
      // monotonically, so every ordering assertion was satisfied by it.
      //
      // A re-base is indistinguishable from a very long silence if you only
      // look at the media clock: both are a jump forward. What separates them
      // is the WALL clock. A real gap in speech takes real time — the media
      // and arrival gaps move together — while a re-base arrives 20 ms after
      // the frame before it and claims a day and a half of media time.
      const mediaGapMs = candidateMs - stream.lastMediaMs;
      const arrivalGapMs = arrivedAtMs - stream.lastArrivalMs;
      if (mediaGapMs - arrivalGapMs > SipCall.RUN_CONTINUITY_LIMIT_MS) {
        this.log('sip rtp sender re-based its media clock; continuing the timeline', {
          sessionId: this.sessionId,
        });
        this.measurements.mediaClockRebases += 1;
        this.streamBases.delete(generation);
        stream = undefined;
      }
    }
    if (stream === undefined) {
      // The offset is decided HERE, when this run's first packet is actually
      // timed — not back when the restart was noticed. At that earlier moment
      // the previous run was often still buffered, so its frames had not been
      // delivered yet and any offset taken then overlapped them.
      const offsetMs = this.anyStreamLatched ? this.lastEmittedMediaTimeMs + 20 : 0;
      stream = { base: rtpTimestamp, offsetMs, lastMediaMs: offsetMs, lastArrivalMs: arrivedAtMs };
      this.streamBases.set(generation, stream);
      this.anyStreamLatched = true;
      // Bounded: a peer restarting on every packet must not grow this forever.
      if (this.streamBases.size > 8) {
        const oldest = this.streamBases.keys().next().value;
        if (oldest !== undefined) this.streamBases.delete(oldest);
      }
    }
    // Unsigned 32-bit difference: a wrap reads as a small forward step, which
    // is what it is, rather than as a jump backwards of seven weeks.
    const ticks = (rtpTimestamp - stream.base) >>> 0;
    const mediaMs = stream.offsetMs + Math.round((ticks / clockRate) * 1000);
    stream.lastMediaMs = mediaMs;
    stream.lastArrivalMs = arrivedAtMs;
    return mediaMs;
  }

  private respond(request: SipMessage, statusCode: number, reason: string, body = ''): void {
    const snapshot = this.dialog.snapshot();
    // CR and LF are how a header value becomes extra headers, or a whole
    // second message. Everything echoed from the request is stripped of them.
    const echo = (name: string): string => (request.headers[name] ?? '').replace(/[\r\n]/g, '');
    const toHeader = echo('to');
    this.deps.sendSip({
      kind: 'response',
      statusCode,
      reason,
      headers: {
        via: echo('via'),
        from: echo('from'),
        // Our tag identifies this dialog's local end for everything that follows.
        to: toHeader.includes(';tag=') ? toHeader : `${toHeader};tag=${snapshot.identity.localTag}`,
        'call-id': echo('call-id'),
        cseq: echo('cseq'),
        ...(body === '' ? {} : { 'content-type': 'application/sdp' }),
      },
      body,
    });
  }
}

export { CODECS, UnsupportedCodecError };
