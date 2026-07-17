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

export class Gateway {
  private readonly io: SocketServer;
  private readonly store = new EventStore();
  private readonly clients = new Map<string, ClientState>();
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
        logger.info('Operator connected', { socketId: socket.id });
        break;
      case 'worker':
        void socket.join(WORKER_ROOM);
        this.handleWorkerSocket(socket);
        logger.info('Speech worker connected', { socketId: socket.id });
        break;
      case 'ingest':
        void socket.join(INGEST_ROOM);
        this.handleIngestSocket(socket);
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

  private handleWorkerSocket(socket: Socket): void {
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

      if (!this.store.accept(event)) {
        return;
      }

      this.io.to(languageRoom(event.targetLanguage)).emit(SOCKET_EVENTS.TRANSLATION_EVENT, event);
      this.io.to(OPERATOR_ROOM).emit(SOCKET_EVENTS.TRANSLATION_EVENT, event);

      logger.info('Translation event broadcast', {
        eventId: event.eventId,
        sequence: event.sequence,
        targetLanguage: event.targetLanguage,
        final: event.final,
      });
    });
  }

  private handleIngestSocket(socket: Socket): void {
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
      logger.debug('Media state broadcast', { streamStatus: enriched.streamStatus });
    });
  }

  private handleDisconnect(socket: Socket): void {
    const state = this.clients.get(socket.id);
    if (state?.role === 'listener') {
      this.listenerCount = Math.max(0, this.listenerCount - 1);
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
}
