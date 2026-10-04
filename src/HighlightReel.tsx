import { useEffect, useMemo, useRef, useState } from "react";
import { buildCutList, buildFfmpegScript, buildHighlightReel, formatTimecode, type HighlightKind } from "../shared/highlights.js";
import type { Storyline } from "../shared/platform.js";
import type { MatchFixture } from "../shared/types.js";
import { createReelModel, readPalette, REEL_HEIGHT, REEL_WIDTH, renderReelFrame, segmentAt, type ReelModel } from "./highlightRenderer.js";
import { downloadBlob, downloadJson, formatClock } from "./utils.js";

type HighlightReelPanelProps = {
  fixture: MatchFixture;
  storylines: Storyline[];
  /** Live clock; only moments already played are eligible. */
  uptoSecond: number;
  theme: string;
};

const KIND_LABEL: Record<HighlightKind, string> = {
  goal: "Goal",
  disallowed_goal: "Goal ruled out",
  red_card: "Red card",
  big_chance: "Big chance",
  key_save: "Key save",
  booking: "Booking"
};

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
}

export function HighlightReelPanel({ fixture, storylines, uptoSecond, theme }: HighlightReelPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const modelRef = useRef<ReelModel | null>(null);
  const timeRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [exporting, setExporting] = useState<number | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [kickoffOffset, setKickoffOffset] = useState(0);
  const [halftimeBreak, setHalftimeBreak] = useState(900);
  const recorderSupported = useMemo(() => Boolean(pickMimeType()), []);

  const reel = useMemo(() => buildHighlightReel(fixture, storylines, { uptoSecond }), [fixture, storylines, uptoSecond]);
  const model = useMemo(() => (reel.clips.length > 0 ? createReelModel(fixture, reel, readPalette()) : null), [fixture, reel, theme]);
  modelRef.current = model;

  const draw = (at: number) => {
    const canvas = canvasRef.current;
    const current = modelRef.current;
    if (!canvas || !current) return;
    const context = canvas.getContext("2d");
    if (context) renderReelFrame(context, current, at);
  };

  useEffect(() => {
    timeRef.current = Math.min(timeRef.current, model?.timeline.duration ?? 0);
    setTime(timeRef.current);
    draw(timeRef.current);
  }, [model]);

  useEffect(() => {
    if (!playing || !model) return;
    let last = performance.now();
    const tick = (now: number) => {
      timeRef.current += (now - last) / 1000;
      last = now;
      if (timeRef.current >= model.timeline.duration) {
        timeRef.current = model.timeline.duration - 0.001;
        draw(timeRef.current);
        setTime(timeRef.current);
        setPlaying(false);
        return;
      }
      draw(timeRef.current);
      setTime(timeRef.current);
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [playing, model]);

  function seek(at: number) {
    timeRef.current = at;
    setTime(at);
    draw(at);
  }

  function togglePlay() {
    if (!model) return;
    if (!playing && timeRef.current >= model.timeline.duration - 0.05) seek(0);
    setPlaying((current) => !current);
  }

  async function exportVideo() {
    const canvas = canvasRef.current;
    const mimeType = pickMimeType();
    if (!canvas || !model || !mimeType) return;
    setPlaying(false);
    setExportError(null);
    setExporting(0);
    try {
      const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
      const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
      recorder.start(250);
      const started = performance.now();
      await new Promise<void>((resolve) => {
        const step = () => {
          const at = (performance.now() - started) / 1000;
          if (at >= model.timeline.duration) { draw(model.timeline.duration - 0.001); resolve(); return; }
          draw(at);
          setExporting(Math.round((at / model.timeline.duration) * 100));
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      recorder.stop();
      await stopped;
      stream.getTracks().forEach((track) => track.stop());
      const extension = mimeType.includes("mp4") ? "mp4" : "webm";
      downloadBlob(`${fixture.id}-highlights.${extension}`, new Blob(chunks, { type: mimeType.split(";")[0] }));
    } catch (error: unknown) {
      setExportError(error instanceof Error ? error.message : "Video export failed.");
    } finally {
      setExporting(null);
      seek(0);
    }
  }

  function downloadCutList() {
    const options = { kickoffOffsetSeconds: kickoffOffset, halftimeBreakSeconds: halftimeBreak };
    downloadJson(`${fixture.id}-cut-list.json`, { fixtureId: fixture.id, options, clips: reel.clips, cutList: buildCutList(reel, options) });
    downloadBlob(`${fixture.id}-cut-highlights.sh`, new Blob([buildFfmpegScript(reel, options)], { type: "text/x-shellscript" }));
  }

  const activeSegment = model ? segmentAt(model.timeline, time) : null;
  const activeClipIndex = activeSegment && "index" in activeSegment ? activeSegment.index : -1;
  const cutList = buildCutList(reel, { kickoffOffsetSeconds: kickoffOffset, halftimeBreakSeconds: halftimeBreak });

  return (
    <section className="panel reel" aria-labelledby="reel-title">
      <header className="panel__header">
        <div>
          <span className="eyebrow">Auto-generated</span>
          <h2 id="reel-title">Highlight reel</h2>
        </div>
        <div className="chips">
          <span className="tag">{reel.clips.length} moments</span>
          {model && <span className="tag">{Math.round(model.timeline.duration)} s reel</span>}
        </div>
      </header>
      <p className="lede">
        MatchLens ranks every verified event (goals, corrections, red cards, big chances, key saves) and cuts a reel around them.
        Captions come from producer-approved storylines. Synthetic matches have no footage, so the reel is rendered from the event
        data; with a licensed broadcast feed, the same cut list trims the real video.
      </p>

      {model ? (
        <div className="reel__body">
          <div className="reel__stage">
            <canvas ref={canvasRef} width={REEL_WIDTH} height={REEL_HEIGHT} className="reel__canvas" aria-label="Highlight reel player" />
            <div className="reel__controls">
              <button type="button" className="button button--primary" onClick={togglePlay} disabled={exporting !== null}>{playing ? "Pause" : "Play reel"}</button>
              <input type="range" min={0} max={model.timeline.duration} step={0.05} value={time} onChange={(event) => { setPlaying(false); seek(Number(event.target.value)); }} aria-label="Reel position" disabled={exporting !== null} />
              <span className="mono">{formatClock(time)} / {formatClock(model.timeline.duration)}</span>
            </div>
            <div className="control-row control-row--start">
              <button type="button" className="button" onClick={() => void exportVideo()} disabled={!recorderSupported || exporting !== null}>
                {exporting !== null ? `Rendering ${exporting}%` : "Export video"}
              </button>
              <button type="button" className="button" onClick={downloadCutList}>Download cut list</button>
            </div>
            {!recorderSupported && <div className="banner banner--info">This browser can't record canvas video. Use a Chromium-based browser to export.</div>}
            {exportError && <div className="banner banner--danger">{exportError}</div>}
          </div>

          <ol className="reel__clips">
            {reel.clips.map((clip, index) => (
              <li key={clip.id}>
                <button type="button" className={`clip-row${index === activeClipIndex ? " is-active" : ""}`} onClick={() => { setPlaying(false); seek(model.timeline.clipStarts[index] ?? 0); }}>
                  <span className={`clip-row__kind clip-row__kind--${clip.kind}`}>{KIND_LABEL[clip.kind]}</span>
                  <span className="clip-row__title">{clip.title}</span>
                  <span className="clip-row__caption">{clip.caption}</span>
                  <span className="clip-row__meta">
                    <span className="mono">{formatClock(clip.startSecond)}–{formatClock(clip.endSecond)}</span>
                    {clip.storylineId && <span className="tag tag--accent">storyline caption</span>}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <div className="empty-state">No highlight moments yet. Goals, big chances and corrections will appear here as the match plays.</div>
      )}

      {reel.clips.length > 0 && (
        <details className="disclosure">
          <summary>Cut real broadcast footage with this reel</summary>
          <p className="subtle-text">
            Set where kick-off happens in the recording and how long the half-time break is. The download contains the timecoded
            cut list (JSON) and an ffmpeg script that trims and joins the clips.
          </p>
          <div className="control-grid">
            <label className="field"><span>Kick-off offset (seconds)</span><input type="number" min={0} value={kickoffOffset} onChange={(event) => setKickoffOffset(Math.max(0, Number(event.target.value)))} /></label>
            <label className="field"><span>Half-time break (seconds)</span><input type="number" min={0} value={halftimeBreak} onChange={(event) => setHalftimeBreak(Math.max(0, Number(event.target.value)))} /></label>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th scope="col">Clip</th><th scope="col">In</th><th scope="col">Out</th><th scope="col">Length</th></tr></thead>
              <tbody>
                {cutList.map((entry) => (
                  <tr key={entry.clipId}>
                    <td>{entry.title}</td>
                    <td className="mono">{entry.in}</td>
                    <td className="mono">{entry.out}</td>
                    <td className="mono">{formatTimecode(entry.outSeconds - entry.inSeconds).slice(3, 8)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}
