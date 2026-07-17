import React, { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import type { TranslationEvent, MediaStateEvent } from '@videofy-live/shared-types';
import { SOCKET_EVENTS } from '@videofy-live/shared-types';
import styles from './App.module.css';
import { createOperatorSocketOptions } from './socketConfig';

const GATEWAY_URL = import.meta.env['VITE_GATEWAY_URL'] ?? 'http://localhost:3001';

const LANGUAGE_OPTIONS = ['fr', 'es', 'de', 'pt', 'it', 'ja', 'zh', 'ar'];

interface LatencyRow {
  label: string;
  valueMs: number | null;
}

interface PhraseLogEntry {
  id: string;
  seq: number;
  sourceText: string;
  translatedText: string;
  targetLanguage: string;
  videoTimestampMs: number;
  receivedAt: number;
  latency: {
    audioCaptureMs: number;
    transcriptionMs: number;
    translationMs: number;
    speechGenerationMs: number;
    deliveryMs: number;
    synchronizationOffsetMs: number;
  };
}

interface ServiceStatusEvent {
  service: 'gateway' | 'media-ingest' | 'speech-worker';
  status: 'healthy' | 'unhealthy';
  timestamp: string;
}

type OperatorControlAction =
  | 'start-mock-stream'
  | 'stop-mock-stream'
  | 'trigger-mock-phrase'
  | 'reset-mock-sequence';

function StatusDot({ ok }: { ok: boolean }): React.ReactElement {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: ok ? 'var(--color-success)' : 'var(--color-error)',
        marginRight: 6,
      }}
    />
  );
}

function MetricCard({
  label,
  value,
  unit = '',
}: {
  label: string;
  value: string | number;
  unit?: string;
}): React.ReactElement {
  return (
    <div className={styles.metricCard}>
      <span className={styles.metricLabel}>{label}</span>
      <span className={styles.metricValue}>
        {value}
        {unit && <span className={styles.metricUnit}>{unit}</span>}
      </span>
    </div>
  );
}

