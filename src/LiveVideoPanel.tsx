import { useEffect, useRef, useState } from "react";
import type { LiveStatus } from "../shared/platform.js";
import type { ProgressiveVideoSession } from "../shared/progressiveVideo.js";
import { api } from "./api.js";
import { Panel } from "./components.js";
import {
  canStartLiveVideo, confirmLiveVideoStop, decodeVideoFrame, liveVideoStopError, plannedVideoFrames, playedWatermark,
  streamLocalVideo, validateLocalVideo
} from "./liveVideo.js";
import { formatClock, getErrorMessage } from "./utils.js";
import type { VideoFootage } from "./VideoLab.js";

type Props = {
  status: LiveStatus | null;
  onStreamed: (status: LiveStatus) => void;
  onFootage: (footage: VideoFootage | null) => void;
  onSession: (session: ProgressiveVideoSession | null) => void;
  onFullUpload: () => void;
};
type Source = { file: File; url: string; controller: AbortController };
type Run = {
  controller: AbortController; source: Source; id?: string; fixtureId?: string; matchId?: string;
  previousMatchId?: string; sawOwn: boolean; showResult: boolean; cleanupFailed: boolean;
  session?: ProgressiveVideoSession;
  finished: Promise<void>; finish: () => void;
};

export function LiveVideoPanel(props: Props) {
  const callbacks = useRef(props);
  callbacks.current = props;
  const sourceRef = useRef<Source | null>(null);
  const attemptedSource = useRef<Source | null>(null);
  const runRef = useRef<Run | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const decoderRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const furthest = useRef(0);
  const clipEnd = useRef<number | null>(null);
  const mounted = useRef(true);
  const [source, setSource] = useState<Source | null>(null);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [session, setSession] = useState<ProgressiveVideoSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [rights, setRights] = useState(false);
  const [homeName, setHomeName] = useState("Home");
  const [homeKit, setHomeKit] = useState("");
  const [awayName, setAwayName] = useState("Away");
  const [awayKit, setAwayKit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [decodeError, setDecodeError] = useState(false);
  const [playPrompt, setPlayPrompt] = useState(false);

  function publish(next: ProgressiveVideoSession | null) {
    setSession(next);
    callbacks.current.onSession(next);
  }

  async function stopSession(run: Run) {
    if (!run.id) return;
    run.cleanupFailed = false;
    try {
      const result = await confirmLiveVideoStop({ id: run.id, fixtureId: run.fixtureId, matchId: run.matchId }, {
        stop: (id) => api.stopProgressiveVideo(id),
        status: () => api.getLiveStatus()
      });
      const stopped = result.session ?? (run.session && {
        ...run.session, stage: "stopped" as const, live: result.live,
        error: run.session.error ?? "Video session expired or was removed."
      });
      if (stopped && run.showResult && mounted.current && sourceRef.current === run.source && runRef.current === run) {
        // onStreamed resets the desk's match data; cleanup uses onSession and the live status feed instead.
        publish(stopped);
      }
    } catch (reason) {
      run.cleanupFailed = true;
      if (mounted.current && runRef.current === run && sourceRef.current === run.source) {
        setError((original) => liveVideoStopError(original, reason));
      }
    }
  }

  function releaseRun(run: Run) {
    if (runRef.current !== run) return;
    // Unconfirmed cleanup keeps the restart lock; Stop can explicitly try cleanup again.
    if (!run.cleanupFailed) runRef.current = null;
    if (mounted.current) setBusy(false);
  }

  async function stopRun(showResult = true) {
    const run = runRef.current;
    if (!run) return;
    run.showResult &&= showResult;
    run.controller.abort();
    if (run.cleanupFailed) {
      if (mounted.current) setBusy(true);
      await stopSession(run);
      releaseRun(run);
    } else {
      // Creation is deliberately not aborted. Wait for its response and cleanup before a restart.
      await run.finished;
    }
  }

  function releaseSource() {
    const old = sourceRef.current;
    sourceRef.current = null;
    if (old) {
      old.controller.abort();
      URL.revokeObjectURL(old.url);
    }
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void stopRun(false);
      releaseSource();
    };
  }, []);

  useEffect(() => {
    const run = runRef.current;
    const next = props.status;
    if (!run?.id || run.controller.signal.aborted || !next) return;
    const own = next.fixtureId === run.fixtureId || Boolean(run.matchId && next.matchId === run.matchId);
    if (own) run.sawOwn = true;
    else if (next.matchId && (run.sawOwn || next.matchId !== run.previousMatchId)) {
      setError("Another match is now live. This video's analysis has stopped; local playback is unchanged.");
      void stopRun();
    }
  }, [props.status, session?.id]);

  function chooseFile(file: File | undefined) {
    if (!file) return;
    void stopRun(false);
    callbacks.current.onFootage(null);
    publish(null);
    releaseSource();
    setSource(null);
    setDuration(0);
    setTime(0);
    furthest.current = 0;
    clipEnd.current = null;
    setError(null);
    setDecodeError(false);
    setPlayPrompt(false);
    try {
      validateLocalVideo(file);
      const next = { file, url: URL.createObjectURL(file), controller: new AbortController() };
      sourceRef.current = next;
      setSource(next);
    } catch (reason) { setError(getErrorMessage(reason)); }
  }

  async function play() {
    const current = sourceRef.current;
    const video = videoRef.current;
    if (!video || !current) return;
    try {
      await video.play();
      if (sourceRef.current === current && !current.controller.signal.aborted) setPlayPrompt(false);
    } catch {
      if (sourceRef.current === current && !current.controller.signal.aborted) setPlayPrompt(true);
    }
  }

  function metadata(loadedSource: Source, video: HTMLVideoElement) {
    if (sourceRef.current !== loadedSource || loadedSource.controller.signal.aborted) return;
    try {
      plannedVideoFrames(video.duration);
      setDuration(video.duration);
      void play();
    } catch (reason) {
      video.pause();
      setDecodeError(true);
      setError(getErrorMessage(reason));
    }
  }

  function mediaFailure(failedSource: Source) {
    if (sourceRef.current !== failedSource || failedSource.controller.signal.aborted) return;
    setDecodeError(true);
    setError("This browser cannot decode this video's codec. Try H.264 MP4; Video Lab also offers optional AI upload.");
    void stopRun();
  }

  function updatePlayback(ended = false) {
    const video = videoRef.current;
    if (!video || !duration) return;
    setTime(video.currentTime);
    furthest.current = playedWatermark(furthest.current, ended ? duration : video.currentTime, duration);
    if (clipEnd.current !== null && video.currentTime >= clipEnd.current) {
      video.pause();
      clipEnd.current = null;
    }
  }

  async function startAnalysis() {
    const current = sourceRef.current;
    if (!current || runRef.current || !canStartLiveVideo(ready, busy, session, callbacks.current.status)) return;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const run: Run = {
      controller: new AbortController(), source: current, previousMatchId: callbacks.current.status?.matchId,
      sawOwn: false, showResult: true, cleanupFailed: false, finished, finish
    };
    const retrying = attemptedSource.current === current;
    attemptedSource.current = current;
    runRef.current = run;
    setBusy(true);
    setError(null);
    let failed = false;
    const signal = run.controller.signal;
    const requireSession = (next: ProgressiveVideoSession | null) => {
      if (!next) throw new Error("The live video service returned an empty session.");
      return next;
    };
    try {
      if (retrying) {
        const video = videoRef.current;
        if (!video) throw new Error("The local video player is unavailable.");
        video.pause();
        video.currentTime = 0;
        furthest.current = 0;
        clipEnd.current = null;
        setTime(0);
        setPlayPrompt(false);
        publish(null);
        callbacks.current.onFootage(null);
        void play();
      }
      // Let creation resolve even after cancellation so a late-created session can be deleted by its own ID.
      const created = requireSession(await api.startProgressiveVideo({
        fileName: current.file.name, sizeBytes: current.file.size,
        contentType: /\.webm$/iu.test(current.file.name) ? "video/webm" : /\.mov$/iu.test(current.file.name) ? "video/quicktime" : "video/mp4",
        durationSeconds: duration, rightsConfirmed: true,
        request: { home: { name: homeName.trim(), kit: homeKit.trim() }, away: { name: awayName.trim(), kit: awayKit.trim() } }
      }));
      run.id = created.id;
      run.fixtureId = created.fixtureId;
      run.matchId = created.live.matchId;
      run.session = created;
      signal.throwIfAborted();
      if (runRef.current !== run || sourceRef.current !== current) return;
      publish(created);
      callbacks.current.onFootage({ fixtureId: created.fixtureId, url: current.url, name: current.file.name });
      callbacks.current.onStreamed(created.live);
      const decoder = decoderRef.current;
      const canvas = canvasRef.current;
      if (!decoder || !canvas) throw new Error("The local frame decoder is unavailable.");
      await streamLocalVideo(created, {
        get: async () => requireSession(await api.getProgressiveVideo(created.id, signal)),
        send: async (batch) => requireSession(await api.sendProgressiveBatch(created.id, batch, signal)),
        complete: async () => requireSession(await api.completeProgressiveVideo(created.id, signal)),
        extract: (frame) => decodeVideoFrame(decoder, canvas, frame, signal),
        watermark: () => furthest.current,
        update: (next) => {
          run.session = next;
          if (mounted.current && runRef.current === run && sourceRef.current === current) publish(next);
        }
      }, signal);
    } catch (reason) {
      failed = true;
      if (!signal.aborted && mounted.current && runRef.current === run && sourceRef.current === current) {
        setError(getErrorMessage(reason));
      }
    } finally {
      try {
        if (failed || signal.aborted || sourceRef.current !== current || run.session?.stage === "stopped" || run.session?.stage === "failed") {
          run.controller.abort();
          await stopSession(run);
        }
      } finally {
        releaseRun(run);
        run.finish();
      }
    }
  }

  const planned = duration ? plannedVideoFrames(duration).length : 0;
  const ready = Boolean(source && duration && rights && homeName.trim() && awayName.trim() && homeKit.trim() && awayKit.trim() && !decodeError);
  const canStart = !runRef.current && canStartLiveVideo(ready, busy, session, props.status);
  return (
    <section className="live-video-panel" aria-label="Local video and live analysis">
      <Panel eyebrow="Local playback · progressive analysis" title="Choose a video and play">
        <p className="subtle-text">MP4 / WebM / MOV, up to 15 minutes and 500 MB. The original stays in your browser in this mode. Only sampled JPEG frames go to cloud analysis, after you confirm rights and start. Playback never waits for AI.</p>
        <label className="field"><span>Select video for local playback</span><input type="file" accept=".mp4,.webm,.mov,video/mp4,video/webm,video/quicktime" onChange={(event) => { chooseFile(event.target.files?.[0]); event.target.value = ""; }} /></label>
        {source && <div className="live-video-layout">
          <div>
            <video key={source.url} className="live-video-player" ref={videoRef} src={source.url} controls autoPlay muted playsInline preload="auto"
              aria-label={`Local playback: ${source.file.name}`}
              onLoadedMetadata={(event) => metadata(source, event.currentTarget)}
              onError={() => mediaFailure(source)} onTimeUpdate={() => updatePlayback()} onSeeked={() => updatePlayback()}
              onEnded={() => updatePlayback(true)} onPlay={() => setPlayPrompt(false)} />
            <video key={`decoder-${source.url}`} ref={decoderRef} src={source.url} muted playsInline preload="auto" hidden aria-hidden="true" />
            <canvas ref={canvasRef} hidden aria-hidden="true" />
            <p className="subtle-text">{source.file.name} · Playback {formatClock(time)} / {formatClock(duration)}</p>
            {playPrompt && <p role="status">Autoplay was blocked. Click Play to start local playback.</p>}
            <button type="button" className="button" disabled={!duration || decodeError} onClick={() => { clipEnd.current = null; void play(); }}>Play</button>
          </div>
          <div className="setup">
            <fieldset disabled={busy || session?.stage === "streaming"} className="live-video-inputs">
              <legend>Before sending frames to cloud AI</legend>
              <div className="field-grid">
                <label className="field"><span>Home team</span><input maxLength={40} value={homeName} onChange={(event) => setHomeName(event.target.value)} /></label>
                <label className="field"><span>Home kit</span><input maxLength={60} placeholder="Red shirts, white shorts" value={homeKit} onChange={(event) => setHomeKit(event.target.value)} /></label>
                <label className="field"><span>Away team</span><input maxLength={40} value={awayName} onChange={(event) => setAwayName(event.target.value)} /></label>
                <label className="field"><span>Away kit</span><input maxLength={60} placeholder="Blue shirts, blue shorts" value={awayKit} onChange={(event) => setAwayKit(event.target.value)} /></label>
              </div>
              <label className="live-video-consent"><input type="checkbox" checked={rights} onChange={(event) => setRights(event.target.checked)} /> I have permission to use this video and send sampled frames to cloud AI.</label>
            </fieldset>
            <div className="live-video-actions">
              <button type="button" className="button button--primary" disabled={!canStart} onClick={() => void startAnalysis()}>{busy ? "Live analysis active" : session?.stage === "failed" || session?.stage === "stopped" ? "Retry live analysis" : "Start live analysis"}</button>
              <button type="button" className="button" disabled={!busy && !runRef.current} onClick={() => void stopRun()}>{runRef.current?.cleanupFailed ? "Retry server stop" : "Stop analysis"}</button>
            </div>
            {session && <div className="live-video-status" aria-live="polite">
              <strong>{session.stage === "streaming" ? session.inputComplete ? "Finishing queued analysis" : "Sampling as you watch" : `Analysis ${session.stage}`}</strong>
              <label>Uploaded: {session.acceptedFrames}/{planned} frames · through {formatClock(session.uploadedThrough)}<progress max={planned || 1} value={session.acceptedFrames} /></label>
              <label>Processed by AI (includes skipped graphics): {session.analyzedFrames}/{planned} frames · through {formatClock(session.analyzedThrough)}<progress max={planned || 1} value={session.analyzedFrames} /></label>
              {session.skippedFrames !== undefined && <span>Broadcast graphics skipped: {session.skippedFrames} frames</span>}
              {session.coverageNote && <span>{session.coverageNote}</span>}
              <span>AI behind current playback: {Math.max(0, time - session.analyzedThrough).toFixed(1)}s · Pending batches: {session.pendingBatches}/2</span>
              <span>Live Desk clock and stats use the analyzed watermark, not your playback position.</span>
              {session.stage === "stopped" && <span>Stopped early is not full time.</span>}
              {(session.stage === "stopped" || session.stage === "failed") && <span>Retry explicitly to analyze this same file from the beginning, once no match is running.</span>}
              {session.error && <span role="alert">{session.error}</span>}
            </div>}
          </div>
        </div>}
        <p className="banner banner--warning">AI-detected / provisional, verify goals; replay filtering is not guaranteed.</p>
        {error && <p className="banner banner--danger" role="alert">{error}</p>}
        <button type="button" className="link-button" onClick={props.onFullUpload}>Open Video Lab for tagging and detailed review →</button>
      </Panel>
    </section>
  );
}
