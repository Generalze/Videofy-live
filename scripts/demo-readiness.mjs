#!/usr/bin/env node
/** @author masterzee001 */
/**
 * Demo readiness — one command, run before the investor presentation, that
 * checks everything docs/INVESTOR_DEMO_RUNBOOK.md depends on.
 *
 *   node scripts/demo-readiness.mjs [origin] [--strict]
 *
 *   origin    the deployment to check (default https://staging.consummate7.com)
 *   --strict  a check that could NOT be determined (BLOCKED) also exits non-zero
 *
 * WHY THIS EXISTS. Every beat of the runbook rests on something that is true
 * of a DEPLOYMENT rather than of the code: the listener bundle was built with
 * the right base, a channel with a handle exists, the relay is not behind the
 * proxy, the synthesis vendor is a real one rather than the mock. Each of
 * those has failed at least once in this project's history, and every one of
 * them fails SILENTLY -- a blank page that returns 200, a relay that issues
 * credentials to nothing, a translation chain that produces confident silence.
 * Discovering one of them with an audience in the room is the outcome this
 * script exists to make impossible.
 *
 * THE HONESTY RULE IT ENFORCES (memory: nigerian-language-specialist,
 * silent-broken-fallback). ElevenLabs and Azure both answer HTTP 200 with real
 * audio for Yoruba, Hausa and Igbo, and a speaker of those languages will tell
 * you it is a multilingual voice reading unfamiliar orthography with the wrong
 * phonology. So nothing here infers language quality from a status code. The
 * language section reports the CAPABILITY STATE the deployment itself
 * publishes -- `qualified`, `available`, `limited`, `unavailable`, resolved
 * from evidence grades in services/ai-registry -- and reports the Nigerian
 * languages separately, because whether they are the real thing or a degraded
 * rendering depends on a specialist vendor being configured, which no amount
 * of successful requests can establish.
 *
 * WHAT IT NEVER PRINTS. No secret VALUE of any kind. Vendors are named
 * (`deepgram`, `elevenlabs`, `azure`, `naijalingo`); keys are never read, and
 * the only thing said about the relay's short-lived credential is how many
 * seconds remain before it expires -- parsed, never echoed.
 *
 * EXIT STATUS. Non-zero on any FAIL. A BLOCKED check -- one this script could
 * not determine from outside the box, such as a deployed SHA no endpoint
 * publishes -- does not fail the run by default, because "I could not see it
 * from here" is not the same claim as "it is wrong", and the runbook carries a
 * by-hand fallback for each one. `--strict` makes blocks fail too. The summary
 * names the blocked count either way, so no green run can hide one.
 *
 * DELIBERATELY DIFFERENT FROM scripts/mobile-contract-acceptance.mjs, where a
 * BLOCKED check DOES fail by default. That suite exists to certify a contract,
 * and a certificate with a hole in it is worthless. This one exists to tell a
 * person about to walk on stage what they can and cannot show. The two want
 * different defaults for the same word, so both say which they use.
 */
import { resolve4 } from 'node:dns/promises';

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const unknownFlags = argv.filter((arg) => arg.startsWith('-') && arg !== '--strict');
if (unknownFlags.length > 0) {
  console.error(`Unknown option(s): ${unknownFlags.join(' ')}`);
  console.error('usage: node scripts/demo-readiness.mjs [origin] [--strict]');
  process.exit(2);
}
const origin = (argv.find((arg) => !arg.startsWith('-')) ?? 'https://staging.consummate7.com').replace(
  /\/$/,
  '',
);

// ------------------------------------------------------------------ results
const rows = [];
let failed = 0;
let blocked = 0;

/** A PASS/FAIL row. `detail` carries the status code or the measured value. */
function check(group, name, ok, detail) {
  rows.push({ group, name, outcome: ok ? 'PASS' : 'FAIL', detail: detail ?? '' });
  if (!ok) failed += 1;
}

/**
 * A check this script could not DETERMINE, as opposed to one it determined to
 * be wrong. Never counted as a pass; see the exit-status note in the header.
 */
function undetermined(group, name, why) {
  rows.push({ group, name, outcome: 'BLOCKED', detail: why });
  blocked += 1;
}

/** Context a reader needs that is not itself pass-or-fail. */
const notes = [];
function note(text) {
  notes.push(text);
}

// -------------------------------------------------------------- HTTP helpers
const USER_AGENT = 'VideofyLive-DemoReadiness/1.0';

