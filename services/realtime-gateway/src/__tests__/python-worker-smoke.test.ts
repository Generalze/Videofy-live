import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as connectClient, type Socket } from 'socket.io-client';
import type { TranslationEvent } from '@videofy-live/shared-types';
import { SOCKET_EVENTS } from '@videofy-live/shared-types';
import { afterEach, describe, expect, it } from 'vitest';
import { issueSessionToken, requireSessionSecret } from '@videofy-live/account-tokens';

/*
 * This smoke test spawns the REAL gateway process, so the operator secret has
 * to reach it the way it reaches production -- through the environment -- and
 * the operator client has to present a token signed with the same one.
 *
 * Leaving it unset would make the gateway refuse every operator, which is the
 * correct behaviour for an unconfigured privileged surface and would simply
 * fail this test for the right reason.
 */
const OPERATOR_SECRET = 'z'.repeat(48);
const OPERATOR_TOKEN = issueSessionToken({
  secret: requireSessionSecret(OPERATOR_SECRET, 'TEST_OPERATOR_SECRET'),
  accountId: 'acct_a1b2c3d4e5f60718',
  version: 1,
  nowSeconds: Math.floor(Date.now() / 1000),
});

const testDir = dirname(fileURLToPath(import.meta.url));
const gatewayDir = resolve(testDir, '../..');
const repoRoot = resolve(gatewayDir, '../..');
const workerDir = resolve(repoRoot, 'services/speech-worker');

describe('Python worker to Node gateway smoke', () => {
  const sockets: Socket[] = [];
  const processes: ChildProcessWithoutNullStreams[] = [];

  afterEach(async () => {
    for (const socket of sockets) {
      socket.disconnect();
    }
    await Promise.all(processes.map((child) => terminate(child)));
  });

  it('routes a real Python worker French translation to listener and operator', async () => {
    const gatewayPort = await freePort();
    const workerHealthPort = await freePort();
    const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

    const gateway = spawn(process.execPath, ['dist/index.js'], {
      cwd: gatewayDir,
      env: {
        ...process.env,
        GATEWAY_HOST: '127.0.0.1',
        GATEWAY_PORT: String(gatewayPort),
        CORS_ORIGINS: 'http://127.0.0.1',
        LOG_LEVEL: 'error',
        VIDEOFY_AUTH_SECRET: OPERATOR_SECRET,
        // The gateway refuses to start without this: unset, its internal media
        // API would accept audio from anyone who can reach the port. That guard
        // predates the operator work and is unrelated to it -- the smoke test
        // simply never satisfied it, so the process died before /health existed
        // and the failure read as a timeout rather than as a refusal.
        INTERNAL_WEBRTC_TOKEN: 'f'.repeat(64),
        // The operator console is GRANTED, not ambient (founder ruling,
        // 2026-08-27): the gateway refuses any operator not on this list, and
        // an empty list refuses everybody. The smoke's operator token names
        // this account, so it is granted here the way production grants --
        // through the environment -- and the refusal path stays exercised by
        // the operator-authority unit tests.
        OPERATOR_CONSOLE_ACCOUNT_IDS: 'acct_a1b2c3d4e5f60718',
      },
      stdio: 'pipe',
    });
    processes.push(gateway);
    await waitForHttp(`${gatewayUrl}/health`);

    const listener = connect('listener', gatewayUrl);
    const spanishListener = connect('listener', gatewayUrl);
    const operator = connect('operator', gatewayUrl);
    await Promise.all([
      waitForConnect(listener),
      waitForConnect(spanishListener),
      waitForConnect(operator),
    ]);
    listener.emit(SOCKET_EVENTS.JOIN_LANGUAGE, 'fr');
    spanishListener.emit(SOCKET_EVENTS.JOIN_LANGUAGE, 'es');

    const frenchEvent = waitForEvent<TranslationEvent>(listener, SOCKET_EVENTS.TRANSLATION_EVENT);
    const operatorEvent = waitForEvent<TranslationEvent>(operator, SOCKET_EVENTS.TRANSLATION_EVENT);
    const spanishEvents: TranslationEvent[] = [];
    spanishListener.on(SOCKET_EVENTS.TRANSLATION_EVENT, (event: TranslationEvent) => {
      spanishEvents.push(event);
    });

    const worker = spawn(resolvePython(), ['main.py'], {
      cwd: workerDir,
      env: {
        ...process.env,
        EVENT_ID: 'python-smoke-event',
        GATEWAY_URL: gatewayUrl,
        LOG_LEVEL: 'ERROR',
        MOCK_PHRASE_INTERVAL_MS: '100',
        SOURCE_LANGUAGE: 'en',
        SPEECH_WORKER_PORT: String(workerHealthPort),
        TARGET_LANGUAGE: 'fr',
      },
      stdio: 'pipe',
    });
    processes.push(worker);

    const [listenerPayload, operatorPayload] = await Promise.all([frenchEvent, operatorEvent]);

    expect(listenerPayload).toMatchObject({
      eventId: 'python-smoke-event',
      sequence: 1,
      sourceLanguage: 'en',
      targetLanguage: 'fr',
      final: true,
    });
    expect(operatorPayload).toMatchObject({
      eventId: 'python-smoke-event',
      sequence: listenerPayload.sequence,
      targetLanguage: 'fr',
    });

    await delay(100);
    expect(spanishEvents).toEqual([]);
  }, 15_000);

  function connect(role: string, gatewayUrl: string): Socket {
    const socket = connectClient(gatewayUrl, {
      query: { role },
      // Only the operator role is authenticated.
      ...(role === 'operator' ? { auth: { token: OPERATOR_TOKEN } } : {}),
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnectionDelay: 50,
      reconnectionDelayMax: 100,
    });
    sockets.push(socket);
    // The listeners here never name a channel, so they sit on the platform
    // channel; an operator lands on their own at connect (founder directive
    // A, 30 Aug 2026) and is moved there first.
    if (role === 'operator') socket.emit(SOCKET_EVENTS.JOIN_CHANNEL, { channelId: 'main' });
    return socket;
  }
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function resolvePython(): string {
  if (process.env['PYTHON']) return process.env['PYTHON'];

  const windowsVenv = resolve(workerDir, '.venv/Scripts/python.exe');
  if (existsSync(windowsVenv)) return windowsVenv;

  const unixVenv = resolve(workerDir, '.venv/bin/python');
  if (existsSync(unixVenv)) return unixVenv;

  return process.platform === 'win32' ? 'python.exe' : 'python';
}

function waitForConnect(socket: Socket): Promise<void> {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out connecting socket ${socket.id ?? 'unknown'}`));
    }, 5_000);
    socket.once('connect', () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function waitForEvent<T>(socket: Socket, eventName: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, 10_000);
    socket.once(eventName, (payload: T) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

async function waitForHttp(url: string, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Retry until the child process has bound its port.
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const closed = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  });
  child.kill('SIGTERM');
  await Promise.race([
    closed,
    delay(2_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }),
  ]);
}
