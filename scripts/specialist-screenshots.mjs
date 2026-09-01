#!/usr/bin/env node
/** @author masterzee001 */
/**
 * Capture the Language Specialist surfaces at the four audit widths.
 *
 * HONEST SCOPE, because this is the kind of claim that is easy to overstate:
 *   * The browser is Microsoft Edge (Chromium), driven through playwright-core.
 *     Chrome is not installed on this machine. Layout and CSS resolution are the
 *     same engine, but this is NOT literally Chrome, and a "real Chrome" pass
 *     remains somebody else's to run. The viewer capture script says the same.
 *   * The pages are captured against a REAL account service with a real session
 *     and real submitted data. Nothing here is a fixture rendered into a static
 *     page: the portal screenshots are of the application talking to the API.
 *   * The operator console requires a VERIFIED account on the platform operator
 *     allowlist. This script does not verify anybody and does not add a bypass;
 *     `--operator-token` accepts a session for an account the deployment has
 *     already made an operator, and without it the operator captures are of the
 *     refusal screen, which is itself worth having.
 *
 * Usage (see docs/LANGUAGE_SPECIALIST_PORTAL.md for the full run sheet):
 *   node scripts/specialist-screenshots.mjs \
 *     --site http://localhost:4330 --operator http://localhost:4331 \
 *     --account http://localhost:3006
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = '.specialist-screenshots';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const SITE = arg('site', 'http://localhost:4330').replace(/\/$/, '');
const OPERATOR = arg('operator', 'http://localhost:4331').replace(/\/$/, '');
const ACCOUNT = arg('account', 'http://localhost:3006').replace(/\/$/, '');

/**
 * The four widths the audit names.
 *
 * 390 is a phone, 768 a tablet portrait, 1024 a laptop and 1440 a desktop.
 * Every one of them is a width at which a real person opens this, and the
 * portal has two structural changes between them -- the rail becomes a top bar
 * at 1024, and the paired fields stack at 768 -- so all four are load-bearing
 * rather than a sample.
 */
const VIEWPORTS = [
  { name: '390', width: 390, height: 844, isMobile: true },
  { name: '768', width: 768, height: 1024 },
  { name: '1024', width: 1024, height: 768 },
  { name: '1440', width: 1440, height: 900 },
];

/** A throwaway account, created through the real sign-up route. */
async function seed() {
  const email = `specialist-shot-${Date.now()}@example.com`;
  const password = 'Sc3ptre-Harbour-92!';
  const username = `c7shot${Date.now().toString().slice(-8)}`;

  const created = await fetch(`${ACCOUNT}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, username }),
  });
  if (!created.ok) {
    throw new Error(`could not create an account: ${created.status} ${await created.text()}`);
  }
  const body = await created.json();
  const token = body.token;
  const accountId = body.accountId;
  if (typeof token !== 'string' || typeof accountId !== 'string') {
    throw new Error('the sign-up response carried no session');
  }

  const call = async (method, path, payload) => {
    const response = await fetch(`${ACCOUNT}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    return { status: response.status, body: await response.text() };
  };

  await call('POST', '/specialists/me', {
    motivation: 'I speak Yoruba and English, and I have taught Yoruba for ten years.',
    country: 'Nigeria',
    timeZone: '(GMT+0100) West Africa Time',
  });
  /*
   * Four tracks on purpose, one per state the audit cares about:
   *   yo  elicitation, carried all the way to a frozen corpus
   *   ha  elicitation, left at the consent step
   *   fr  VALIDATION, so the source-check screen has something to show
   *   pt  VALIDATION, and the language that asks the observed-language question
   */
  for (const language of ['yo', 'ha', 'fr', 'pt']) {
    await call('POST', `/specialists/languages/${language}/apply`);
  }

  /*
   * The Hausa track is left at the consent step ON PURPOSE, so the audit has a
   * capture of the permission screen as somebody actually meets it, rather than
   * only of the state after it has been accepted.
   */
  const offer = JSON.parse((await call('GET', '/specialists/consent/yo')).body);
  await call('POST', '/specialists/consent/yo', {
    accepted: true,
    typed: 'YES',
    consentVersion: offer.offer.consentVersion,
  });

  const form = JSON.parse((await call('GET', '/specialists/elicitation/yo')).body);
  const entries = form.prompts.map((prompt) => ({
    item: prompt.item,
    nativeMessage: prompt.optional ? '' : SAMPLE[prompt.item] ?? `Ìránṣẹ́ ${prompt.item}`,
    englishSemanticReference: prompt.optional ? '' : SAMPLE_EN[prompt.item] ?? `Meaning ${prompt.item}`,
  }));
  await call('PUT', '/specialists/elicitation/yo', { entries });
  await call('POST', '/specialists/elicitation/yo/freeze');

  return { token, accountId, email, call };
}

