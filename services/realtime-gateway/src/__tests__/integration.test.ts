import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connectClient, type Socket } from 'socket.io-client';
import type {
  AudioMixPreferences,
  GeneratedAudioReadyEvent,
  MediaStateEvent,
  TimestampedTranslationEvent,
  TranscriptionEvent,
  TranslationEvent,
} from '@videofy-live/shared-types';
import { SOCKET_EVENTS } from '@videofy-live/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { issueSessionToken, requireSessionSecret } from '@videofy-live/account-tokens';
import { Gateway } from '../gateway.js';

/*
 * The gateway authenticates operators now, so this harness presents a real token
 * exactly as a real client does.
 *
 * Supplying a secret rather than leaving the gateway unconfigured is deliberate:
 * unconfigured REFUSES every operator, so a test that passed by leaving the gate
 * open would be asserting the absence of the control it exists to protect.
 */
const OPERATOR_SECRET = 'z'.repeat(48);
const OPERATOR_TOKEN = issueSessionToken({
  secret: requireSessionSecret(OPERATOR_SECRET, 'TEST_OPERATOR_SECRET'),
  accountId: 'acct_a1b2c3d4e5f60718',
  version: 1,
  nowSeconds: Math.floor(Date.now() / 1000),
});


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
    streamStatus: 'processing',
    videoSource: 'mock',
    videoTimestampMs: 12_000,
    sourceAudioActive: true,
    translatedLanguages: ['fr', 'es'],
    connectedListeners: 0,
    createdAt: '2026-07-17T08:30:00.000Z',
  };
}

function makeTranscriptionEvent(): TranscriptionEvent {
  return {
    sessionId: 'ps_integration',
    streamId: 'stream_integration',
    chunkId: 'ps_integration:chunk:0',
    sequence: 0,
    sourceText: 'hello from source audio',
    detectedLanguage: 'en',
    startMs: 0,
    endMs: 15_000,
    confidence: 0.91,
    status: 'transcribed',
    createdAt: '2026-07-17T08:30:00.000Z',
  };
}

function makeTimestampedTranslationEvent(): TimestampedTranslationEvent {
  return {
    sessionId: 'ps_integration',
    streamId: 'stream_integration',
    segmentId: 'ps_integration:chunk:0',
    sequence: 0,
    sourceLanguage: 'en',
    targetLanguage: 'fr',
    sourceText: 'hello from source audio',
    translatedText: '[fr] hello from source audio',
    startMs: 0,
    endMs: 15_000,
    status: 'translated',
    latency: {
      queuedMs: 0,
      providerMs: 3,
      totalMs: 3,
    },
    createdAt: '2026-07-17T08:30:00.000Z',
  };
}

