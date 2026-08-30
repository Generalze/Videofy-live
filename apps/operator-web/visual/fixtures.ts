/** @author masterzee001 */
/**
 * Deterministic render fixtures for the visual harness. TEST-ONLY.
 *
 * WHY THEY EXIST (founder directive, 30 Aug 2026, SS13 OPERATOR GOLDEN-MASTER
 * CORRECTION): the harness screenshots the real console, which has no
 * gateway, no ingest and no account service behind it. Every capture was
 * therefore the signed-out, disconnected console -- empty catalogue, Waiting
 * chips, disabled buttons -- diffed against masters drawn with sample state.
 * Most of the remaining mismatch was that difference, and none of it was a
 * layout defect. These fixtures render the same LAYOUT with state that does
 * not move between runs, so the number the harness reports is about
 * geometry, typography and spacing.
 *
 * WHAT THEY MAY NOT BECOME. The implementation contract is explicit: "Never
 * hard-code sample data solely to make the screenshot match" and "No status
 * value may be invented." These values are not a way to ship invented
 * operational data, and production cannot read them:
 *
 *   - this file lives outside src/, so it is not in the production module
 *     graph -- the production build starts at ../index.html -> src/main.tsx;
 *   - no file under src/ imports it, and no file under src/ branches on a
 *     fixture flag. Both are asserted, by fixtureIsolation.test.ts and again
 *     by the harness before it builds;
 *   - every value below is plainly synthetic and named as such.
 *
 * WHERE THE VALUES COME FROM. Only from the masters, and only what the
 * masters actually show. Where a master shows nothing, the fixture shows the
 * honest empty/waiting state -- it does not invent a number to close a gap.
 * In particular 01 shows 0 viewers and a disconnected gateway with its red
 * alert, which is what the fixture renders.
 */
import type { ServiceLight, ShellHeader, ShellStatus } from '../src/ConsoleShell';
import type { ChannelIdentityState } from '../src/premium/channelIdentity';
import type { CatalogueState } from '../src/pages/LanguagesPage';
import type { LanguageRow } from '../src/languageRows';
import type { SourceLanguageControlMetadata } from '@videofy-live/shared-types';
import type { VoiceRow } from '../src/voiceRows';
import type { OverviewFeed } from '../src/pages/overviewStatus';
import type { LiveFeedCard } from '../src/pages/LivePage';
import type { ProgrammeRecorderSnapshot } from '../src/programmeRecorder';
import {
  createInitialProgrammeSourceSnapshot,
  type ProgrammeSourceSnapshot,
} from '../src/programmeSourceManager';
import { buildOperatorWorkflowSummary, type OperatorWorkflowSummary } from '../src/operatorWorkflow';

/**
 * The synthetic origins the fixture hands the shell. They are not a
 * deployment: nothing is fetched from them, because the fixture renders the
 * signed-out identity and the shell only builds avatar URLs for a profile.
 */
export const FIXTURE_ACCOUNT_URL = 'http://fixture.invalid/account';
export const FIXTURE_PUBLIC_ORIGIN = 'http://fixture.invalid';

/**
 * 01 lists two service lights, each with a word under it. These are the two
 * services the console really reports; the words are the console's own
 * unhealthy wording, not an invented status.
 */
export const fixtureServices: readonly ServiceLight[] = [
  { label: 'Realtime gateway', ok: false, detail: 'Disconnected', tone: 'danger' },
  { label: 'Media ingest', ok: false, detail: 'Unavailable', tone: 'warn' },
];

/** 01 shows 0 viewers. The alert owns the gateway sentence, so the strip carries none. */
export const fixtureStatus: ShellStatus = { viewers: 0, warning: null };

/** 01 shows the gateway pill Disconnected and the red alert under the bar. */
export const fixtureHeader: ShellHeader = { gatewayConnected: false, gatewayRefusal: null, uiLanguage: 'EN' };

/**
 * Signed out. A fixture must never carry an account, a channel, a handle or
 * a session id, so the identity cluster renders the shell's "Sign in" state
 * rather than a made-up channel.
 */
export const fixtureIdentity: ChannelIdentityState = { status: 'signed-out' };

/** No programme, so no source. The manager's own initial snapshot, not a literal. */
export const fixtureSource: ProgrammeSourceSnapshot = createInitialProgrammeSourceSnapshot();

