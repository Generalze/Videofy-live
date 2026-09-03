/** @author masterzee001 */
/**
 * What the public may have, and the boundary that decides it.
 *
 * The encoder's own spool and playlist are PRIVATE. They contain the next
 * forty-five seconds of a protected broadcast, which is precisely the material
 * the safety delay exists to withhold. Exposing that directory, or FFmpeg's
 * playlist, would hand the audience the future.
 *
 * SO AUTHORISATION LIVES HERE, AT FETCH, NOT ONLY IN THE MANIFEST. A manifest
 * that lists only published segments is necessary and nowhere near sufficient:
 * segment names are sequential, and anybody can add one. The question asked of
 * every single fetch is "has the cursor published this yet", answered against
 * the authoritative cursor at that instant. Guessing a name gets a refusal.
 *
 * A FUTURE SEGMENT ON DISK IS NOT PUBLIC. Existence and publication are
 * different facts, and this file is where they are kept apart.
 *
 * IDENTIFIERS ARE OPAQUE. Nothing here returns a filesystem path to a client.
 * A segment is named by an id; the store knows where its bytes are. That is
 * what lets the spool move to object storage or a CDN later without changing
 * anything a viewer or the Programme timeline depends on.
 */

import type { ProgrammeMediaStore } from './programme-media-store.js';
import type { ProgrammeTimelineRegistry } from './programme-timeline-registry.js';

/** Why a fetch was refused. Each is a different fault with a different fix. */
export type EgressRefusal =
  /** This service is not running that broadcast. */
  | 'unknown-run'
  /** The segment is real, and the cursor has not published it. */
  | 'not-yet-public'
  /** No such segment in this run. Includes another run's segments. */
  | 'unknown-segment'
  /** The programme is not currently permitted to emit at all. */
  | 'output-stopped';

export type SegmentAuthorization =
  | { readonly allowed: true; readonly storageReference: string; readonly bytes: number }
  | { readonly allowed: false; readonly refusal: EgressRefusal };

export interface PublicManifestEntry {
  readonly segmentId: string;
  readonly durationSeconds: number;
}

export type PublicManifest =
  | {
      readonly available: true;
      readonly runId: string;
      /** The init segment every fragment needs, by opaque id. */
      readonly initSegmentId: string;
      readonly segments: readonly PublicManifestEntry[];
      /** Where the audience is, so a client can resume rather than guess. */
      readonly publicOutputTimeMs: number;
      /** True once nothing further will be published. */
      readonly complete: boolean;
    }
  | { readonly available: false; readonly refusal: EgressRefusal; readonly detail: string };

/** The init segment's public identity. One per run; versioned if the encoder restarts. */
export function initSegmentId(runId: string, generation = 0): string {
  return `${runId}.init.${generation}`;
}

export class ProgrammeEgressAuthority {
  constructor(
    private readonly timelines: ProgrammeTimelineRegistry,
    private readonly media: ProgrammeMediaStore,
    /** Where each run's init segment lives, by generation. */
    private readonly initReferences = new Map<string, string>(),
  ) {}

  /** Record the init segment an encoder produced for a run. */
  noteInitSegment(runId: string, storageReference: string, generation = 0): void {
    this.initReferences.set(initSegmentId(runId, generation), storageReference);
  }

  /**
   * Is there an initialisation segment for this run?
   *
   * Asked before a delivery is called ready: without it no fragment decodes,
   * so a manifest offered in its absence is one no player can use.
   */
  hasInitSegment(runId: string, generation = 0): boolean {
    return this.initReferences.has(initSegmentId(runId, generation));
  }

