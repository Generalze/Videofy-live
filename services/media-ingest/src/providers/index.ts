/**
 * Provider interface for future live-media input sources.
 *
 * Each provider is responsible for:
 * - Starting and stopping the media capture
 * - Reporting the current video timestamp
 * - Reporting whether source audio is active
 *
 * Providers planned for future implementation:
 * - ZoomProvider      – Zoom meeting/webinar audio/video capture
 * - TeamsProvider     – Microsoft Teams capture
 * - MeetProvider      – Google Meet capture
 * - ObsProvider       – OBS WebSocket integration
 * - RtmpProvider      – RTMP ingest
 * - WebRtcProvider    – WebRTC ingest
 * - HlsProvider       – HLS output
 * - LocalCameraProvider – Browser webcam/microphone
 * - LocalFileProvider – Pre-recorded video for testing
 */
export interface MediaProvider {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  isAudioActive(): boolean;
  getVideoTimestampMs(): number;
}

export class MockProvider implements MediaProvider {
  readonly name = 'mock';
  private startedAt: number | null = null;

  async start(): Promise<void> {
    this.startedAt = Date.now();
  }

  async stop(): Promise<void> {
    this.startedAt = null;
  }

  isAudioActive(): boolean {
    return this.startedAt !== null;
  }

  getVideoTimestampMs(): number {
    if (this.startedAt === null) return 0;
    return Date.now() - this.startedAt;
  }
}
