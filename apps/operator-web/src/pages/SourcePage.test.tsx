/** @author masterzee001 */
/**
 * The Source page renders the six real source flows and never invents state:
 * with no source the chips wait, the details say so, and Record is disabled
 * with a reason; with a ready source the details are the snapshot's own.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createInitialProgrammeSourceSnapshot, type ProgrammeSourceSnapshot } from '../programmeSourceManager';
import { SourcePage, type SourceTileId } from './SourcePage';

function render(source: Partial<ProgrammeSourceSnapshot> = {}, defaultType?: SourceTileId, recording: 'idle' | 'recording' = 'idle'): string {
  return renderToStaticMarkup(
    <SourcePage
      source={{ ...createInitialProgrammeSourceSnapshot(), ...source }}
      recording={{ state: recording, startedAtMs: recording === 'recording' ? 1 : null, error: null }}
      onRefreshDevices={vi.fn()}
      onSelectCamera={vi.fn()}
      onSelectScreen={vi.fn()}
      onSelectUploadedVideo={vi.fn()}
      onSelectDirectStreamUrl={vi.fn()}
      onSelectRtmpSource={vi.fn()}
      onSeek={vi.fn()}
      onClear={vi.fn()}
      onToggleRecording={vi.fn()}
      defaultType={defaultType}
    />,
  );
}

describe('SourcePage', () => {
  it('shows the six source tiles with the upload panel first', () => {
    const html = render();
    for (const title of ['Upload video', 'Camera / capture device', 'Screen / window', 'Meeting through OBS', 'Direct media URL', 'RTMP']) {
      expect(html).toContain(title);
    }
    expect(html).toContain('Drag &amp; drop your video file here');
    expect(html).toContain('Browse files');
    expect(html).toContain('Supported formats: MP4, WebM, MOV');
    // No size limit exists in the manager, so none is printed.
    expect(html).not.toMatch(/Max size/i);
    expect(html).toContain('Browser default camera');
    expect(html).toContain('Browser default audio');
  });

  it('with no source: waiting chips, "No source selected", Record disabled with a reason', () => {
    const html = render();
    expect(html).toContain('Video waiting');
    expect(html).toContain('Audio waiting');
    expect(html).toContain('Live source');
    expect(html).toContain('Not ready');
    expect(html).toContain('No source selected');
    expect(html).toMatch(/<button[^>]*disabled[^>]*title="Select a programme source first[^"]*"[^>]*>(?:(?!<\/button>).)*Record the programme/s);
    expect(html).toContain('aria-label="Operator programme preview"');
    expect(html).toContain('Enter fullscreen');
  });

  it('keeps the other flows reachable through their panels', () => {
    expect(render({}, 'direct-url')).toContain('Use URL');
    const rtmp = render({}, 'rtmp');
    expect(rtmp).toContain('Use RTMP');
    expect(rtmp).toContain('RTMP publish URL');
    expect(render({}, 'screen')).toContain('Choose a screen or window');
    expect(render({}, 'obs')).toContain('Use OBS Virtual Camera');
    expect(render({}, 'camera')).toContain('Use this camera');
  });

  it('with a ready uploaded video: the chips and details are the snapshot, and Record is live', () => {
    const html = render({
      sourceType: 'uploaded-video',
      sourceIdentity: 'demo.mp4',
      status: 'preview-ready',
      previewReady: true,
      audioDetected: true,
      videoDetected: true,
      durationMs: 47_900,
      canSeek: true,
    });
    expect(html).toContain('Video detected');
    expect(html).toContain('Audio detected');
    expect(html).toContain('0:47');
    expect(html).toContain('Ready');
    expect(html).toContain('demo.mp4');
    expect(html).toContain('Uploaded video');
    expect(html).not.toContain('No source selected');
    expect(html).toContain('aria-label="Programme video seek"');
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Record the programme/s);
  });

  it('opens the OBS tile for a camera the manager recognised as OBS', () => {
    const html = render({ sourceType: 'camera', isObsVirtualCamera: true, status: 'preview-ready', previewReady: true });
    expect(html).toContain('Use OBS Virtual Camera');
  });

  it('while recording, the primary offers to stop and download', () => {
    const html = render({ sourceType: 'camera', status: 'broadcasting', previewReady: true }, undefined, 'recording');
    expect(html).toContain('Stop recording &amp; download');
  });
});
