import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { ACTION_LABEL, boxAt, playerLabel, type PlayerAnchor, type PlayerCamJob, type PlayerCamJobSummary } from "../shared/playercam.js";
import type { VideoJobStage } from "../shared/video.js";
import { api, uploadPlayerCam, type VideoHealth } from "./api.js";
import { Panel } from "./components.js";
import { readPalette } from "./highlightRenderer.js";
import { speak, speechSupported, stopSpeaking } from "./narration.js";
import { PLAYER_REEL_SIZE, renderPlayerFrame, type PlayerReelFormat } from "./playerReelRenderer.js";
import { downloadBlob, formatClock, getErrorMessage, labelize } from "./utils.js";

const TERMINAL: VideoJobStage[] = ["ready", "rejected", "failed"];
const ACCEPT = "video/mp4,video/quicktime,video/webm";
const SOUND_KEY = "matchlens.reel.sound";

const STEPS: { stage: VideoJobStage; title: string; service: string }[] = [
  { stage: "queued", title: "Upload", service: "Container Apps API" },
  { stage: "probing", title: "Probe", service: "ffprobe" },
  { stage: "extracting", title: "Reference and frames", service: "ffmpeg" },
  { stage: "analysing", title: "Find the player", service: "Azure OpenAI vision" },
  { stage: "building", title: "Build moments", service: "Deterministic rules" },
  { stage: "ready", title: "Reel ready", service: "Your browser" }
];

function stepState(job: PlayerCamJob | null, index: number): "done" | "active" | "todo" | "failed" {
  if (!job) return "todo";
  if (job.stage === "rejected" || job.stage === "failed") {
    const reached = job.frames.length > 0 ? (job.batchesDone > 0 ? 3 : 2) : job.durationSeconds ? 1 : 0;
    return index < reached ? "done" : index === reached ? "failed" : "todo";
  }
  const current = STEPS.findIndex((step) => step.stage === job.stage);
  if (index < current || job.stage === "ready") return "done";
  return index === current ? "active" : "todo";
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
}

/** Maps a click on a <video> (object-fit: contain) to 0–1 coordinates inside the picture, or null on the letterbox. */
function pointInVideo(event: MouseEvent<HTMLElement>, video: HTMLVideoElement): { x: number; y: number } | null {
  const rect = video.getBoundingClientRect();
  const vw = video.videoWidth || rect.width;
  const vh = video.videoHeight || rect.height;
  const scale = Math.min(rect.width / vw, rect.height / vh);
  const w = vw * scale;
  const h = vh * scale;
  const x = (event.clientX - rect.left - (rect.width - w) / 2) / w;
  const y = (event.clientY - rect.top - (rect.height - h) / 2) / h;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}

type AudioTap = { context: AudioContext; destination: MediaStreamAudioDestinationNode };