async function get(path, init = {}) {
  try {
    const response = await fetch(`${origin}${path}`, {
      ...init,
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT, ...(init.headers ?? {}) },
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return {
      ok: true,
      status: response.status,
      headers: response.headers,
      text,
      json,
      bytes: Buffer.byteLength(text),
    };
  } catch (error) {
    return { ok: false, status: 0, headers: new Headers(), text: '', json: null, bytes: 0, error };
  }
}

function code(response) {
  return response.ok ? `HTTP ${response.status}` : `unreachable: ${String(response.error?.message ?? response.error)}`;
}

// ==========================================================================
// 1. Services
// ==========================================================================
async function checkServices() {
  const gateway = await get('/health');
  check(
    'services',
    'realtime-gateway healthy through the edge',
    gateway.status === 200 && gateway.json?.service === 'realtime-gateway',
    `${code(gateway)}, service=${gateway.json?.service ?? '(none)'}`,
  );

  const media = await get('/media/health');
  /*
   * 503 IS THE HONEST DEGRADED ANSWER, NOT AN OUTAGE -- and it still fails
   * this check. media-ingest answers 503 when it is not connected to the
   * gateway, which is exactly the state in which a programme produces
   * captions and no audio. Better to see it here than on stage.
   */
  check(
    'services',
    'media-ingest healthy and connected to the gateway',
    media.status === 200 && media.json?.status === 'ok' && media.json?.gatewayConnected === true,
    `${code(media)}, status=${media.json?.status ?? '?'}, gatewayConnected=${media.json?.gatewayConnected}`,
  );

  /*
   * The account service has no anonymous 200. A 401 from /auth/sessions/current
   * proves two things at once: the service is up, and it is fail-closed.
   */
  const account = await get('/auth/sessions/current');
  check(
    'services',
    'account service up and refusing anonymous callers',
    account.status === 401,
    `${code(account)} (expected 401)`,
  );

  return media;
}

// ==========================================================================
// 2. The four surfaces the demo is driven from
// ==========================================================================
/**
 * A single-page app built with the wrong `--base` serves a perfectly good
 * index.html whose script tag 404s: the page loads, blank, and every status
 * check passes. So each surface is checked by fetching the shell, reading the
 * FIRST script src out of it, and fetching that too.
 */
async function checkSurfaces() {
  const surfaces = [
    ['C7 site', '/', '/assets/'],
    ['call-web (translated calls)', '/call/', '/call/assets/'],
    ['listener-web (viewers)', '/listen/', '/listen/assets/'],
    ['operator console', '/operator/', '/operator/assets/'],
  ];
  for (const [label, path, prefix] of surfaces) {
    const shell = await get(path);
    if (shell.status !== 200) {
      check('surfaces', `${label} served at ${path}`, false, code(shell));
      continue;
    }
    const src = /<script[^>]+src="([^"]+)"/.exec(shell.text)?.[1] ?? null;
    if (src === null) {
      check('surfaces', `${label} served at ${path}`, false, 'HTTP 200 but no script tag in the shell');
      continue;
    }
    if (!src.startsWith(prefix)) {
      check('surfaces', `${label} served at ${path}`, false, `script src ${src} is not under ${prefix} (blank page)`);
      continue;
    }
    const asset = await get(src);
    check(
      'surfaces',
      `${label} served at ${path}`,
      asset.status === 200,
      `HTTP 200, bundle ${src} -> HTTP ${asset.status}`,
    );

    /*
     * THE SHELL-CACHING TRAP (memory: spa-shell-caching). index.html served
     * without a Cache-Control header is heuristically cached by browsers and
     * by Cloudflare, so a fix deployed an hour before the demo keeps not
     * appearing and nobody can say why. The bundles are content-hashed and may
     * cache forever; the shell that points at them must not.
     */
    const cacheControl = (shell.headers.get('cache-control') ?? '').toLowerCase();
    const revalidates =
      cacheControl.includes('no-store') ||
      cacheControl.includes('no-cache') ||
      /max-age=0\b/.test(cacheControl);
    check(
      'surfaces',
      `${label} shell is revalidated, not heuristically cached`,
      revalidates,
      `cache-control: ${cacheControl || '(absent)'}`,
    );
  }
}

