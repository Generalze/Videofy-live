// Videofy Live — Viewer Page visual capture.
//
// Produces the screenshots the owner's viewer acceptance gate asks for.
//
// HONEST SCOPE, because this is the kind of claim that is easy to overstate:
//   * The browser is Microsoft Edge (Chromium), driven through playwright-core.
//     Chrome is not installed on this machine. Layout and CSS resolution are
//     the same engine, but this is NOT literally Chrome, and the owner's
//     "real Chrome" pass remains theirs to run.
//   * No gateway is running, so the Viewer is captured in its pre-connection
//     states. That exercises the header, language control, stage framing,
//     status banner, settings sheet and the mobile stack — it does not
//     exercise a live programme, captions in flight, or translated audio.
//
// Usage:
//   npm run build -w apps/listener-web
//   npx vite preview --config apps/listener-web/vite.config.ts --port 4319
//   node scripts/viewer-screenshots.mjs
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL = process.env['VIEWER_URL'] ?? 'http://localhost:4319/';
const OUT = '.videofy-screenshots';

/** The viewports that matter: a laptop, and the phone a link gets opened on. */
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1024, height: 720 },
  { name: 'mobile', width: 390, height: 844, isMobile: true },
];

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EDGE });

  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      await page.goto(URL, { waitUntil: 'networkidle' });
      // The Viewer settles into its pre-connection state after the socket
      // attempt fails; capturing before that shows a frame nobody ever sees.
      await page.waitForTimeout(1500);

      await page.screenshot({ path: `${OUT}/viewer-${viewport.name}.png`, fullPage: true });
      console.log(`captured ${viewport.name} (${viewport.width}x${viewport.height})`);

      // The settings sheet open, since a closed disclosure proves nothing about
      // what is inside it.
      const summary = page.locator('summary', { hasText: 'Audio & captions' }).first();
      if (await summary.count()) {
        await summary.click();
        await page.waitForTimeout(400);
        await page.screenshot({
          path: `${OUT}/viewer-${viewport.name}-settings.png`,
          fullPage: true,
        });
        console.log(`captured ${viewport.name} settings sheet`);
      }

      // Horizontal overflow is the classic mobile failure and is measurable
      // rather than a matter of taste, so it is asserted instead of eyeballed.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      console.log(`${viewport.name} horizontal overflow: ${overflow}px`);
      if (overflow > 0) {
        console.error(`FAIL: ${viewport.name} scrolls sideways by ${overflow}px`);
        process.exitCode = 1;
      }

      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`\nScreenshots in ${OUT}/ — Edge/Chromium, pre-connection states only.`);
}

await main();
