/** @author masterzee001 */
/**
 * The object store, as this package needs it, and an S3-compatible client.
 *
 * THE PORT IS SMALL ON PURPOSE. Put, get, head, delete, list, and one
 * conditional create. Everything the archive does is built from those six, so a
 * deployment that wants a different backing store implements six methods rather
 * than reproducing a lifecycle. It is also what keeps a provider's name out of
 * the Replay domain: the archive above this knows about keys and bytes and has
 * never heard of a region.
 *
 * WHY A CLIENT AND NOT AN SDK. The whole of what is used here is
 * GET/PUT/HEAD/DELETE and one list, signed. A vendor SDK brings a dependency
 * tree, a release cadence and a configuration surface far larger than that, and
 * it tends to arrive with a provider's name attached -- which is precisely the
 * coupling this milestone is meant to avoid. SigV4 is a published algorithm and
 * about two hundred lines; it is implemented here, once, against `fetch` and
 * `node:crypto`.
 *
 * COMPATIBILITY IS THE POINT. Path-style addressing, an explicit region and no
 * assumptions about DNS mean the same client speaks to AWS S3, Contabo Object
 * Storage, MinIO, and anything else implementing the same requests. Nothing
 * below branches on who is answering.
 *
 * CREDENTIALS LIVE HERE AND NOWHERE ELSE. They are held by the client, used to
 * sign, and never written into a key, a reference, a state document, an error
 * message or a log line. `describeStoreError` exists so that a failure can be
 * reported without the signed URL that produced it.
 */

import { createHash, createHmac } from 'node:crypto';
import type { Readable } from 'node:stream';

/* ----------------------------------------------------------------- the port */

/** One inclusive byte range, as HTTP means it. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

export interface StoredObjectHead {
  readonly sizeBytes: number;
  /** Whatever the store calls this version. Compared, never parsed. */
  readonly etag: string;
}

export interface StoredObjectBody extends StoredObjectHead {
  readonly body: Readable;
  /** Bytes actually being returned: the range's length, or the whole object. */
  readonly returnedBytes: number;
}

export interface PutOptions {
  /**
   * Refuse if the key already exists.
   *
   * THE CONDITIONAL THE ARCHIVE'S STATE WRITES DEPEND ON. Widely supported, and
   * where it is not, the archive verifies its write afterwards rather than
   * trusting it -- see the read-back in `object-archive.ts`.
   */
  readonly ifAbsent?: boolean;
  readonly contentType?: string;
}

export interface ListedObject {
  readonly key: string;
  readonly sizeBytes: number;
}

/**
 * A store that would refuse rather than overwrite, or could not be reached.
 *
 * `precondition` IS NOT AN OUTAGE. It means somebody else got there first,
 * which for a state write is the correct and expected answer to a race.
 */
export class ObjectStoreError extends Error {
  constructor(
    message: string,
    readonly kind: 'precondition' | 'not-found' | 'unavailable',
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'ObjectStoreError';
  }
}

export interface ReplayObjectStore {
  put(key: string, body: Buffer, options?: PutOptions): Promise<StoredObjectHead>;
  /** Streamed, so a segment is never materialised in memory to be served. */
  putStream(
    key: string,
    body: Readable,
    sizeBytes: number,
    options?: PutOptions,
  ): Promise<StoredObjectHead>;
  get(key: string, range?: ByteRange): Promise<StoredObjectBody>;
  /** Null when the object is not there. Absence is an answer, not an error. */
  head(key: string): Promise<StoredObjectHead | null>;
  /** Idempotent: removing what is not there succeeds. */
  delete(key: string): Promise<void>;
  list(prefix: string, limit?: number): Promise<readonly ListedObject[]>;
}

/** An error message with nothing in it that could identify a deployment. */
export function describeStoreError(error: unknown): string {
  if (error instanceof ObjectStoreError) return error.message;
  if (error instanceof Error) {
    /*
     * A URL IN A MESSAGE IS AN ENDPOINT IN A LOG. `fetch` failures routinely
     * quote the request URL, which on a signed request carries the host, the
     * bucket, the key and sometimes query credentials. The shape is stripped
     * rather than passed along.
     */
    return error.message.replace(/https?:\/\/\S+/giu, '<endpoint>');
  }
  return String(error);
}