// ==========================================================================
// 3. Languages — the capability states, read rather than wished for
// ==========================================================================
const NIGERIAN_LANGUAGES = [
  ['yo', 'Yoruba'],
  ['ha', 'Hausa'],
  ['ig', 'Igbo'],
  ['pcm', 'Nigerian Pidgin'],
];

/** States a language may be demonstrated in, strongest first. */
const DEMONSTRABLE_STATES = new Set(['qualified', 'available']);

async function checkLanguages(mediaHealth) {
  const catalogue = await get('/media/languages/catalogue');
  const list = Array.isArray(catalogue.json?.catalogue) ? catalogue.json.catalogue : null;
  check(
    'languages',
    'language catalogue reachable',
    catalogue.status === 200 && list !== null && list.length > 0,
    `${code(catalogue)}, ${list?.length ?? 0} language(s)`,
  );
  if (list === null || list.length === 0) return;

  /*
   * The tally is the point. "All languages enabled" is a claim about a picker;
   * this is a claim about the chain, and the two are different numbers.
   */
  const byState = new Map();
  for (const row of list) {
    const state = typeof row?.state === 'string' ? row.state : 'unknown';
    byState.set(state, (byState.get(state) ?? 0) + 1);
  }
  const tally = [...byState.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([state, count]) => `${state}=${count}`)
    .join(', ');
  check('languages', 'every catalogue row carries a capability state', !byState.has('unknown'), tally);

  const withVoice = list.filter((row) => row?.voiceAvailable === true && DEMONSTRABLE_STATES.has(row?.state));
  check(
    'languages',
    'at least one language can be demonstrated with VOICE',
    withVoice.length > 0,
    `${withVoice.length} of ${list.length}: ${withVoice.slice(0, 12).map((row) => row.language).join(' ') || '(none)'}`,
  );
  const textOnly = list.filter((row) => row?.textOnly === true);
  note(
    `Voice today: ${withVoice.length} language(s). Captions-only: ${textOnly.length}. ` +
      `Total offered by this deployment: ${list.length}.`,
  );

  // ---- the synthesis chain, by NAME
  const engine = mediaHealth?.json?.translationEngine ?? null;
  if (engine === null) {
    undetermined('languages', 'the live translation chain names real vendors', '/media/health carried no translationEngine');
  } else {
    const stubbed = Array.isArray(engine.stubbed) ? engine.stubbed : [];
    check(
      'languages',
      'the live translation chain names real vendors (not mock, not off)',
      engine.real === true && stubbed.length === 0,
      `stt=${engine.transcription} · mt=${engine.translation} · tts=${engine.synthesis}` +
        (stubbed.length > 0 ? ` · STUBBED: ${stubbed.join(', ')}` : ''),
    );
  }

  // ---- the Nigerian languages, which no status code can vouch for
  /*
   * READ THE DEPLOYMENT'S OWN ANSWER, DO NOT PATTERN-MATCH FOR IT.
   *
   * This block used to decide the question by searching the whole /media/health
   * body for the string "naijalingo". That inverted the one row in this script
   * that a demo actually turns on: media-ingest reports
   * `nigerianLanguageSynthesis` UNCONDITIONALLY, and its absent-key state names
   * the specialist in `specialistProviderId` and again in `degradedReason`
   * ("no naijalingo credential is configured..."). So a box with NO key
   * contained the substring several times over and scored PASS -- telling the
   * founder that Yoruba, Hausa, Igbo and Pidgin were the real thing at exactly
   * the moment they were the degraded rendering.
   *
   * The structured field is the answer. `specialistConfigured` is a boolean the
   * service computes from whether the credential is present, and `preflight`
   * says whether that credential actually reached the vendor -- which is a
   * different question, because a key that is set but rejected falls through to
   * the same mispronouncing fallback as no key at all.
   *
   * WHAT A GREEN ROW STILL DOES NOT MEAN. That the specialist answered is not
   * that the Yoruba was good. Nothing here, and nothing on the server, can
   * establish that; only a speaker of the language listening to a sentence can.
   */
  for (const [languageCode, englishName] of NIGERIAN_LANGUAGES) {
    const row = list.find((entry) => entry?.language === languageCode);
    if (row === undefined) {
      note(`${englishName} (${languageCode}) is not offered by this deployment's catalogue at all.`);
      continue;
    }
    note(
      `${englishName} (${languageCode}): state=${row.state}, tts route=${row.providers?.tts ?? 'none'}, ` +
        `voice=${row.voiceAvailable === true ? 'yes' : 'no'}${row.reason ? ` — ${row.reason}` : ''}`,
    );
  }

  const nigerian = mediaHealth?.json?.nigerianLanguageSynthesis ?? null;
  if (nigerian === null || typeof nigerian !== 'object') {
    /*
     * Synthesis switched off entirely, or a build older than the field. Either
     * way this script cannot determine it and must not guess in the flattering
     * direction.
     */
    undetermined(
      'languages',
      'Nigerian-language specialist configured on this deployment',
      '/media/health carried no nigerianLanguageSynthesis (synthesis off, or an older build). ' +
        'Read the boot log line "9jaLingo preflight:". Until it is read, present ha/ig/yo/pcm ' +
        'as a DEGRADED rendering, never as native quality.',
    );
  } else {
    const configured = nigerian.specialistConfigured === true;
    check(
      'languages',
      'Nigerian-language specialist configured on this deployment',
      configured,
      configured
        ? `${nigerian.specialistProviderId ?? 'the specialist'} is configured for ${
            Array.isArray(nigerian.languages) ? nigerian.languages.join('/') : 'ha/ig/yo/pcm'
          }`
        : String(nigerian.degradedReason ?? `no specialist credential; ${nigerian.fallbackProviderId ?? 'the fallback'} speaks these languages and mispronounces them`),
    );

    /*
     * A SECOND ROW, because a key that is set is not a key that works. The
     * preflight is the only thing that has actually spoken to the vendor.
     */
    if (configured) {
      const preflight = nigerian.preflight ?? null;
      if (preflight === null || typeof preflight !== 'object') {
        undetermined(
          'languages',
          'the specialist credential reached the vendor',
          'the boot preflight has not reported yet; re-run in a moment, or read the boot log line "9jaLingo preflight:".',
        );
      } else {
        const speakers = preflight.speakerIdsByLanguage ?? {};
        const counts = (Array.isArray(nigerian.languages) ? nigerian.languages : ['ha', 'ig', 'yo', 'pcm'])
          .map((language) => `${language}=${(speakers[language] ?? []).length}`)
          .join(' ');
        check(
          'languages',
          'the specialist credential reached the vendor',
          preflight.reachable === true && preflight.problem == null,
          preflight.reachable === true
            ? `speakers ${counts}${preflight.problem == null ? '' : ` — ${preflight.problem}`}`
            : `NOT reachable — ${preflight.problem ?? 'unknown'}; ha/ig/yo/pcm fall to ${nigerian.fallbackProviderId ?? 'the fallback'}`,
        );
      }
    }

    /*
     * Degradation that has ALREADY BEEN HEARD. Distinct from the rows above: a
     * configured, reachable specialist can still have missed a sentence while
     * cold, and a listener heard the fallback speak it.
     */
    if (nigerian.degraded === true && configured) {
      check(
        'languages',
        'no Nigerian-language sentence has been served by the fallback',
        false,
        String(nigerian.degradedReason ?? `${nigerian.degradedSentences ?? 'some'} sentence(s) served by the fallback`),
      );
    }
    note(
      `Nigerian-language rendering so far: ${JSON.stringify(nigerian.renderingByLanguage ?? {})} ` +
        `(specialist=${nigerian.specialistSentences ?? 0}, degraded=${nigerian.degradedSentences ?? 0}). ` +
        'A "specialist" rendering means 9jaLingo answered -- NOT that the audio was right. ' +
        'Only a speaker of the language can establish that.',
    );
  }
}

