import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connectClient, type Socket } from 'socket.io-client';
import type { MediaStateEvent, TranslationEvent } from '@videofy-live/shared-types';
import { SOCKET_EVENTS } from '@videofy-live/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { Gateway } from '../gateway.js';

function makeTranslation(sequence: number, targetLanguage = 'fr'): TranslationEvent {
  return {
    eventId: 'integration-event',
    sequence,
    sourceLanguage: 'en',
    targetLanguage,
    sourceText: `source ${sequence}`,
    translatedText: `translated ${sequence}`,
    audioUrl: null,
    audioFormat: null,
    audioDurationMs: null,
    final: true,
    videoTimestampMs: sequence * 1000,
    createdAt: '2026-07-17T08:30:00.000Z',
    latency: {
      audioCaptureMs: 0,
      transcriptionMs: 0,
      translationMs: 0,
      speechGenerationMs: 0,
      deliveryMs: 0,
      synchronizationOffsetMs: 0,
    },
  };
}

function makeMediaState(): MediaStateEvent {
  return {
    eventId: 'integration-event',
    streamStatus: 'live',
    videoSource: 'mock',
    videoTimestampMs: 12_000,
    sourceAudioActive: true,
    translatedLanguages: ['fr', 'es'],
    connectedListeners: 0,
    createdAt: '2026-07-17T08:30:00.000Z',
  };
}

function waitForConnect(socket: Socket): Promise<void> {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
}

function waitForEvent<T>(socket: Socket, eventName: string): Promise<T> {
  return new Promise((resolve) => {
    socket.once(eventName, (payload: T) => resolve(payload));
  });
}

