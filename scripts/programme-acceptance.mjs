/**
 * Programme-path smoke against deployed staging.
 *
 * Confirms the gateway accepts and registers the two programme roles, and that
 * the viewer receives programme state. Media for a programme needs an actual
 * source, so this checks the SIGNALLING surface rather than claiming audio.
 */
import { io } from 'socket.io-client';

const BASE = process.argv[2] ?? 'https://staging.consummate7.com';

function connectAs(role) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, {
      query: { role },
      transports: ['websocket'],
      reconnection: false,
      timeout: 15000,
    });
    const timer = setTimeout(() => reject(new Error(`${role}: timeout`)), 15000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** Collect any events this socket receives for a short window. */
function collect(socket, ms = 4000) {
  const seen = new Map();
  socket.onAny((event) => seen.set(event, (seen.get(event) ?? 0) + 1));
  return new Promise((resolve) => setTimeout(() => resolve(seen), ms));
}

let failures = 0;
function record(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log(`Programme path against ${BASE}\n`);

for (const role of ['listener', 'operator']) {
  try {
    const socket = await connectAs(role);
    record(`${role} socket accepted`, true, `transport=${socket.io.engine.transport.name}`);
    const seen = await collect(socket);
    const events = [...seen.keys()];
    record(
      `${role} receives programme state on connect`,
      events.length > 0,
      events.length > 0 ? events.join(', ') : 'no events within 4s',
    );
    socket.close();
  } catch (error) {
    record(`${role} socket accepted`, false, String(error?.message ?? error));
  }
}

console.log(`\n${failures === 0 ? 'programme signalling OK' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