/**
 * Ask an operator to issue a blind review packet for the seeded specialist.
 *
 * ONLY WITH A REAL OPERATOR SESSION. There is no bypass here and none is added
 * anywhere for this script: `--operator-token` must be a session for an account
 * the deployment has already put on the platform allowlist AND verified. Without
 * one the review surface is captured in its honest empty state, which is what a
 * specialist with no assignment actually sees.
 *
 * The candidates below are illustrative, written for this script. They are NOT
 * engine output and must never be read as benchmark evidence.
 */
/**
 * Supply the source a fluent speaker validates. VALIDATION tracks only.
 *
 * Illustrative French, written for this script. It is NOT a corpus and must
 * never be read as one.
 */
async function supplySource(operatorToken, accountId, language) {
  const response = await fetch(
    `${ACCOUNT}/admin/language-specialists/${accountId}/${language}/source`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
      body: JSON.stringify({
        items: [
          { category: 'money', suppliedText: 'Le prix est de deux mille nairas le sac.' },
          { category: 'negation', suppliedText: "Je n'ai pas encore reçu l'argent." },
          { category: 'phone', suppliedText: 'Appelle-moi au 08031234567 quand tu arrives.' },
          { category: 'otp', suppliedText: 'Votre code est 483920. Ne le partagez pas.' },
          { category: 'meeting', suppliedText: 'On se voit vendredi à seize heures.' },
        ],
      }),
    },
  );
  if (!response.ok) {
    console.log(`  could not supply ${language} source: ${response.status} ${await response.text()}`);
    return;
  }
  console.log(`  supplied ${language} source for validation`);
}