export function PlayerCam() {
  const [health, setHealth] = useState<VideoHealth | null>(null);
  const [attested, setAttested] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [number, setNumber] = useState("");
  const [kit, setKit] = useState("");
  const [anchor, setAnchor] = useState<PlayerAnchor | null>(null);
  const [marking, setMarking] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [job, setJob] = useState<PlayerCamJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [library, setLibrary] = useState<PlayerCamJobSummary[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [format, setFormat] = useState<PlayerReelFormat>("landscape");
  const [sound, setSound] = useState(() => localStorage.getItem(SOUND_KEY) !== "off");
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [exporting, setExporting] = useState<number | null>(null);
  const [frameIndex, setFrameIndex] = useState<number | null>(null);

  const previewRef = useRef<HTMLVideoElement | null>(null);
  const reelVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const indexRef = useRef(0);
  const focusRef = useRef(0.5);
  const rafRef = useRef<number | null>(null);
  const finishedRef = useRef<(() => void) | null>(null);
  const spokenRef = useRef(-1);
  const audioRef = useRef<AudioTap | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.getVideoHealth(controller.signal).then(setHealth).catch(() => setHealth(null));
    return () => controller.abort();
  }, []);
  useEffect(() => () => { if (fileUrl) URL.revokeObjectURL(fileUrl); }, [fileUrl]);
  useEffect(() => () => { stopSpeaking(); void audioRef.current?.context.close(); }, []);

  function refreshLibrary() {
    api.listPlayerCamJobs().then((list) => setLibrary(list ?? [])).catch(() => undefined);
  }
  useEffect(() => { refreshLibrary(); }, [job?.id, job?.stage]);

  useEffect(() => {
    if (!job || TERMINAL.includes(job.stage)) return;
    const timer = window.setInterval(() => {
      api.getPlayerCamJob(job.id).then((next) => { if (next) setJob(next); }).catch((reason: unknown) => setError(getErrorMessage(reason)));
    }, 1_200);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.stage]);

  const label = job ? playerLabel(job.request) : playerLabel({ name: name.trim() || "Player", number: number ? Number(number) : null });
  const moments = useMemo(() => (job?.moments ?? []).filter((moment) => !excluded.has(moment.id)), [job, excluded]);
  const starts = useMemo(() => {
    let total = 0;
    return moments.map((moment) => { const start = total; total += moment.endSecond - moment.startSecond; return start; });
  }, [moments]);
  const totalSeconds = moments.reduce((sum, moment) => sum + moment.endSecond - moment.startSecond, 0);
  const palette = useMemo(() => readPalette(), [job?.id, format]);

  function reset() {
    setPlaying(false);
    setJob(null);
    setFile(null);
    setFileUrl(null);
    setAnchor(null);
    setMarking(false);
    setExcluded(new Set());
    setFrameIndex(null);
    setElapsed(0);
    setActiveIndex(-1);
    indexRef.current = 0;
  }

  function chooseFile(next: File | undefined) {
    if (!next) return;
    reset();
    setError(null);
    setFile(next);
    setFileUrl(URL.createObjectURL(next));
  }

  function markPlayer(event: MouseEvent<HTMLDivElement>) {
    const video = previewRef.current;
    if (!video) return;
    const point = pointInVideo(event, video);
    if (!point) return;
    video.pause();
    setAnchor({ second: Math.round(video.currentTime * 100) / 100, ...point });
    setMarking(false);
  }

  async function startProcessing() {
    if (!file) return;
    const trimmed = name.trim();
    if (!trimmed) { setError("Give the player a name for the captions."); return; }
    const shirt = number.trim() ? Number(number) : null;
    if (shirt !== null && !(Number.isInteger(shirt) && shirt >= 1 && shirt <= 99)) { setError("Shirt number must be 1–99."); return; }
    if (!anchor && shirt === null && !kit.trim()) { setError("Click the player in the video, or give their shirt number or kit, so the worker can find them."); return; }
    setError(null);
    setUploadProgress(0);
    try {
      setJob(await uploadPlayerCam(file, { name: trimmed, number: shirt, kit: kit.trim(), anchor }, setUploadProgress));
    } catch (reason: unknown) {
      setError(getErrorMessage(reason));
    } finally {
      setUploadProgress(null);
    }
  }

  async function deleteClip(id: string) {
    setError(null);
    try {
      await api.deletePlayerCamJob(id);
      if (job?.id === id) reset();
      setConfirmDelete(null);
      refreshLibrary();
    } catch (reason: unknown) {
      setError(getErrorMessage(reason));
    }
  }

  // ---------------------------------------------------------------- reel playback

  function draw() {
    const context = canvasRef.current?.getContext("2d");
    if (!context || !job) return;
    const video = reelVideoRef.current;
    const moment = moments[indexRef.current];
    const second = video?.currentTime ?? 0;
    const box = boxAt(job.track, second);
    if (box && format === "vertical") {
      const target = (box.x + box.w / 2) / 100;
      // Ease the vertical crop towards the player so the pan feels like a camera operator, not a jump.
      focusRef.current += (target - focusRef.current) * 0.12;
    }
    const offset = moment ? Math.min(Math.max(0, second - moment.startSecond), moment.endSecond - moment.startSecond) : 0;
    renderPlayerFrame(
      context,
      format,
      video && video.readyState >= 2 ? video : null,
      moment ? { moment, index: indexRef.current, total: moments.length, second, progress: totalSeconds ? ((starts[indexRef.current] ?? 0) + offset) / totalSeconds : 0, box } : null,
      label,
      palette,
      focusRef.current
    );
    if (moment) setElapsed((starts[indexRef.current] ?? 0) + offset);
  }

  function seekMoment(index: number) {
    const video = reelVideoRef.current;
    const moment = moments[index];
    if (!video || !moment) return;
    indexRef.current = index;
    setActiveIndex(index);
    const box = job ? boxAt(job.track, moment.startSecond, 6) : undefined;
    if (box) focusRef.current = (box.x + box.w / 2) / 100;
    video.currentTime = moment.startSecond;
  }

  useEffect(() => {
    indexRef.current = 0;
    setActiveIndex(moments.length ? 0 : -1);
    if (moments[0] && reelVideoRef.current) reelVideoRef.current.currentTime = moments[0].startSecond;
    draw();
  }, [job?.id, job?.stage, moments, format]);

  useEffect(() => {
    const video = reelVideoRef.current;
    if (!playing || !video) return;
    video.muted = !sound;
    void video.play().catch(() => { video.muted = true; void video.play().catch(() => setPlaying(false)); });
    const tick = () => {
      const moment = moments[indexRef.current];
      if (!moment) { finish(); return; }
      if (video.currentTime >= moment.endSecond || video.ended) {
        if (indexRef.current + 1 >= moments.length) { finish(); return; }
        seekMoment(indexRef.current + 1);
      }
      draw();
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      video.pause();
    };
  }, [playing, moments, format]);

  useEffect(() => {
    if (reelVideoRef.current) reelVideoRef.current.muted = !sound;
    if (!sound) stopSpeaking();
  }, [sound]);

  // Commentary voice: read each moment as the reel reaches it.
  useEffect(() => {
    if (!playing || !sound || activeIndex < 0 || activeIndex === spokenRef.current) return;
    const moment = moments[activeIndex];
    if (!moment) return;
    spokenRef.current = activeIndex;
    speak(`${ACTION_LABEL[moment.action]}. ${label}.`, "en");
  }, [activeIndex, playing, sound]);
  useEffect(() => { if (!playing) { spokenRef.current = -1; stopSpeaking(); } }, [playing]);

  function finish() {
    setPlaying(false);
    draw();
    finishedRef.current?.();
    finishedRef.current = null;
  }

  function togglePlay() {
    if (!moments.length) return;
    if (!playing) {
      const video = reelVideoRef.current;
      const moment = moments[indexRef.current];
      if (video && moment && (video.currentTime < moment.startSecond || video.currentTime >= moment.endSecond)) {
        seekMoment(indexRef.current >= moments.length - 1 && video.currentTime >= moment.endSecond ? 0 : indexRef.current);
      }
    }
    setPlaying((current) => !current);
  }

  function toggleSound() {
    setSound((current) => {
      localStorage.setItem(SOUND_KEY, current ? "off" : "on");
      return !current;
    });
  }

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

  async function exportReel() {
    const canvas = canvasRef.current;
    const video = reelVideoRef.current;
    const mimeType = pickMimeType();
    if (!canvas || !video || !mimeType || !moments.length || !job) return;
    setPlaying(false);
    setError(null);
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
      const seeked = new Promise<void>((resolve) => { video.addEventListener("seeked", () => resolve(), { once: true }); window.setTimeout(resolve, 1500); });
      seekMoment(0);
      await seeked;
      const done = new Promise<void>((resolve) => { finishedRef.current = resolve; });
      recorder.start(250);
      setExporting(0);
      setPlaying(true);
      const progress = window.setInterval(() => setExporting(Math.round(((starts[indexRef.current] ?? 0) / Math.max(1, totalSeconds)) * 100)), 400);
      await done;
      window.clearInterval(progress);
      recorder.stop();
      await stopped;
      stream.getVideoTracks().forEach((track) => track.stop());
      const safeName = job.request.name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "player";
      downloadBlob(`${safeName}-player-cam-${format}.${mimeType.includes("mp4") ? "mp4" : "webm"}`, new Blob(chunks, { type: mimeType.split(";")[0] }));
    } catch (reason: unknown) {
      setError(getErrorMessage(reason));
    } finally {
      setExporting(null);
    }
  }

  function toggleMoment(id: string) {
    setPlaying(false);
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const busy = uploadProgress !== null || (job !== null && !TERMINAL.includes(job.stage));
  const unavailable = health !== null && (!health.visionConfigured || !health.ffmpeg);
  const ready = job?.stage === "ready";
  const size = PLAYER_REEL_SIZE[format];
  const seen = job ? job.sightings.filter((item) => item.visible && item.confidence >= 0.5).length : 0;
  const recorderSupported = Boolean(pickMimeType());

  return (
    <div className="recap-grid video-lab player-cam">
      <div className="desk-col">
        <Panel eyebrow="Player cam" title={ready ? `${label}: personal highlights` : "Follow one player"} aside={<span className="tag tag--accent">Beta</span>}>
          {!ready && (
            <p className="lede">
              Upload a short clip (up to 3 minutes), then click the player you want to follow, or give their shirt number and kit. The worker
              finds them in every sampled frame, works out when they are involved and cuts a personal reel with a spotlight on them. Nothing
              is sent to Eventstream; this is a fan experience, not match data.
            </p>
          )}
          {unavailable && <div className="banner banner--warning">Video processing isn't available on this server ({!health?.ffmpeg ? "ffmpeg missing" : "vision model not configured"}).</div>}

          {!fileUrl && (
            <div className="footage__intake">
              <label className="checkbox">
                <input type="checkbox" checked={attested} onChange={(event) => setAttested(event.target.checked)} />
                <span>I filmed this clip myself or have a licence to use it, and the player has agreed to be featured. It contains no Premier League, broadcaster or other third-party footage.</span>
              </label>
              <label className={`button button--primary footage__file${attested && !unavailable ? "" : " is-disabled"}`}>
                Choose video file
                <input type="file" accept={ACCEPT} disabled={!attested || unavailable} onChange={(event) => chooseFile(event.target.files?.[0])} />
              </label>
              <p className="subtle-text">Good for a kid's Sunday league match, your 5-a-side or an academy game. The clip is deleted from the server after processing; the reel plays from the copy in your browser.</p>
            </div>
          )}

          {fileUrl && !job && (
            <>
              <div className={`video-frame player-mark${marking ? " is-marking" : ""}`}>
                <video ref={previewRef} src={fileUrl} controls={!marking} playsInline className="video-frame__video" />
                {marking && <div className="player-mark__layer" onClick={markPlayer} role="presentation"><span className="player-mark__hint">Click the player</span></div>}
                {anchor && !marking && (
                  <span className="player-mark__pin" style={{ left: `${anchor.x * 100}%`, top: `${anchor.y * 100}%` }} aria-hidden="true" />
                )}
              </div>
              <div className="control-row">
                <button type="button" className={`button${marking ? " button--primary" : ""}`} onClick={() => { previewRef.current?.pause(); setMarking((current) => !current); }}>
                  {marking ? "Cancel marking" : anchor ? "Mark again" : "Mark the player"}
                </button>
                <span className="subtle-text">
                  {anchor ? `Marked at ${formatClock(anchor.second)}. The worker uses a crop around this spot as the player's reference.` : "Pause where the player is clearly visible, press Mark the player and click them. This is the most reliable way to identify them."}
                </span>
              </div>
              <div className="field-grid">
                <label className="field"><span>Player name (for captions)</span><input type="text" maxLength={40} placeholder="e.g. Maya" value={name} onChange={(event) => setName(event.target.value)} /></label>
                <label className="field"><span>Shirt number (optional)</span><input type="text" inputMode="numeric" maxLength={2} value={number} onChange={(event) => setNumber(event.target.value.replace(/\D/gu, ""))} /></label>
                <label className="field"><span>Kit (optional)</span><input type="text" maxLength={60} placeholder="e.g. red shirt, white shorts" value={kit} onChange={(event) => setKit(event.target.value)} /></label>
              </div>
              <div className="control-row">
                <button type="button" className="button button--primary" onClick={() => void startProcessing()} disabled={busy || unavailable}>
                  {uploadProgress !== null ? `Uploading ${Math.round(uploadProgress * 100)}%` : "Find the player"}
                </button>
                <button type="button" className="button button--ghost" onClick={reset} disabled={busy}>Choose another file</button>
                {file && <span className="subtle-text footage__name">{file.name} · {(file.size / 1_048_576).toFixed(1)} MB</span>}
              </div>
            </>
          )}

          {job && !ready && fileUrl && <video src={fileUrl} className="video-frame__video player-cam__waiting" muted playsInline autoPlay loop />}

          {ready && fileUrl && (
            <div className="reel__stage">
              <canvas ref={canvasRef} width={size.width} height={size.height} className={`reel__canvas player-cam__canvas player-cam__canvas--${format}`} aria-label={`Player cam reel for ${label}`} />
              <video ref={reelVideoRef} src={fileUrl} className="footage__video" muted={!sound} playsInline preload="auto" onLoadedData={draw} onSeeked={draw} />
              <div className="reel__controls">
                <button type="button" className="button button--primary" onClick={togglePlay} disabled={!moments.length || exporting !== null}>{playing ? "Pause" : "Play reel"}</button>
                <div className="footage__progress" aria-hidden="true"><span style={{ width: `${totalSeconds ? (elapsed / totalSeconds) * 100 : 0}%` }} /></div>
                <span className="mono">{formatClock(elapsed)} / {formatClock(totalSeconds)}</span>
              </div>
              <div className="control-row control-row--start">
                <div className="segmented segmented--compact" role="group" aria-label="Reel format">
                  <button type="button" className={`segmented__item${format === "landscape" ? " is-active" : ""}`} aria-pressed={format === "landscape"} onClick={() => { setPlaying(false); setFormat("landscape"); }}>Landscape 16:9</button>
                  <button type="button" className={`segmented__item${format === "vertical" ? " is-active" : ""}`} aria-pressed={format === "vertical"} onClick={() => { setPlaying(false); setFormat("vertical"); }}>Vertical 9:16</button>
                </div>
                <button type="button" className={`button button--ghost reel__sound${sound ? " is-on" : ""}`} aria-pressed={sound} onClick={toggleSound} title={speechSupported() ? "Clip audio plus a voice that calls each moment" : "Clip audio"}>{sound ? "Sound on" : "Sound off"}</button>
                <button type="button" className="button" onClick={() => void exportReel()} disabled={!recorderSupported || !moments.length || exporting !== null}>{exporting !== null ? `Rendering ${exporting}%` : "Export video"}</button>
                <button type="button" className="button button--ghost" onClick={reset} disabled={exporting !== null}>New clip</button>
              </div>
              {format === "vertical" && <p className="subtle-text">Vertical follows the player: the frame pans with them, ready for a phone or social post.</p>}
            </div>
          )}
          {job && job.stage !== "ready" && TERMINAL.includes(job.stage) && <div className="control-row"><button type="button" className="button" onClick={reset}>Try another clip</button></div>}
          {error && <div className="banner banner--danger" role="alert">{error}</div>}
        </Panel>

        {ready && (
          <Panel eyebrow="Moments" title="What made the reel" aside={<span className="tag">{moments.length} of {job.moments.length} selected</span>}>
            {job.moments.length > 0 ? (
              <ol className="reel__clips">
                {job.moments.map((moment) => {
                  const included = !excluded.has(moment.id);
                  const index = moments.findIndex((item) => item.id === moment.id);
                  return (
                    <li key={moment.id} className="player-moment">
                      <label className="player-moment__toggle"><input type="checkbox" checked={included} onChange={() => toggleMoment(moment.id)} /><span className="sr-only">Include {moment.caption}</span></label>
                      <button type="button" className={`clip-row${index === activeIndex && included ? " is-active" : ""}`} onClick={() => included && seekMoment(index)} disabled={!included}>
                        <span className="clip-row__kind clip-row__kind--big_chance">{ACTION_LABEL[moment.action]}</span>
                        <span className="clip-row__title">{moment.caption}</span>
                        <span className="clip-row__caption">{moment.description}</span>
                        <span className="clip-row__meta"><span className="mono">{formatClock(moment.startSecond)}–{formatClock(moment.endSecond)}</span><span className="tag mono">{Math.round(moment.confidence * 100)}%</span></span>
                      </button>
                      <button type="button" className="link-button" onClick={() => setFrameIndex(moment.frameIndex)}>Frame #{moment.frameIndex}</button>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <div className="empty-state">
                {seen === 0 ? "The worker couldn't find the player with enough confidence. Try again and click them in the video, or add their shirt number." : "The player was seen but never involved in the action, so there is nothing to cut yet."}
              </div>
            )}
            {frameIndex !== null && (
              <figure className="video-evidence">
                <img src={`/api/player-cam/jobs/${job.id}/frames/${frameIndex}`} alt={`Sampled frame ${frameIndex}`} />
                <figcaption className="subtle-text">Frame #{frameIndex} · exactly what the model was shown. <button type="button" className="link-button" onClick={() => setFrameIndex(null)}>Close</button></figcaption>
              </figure>
            )}
          </Panel>
        )}
      </div>

      <div className="desk-col">
        <Panel eyebrow="Player cam worker" title={job ? labelize(job.stage) : "Waiting for a clip"} aside={job && <span className="tag mono">{job.progress}%</span>}>
          <div className="footage__progress" aria-hidden="true"><span style={{ width: `${uploadProgress !== null ? uploadProgress * 100 : job?.progress ?? 0}%` }} /></div>
          <ol className="worker-steps">
            {STEPS.map((step, index) => {
              const state = uploadProgress !== null && index === 0 ? "active" : stepState(job, index);
              return (
                <li key={step.stage} className={`worker-step worker-step--${state}`}>
                  <span className="worker-step__dot" aria-hidden="true" />
                  <div>
                    <strong>{step.title}</strong>
                    <span className="pipeline__service">{step.service}</span>
                    {step.stage === "analysing" && job && job.batchesTotal > 0 && <span className="subtle-text">Batch {job.batchesDone}/{job.batchesTotal} · seen in {seen} frames</span>}
                  </div>
                </li>
              );
            })}
          </ol>
          {job?.error && <div className={`banner ${job.stage === "rejected" ? "banner--warning" : "banner--danger"}`}>{job.stage === "rejected" ? "Rejected by the footage check: " : ""}{job.error}</div>}
          {job && (
            <dl className="meta-grid">
              <div><dt>Player</dt><dd>{label}{job.request.kit ? ` · ${job.request.kit}` : ""}</dd></div>
              <div><dt>Seen</dt><dd>{job.frames.length ? `${seen} of ${job.frames.length} frames` : "—"}</dd></div>
              <div><dt>Clip</dt><dd>{job.durationSeconds ? `${job.durationSeconds} s` : "—"}</dd></div>
              <div><dt>Tokens</dt><dd className="mono">{job.usage.inputTokens.toLocaleString()} in · {job.usage.outputTokens.toLocaleString()} out</dd></div>
            </dl>
          )}
          {job?.referenceCaptured && (
            <figure className="player-cam__reference">
              <img src={`/api/player-cam/jobs/${job.id}/reference`} alt="Reference crop of the selected player" />
              <figcaption className="subtle-text">Reference the model used: the player in the yellow box.</figcaption>
            </figure>
          )}
          {job && (
            <details className="disclosure">
              <summary>Worker log ({job.log.length})</summary>
              <ol className="worker-log">{job.log.map((entry, index) => <li key={index}><span className="mono subtle-text">{new Date(entry.at).toLocaleTimeString()}</span> {entry.message}</li>)}</ol>
            </details>
          )}
        </Panel>

        <Panel eyebrow="Library" title="Player cam clips" aside={<span className="tag">{library.length}</span>}>
          {library.length > 0 ? (
            <ul className="clip-library">
              {library.map((item) => (
                <li key={item.id} className={`clip-library__item${item.id === job?.id ? " is-current" : ""}`}>
                  <div className="clip-library__main">
                    <strong>{item.playerLabel}</strong>
                    <span className="subtle-text">{item.fileName} · {new Date(item.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
                    <span className="chips chips--start">
                      <span className={`tag${item.stage === "ready" ? " tag--success" : item.stage === "failed" || item.stage === "rejected" ? " tag--danger" : ""}`}>{labelize(item.stage)}</span>
                      {item.stage === "ready" && <span className="tag">{item.momentCount} moments</span>}
                    </span>
                  </div>
                  {confirmDelete === item.id ? (
                    <div className="clip-library__actions">
                      <button type="button" className="button button--small button--danger" onClick={() => void deleteClip(item.id)}>Delete</button>
                      <button type="button" className="button button--small button--ghost" onClick={() => setConfirmDelete(null)}>Cancel</button>
                    </div>
                  ) : (
                    <button type="button" className="button button--small button--ghost" onClick={() => setConfirmDelete(item.id)} disabled={!TERMINAL.includes(item.stage)} aria-label={`Delete ${item.playerLabel} (${item.fileName})`}>Delete</button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty-state">No Player cam clips yet.</div>
          )}
        </Panel>

        <Panel eyebrow="Honest limits" title="What Player cam can and can't do">
          <ul className="plain-list">
            <li>It checks one frame every 1–3 seconds, so the spotlight glides between sightings rather than tracking every step.</li>
            <li>Clicking the player is far more reliable than a number alone: numbers are often unreadable on fan footage.</li>
            <li>Team-mates in the same kit can be confused when the player is far away or turned around; untick any wrong moment.</li>
            <li>Only sightings at 50% confidence or more count. Moments are grouped and ranked by code, not by the model.</li>
            <li>Feature only players who have agreed, and get a parent's consent for children.</li>
          </ul>
        </Panel>
      </div>
    </div>
  );
}