// ==========================================================================
// 4. TURN — reachable, and NOT behind the ordinary Cloudflare proxy
// ==========================================================================
/*
 * MIRROR of deploy/lib/turn-guard.sh: Cloudflare's published IPv4 ranges, the
 * one permitted origin address, and the hostnames that are proxied by design.
 * The guard is a bash function sourced by the installer, and this script runs
 * on a workstation against a REMOTE origin, so the values are copied and named
 * as copies rather than shelled out to. A change belongs in both files until
 * the list has one home. Embedded rather than fetched for the same reason the
 * guard embeds it: the answer must not depend on outbound HTTP.
 */
const CLOUDFLARE_IPV4 = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];
const TURN_ORIGIN_IP = '169.58.215.77';
const TURN_FORBIDDEN_HOSTS = new Set([
  'consummate7.com',
  'www.consummate7.com',
  'staging.consummate7.com',
]);

const IPV4_SHAPE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipToInt(address) {
  const parts = IPV4_SHAPE.exec(address);
  if (parts === null) return null;
  let total = 0;
  for (let index = 1; index <= 4; index += 1) {
    const octet = Number(parts[index]);
    if (octet > 255) return null;
    total = total * 256 + octet;
  }
  return total;
}

function insideCloudflare(address) {
  const value = ipToInt(address);
  if (value === null) return false;
  return CLOUDFLARE_IPV4.some((cidr) => {
    const [network, bits] = cidr.split('/');
    const networkValue = ipToInt(network);
    if (networkValue === null) return false;
    const width = Number(bits);
    const mask = width === 0 ? 0 : (0xffffffff << (32 - width)) >>> 0;
    return ((value & mask) >>> 0) === ((networkValue & mask) >>> 0);
  });
}

