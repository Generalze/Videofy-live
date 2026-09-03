/** @author masterzee001 */
/**
 * The contribution side of a programme: how a broadcaster's media reaches the
 * one encoder that produces protected output.
 *
 * Kept as its own package because of where its callers are. The gateway holds
 * the WebRTC peer and the decoded frames; the media service holds the store,
 * the timeline and the cursor. Raw 1080p video must not travel between them
 * over a service API to satisfy a module boundary, so the boundary moves
 * instead: this is shared, and the frames stay where they were decoded.
 */
export {
  ContributionClock,
  framesDueBy,
  processMonotonic,
  samplesDueBy,
  type MonotonicSource,
} from './clock.js';
export {
  ProgrammeContributionBridge,
  type ContributionAudioFormat,
  type ContributionBridgeOptions,
  type ContributionOutput,
  type ContributionState,
  type ContributionStatus,
  type ContributionVideoFormat,
} from './bridge.js';
export {
  SEGMENT_SECONDS,
  buildOriginCommand,
  initFileName,
  playlistFileName,
  probeSegment,
  runOrigin,
  type MediaOriginOptions,
  type OriginRunResult,
  type ProbedSegment,
} from './origin.js';
export {
  RawContributionEncoder,
  buildRawOriginCommand,
  type RawEncoderOptions,
} from './raw-encoder.js';
