/** @owner masterzee001 */

/**
 * THE `call:*` socket event names (P6.5). Single source of truth: the gateway
 * runtime imports these, and client mirrors re-export them. Every value is a
 * wire protocol constant — changing one breaks every deployed client — so the
 * package's byte-identity test pins each name against a literal table.
 *
 * CAPTURE_SETTINGS and PLAYBACK are INTERNAL instrumentation events (see
 * their comments and the package README): they exist for acoustic forensics,
 * carry no product behavior, and must never surface in a public SDK contract.
 */
export const CALL_EVENTS = {
  JOIN: 'call:join',
  LEAVE: 'call:leave',
  PUBLISH_OFFER: 'call:publish:offer',
  PUBLISH_ICE: 'call:publish:ice',
  RECEIVE_OFFER: 'call:receive:offer',
  RECEIVE_ICE: 'call:receive:ice',
  /**
   * P6.4-W2: which remote speaker each of this listener's receive slots is
   * carrying. Sent to the one listener it describes, never broadcast — a
   * call-wide mapping would hand everybody a map of everyone else's transport
   * state for no reason.
   */
  RECEIVE_TRACKS: 'call:receive:tracks',
  SET_CAPTION_LANGUAGE: 'call:caption-language',
  /**
   * INTERNAL INSTRUMENTATION — W1: the capture settings the browser actually
   * granted. A preference asked for is not a fact; this is the fact, and every
   * acoustic measurement taken later has to be read against it. Not part of
   * the product contract; public SDKs must not expose it.
   */
  CAPTURE_SETTINGS: 'call:capture-settings',
  /**
   * INTERNAL INSTRUMENTATION — W4: a participant's own loudspeaker started or
   * stopped being audible. Reported by the client because only the client
   * knows when its audio element really began, and aggregated gateway-side
   * because the consequence belongs to a DIFFERENT participant's microphone.
   * Not part of the product contract; public SDKs must not expose it.
   */
  PLAYBACK: 'call:playback',
  STATE: 'call:state',
  CAPTION: 'call:caption',
  GENERATED_AUDIO: 'call:generated-audio',
  /**
   * One frame of translated speech, while the sentence is still being made.
   *
   * Separate from GENERATED_AUDIO, which announces a FINISHED clip by URL.
   * Both exist: an uploaded programme really does have a complete file, and a
   * conversation really does not. A client that understands both needs no flag
   * to tell them apart, because only one of them ever arrives for a given
   * deployment.
   *
   * Carries CLIENT-DOMAIN identity only. The media-ingest session id, the
   * adapter reference and the provider are all server knowledge, and putting
   * any of them here would make the next internal rename a frontend breaking
   * change.
   */
  TRANSLATED_AUDIO_FRAME: 'call:translated-audio-frame',
  ERROR: 'call:error',
  /** W5: call-global mode change; owner authority only. */
  SET_MODE: 'call:mode:set',
  /** W5.1: a listener's own mid-call Audio Mode change; planning reacts immediately. */
  SET_AUDIO_MODE: 'call:audio-mode:set',
  /** Owner-only transcript-download policy for the whole call. */
  SET_TRANSCRIPT_POLICY: 'call:transcript-policy:set',
  /**
   * P7.0A governance: appoint, revoke, transfer the Chair.
   *
   * ONE event carrying an action rather than five events. The authority check
   * is identical for all of them, and five entry points is five places for one
   * of them to be wired without it.
   */
  GOVERNANCE: 'call:governance',
  /** V1: P2P video mesh signalling, relayed peer-to-peer by the gateway. */
  VIDEO_OFFER: 'call:video:offer',
  VIDEO_ANSWER: 'call:video:answer',
  VIDEO_ICE: 'call:video:ice',
} as const;

export type CallEventName = (typeof CALL_EVENTS)[keyof typeof CALL_EVENTS];
