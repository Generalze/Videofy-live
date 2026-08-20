#!/usr/bin/env node
/** @author masterzee001 */
/**
 * P6.9 LOCAL MULTI-PROCESS ACCEPTANCE
 *
 * Everything before this proved COMPOSITION: real objects, real protocol, real
 * bytes — but one process, and a loopback transport standing in for a network.
 * That is a genuine result and it is not the same claim as this one.
 *
 * This launches THREE ACTUAL PROCESSES and puts a telephone call through them:
 *
 *     real UDP
 *        |
 *     sip-runtime process          separate OS process, own sockets
 *        |  real WebSocket over TCP, service credential on the upgrade
 *        v
 *     realtime-gateway process     separate OS process
 *        |  real HTTP
 *        v
 *     media-ingest process         separate OS process
 *
 * IT IMPORTS NOTHING FROM THE SYSTEM UNDER TEST. Not the authority, not the
 * binding, not the wire codec, not `SipCall`. It speaks SIP and RTP as bytes on
 * a socket, exactly as a softphone would, and observes the result through the
 * gateway's own diagnostics endpoint over HTTP. If it imported the classes it
 * is checking, it would be an integration test wearing a deployment costume.
 *
 * WHAT THIS PROVES: the services start from configuration alone, find each
 * other over real transports, authenticate, and carry audio from a UDP datagram
 * to the media pipeline — and then shut down cleanly on SIGTERM.
 *
 * WHAT THIS DOES NOT PROVE: interoperability with a third-party SIP stack, TLS
 * termination, NAT traversal, or that STT produced sensible text. The first
 * three arrive with the VPS; the last is a different subsystem with its own
 * suites and its own models, and asserting on it here would make this script
 * fail for reasons that have nothing to do with deployment.
 */
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const ROOT = process.cwd();
const workDir = mkdtempSync(join(tmpdir(), 'videofy-p69-acceptance-'));
const children = [];
const sockets = [];
let failures = 0;
let deferred = 0;

function skip(label, why) {
  say(`  SKIP  ${label}  (${why})`);
  deferred += 1;
}

/**
 * Can this platform deliver SIGTERM to a child process at all?
 *
 * PROBED, not assumed from `process.platform`. On Windows `child.kill('SIGTERM')`
 * is an unconditional TerminateProcess: the handler never runs, so a graceful
 * shutdown check there measures the operating system rather than the service,
 * and would fail forever for a reason that has nothing to do with the code.
 *
 * Reporting that as a PASS would be a lie; reporting it as a FAIL would be
 * noise. So it is reported as DEFERRED, with the platform named. The ORDER and
 * BOUNDS of the drain are proved by the sip-runtime lifecycle suite; what is
 * deferred here is only whether the SIGNAL arrives, and that is verified on
 * Linux, which is where this actually deploys.
 */
function sigtermIsDeliverable() {
  return new Promise((resolve) => {
    const probe = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"],
      { stdio: 'ignore' },
    );
    probe.on('exit', (code) => resolve(code === 0));
    setTimeout(() => probe.kill('SIGTERM'), 400);
  });
}

const SERVICE_TOKEN = randomBytes(24).toString('hex');
const INTERNAL_TOKEN = randomBytes(24).toString('hex');
const ROUTE_SECRET = randomBytes(24).toString('hex');
const ROUTE_ID = 'r_sip_acceptance';
const DIALLED = '441234567890';
const ROUTE_REF = 'route_acceptance';

const GATEWAY_PORT = 3311;
const INGEST_PORT = 3312;
const SIP_PORT = 35060;

function say(message) {
  process.stdout.write(`${message}\n`);
}

