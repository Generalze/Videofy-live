import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer, type Socket } from 'socket.io';
import type { MediaStateEvent, TranslationEvent } from '@videofy-live/shared-types';
import {
  INGEST_ROOM,
  languageRoom,
  OPERATOR_ROOM,
  SOCKET_EVENTS,
  WORKER_ROOM,
} from '@videofy-live/shared-types';
import { safeParseMediaStateEvent, safeParseTranslationEvent } from '@videofy-live/media-contracts';
import { EventStore } from './event-store.js';
import { logger } from './logger.js';

/** Client role determined by query parameter on connect. */
type ClientRole = 'listener' | 'operator' | 'worker' | 'ingest';

interface ClientState {
  role: ClientRole;
  socketId: string;
  connectedAt: string;
  targetLanguage: string | undefined;
}

type ServiceName = 'gateway' | 'media-ingest' | 'speech-worker';
type HealthStatus = 'healthy' | 'unhealthy';
type OperatorControlAction =
  | 'start-mock-stream'
  | 'stop-mock-stream'
  | 'trigger-mock-phrase'
  | 'reset-mock-sequence';

interface ServiceStatusEvent {
  service: ServiceName;
  status: HealthStatus;
  socketId?: string;
  timestamp: string;
}

interface OperatorControlEvent {
  action: OperatorControlAction;
  eventId?: string;
  targetLanguage?: string;
}

export class Gateway {
  private readonly io: SocketServer;
  private readonly store = new EventStore({
    onReady: (events) => this.broadcastTranslationEvents(events),
  });
  private readonly clients = new Map<string, ClientState>();
  private readonly activeWorkers = new Set<string>();
  private readonly activeIngestClients = new Set<string>();
  private listenerCount = 0;

  constructor(httpServer: HttpServer, corsOrigins: string[]) {
    this.io = new SocketServer(httpServer, {
      cors: { origin: corsOrigins, methods: ['GET', 'POST'] },
      transports: ['websocket', 'polling'],
    });

    this.io.on('connection', (socket: Socket) => this.handleConnection(socket));
    logger.info('Gateway socket server initialised');
  }

  private handleConnection(socket: Socket): void {
    const role = this.resolveRole(socket);
    const state: ClientState = {
      role,
      socketId: socket.id,
      connectedAt: new Date().toISOString(),
      targetLanguage: undefined,
    };
    this.clients.set(socket.id, state);

    switch (role) {
      case 'listener':
        this.listenerCount++;
        void socket.join('listeners');
        this.handleListenerSocket(socket, state);
        logger.info('Listener connected', { socketId: socket.id, listenerCount: this.listenerCount });
        break;
      case 'operator':
        void socket.join(OPERATOR_ROOM);
        this.handleOperatorSocket(socket);
        logger.info('Operator connected', { socketId: socket.id });
        break;
      case 'worker':
        void socket.join(WORKER_ROOM);
        this.activeWorkers.add(socket.id);
        this.handleWorkerSocket(socket);
        this.broadcastServiceStatus('speech-worker', 'healthy', socket.id);
        logger.info('Speech worker connected', { socketId: socket.id });
        break;
      case 'ingest':
        void socket.join(INGEST_ROOM);
        this.activeIngestClients.add(socket.id);
        this.handleIngestSocket(socket);
        this.broadcastServiceStatus('media-ingest', 'healthy', socket.id);
        logger.info('Media ingest connected', { socketId: socket.id });
        break;
    }

    socket.on('disconnect', () => this.handleDisconnect(socket));
  }

  private resolveRole(socket: Socket): ClientRole {
    const role = socket.handshake.query['role'];
    if (role === 'operator') return 'operator';
    if (role === 'worker') return 'worker';
    if (role === 'ingest') return 'ingest';
    return 'listener';
  }

