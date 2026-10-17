import { useEffect, useId, useMemo, useRef, useState } from "react";
import { buildCutList, buildFfmpegScript, buildHighlightReel, type HighlightClip, type HighlightKind } from "../shared/highlights.js";
import type { Storyline } from "../shared/platform.js";
import type { Language, MatchFixture } from "../shared/types.js";
import { createReelModel, readPalette, REEL_HEIGHT, REEL_WIDTH, renderReelFrame, segmentAt, type ReelModel } from "./highlightRenderer.js";
import { speechSupported, useHighlightCommentary } from "./narration.js";
import { downloadBlob, downloadJson, formatClock, LANGUAGE_LABEL, LANGUAGES } from "./utils.js";
import { VideoRecap } from "./VideoRecap.js";

type HighlightReelPanelProps = {
  fixture: MatchFixture;
  storylines: Storyline[];
  /** Live clock; only moments already played are eligible. */
  uptoSecond: number;
  theme: string;
  /** The Video lab clip behind this fixture, when there is one. */
  footage: { url: string; name: string } | null;
  onOpenVideoLab: () => void;
  /** Keeps only matching moments (e.g. Fan View's favourite club or player); selection itself is unchanged. */
  clipFilter?: (clip: HighlightClip) => boolean;
  title?: string;
  /** Replaces the default explanation under the title. */
  intro?: React.ReactNode;
  initialLanguage?: Language;
};

const SOUND_KEY = "matchlens.reel.sound";

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