/* ------------------------------------------------------------- the client */

export interface S3StoreConfig {
  /** e.g. https://s3.eu-central-1.amazonaws.com, or a MinIO origin. */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /**
   * Path-style addressing (`<endpoint>/<bucket>/<key>`).
   *
   * DEFAULT ON, DELIBERATELY. Virtual-host style needs wildcard DNS and a
   * bucket name that is a legal hostname; path style works everywhere,
   * including a MinIO on localhost and every provider that has not finished
   * migrating. Nothing here needs the other one.
   */
  readonly forcePathStyle?: boolean;
  /** Injected for tests; the global `fetch` otherwise. */
  readonly fetcher?: typeof fetch;
}

const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

function sha256Hex(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/**
 * Percent-encode for a signature, which is not what `encodeURIComponent` does.
 *
 * SigV4 requires the unreserved set to be left alone and everything else
 * encoded in UPPERCASE hex, and `!'()*` are reserved here where the built-in
 * leaves them. Getting this wrong produces a signature mismatch on exactly the
 * keys that contain those characters and on no others, which is the kind of bug
 * that survives every test written with ordinary names.
 */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** A key as a path: each segment encoded, the separators kept. */
function encodeKey(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/');
}

function amzDate(now: Date): { readonly stamp: string; readonly date: string } {
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/gu, '');
  return { stamp, date: stamp.slice(0, 8) };
}

/**
 * An S3-compatible store, spoken to over ordinary signed HTTP.
 *
 * NO PROVIDER BRANCHING. Every request below is the same request whichever
 * implementation answers it, which is what makes "S3-compatible" a claim this
 * can actually make rather than a label.
 */
export class S3CompatibleObjectStore implements ReplayObjectStore {
  private readonly fetcher: typeof fetch;
  private readonly origin: string;
  private readonly pathStyle: boolean;

  constructor(private readonly config: S3StoreConfig) {
    this.fetcher = config.fetcher ?? fetch;
    this.origin = config.endpoint.replace(/\/$/u, '');
    this.pathStyle = config.forcePathStyle !== false;
  }

  async put(key: string, body: Buffer, options: PutOptions = {}): Promise<StoredObjectHead> {
    const response = await this.send('PUT', key, {
      body,
      payloadHash: sha256Hex(body),
      headers: this.putHeaders(body.length, options),
    });
    return this.headFromResponse(response, body.length);
  }

  async putStream(
    key: string,
    body: Readable,
    sizeBytes: number,
    options: PutOptions = {},
  ): Promise<StoredObjectHead> {
    /*
     * UNSIGNED-PAYLOAD, because a streamed body cannot be hashed before it is
     * sent without buffering the whole thing -- which for a video fragment is
     * exactly what streaming is avoiding. The request itself is still signed;
     * what is not covered is the body, and the archive verifies the stored
     * object's length afterwards regardless. Every S3-compatible store accepts
     * this over HTTPS, and the transport is what protects the bytes in flight.
     */
    const response = await this.send('PUT', key, {
      body,
      payloadHash: UNSIGNED_PAYLOAD,
      headers: this.putHeaders(sizeBytes, options),
    });
    return this.headFromResponse(response, sizeBytes);
  }

  async get(key: string, range?: ByteRange): Promise<StoredObjectBody> {
    const headers: Record<string, string> = {};
    if (range !== undefined) headers['range'] = `bytes=${range.start}-${range.end}`;
    const response = await this.send('GET', key, { payloadHash: EMPTY_SHA256, headers });

    const length = Number(response.headers.get('content-length') ?? '0');
    const body = response.body;
    if (body === null) {
      throw new ObjectStoreError('the store returned no body', 'unavailable', response.status);
    }
    /*
     * A WEB STREAM BECOMES A NODE STREAM ONCE, HERE. Everything above this
     * point deals in Node streams because that is what an HTTP response is
     * piped from, and doing the conversion at the boundary keeps it out of
     * every caller.
     */
    const { Readable: NodeReadable } = await import('node:stream');
    const stream = NodeReadable.fromWeb(body as Parameters<typeof NodeReadable.fromWeb>[0]);

    return {
      body: stream,
      returnedBytes: length,
      sizeBytes: totalFromContentRange(response.headers.get('content-range')) ?? length,
      etag: normaliseEtag(response.headers.get('etag')),
    };
  }