async function checkTurn() {
  const ice = await get('/webrtc/ice');
  const servers = Array.isArray(ice.json?.iceServers) ? ice.json.iceServers : [];
  const urls = servers.flatMap((server) => (Array.isArray(server?.urls) ? server.urls : []));
  const turnUrls = urls.filter((url) => typeof url === 'string' && url.startsWith('turn:'));

  check(
    'turn',
    'the deployment issues a relay to browsers',
    ice.status === 200 && ice.json?.relayConfigured === true && turnUrls.length > 0,
    `${code(ice)}, relayConfigured=${ice.json?.relayConfigured}, ${turnUrls.length} turn url(s)`,
  );
  check(
    'turn',
    'the relay is offered over UDP and TCP',
    turnUrls.some((url) => url.includes('transport=udp')) && turnUrls.some((url) => url.includes('transport=tcp')),
    turnUrls.map((url) => url.replace(/^turn:/, '')).join(' ') || '(no relay offered)',
  );
  if (turnUrls.length === 0) return;

  /*
   * The credential is short-lived by construction: the TURN REST API username
   * IS the expiry, in unix seconds. Read it, subtract now, print the remaining
   * seconds. The value itself is never touched.
   */
  const relayServer = servers.find((server) =>
    (Array.isArray(server?.urls) ? server.urls : []).some((url) => String(url).startsWith('turn:')),
  );
  const expirySeconds = Number.parseInt(String(relayServer?.username ?? '').split(':')[0] ?? '', 10);
  const secondsRemaining = Number.isFinite(expirySeconds) ? expirySeconds - Math.floor(Date.now() / 1000) : NaN;
  check(
    'turn',
    'the relay credential is time-limited and still valid',
    Number.isFinite(secondsRemaining) && secondsRemaining > 0,
    Number.isFinite(secondsRemaining) ? `expires in ${secondsRemaining} s` : 'no parseable expiry',
  );

  // ---- the proxy guard
  const turnHost = /^turn:([^:?/]+)/.exec(turnUrls[0])?.[1] ?? '';
  if (TURN_FORBIDDEN_HOSTS.has(turnHost)) {
    check(
      'turn',
      'the relay is NOT behind the ordinary Cloudflare proxy',
      false,
      `${turnHost} is a proxied hostname by design; Cloudflare carries HTTP, not UDP 3478`,
    );
    return;
  }
  let addresses = [];
  if (IPV4_SHAPE.test(turnHost)) {
    addresses = [turnHost];
  } else {
    try {
      addresses = await resolve4(turnHost);
    } catch {
      addresses = [];
    }
  }
  if (addresses.length === 0) {
    check(
      'turn',
      'the relay is NOT behind the ordinary Cloudflare proxy',
      false,
      `${turnHost} does not resolve to an IPv4 address from here; an address this check cannot see is one it cannot clear`,
    );
    return;
  }
  const proxied = addresses.filter((address) => insideCloudflare(address));
  check(
    'turn',
    'the relay is NOT behind the ordinary Cloudflare proxy',
    proxied.length === 0,
    proxied.length === 0
      ? `${turnHost} -> ${addresses.join(' ')}${addresses.includes(TURN_ORIGIN_IP) ? ' (the known direct origin)' : ' (not Cloudflare; not the known origin)'}`
      : `${turnHost} -> ${proxied.join(' ')} is inside a Cloudflare range (orange cloud): grey-cloud it or use ${TURN_ORIGIN_IP}`,
  );
}