export default function App(): React.ReactElement {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  const [mediaState, setMediaState] = useState<MediaStateEvent | null>(null);
  const [streamStatus, setStreamStatus] = useState('idle');
  const [phraseLog, setPhraseLog] = useState<PhraseLogEntry[]>([]);
  const [sourceLanguage, setSourceLanguage] = useState('en');
  const [targetLanguages, setTargetLanguages] = useState<string[]>(['fr']);

  // Mix controls (UI only in this prototype)
  const [originalMix, setOriginalMix] = useState(0.2);
  const [translatedMix, setTranslatedMix] = useState(1.0);
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);

  const [gatewayOk, setGatewayOk] = useState(false);
  const [workerOk, setWorkerOk] = useState(false);
  const [ingestOk, setIngestOk] = useState(false);
  const [lastControlAck, setLastControlAck] = useState<string>('No control sent');

  const connect = useCallback((): void => {
    if (socketRef.current) return;
    const socket = io(GATEWAY_URL, createOperatorSocketOptions());
    socketRef.current = socket;

    socket.on(SOCKET_EVENTS.CONNECTED, () => {
      setConnected(true);
      setGatewayOk(true);
    });
    socket.on(SOCKET_EVENTS.DISCONNECTED, () => {
      setConnected(false);
      setGatewayOk(false);
    });
    socket.on('connect_error', () => {
      setConnected(false);
      setGatewayOk(false);
    });

    socket.on(SOCKET_EVENTS.MEDIA_STATE, (state: MediaStateEvent) => {
      setMediaState(state);
      setStreamStatus(state.streamStatus);
    });

    socket.on(SOCKET_EVENTS.STREAM_STATUS, (data: { status: string }) => {
      setStreamStatus(data.status);
    });

    socket.on(SOCKET_EVENTS.TRANSLATION_EVENT, (event: TranslationEvent) => {
      if (!event.final) return;
      const entry: PhraseLogEntry = {
        id: `${event.sequence}-${event.targetLanguage}`,
        seq: event.sequence,
        sourceText: event.sourceText,
        translatedText: event.translatedText,
        targetLanguage: event.targetLanguage,
        videoTimestampMs: event.videoTimestampMs,
        receivedAt: Date.now(),
        latency: event.latency,
      };
      setPhraseLog((prev) => [entry, ...prev].slice(0, 20));
    });

    socket.on(SOCKET_EVENTS.SERVICE_STATUS, (event: ServiceStatusEvent) => {
      const ok = event.status === 'healthy';
      if (event.service === 'gateway') setGatewayOk(ok);
      if (event.service === 'media-ingest') setIngestOk(ok);
      if (event.service === 'speech-worker') setWorkerOk(ok);
    });

    socket.on(SOCKET_EVENTS.CONTROL_ACK, (event: { action: string; accepted: boolean }) => {
      setLastControlAck(`${event.action}: ${event.accepted ? 'accepted' : 'rejected'}`);
    });
  }, []);

  const sendControl = useCallback((action: OperatorControlAction): void => {
    socketRef.current?.emit(SOCKET_EVENTS.OPERATOR_CONTROL, {
      action,
      eventId: mediaState?.eventId ?? 'demo-event',
      targetLanguage: targetLanguages[0] ?? 'fr',
    });
    setLastControlAck(`${action}: sent`);
  }, [mediaState?.eventId, targetLanguages]);

  useEffect(() => {
    connect();
    return () => {
      socketRef.current?.disconnect();
    };
  }, [connect]);

  const latencyRows: LatencyRow[] = phraseLog[0]
    ? [
        { label: 'Video delivery', valueMs: null },
        { label: 'Audio capture', valueMs: phraseLog[0].latency.audioCaptureMs },
        { label: 'Transcription', valueMs: phraseLog[0].latency.transcriptionMs },
        { label: 'Translation', valueMs: phraseLog[0].latency.translationMs },
        { label: 'Speech generation', valueMs: phraseLog[0].latency.speechGenerationMs },
        { label: 'Audio delivery', valueMs: phraseLog[0].latency.deliveryMs },
        { label: 'Sync offset', valueMs: phraseLog[0].latency.synchronizationOffsetMs },
      ]
    : [];

  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span className={styles.brandIcon}>▶</span>
          <div>
            <div className={styles.brandName}>Videofy Live</div>
            <div className={styles.brandRole}>Operator</div>
          </div>
        </div>

        <section className={styles.sideSection}>
          <h3 className={styles.sideTitle}>Services</h3>
          <div className={styles.serviceRow}>
            <StatusDot ok={gatewayOk} />
            <span>Realtime Gateway</span>
          </div>
          <div className={styles.serviceRow}>
            <StatusDot ok={ingestOk} />
            <span>Media Ingest</span>
          </div>
          <div className={styles.serviceRow}>
            <StatusDot ok={workerOk} />
            <span>Speech Worker</span>
          </div>
        </section>

        <section className={styles.sideSection}>
          <h3 className={styles.sideTitle}>Languages</h3>
          <div className={styles.langConfig}>
            <label className={styles.configLabel}>Source</label>
            <select
              className={styles.configSelect}
              value={sourceLanguage}
              onChange={(e) => setSourceLanguage(e.target.value)}
            >
              <option value="en">English</option>
              <option value="fr">Français</option>
              <option value="es">Español</option>
              <option value="de">Deutsch</option>
            </select>
          </div>
          <div className={styles.langConfig}>
            <label className={styles.configLabel}>Target channels</label>
            <div className={styles.targetLangs}>
              {LANGUAGE_OPTIONS.map((lang) => (
                <label key={lang} className={styles.langCheckbox}>
                  <input
                    type="checkbox"
                    checked={targetLanguages.includes(lang)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setTargetLanguages((prev) => [...prev, lang]);
                      } else {
                        setTargetLanguages((prev) => prev.filter((l) => l !== lang));
                      }
                    }}
                  />
                  {lang.toUpperCase()}
                </label>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.sideSection}>
          <h3 className={styles.sideTitle}>Mix</h3>
          <div className={styles.mixControl}>
            <label className={styles.configLabel}>Original {Math.round(originalMix * 100)}%</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={originalMix}
              onChange={(e) => setOriginalMix(Number(e.target.value))}
              className={styles.slider}
            />
          </div>
          <div className={styles.mixControl}>
            <label className={styles.configLabel}>Translated {Math.round(translatedMix * 100)}%</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={translatedMix}
              onChange={(e) => setTranslatedMix(Number(e.target.value))}
              className={styles.slider}
            />
          </div>
          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={subtitlesEnabled}
              onChange={(e) => setSubtitlesEnabled(e.target.checked)}
            />
            Subtitles enabled
          </label>
        </section>
      </aside>

      <main className={styles.main}>
        <div className={styles.statusBar}>
          <div className={styles.statusItem}>
            <StatusDot ok={connected} />
            <span>{connected ? 'Gateway connected' : 'Gateway disconnected'}</span>
          </div>
          <div
            className={styles.liveChip}
            style={{
              background:
                streamStatus === 'live' ? 'var(--color-success)' : 'var(--color-surface-raised)',
              color: streamStatus === 'live' ? '#000' : 'var(--color-text-muted)',
            }}
          >
            {streamStatus.toUpperCase()}
          </div>
          <div className={styles.statusItem}>
            <span>{mediaState?.connectedListeners ?? 0} listeners</span>
          </div>
          <div className={styles.statusItem}>
            <span>{targetLanguages.length} language channels</span>
          </div>
        </div>

        <section className={styles.metricsGrid}>
          <MetricCard label="Stream status" value={streamStatus} />
          <MetricCard label="Video source" value={mediaState?.videoSource ?? '—'} />
          <MetricCard
            label="Video timestamp"
            value={mediaState ? String(Math.floor(mediaState.videoTimestampMs / 1000)) : '—'}
            unit=" s"
          />
          <MetricCard
            label="Source audio"
            value={mediaState?.sourceAudioActive ? 'Active' : 'Inactive'}
          />
          <MetricCard label="Connected listeners" value={mediaState?.connectedListeners ?? 0} />
          <MetricCard label="Active channels" value={targetLanguages.length} />
          <MetricCard label="Phrases received" value={phraseLog.length} />
        </section>

        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Latency (last phrase)</h2>
          {latencyRows.length === 0 ? (
            <p className={styles.empty}>Waiting for translation events…</p>
          ) : (
            <table className={styles.latencyTable}>
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Latency</th>
                </tr>
              </thead>
              <tbody>
                {latencyRows.map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    <td className={styles.latencyValue}>
                      {row.valueMs === null ? '—' : `${row.valueMs} ms`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Translation phrase log</h2>
          {phraseLog.length === 0 ? (
            <p className={styles.empty}>No translation events received yet.</p>
          ) : (
            <div className={styles.phraseLog}>
              {phraseLog.map((entry) => (
                <div key={entry.id} className={styles.phraseEntry}>
                  <div className={styles.phraseMeta}>
                    <span className={styles.phraseSeq}>#{entry.seq}</span>
                    <span className={styles.phraseLang}>{entry.targetLanguage.toUpperCase()}</span>
                    <span className={styles.phraseTs}>
                      {Math.floor(entry.videoTimestampMs / 1000)}s
                    </span>
                  </div>
                  <div className={styles.phraseSource}>{entry.sourceText}</div>
                  <div className={styles.phraseTranslated}>{entry.translatedText}</div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Mock controls</h2>
          <p className={styles.mockNote}>
            Phase 1 mock controls. Production use requires operator authorization.
          </p>
          <p className={styles.mockNote}>{lastControlAck}</p>
          <div className={styles.mockButtons}>
            <button className={styles.mockBtn} onClick={() => sendControl('start-mock-stream')}>
              Start mock stream
            </button>
            <button className={styles.mockBtn} onClick={() => sendControl('stop-mock-stream')}>
              Stop mock stream
            </button>
            <button className={styles.mockBtn} onClick={() => sendControl('trigger-mock-phrase')}>
              Trigger mock phrase
            </button>
            <button className={styles.mockBtn} onClick={() => sendControl('reset-mock-sequence')}>
              Reset sequence
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
