import { useEffect, useMemo, useRef, useState } from "react";
import { buildCutList, buildFfmpegScript, buildHighlightReel, type HighlightKind } from "../shared/highlights.js";
import type { Storyline } from "../shared/platform.js";
import type { MatchFixture } from "../shared/types.js";
import { FootageReel } from "./FootageReel.js";
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
  const [source, setSource] = useState<"data" | "footage">("data");
  const [footageClip, setFootageClip] = useState(-1);
  const [seekRequest, setSeekRequest] = useState<{ index: number; nonce: number } | null>(null);
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

  useEffect(() => { if (source === "data") draw(timeRef.current); }, [source]);

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
    downloadJson(`${fixture.id}-cut-list.json`, { fixtureId: fixture.id, options: {}, clips: reel.clips, cutList: buildCutList(reel) });
    downloadBlob(`${fixture.id}-cut-highlights.sh`, new Blob([buildFfmpegScript(reel)], { type: "text/x-shellscript" }));
  }

  function pickClip(index: number) {
    if (!model) return;
    if (source === "footage") { setSeekRequest({ index, nonce: Date.now() }); return; }
    setPlaying(false);
    seek(model.timeline.clipStarts[index] ?? 0);
  }

  function switchSource(next: "data" | "footage") {
    setPlaying(false);
    setSource(next);
  }

  const activeSegment = model ? segmentAt(model.timeline, time) : null;
  const activeClipIndex = source === "footage" ? footageClip : activeSegment && "index" in activeSegment ? activeSegment.index : -1;

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
        Captions come from producer-approved storylines. Render it from the event data, or drop in footage you own and MatchLens
        cuts it and lays the same overlays on top.
      </p>

      {model ? (
        <>
        <div className="segmented segmented--compact reel__source" role="group" aria-label="Reel source">
          <button type="button" className={`segmented__item${source === "data" ? " is-active" : ""}`} aria-pressed={source === "data"} onClick={() => switchSource("data")}>Data-rendered</button>
          <button type="button" className={`segmented__item${source === "footage" ? " is-active" : ""}`} aria-pressed={source === "footage"} onClick={() => switchSource("footage")}>Your footage</button>
        </div>
        <div className="reel__body">
          {source === "footage" ? (
            <FootageReel fixture={fixture} reel={reel} model={model} seekRequest={seekRequest} onActiveClip={setFootageClip} pickMimeType={pickMimeType} />
          ) : (
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
          )}

          <ol className="reel__clips">
            {reel.clips.map((clip, index) => (
              <li key={clip.id}>
                <button type="button" className={`clip-row${index === activeClipIndex ? " is-active" : ""}`} onClick={() => pickClip(index)}>
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
        </>
      ) : (
        <div className="empty-state">No highlight moments yet. Goals, big chances and corrections will appear here as the match plays.</div>
      )}
    </section>
  );
}