  async head(key: string): Promise<StoredObjectHead | null> {
    try {
      const response = await this.send('HEAD', key, { payloadHash: EMPTY_SHA256, headers: {} });
      return this.headFromResponse(response, Number(response.headers.get('content-length') ?? '0'));
    } catch (error) {
      // ABSENCE IS AN ANSWER. Every caller here asks "is it there", and a
      // thrown not-found would make each of them write the same catch.
      if (error instanceof ObjectStoreError && error.kind === 'not-found') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.send('DELETE', key, { payloadHash: EMPTY_SHA256, headers: {} });
    } catch (error) {
      // Removing what is not there is the state the caller asked for.
      if (error instanceof ObjectStoreError && error.kind === 'not-found') return;
      throw error;
    }
  }

  async list(prefix: string, limit = 1000): Promise<readonly ListedObject[]> {
    const found: ListedObject[] = [];
    let token: string | null = null;
    /*
     * PAGED TO EXHAUSTION, BOUNDED BY `limit`. A store returns at most a
     * thousand keys per call whatever is asked for, so a single request would
     * silently truncate a long-running channel's history -- and a truncated
     * recovery listing means a state generation nobody finds.
     */
    do {
      const query: Record<string, string> = {
        'list-type': '2',
        prefix,
        'max-keys': String(Math.min(1000, limit - found.length)),
      };
      if (token !== null) query['continuation-token'] = token;
      const response = await this.send('GET', '', {
        payloadHash: EMPTY_SHA256,
        headers: {},
        query,
      });
      const xml = await response.text();
      for (const entry of parseListing(xml)) {
        found.push(entry);
        if (found.length >= limit) return found;
      }
      token = truncatedToken(xml);
    } while (token !== null && found.length < limit);
    return found;
  }

  /* ---------------------------------------------------------- the plumbing */

  private putHeaders(sizeBytes: number, options: PutOptions): Record<string, string> {
    const headers: Record<string, string> = { 'content-length': String(sizeBytes) };
    if (options.contentType !== undefined) headers['content-type'] = options.contentType;
    // The create-if-absent conditional, as the protocol spells it.
    if (options.ifAbsent === true) headers['if-none-match'] = '*';
    return headers;
  }

  private headFromResponse(response: Response, fallbackBytes: number): StoredObjectHead {
    return {
      sizeBytes: Number(response.headers.get('content-length') ?? String(fallbackBytes)) || fallbackBytes,
      etag: normaliseEtag(response.headers.get('etag')),
    };
  }

  private async send(
    method: string,
    key: string,
    request: {
      readonly payloadHash: string;
      readonly headers: Record<string, string>;
      readonly body?: Buffer | Readable;
      readonly query?: Record<string, string>;
    },
  ): Promise<Response> {
    const { url, canonicalUri, canonicalQuery, host } = this.address(key, request.query);
    const now = new Date();
    const { stamp, date } = amzDate(now);

    const headers: Record<string, string> = {
      ...request.headers,
      host,
      'x-amz-content-sha256': request.payloadHash,
      'x-amz-date': stamp,
    };

    const signedNames = Object.keys(headers)
      .map((name) => name.toLowerCase())
      .sort();
    const canonicalHeaders = signedNames
      .map((name) => `${name}:${String(headers[name] ?? headers[name.toLowerCase()] ?? '').trim()}\n`)
      .join('');
    const signedHeaders = signedNames.join(';');

    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      request.payloadHash,
    ].join('\n');

