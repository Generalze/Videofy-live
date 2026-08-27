/** @author masterzee001 */
/**
 * Profile pictures: who may write, who may read, and what counts as an image.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { registerAvatarRoutes, sniffImageMime } from '../avatar-routes.js';
import type { Caller } from '../routes.js';

const TRUST = {
  email: 'verified',
  phone: 'unverified',
  identity: 'unverified',
  risk: 'normal',
  restriction: 'none',
} as const;

function caller(accountId: string): Caller {
  return { accountId, trust: TRUST, record: {} as Caller['record'] };
}

/** Smallest real JPEG header; the sniffer reads magic bytes, not validity. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const dataUrl = (bytes: Buffer, label = 'image/jpeg'): string =>
  `data:${label};base64,${bytes.toString('base64')}`;

interface Harness {
  url: string;
  close: () => Promise<void>;
  as: (accountId: string | null, path: string, init?: RequestInit) => Promise<Response>;
}

async function harness(): Promise<Harness> {
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  registerAvatarRoutes(app, {
    avatarDir: await mkdtemp(join(tmpdir(), 'avatars-')),
    callerAccountId: (req) => {
      const id = req.header('x-test-account');
      return id ? caller(id) : null;
    },
  });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    close: () => new Promise<void>((r) => server.close(() => r())),
    as: (accountId, path, init = {}) =>
      fetch(`${url}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(accountId === null ? {} : { 'x-test-account': accountId }),
          ...(init.headers ?? {}),
        },
      }),
  };
}

const A = 'acct_00000000000000aa';
const B = 'acct_00000000000000bb';

let app: Harness;
afterEach(async () => {
  await app?.close();
});

describe('setting a picture', () => {
  it('stores an upload and serves it to any signed-in account', async () => {
    app = await harness();
    const put = await app.as(A, '/profile/avatar', {
      method: 'PUT',
      body: JSON.stringify({ image: dataUrl(JPEG) }),
    });
    expect(put.status).toBe(200);

    // A stranger with a session sees it: avatars appear on call tiles, and a
    // conference contains people who are not your contacts.
    const got = await app.as(B, `/avatars/${A}`);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await got.arrayBuffer()).equals(JPEG)).toBe(true);
  });

  it('judges the bytes, not the label: an svg dressed as jpeg is refused', async () => {
    app = await harness();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const put = await app.as(A, '/profile/avatar', {
      method: 'PUT',
      body: JSON.stringify({ image: dataUrl(svg, 'image/jpeg') }),
    });
    expect(put.status).toBe(400);
  });

  it('removes on delete and answers 404 afterwards', async () => {
    app = await harness();
    await app.as(A, '/profile/avatar', {
      method: 'PUT',
      body: JSON.stringify({ image: dataUrl(JPEG) }),
    });
    await app.as(A, '/profile/avatar', { method: 'DELETE' });
    expect((await app.as(B, `/avatars/${A}`)).status).toBe(404);
  });
});

describe('who is refused', () => {
  it('requires a session for reading and writing alike', async () => {
    app = await harness();
    expect((await app.as(null, `/avatars/${A}`)).status).toBe(401);
    expect(
      (
        await app.as(null, '/profile/avatar', {
          method: 'PUT',
          body: JSON.stringify({ image: dataUrl(JPEG) }),
        })
      ).status,
    ).toBe(401);
  });

  it('answers a malformed id and a missing picture identically', async () => {
    app = await harness();
    const malformed = await app.as(A, '/avatars/not-an-id');
    const absent = await app.as(A, `/avatars/${B}`);
    expect(malformed.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(await malformed.text()).toBe(await absent.text());
  });
});

describe('sniffing', () => {
  it('recognises jpeg, png and webp; nothing else', () => {
    expect(sniffImageMime(JPEG)).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe('image/png');
    expect(
      sniffImageMime(Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1')])),
    ).toBe('image/webp');
    expect(sniffImageMime(Buffer.from('RIFFxxxxWAVE', 'latin1'))).toBe(null);
    expect(sniffImageMime(Buffer.from('GIF89a', 'latin1'))).toBe(null);
  });
});
