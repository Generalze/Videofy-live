#!/usr/bin/env node
/**
 * Does the call surface actually fit on a phone?
 *
 *   node scripts/check-call-layout.mjs
 *
 * WHY THIS EXISTS. The call screen is a fixed-height grid -- `100dvh` with
 * `overflow: hidden` -- whose last row is the control bar. Anything that makes
 * the rows above it taller (a wrapping row of buttons, a caption panel, a long
 * call title) pushes the control bar past the bottom edge, where `overflow:
 * hidden` silently clips it. Nothing errors. The page looks fine. The Leave
 * button simply is not there, and a participant has no way to end the call.
 *
 * Unit tests cannot see this: jsdom has no layout engine, so every element it
 * reports is zero by zero and always "present". This renders the REAL
 * component with the REAL stylesheet in a REAL browser at phone size and asks
 * where things landed.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// A small modern phone. Narrower than most, which is the point: if it fits
// here it fits on the devices people actually hold.
const VIEWPORT = { width: 390, height: 844 };

const viewports = [
  { label: 'iPhone-sized (390x844)', ...VIEWPORT },
  { label: 'small Android (360x800)', width: 360, height: 800 },
];

/**
 * Inlines the whole stylesheet, following @import by hand.
 *
 * index.css opens with `@import '@videofy-live/design-system/base.css'`, a
 * bare package specifier that Vite resolves at build time and a browser cannot
 * resolve at all. Dropping the file into a <style> tag unresolved silently
 * measures the app WITHOUT its reset or design tokens -- which is a different
 * page from the one that ships, and produces confident numbers about a layout
 * nobody will ever see.
 */
function loadStylesheet() {
  const seen = new Set();
  const read = (url) => {
    const key = url.href;
    if (seen.has(key)) return '';
    seen.add(key);
    const source = readFileSync(url, 'utf8');
    return source.replace(/@import\s+['"]([^'"]+)['"]\s*;/g, (_match, specifier) => {
      const resolved = specifier.startsWith('@videofy-live/design-system/')
        ? new URL(
            `../packages/design-system/src/${specifier.split('/').pop()}`,
            import.meta.url,
          )
        : new URL(specifier, url);
      return read(resolved);
    });
  };
  const css = read(new URL('../apps/call-web/src/index.css', import.meta.url));
  if (!css.includes('box-sizing')) {
    throw new Error('stylesheet inlining failed: the reset is missing, measurements would lie');
  }
  return css;
}

async function renderCallScreenHtml(variant) {
  // Rendered through the app's own toolchain so the markup is the component's,
  // not an approximation maintained by hand in this script.
  const { renderToStaticMarkup } = await import('react-dom/server');
  const React = await import('react');
  const { CallScreen } = await import('../apps/call-web/src/CallScreen.tsx');

  const participant = (id, name, speak, hear) => ({
    participantId: id,
    displayName: name,
    speakLanguage: speak,
    hearLanguage: hear,
    joined: true,
  });
  const noop = () => {};

  return renderToStaticMarkup(
    React.createElement(CallScreen, {
      callCode: 'calm-river-42',
      selfParticipantId: 'p1',
      // Four people: the conference case, where the stage is fullest.
      participants: [
        participant('p1', 'Alice', 'en', 'en'),
        participant('p2', 'Bruno', 'fr', 'fr'),
        participant('p3', 'Chidi', 'en', 'en'),
        participant('p4', 'Dmitri', 'es', 'es'),
      ],
      phase: 'connected',
      statusNote: null,
      playbackBlocked: false,
      translatedAudioUnavailable: false,
      remoteSpeakers: [],
      captions: [],
      captionsVisible: true,
      audioMode: 'translated',
      originalVolume: 0.4,
      translatedVolume: 1,
      micMuted: false,
      callType: variant.callType,
      isOwner: variant.isOwner,
      onToggleMute: noop,
      onToggleCaptions: noop,
      onCaptionLanguageChange: noop,
      captionLanguageBusy: false,
      onAudioModeChange: noop,
      onOriginalVolumeChange: noop,
      onTranslatedVolumeChange: noop,
      onEnableAudio: noop,
      onCallModeChange: noop,
      onLeave: noop,
      onEndCall: noop,
    }),
  );
}

