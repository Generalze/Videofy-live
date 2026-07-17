import { Socket, io } from 'socket.io-client';
import type { MediaStateEvent } from '@videofy-live/shared-types';
import { SOCKET_EVENTS } from '@videofy-live/shared-types';
import type { IngestConfig } from './config.js';
import { MockProvider, type MediaProvider } from './providers/index.js';
import { logger } from './logger.js';

export class IngestService {
  private socket: Socket | null = null;
  private provider: MediaProvider;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private streamStatus: MediaStateEvent['streamStatus'] = 'idle';

  constructor(private readonly config: IngestConfig) {
    this.provider = new MockProvider();
  }

  async start(): Promise<void> {
    logger.info('Media ingest starting', { videoSource: this.config.videoSource });

    this.socket = io(this.config.gatewayUrl, {
      query: { role: 'ingest' },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionAttempts: 10,
    });

    this.socket.on(SOCKET_EVENTS.CONNECTED, () => {
      logger.info('Connected to gateway');
      if (this.streamStatus === 'idle') {
        this.streamStatus = 'connecting';
      }
      this.socket?.emit(SOCKET_EVENTS.INGEST_HEALTH, { status: 'healthy' });
      this.emitState();
    });

    this.socket.on(SOCKET_EVENTS.DISCONNECTED, () => {
      logger.warn('Disconnected from gateway');
    });

    this.socket.on('connect_error', (err: Error) => {
      logger.error('Gateway connection error', { message: err.message });
    });

    this.socket.on(SOCKET_EVENTS.INGEST_START_STREAM, () => {
      logger.info('Operator requested mock stream start');
      void this.startMockStream();
    });

    this.socket.on(SOCKET_EVENTS.INGEST_STOP_STREAM, () => {
      logger.info('Operator requested mock stream stop');
      void this.stopMockStream();
    });

    await this.startMockStream();

    this.ticker = setInterval(() => {
      this.emitState();
    }, this.config.mockTickMs);
  }

  private async startMockStream(): Promise<void> {
    await this.provider.start();
    this.streamStatus = 'live';
    this.emitState();
    logger.info('Mock video source started');
  }

  private async stopMockStream(): Promise<void> {
    this.streamStatus = 'ended';
    this.emitState();
    await this.provider.stop();
    logger.info('Mock video source stopped');
  }

  private emitState(): void {
    if (!this.socket?.connected) return;

    const state: MediaStateEvent = {
      eventId: this.config.eventId,
      streamStatus: this.streamStatus,
      videoSource: this.config.videoSource,
      videoTimestampMs: this.provider.getVideoTimestampMs(),
      sourceAudioActive: this.provider.isAudioActive(),
      translatedLanguages: this.config.translatedLanguages,
      connectedListeners: 0,
      createdAt: new Date().toISOString(),
    };

    this.socket.emit(SOCKET_EVENTS.INGEST_STATE, state);
    logger.debug('Media state emitted', {
      streamStatus: state.streamStatus,
      videoTimestampMs: state.videoTimestampMs,
    });
  }

  async stop(): Promise<void> {
    logger.info('Media ingest stopping');
    this.streamStatus = 'ended';
    this.emitState();

    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }

    await this.provider.stop();

    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }

    logger.info('Media ingest stopped');
  }
}
