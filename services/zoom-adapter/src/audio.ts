/** @author masterzee001 */
/**
 * RTMS audio bytes -> the engine's frame contract.
 *
 * We ask Zoom for exactly what the engine already speaks — raw L16, 16 kHz,
 * mono, 20 ms packets — so this file is a reinterpretation of bytes rather
 * than a transcode. No resampling, no decode, no format negotiation at
 * runtime: if Zoom ever hands us something else, that is a handshake failure
 * to surface, not a conversion to attempt quietly.
 */
import { RtmsProtocolError, type RtmsAudioPacket } from './protocol.js';
import type { AdapterAudioFrame } from './media-port.js';

/** Bytes per sample for the 16-bit PCM we request. */
const BYTES_PER_SAMPLE = 2;

/**
 * Reinterpret a packet's PCM bytes as signed 16-bit samples.
 *
 * Node gives no alignment guarantee on a Buffer's underlying memory, so the
 * bytes are copied into a fresh Int16Array rather than viewed in place — an
 * unaligned view throws, and worse, an aliased one would mutate under us when
 * the socket reuses its read buffer.
 */
export function decodePcm16(pcm: Buffer): Int16Array {
  if (pcm.length === 0) {
    throw new RtmsProtocolError('malformed', 'Audio packet carried no samples.');
  }
  if (pcm.length % BYTES_PER_SAMPLE !== 0) {
    throw new RtmsProtocolError(
      'unsupported-audio',
      `Audio payload of ${pcm.length} bytes is not whole 16-bit samples.`,
    );
  }
  const samples = new Int16Array(pcm.length / BYTES_PER_SAMPLE);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = pcm.readInt16LE(index * BYTES_PER_SAMPLE);
  }
  return samples;
}

/** One RTMS audio packet, in the terms the seam accepts. */
export function toAdapterFrame(packet: RtmsAudioPacket, participantId: string): AdapterAudioFrame {
  return {
    participantId,
    samples: decodePcm16(packet.pcm),
    sampleRate: 16000,
    channelCount: 1,
    platformTimestampMs: packet.timestamp,
  };
}

/**
 * Duration of a frame in milliseconds, from its own sample count. Used to
 * detect gaps: Zoom's per-user timestamps advance by send_rate, so a jump
 * larger than one frame means that speaker's audio was interrupted — which
 * the engine must know about, because silence and absence are not the same
 * thing and a chunker that cannot tell them apart glues two utterances into
 * one sentence.
 */
export function frameDurationMs(frame: AdapterAudioFrame): number {
  return (frame.samples.length / frame.sampleRate) * 1000;
}

export interface GapReport {
  /** Milliseconds of missing audio; 0 when the frame is contiguous. */
  gapMs: number;
  contiguous: boolean;
}

/**
 * Compare a frame against the previous one from the SAME speaker. Zoom
 * documents each user as carrying its own incremental timestamp series, so
 * continuity is only meaningful per participant — comparing across speakers
 * would report a gap every time the conversation changed hands.
 */
export function measureGap(
  previous: { platformTimestampMs: number; durationMs: number } | null,
  frame: AdapterAudioFrame,
  toleranceMs = 5,
): GapReport {
  if (previous === null) return { gapMs: 0, contiguous: true };
  const expectedAt = previous.platformTimestampMs + previous.durationMs;
  const gapMs = frame.platformTimestampMs - expectedAt;
  // A BACKWARD jump is not continuity. An out-of-order packet, a restarted
  // timestamp series after a re-establish, or a missing timestamp all produce
  // a negative delta, and calling that contiguous is precisely how two
  // separate utterances get glued into one sentence.
  if (gapMs < -toleranceMs) return { gapMs, contiguous: false };
  if (gapMs <= toleranceMs) return { gapMs: Math.max(0, gapMs), contiguous: true };
  return { gapMs, contiguous: false };
}