// ==========================================================================
// 5. Channels — the directory, a handle, and the page it opens
// ==========================================================================
async function checkChannels() {
  let io = null;
  try {
    ({ io } = await import('socket.io-client'));
  } catch {
    io = null;
  }
  if (io === null) {
    undetermined(
      'channels',
      'the channel directory lists a channel with a handle and an avatar',
      'socket.io-client is not installed in this checkout; run `npm install` at the repo root',
    );
    return null;
  }

  /*
   * There is no HTTP form of the directory, on purpose -- inventing one would
   * be a second source of truth -- so this connects a listener socket exactly
   * as the web and the phone do and reads the payload they read.
   */
  const directory = await new Promise((settle) => {
    const socket = io(origin, {
      query: { role: 'listener' },
      reconnection: false,
      timeout: 20_000,
      extraHeaders: { 'user-agent': USER_AGENT },
    });
    let timer = null;
    const finish = (value) => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      socket.removeAllListeners();
      socket.disconnect();
      settle(value);
    };
    timer = setTimeout(() => finish({ error: 'no channel:directory within 20 s' }), 20_000);
    socket.on('connect_error', (error) => finish({ error: `connect_error: ${error.message}` }));
    socket.on('channel:directory', (payload) => finish({ list: Array.isArray(payload) ? payload : null }));
  });

  if (directory.error !== undefined) {
    check('channels', 'the listener socket publishes the channel directory', false, directory.error);
    return null;
  }
  const list = directory.list ?? [];
  check(
    'channels',
    'the listener socket publishes the channel directory',
    Array.isArray(directory.list),
    `${list.length} channel(s)`,
  );

  const CHANNEL_HANDLE_SHAPE = /^[a-z0-9_]{3,24}$/;
  const named = list.filter((row) => typeof row?.handle === 'string' && CHANNEL_HANDLE_SHAPE.test(row.handle));
  const withAvatar = named.filter((row) => typeof row?.avatarUrl === 'string' && row.avatarUrl.trim().length > 0);
  check(
    'channels',
    'at least one listed channel has a handle (the demo needs /streams/<handle>)',
    named.length > 0,
    `${named.length} of ${list.length}: ${named.slice(0, 6).map((row) => `@${row.handle}`).join(' ') || '(none)'}`,
  );
  check(
    'channels',
    'at least one listed channel has an avatar (an empty card reads as unfinished)',
    withAvatar.length > 0,
    `${withAvatar.length} of ${named.length} named channel(s) carry an avatarUrl`,
  );
  if (named.length === 0) return null;

  const handle = (withAvatar[0] ?? named[0]).handle;

  const profile = await get(`/auth/streams/${encodeURIComponent(handle)}`);
  const keys = Object.keys(profile.json ?? {});
  check(
    'channels',
    `/auth/streams/${handle} resolves to a public profile`,
    profile.status === 200 && profile.json?.handle === handle && typeof profile.json?.channelId === 'string',
    `${code(profile)}, keys=${keys.sort().join(',') || '(none)'}`,
  );
  check(
    'channels',
    'the public profile carries no owner or account id',
    !keys.some((key) => /owner|account/i.test(key)),
    keys.sort().join(',') || '(none)',
  );

  /*
   * The channel PAGE, not the JSON behind it. It is served by the listener
   * bundle through the proxy's SPA fallback, so it must come back as the
   * listener shell -- a JSON 404 or a page whose script points elsewhere is
   * the blank-page failure with a different address.
   */
  const page = await get(`/streams/${encodeURIComponent(handle)}`);
  const pageScript = /<script[^>]+src="([^"]+)"/.exec(page.text)?.[1] ?? '';
  check(
    'channels',
    `/streams/${handle} serves the listener shell`,
    page.status === 200 && pageScript.startsWith('/listen/assets/'),
    `${code(page)}, script=${pageScript || '(none)'}`,
  );

  const publicCalls = await get('/calls/public');
  check(
    'channels',
    'the public conference listing answers',
    publicCalls.status === 200 && Array.isArray(publicCalls.json?.calls),
    `${code(publicCalls)}, ${publicCalls.json?.calls?.length ?? '?'} room(s)`,
  );

  note(`Demo channel: @${handle} — open ${origin}/streams/${handle}`);
  return handle;
}