function check(label, ok, detail = '') {
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start one service, capturing its output so failures are diagnosable. */
function start(name, cwd, entry, env) {
  const child = spawn(process.execPath, [entry], {
    cwd: join(ROOT, cwd),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  const collect = (chunk) => {
    for (const line of String(chunk).split('\n')) if (line.trim() !== '') lines.push(line);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const record = { name, child, lines, exited: null };
  child.on('exit', (code, signal) => {
    record.exited = { code, signal };
  });
  children.push(record);
  return record;
}

/**
 * Poll until a service answers.
 *
 * EVERY REQUEST IS BOUNDED, and that is not incidental. media-ingest blocks its
 * event loop for about twenty seconds warming AI providers at startup: the TCP
 * listener is already accepting, so a bare `await fetch` connects and then
 * hangs until the loop frees up. One hung request with no timeout stalls this
 * whole poll loop past its own deadline, and the service is then reported down
 * while it is demonstrably logging that it is up. Which is exactly what
 * happened the first time this script ran.
 */
async function waitForHealth(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return true;
    } catch {
      /* not up yet, or busy starting */
    }
    await sleep(250);
  }
  return false;
}

async function waitFor(predicate, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

// --- SIP and RTP, written by hand so nothing under test is imported ---------

function sipSocket() {
  const socket = createSocket('udp4');
  sockets.push(socket);
  const received = [];
  socket.on('message', (datagram) => received.push(datagram.toString('utf8')));
  return { socket, received };
}

function bindTo(socket, port = 0) {
  return new Promise((resolve) => socket.bind(port, '127.0.0.1', () => resolve(socket.address().port)));
}

function inviteText(callId, fromPort, rtpPort) {
  const lines = [
    `v=0`,
    `o=acceptance 1 1 IN IP4 127.0.0.1`,
    `s=acceptance`,
    `c=IN IP4 127.0.0.1`,
    `t=0 0`,
    `m=audio ${rtpPort} RTP/AVP 0`,
    `a=rtpmap:0 PCMU/8000`,
    ``,
  ].join('\r\n');
  return [
    `INVITE sip:${DIALLED}@127.0.0.1 SIP/2.0`,
    `Via: SIP/2.0/UDP 127.0.0.1:${fromPort};branch=z9hG4bK-${callId}`,
    `From: "Acceptance" <sip:tester@127.0.0.1>;tag=t-${callId}`,
    `To: <sip:${DIALLED}@127.0.0.1>`,
    `Call-ID: ${callId}`,
    `CSeq: 1 INVITE`,
    `Content-Type: application/sdp`,
    `Content-Length: ${Buffer.byteLength(lines)}`,
    ``,
    lines,
  ].join('\r\n');
}

function simpleRequest(method, callId, fromPort, cseq) {
  return [
    `${method} sip:${DIALLED}@127.0.0.1 SIP/2.0`,
    `Via: SIP/2.0/UDP 127.0.0.1:${fromPort};branch=z9hG4bK-${callId}-${method}`,
    `From: "Acceptance" <sip:tester@127.0.0.1>;tag=t-${callId}`,
    `To: <sip:${DIALLED}@127.0.0.1>`,
    `Call-ID: ${callId}`,
    `CSeq: ${cseq} ${method}`,
    `Content-Length: 0`,
    ``,
    ``,
  ].join('\r\n');
}

/** G.711 mu-law, written here rather than imported: the codec is under test. */
function muLawEncode(sample) {
  const BIAS = 0x84;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > 32635) sample = 32635;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent -= 1, mask >>= 1);
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function rtpPacket(sequence, timestamp, payload) {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = 0x00; // PCMU
  header.writeUInt16BE(sequence & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(0x0acce55, 8);
  return Buffer.concat([header, payload]);
}

/** 20 ms of 440 Hz tone at 8 kHz, companded. */
function toneFrame(index) {
  const payload = Buffer.alloc(160);
  for (let n = 0; n < 160; n += 1) {
    const t = (index * 160 + n) / 8000;
    payload[n] = muLawEncode(Math.round(Math.sin(2 * Math.PI * 440 * t) * 12000));
  }
  return payload;
}

function statusOf(message) {
  const match = /^SIP\/2\.0 (\d{3})/.exec(message);
  return match ? Number(match[1]) : null;
}

async function cleanup() {
  for (const socket of sockets) {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }
  for (const record of children) {
    if (record.exited === null) record.child.kill('SIGKILL');
  }
  await sleep(200);
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

async function main() {
  say('\nP6.9 LOCAL MULTI-PROCESS ACCEPTANCE');
  say('='.repeat(64));

  const policyPath = join(workDir, 'adapter-routes.json');
  writeFileSync(
    policyPath,
    JSON.stringify(
      {
        adapters: [
          { id: ROUTE_ID, adapterId: 'sip-acceptance', routes: [ROUTE_REF], secretEnv: 'SIP_ROUTE_SECRET' },
        ],
        routes: { [ROUTE_REF]: { targetLanguages: ['es'], sourceLanguage: 'en' } },
      },
      null,
      2,
    ),
    'utf8',
  );

  const stagingDir = join(workDir, 'staging');

  say('\n[1] starting three separate processes');
  const ingest = start(
    'media-ingest',
    'services/media-ingest',
    // Its tsconfig emits with a monorepo-spanning rootDir, so the entry is
    // nested rather than at dist/index.js.
    'dist/services/media-ingest/src/index.js',
    {
    INGEST_PORT: String(INGEST_PORT),
    // media-ingest holds a socket.io connection back to the gateway and reports
    // /health as 503 "degraded" until it is up. Pointing it at the real gateway
    // is not a workaround for the check: a deployment where these two cannot
    // find each other IS broken, and the health endpoint is right to say so.
    GATEWAY_URL: `http://127.0.0.1:${GATEWAY_PORT}`,
    INTERNAL_WEBRTC_TOKEN: INTERNAL_TOKEN,
    SESSION_SECRET: randomBytes(24).toString('hex'),
    WEBRTC_AUDIO_CHUNK_STAGING_DIR: stagingDir,
    LOG_LEVEL: 'info',
    },
  );
  const gateway = start('realtime-gateway', 'services/realtime-gateway', 'dist/index.js', {
    GATEWAY_PORT: String(GATEWAY_PORT),
    GATEWAY_HOST: '127.0.0.1',
    INTERNAL_WEBRTC_TOKEN: INTERNAL_TOKEN,
    ADAPTER_SERVICE_TOKEN: SERVICE_TOKEN,
    ADAPTER_ROUTE_POLICY_PATH: policyPath,
    SIP_ROUTE_SECRET: ROUTE_SECRET,
    MEDIA_INGEST_URL: `http://127.0.0.1:${INGEST_PORT}`,
    WEBRTC_TRANSCRIPTION_CHUNK_MS: '1000',
    WEBRTC_TRANSCRIPTION_STAGING_DIR: stagingDir,
    WEBRTC_DIAGNOSTICS_ENABLED: 'true',
    WEBRTC_VAD_ENABLED: 'false',
    LOG_LEVEL: 'info',
  });

  const ingestUp = await waitForHealth(`http://127.0.0.1:${INGEST_PORT}/health`);
  check('media-ingest process is listening', ingestUp);
  const gatewayUp = await waitForHealth(`http://127.0.0.1:${GATEWAY_PORT}/health`);
  check('realtime-gateway process is listening', gatewayUp);
  if (!ingestUp || !gatewayUp) {
    say('\n--- media-ingest output ---');
    say(ingest.lines.slice(-25).join('\n'));
    say('\n--- gateway output ---');
    say(gateway.lines.slice(-25).join('\n'));
    return;
  }
  check(
    'the gateway provisioned its adapter from configuration alone',
    gateway.lines.some((line) => line.includes('Adapter ingress enabled')),
  );

  const sip = start('sip-runtime', 'services/sip-runtime', 'dist/index.js', {
    ADAPTER_SERVICE_TOKEN: SERVICE_TOKEN,
    SIP_ROUTE_CREDENTIAL: `vfr_${ROUTE_ID}.${ROUTE_SECRET}`,
    GATEWAY_ADAPTER_CONTROL_URL: `http://127.0.0.1:${GATEWAY_PORT}/internal/adapter/v1`,
    GATEWAY_ADAPTER_MEDIA_URL: `ws://127.0.0.1:${GATEWAY_PORT}/internal/adapter/v1/media`,
    SIP_ADVERTISED_ADDRESS: '127.0.0.1',
    SIP_HOST: '127.0.0.1',
    SIP_PORT: String(SIP_PORT),
    SIP_RTP_PORT_MIN: '35100',
    SIP_RTP_PORT_MAX: '35120',
    SIP_ROUTE_MAP: JSON.stringify({ [DIALLED]: ROUTE_REF }),
    LOG_LEVEL: 'info',
  });
  const sipUp = await waitFor(
    async () => sip.lines.some((line) => line.includes('SIP runtime started')),
    30_000,
  );
  check('sip-runtime process started', sipUp);
  if (!sipUp) {
    say('\n--- sip-runtime output ---');
    say(sip.lines.slice(-25).join('\n'));
    return;
  }

  say('\n[2] a real SIP call over real UDP');
  const signalling = sipSocket();
  const signallingPort = await bindTo(signalling.socket);
  const media = sipSocket();
  const mediaPort = await bindTo(media.socket);
  const callId = `acceptance-${randomBytes(4).toString('hex')}`;

  signalling.socket.send(
    Buffer.from(inviteText(callId, signallingPort, mediaPort)),
    SIP_PORT,
    '127.0.0.1',
  );
  const answered = await waitFor(
    async () => signalling.received.some((message) => statusOf(message) === 200),
    20_000,
  );
  check('the call was answered with 200 OK', answered);
  if (!answered) {
    say(`  responses seen: ${JSON.stringify(signalling.received)}`);
    say('\n--- sip-runtime output ---');
    say(sip.lines.slice(-25).join('\n'));
    return;
  }

  const ok = signalling.received.find((message) => statusOf(message) === 200);
  const advertised = /m=audio (\d+) RTP\/AVP 0/.exec(ok ?? '');
  check('the answer advertises a real RTP port', advertised !== null, advertised?.[1] ?? '');
  check('the answer advertises the configured address', (ok ?? '').includes('c=IN IP4 127.0.0.1'));

  signalling.socket.send(Buffer.from(simpleRequest('ACK', callId, signallingPort, 1)), SIP_PORT, '127.0.0.1');

  say('\n[3] real RTP into the runtime, across two more process boundaries');
  const targetRtpPort = Number(advertised?.[1] ?? 0);
  // Two seconds of speech-shaped audio, paced as a phone would send it, so the
  // gateway's chunker reaches its 1000 ms boundary more than once.
  for (let index = 0; index < 100; index += 1) {
    media.socket.send(
      rtpPacket(1000 + index, 160000 + index * 160, toneFrame(index)),
      targetRtpPort,
      '127.0.0.1',
    );
    if (index % 10 === 9) await sleep(20);
  }
  await sleep(500);

  const diagnostics = async () => {
    try {
    const response = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/internal/diagnostics`, {
      headers: { 'X-Videofy-Internal-Token': INTERNAL_TOKEN },
      signal: AbortSignal.timeout(2_000),
    });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  };

  const reached = await waitFor(async () => {
    const state = await diagnostics();
    return (state?.transcriptionBridgeSessionCount ?? 0) >= 1;
  }, 20_000);
  // Observed through the gateway's OWN HTTP surface. Nothing internal is
  // imported to see it.
  check('adapter audio reached the media pipeline in the gateway process', reached);
  if (!reached) {
    say('\n--- gateway output ---');
    say(gateway.lines.slice(-30).join('\n'));
  }

  const submitted = await waitFor(
    async () => ingest.lines.some((line) => line.includes('adaptercast_')),
    25_000,
  );
  // The final hop. media-ingest is a separate process reached over real HTTP,
  // and the broadcast id it names could only have come from an adapter session.
  check('media-ingest received the adapter session over HTTP', submitted);
  if (!submitted) {
    say('\n--- media-ingest output (last 30) ---');
    say(ingest.lines.slice(-30).join('\n'));
  }

  say('\n[4] hanging up');
  signalling.socket.send(
    Buffer.from(simpleRequest('BYE', callId, signallingPort, 2)),
    SIP_PORT,
    '127.0.0.1',
  );
  const byeAnswered = await waitFor(
    async () => signalling.received.filter((message) => statusOf(message) === 200).length >= 2,
    10_000,
  );
  check('the hangup was acknowledged', byeAnswered);

  say('\n[5] SIGTERM produces a real teardown, not a killed process');
  const canSignal = await sigtermIsDeliverable();
  for (const record of [sip, gateway, ingest]) {
    record.child.kill('SIGTERM');
  }
  const allExited = await waitFor(async () => children.every((record) => record.exited !== null), 25_000);
  check('every process terminated', allExited);

  if (!canSignal) {
    skip(
      'processes drain gracefully on SIGTERM',
      `${process.platform} cannot deliver SIGTERM to a child; verify on Linux`,
    );
    return;
  }
  if (allExited) {
    for (const record of children) {
      check(
        `${record.name} exited cleanly`,
        record.exited.code === 0,
        `code=${record.exited.code} signal=${record.exited.signal}`,
      );
    }
    check(
      'sip-runtime drained in order rather than dying',
      sip.lines.some((line) => line.includes('SIP runtime stopped')),
    );
  }
}

main()
  .catch((error) => {
    failures += 1;
    say(`\nUNEXPECTED FAILURE: ${error instanceof Error ? error.stack : String(error)}`);
  })
  .finally(async () => {
    await cleanup();
    say('\n' + '='.repeat(64));
    if (failures === 0) {
      say(
        deferred === 0
          ? 'P6.9 LOCAL MULTI-PROCESS E2E: PASS'
          : `P6.9 LOCAL MULTI-PROCESS E2E: PASS (${deferred} check(s) deferred to Linux)`,
      );
      say('Three real processes, real UDP, real WebSocket, real HTTP.');
      say('NOT proved here: third-party SIP interop, TLS, NAT, or STT output.');
    } else {
      say(`P6.9 LOCAL MULTI-PROCESS E2E: FAIL (${failures} check(s))`);
    }
    process.exit(failures === 0 ? 0 : 1);
  });
