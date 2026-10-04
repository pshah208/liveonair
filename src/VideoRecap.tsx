import { useEffect, useMemo, useRef, useState } from "react";
import { buildCutList, buildFfmpegScript, type CutListEntry, type CutListOptions, type HighlightReel } from "../shared/highlights.js";
import type { MatchFixture } from "../shared/types.js";
import { REEL_HEIGHT, REEL_WIDTH, renderFootageFrame, type FootageFrame, type ReelModel } from "./highlightRenderer.js";
import { downloadBlob, downloadJson, formatClock } from "./utils.js";

type VideoRecapProps = {
  fixture: MatchFixture;
  reel: HighlightReel;
  model: ReelModel;
  footage: { url: string; name: string };
  sound: boolean;
  /** Index of the clip the user picked from the clip list; nonce re-triggers the same index. */
  seekRequest: { index: number; nonce: number } | null;
  onActiveClip: (index: number) => void;
  onPlayingChange: (playing: boolean) => void;
  pickMimeType: () => string | undefined;
};

type AudioTap = { context: AudioContext; destination: MediaStreamAudioDestinationNode };

/**
 * Cuts the Video lab clip around the moments the reel selected. Video-lab fixtures run on the clip's own clock,
 * so each event second is the same second in the footage.
 */
export function VideoRecap({ fixture, reel, model, footage, sound, seekRequest, onActiveClip, onPlayingChange, pickMimeType }: VideoRecapProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const indexRef = useRef(0);
  const finishedRef = useRef<(() => void) | null>(null);
  const audioRef = useRef<AudioTap | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [exporting, setExporting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options: CutListOptions = useMemo(() => ({
    mode: "match-clock",
    kickoffOffsetSeconds: 0,
    halftimeBreakSeconds: 0,
    recordingSeconds: recordingSeconds || undefined,
    matchSeconds: fixture.durationSeconds,
    sourceFile: footage.name
  }), [recordingSeconds, fixture.durationSeconds, footage.name]);
  const cutList = useMemo(() => buildCutList(reel, options), [reel, options]);
  const clipIndexById = useMemo(() => new Map(reel.clips.map((clip, index) => [clip.id, index])), [reel]);
  const startsAt = useMemo(() => {
    let total = 0;
    return cutList.map((entry) => { const start = total; total += entry.outSeconds - entry.inSeconds; return start; });
  }, [cutList]);
  const totalSeconds = cutList.reduce((sum, entry) => sum + entry.outSeconds - entry.inSeconds, 0);

  useEffect(() => { onPlayingChange(playing); }, [playing]);
  useEffect(() => () => { void audioRef.current?.context.close(); }, []);

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
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    const video = videoRef.current;
    const time = video?.currentTime ?? 0;
    const frame = frameFor(indexRef.current, time);
    renderFootageFrame(context, model, video && video.readyState >= 2 ? video : null, frame);
    const entry = cutList[indexRef.current];
    if (frame && entry) {
      setElapsed(startsAt[indexRef.current] + Math.max(0, Math.min(time - entry.inSeconds, entry.outSeconds - entry.inSeconds)));
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

  useEffect(() => { draw(); }, [model, cutList]);

  useEffect(() => {
    if (!seekRequest) return;
    const clip = reel.clips[seekRequest.index];
    const entryIndex = cutList.findIndex((entry) => entry.clipId === clip?.id);
    if (entryIndex >= 0) seekEntry(entryIndex);
  }, [seekRequest]);

  useEffect(() => {
    const video = videoRef.current;
    if (!playing || !video) return;
    void video.play().catch(async (reason: unknown) => {
      // Browsers can refuse audible playback without a fresh click; fall back to muted rather than stalling.
      if (reason instanceof DOMException && reason.name === "NotAllowedError" && !video.muted) {
        video.muted = true;
        setError("The browser blocked sound for this playback. Press Play again to hear it.");
        await video.play().catch(() => setPlaying(false));
        return;
      }
      setError(reason instanceof Error ? reason.message : "Playback failed.");
      setPlaying(false);
    });
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

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.muted = !sound;
    if (sound) void audioRef.current?.context.resume();
  }, [sound]);

  function finish() {
    setPlaying(false);
    draw();
    finishedRef.current?.();
    finishedRef.current = null;
  }

  function onMetadata() {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    setError(null);
    setRecordingSeconds(video.duration);
  }

  function togglePlay() {
    if (!cutList.length) return;
    if (!playing) {
      setError(null);
      const video = videoRef.current;
      const entry = cutList[indexRef.current];
      if (!video || !entry) return;
      video.muted = !sound;
      if (video.currentTime < entry.inSeconds || video.currentTime >= entry.outSeconds) seekEntry(indexRef.current >= cutList.length - 1 && video.currentTime >= entry.outSeconds ? 0 : indexRef.current);
    }
    setPlaying((current) => !current);
  }

  /** Routes the clip's audio through Web Audio once, so it can be both heard and recorded. */
  function audioTap(video: HTMLVideoElement): AudioTap | null {
    if (audioRef.current) return audioRef.current;
    if (typeof AudioContext === "undefined") return null;
    try {
      const context = new AudioContext();
      const source = context.createMediaElementSource(video);
      const destination = context.createMediaStreamDestination();
      source.connect(context.destination);
      source.connect(destination);
      audioRef.current = { context, destination };
      return audioRef.current;
    } catch {
      return null;
    }
  }

  async function exportVideo() {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    const mimeType = pickMimeType();
    if (!canvas || !video || !mimeType || !cutList.length) return;
    setError(null);
    setPlaying(false);
    try {
      const stream = canvas.captureStream(30);
      const tap = sound ? audioTap(video) : null;
      if (tap) {
        await tap.context.resume();
        tap.destination.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
      }
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
      const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
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
      stream.getVideoTracks().forEach((track) => track.stop());
      const extension = mimeType.includes("mp4") ? "mp4" : "webm";
      downloadBlob(`${fixture.id}-video-recap-${reel.language}.${extension}`, new Blob(chunks, { type: mimeType.split(";")[0] }));
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
      <canvas ref={canvasRef} width={REEL_WIDTH} height={REEL_HEIGHT} className="reel__canvas" aria-label="Video recap player" />
      <video ref={videoRef} src={footage.url} className="footage__video" muted={!sound} playsInline preload="auto" onLoadedMetadata={onMetadata} onLoadedData={draw} onSeeked={draw} onError={() => setError("This browser can't play the Video lab clip. Try an MP4 (H.264) or WebM file.")} />
      <div className="reel__controls">
        <button type="button" className="button button--primary" onClick={togglePlay} disabled={exporting !== null || !cutList.length}>{playing ? "Pause" : "Play recap"}</button>
        <div className="footage__progress" aria-hidden="true"><span style={{ width: `${totalSeconds ? (elapsed / totalSeconds) * 100 : 0}%` }} /></div>
        <span className="mono">{formatClock(elapsed)} / {formatClock(totalSeconds)}</span>
      </div>
      <div className="control-row control-row--start">
        <button type="button" className="button" onClick={() => void exportVideo()} disabled={!pickMimeType() || exporting !== null || !cutList.length}>
          {exporting !== null ? `Rendering ${exporting}%` : "Export video"}
        </button>
        <button type="button" className="button" onClick={downloadCutList} disabled={!cutList.length}>Download cut list</button>
        <span className="subtle-text footage__name">{footage.name} · {formatClock(recordingSeconds)}</span>
      </div>
      {!cutList.length && recordingSeconds > 0 && <div className="banner banner--warning">None of the selected moments fall inside the clip.</div>}
      {error && <div className="banner banner--danger" role="alert">{error}</div>}
    </div>
  );
}
