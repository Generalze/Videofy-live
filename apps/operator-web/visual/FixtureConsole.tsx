/** @author masterzee001 */
/**
 * The console as the visual harness renders it. TEST-ONLY.
 *
 * It mounts the SAME ConsoleShell and the SAME five page components the
 * console ships, and feeds them fixture prop objects. Nothing is
 * reimplemented here: if this file had its own copy of the shell, the harness
 * would be measuring a drawing of the console rather than the console.
 *
 * The page is chosen by hash, exactly as the console chooses it, so the
 * harness drives #/overview, #/source, #/languages, #/audio and #/live
 * against this entry the same way it drove them against the app.
 */
import React from 'react';
import { ConsolePage, ConsoleShell } from '../src/ConsoleShell';
import { pageFromHash, type OperatorPage } from '../src/router';
import { OverviewPage } from '../src/pages/OverviewPage';
import { SourcePage } from '../src/pages/SourcePage';
import { LanguagesPage } from '../src/pages/LanguagesPage';
import { AudioVoicesAside, AudioVoicesPage } from '../src/pages/AudioVoicesPage';
import { LiveControlAside, LivePage } from '../src/pages/LivePage';
import {
  FIXTURE_ACCOUNT_URL,
  FIXTURE_PUBLIC_ORIGIN,
  fixtureCatalogue,
  fixtureFeed,
  fixtureHeader,
  fixtureIdentity,
  fixtureLanguageRows,
  fixtureLiveActiveLanguages,
  fixtureLiveRecommendedDelay,
  fixtureLiveGeneratedVoice,
  fixtureLiveHeader,
  fixtureLiveQuality,
  fixtureLiveSource,
  fixtureLiveTargetLanguages,
  fixtureLiveTranscript,
  fixtureLiveTranslation,
  fixtureLiveWorkflow,
  fixtureOriginalMix,
  fixtureRecording,
  fixtureServices,
  fixtureSource,
  fixtureSourceLanguageControl,
  fixtureStatus,
  fixtureSubtitlesEnabled,
  fixtureTargetLanguages,
  fixtureTranslatedMix,
  fixtureVoiceRows,
  fixtureWorkflow,
  noop,
} from './fixtures';

export function FixtureConsole(): React.ReactElement {
  const page: OperatorPage = pageFromHash(window.location.hash);
  return (
    <ConsoleShell
      page={page}
      services={fixtureServices}
      status={fixtureStatus}
      /*
       * 01 draws the gateway alert and 10 does not, so the shell state the
       * fixture feeds follows the master under test. The shell itself is
       * untouched: this is which state it is shown in, not how it is built.
       */
      header={page === 'live' ? fixtureLiveHeader : fixtureHeader}
      identity={fixtureIdentity}
      channelLive={null}
      accountUrl={FIXTURE_ACCOUNT_URL}
      publicOrigin={FIXTURE_PUBLIC_ORIGIN}
    >
      <OverviewPage
        active={page === 'overview'}
        workflow={fixtureWorkflow}
        starting={false}
        onGoLive={noop}
        source={{ videoDetected: false, audioDetected: false }}
        transcription={fixtureFeed}
        translation={fixtureFeed}
        generatedVoice={fixtureFeed}
        viewers={fixtureStatus.viewers}
      />
      {/*
        The page opening is production's, word for word (App.tsx's own kicker
        and lede for 02). A fixture may pin STATE; it may not render a page
        header the console does not ship, or the harness measures a page
        nobody can reach.
      */}
      <ConsolePage
        id="source"
        active={page === 'source'}
        kicker="Step 1 of 6"
        title="Source"
        lede="Choose how you want to send your programme to Videofy Live. Select a source type and configure the details."
      >
        <SourcePage
          source={fixtureSource}
          recording={fixtureRecording}
          onRefreshDevices={noop}
          onSelectCamera={noop}
          onSelectScreen={noop}
          onSelectUploadedVideo={noop}
          onSelectDirectStreamUrl={noop}
          onSelectRtmpSource={noop}
          onSeek={noop}
          onClear={noop}
          onToggleRecording={noop}
        />
      </ConsolePage>
      {/*
        * The kicker, title and lede are the ones App.tsx passes for this page.
        * A fixture that reworded the heading would measure a heading the
        * console does not ship.
        */}
      <ConsolePage
        id="languages"
        active={page === 'languages'}
        kicker="Step 2 of 6"
        title="Languages"
        lede="Choose the source language of your programme and the target languages you want to make available to your audience."
      >
        <LanguagesPage
          rows={fixtureLanguageRows}
          catalogue={fixtureCatalogue}
          sourceLanguage="en"
          sourceLanguageMode="auto-detect"
          onSourceLanguageChange={noop}
          sourceLanguageControl={fixtureSourceLanguageControl}
          targetLanguages={fixtureTargetLanguages}
          onToggleTarget={noop}
          locked={false}
          lockedReason=""
          onBack={noop}
          onContinue={noop}
        />
      </ConsolePage>
      <ConsolePage
        id="audio"
        active={page === 'audio'}
        kicker="Step 3 of 6"
        title="Audio & Voices"
        lede="Choose how viewers hear the programme: the original under interpretation, or replaced by it. Voices are set per language by the deployment's registry."
        aside={<AudioVoicesAside />}
      >
        <AudioVoicesPage
          mode="interpretation"
          onModeChange={noop}
          originalMix={fixtureOriginalMix}
          translatedMix={fixtureTranslatedMix}
          onOriginalMixChange={noop}
          onTranslatedMixChange={noop}
          subtitlesEnabled={fixtureSubtitlesEnabled}
          onSubtitlesEnabledChange={noop}
          viewers={fixtureStatus.viewers}
          voices={fixtureVoiceRows}
          onViewPreflight={noop}
        />
      </ConsolePage>
      <ConsolePage
        id="live"
        active={page === 'live'}
        kicker={fixtureLiveWorkflow.status === 'Live' ? 'On air' : 'Off air'}
        title="Live Control"
        lede="Manage the live programme. Control playback, recording and monitor real-time outputs."
        aside={
          <LiveControlAside
            onAir={fixtureLiveWorkflow.status === 'Live'}
            progressLabel={fixtureLiveWorkflow.progressLabel}
            viewers={fixtureStatus.viewers}
            quality={fixtureLiveQuality}
            recommendedDelay={fixtureLiveRecommendedDelay}
          />
        }
      >
        <LivePage
          workflow={fixtureLiveWorkflow}
          starting={false}
          recording={fixtureRecording}
          source={fixtureLiveSource}
          previewStream={null}
          targetLanguages={fixtureLiveTargetLanguages}
          activeLanguages={fixtureLiveActiveLanguages}
          audioMode="interpretation"
          transcript={fixtureLiveTranscript}
          translation={fixtureLiveTranslation}
          generatedVoice={fixtureLiveGeneratedVoice}
          onStart={noop}
          onRestart={noop}
          onPause={noop}
          onResume={noop}
          onEnd={noop}
          onToggleRecording={noop}
          diagnostics={null}
        />
      </ConsolePage>
    </ConsoleShell>
  );
}
