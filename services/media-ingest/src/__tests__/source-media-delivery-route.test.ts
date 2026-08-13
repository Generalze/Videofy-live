import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaIngestError } from '../ingest-error.js';
import {
  registerSourceMediaDeliveryRoute,
  type SourceMediaDeliveryService,
} from '../source-media-delivery-route.js';
import type { SourceMediaFile } from '../media-session.js';

const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('source-media delivery route', () => {
  it('serves uploaded source media with browser range support', async () => {
    const temp = await tempDir();
    const mediaPath = join(temp, 'source.mp4');
    const media = Buffer.from('videofy-source-media-fixture');
    await writeFile(mediaPath, media);
    const baseUrl = await startDeliveryApp({
      getSourceMediaFile: async () => sourceMediaFile(mediaPath, media.length),
    });

    const full = await fetch(`${baseUrl}/sessions/wrs_uploaded/source-media`);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toContain('video/mp4');
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect((await full.arrayBuffer()).byteLength).toBe(media.length);

    const partial = await fetch(`${baseUrl}/sessions/wrs_uploaded/source-media`, {
      headers: { range: 'bytes=0-6' },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(`bytes 0-6/${media.length}`);
    expect(Buffer.from(await partial.arrayBuffer()).toString('utf8')).toBe('videofy');
  });

  it('returns clear errors for missing, unavailable and unsafe source-media requests', async () => {
    const baseUrl = await startDeliveryApp({
      getSourceMediaFile: async (sessionId) => {
        if (sessionId.includes('..')) {
          throw new MediaIngestError('Unsafe session ID rejected.', 'unsafe-path', 400);
        }
        throw new MediaIngestError(
          `Uploaded source media is unavailable for session ${sessionId}.`,
          'source-media-unavailable',
          404,
        );
      },
    });

    const missing = await fetch(`${baseUrl}/sessions/wrs_missing/source-media`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'source-media-unavailable' });

    const unsafe = await fetch(`${baseUrl}/sessions/..%2Fbad/source-media`);
    expect(unsafe.status).toBe(400);
    expect(await unsafe.json()).toMatchObject({ code: 'unsafe-path' });
  });
});

async function startDeliveryApp(service: SourceMediaDeliveryService): Promise<string> {
  const app = express();
  registerSourceMediaDeliveryRoute(app, service);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'videofy-source-delivery-'));
  tempDirs.push(dir);
  return dir;
}

function sourceMediaFile(mediaPath: string, sizeBytes: number): SourceMediaFile {
  return {
    mediaPath,
    mimeType: 'video/mp4',
    sizeBytes,
  };
}