    const scope = `${date}/${this.config.region}/s3/aws4_request`;
    const toSign = [
      'AWS4-HMAC-SHA256',
      stamp,
      scope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, date), this.config.region), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(toSign, 'utf8').digest('hex');

    headers['authorization'] =
      `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers,
        ...(request.body === undefined
          ? {}
          : {
              body: request.body as unknown as ReadableStream,
              // Node's fetch needs telling that a stream body is not a form.
              duplex: 'half',
            }),
      } as RequestInit);
    } catch (error) {
      throw new ObjectStoreError(
        `the object store could not be reached: ${describeStoreError(error)}`,
        'unavailable',
      );
    }

    if (response.ok) return response;

    /*
     * THE STATUS IS CLASSIFIED, THE BODY IS NOT REPEATED. A store's error
     * document names the bucket and often the key; neither belongs in a log
     * line that an operator reads or a message that reaches a caller.
     */
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404) {
      throw new ObjectStoreError('the object is not there', 'not-found', 404);
    }
    if (response.status === 412 || response.status === 409) {
      throw new ObjectStoreError(
        'the object store refused the write: something else got there first',
        'precondition',
        response.status,
      );
    }
    throw new ObjectStoreError(
      `the object store answered ${response.status}`,
      'unavailable',
      response.status,
    );
  }

  private address(
    key: string,
    query: Record<string, string> | undefined,
  ): { url: string; canonicalUri: string; canonicalQuery: string; host: string } {
    const base = new URL(this.origin);
    const encodedKey = key === '' ? '' : `/${encodeKey(key)}`;
    const canonicalUri = this.pathStyle
      ? `${base.pathname.replace(/\/$/u, '')}/${encodeRfc3986(this.config.bucket)}${encodedKey}`
      : `${base.pathname.replace(/\/$/u, '')}${encodedKey}`;

    const canonicalQuery = Object.entries(query ?? {})
      .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([name, value]) => `${name}=${value}`)
      .join('&');

    const host = this.pathStyle ? base.host : `${this.config.bucket}.${base.host}`;
    const url = `${base.protocol}//${host}${canonicalUri}${canonicalQuery === '' ? '' : `?${canonicalQuery}`}`;
    return { url, canonicalUri: canonicalUri === '' ? '/' : canonicalUri, canonicalQuery, host };
  }
}

/* --------------------------------------------------------------- responses */

function normaliseEtag(raw: string | null): string {
  // Stores quote them, some weakly. Compared for equality only, so the quotes
  // are stripped once here rather than at every comparison.
  return (raw ?? '').replace(/^W\//u, '').replace(/"/gu, '');
}

function totalFromContentRange(raw: string | null): number | null {
  const match = raw === null ? null : /\/(\d+)$/u.exec(raw);
  return match === null ? null : Number(match[1]);
}

/**
 * The keys and sizes out of a ListObjectsV2 response.
 *
 * A DELIBERATELY NARROW READER, not an XML parser. Three fields are wanted, the
 * document is machine-generated by the store, and adding a parser dependency to
 * read `<Key>` would be a large surface for a small need. Anything it cannot
 * read is simply not returned, which for a listing is safe: the caller re-reads
 * authoritative state per run anyway.
 */
function parseListing(xml: string): readonly ListedObject[] {
  const found: ListedObject[] = [];
  const contents = /<Contents>([\s\S]*?)<\/Contents>/gu;
  let block: RegExpExecArray | null;
  while ((block = contents.exec(xml)) !== null) {
    const body = block[1] ?? '';
    const key = /<Key>([\s\S]*?)<\/Key>/u.exec(body)?.[1];
    const size = /<Size>(\d+)<\/Size>/u.exec(body)?.[1];
    if (key === undefined) continue;
    found.push({ key: decodeXml(key), sizeBytes: size === undefined ? 0 : Number(size) });
  }
  return found;
}

function truncatedToken(xml: string): string | null {
  if (!/<IsTruncated>\s*true\s*<\/IsTruncated>/iu.test(xml)) return null;
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/u.exec(xml)?.[1];
  return token === undefined ? null : decodeXml(token);
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'");
}