  /**
   * The manifest a viewer may see right now.
   *
   * Built from the authoritative cursor, never from the encoder's playlist.
   * A programme whose output has stopped -- a failed buffer, a lost writer --
   * gets a refusal rather than a stale list, because continuing to serve the
   * last known manifest is how an audience keeps watching a broadcast that
   * has been withdrawn.
   */
  manifest(runId: string): PublicManifest {
    const status = this.timelines.status(runId);
    if (status === null) {
      return {
        available: false,
        refusal: 'unknown-run',
        detail: 'This service is not running that broadcast.',
      };
    }
    if (status.state === 'failed') {
      return {
        available: false,
        refusal: 'output-stopped',
        detail: status.detail,
      };
    }

    const cursor = status.cursor.publicOutputTimeMs;
    const held = this.media.throughCursor(runId, cursor, this.media.earliestHeldMs(runId) ?? 0);
    if (!held.available) {
      // Retention exhausted. Serving what remains would skip the audience
      // forward, which is the downgrade the buffer exists to prevent.
      return { available: false, refusal: 'output-stopped', detail: held.reason };
    }

    return {
      available: true,
      runId,
      initSegmentId: initSegmentId(runId),
      segments: held.segments.map((segment) => ({
        segmentId: segment.segmentId,
        durationSeconds: (segment.endProgrammeTimeMs - segment.startProgrammeTimeMs) / 1000,
      })),
      publicOutputTimeMs: cursor,
      // Draining still publishes; only a finished drain is complete.
      complete: status.state === 'draining' && held.segments.length === 0,
    };
  }

  /**
   * May this exact segment be delivered, right now?
   *
   * Asked again at fetch, against the cursor at this instant, because the
   * manifest is a snapshot and a request is not. This is the check that makes
   * guessing a segment name useless.
   */
  authorizeSegment(runId: string, segmentId: string): SegmentAuthorization {
    const status = this.timelines.status(runId);
    if (status === null) return { allowed: false, refusal: 'unknown-run' };
    if (status.state === 'failed') return { allowed: false, refusal: 'output-stopped' };

    const init = this.initReferences.get(segmentId);
    if (init !== undefined) {
      /*
       * The init segment carries no programme content -- codec configuration
       * only -- so it is publishable as soon as the run is. Withholding it
       * would make the first published fragment undecodable.
       */
      return { allowed: true, storageReference: init, bytes: 0 };
    }

    const cursor = status.cursor.publicOutputTimeMs;
    const published = this.media.throughCursor(runId, cursor, this.media.earliestHeldMs(runId) ?? 0);
    if (!published.available) return { allowed: false, refusal: 'output-stopped' };

    const found = published.segments.find((segment) => segment.segmentId === segmentId);
    if (found !== undefined) {
      return { allowed: true, storageReference: found.storageReference, bytes: found.bytes };
    }

    /*
     * NOT FOUND AMONG THE PUBLISHED. Either it does not exist, or it exists
     * and the cursor has not reached it. Those are answered differently
     * because one is a client error and the other is somebody trying to see
     * the future -- and the second is the one worth alerting on.
     */
    const everything = this.media.throughCursor(runId, Number.MAX_SAFE_INTEGER, 0);
    const existsButUnpublished =
      everything.available && everything.segments.some((s) => s.segmentId === segmentId);
    return {
      allowed: false,
      refusal: existsButUnpublished ? 'not-yet-public' : 'unknown-segment',
    };
  }
}

/**
 * Render a manifest as HLS.
 *
 * Built from our own list rather than copied from the encoder's playlist,
 * because the encoder's playlist describes everything it has produced and this
 * must describe only what the cursor has published. The two are different
 * documents that happen to share a format.
 */
export function renderHlsManifest(
  manifest: Extract<PublicManifest, { available: true }>,
  segmentUrl: (segmentId: string) => string,
): string {
  const longest = manifest.segments.reduce((max, s) => Math.max(max, s.durationSeconds), 0);
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(longest))}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-MAP:URI="${segmentUrl(manifest.initSegmentId)}"`,
  ];
  for (const segment of manifest.segments) {
    lines.push(`#EXTINF:${segment.durationSeconds.toFixed(6)},`);
    lines.push(segmentUrl(segment.segmentId));
  }
  // Only a finished drain ends the playlist; a live one must stay open or a
  // player stops at the current edge and never asks again.
  if (manifest.complete) lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}