export const fixtureRecording: ProgrammeRecorderSnapshot = { state: 'idle', startedAtMs: null, error: null };

/** Derived, not asserted: the workflow's own summary for a disconnected console with no source. */
export const fixtureWorkflow: OperatorWorkflowSummary = buildOperatorWorkflowSummary({
  connected: false,
  ingestHealthy: false,
  programmeSource: fixtureSource,
  programmeMediaReady: false,
  programmeMediaError: null,
  mediaState: null,
  streamStatus: 'idle',
  starting: false,
  mediaError: null,
});

/** No processing session exists, so every feed is absent and every card says Waiting. */
export const fixtureFeed: OverviewFeed | null = null;

/**
 * The catalogue rows 03 draws, and only those five, in the master's order.
 *
 * The capability word on each row is a RENDER INPUT, not a claim: the four
 * words paint four different chips (teal, amber, grey) at three different
 * widths, and the width decides where the "+ Add" button lands. A fixture
 * that made every row Unavailable would measure one chip five times and
 * would never measure the row the master actually draws. So the words here
 * are the master's own, and they are readable by nothing but the harness:
 * no capability is asserted about any deployment, because this list is not
 * a deployment's catalogue and production cannot reach it.
 */
export const fixtureLanguageRows: readonly LanguageRow[] = [
  { code: 'es', label: 'Spanish', state: 'available' },
  { code: 'fr', label: 'French', state: 'available' },
  { code: 'de', label: 'German', state: 'limited' },
  { code: 'pt', label: 'Portuguese', state: 'available' },
  { code: 'zh', label: 'Chinese (Simplified)', state: 'unavailable' },
];

/** 03 draws one selected chip, ES Spanish, and "Selected languages (1)". */
export const fixtureTargetLanguages: readonly string[] = ['es'];

/**
 * 03 draws the current source as EN / English / Detected, which is the shape
 * of a running session's source-language control. The fixture hands the page
 * that control and NO action callback, so the page renders the state the
 * master draws without the Confirm / Reject / Override / Lock row, which the
 * master does not draw. Every field is synthetic and fixed.
 */
export const fixtureSourceLanguageControl: SourceLanguageControlMetadata = {
  defaultLanguage: 'en',
  activeLanguage: 'en',
  mode: 'auto-detect',
  status: 'detected',
  detectedLanguage: 'en',
  detectionConfidence: 0.98,
  confirmedLanguage: null,
  rejectedLanguage: null,
  locked: false,
  revision: 1,
  confidenceThreshold: 0.7,
  updatedAt: '2026-08-30T00:00:00.000Z',
};

export const fixtureCatalogue: CatalogueState = { status: 'ready' };

/**
 * 04's six voice rows, exactly as the master draws them: a flag, a vendor
 * with a voice id, and a chip that carries the sold grade where the master
 * shows one and the availability word where it does not.
 *
 * WRITTEN OUT, not derived from fixtureLanguageRows: 03 and 04 draw
 * different languages (04 draws English first and keeps Yoruba and Hausa;
 * 03 draws neither), so one list cannot serve both pages. Deriving them
 * coupled two independent masters, and moving either page's rows silently
 * moved the other's.
 *
 * NEITHER THE FLAG NOR THE GRADE EXISTS IN THE DEPLOYMENT. buildVoiceRows
 * returns null for both on every row, because no feed maps a language to a
 * country and the capability resolver returns the same rows for every grade;
 * the real console therefore shows the language code and the availability
 * word, and always will until something resolves them. These literals exist
 * so the harness measures the master's row geometry -- flag plate, two lines
 * of text, chip, chevron -- instead of measuring the absence of a registry.
 * Production has no path to this file.
 *
 * The vendors named are ones the deployment really integrates and the voice
 * ids are in the shape providerLabel() builds; the countries are the flags
 * the master drew, Sierra Leone beside Hausa included.
 */