  private handleListenerSocket(socket: Socket, state: ClientState): void {
    socket.on(SOCKET_EVENTS.JOIN_LANGUAGE, (targetLanguage: unknown) => {
      if (typeof targetLanguage !== 'string' || targetLanguage.length < 2) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Invalid targetLanguage' });
        return;
      }
      if (state.targetLanguage) {
        void socket.leave(languageRoom(state.targetLanguage));
      }
      state.targetLanguage = targetLanguage;
      void socket.join(languageRoom(targetLanguage));
      logger.debug('Listener joined language room', { socketId: socket.id, targetLanguage });
    });

    socket.on(SOCKET_EVENTS.LEAVE_LANGUAGE, (targetLanguage: unknown) => {
      if (typeof targetLanguage === 'string') {
        void socket.leave(languageRoom(targetLanguage));
        if (state.targetLanguage === targetLanguage) {
          state.targetLanguage = undefined;
        }
      }
    });
  }

  private handleOperatorSocket(socket: Socket): void {
    this.emitServiceSnapshot(socket);

    socket.on(SOCKET_EVENTS.OPERATOR_CONTROL, (raw: unknown) => {
      const control = this.parseOperatorControl(raw);
      if (!control) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Invalid operator control' });
        return;
      }

      switch (control.action) {
        case 'start-mock-stream':
          this.io.to(INGEST_ROOM).emit(SOCKET_EVENTS.INGEST_START_STREAM);
          break;
        case 'stop-mock-stream':
          this.io.to(INGEST_ROOM).emit(SOCKET_EVENTS.INGEST_STOP_STREAM);
          break;
        case 'trigger-mock-phrase':
          this.io.to(WORKER_ROOM).emit(SOCKET_EVENTS.WORKER_TRIGGER_PHRASE);
          break;
        case 'reset-mock-sequence':
          this.store.reset(control.eventId, control.targetLanguage);
          this.io.to(WORKER_ROOM).emit(SOCKET_EVENTS.WORKER_RESET_SEQUENCE, {
            eventId: control.eventId,
            targetLanguage: control.targetLanguage,
          });
          break;
      }

      socket.emit(SOCKET_EVENTS.CONTROL_ACK, {
        action: control.action,
        accepted: true,
        timestamp: new Date().toISOString(),
      });
      logger.info('Operator control accepted', { action: control.action });
    });
  }

  private handleWorkerSocket(socket: Socket): void {
    socket.on(SOCKET_EVENTS.WORKER_HEALTH, () => {
      this.broadcastServiceStatus('speech-worker', 'healthy', socket.id);
    });

    socket.on(SOCKET_EVENTS.WORKER_TRANSLATION, (raw: unknown) => {
      const result = safeParseTranslationEvent(raw);
      if (!result.success) {
        socket.emit(SOCKET_EVENTS.ERROR, {
          message: 'Invalid translation event',
          issues: result.error.issues,
        });
        logger.warn('Worker sent invalid translation event', { socketId: socket.id });
        return;
      }

      const event = result.data as TranslationEvent;

      const accepted = this.store.offer(event);
      if (!accepted.accepted) {
        return;
      }

      this.broadcastTranslationEvents(accepted.ready);
    });
  }

  private handleIngestSocket(socket: Socket): void {
    socket.on(SOCKET_EVENTS.INGEST_HEALTH, () => {
      this.broadcastServiceStatus('media-ingest', 'healthy', socket.id);
    });

    socket.on(SOCKET_EVENTS.INGEST_STATE, (raw: unknown) => {
      const result = safeParseMediaStateEvent(raw);
      if (!result.success) {
        socket.emit(SOCKET_EVENTS.ERROR, {
          message: 'Invalid media state event',
          issues: result.error.issues,
        });
        logger.warn('Ingest sent invalid media state event', { socketId: socket.id });
        return;
      }

      const stateEvent = result.data as MediaStateEvent;
      const enriched: MediaStateEvent = {
        ...stateEvent,
        connectedListeners: this.listenerCount,
      };

      this.io.emit(SOCKET_EVENTS.MEDIA_STATE, enriched);
      this.broadcastServiceStatus('media-ingest', 'healthy', socket.id);
      logger.debug('Media state broadcast', { streamStatus: enriched.streamStatus });
    });
  }

  private handleDisconnect(socket: Socket): void {
    const state = this.clients.get(socket.id);
    if (state?.role === 'listener') {
      this.listenerCount = Math.max(0, this.listenerCount - 1);
    } else if (state?.role === 'worker') {
      this.activeWorkers.delete(socket.id);
      if (this.activeWorkers.size === 0) {
        this.broadcastServiceStatus('speech-worker', 'unhealthy', socket.id);
      }
    } else if (state?.role === 'ingest') {
      this.activeIngestClients.delete(socket.id);
      if (this.activeIngestClients.size === 0) {
        this.broadcastServiceStatus('media-ingest', 'unhealthy', socket.id);
      }
    }
    this.clients.delete(socket.id);
    logger.info('Client disconnected', { socketId: socket.id, role: state?.role });
  }

  /** Broadcast a stream-status change to all connected clients. */
  broadcastStreamStatus(status: string): void {
    this.io.emit(SOCKET_EVENTS.STREAM_STATUS, { status, timestamp: new Date().toISOString() });
  }

  getListenerCount(): number {
    return this.listenerCount;
  }

  getConnectedCount(): number {
    return this.clients.size;
  }

  private broadcastServiceStatus(
    service: ServiceName,
    status: HealthStatus,
    socketId?: string,
  ): void {
    this.io.to(OPERATOR_ROOM).emit(SOCKET_EVENTS.SERVICE_STATUS, {
      ...this.serviceStatus(service, status),
      socketId,
    });
  }

  private emitServiceSnapshot(socket: Socket): void {
    const snapshot: ServiceStatusEvent[] = [
      this.serviceStatus('gateway', 'healthy'),
      this.serviceStatus(
        'media-ingest',
        this.activeIngestClients.size > 0 ? 'healthy' : 'unhealthy',
      ),
      this.serviceStatus(
        'speech-worker',
        this.activeWorkers.size > 0 ? 'healthy' : 'unhealthy',
      ),
    ];

    for (const status of snapshot) {
      socket.emit(SOCKET_EVENTS.SERVICE_STATUS, status);
    }
  }

  private serviceStatus(service: ServiceName, status: HealthStatus): ServiceStatusEvent {
    return {
      service,
      status,
      timestamp: new Date().toISOString(),
    };
  }

  private broadcastTranslationEvents(events: TranslationEvent[]): void {
    for (const readyEvent of events) {
      this.io
        .to(languageRoom(readyEvent.targetLanguage))
        .emit(SOCKET_EVENTS.TRANSLATION_EVENT, readyEvent);
      this.io.to(OPERATOR_ROOM).emit(SOCKET_EVENTS.TRANSLATION_EVENT, readyEvent);

      logger.info('Translation event broadcast', {
        eventId: readyEvent.eventId,
        sequence: readyEvent.sequence,
        targetLanguage: readyEvent.targetLanguage,
        final: readyEvent.final,
      });
    }
  }

  private parseOperatorControl(raw: unknown): OperatorControlEvent | null {
    if (!raw || typeof raw !== 'object') return null;
    const action = (raw as { action?: unknown }).action;
    if (
      action !== 'start-mock-stream' &&
      action !== 'stop-mock-stream' &&
      action !== 'trigger-mock-phrase' &&
      action !== 'reset-mock-sequence'
    ) {
      return null;
    }

    const eventId = (raw as { eventId?: unknown }).eventId;
    const targetLanguage = (raw as { targetLanguage?: unknown }).targetLanguage;

    if (eventId !== undefined && typeof eventId !== 'string') return null;
    if (targetLanguage !== undefined && typeof targetLanguage !== 'string') return null;

    const control: OperatorControlEvent = { action };
    if (eventId !== undefined) control.eventId = eventId;
    if (targetLanguage !== undefined) control.targetLanguage = targetLanguage;
    return control;
  }
}
