/** @author masterzee001 */
/**
 * One canonical public URL, and a loud complaint when it cannot work.
 *
 * The defect these pin: media-ingest read `INGEST_PUBLIC_URL` while `.env` and
 * `.env.example` set `MEDIA_INGEST_PUBLIC_URL`, so a correctly-configured
 * deployment still minted `http://localhost:3002` for remote clients — and that
 * is invisible on the machine doing the minting, because there localhost is
 * right.
 */
import { describe, expect, it } from 'vitest';
import {
  PublicIngestUrlError,
  isLoopbackHost,
  resolvePublicIngestUrl,
} from '../public-ingest-url.js';

const OPTIONS = { defaultPort: 3002, serviceName: 'test' };

describe('resolution order', () => {
  it('prefers the canonical variable', () => {
    const resolution = resolvePublicIngestUrl(
      {
        MEDIA_INGEST_PUBLIC_URL: 'http://192.168.0.179:3002',
        INGEST_PUBLIC_URL: 'http://elsewhere:3002',
        MEDIA_INGEST_URL: 'http://internal:3002',
      },
      OPTIONS,
    );

    expect(resolution).toMatchObject({
      url: 'http://192.168.0.179:3002',
      source: 'MEDIA_INGEST_PUBLIC_URL',
      loopback: false,
    });
  });

  it('still accepts the deprecated alias, and says so', () => {
    // Removing it outright would break any deployment already using it, and a
    // silent behaviour change is what caused this defect in the first place.
    const resolution = resolvePublicIngestUrl(
      { INGEST_PUBLIC_URL: 'http://192.168.0.179:3002' },
      OPTIONS,
    );

    expect(resolution).toMatchObject({
      url: 'http://192.168.0.179:3002',
      source: 'INGEST_PUBLIC_URL',
    });
    expect(resolution.warnings.join(' ')).toMatch(/deprecated/i);
  });

  it('complains loudly when the two disagree', () => {
    // Two sources of truth that differ is worse than either alone: which one
    // wins depends on which service you happen to ask.
    const resolution = resolvePublicIngestUrl(
      {
        MEDIA_INGEST_PUBLIC_URL: 'http://192.168.0.179:3002',
        INGEST_PUBLIC_URL: 'http://192.168.0.55:3002',
      },
      OPTIONS,
    );

    expect(resolution.url).toBe('http://192.168.0.179:3002');
    expect(resolution.warnings.join(' ')).toMatch(/DISAGREE/);
  });

  it('falls back to the internal URL before inventing localhost', () => {
    const resolution = resolvePublicIngestUrl(
      { MEDIA_INGEST_URL: 'http://192.168.0.179:3002' },
      OPTIONS,
    );

    expect(resolution).toMatchObject({ url: 'http://192.168.0.179:3002', source: 'MEDIA_INGEST_URL' });
    expect(resolution.warnings).toEqual([]);
  });

  it('treats a blank value as unset, so a templated line does not win', () => {
    const resolution = resolvePublicIngestUrl(
      { MEDIA_INGEST_PUBLIC_URL: '   ', MEDIA_INGEST_URL: 'http://host:3002' },
      OPTIONS,
    );

    expect(resolution.source).toBe('MEDIA_INGEST_URL');
  });

  it('strips a trailing slash, so the minted path never doubles it', () => {
    expect(
      resolvePublicIngestUrl({ MEDIA_INGEST_PUBLIC_URL: 'http://host:3002//' }, OPTIONS).url,
    ).toBe('http://host:3002');
  });
});

describe('warning when public delivery cannot work', () => {
  it('warns that a loopback URL is unusable from any other device', () => {
    // THE defect, in one assertion. This configuration is silently correct on
    // the machine that produced it and broken everywhere else.
    const resolution = resolvePublicIngestUrl(
      { MEDIA_INGEST_PUBLIC_URL: 'http://localhost:3002' },
      OPTIONS,
    );

    expect(resolution.loopback).toBe(true);
    const warning = resolution.warnings.join(' ');
    expect(warning).toMatch(/LOOPBACK/);
    // Names the symptom, because the symptom is what somebody will be looking at.
    expect(warning).toMatch(/MediaError 4|NotSupportedError/);
  });

  it('warns for the whole 127.0.0.0\/8 range and for the unspecified address', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', '0.0.0.0', '[::1]']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ['192.168.0.179', 'media.example.com', '10.0.0.5']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it('says nothing when the configuration is fine', () => {
    expect(
      resolvePublicIngestUrl({ MEDIA_INGEST_PUBLIC_URL: 'https://media.example.com' }, OPTIONS)
        .warnings,
    ).toEqual([]);
  });

  it('defaults to localhost with a warning rather than failing a local dev run', () => {
    // Refusing to start would make every single-machine developer configure a
    // LAN address they do not need.
    const resolution = resolvePublicIngestUrl({}, OPTIONS);

    expect(resolution).toMatchObject({ url: 'http://localhost:3002', source: 'default' });
    expect(resolution.loopback).toBe(true);
    expect(resolution.warnings).toHaveLength(1);
  });
});

describe('failing loudly', () => {
  it('refuses a value that is not an absolute URL', () => {
    // A malformed public URL cannot produce anything but broken clients, and
    // failing at startup beats failing on somebody's phone.
    expect(() =>
      resolvePublicIngestUrl({ MEDIA_INGEST_PUBLIC_URL: '192.168.0.179:3002' }, OPTIONS),
    ).toThrow(PublicIngestUrlError);
  });

  it('refuses a non-http scheme', () => {
    expect(() =>
      resolvePublicIngestUrl({ MEDIA_INGEST_PUBLIC_URL: 'ws://host:3002' }, OPTIONS),
    ).toThrow(/http or https/);
  });

  it('can be made to refuse loopback outright, for deployments that must not risk it', () => {
    expect(() =>
      resolvePublicIngestUrl(
        { MEDIA_INGEST_PUBLIC_URL: 'http://localhost:3002', MEDIA_INGEST_REQUIRE_PUBLIC_URL: 'true' },
        OPTIONS,
      ),
    ).toThrow(/Remote clients could not fetch/);
  });

  it('is opt-in: strictness off by default keeps local development working', () => {
    expect(() => resolvePublicIngestUrl({}, OPTIONS)).not.toThrow();
    expect(() =>
      resolvePublicIngestUrl({ MEDIA_INGEST_REQUIRE_PUBLIC_URL: 'false' }, OPTIONS),
    ).not.toThrow();
  });
});

describe('the two services agree', () => {
  it('resolves identically for the gateway and for media-ingest', () => {
    // The whole point. These used to read different variables, and the
    // disagreement was only observable from a second device.
    const env = { MEDIA_INGEST_PUBLIC_URL: 'http://192.168.0.179:3002' };
    const gateway = resolvePublicIngestUrl(env, { defaultPort: 3002, serviceName: 'gateway' });
    const ingest = resolvePublicIngestUrl(env, { defaultPort: 3002, serviceName: 'media-ingest' });

    expect(gateway.url).toBe(ingest.url);
    expect(gateway.source).toBe(ingest.source);
  });
});