export function HighlightReelPanel({ fixture, storylines, uptoSecond, theme, footage, onOpenVideoLab, clipFilter, title, intro, initialLanguage = "en" }: HighlightReelPanelProps) {
  const titleId = useId();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const modelRef = useRef<ReelModel | null>(null);
  const timeRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [exporting, setExporting] = useState<number | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [footageClip, setFootageClip] = useState(-1);
  const [footagePlaying, setFootagePlaying] = useState(false);
  const [seekRequest, setSeekRequest] = useState<{ index: number; nonce: number } | null>(null);
  const [language, setLanguage] = useState<Language>(initialLanguage);
  const [sound, setSound] = useState(() => localStorage.getItem(SOUND_KEY) !== "off");
  const recorderSupported = useMemo(() => Boolean(pickMimeType()), []);
  const voiceSupported = useMemo(() => speechSupported(), []);
  const source: "data" | "footage" = footage ? "footage" : "data";

  const reel = useMemo(() => {
    const built = buildHighlightReel(fixture, storylines, { uptoSecond, language });
    if (!clipFilter) return built;
    const clips = built.clips.filter(clipFilter);
    return { ...built, clips, totalMatchSeconds: clips.reduce((sum, clip) => sum + (clip.endSecond - clip.startSecond), 0) };
  }, [fixture, storylines, uptoSecond, language, clipFilter]);
  const commentary = useHighlightCommentary(reel, sound);
  const model = useMemo(() => (reel.clips.length > 0 ? createReelModel(fixture, reel, readPalette(), commentary.durations) : null), [fixture, reel, theme, commentary.durations]);
  modelRef.current = model;
  const [preparing, setPreparing] = useState(false);
  const lastCueRef = useRef<string | null>(null);

  function toggleSound() {
    setSound((current) => {
      localStorage.setItem(SOUND_KEY, current ? "off" : "on");
      return !current;
    });
  }

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

  // Canvas text uses IBM Plex; redraw once the web font has loaded.
  useEffect(() => { void document.fonts?.ready.then(() => draw(timeRef.current)); }, []);

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
    if (playing) { setPlaying(false); return; }
    if (timeRef.current >= model.timeline.duration - 0.05) seek(0);
    if (!sound) { setPlaying(true); return; }
    setPreparing(true);
    void commentary.prepare().finally(() => { setPreparing(false); setPlaying(true); });
  }

  /** Commentary cue for a reel time: the intro, a clip's line, or the outro. */
  function cueAt(current: ReelModel, at: number): string {
    const segment = segmentAt(current.timeline, at);
    return "clip" in segment ? segment.clip.id : segment.kind;
  }

  async function exportVideo() {
    const canvas = canvasRef.current;
    const mimeType = pickMimeType();
    if (!canvas || !modelRef.current || !mimeType) return;
    setPlaying(false);
    setExportError(null);
    setExporting(0);
    try {
      if (sound) await commentary.prepare();
      // Preparing commentary can re-pace the reel to fit each voice line.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const model = modelRef.current;
      if (!model) return;
      const stream = canvas.captureStream(30);
      const voice = sound ? commentary.player.recordStream() : null;
      voice?.getAudioTracks().forEach((track) => stream.addTrack(track));
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
      const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
      recorder.start(250);
      const started = performance.now();
      let lastCue: string | null = null;
      await new Promise<void>((resolve) => {
        const step = () => {
          const at = (performance.now() - started) / 1000;
          if (at >= model.timeline.duration) { draw(model.timeline.duration - 0.001); resolve(); return; }
          draw(at);
          const cue = cueAt(model, at);
          if (sound && cue !== lastCue) { lastCue = cue; commentary.cue(cue); }
          setExporting(Math.round((at / model.timeline.duration) * 100));
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      commentary.stop();
      recorder.stop();
      await stopped;
      stream.getVideoTracks().forEach((track) => track.stop());
      const extension = mimeType.includes("mp4") ? "mp4" : "webm";
      downloadBlob(`${fixture.id}-highlights-${language}.${extension}`, new Blob(chunks, { type: mimeType.split(";")[0] }));
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

  useEffect(() => { setPlaying(false); }, [source]);

  const activeSegment = model ? segmentAt(model.timeline, time) : null;
  const activeClipIndex = source === "footage" ? footageClip : activeSegment && "index" in activeSegment ? activeSegment.index : -1;
  const cueActive = sound && (source === "footage" ? footagePlaying : playing && exporting === null);
  // Footage plays its own build-up, so only clip lines are voiced there; the data reel adds intro and outro.
  const cueKey = source === "footage"
    ? reel.clips[footageClip]?.id ?? null
    : model && activeSegment ? cueAt(model, time) : null;

  useEffect(() => {
    if (!cueActive) {
      if (exporting === null) commentary.stop();
      lastCueRef.current = null;
      return;
    }
    if (!cueKey || cueKey === lastCueRef.current) return;
    lastCueRef.current = cueKey;
    commentary.cue(cueKey);
  }, [cueActive, cueKey]);

  const voiceLabel = commentary.status === "ready"
    ? "Broadcast commentary: lines written by the Foundry commentator, voiced with Azure neural voices"
    : voiceSupported ? "Commentary voice; uses the browser voice when neural commentary is unavailable" : "This browser has no speech voice; sound only affects clip audio";

  const soundButton = (
    <button type="button" className={`button button--ghost reel__sound${sound ? " is-on" : ""}`} aria-pressed={sound} onClick={toggleSound} title={voiceLabel}>
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 6h2.5L8 3v10L4.5 10H2z" fill="currentColor" />
        {sound ? <path d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6.5 6.5 0 0 1 0 9" /> : <path d="M10.5 6l4 4M14.5 6l-4 4" />}
      </svg>
      {sound ? "Sound on" : "Sound off"}
    </button>
  );

  return (
    <section className="panel reel" aria-labelledby={titleId}>
      <header className="panel__header">
        <div>
          <span className="eyebrow">Auto-generated</span>
          <h2 id={titleId}>{title ?? (source === "footage" ? "Video recap" : "Highlight reel")}</h2>
        </div>
        <div className="chips">
          <span className="tag">{reel.clips.length} {reel.clips.length === 1 ? "moment" : "moments"}</span>
          {model && <span className="tag">{Math.round(source === "footage" ? reel.totalMatchSeconds : model.timeline.duration)} s</span>}
          {soundButton}
          {sound && commentary.status === "loading" && <span className="tag">Writing commentary…</span>}
          {sound && commentary.status === "ready" && <span className="tag tag--accent" title="Written from the verified event feed by the Foundry commentator and voiced with Azure AI Speech">Neural commentary</span>}
          {sound && commentary.status === "fallback" && <span className="tag" title={commentary.error ?? "Neural commentary is unavailable; the browser voice reads captions"}>Browser voice</span>}
          <label className="inline-select"><span className="sr-only">Reel language</span><select value={language} onChange={(event) => setLanguage(event.target.value as Language)}>{LANGUAGES.map((item) => <option key={item} value={item}>{LANGUAGE_LABEL[item]}</option>)}</select></label>
        </div>
      </header>
      {intro ? <div className="lede">{intro}</div> : source === "footage" ? (
        <p className="lede">
          Cut automatically from your Video lab clip. Live on Air ranks the events the video worker and your Video lab tags found, takes each moment
          from the footage, and always keeps goals, red cards and approved storylines, captioned with the copy approved on the live desk.
        </p>
      ) : (
        <p className="lede">
          Live on Air ranks every verified event and cuts a reel around them. Every goal, red card, ruled-out goal and
          producer-approved storyline is always included, captioned with the approved copy. This match is synthetic, so the reel is drawn from the event data.{" "}
          <button type="button" className="link-button" onClick={onOpenVideoLab}>Tag moments in Video lab</button> to cut a pundit reel from your own footage.
        </p>
      )}

      {model ? (
        <div className="reel__body">
          {footage ? (
            <VideoRecap fixture={fixture} reel={reel} model={model} footage={footage} sound={sound} seekRequest={seekRequest} onActiveClip={setFootageClip} onPlayingChange={setFootagePlaying} pickMimeType={pickMimeType} commentary={commentary} />
          ) : (
          <div className="reel__stage">
            <canvas ref={canvasRef} width={REEL_WIDTH} height={REEL_HEIGHT} className="reel__canvas" aria-label="Highlight reel player" />
            <div className="reel__controls">
              <button type="button" className="button button--primary" onClick={togglePlay} disabled={exporting !== null || preparing}>{preparing ? "Preparing commentary…" : playing ? "Pause" : "Play reel"}</button>
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
                  {sound && commentary.lineText(clip.id) && <span className="clip-row__commentary">“{commentary.lineText(clip.id)}”</span>}
                  <span className="clip-row__meta">
                    <span className="mono">{formatClock(clip.startSecond)}–{formatClock(clip.endSecond)}</span>
                    {clip.storylineId && (storylines.find((item) => item.id === clip.storylineId)?.status === "approved"
                      ? <span className="tag tag--accent">Approved storyline</span>
                      : <span className="tag">Storyline draft</span>)}
                    {clip.captionLanguage !== reel.language && <span className="tag" title="The localizer agent has no translation for this storyline yet">English fallback</span>}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <div className="empty-state">{source === "footage" ? "No recap moments in this clip yet. They appear as the live video analysis detects goals, cards and chances." : "No highlight moments yet. Goals, big chances and corrections will appear here as the match plays."}</div>
      )}
    </section>
  );
}