function makeGeneratedAudioReadyEvent(
  sequence: number,
  targetLanguage = 'es',
): GeneratedAudioReadyEvent {
  return {
    sessionId: 'ps_integration',
    streamId: 'stream_integration',
    segmentId: `ps_integration:chunk:${sequence}`,
    sequence,
    targetLanguage,
    translatedText: `audio translated ${sequence}`,
    startMs: sequence * 15_000,
    endMs: sequence * 15_000 + 15_000,
    voiceId: 'es-test',
    durationMs: 900,
    providerLatencyMs: 12,
    audioUrl: `http://localhost:3002/sessions/ps_integration/generated-audio/segments/ps_integration%3Achunk%3A${sequence}/audio`,
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
  let gateway: Gateway;
  let baseUrl: string;
  let clients: Socket[];

  beforeEach(async () => {
    server = createServer(createApp());
    gateway = new Gateway(server, ['http://localhost:5173', 'http://localhost:5174'], {
    call: { authorizeHost: async () => true },
      operator: { authSecret: OPERATOR_SECRET },
    });
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
      ...(role === 'operator' ? { auth: { token: OPERATOR_TOKEN } } : {}),
      // Only the operator role is authenticated; every other role connects
      // exactly as before.
      ...(role === 'operator' ? { auth: { token: OPERATOR_TOKEN } } : {}),
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnectionDelay: 50,
      reconnectionDelayMax: 100,
    });
    clients.push(socket);
    /*
     * These suites exercise the PLATFORM channel, where a listener that never
     * names a channel sits. An operator now lands on their own channel at
     * connect (founder directive A, 30 Aug 2026), so the operator here moves
     * to the platform channel first. Buffered before connect, it is the first
     * message the gateway handles from this socket; re-sent on a reconnect,
     * because a fresh connection lands afresh.
     */
    if (role === 'operator') {
      socket.emit(SOCKET_EVENTS.JOIN_CHANNEL, { channelId: 'main' });
      socket.io.on('reconnect', () => {
        socket.emit(SOCKET_EVENTS.JOIN_CHANNEL, { channelId: 'main' });
      });
    }
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
    await waitUntil(
      () => operator.connected && frenchListener.connected && spanishListener.connected,
    );
    await delay(150);
    await waitUntil(
      () => operator.connected && frenchListener.connected && spanishListener.connected,
    );
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
      streamStatus: 'processing',
      connectedListeners: 2,
    });
    await expect(operatorMedia).resolves.toMatchObject({
      eventId: 'integration-event',
      streamStatus: 'processing',
      connectedListeners: 2,
    });

    const operatorTranscription = waitForEvent<TranscriptionEvent>(
      operator,
      SOCKET_EVENTS.TRANSCRIPTION_EVENT,
    );
    ingest.emit(SOCKET_EVENTS.INGEST_TRANSCRIPTION, makeTranscriptionEvent());

    await expect(operatorTranscription).resolves.toMatchObject({
      sessionId: 'ps_integration',
      chunkId: 'ps_integration:chunk:0',
      sourceText: 'hello from source audio',
      status: 'transcribed',
    });

    const operatorTimestampedTranslation = waitForEvent<TimestampedTranslationEvent>(
      operator,
      SOCKET_EVENTS.TIMESTAMPED_TRANSLATION_EVENT,
    );
    ingest.emit(SOCKET_EVENTS.INGEST_TRANSLATION, makeTimestampedTranslationEvent());

    await expect(operatorTimestampedTranslation).resolves.toMatchObject({
      sessionId: 'ps_integration',
      segmentId: 'ps_integration:chunk:0',
      translatedText: '[fr] hello from source audio',
      status: 'translated',
    });
  });

  it('delivers translated caption segments to language-room and original-channel listeners', async () => {
    const ingest = client('ingest');
    const operator = client('operator');
    const frenchListener = client('listener');
    const originalListener = client('listener');
    const spanishListener = client('listener');
    await Promise.all([
      waitForConnect(ingest),
      waitForConnect(operator),
      waitForConnect(frenchListener),
      waitForConnect(originalListener),
      waitForConnect(spanishListener),
    ]);

    frenchListener.emit(SOCKET_EVENTS.JOIN_LANGUAGE, 'fr');
    originalListener.emit(SOCKET_EVENTS.JOIN_LANGUAGE, 'original');
    spanishListener.emit(SOCKET_EVENTS.JOIN_LANGUAGE, 'es');
    await delay(50);

    const frenchEvents: TimestampedTranslationEvent[] = [];
    const originalEvents: TimestampedTranslationEvent[] = [];
    const spanishEvents: TimestampedTranslationEvent[] = [];
    const operatorEvents: TimestampedTranslationEvent[] = [];
    frenchListener.on(
      SOCKET_EVENTS.TIMESTAMPED_TRANSLATION_EVENT,
      (event: TimestampedTranslationEvent) => frenchEvents.push(event),
    );
    originalListener.on(
      SOCKET_EVENTS.TIMESTAMPED_TRANSLATION_EVENT,
      (event: TimestampedTranslationEvent) => originalEvents.push(event),
    );
    spanishListener.on(
      SOCKET_EVENTS.TIMESTAMPED_TRANSLATION_EVENT,
      (event: TimestampedTranslationEvent) => spanishEvents.push(event),
    );
    operator.on(
      SOCKET_EVENTS.TIMESTAMPED_TRANSLATION_EVENT,
      (event: TimestampedTranslationEvent) => operatorEvents.push(event),
    );

    ingest.emit(SOCKET_EVENTS.INGEST_TRANSLATION, makeTimestampedTranslationEvent());
    await waitUntil(
      () =>
        frenchEvents.length === 1 && originalEvents.length === 1 && operatorEvents.length === 1,
    );
    expect(frenchEvents[0]).toMatchObject({
      segmentId: 'ps_integration:chunk:0',
      translatedText: '[fr] hello from source audio',
      status: 'translated',
    });
    expect(originalEvents[0]).toMatchObject({
      segmentId: 'ps_integration:chunk:0',
      sourceText: 'hello from source audio',
      status: 'translated',
    });
    expect(spanishEvents).toHaveLength(0);

    ingest.emit(SOCKET_EVENTS.INGEST_TRANSLATION, {
      ...makeTimestampedTranslationEvent(),
      segmentId: 'ps_integration:chunk:1',
      sequence: 1,
      status: 'failed',
      error: 'provider failed',
    });
    await waitUntil(() => operatorEvents.length === 2);
    await delay(50);
    expect(frenchEvents).toHaveLength(1);
    expect(originalEvents).toHaveLength(1);
  });

  it('lets a listener join and leave the original caption channel without errors', async () => {
    const ingest = client('ingest');
    const listener = client('listener');
    await Promise.all([waitForConnect(ingest), waitForConnect(listener)]);

    const errors: Array<{ message: string }> = [];
    listener.on(SOCKET_EVENTS.ERROR, (event: { message: string }) => errors.push(event));
    const captions: TimestampedTranslationEvent[] = [];
    listener.on(
      SOCKET_EVENTS.TIMESTAMPED_TRANSLATION_EVENT,
      (event: TimestampedTranslationEvent) => captions.push(event),
    );

    listener.emit(SOCKET_EVENTS.JOIN_LANGUAGE, 'original');
    await delay(50);
    ingest.emit(SOCKET_EVENTS.INGEST_TRANSLATION, makeTimestampedTranslationEvent());
    await waitUntil(() => captions.length === 1);
    expect(errors).toEqual([]);

    listener.emit(SOCKET_EVENTS.LEAVE_LANGUAGE, 'original');
    await delay(50);
    ingest.emit(SOCKET_EVENTS.INGEST_TRANSLATION, {
      ...makeTimestampedTranslationEvent(),
      segmentId: 'ps_integration:chunk:1',
      sequence: 1,
    });
    await delay(75);
    expect(captions).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('delivers generated audio to listeners in order and rejects duplicates', async () => {
    const ingest = client('ingest');
    const operator = client('operator');
    const spanishListener = client('listener');
    const frenchListener = client('listener');
    await Promise.all([
      waitForConnect(ingest),
      waitForConnect(operator),
      waitForConnect(spanishListener),
      waitForConnect(frenchListener),
    ]);

    spanishListener.emit(SOCKET_EVENTS.JOIN_LANGUAGE, 'es');
    frenchListener.emit(SOCKET_EVENTS.JOIN_LANGUAGE, 'fr');
    await delay(50);

    const spanishEvents: GeneratedAudioReadyEvent[] = [];
    const frenchEvents: GeneratedAudioReadyEvent[] = [];
    const operatorEvents: GeneratedAudioReadyEvent[] = [];
    spanishListener.on(SOCKET_EVENTS.GENERATED_AUDIO_READY, (event: GeneratedAudioReadyEvent) => {
      spanishEvents.push(event);
    });
    frenchListener.on(SOCKET_EVENTS.GENERATED_AUDIO_READY, (event: GeneratedAudioReadyEvent) => {
      frenchEvents.push(event);
    });
    operator.on(SOCKET_EVENTS.GENERATED_AUDIO_READY, (event: GeneratedAudioReadyEvent) => {
      operatorEvents.push(event);
    });

    ingest.emit(SOCKET_EVENTS.INGEST_GENERATED_AUDIO, makeGeneratedAudioReadyEvent(0));
    ingest.emit(SOCKET_EVENTS.INGEST_GENERATED_AUDIO, makeGeneratedAudioReadyEvent(2));
    await waitUntil(() => spanishEvents.length === 1 && operatorEvents.length === 1);
    expect(spanishEvents.map((event) => event.sequence)).toEqual([0]);

    ingest.emit(SOCKET_EVENTS.INGEST_GENERATED_AUDIO, makeGeneratedAudioReadyEvent(1));
    await waitUntil(() => spanishEvents.length === 3 && operatorEvents.length === 3);
    expect(spanishEvents.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(operatorEvents.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(frenchEvents).toHaveLength(0);

    ingest.emit(SOCKET_EVENTS.INGEST_GENERATED_AUDIO, makeGeneratedAudioReadyEvent(1));
    await delay(50);
    expect(spanishEvents.map((event) => event.sequence)).toEqual([0, 1, 2]);
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

  it('validates, broadcasts and retains operator audio mix preferences', async () => {
    const operator = client('operator');
    const listener = client('listener');
    const listenerEvents: AudioMixPreferences[] = [];
    listener.on(
      SOCKET_EVENTS.AUDIO_MODE_PREFERENCES,
      (preferences: AudioMixPreferences) => listenerEvents.push(preferences),
    );
    await Promise.all([waitForConnect(operator), waitForConnect(listener)]);
    await waitUntil(() => listenerEvents.length === 1);

    const preferences: AudioMixPreferences = {
      mode: 'replacement',
      originalVolume: 0.45,
      translatedVolume: 0.7,
      subtitlesEnabled: false,
    };
    operator.emit(SOCKET_EVENTS.OPERATOR_AUDIO_MODE_PREFERENCES, preferences);
    await waitUntil(() => listenerEvents.length === 2);
    expect(listenerEvents.at(-1)).toEqual(preferences);

    const operatorError = waitForEvent<{ message: string }>(operator, SOCKET_EVENTS.ERROR);
    operator.emit(SOCKET_EVENTS.OPERATOR_AUDIO_MODE_PREFERENCES, {
      ...preferences,
      originalVolume: 2,
    });
    await expect(operatorError).resolves.toEqual({
      message: 'Invalid audio mode preferences',
    });
    expect(listenerEvents).toHaveLength(2);

    const laterListener = client('listener');
    const retained = waitForEvent<AudioMixPreferences>(
      laterListener,
      SOCKET_EVENTS.AUDIO_MODE_PREFERENCES,
    );
    await waitForConnect(laterListener);
    await expect(retained).resolves.toEqual(preferences);
  });

  it('stores operator programme-session language config for WebRTC processing', async () => {
    const operator = client('operator');
    const ingest = client('ingest');
    const listener = client('listener');
    await Promise.all([waitForConnect(operator), waitForConnect(ingest), waitForConnect(listener)]);
    const ack = waitForEvent<{ action: string; accepted: boolean }>(
      operator,
      SOCKET_EVENTS.CONTROL_ACK,
    );
    const immediateMedia = waitForEvent<MediaStateEvent>(listener, SOCKET_EVENTS.MEDIA_STATE);

    operator.emit(SOCKET_EVENTS.OPERATOR_PROGRAMME_SESSION_CONFIG, {
      sessionId: 'wrs_uploaded',
      broadcastId: 'broadcast_uploaded',
      sourceRevision: 2,
      targetLanguage: 'es',
      targetLanguages: ['es'],
      sourceLanguage: 'en',
      sourceLanguageMode: 'auto-detect',
    });

    await expect(immediateMedia).resolves.toMatchObject({
      processingSessionId: 'wrs_uploaded',
      shareableWebRtcSessionId: 'broadcast_uploaded/wrs_uploaded',
      streamStatus: 'processing',
      videoSource: 'webrtc',
      videoTimestampMs: 0,
      connectedListeners: 1,
    });
    await expect(ack).resolves.toMatchObject({
      action: 'programme-session-config',
      accepted: true,
    });
    const inspected = gateway as unknown as {
      programmeSessionConfigs: Map<string, unknown>;
    };
    expect(inspected.programmeSessionConfigs.get('wrs_uploaded')).toMatchObject({
      targetLanguage: 'es',
      sourceLanguage: 'en',
      sourceLanguageMode: 'auto-detect',
    });

    const media = waitForEvent<MediaStateEvent>(listener, SOCKET_EVENTS.MEDIA_STATE);
    ingest.emit(SOCKET_EVENTS.INGEST_STATE, {
      ...makeMediaState(),
      processingSessionId: 'wrs_uploaded',
    });

    await expect(media).resolves.toMatchObject({
      processingSessionId: 'wrs_uploaded',
      shareableWebRtcSessionId: 'broadcast_uploaded/wrs_uploaded',
    });
  });

  it('carries the retained programme video timestamp into synthetic media state', async () => {
    const operator = client('operator');
    const ingest = client('ingest');
    const listener = client('listener');
    await Promise.all([waitForConnect(operator), waitForConnect(ingest), waitForConnect(listener)]);

    const mediaEvents: MediaStateEvent[] = [];
    listener.on(SOCKET_EVENTS.MEDIA_STATE, (event: MediaStateEvent) => mediaEvents.push(event));

    const configPayload = {
      sessionId: 'wrs_resumed',
      broadcastId: 'broadcast_resumed',
      sourceRevision: 1,
      targetLanguage: 'es',
      targetLanguages: ['es'],
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
    };
    operator.emit(SOCKET_EVENTS.OPERATOR_PROGRAMME_SESSION_CONFIG, configPayload);
    await waitUntil(() => mediaEvents.length === 1);
    expect(mediaEvents[0]).toMatchObject({
      processingSessionId: 'wrs_resumed',
      videoTimestampMs: 0,
    });

    ingest.emit(SOCKET_EVENTS.INGEST_STATE, {
      ...makeMediaState(),
      processingSessionId: 'wrs_resumed',
    });
    await waitUntil(() => mediaEvents.length === 2);

    operator.emit(SOCKET_EVENTS.OPERATOR_PROGRAMME_SESSION_CONFIG, configPayload);
    await waitUntil(() => mediaEvents.length === 3);
    expect(mediaEvents[2]).toMatchObject({
      processingSessionId: 'wrs_resumed',
      videoTimestampMs: 12_000,
    });
  });

  it('replays the active programme media state to listeners that connect late', async () => {
    const operator = client('operator');
    await waitForConnect(operator);

    operator.emit(SOCKET_EVENTS.OPERATOR_PROGRAMME_SESSION_CONFIG, {
      sessionId: 'wrs_uploaded_late',
      broadcastId: 'broadcast_uploaded_late',
      sourceRevision: 3,
      targetLanguage: 'es',
      targetLanguages: ['es'],
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
    });

    const lateListener = client('listener');
    const replayed = waitForEvent<MediaStateEvent>(lateListener, SOCKET_EVENTS.MEDIA_STATE);
    await waitForConnect(lateListener);

    await expect(replayed).resolves.toMatchObject({
      processingSessionId: 'wrs_uploaded_late',
      shareableWebRtcSessionId: 'broadcast_uploaded_late/wrs_uploaded_late',
      streamStatus: 'processing',
      videoSource: 'webrtc',
      connectedListeners: 1,
    });
  });

  it('does not replay a completed programme media state to late listeners', async () => {
    const operator = client('operator');
    const ingest = client('ingest');
    await Promise.all([waitForConnect(operator), waitForConnect(ingest)]);

    operator.emit(SOCKET_EVENTS.OPERATOR_PROGRAMME_SESSION_CONFIG, {
      sessionId: 'wrs_completed_upload',
      broadcastId: 'broadcast_completed_upload',
      sourceRevision: 4,
      targetLanguage: 'es',
      targetLanguages: ['es'],
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
    });
    ingest.emit(SOCKET_EVENTS.INGEST_STATE, {
      ...makeMediaState(),
      processingSessionId: 'wrs_completed_upload',
      streamStatus: 'completed',
    });
    await delay(25);

    const lateListener = client('listener');
    const replayed: MediaStateEvent[] = [];
    lateListener.on(SOCKET_EVENTS.MEDIA_STATE, (event: MediaStateEvent) => {
      replayed.push(event);
    });
    await waitForConnect(lateListener);
    await delay(75);

    expect(replayed).toEqual([]);
  });

  it('stops advertising retained programme media state after ingest disconnects', async () => {
    const ingest = client('ingest');
    await waitForConnect(ingest);

    ingest.emit(SOCKET_EVENTS.INGEST_STATE, {
      ...makeMediaState(),
      processingSessionId: 'wrs_stale_upload',
      streamStatus: 'processing',
      programmeMediaUrl: 'http://localhost:3002/sessions/wrs_stale_upload/source-media',
    });
    await delay(25);

    ingest.disconnect();
    await delay(50);

    const lateListener = client('listener');
    const replayed: MediaStateEvent[] = [];
    lateListener.on(SOCKET_EVENTS.MEDIA_STATE, (event: MediaStateEvent) => {
      replayed.push(event);
    });
    await waitForConnect(lateListener);
    await delay(75);

    expect(replayed).toEqual([]);
  });

  it('rejects invalid programme-session language config visibly', async () => {
    const operator = client('operator');
    await waitForConnect(operator);
    const error = waitForEvent<{ message: string }>(operator, SOCKET_EVENTS.ERROR);

    operator.emit(SOCKET_EVENTS.OPERATOR_PROGRAMME_SESSION_CONFIG, {
      sessionId: 'wrs_uploaded',
      broadcastId: 'broadcast_uploaded',
      sourceRevision: 2,
      targetLanguage: 'zz',
      targetLanguages: [],
      sourceLanguage: 'en',
      sourceLanguageMode: 'auto-detect',
    });

    await expect(error).resolves.toEqual({
      message: 'Invalid programme session configuration',
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

describe('gateway public media ingest URL', () => {
  it('builds listener-facing programme media URLs from the public ingest URL', async () => {
    const server = createServer(createApp());
    new Gateway(server, ['http://localhost:5173'], {
    call: { authorizeHost: async () => true },
      mediaIngestUrl: 'http://internal-ingest:3002',
      mediaIngestPublicUrl: 'https://media.example.com',
      operator: { authSecret: OPERATOR_SECRET },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const sockets: Socket[] = [];
    const connect = (role: string): Socket => {
      const socket = connectClient(baseUrl, {
        query: { role },
      ...(role === 'operator' ? { auth: { token: OPERATOR_TOKEN } } : {}),
        transports: ['websocket', 'polling'],
        forceNew: true,
        reconnection: false,
      });
      sockets.push(socket);
      // The platform channel, as above: an operator lands on their own
      // channel at connect and this suite listens on the platform one.
      if (role === 'operator') socket.emit(SOCKET_EVENTS.JOIN_CHANNEL, { channelId: 'main' });
      return socket;
    };

    try {
      const operator = connect('operator');
      const ingest = connect('ingest');
      const listener = connect('listener');
      await Promise.all([
        waitForConnect(operator),
        waitForConnect(ingest),
        waitForConnect(listener),
      ]);
      const mediaEvents: MediaStateEvent[] = [];
      listener.on(SOCKET_EVENTS.MEDIA_STATE, (event: MediaStateEvent) => mediaEvents.push(event));

      operator.emit(SOCKET_EVENTS.OPERATOR_PROGRAMME_SESSION_CONFIG, {
        sessionId: 'wrs_public',
        broadcastId: 'broadcast_public',
        sourceRevision: 1,
        programmeSourceType: 'uploaded-video',
        targetLanguage: 'es',
        targetLanguages: ['es'],
        sourceLanguage: 'en',
        sourceLanguageMode: 'manual',
      });
      await waitUntil(() => mediaEvents.length >= 1);

      ingest.emit(SOCKET_EVENTS.INGEST_STATE, {
        ...makeMediaState(),
        processingSessionId: 'wrs_public',
        streamStatus: 'completed',
      });
      await waitUntil(() => mediaEvents.some((event) => Boolean(event.programmeMediaUrl)));

      expect(mediaEvents.find((event) => event.programmeMediaUrl)).toMatchObject({
        processingSessionId: 'wrs_public',
        programmeMediaUrl: 'https://media.example.com/sessions/wrs_public/source-media',
      });
    } finally {
      for (const socket of sockets) socket.disconnect();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function collectServiceStatuses(socket: Socket): ServiceStatusEvent[] {
  const statuses: ServiceStatusEvent[] = [];
  socket.on(SOCKET_EVENTS.SERVICE_STATUS, (event: ServiceStatusEvent) => {
    statuses.push(event);
  });
  return statuses;
}

function latestStatuses(
  statuses: ServiceStatusEvent[],
): Record<ServiceStatusEvent['service'], string> {
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