// --dump-dom cannot run our probe, so measurement goes through the DevTools
// protocol: launch with remote debugging, set a true phone viewport with
// Emulation.setDeviceMetricsOverride, then evaluate.
async function measureViaCdp(html, viewport) {
  const dir = mkdtempSync(join(tmpdir(), 'call-layout-'));
  const page = join(dir, 'page.html');
  const css = loadStylesheet();
  writeFileSync(
    page,
    `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style></head><body><div id="root">${html}</div></body></html>`,
  );

  const userDataDir = mkdtempSync(join(tmpdir(), 'edge-profile-'));
  const port = 9333 + Math.floor(viewport.width % 50);
  const child = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    let target = null;
    for (let attempt = 0; attempt < 40 && !target; attempt += 1) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch {
        /* not up yet */
      }
    }
    if (!target) throw new Error('Edge did not expose a debugging target');

    const { default: WebSocket } = await import('ws').catch(() => ({ default: null }));
    if (!WebSocket) throw new Error('ws module unavailable');

    const socket = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((resolve, reject) => {
      socket.on('open', resolve);
      socket.on('error', reject);
    });

    let id = 0;
    const pending = new Map();
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const messageId = ++id;
        pending.set(messageId, resolve);
        socket.send(JSON.stringify({ id: messageId, method, params }));
      });

    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await send('Page.navigate', { url: pathToFileURL(page).href });
    await new Promise((r) => setTimeout(r, 1200));

    const probe = `(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
      };
      // Whichever control this variant offers for getting out of the call.
      const labels = ['leave', 'end call', 'end for everyone'];
      const candidates = [...document.querySelectorAll('button')].filter(
        (b) => labels.includes(b.textContent.trim().toLowerCase()));
      const leave = candidates[candidates.length - 1];
      const r = leave && leave.getBoundingClientRect();
      return JSON.stringify({
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        controlBar: box('.control-bar'),
        stage: box('.call-stage'),
        captions: box('.captions'),
        leaveButton: r ? { top: Math.round(r.top), bottom: Math.round(r.bottom) } : null,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      });
    })()`;
    const response = await send('Runtime.evaluate', { expression: probe, returnByValue: true });
    socket.close();
    return JSON.parse(response.result.result.value);
  } finally {
    child.kill();
  }
}

/**
 * The chairman's conference carries the most controls of any call, so it is
 * the variant that runs out of room first; the personal call is the one most
 * people are actually in. Both have to fit.
 */
const variants = [
  { label: 'conference (chairman)', callType: 'conference', isOwner: true },
  { label: 'personal call', callType: 'personal', isOwner: false },
];

let failures = 0;
for (const variant of variants) {
 const html = await renderCallScreenHtml(variant);
 for (const viewport of viewports) {
  const m = await measureViaCdp(html, viewport);
  console.log(`\n${variant.label} — ${viewport.label}`);
  console.log(`  viewport            ${m.viewportWidth}x${m.viewportHeight}`);
  console.log(`  control bar         top ${m.controlBar?.top}, bottom ${m.controlBar?.bottom}`);
  console.log(`  exit control        ${m.leaveButton ? `top ${m.leaveButton.top}, bottom ${m.leaveButton.bottom}` : 'NOT RENDERED'}`);

  const visible =
    m.leaveButton !== null &&
    m.leaveButton.bottom <= m.viewportHeight &&
    m.leaveButton.top >= 0;
  if (!visible) {
    failures += 1;
    console.log(
      `  FAIL  the exit control is off-screen — no way to leave or end the call.`,
    );
  } else {
    console.log('  PASS  exit control is on screen');
  }

  if (m.horizontalOverflow) {
    failures += 1;
    console.log('  FAIL  the page scrolls sideways — content is cut off at the edge');
  } else {
    console.log('  PASS  no horizontal overflow');
  }
 }
}

console.log(failures === 0 ? '\ncall layout fits\n' : `\n${failures} layout failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
