/**
 * Socket.IO event name constants shared between the gateway server and all
 * clients (listener, operator, speech worker, media ingest).
 */

// Gateway → listener
export const SOCKET_EVENTS = {
  // Server → client
  TRANSLATION_EVENT: 'translation:event',
  MEDIA_STATE: 'media:state',
  STREAM_STATUS: 'stream:status',
  TRANSLATED_AUDIO: 'audio:translated',
  SERVICE_STATUS: 'service:status',
  CONTROL_ACK: 'operator:control_ack',
  ERROR: 'error',

  // Client → server
  JOIN_LANGUAGE: 'join:language',
  LEAVE_LANGUAGE: 'leave:language',

  // Speech worker → gateway
  WORKER_TRANSLATION: 'worker:translation',
  WORKER_HEALTH: 'worker:health',
  WORKER_TRIGGER_PHRASE: 'worker:trigger_phrase',
  WORKER_RESET_SEQUENCE: 'worker:reset_sequence',

  // Media ingest → gateway
  INGEST_STATE: 'ingest:state',
  INGEST_HEALTH: 'ingest:health',
  INGEST_START_STREAM: 'ingest:start_stream',
  INGEST_STOP_STREAM: 'ingest:stop_stream',

  // Operator → gateway
  OPERATOR_CONTROL: 'operator:control',

  // Shared
  CONNECTED: 'connect',
  DISCONNECTED: 'disconnect',
  RECONNECT: 'reconnect',
} as const;

export type SocketEventName = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];

/** Room naming convention for per-language translation channels. */
export function languageRoom(targetLanguage: string): string {
  return `lang:${targetLanguage}`;
}

/** Room for operator dashboard connections. */
export const OPERATOR_ROOM = 'operators';

/** Room for media-ingest connections. */
export const INGEST_ROOM = 'ingest';

/** Room for speech-worker connections. */
export const WORKER_ROOM = 'workers';
