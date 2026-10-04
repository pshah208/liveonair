import { useEffect, useMemo, useRef, useState } from "react";
import { buildCutList, buildFfmpegScript, formatTimecode, type CutListEntry, type CutListMode, type CutListOptions, type HighlightReel } from "../shared/highlights.js";
import type { MatchFixture } from "../shared/types.js";
import { REEL_HEIGHT, REEL_WIDTH, renderFootageFrame, type FootageFrame, type ReelModel } from "./highlightRenderer.js";
import { downloadBlob, downloadJson, formatClock } from "./utils.js";

type FootageReelProps = {
  fixture: MatchFixture;
  reel: HighlightReel;
  model: ReelModel;
  /** Index of the clip the user picked from the clip list; nonce re-triggers the same index. */
  seekRequest: { index: number; nonce: number } | null;
  onActiveClip: (index: number) => void;
  pickMimeType: () => string | undefined;
};

/** Recordings shorter than this are treated as short clips and use fit mode by default. */
const FULL_MATCH_MIN_SECONDS = 80 * 60;

export function FootageReel({ fixture, reel, model, seekRequest, onActiveClip, pickMimeType }: FootageReelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const indexRef = useRef(0);
  const finishedRef = useRef<(() => void) | null>(null);
  const [attested, setAttested] = useState(false);
  const [source, setSource] = useState<{ url: string; name: string } | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [mode, setMode] = useState<CutListMode>("fit");
  const [kickoffOffset, setKickoffOffset] = useState(0);
  const [halftimeBreak, setHalftimeBreak] = useState(900);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [exporting, setExporting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options: CutListOptions = useMemo(() => ({
    mode,
    kickoffOffsetSeconds: kickoffOffset,
    halftimeBreakSeconds: mode === "match-clock" ? halftimeBreak : 0,
    recordingSeconds: recordingSeconds || undefined,
    matchSeconds: fixture.durationSeconds,
    sourceFile: source?.name
  }), [mode, kickoffOffset, halftimeBreak, recordingSeconds, fixture.durationSeconds, source?.name]);
  const cutList = useMemo(() => buildCutList(reel, options), [reel, options]);
  const clipIndexById = useMemo(() => new Map(reel.clips.map((clip, index) => [clip.id, index])), [reel]);
  const startsAt = useMemo(() => {
    let total = 0;
    return cutList.map((entry) => { const start = total; total += entry.outSeconds - entry.inSeconds; return start; });
  }, [cutList]);
  const totalSeconds = cutList.reduce((sum, entry) => sum + entry.outSeconds - entry.inSeconds, 0);

  useEffect(() => () => { if (source) URL.revokeObjectURL(source.url); }, [source]);

  function frameFor(entryIndex: number, videoTime: number): FootageFrame | null {
    const entry: CutListEntry | undefined = cutList[entryIndex];
    if (!entry) return null;
    const clipIndex = clipIndexById.get(entry.clipId) ?? 0;
    const offset = Math.min(Math.max(0, videoTime - entry.inSeconds), entry.outSeconds - entry.inSeconds);
    return {
      clip: reel.clips[clipIndex],
      clipIndex,
      clipCount: reel.clips.length,
      matchSecond: entry.matchInSeconds + offset,
      progress: totalSeconds > 0 ? (startsAt[entryIndex] + offset) / totalSeconds : 0
    };
  }

  function draw() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!context) return;
    const video = videoRef.current;
    const time = video?.currentTime ?? 0;
    const frame = source ? frameFor(indexRef.current, time) : null;
    renderFootageFrame(context, model, source && video && video.readyState >= 2 ? video : null, frame);
    if (frame) {
      setElapsed(startsAt[indexRef.current] + Math.max(0, Math.min(time - cutList[indexRef.current].inSeconds, cutList[indexRef.current].outSeconds - cutList[indexRef.current].inSeconds)));
      onActiveClip(frame.clipIndex);
    }
  }

  function seekEntry(entryIndex: number) {
    const video = videoRef.current;
    const entry = cutList[entryIndex];
    if (!video || !entry) return;
    indexRef.current = entryIndex;
    video.currentTime = entry.inSeconds;
  }

  useEffect(() => { draw(); }, [model, cutList, source]);

  useEffect(() => {
    if (!seekRequest) return;
    const clip = reel.clips[seekRequest.index];
    const entryIndex = cutList.findIndex((entry) => entry.clipId === clip?.id);
    if (entryIndex >= 0) seekEntry(entryIndex);
  }, [seekRequest]);

  useEffect(() => {
    const video = videoRef.current;
    if (!playing || !video) return;
    void video.play().catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : "Playback failed."); setPlaying(false); });
    const tick = () => {
      const entry = cutList[indexRef.current];
      if (!entry) { finish(); return; }
      if (video.currentTime >= entry.outSeconds || video.ended) {
        if (indexRef.current + 1 >= cutList.length) { finish(); return; }
        seekEntry(indexRef.current + 1);
      }
      draw();
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      video.pause();
    };
  }, [playing, cutList]);

  function finish() {
    setPlaying(false);
    draw();
    finishedRef.current?.();
    finishedRef.current = null;
  }

  function loadFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setPlaying(false);
    indexRef.current = 0;
    setSource({ url: URL.createObjectURL(file), name: file.name });
  }

  function onMetadata() {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    setError(null);
    setRecordingSeconds(video.duration);
    setMode(video.duration >= FULL_MATCH_MIN_SECONDS ? "match-clock" : "fit");
  }

  function togglePlay() {
    if (!cutList.length) return;
    if (!playing) {
      const video = videoRef.current;
      const entry = cutList[indexRef.current];
      if (!video || !entry) return;
      if (video.currentTime < entry.inSeconds || video.currentTime >= entry.outSeconds) seekEntry(indexRef.current >= cutList.length - 1 && video.currentTime >= entry.outSeconds ? 0 : indexRef.current);
    }
    setPlaying((current) => !current);
  }

  async function exportVideo() {
    const canvas = canvasRef.current;
    const mimeType = pickMimeType();
    if (!canvas || !mimeType || !cutList.length) return;
    setError(null);
    setPlaying(false);
    try {
      const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
      const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
      const video = videoRef.current;
      if (!video) return;
      const target = cutList[0].inSeconds;
      if (Math.abs(video.currentTime - target) > 0.01) {
        const seeked = new Promise<void>((resolve) => {
          video.addEventListener("seeked", () => resolve(), { once: true });
          window.setTimeout(resolve, 2000);
        });
        seekEntry(0);
        await seeked;
      } else indexRef.current = 0;
      const done = new Promise<void>((resolve) => { finishedRef.current = resolve; });
      recorder.start(250);
      setExporting(0);
      setPlaying(true);
      const progress = window.setInterval(() => setExporting(Math.round(((startsAt[indexRef.current] ?? 0) / Math.max(1, totalSeconds)) * 100)), 400);
      await done;
      window.clearInterval(progress);
      recorder.stop();
      await stopped;
      stream.getTracks().forEach((track) => track.stop());
      const extension = mimeType.includes("mp4") ? "mp4" : "webm";
      downloadBlob(`${fixture.id}-footage-highlights-${reel.language}.${extension}`, new Blob(chunks, { type: mimeType.split(";")[0] }));
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Video export failed.");
    } finally {
      setExporting(null);
    }
  }

  function downloadCutList() {
    downloadJson(`${fixture.id}-cut-list.json`, { fixtureId: fixture.id, options, clips: reel.clips, cutList });
    downloadBlob(`${fixture.id}-cut-highlights.sh`, new Blob([buildFfmpegScript(reel, options)], { type: "text/x-shellscript" }));
  }

  return (
    <div className="reel__stage">
      <canvas ref={canvasRef} width={REEL_WIDTH} height={REEL_HEIGHT} className="reel__canvas" aria-label="Footage highlight player" />
      {source && (
        <video ref={videoRef} src={source.url} className="footage__video" muted playsInline preload="auto" onLoadedMetadata={onMetadata} onLoadedData={draw} onSeeked={draw} onError={() => setError("This browser can't play that file. Try an MP4 (H.264) or WebM video.")} />
      )}

      {!source ? (
        <div className="footage__intake">
          <label className="checkbox">
            <input type="checkbox" checked={attested} onChange={(event) => setAttested(event.target.checked)} />
            <span>I filmed this footage myself or have a licence to use it. It contains no Premier League, broadcaster or other third-party footage.</span>
          </label>
          <label className={`button button--primary footage__file${attested ? "" : " is-disabled"}`}>
            Choose video file
            <input type="file" accept="video/*" disabled={!attested} onChange={(event) => loadFile(event.target.files?.[0])} />
          </label>
          <p className="subtle-text">
            The file stays in your browser and is never uploaded. Good sources: your own 5-a-side recording, or CC0 stock clips with no club
            or league branding. The overlays come from the synthetic match events, so names and score are fictional.
          </p>
        </div>
      ) : (
        <>
          <div className="reel__controls">
            <button type="button" className="button button--primary" onClick={togglePlay} disabled={exporting !== null || !cutList.length}>{playing ? "Pause" : "Play reel"}</button>
            <div className="footage__progress" aria-hidden="true"><span style={{ width: `${totalSeconds ? (elapsed / totalSeconds) * 100 : 0}%` }} /></div>
            <span className="mono">{formatClock(elapsed)} / {formatClock(totalSeconds)}</span>
          </div>
          <div className="control-row control-row--start">
            <button type="button" className="button" onClick={() => void exportVideo()} disabled={!pickMimeType() || exporting !== null || !cutList.length}>
              {exporting !== null ? `Rendering ${exporting}%` : "Export video"}
            </button>
            <button type="button" className="button" onClick={downloadCutList} disabled={!cutList.length}>Download cut list</button>
            <button type="button" className="button button--ghost" onClick={() => { setPlaying(false); setSource(null); setRecordingSeconds(0); }} disabled={exporting !== null}>Remove footage</button>
            <span className="subtle-text footage__name">{source.name} · {formatClock(recordingSeconds)}</span>
          </div>
          <div className="control-grid">
            <div className="field">
              <span>How the recording maps to the match</span>
              <div className="segmented" role="group" aria-label="Time mapping">
                <button type="button" className={`segmented__item${mode === "fit" ? " is-active" : ""}`} onClick={() => setMode("fit")} aria-pressed={mode === "fit"}>Fit to clip</button>
                <button type="button" className={`segmented__item${mode === "match-clock" ? " is-active" : ""}`} onClick={() => setMode("match-clock")} aria-pressed={mode === "match-clock"}>Full match clock</button>
              </div>
            </div>
            <label className="field"><span>Kick-off offset (seconds)</span><input type="number" min={0} value={kickoffOffset} onChange={(event) => setKickoffOffset(Math.max(0, Number(event.target.value)))} /></label>
            {mode === "match-clock" && (
              <label className="field"><span>Half-time break (seconds)</span><input type="number" min={0} value={halftimeBreak} onChange={(event) => setHalftimeBreak(Math.max(0, Number(event.target.value)))} /></label>
            )}
          </div>
          <p className="subtle-text">
            {mode === "fit"
              ? "Fit to clip spreads the key moments across your recording in match order and plays them in real time, trimming clips evenly when the recording is short. Use it for short or generic footage."
              : "Full match clock assumes the recording runs in real match time from kick-off, so each clip lands on the exact moment."}
            {cutList.length < reel.clips.length && ` ${reel.clips.length - cutList.length} moment(s) fall outside this recording and are skipped.`}
          </p>
          {!cutList.length && <div className="banner banner--warning">No moments fit inside this recording. Lower the kick-off offset or switch to Fit to clip.</div>}
          {error && <div className="banner banner--danger">{error}</div>}
          <details className="disclosure">
            <summary>Cut list ({cutList.length} clips)</summary>
            <div className="table-scroll">
              <table className="data-table">
                <thead><tr><th scope="col">Clip</th><th scope="col">In</th><th scope="col">Out</th><th scope="col">Length</th></tr></thead>
                <tbody>
                  {cutList.map((entry, index) => (
                    <tr key={entry.clipId}>
                      <td><button type="button" className="link-button" onClick={() => seekEntry(index)}>{entry.title}</button></td>
                      <td className="mono">{entry.in}</td>
                      <td className="mono">{entry.out}</td>
                      <td className="mono">{formatTimecode(entry.outSeconds - entry.inSeconds).slice(3, 8)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
