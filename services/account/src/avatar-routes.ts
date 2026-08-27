/** @author masterzee001 */
/**
 * Profile pictures.
 *
 * THE FILE IS THE STATE. An avatar is one image per account on disk, named by
 * the account id; no database column records it, because the filesystem
 * already answers "is there one" and "when did it change". What a column
 * would add is a way for the two to disagree.
 *
 * WHO MAY SEE ONE: anybody signed in. An avatar appears on call tiles, and a
 * conference contains people who are not your contacts; gating it on the
 * contact graph would blank exactly those tiles. What stays gated is writing:
 * only the account itself may set or clear its picture.
 *
 * THE CLIENT SENDS A SMALL IMAGE. Upload is a base64 data-URL in JSON --
 * same shape as voice notes -- with a route-scoped body limit, and the client
 * downscales before sending. The server checks magic bytes rather than
 * trusting the declared type: a "jpeg" that opens with <svg would otherwise
 * become stored script served to every contact.
 */
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import type { Caller } from './routes.js';

export interface AvatarRouteDependencies {
  /** Where avatar images live. Created on first use. */
  readonly avatarDir: string;
  readonly callerAccountId: (req: express.Request) => Caller | null;
}

/** Decoded image cap. Clients downscale to ~512px; this is the backstop. */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

const MAGIC: readonly { readonly mime: string; readonly bytes: readonly number[] }[] = [
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  // WebP: RIFF....WEBP — the RIFF prefix is checked here, WEBP at offset 8 below.
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] },
];

/** The stored type, from the bytes themselves. Null means "not an image we serve". */
export function sniffImageMime(bytes: Buffer): string | null {
  for (const candidate of MAGIC) {
    if (candidate.bytes.every((byte, index) => bytes[index] === byte)) {
      if (candidate.mime === 'image/webp') {
        return bytes.subarray(8, 12).toString('ascii') === 'WEBP' ? 'image/webp' : null;
      }
      return candidate.mime;
    }
  }
  return null;
}

const EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Account ids are minted by us; anything else in the path is a probe. */
const ACCOUNT_ID = /^acct_[0-9a-f]{16}$/;

function avatarPathFor(dir: string, accountId: string, extension: string): string {
  return join(dir, `${accountId}.${extension}`);
}

async function findExisting(
  dir: string,
  accountId: string,
): Promise<{ path: string; mime: string; mtimeMs: number } | null> {
  for (const [mime, extension] of Object.entries(EXTENSION)) {
    const path = avatarPathFor(dir, accountId, extension);
    try {
      const info = await stat(path);
      return { path, mime, mtimeMs: info.mtimeMs };
    } catch {
      // Not this extension; the next may exist.
    }
  }
  return null;
}

/**
 * Express 4 does not catch a rejected async handler; the failure becomes an
 * unhandled rejection and kills the process. Staging proved it: a read-only
 * avatars directory turned one PUT into a service restart. Every handler
 * below rides through this wrapper so a filesystem fault is a 500 with a
 * sentence, never an outage.
 */
function guarded(
  handler: (req: express.Request, res: express.Response) => Promise<void>,
): (req: express.Request, res: express.Response) => void {
  return (req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'That could not be completed. Try again.' });
      }
    });
  };
}

export function registerAvatarRoutes(
  app: express.Express,
  deps: AvatarRouteDependencies,
): void {
  /*
   * Route-scoped parser: a 3MB JSON body (2MB image as base64) must not raise
   * the global 16kb limit that protects every identity endpoint.
   */
  app.put('/profile/avatar', express.json({ limit: '4mb' }), guarded(async (req, res) => {
    const caller = deps.callerAccountId(req);
    if (caller === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    const dataUrl = (req.body as { image?: unknown } | undefined)?.image;
    const match =
      typeof dataUrl === 'string' ? /^data:image\/[a-z+]+;base64,(.+)$/.exec(dataUrl) : null;
    if (match === null) {
      res.status(400).json({ error: 'Send the picture as a data URL.' });
      return;
    }
    const bytes = Buffer.from(match[1] ?? '', 'base64');
    if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) {
      res.status(400).json({ error: 'That picture is too large. Use one under 2MB.' });
      return;
    }
    // The bytes decide the type; the data-URL label is not consulted.
    const mime = sniffImageMime(bytes);
    if (mime === null) {
      res.status(400).json({ error: 'Use a JPEG, PNG or WebP picture.' });
      return;
    }
    await mkdir(deps.avatarDir, { recursive: true });
    // A change of format must not leave the old file behind as the answer.
    const previous = await findExisting(deps.avatarDir, caller.accountId);
    if (previous !== null) await unlink(previous.path).catch(() => undefined);
    await writeFile(avatarPathFor(deps.avatarDir, caller.accountId, EXTENSION[mime] ?? 'jpg'), bytes);
    res.json({ updated: true });
  }));

  app.delete('/profile/avatar', guarded(async (req, res) => {
    const caller = deps.callerAccountId(req);
    if (caller === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    const existing = await findExisting(deps.avatarDir, caller.accountId);
    if (existing !== null) await unlink(existing.path).catch(() => undefined);
    res.json({ removed: true });
  }));

  app.get('/avatars/:accountId', guarded(async (req, res) => {
    if (deps.callerAccountId(req) === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    const accountId = String(req.params['accountId'] ?? '');
    if (!ACCOUNT_ID.test(accountId)) {
      res.status(404).json({ error: 'No picture.' });
      return;
    }
    const existing = await findExisting(deps.avatarDir, accountId);
    if (existing === null) {
      // One answer for "no such account" and "no picture": this route must not
      // become an account-id oracle.
      res.status(404).json({ error: 'No picture.' });
      return;
    }
    res.setHeader('content-type', existing.mime);
    // A minute of staleness beats re-downloading every contact's face per poll.
    res.setHeader('cache-control', 'private, max-age=60');
    createReadStream(existing.path).pipe(res);
  }));
}