type ServiceStatusEvent = {
  service: 'gateway' | 'media-ingest' | 'speech-worker';
  status: 'healthy' | 'unhealthy';
  timestamp: string;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('gateway Socket.IO integration', () => {
  let server: Server;
  let baseUrl: string;
  let clients: Socket[];

  beforeEach(async () => {
    server = createServer(createApp());
    new Gateway(server, ['http://localhost:5173', 'http://localhost:5174']);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) {
      client.disconnect();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function client(role: string): Socket {
    const socket = connectClient(baseUrl, {
      query: { role },
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnectionDelay: 50,
      reconnectionDelayMax: 100,
    });
    clients.push(socket);
    return socket;
  }

  it('routes validated ordered worker translations and media state end to end', async () => {
    const ingest = client('ingest');
    const worker = client('worker');
    const operator = client('operator');
    const frenchListener = client('listener');
    const spanishListener = client('listener');

    await Promise.all([
      waitForConnect(ingest),
      waitForConnect(worker),
      waitForConnect(operator),
      waitForConnect(frenchListener),
      waitForConnect(spanishListener),
    ]);

    frenchListener.emit(SOCKET_EVENTS.JOIN_LANGUAGE, 'fr');
    spanishListener.emit(SOCKET_EVENTS.JOIN_LANGUAGE, 'es');
    await waitUntil(() => operator.connected && frenchListener.connected && spanishListener.connected);
    await delay(150);
    await waitUntil(() => operator.connected && frenchListener.connected && spanishListener.connected);
    await delay(25);

    const frenchEvents: TranslationEvent[] = [];
    const spanishEvents: TranslationEvent[] = [];
    const operatorEvents: TranslationEvent[] = [];
    frenchListener.on(SOCKET_EVENTS.TRANSLATION_EVENT, (event: TranslationEvent) => {
      frenchEvents.push(event);
    });
    spanishListener.on(SOCKET_EVENTS.TRANSLATION_EVENT, (event: TranslationEvent) => {
      spanishEvents.push(event);
    });
    operator.on(SOCKET_EVENTS.TRANSLATION_EVENT, (event: TranslationEvent) => {
      operatorEvents.push(event);
    });

    worker.emit(SOCKET_EVENTS.WORKER_TRANSLATION, makeTranslation(1));
    await waitUntil(() => frenchEvents.length === 1 && operatorEvents.length === 1);

    expect(frenchEvents.map((event) => event.sequence)).toEqual([1]);
    expect(operatorEvents.map((event) => event.sequence)).toEqual([1]);
    expect(spanishEvents).toHaveLength(0);

    worker.emit(SOCKET_EVENTS.WORKER_TRANSLATION, makeTranslation(1));
    await delay(50);
    expect(frenchEvents.map((event) => event.sequence)).toEqual([1]);

    worker.emit(SOCKET_EVENTS.WORKER_TRANSLATION, makeTranslation(3));
    await delay(50);
    expect(frenchEvents.map((event) => event.sequence)).toEqual([1]);

    worker.emit(SOCKET_EVENTS.WORKER_TRANSLATION, makeTranslation(2));
    await waitUntil(() => frenchEvents.length === 3 && operatorEvents.length === 3);
    expect(frenchEvents.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(operatorEvents.map((event) => event.sequence)).toEqual([1, 2, 3]);

    const listenerMedia = waitForEvent<MediaStateEvent>(frenchListener, SOCKET_EVENTS.MEDIA_STATE);
    const operatorMedia = waitForEvent<MediaStateEvent>(operator, SOCKET_EVENTS.MEDIA_STATE);
    ingest.emit(SOCKET_EVENTS.INGEST_STATE, makeMediaState());

    await expect(listenerMedia).resolves.toMatchObject({
      eventId: 'integration-event',
      streamStatus: 'live',
      connectedListeners: 2,
    });
    await expect(operatorMedia).resolves.toMatchObject({
      eventId: 'integration-event',
      streamStatus: 'live',
      connectedListeners: 2,
    });
  });

  it('emits a complete unhealthy service snapshot when an operator connects before services', async () => {
    const operator = client('operator');
    const statuses = collectServiceStatuses(operator);

    await waitForConnect(operator);
    await waitUntil(() => statuses.length >= 3);

    expect(latestStatuses(statuses)).toMatchObject({
      gateway: 'healthy',
      'media-ingest': 'unhealthy',
      'speech-worker': 'unhealthy',
    });
  });

  it('emits a complete healthy service snapshot when an operator connects after services', async () => {
    const ingest = client('ingest');
    const worker = client('worker');
    await Promise.all([waitForConnect(ingest), waitForConnect(worker)]);

    const operator = client('operator');
    const statuses = collectServiceStatuses(operator);
    await waitForConnect(operator);
    await waitUntil(() => statuses.length >= 3);

    expect(latestStatuses(statuses)).toMatchObject({
      gateway: 'healthy',
      'media-ingest': 'healthy',
      'speech-worker': 'healthy',
    });
  });

  it('preserves healthy speech-worker status with multiple workers', async () => {
    const operator = client('operator');
    const statuses = collectServiceStatuses(operator);
    const workerA = client('worker');
    const workerB = client('worker');
    await Promise.all([waitForConnect(operator), waitForConnect(workerA), waitForConnect(workerB)]);
    await waitUntil(() => latestStatuses(statuses)['speech-worker'] === 'healthy');

    expect(latestStatuses(statuses)['speech-worker']).toBe('healthy');
  });

  it('does not mark speech-worker unhealthy when one of multiple workers disconnects', async () => {
    const operator = client('operator');
    const statuses = collectServiceStatuses(operator);
    const workerA = client('worker');
    const workerB = client('worker');
    await Promise.all([waitForConnect(operator), waitForConnect(workerA), waitForConnect(workerB)]);
    await waitUntil(() => latestStatuses(statuses)['speech-worker'] === 'healthy');

    workerA.disconnect();
    await delay(75);

    expect(statuses.filter((event) => event.service === 'speech-worker').at(-1)?.status).toBe(
      'healthy',
    );
  });

  it('marks speech-worker unhealthy after the final worker disconnects', async () => {
    const operator = client('operator');
    const statuses = collectServiceStatuses(operator);
    const workerA = client('worker');
    const workerB = client('worker');
    await Promise.all([waitForConnect(operator), waitForConnect(workerA), waitForConnect(workerB)]);
    await waitUntil(() => latestStatuses(statuses)['speech-worker'] === 'healthy');

    workerA.disconnect();
    await delay(50);
    workerB.disconnect();
    await waitUntil(() => latestStatuses(statuses)['speech-worker'] === 'unhealthy');

    expect(latestStatuses(statuses)['speech-worker']).toBe('unhealthy');
  });
});

function collectServiceStatuses(socket: Socket): ServiceStatusEvent[] {
  const statuses: ServiceStatusEvent[] = [];
  socket.on(SOCKET_EVENTS.SERVICE_STATUS, (event: ServiceStatusEvent) => {
    statuses.push(event);
  });
  return statuses;
}

function latestStatuses(statuses: ServiceStatusEvent[]): Record<ServiceStatusEvent['service'], string> {
  return statuses.reduce(
    (acc, event) => {
      acc[event.service] = event.status;
      return acc;
    },
    {
      gateway: 'unknown',
      'media-ingest': 'unknown',
      'speech-worker': 'unknown',
    },
  );
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for integration condition');
    }
    await delay(10);
  }
}
