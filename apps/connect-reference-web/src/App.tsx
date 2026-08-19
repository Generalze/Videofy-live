// owner: masterzee001
/**
 * The Connect Reference app shell. Screens are pure views; this container owns
 * the state and the two conversations the product is allowed to have:
 *
 *   1. with the Connect Reference server — room ids, join tokens, host keys;
 *   2. with the Videofy gateway — through @videofy/connect only.
 *
 * Nothing else. The project key lives on the server; internal call identity
 * never reaches this file, let alone the page.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createVideofyClient } from '@videofy/connect';
import type { AudioMode } from '@videofy/connect';
import { createCameraPreview } from './cameraPreview';
import { gatewayUrl } from './config';
import { ensureGuestSubject, recallDisplayName, rememberDisplayName } from './guestIdentity';
import { holdsHostKey, recallHostKey, rememberHostKey } from './hostKeys';
import { createRefApi, RefApiError } from './referenceApi';
import type { RefConfig, RoomDetail, RoomMode, RoomSummary } from './referenceTypes';
import { createLatestRequestGuard } from './latestRequest';
import { LobbyScreen } from './LobbyScreen';
import { brandTranscript, canDownloadTranscript } from './roomPolicy';
import { REJOIN_MAX_ATTEMPTS } from './rejoinPlan';
import { RoomScreen } from './RoomScreen';
import { RoomSession, type CurrentPreferences, type SessionView } from './roomSession';
import { RoomsScreen, type FreshHostKey, type RoomCreateForm } from './RoomsScreen';

type Nav =
  | { screen: 'rooms' }
  | { screen: 'lobby'; roomId: string }
  | { screen: 'room'; roomId: string };

function failureWords(failure: unknown): string {
  if (failure instanceof RefApiError) return failure.message;
  if (failure instanceof Error && failure.message.length > 0) return failure.message;
  return 'Something went wrong. Please try again.';
}

const EMPTY_FORM: RoomCreateForm = { name: '', mode: 'normal', scheduledFor: '' };

export function App(): JSX.Element {
  const api = useMemo(() => createRefApi((input, init) => fetch(input, init)), []);
  const storage = window.localStorage;

  const [nav, setNav] = useState<Nav>({ screen: 'rooms' });

  // ——— platform config ———
  const [config, setConfig] = useState<RefConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const languages = config?.languages ?? [];

  // ——— rooms screen ———
  const roomsRefreshBusy = useRef(false);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [form, setForm] = useState<RoomCreateForm>(EMPTY_FORM);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [freshHostKey, setFreshHostKey] = useState<FreshHostKey | null>(null);
  const [hostKeyCopied, setHostKeyCopied] = useState(false);

  // ——— lobby ———
  const [detail, setDetail] = useState<RoomDetail | null>(null);
  const [displayName, setDisplayName] = useState(() => recallDisplayName(storage));
  const [speakLanguage, setSpeakLanguage] = useState('');
  const [hearLanguage, setHearLanguage] = useState('');
  const [previewOn, setPreviewOn] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const preview = useMemo(() => createCameraPreview(navigator.mediaDevices), []);

  // ——— in the room ———
  const sessionRef = useRef<RoomSession | null>(null);
  const [sessionView, setSessionView] = useState<SessionView | null>(null);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [hostBusy, setHostBusy] = useState(false);
  const [uiNotice, setUiNotice] = useState<string | null>(null);
  const transcriptOpenRef = useRef(false);
  transcriptOpenRef.current = transcriptOpen;

  const refreshRooms = useCallback(async () => {
    // The 5-second poll must never overlap itself: two in-flight refreshes
    // can land out of order and paint a stale list. Skip the tick instead —
    // the next one is at most five seconds away.
    if (roomsRefreshBusy.current) return;
    roomsRefreshBusy.current = true;
    try {
      const listed = await api.listRooms();
      setRooms(listed);
      setListError(null);
    } catch (failure) {
      setListError(failureWords(failure));
    } finally {
      roomsRefreshBusy.current = false;
      setRoomsLoading(false);
    }
  }, [api]);

  const loadConfig = useCallback(async () => {
    try {
      const fetched = await api.getConfig();
      setConfig(fetched);
      setConfigError(null);
    } catch (failure) {
      setConfigError(failureWords(failure));
    }
  }, [api]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (nav.screen !== 'rooms') return;
    void refreshRooms();
    const timer = window.setInterval(() => void refreshRooms(), 5000);
    return () => window.clearInterval(timer);
  }, [nav.screen, refreshRooms]);

  useEffect(() => {
    if (languages.length === 0) return;
    const first = languages[0] ?? '';
    setSpeakLanguage((current) => (current === '' ? first : current));
    setHearLanguage((current) => (current === '' ? first : current));
  }, [languages]);

  // ——— rooms handlers ———

  const handleCreate = useCallback(async () => {
    setCreateBusy(true);
    setCreateError(null);
    try {
      const scheduled = form.scheduledFor.trim();
      const created = await api.createRoom({
        name: form.name.trim(),
        mode: form.mode,
        ...(scheduled.length > 0 ? { scheduledFor: new Date(scheduled).toISOString() } : {}),
      });
      rememberHostKey(storage, created.room.roomId, created.hostKey);
      setFreshHostKey({
        roomId: created.room.roomId,
        roomName: created.room.name,
        hostKey: created.hostKey,
      });
      setHostKeyCopied(false);
      setForm(EMPTY_FORM);
      await refreshRooms();
    } catch (failure) {
      setCreateError(failureWords(failure));
    } finally {
      setCreateBusy(false);
    }
  }, [api, form, refreshRooms, storage]);

  const lobbyRoomRef = useRef<string | null>(null);
  const enterLobby = useCallback(
    async (roomId: string) => {
      lobbyRoomRef.current = roomId;
      setDetail(null);
      setJoinError(null);
      setPreviewError(null);
      setNav({ screen: 'lobby', roomId });
      if (config === null) void loadConfig();
      try {
        const fetched = await api.getRoom(roomId);
        // A slower response for a lobby the member already left must not
        // dress THIS lobby in the wrong room's detail.
        if (lobbyRoomRef.current !== roomId) return;
        setDetail(fetched);
      } catch (failure) {
        if (lobbyRoomRef.current !== roomId) return;
        setJoinError(failureWords(failure));
        setDetail(null);
      }
    },
    [api, config, loadConfig],
  );

  const leaveLobby = useCallback(() => {
    preview.stop();
    setPreviewOn(false);
    // A join still in flight is abandoned here: closing the session makes
    // its eventual join surrender the seat instead of yanking the member
    // into a room they already walked away from.
    sessionRef.current?.leave();
    sessionRef.current = null;
    setSessionView(null);
    setNav({ screen: 'rooms' });
  }, [preview]);

  const handleTogglePreview = useCallback(async () => {
    setPreviewError(null);
    if (previewOn) {
      preview.stop();
      setPreviewOn(false);
      return;
    }
    try {
      await preview.start();
      setPreviewOn(true);
    } catch (failure) {
      setPreviewError('We could not start your camera: ' + failureWords(failure));
      setPreviewOn(false);
    }
  }, [preview, previewOn]);

  const previewVideoRef = useCallback(
    (element: HTMLVideoElement | null) => {
      if (element !== null) element.srcObject = preview.current();
    },
    [preview],
  );

  // ——— joining ———

  const handleJoin = useCallback(async () => {
    if (nav.screen !== 'lobby' || detail === null) return;
    const roomId = nav.roomId;
    setJoinBusy(true);
    setJoinError(null);
    rememberDisplayName(storage, displayName);
    const subject = ensureGuestSubject(storage);
    const translated = detail.mode === 'translated';
    const speak = speakLanguage;
    const hear = translated ? hearLanguage : speakLanguage;
    const name = displayName.trim();

    const mintToken = async (current: CurrentPreferences): Promise<string> => {
      const minted = await api.mintJoinToken(roomId, {
        displayName: name,
        speakLanguage: speak,
        // A recovery token must reflect what the member hears NOW, not the
        // lobby choice they may have changed mid-call.
        hearLanguage: translated ? (current.hearLanguage ?? hear) : speak,
        subject,
      });
      return minted.token;
    };

    const cameraWasOn = previewOn;
    preview.stop();
    setPreviewOn(false);

    const session = new RoomSession({
      client: createVideofyClient({ baseUrl: gatewayUrl() }),
      mintToken,
      // The room being over is terminal: the truthful screen is the closed
      // room, not four doomed retries and a lobby that will refuse anyway.
      isTerminalRejoinFailure: (failure) =>
        failure instanceof RefApiError &&
        (failure.code === 'REF_ROOM_ENDED' || failure.code === 'REF_ROOM_NOT_FOUND'),
    });
    sessionRef.current = session;
    session.subscribe((view) => {
      setSessionView(view);
      if (transcriptOpenRef.current) {
        setTranscript(brandTranscript(detail.name, session.getTranscript()));
      }
    });
    try {
      await session.start({ microphone: true, camera: cameraWasOn });
      if (sessionRef.current !== session) {
        // The member left the lobby while the join was in flight; the
        // session already surrendered the seat. Navigate nowhere.
        return;
      }
      setCaptionsOn(true);
      setTranscriptOpen(false);
      setTranscript('');
      setUiNotice(null);
      setNav({ screen: 'room', roomId });
    } catch (failure) {
      if (sessionRef.current === session) {
        sessionRef.current = null;
        setSessionView(null);
        setJoinError(failureWords(failure));
      }
    } finally {
      setJoinBusy(false);
    }
  }, [
    api,
    detail,
    displayName,
    hearLanguage,
    nav,
    preview,
    previewOn,
    speakLanguage,
    storage,
  ]);

  // ——— room handlers ———

  const attachVideoRef = useMemo(() => {
    const cache = new Map<string, (element: HTMLVideoElement | null) => void>();
    return (participantId: string) => {
      let bound = cache.get(participantId);
      if (bound === undefined) {
        bound = (element) => {
          const session = sessionRef.current;
          if (session === null) return;
          if (element !== null) session.attachVideo(participantId, element);
          else session.detachVideo(participantId);
        };
        cache.set(participantId, bound);
      }
      return bound;
    };
  }, []);

  const closeSession = useCallback(() => {
    sessionRef.current?.leave();
    sessionRef.current = null;
    setSessionView(null);
    setUiNotice(null);
    setHostBusy(false);
  }, []);

  const handleLeave = useCallback(() => {
    closeSession();
    setNav({ screen: 'rooms' });
    void refreshRooms();
  }, [closeSession, refreshRooms]);

  const handleBackToLobby = useCallback(() => {
    const roomId = nav.screen === 'room' ? nav.roomId : null;
    closeSession();
    if (roomId !== null) void enterLobby(roomId);
    else setNav({ screen: 'rooms' });
  }, [closeSession, enterLobby, nav]);

  const handleToggleTranscript = useCallback(() => {
    setTranscriptOpen((open) => {
      const next = !open;
      if (next) {
        setTranscript(
          brandTranscript(detail?.name ?? 'Room', sessionRef.current?.getTranscript() ?? ''),
        );
      }
      return next;
    });
  }, [detail]);

  const handleDownloadTranscript = useCallback(() => {
    const roomName = detail?.name ?? 'room';
    const text = brandTranscript(roomName, sessionRef.current?.getTranscript() ?? '');
    const blob = new Blob([text.length > 0 ? text : 'Nothing was said.'], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = roomName.replace(/[^\w-]+/g, '-') + '-transcript.txt';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [detail]);

  const handleHostModeSwitch = useCallback(
    async (mode: RoomMode) => {
      if (nav.screen !== 'room') return;
      const hostKey = recallHostKey(storage, nav.roomId);
      if (hostKey === null) return;
      setHostBusy(true);
      setUiNotice(null);
      try {
        await api.setRoomMode(nav.roomId, mode, hostKey);
        setDetail((current) => (current === null ? current : { ...current, mode }));
      } catch (failure) {
        setUiNotice(failureWords(failure));
      } finally {
        setHostBusy(false);
      }
    },
    [api, nav, storage],
  );

  const handleEndRoom = useCallback(async () => {
    if (nav.screen !== 'room') return;
    const hostKey = recallHostKey(storage, nav.roomId);
    if (hostKey === null) return;
    setHostBusy(true);
    setUiNotice(null);
    try {
      await api.endRoom(nav.roomId, hostKey);
    } catch (failure) {
      setUiNotice(failureWords(failure));
    } finally {
      setHostBusy(false);
    }
  }, [api, nav, storage]);

  // ——— render ———

  let body: JSX.Element;
  if (nav.screen === 'room' && sessionView !== null && sessionView.snapshot !== null) {
    body = (
      <RoomScreen
        roomName={detail?.name ?? 'Room'}
        snapshot={sessionView.snapshot}
        phase={sessionView.phase}
        rejoinAttempt={sessionView.rejoinAttempt}
        rejoinMaxAttempts={REJOIN_MAX_ATTEMPTS}
        audioBlocked={sessionView.audioBlocked}
        micOn={sessionView.micOn}
        cameraOn={sessionView.cameraOn}
        captionsOn={captionsOn}
        isHost={holdsHostKey(storage, nav.roomId)}
        hostBusy={hostBusy}
        languages={languages}
        downloadAllowed={canDownloadTranscript(detail)}
        transcriptOpen={transcriptOpen}
        transcript={transcript}
        notice={uiNotice ?? sessionView.notice}
        attachVideoRef={attachVideoRef}
        onToggleMic={() => void sessionRef.current?.setMicrophone(!sessionView.micOn)}
        onToggleCamera={() => void sessionRef.current?.setCamera(!sessionView.cameraOn)}
        onAudioModeChange={(mode: AudioMode) => sessionRef.current?.setAudioMode(mode)}
        onHearLanguageChange={(language) => void sessionRef.current?.setHearLanguage(language)}
        onToggleCaptions={() => {
          setCaptionsOn((on) => {
            sessionRef.current?.setCaptions(!on);
            return !on;
          });
        }}
        onEnableAudio={() => void sessionRef.current?.enableAudio()}
        onToggleTranscript={handleToggleTranscript}
        onDownloadTranscript={handleDownloadTranscript}
        onHostModeSwitch={(mode) => void handleHostModeSwitch(mode)}
        onEndRoom={() => void handleEndRoom()}
        onLeave={handleLeave}
        onBackToRooms={handleLeave}
        onBackToLobby={handleBackToLobby}
      />
    );
  } else if (nav.screen === 'lobby' || nav.screen === 'room') {
    const roomId = nav.roomId;
    body =
      detail !== null ? (
        <LobbyScreen
          room={detail}
          languages={languages}
          displayName={displayName}
          speakLanguage={speakLanguage}
          hearLanguage={hearLanguage}
          previewOn={previewOn}
          previewSupported={preview.supported()}
          previewError={previewError}
          joinBusy={joinBusy}
          joinError={configError !== null && languages.length === 0 ? configError : joinError}
          previewVideoRef={previewVideoRef}
          onDisplayNameChange={setDisplayName}
          onSpeakLanguageChange={setSpeakLanguage}
          onHearLanguageChange={setHearLanguage}
          onTogglePreview={() => void handleTogglePreview()}
          onJoin={() => void handleJoin()}
          onBack={leaveLobby}
        />
      ) : (
        <section className="ref-card">
          <h2>Lobby</h2>
          {joinError !== null ? (
            <div>
              <p className="ref-error">{joinError}</p>
              <button type="button" onClick={() => void enterLobby(roomId)}>
                Try again
              </button>{' '}
              <button type="button" onClick={leaveLobby}>
                Back to rooms
              </button>
            </div>
          ) : (
            <p className="ref-note">Opening the room…</p>
          )}
        </section>
      );
  } else {
    body = (
      <RoomsScreen
        rooms={rooms}
        loading={roomsLoading}
        listError={listError}
        form={form}
        createBusy={createBusy}
        createError={createError}
        freshHostKey={freshHostKey}
        hostKeyCopied={hostKeyCopied}
        onNameChange={(value) => setForm((current) => ({ ...current, name: value }))}
        onModeChange={(mode) => setForm((current) => ({ ...current, mode }))}
        onScheduleChange={(value) => setForm((current) => ({ ...current, scheduledFor: value }))}
        onCreate={() => void handleCreate()}
        onJoinRoom={(roomId) => void enterLobby(roomId)}
        onCopyHostKey={() => {
          if (freshHostKey === null) return;
          void navigator.clipboard?.writeText(freshHostKey.hostKey);
          setHostKeyCopied(true);
        }}
        onDismissHostKey={() => setFreshHostKey(null)}
      />
    );
  }

  return (
    <div className="ref-shell">
      <header className="ref-masthead">
        <h1 className="ref-wordmark">
          <span className="ref-crown">◈</span>
          Connect Reference
        </h1>
        <span className="ref-tagline">
          A conference built entirely on the public Videofy Connect SDKs.
        </span>
      </header>
      {body}
    </div>
  );
}