export const fixtureVoiceRows: readonly VoiceRow[] = [
  { code: 'en', label: 'English', provider: 'Azure Neural (en-GB)', status: 'ready', reason: undefined, flag: 'GB', grade: 'standard' },
  { code: 'es', label: 'Spanish', provider: 'ElevenLabs (es-ES)', status: 'ready', reason: undefined, flag: 'ES', grade: 'premium' },
  { code: 'fr', label: 'French', provider: 'Azure Neural (fr-FR)', status: 'ready', reason: undefined, flag: 'FR', grade: 'standard' },
  { code: 'de', label: 'German', provider: 'ElevenLabs (de-DE)', status: 'waiting', reason: undefined, flag: 'DE', grade: null },
  { code: 'yo', label: 'Yoruba', provider: 'ElevenLabs (yo)', status: 'waiting', reason: undefined, flag: 'NG', grade: null },
  { code: 'ha', label: 'Hausa', provider: 'Azure Neural (ha)', status: 'waiting', reason: undefined, flag: 'SL', grade: null },
];

/** 04 draws the subtitles box ticked and its note in the affirmative. */
export const fixtureSubtitlesEnabled = true;

/** 04's two levels: the original under the interpretation, the interpretation at full. */
export const fixtureOriginalMix = 0.2;
export const fixtureTranslatedMix = 1;

/* ------------------------------------------------------------ 10 Live Control */

/**
 * 10 draws the console mid-programme, and it draws no gateway alert under the
 * top bar. The alert is the console's response to a disconnected gateway --
 * exactly the "random disconnected runtime state" these fixtures exist to take
 * out of the measurement -- and while it is up it pushes the whole page body
 * about 100px down the viewport, so the harness measures a vertical offset
 * instead of a layout.
 *
 * So the live fixture renders a connected gateway. The cost is honest and
 * recorded: 10 draws the top-bar pill as "Disconnected" while drawing no
 * alert, which no single console state produces, and this fixture keeps the
 * page body rather than the pill. The shell is 01's, not this page's.
 */
export const fixtureLiveHeader: ShellHeader = { gatewayConnected: true, gatewayRefusal: null, uiLanguage: 'EN' };

/**
 * The source 10 draws: an HDMI video input and an Input 1 audio input,
 * 1080p25, broadcasting. Built from the manager's own initial snapshot so a
 * new field cannot be silently missing, and every value is one the master
 * shows.
 */
export const fixtureLiveSource: ProgrammeSourceSnapshot = {
  ...createInitialProgrammeSourceSnapshot(),
  sourceType: 'rtmp',
  sourceIdentity: 'Fixture programme source',
  status: 'broadcasting',
  audioDetected: true,
  videoDetected: true,
  audioSourceLabel: 'Input 1',
  videoSourceLabel: 'HDMI 1',
  audioTrackState: 'live',
  videoTrackState: 'live',
  videoWidth: 1920,
  videoHeight: 1080,
  frameRate: 25,
  previewReady: true,
  broadcasting: true,
  canPause: true,
  canRestart: true,
};

/** Derived, not asserted: the workflow's own summary for that source on a healthy console. */
export const fixtureLiveWorkflow: OperatorWorkflowSummary = buildOperatorWorkflowSummary({
  connected: true,
  ingestHealthy: true,
  programmeSource: fixtureLiveSource,
  programmeMediaReady: true,
  programmeMediaError: null,
  mediaState: null,
  streamStatus: 'processing',
  starting: false,
  mediaError: null,
});

/**
 * The three output cards, each carrying its stage's own real status word so
 * feedPill() decides the pill rather than a literal. No text: 10 draws the
 * components' own placeholder sentences, which is what an empty card says.
 */
export const fixtureLiveTranscript: LiveFeedCard = { status: 'transcribing', text: null };
export const fixtureLiveTranslation: LiveFeedCard = { status: 'translated', text: null };
export const fixtureLiveGeneratedVoice: LiveFeedCard = { status: 'generated', text: null };

/** 10 shows "2 active" on the Languages row. Catalogue codes, not operational state. */
export const fixtureLiveTargetLanguages: readonly string[] = ['es', 'fr'];
export const fixtureLiveActiveLanguages: readonly string[] = ['es', 'fr'];

/**
 * The two figures 10 draws that nothing in the product measures. The
 * Programme Quality Engine is not built, so the console passes neither and an
 * operator reads "--"; these live here, in a file production cannot reach, and
 * are handed to the page as props. They are the master's numbers, not a claim
 * about any programme.
 */
export const fixtureLiveQuality = 'Good';
export const fixtureLiveDelay = '480 ms';

/** Every callback a page needs. A fixture render is never interacted with. */
export const noop = (): void => undefined;