// ==========================================================================
// 6. The operator console, and the guard in front of programme control
// ==========================================================================
async function checkOperator() {
  /*
   * AUTH MUST BE CHECKED BEFORE EXISTENCE. A 404 for a well-formed but
   * non-existent session id would mean there is no authentication layer at
   * all, and that knowing a session id is the only thing protecting a live
   * programme. 401/403 is the correct answer to an anonymous caller.
   */
  const fakeSession = 'ps_00000000-0000-0000-0000-000000000000';
  const pause = await get(`/media/sessions/${fakeSession}/pause`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  check(
    'operator',
    'programme control demands authentication before existence',
    pause.status === 401 || pause.status === 403,
    `${code(pause)} (expected 401/403; a 404 would mean no auth layer)`,
  );
}

// ==========================================================================
// 7. One deployed build behind every surface
// ==========================================================================
/**
 * Ask each service what it is running. Nothing publishes a commit today, so
 * this reports BLOCKED rather than inventing agreement -- three services that
 * never state a build cannot be shown to agree, and a check that passes on
 * silence is the failure mode this project hunts.
 */
const SHA_FIELDS = ['sha', 'commit', 'commitSha', 'gitSha', 'revision', 'build', 'buildSha'];
const SHA_SHAPE = /^[0-9a-f]{7,40}$/;

function readSha(body) {
  if (body === null || typeof body !== 'object') return null;
  for (const field of SHA_FIELDS) {
    const value = body[field];
    if (typeof value === 'string' && SHA_SHAPE.test(value)) return value;
  }
  return null;
}

async function checkBuild() {
  const probes = [
    ['gateway', '/health'],
    ['media-ingest', '/media/health'],
    ['account', '/auth/health'],
  ];
  const found = [];
  const silent = [];
  for (const [service, path] of probes) {
    const response = await get(path);
    const sha = readSha(response.json);
    if (sha === null) silent.push(service);
    else found.push([service, sha]);
  }
  if (found.length === 0) {
    undetermined(
      'build',
      'account, gateway and media-ingest report the same deployed SHA',
      `no endpoint publishes a build id (${silent.join(', ')}); compare by hand with ` +
        '`ssh c7-claude "git -C /srv/videofy/app rev-parse --short HEAD"` against your local HEAD',
    );
    return;
  }
  const distinct = new Set(found.map(([, sha]) => sha));
  check(
    'build',
    'every service that reports a build reports the SAME one',
    distinct.size === 1,
    found.map(([service, sha]) => `${service}=${sha}`).join(' '),
  );
  if (silent.length > 0) {
    undetermined(
      'build',
      'every service reports a build id',
      `${silent.join(', ')} publish none, so agreement is partial`,
    );
  }
}

// ==========================================================================
// run
// ==========================================================================
console.log(`Videofy Live — demo readiness against ${origin}\n`);

const mediaHealth = await checkServices();
await checkSurfaces();
await checkLanguages(mediaHealth);
await checkTurn();
await checkChannels();
await checkOperator();
await checkBuild();

// ------------------------------------------------------------------- output
const width = Math.min(76, Math.max(...rows.map((row) => row.name.length)));
let lastGroup = null;
for (const row of rows) {
  if (row.group !== lastGroup) {
    console.log(`\n${row.group.toUpperCase()}`);
    lastGroup = row.group;
  }
  console.log(`  ${row.outcome.padEnd(7, ' ')} ${row.name.padEnd(width, ' ')}  ${row.detail}`);
}

if (notes.length > 0) {
  console.log('\nWHAT CAN BE DEMONSTRATED, HONESTLY');
  for (const line of notes) console.log(`  · ${line}`);
  console.log(
    '  · A language reported `limited` or `unavailable` may still return audio.\n' +
      '    That is not evidence it is right: the general vendors answer 200 with a\n' +
      '    multilingual voice reading unfamiliar orthography. Show those as\n' +
      '    captions, or say the word "degraded" out loud before playing them.',
  );
}

const passed = rows.length - failed - blocked;
console.log(
  `\n${passed}/${rows.length} checks passed — ${failed} failed, ${blocked} could not be determined`,
);
if (blocked > 0 && !strict) {
  console.log(
    'A BLOCKED check is not a pass. Each one has a by-hand fallback in docs/INVESTOR_DEMO_RUNBOOK.md;\n' +
      'run with --strict to make them fail this command.',
  );
}
const blockedFails = strict && blocked > 0;
if (failed === 0 && !blockedFails) {
  console.log('READY — every checked dependency of the runbook holds.');
} else {
  console.log('NOT READY — fix the FAIL rows above before the presentation.');
}
process.exit(failed === 0 && !blockedFails ? 0 : 1);
