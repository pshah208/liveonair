import { useMemo, useState } from "react";
import type { HighlightReel } from "../shared/highlights.js";
import type { MatchFixture } from "../shared/types.js";
import { clipTitle, createReelModel, readPalette } from "./highlightRenderer.js";
import { speechSupported, useHighlightCommentary } from "./narration.js";
import { formatClock } from "./utils.js";
import { VideoRecap } from "./VideoRecap.js";

export type LabHighlights = { fixture: MatchFixture; reel: HighlightReel; footage: { url: string; name: string } };

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
}

/** A highlight reel cut from the pundit's own footage around the moments they tagged in Video Lab. */
export function LabHighlightReel({ lab, theme, onEdit, onClose }: { lab: LabHighlights; theme: string; onEdit: () => void; onClose: () => void }) {
  const [sound, setSound] = useState(false);
  const [activeClip, setActiveClip] = useState(-1);
  const [seekRequest, setSeekRequest] = useState<{ index: number; nonce: number } | null>(null);
  const commentary = useHighlightCommentary(lab.reel, sound, false);
  const model = useMemo(() => ({ ...createReelModel(lab.fixture, lab.reel, readPalette()), subtitle: "VIDEO LAB · TAGGED BY THE ANALYST" }), [lab, theme]);

  return (
    <section className="panel reel lab-reel" aria-labelledby="lab-reel-title">
      <header className="panel__header">
        <div>
          <span className="eyebrow">From Video Lab</span>
          <h2 id="lab-reel-title">Pundit highlights · {lab.fixture.title}</h2>
        </div>
        <div className="chips">
          <span className="tag">{lab.reel.clips.length} {lab.reel.clips.length === 1 ? "moment" : "moments"}</span>
          <span className="tag">{Math.round(lab.reel.totalMatchSeconds)} s</span>
          {speechSupported() && (
            <button type="button" className={`button button--ghost reel__sound${sound ? " is-on" : ""}`} aria-pressed={sound} onClick={() => setSound((value) => !value)} title="Reads each moment's notes with the browser voice">
              {sound ? "Voice-over on" : "Voice-over off"}
            </button>
          )}
          <button type="button" className="button button--ghost" onClick={onEdit}>Edit tags</button>
          <button type="button" className="button button--ghost" onClick={onClose} aria-label="Close Video Lab highlights">Close</button>
        </div>
      </header>
      <p className="lede">Cut from <strong>{lab.footage.name}</strong> around the moments you tagged, in clip order, with your tag, players and notes on screen. Tagged goals update the scorebug.</p>
      <div className="reel__body">
        <VideoRecap fixture={lab.fixture} reel={lab.reel} model={model} footage={lab.footage} sound={sound} seekRequest={seekRequest}
          onActiveClip={setActiveClip} onPlayingChange={() => undefined} pickMimeType={pickMimeType} commentary={commentary} />
        <ol className="reel__clips">
          {lab.reel.clips.map((clip, index) => (
            <li key={clip.id}>
              <button type="button" className={`clip-row${index === activeClip ? " is-active" : ""}`} onClick={() => setSeekRequest({ index, nonce: Date.now() })}>
                <span className={`clip-row__kind clip-row__kind--${clip.kind}`}>{clip.label ?? clip.kind}</span>
                <span className="clip-row__title">{clipTitle(clip)}</span>
                <span className="clip-row__caption">{clip.caption}</span>
                <span className="clip-row__meta"><span className="mono">{formatClock(clip.startSecond)}–{formatClock(clip.endSecond)}</span></span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