async function issueReview(operatorToken, accountId, language) {
  const response = await fetch(
    `${ACCOUNT}/admin/language-specialists/${accountId}/${language}/assignments`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${operatorToken}`,
      },
      body: JSON.stringify({
        /*
         * A candidate NAMES its sentence and does not carry it. The server
         * resolves the text from the frozen corpus for this account, language
         * and attempt, so a packet cannot hold the words of one source while
         * recording the fingerprint of another.
         *
         * Item 3 is the negation row -- "I have not received the money" -- which
         * is the shape that has already broken two engines.
         */
        candidates: [
          {
            sourceOrdinal: 3,
            candidateText: 'I have received the money.',
            provider: 'illustrative-a',
            model: 'illustrative/a',
          },
          {
            sourceOrdinal: 3,
            candidateText: 'I have not received the money yet.',
            provider: 'illustrative-b',
            model: 'illustrative/b',
          },
          {
            sourceOrdinal: 11,
            candidateText: 'Send the money before you hear from me.',
            provider: 'illustrative-a',
            model: 'illustrative/a',
          },
        ],
      }),
    },
  );
  if (!response.ok) {
    console.log(`  could not issue a review packet: ${response.status} ${await response.text()}`);
    return;
  }
  const body = await response.json();
  console.log(`  issued a blind review of ${body.candidates} translations`);
}

/**
 * Sample answers, so the captures show a filled form rather than empty boxes.
 *
 * These are illustrative Yoruba written for this script; they are NOT a
 * contributor's corpus and must never be treated as one. Real evidence comes
 * from a real specialist under the real permission.
 */
const SAMPLE = {
  1: 'Ẹgbẹ̀rún méjì naira ni owó rẹ̀.',
  2: 'Mo ti gba owó náà, ẹ ṣé.',
  3: 'Mi ò tíì gba owó náà o.',
  4: 'Jọ̀wọ́ fi ẹgbẹ̀rún márùn-ún naira ránṣẹ́ sí mi.',
  5: 'Pè mí ní 08031234567 tí o bá dé.',
  6: 'Kóòdù mi ni 483920, má fi í hàn ẹnikẹ́ni.',
  7: 'Ẹ jẹ́ ká pàdé ní ọjọ́ Ẹtì, ago mẹ́rin ìrọ̀lẹ́.',
  8: 'Ìpàdé náà ti yí padà sí ọjọ́ Àbámẹ́ta.',
  9: 'Mo ti pẹ́ díẹ̀, ìṣẹ́jú ogún ni mo kù.',
  10: 'Jọ̀wọ́ mú ìwé náà wá fún mi.',
  11: 'Má fi owó náà ránṣẹ́ títí ìwọ yóò fi gbọ́ lọ́wọ́ mi.',
  12: 'Ẹ wá gba àpò náà ní ilé.',
  13: 'Ẹ kú àárọ̀ o, ṣé dáadáa ni?',
  14: 'Báwo ni ìdílé ṣe wà?',
};

const SAMPLE_EN = {
  1: 'The price is two thousand naira.',
  2: 'I have received the money, thank you.',
  3: 'I have not received the money yet.',
  4: 'Please send me five thousand naira.',
  5: 'Call me on 08031234567 when you arrive.',
  6: 'My code is 483920, do not show it to anyone.',
  7: 'Let us meet on Friday at four in the afternoon.',
  8: 'The meeting has moved to Saturday.',
  9: 'I am running a little late, about twenty minutes.',
  10: 'Please bring the document for me.',
  11: 'Do not send the money until you hear from me.',
  12: 'Come and collect the bag at the house.',
  13: 'Good morning, are you well?',
  14: 'How is the family?',
};

async function main() {
  await mkdir(OUT, { recursive: true });
  const seeded = await seed();
  console.log(`seeded account ${seeded.accountId}`);

  const operatorToken = arg('operator-token', null);
  if (operatorToken !== null) {
    await issueReview(operatorToken, seeded.accountId, 'yo');
    await supplySource(operatorToken, seeded.accountId, 'fr');
  }

  /*
   * The review packet is captured on ITS OWN URL, which is only known after the
   * assignment exists. Discovered from the specialist's own assignment list
   * rather than from the issuing response, so the capture goes through the same
   * path a person does.
   */
  let reviewPath = null;
  {
    const list = await fetch(`${ACCOUNT}/specialists/assignments`, {
      headers: { authorization: `Bearer ${seeded.token}` },
    });
    if (list.ok) {
      const body = await list.json();
      const open = body.assignments.find((entry) => entry.unlocked === true);
      if (open !== undefined) reviewPath = `/specialist/assignments/${open.assignmentId}/review/`;
    }
  }

  const browser = await chromium.launch({ executablePath: EDGE });

  /*
   * Every page is captured at every width. Screens rather than a sample,
   * because the audit is about composition and a page that only looks right at
   * 1440 is not a page anybody can use.
   */
  const PAGES = [
    { name: 'public', url: `${SITE}/language-specialists/`, session: false },
    { name: 'portal-dashboard', url: `${SITE}/specialist/`, session: true },
    { name: 'portal-languages', url: `${SITE}/specialist/languages/`, session: true },
    { name: 'portal-profile', url: `${SITE}/specialist/profile/`, session: true },
    { name: 'portal-qualification', url: `${SITE}/specialist/qualification/`, session: true },
    { name: 'portal-consent', url: `${SITE}/specialist/qualification/ha/elicitation/`, session: true },
    {
      /* The Checkpoint-B source check: sentences only, no candidate anywhere. */
      name: 'portal-source-validation',
      url: `${SITE}/specialist/qualification/fr/source-check/`,
      session: true,
    },
    { name: 'portal-elicitation', url: `${SITE}/specialist/qualification/yo/elicitation/`, session: true },
    { name: 'portal-assignments', url: `${SITE}/specialist/assignments/`, session: true },
    { name: 'portal-submissions', url: `${SITE}/specialist/submissions/`, session: true },
    { name: 'operator-applicants', url: `${OPERATOR}/operator/language-specialists/applicants`, session: 'operator' },
    ...(reviewPath === null
      ? []
      : [{ name: 'portal-review', url: `${SITE}${reviewPath}`, session: true }]),
    ...(operatorToken === null
      ? []
      : [
          {
            name: 'operator-applicant',
            url: `${OPERATOR}/operator/language-specialists/applicants/${seeded.accountId}`,
            session: 'operator',
          },
        ]),
  ];

  try {
    for (const viewport of VIEWPORTS) {
      for (const page of PAGES) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 2,
          ...(viewport.isMobile === true ? { isMobile: true, hasTouch: true } : {}),
        });

        /*
         * The session is written BEFORE any script on the page runs. Setting it
         * after navigation would capture the signed-out frame first, which is a
         * screenshot of a state nobody stays in.
         */
        const token = page.session === 'operator' ? operatorToken : seeded.token;
        if (page.session !== false && token !== null) {
          await context.addInitScript(
            ([sessionToken, accountId]) => {
              try {
                localStorage.setItem('c7.session', sessionToken);
                localStorage.setItem(
                  'videofy-account:session',
                  JSON.stringify({ accountId, token: sessionToken }),
                );
              } catch {
                /* private mode; the capture will show the signed-out state */
              }
            },
            [token, seeded.accountId],
          );
        }

        const tab = await context.newPage();
        await tab.goto(page.url, { waitUntil: 'networkidle' });
        // The portal loads three requests before it settles; capturing earlier
        // photographs a spinner.
        await tab.waitForTimeout(900);
        await tab.screenshot({
          path: `${OUT}/${page.name}-${viewport.name}.png`,
          fullPage: true,
        });

        /*
         * The horizontal-overflow check, run at capture time rather than by
         * eye. A page that scrolls sideways is a defect the screenshot itself
         * hides, because `fullPage` widens the image to fit the overflow.
         *
         * IT ASKS WHETHER THE PAGE CAN ACTUALLY SCROLL, not what
         * `documentElement.scrollWidth` says. That number counts the content of
         * a nested scroll container too: the operator's applicant table
         * legitimately scrolls inside its own box, and the root reported 262px
         * of "overflow" for a page that would not move a pixel when scrolled.
         * A check that cries wolf on a correct page is a check somebody
         * switches off, so it now measures the thing that matters -- whether a
         * person can push the navigation off screen.
         */
        const overflow = await tab.evaluate(() => {
          const before = window.scrollX;
          window.scrollTo(9999, window.scrollY);
          const moved = window.scrollX;
          window.scrollTo(before, window.scrollY);
          /* `body`, not `documentElement`: see above. */
          const bodyOverflow = document.body.scrollWidth - document.body.clientWidth;
          return Math.max(moved, bodyOverflow > 1 ? bodyOverflow : 0);
        });
        const flag = overflow > 1 ? `  OVERFLOW +${overflow}px` : '';
        console.log(`captured ${page.name} @ ${viewport.name}${flag}`);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\nscreenshots in ${OUT}/`);
  if (operatorToken === null) {
    console.log(
      'NOTE: no --operator-token, so the operator captures show the refusal screen.\n' +
        '      That is the correct output for a caller who is not a verified platform operator.',
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
