/** @author masterzee001 */
/**
 * Reading `.env` in the service itself, rather than hoping the shell did it.
 *
 * Configuration used to arrive from whatever terminal happened to start a
 * service, which works right up until it does not: a service started from a
 * different window silently has different settings, and nothing says so. That
 * was survivable while every missing value degraded visibly — a voice model
 * that fails to load announces itself.
 *
 * It stopped being survivable when authentication arrived. A media-ingest
 * without VIDEOFY_AUTH_SECRET fails CLOSED, exactly as designed, and the symptom
 * is "signing in does nothing" — indistinguishable from a bug in sign-in, in the
 * token, in the browser, or in the account service. The cause is a terminal.
 *
 * So it is read here, once, deterministically:
 *
 *   - the real environment always wins, so an explicit override still works and
 *     production is never overridden by a file that happens to exist
 *   - a missing file is silence, not an error: `.env` is a development
 *     convenience and services must start without one
 *   - values are taken literally to the end of the line, because this repository
 *     is full of Windows paths and comma-separated registries that a shell would
 *     mangle and a clever parser would mangle differently
 *
 * No dependency, because the module that decides where secrets come from is a
 * poor place to inherit somebody else's release process.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface LoadedEnvFile {
  readonly path: string;
  readonly found: boolean;
  /** Names applied. Never the values — this is safe to log. */
  readonly applied: readonly string[];
  /** Names already set in the real environment, so the file did not win. */
  readonly skipped: readonly string[];
}

export function loadEnvFile(filePath: string): LoadedEnvFile {
  const path = resolve(filePath);
  if (!existsSync(path)) return { path, found: false, applied: [], skipped: [] };

  const applied: string[] = [];
  const skipped: string[] = [];
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    // An unreadable file is the same as an absent one. Refusing to start over a
    // development convenience would be a worse failure than the one it fixes.
    return { path, found: false, applied: [], skipped: [] };
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    // A UTF-8 BOM on the first line otherwise becomes part of the first name,
    // producing a variable nobody can ever read.
    const line = rawLine.replace(/^﻿/, '').trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    if (process.env[name] !== undefined) {
      skipped.push(name);
      continue;
    }
    // Deliberately literal: no expansion, no comment stripping, no unescaping.
    // The values here are Windows paths and comma-separated model registries,
    // and every one of those transformations has a way to corrupt them.
    let value = line.slice(separator + 1).trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted?.[2] !== undefined) value = quoted[2];
    process.env[name] = value;
    applied.push(name);
  }

  return { path, found: true, applied, skipped };
}

/** Load the repository's `.env`, given a service directory two levels down. */
export function loadRepositoryEnv(fromDirectory: string = process.cwd()): LoadedEnvFile {
  return loadEnvFile(resolve(fromDirectory, '../../.env'));
}

// One canonical answer to "may this caller inject media into the platform?" —
// see internal-ingress-auth.ts for why the default had to be inverted.
export {
  ADAPTER_SERVICE_TOKEN_VARIABLE,
  ALLOW_INSECURE_ADAPTER_INGRESS_VARIABLE,
  ALLOW_INSECURE_INTERNAL_INGRESS_VARIABLE,
  INTERNAL_INGRESS_TOKEN_VARIABLE,
  InternalIngressAuthError,
  MINIMUM_INTERNAL_INGRESS_TOKEN_LENGTH,
  internalIngressRequestAllowed,
  matchesInternalIngressToken,
  resolveAdapterServiceAuth,
  resolveInternalIngressAuth,
  type InternalIngressAuthMode,
  type InternalIngressAuthResolution,
  type ResolveInternalIngressAuthOptions,
} from './internal-ingress-auth.js';

// One canonical answer to "what URL will a browser be given for generated
// audio?" — see public-ingest-url.ts for why that needed a module.
export {
  DEPRECATED_PUBLIC_INGEST_URL_VARIABLE,
  PUBLIC_INGEST_URL_VARIABLE,
  PublicIngestUrlError,
  REQUIRE_PUBLIC_INGEST_URL_VARIABLE,
  isLoopbackHost,
  resolvePublicIngestUrl,
  type PublicIngestUrlResolution,
  type PublicIngestUrlSource,
  type ResolvePublicIngestUrlOptions,
} from './public-ingest-url.js';
