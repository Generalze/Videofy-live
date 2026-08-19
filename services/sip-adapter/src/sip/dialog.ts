/** @author masterzee001 */
/**
 * The SIP dialog state machine: INVITE -> 200 OK -> ACK -> ... -> BYE.
 *
 * Signalling only. It decides whether a call exists and who is on it; it never
 * touches a packet. Media asks it questions ("is this call still up?") and is
 * told answers, which is why an RTP problem cannot corrupt dialog state and a
 * signalling retransmission cannot disturb audio.
 *
 * Identity is settled HERE, and this matters more than it looks: a participant
 * is a dialog, not a media stream. An SSRC change mid-call is a media event —
 * a re-INVITE, a device swap, a gateway restarting its sender — and must not
 * mint a new person. Only the dialog says who is on the call.
 */
import { cseqNumberOf, parseSdp, tagOf, type ParsedSdp, type SipMessage } from './messages.js';

export type DialogState = 'idle' | 'inviting' | 'established' | 'terminating' | 'terminated';

export interface DialogIdentity {
  callId: string;
  localTag: string;
  remoteTag: string | null;
}

export interface DialogSnapshot {
  state: DialogState;
  identity: DialogIdentity;
  /** Stable Videofy participant id for the remote party. */
  participantId: string;
  remoteDisplayName: string;
  remoteSdp: ParsedSdp | null;
}

export class SipDialogError extends Error {
  constructor(
    readonly code: 'missing-call-id' | 'no-sdp' | 'wrong-state',
    message: string,
  ) {
    super(message);
    this.name = 'SipDialogError';
  }
}

function displayNameOf(header: string | undefined): string {
  if (header === undefined) return '';
  const quoted = /"([^"]*)"/.exec(header);
  if (quoted?.[1] !== undefined) return quoted[1];
  const user = /sip:([^@>;]+)/.exec(header);
  return user?.[1] ?? '';
}

export interface SipDialogOptions {
  /** Mints the Videofy participant id; injectable for deterministic tests. */
  mintParticipantId?: () => string;
  mintTag?: () => string;
}

export class SipDialog {
  private static minted = 0;
  state: DialogState = 'idle';
  private identity: DialogIdentity | null = null;
  private participantId = '';
  private remoteDisplayName = '';
  private remoteSdp: ParsedSdp | null = null;

  private readonly mintParticipantId: () => string;
  private readonly mintTag: () => string;

  constructor(options: SipDialogOptions = {}) {
    // A per-instance counter collides immediately across concurrent calls,
    // which on this seam means two callers sharing one participant identity.
    this.mintParticipantId =
      options.mintParticipantId ??
      (() => `sp_${Math.random().toString(36).slice(2, 10)}${(SipDialog.minted += 1).toString(36)}`);
    this.mintTag = options.mintTag ?? (() => Math.random().toString(36).slice(2, 10));
  }

  snapshot(): DialogSnapshot {
    return {
      state: this.state,
      identity: this.identity ?? { callId: '', localTag: '', remoteTag: null },
      participantId: this.participantId,
      remoteDisplayName: this.remoteDisplayName,
      remoteSdp: this.remoteSdp,
    };
  }

  /**
   * An inbound INVITE. Returns the negotiated view; the caller answers with
   * SDP once it has bound its RTP socket, so the answer can name a real port.
   */
  /**
   * RFC 3261 §12.2.2: an in-dialog request whose sequence number is lower than
   * one this dialog has already seen is stale and must be refused.
   *
   * Without it, negotiation is re-run from whatever offer arrives — so a
   * single delayed retransmission, an ordinary UDP reordering, or one captured
   * datagram replayed by anyone on the path drags the codec BACKWARDS to one
   * the peer has stopped sending. Every packet after that is refused as an
   * unnegotiated payload type, which is total inbound loss for the rest of the
   * call, and it is permanent: nothing self-heals it.
   */
  isStaleRequest(message: SipMessage): boolean {
    if (this.identity === null) return false;
    if (message.headers['call-id'] !== this.identity.callId) return false;
    const sequence = cseqNumberOf(message.headers['cseq']);
    // An in-dialog request we cannot sequence is one we cannot trust to be
    // current, which is the same problem with less information.
    if (sequence === null) return true;
    return this.highestRemoteSequence !== null && sequence < this.highestRemoteSequence;
  }

  /** The highest CSeq this dialog has accepted, so a lower one reads as stale. */
  private highestRemoteSequence: number | null = null;

  private rememberSequence(message: SipMessage): void {
    const sequence = cseqNumberOf(message.headers['cseq']);
    if (sequence === null) return;
    this.highestRemoteSequence =
      this.highestRemoteSequence === null ? sequence : Math.max(this.highestRemoteSequence, sequence);
  }

  receiveInvite(message: SipMessage): DialogSnapshot {
    const callId = message.headers['call-id'];
    if (callId === undefined || callId === '') {
      throw new SipDialogError('missing-call-id', 'INVITE carries no Call-ID.');
    }
    // A re-INVITE on an established dialog re-negotiates media; it does NOT
    // make a new participant. Same dialog, same person, possibly new address.
    if (this.identity !== null && this.identity.callId === callId) {
      this.rememberSequence(message);
      this.remoteSdp = message.body === '' ? this.remoteSdp : parseSdp(message.body);
      return this.snapshot();
    }
    if (this.state !== 'idle') {
      throw new SipDialogError('wrong-state', `INVITE arrived while dialog was ${this.state}.`);
    }
    if (message.body.trim() === '') {
      throw new SipDialogError('no-sdp', 'INVITE carries no SDP offer.');
    }

    this.identity = {
      callId,
      localTag: this.mintTag(),
      remoteTag: tagOf(message.headers['from']),
    };
    this.participantId = this.mintParticipantId();
    this.remoteDisplayName = displayNameOf(message.headers['from']);
    this.remoteSdp = parseSdp(message.body);
    this.rememberSequence(message);
    this.state = 'inviting';
    return this.snapshot();
  }

  /** The far end acknowledged our 200 OK: media may flow. */
  receiveAck(): DialogSnapshot {
    if (this.state === 'inviting') this.state = 'established';
    return this.snapshot();
  }

  /** Either side hung up. Terminal, and idempotent. */
  receiveBye(): DialogSnapshot {
    if (this.state !== 'terminated') this.state = 'terminated';
    return this.snapshot();
  }

  terminate(): DialogSnapshot {
    this.state = 'terminated';
    return this.snapshot();
  }

  get isEstablished(): boolean {
    return this.state === 'established';
  }

  /** True when this message belongs to this dialog. */
  matches(message: SipMessage): boolean {
    return this.identity !== null && message.headers['call-id'] === this.identity.callId;
  }
}
