import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { MAX_UPLOAD_BYTES, MAX_VIDEO_SECONDS } from "../shared/video.js";
import {
  CATEGORIES, CATEGORY_GROUPS, CATEGORY_LABELS, MAX_ANNOTATIONS, MAX_LAB_JSON_BYTES, annotationsCsv, defaultFilters, deriveStats,
  filterAnnotations, labHighlightReel, labStorageKey, paddedRange, parseLabReport,
  serializeLabReport, validateAnnotations, validateFilters, validateSource,
  type Annotation, type Category, type Filters, type LabReport, type LabSource, type Outcome, type Team,
} from "../shared/videoLab.js";
import type { LabHighlights } from "./LabHighlightReel.js";
import "./videoLab.css";

export type VideoFootage = { fixtureId: string; url: string; name: string };
type Props = { active: boolean; onHighlights: (highlights: LabHighlights | null) => void };
type Document = { source: LabSource; annotations: Annotation[]; filters: Filters };
type Draft = { id: string | null; title: string; category: Category; team: Team; players: string; outcome: Outcome; notes: string; start: string; end: string };
const LABELS = CATEGORY_LABELS;
const emptyDraft = (): Draft => ({ id: null, title: "", category: "custom", team: "neutral", players: "", outcome: "unknown", notes: "", start: "", end: "" });
const message = (reason: unknown) => reason instanceof Error ? reason.message : "Something went wrong. Please try again.";
const clock = (second: number) => `${Math.floor(second / 60)}:${(second % 60).toFixed(1).padStart(4, "0")}`;
const precise = (second: number) => String(second);

function download(text: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function VideoLab({ active, onHighlights }: Props) {
  const [local, setLocal] = useState<{ file: File; url: string } | null>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [selected, setSelected] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [rate, setRate] = useState(1);
  const [decodeError, setDecodeError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [storageError, setStorageError] = useState("");
  const [saved, setSaved] = useState(true);
  const [replaceStorage, setReplaceStorage] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingImport, setPendingImport] = useState<LabReport | null>(null);
  const [importing, setImporting] = useState(false);
  const [timeWindow, setTimeWindow] = useState({ from: "0", to: "0" });
  const [teams, setTeams] = useState({ home: "Home", away: "Away" });
  const [excluded, setExcluded] = useState<string[]>([]);
  const [group, setGroup] = useState(CATEGORY_GROUPS[0].id);
  const video = useRef<HTMLVideoElement>(null);
  const root = useRef<HTMLElement>(null);
  const localRef = useRef(local);
  const docRef = useRef(doc);
  const persisted = useRef<string | null>(null);
  const storageBlocked = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const clipOut = useRef<number | null>(null);
  const hydratedUrl = useRef<string | null>(null);
  const onHighlightsRef = useRef(onHighlights);
  localRef.current = local;
  docRef.current = doc;
  onHighlightsRef.current = onHighlights;
  const busy = false;
  const playable = Boolean(doc && !decodeError);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; onHighlightsRef.current(null); };
  }, []);
  useEffect(() => () => { if (local) URL.revokeObjectURL(local.url); }, [local]);
  useEffect(() => {
    if (!active) video.current?.pause();
  }, [active]);
  useEffect(() => {
    function changed(event: StorageEvent) {
      if (!docRef.current || (event.key !== null && event.key !== labStorageKey(docRef.current.source))) return;
      storageBlocked.current = true;
      setStorageError("This file's saved review changed in another tab. Automatic saving is paused; export your work before explicitly replacing storage.");
      setSaved(false);
    }
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  useEffect(() => {
    if (saved) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saved]);

  function persist(next: Document, explicitReplace = false) {
    setSaved(false);
    if (storageBlocked.current && !explicitReplace) return;
    try {
      const json = serializeLabReport(next.source, next.filters, next.annotations);
      const key = labStorageKey(next.source);
      if (!explicitReplace && localStorage.getItem(key) !== persisted.current) {
        throw new Error("Saved review changed elsewhere. Export your work, then explicitly replace storage if intended.");
      }
      localStorage.setItem(key, json);
      persisted.current = json;
      storageBlocked.current = false;
      setStorageError("");
      setSaved(true);
      setReplaceStorage(false);
    } catch (reason) {
      storageBlocked.current = true;
      setStorageError(`${message(reason)} Your review remains in memory. Export a JSON backup; existing storage has not been overwritten.`);
    }
  }

  function commit(annotations: Annotation[], filters = docRef.current!.filters) {
    const current = docRef.current;
    if (!current) return false;
    try {
      const next: Document = {
        source: current.source,
        annotations: validateAnnotations(annotations, current.source.duration),
        filters: validateFilters(filters, current.source.duration),
      };
      // Validate the complete budget before changing the in-memory review, even with storage blocked.
      serializeLabReport(next.source, next.filters, next.annotations);
      docRef.current = next;
      setDoc(next);
      persist(next);
      setError("");
      return true;
    } catch (reason) { setError(message(reason)); return false; }
  }

  function chooseFile(file: File | undefined, confirmed = false) {
    if (!file || busy || importing) return;
    if (file.size === 0 || file.size > MAX_UPLOAD_BYTES) {
      setError("Choose a nonempty video up to 500 MB (500 MiB).");
      return;
    }
    if (!confirmed && (!saved || JSON.stringify(draft) !== JSON.stringify(emptyDraft()))) { setPendingFile(file); return; }
    generation.current++;
    video.current?.pause();
    onHighlightsRef.current(null);
    const next = { file, url: URL.createObjectURL(file) };
    localRef.current = next;
    docRef.current = null;
    setLocal(next);
    setDoc(null);
    hydratedUrl.current = null;
    persisted.current = null;
    storageBlocked.current = false;
    setSaved(true);
    setStorageError("");
    setReplaceStorage(false);
    setDecodeError("");
    setError("");
    setNotice("");
    setDraft(emptyDraft());
    setSelected(null);
    setPendingFile(null);
    setPendingImport(null);
    setExcluded([]);
    setTime(0);
    setRate(1);
    clipOut.current = null;
  }

  function metadata(url: string, element: HTMLVideoElement) {
    const current = localRef.current;
    if (!current || current.url !== url || hydratedUrl.current === url) return;
    try {
      const source = validateSource({ name: current.file.name, size: current.file.size, lastModified: current.file.lastModified, duration: element.duration });
      hydratedUrl.current = url;
      let next: Document = { source, annotations: [], filters: defaultFilters(source.duration) };
      try {
        const raw = localStorage.getItem(labStorageKey(source));
        persisted.current = raw;
        if (raw !== null) {
          const report = parseLabReport(raw, source);
          // Revalidate against this browser's actual duration, not the imported claim.
          next = { source, annotations: validateAnnotations(report.annotations, source.duration), filters: validateFilters(report.filters, source.duration) };
          setNotice(`Restored ${next.annotations.length} reviewed annotations for this file.`);
        }
      } catch (reason) {
        storageBlocked.current = true;
        setStorageError(`${message(reason)} Stored data is preserved. You can tag in memory and export a backup, or explicitly replace the saved review.`);
        setSaved(false);
      }
      docRef.current = next;
      setDoc(next);
      setTimeWindow({ from: precise(next.filters.from), to: precise(next.filters.to) });
      try {
        const savedTeams = JSON.parse(localStorage.getItem(`${labStorageKey(source)}:teams`) ?? "null") as { home?: unknown; away?: unknown } | null;
        setTeams({ home: typeof savedTeams?.home === "string" ? savedTeams.home : "Home", away: typeof savedTeams?.away === "string" ? savedTeams.away : "Away" });
      } catch { setTeams({ home: "Home", away: "Away" }); }
    } catch {
      element.pause();
      setDecodeError(`Cannot review this source. Choose browser-playable footage up to ${MAX_VIDEO_SECONDS / 60} minutes (900 seconds) with a finite duration. Try H.264 MP4 or WebM.`);
    }
  }

  function seek(second: number, end: number | null = null, play = false) {
    if (!video.current || !doc || decodeError) return;
    video.current.pause();
    clipOut.current = end;
    video.current.currentTime = Math.max(0, Math.min(doc.source.duration, second));
    setTime(video.current.currentTime);
    if (play) void video.current.play().catch(() => setError("Playback could not start. Use the video's Play control or try a supported codec."));
  }

  useEffect(() => {
    if (!active || !local) return;
    let frame: number;
    const update = () => {
      const element = video.current;
      const end = clipOut.current;
      if (element && end !== null && element.currentTime >= end) {
        element.pause();
        element.currentTime = end;
        clipOut.current = null;
        setTime(end);
      }
      frame = window.requestAnimationFrame(update);
    };
    frame = window.requestAnimationFrame(update);
    return () => window.cancelAnimationFrame(frame);
  }, [active, local]);

  function mark(which: "start" | "end") {
    if (!playable) return;
    setDraft((value) => ({ ...value, [which]: precise(video.current?.currentTime ?? time) }));
  }

  function shortcut(event: KeyboardEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (!active || root.current?.closest("[hidden]") || !playable || event.repeat || event.altKey || event.ctrlKey || event.metaKey ||
      target.closest("input,textarea,select,video,[contenteditable]:not([contenteditable='false']),[role='textbox']")) return;
    if (event.key.toLowerCase() === "i" || event.key.toLowerCase() === "o") {
      event.preventDefault();
      event.stopPropagation();
      mark(event.key.toLowerCase() === "i" ? "start" : "end");
    }
  }

  function newMoment(category: Category) {
    if (!doc || !playable) return;
    const range = paddedRange(video.current?.currentTime ?? time, doc.source.duration);
    setSelected(null);
    setDraft({ ...emptyDraft(), category, title: LABELS[category], start: precise(range.inSeconds), end: precise(range.outSeconds) });
    setNotice("Moment marked with 3 seconds before / 5 seconds after, bounded by the source. Add detail, then save.");
  }

  function edit(item: Annotation) {
    setSelected(item.id);
    setDraft({ id: item.id, title: item.title, category: item.category, team: item.team, players: item.players.join(", "), outcome: item.outcome, notes: item.notes, start: String(item.inSeconds), end: String(item.outSeconds) });
    seek(item.inSeconds, item.outSeconds);
  }

  function saveAnnotation() {
    if (!doc || !playable) return;
    if (!draft.start.trim() || !draft.end.trim()) { setError("Mark both an in and out point, or choose a moment preset."); return; }
    const original = doc.annotations.find((item) => item.id === draft.id);
    const item: Annotation = {
      id: original?.id ?? crypto.randomUUID(),
      title: draft.title.trim(), category: draft.category, team: draft.team,
      players: draft.players.split(",").map((value) => value.trim()).filter(Boolean),
      outcome: draft.outcome, notes: draft.notes,
      inSeconds: Number(draft.start), outSeconds: Number(draft.end),
      source: original?.source ?? { kind: "manual" },
    };
    if (commit(original ? doc.annotations.map((entry) => entry.id === original.id ? item : entry) : [...doc.annotations, item])) {
      setSelected(item.id);
      setDraft(emptyDraft());
      setNotice("Moment saved to your timeline and highlight list.");
    }
  }

  function remove(item: Annotation) {
    if (!doc) return;
    if (commit(doc.annotations.filter((entry) => entry.id !== item.id))) {
      if (draft.id === item.id) setDraft(emptyDraft());
      if (selected === item.id) setSelected(null);
      setNotice(`Removed “${item.title}” from this review.`);
    }
  }

  function changeFilters(patch: Partial<Filters>) {
    if (doc) commit(doc.annotations, { ...doc.filters, ...patch });
  }

  function exportReport() {
    if (!doc) return;
    try {
      download(serializeLabReport(doc.source, doc.filters, doc.annotations), "video-lab-review.json", "application/json");
    } catch (reason) { setError(message(reason)); }
  }

  async function readImport(file: File | undefined) {
    if (!file || !doc || importing) return;
    setPendingImport(null);
    if (file.size > MAX_LAB_JSON_BYTES) { setError("JSON backup must be at most 1 MiB."); return; }
    const token = generation.current;
    setImporting(true);
    try {
      const report = parseLabReport(await file.text(), doc.source);
      if (token !== generation.current || !mounted.current) return;
      validateAnnotations(report.annotations, doc.source.duration);
      validateFilters(report.filters, doc.source.duration);
      setPendingImport(report);
      setError("");
    } catch (reason) { if (token === generation.current && mounted.current) setError(message(reason)); }
    finally { if (mounted.current) setImporting(false); }
  }

  function changeTeams(next: { home: string; away: string }) {
    setTeams(next);
    if (!doc) return;
    try { localStorage.setItem(`${labStorageKey(doc.source)}:teams`, JSON.stringify(next)); } catch { /* names are a convenience */ }
  }

  function generateHighlights() {
    if (!doc || !local) return;
    const chosen = reviewed.filter((item) => !excluded.includes(item.id));
    if (!chosen.length) { setError("Choose at least one moment for the highlights."); return; }
    try {
      const { fixture, reel } = labHighlightReel(doc.source, chosen, teams);
      video.current?.pause();
      onHighlights({ fixture, reel, footage: { url: local.url, name: local.file.name } });
    } catch (reason) { setError(message(reason)); }
  }

  const reviewed = useMemo(() => doc ? filterAnnotations(doc.annotations, doc.filters) : [], [doc]);
  const stats = useMemo(() => doc ? deriveStats(reviewed, doc.source.duration) : null, [doc, reviewed]);
  const selectedItem = doc?.annotations.find((entry) => entry.id === (draft.id ?? selected));
  const playerOptions = useMemo(() => doc ? deriveStats(doc.annotations, doc.source.duration).players : [], [doc]);
  const fieldsLocked = !playable;
  const highlightCount = reviewed.filter((item) => !excluded.includes(item.id)).length;
  const activeGroup = CATEGORY_GROUPS.find((entry) => entry.id === group) ?? CATEGORY_GROUPS[0];

  return (
    <section className="video-lab-workbench" aria-label="Video Lab analysis workbench" ref={root} tabIndex={0} onKeyDown={shortcut}>
      <header className="vl-header">
        <div><p className="vl-eyebrow">Watch / tag / cut</p><h2>Video Lab</h2><p>The pundit's tagging desk: mark the moments that matter with Hudl-style tags, add your notes, then turn the tagged moments into a highlight reel cut from your footage.</p></div>
        <span className="vl-local">Manual tagging · stays on this device</span>
      </header>
      <div className="vl-source">
        <label className="vl-field"><span>Choose footage for local review</span>
          <input type="file" accept=".mp4,.webm,.mov,video/mp4,video/webm,video/quicktime" disabled={busy || importing}
            onChange={(event) => { chooseFile(event.target.files?.[0]); event.target.value = ""; }} />
        </label>
        <p className="vl-help">Up to 15 minutes / 500 MB (500 MiB). Nothing is uploaded: tagging and highlights run in your browser. Browser codec support varies.</p>
        {doc && <div className="vl-field-row vl-teams">
          <label className="vl-field"><span>Home team</span><input maxLength={40} value={teams.home} onChange={(e) => changeTeams({ ...teams, home: e.target.value })} /></label>
          <label className="vl-field"><span>Away team</span><input maxLength={40} value={teams.away} onChange={(e) => changeTeams({ ...teams, away: e.target.value })} /></label>
        </div>}
        <p className="vl-source-meta">{local ? `${local.file.name} · ${(local.file.size / 1048576).toFixed(1)} MiB${doc ? ` · ${clock(doc.source.duration)}` : " · Reading video metadata…"}` : "Your original file stays on this device. After a reload, reselect the same file to restore its review."}</p>
      </div>
      {pendingFile && <div className="vl-notice" role="alert">
        <p>Switch to {pendingFile.name}? Unsaved edits or in-memory work may be lost. Export your current review first.</p>
        <div className="vl-actions"><button type="button" onClick={exportReport} disabled={!doc}>Export current backup</button><button type="button" onClick={() => chooseFile(pendingFile, true)} disabled={busy}>Discard unsaved work and switch</button><button type="button" onClick={() => setPendingFile(null)}>Keep this source</button></div>
      </div>}
      {error && <div role="alert" className="vl-error">{error} <button type="button" onClick={() => setError("")}>Dismiss</button></div>}
      {decodeError && <p role="alert" className="vl-error">{decodeError}</p>}
      {storageError && <div className="vl-storage-error" role="alert">
        <p>{storageError}</p><div className="vl-actions">
          <button type="button" disabled={!doc} onClick={exportReport}>Export in-memory backup</button>
          <button type="button" onClick={() => {
            try {
              const raw = doc && localStorage.getItem(labStorageKey(doc.source));
              if (raw !== null) download(raw, "video-lab-preserved-storage.txt", "text/plain");
              else setError("No saved storage is available to export.");
            } catch (reason) { setError(message(reason)); }
          }}>Download preserved storage</button>
          <button type="button" disabled={!doc} onClick={() => setReplaceStorage(true)}>Replace saved review…</button>
        </div>
        {replaceStorage && <div className="vl-actions"><p>This overwrites this file's saved data with the current in-memory review.</p><button type="button" onClick={() => doc && persist(doc, true)}>Confirm overwrite saved review</button><button type="button" onClick={() => setReplaceStorage(false)}>Cancel</button></div>}
      </div>}
      <div className="vl-workbench">
        <div className="vl-viewer">
          <div className="vl-screen">
            {local ? <video key={local.url} ref={video} src={local.url} controls playsInline preload="metadata" aria-label={`Review video: ${local.file.name}`}
              onLoadedMetadata={(event) => metadata(local.url, event.currentTarget)}
              onError={() => { if (localRef.current?.url === local.url) { video.current?.pause(); setDecodeError("This browser cannot decode the selected video. Convert it to H.264 MP4 or a supported WebM codec and reselect it. Local review never uploads footage on its own."); } }}
              onTimeUpdate={(event) => {
                const element = event.currentTarget;
                if (clipOut.current !== null && element.currentTime >= clipOut.current) {
                  element.pause(); element.currentTime = clipOut.current; clipOut.current = null;
                }
                setTime(element.currentTime);
              }}
              onEnded={() => { clipOut.current = null; }}
            /> : <div className="vl-empty-video"><span className="vl-eyebrow">Your footage, your analysis</span><h3>See the whole picture.<br />Save the important moments.</h3><p>Choose a local match clip to begin. Tag moments, then generate highlights.</p></div>}
          </div>
          <div className="vl-transport">
            <span className="vl-clock">{clock(time)} / {clock(doc?.source.duration ?? 0)}</span>
            <button type="button" disabled={!playable} onClick={() => {
              if (!video.current) return;
              if (video.current.paused) {
                if (clipOut.current !== null && video.current.currentTime >= clipOut.current) clipOut.current = null;
                void video.current.play().catch(() => setError("Playback failed. Try the native Play control or a supported codec."));
              } else video.current.pause();
            }}>Play / pause</button>
            <button type="button" disabled={!playable} onClick={() => seek((video.current?.currentTime ?? time) - 5)}>−5 s</button>
            <button type="button" disabled={!playable} onClick={() => seek((video.current?.currentTime ?? time) + 5)}>+5 s</button>
            <button type="button" disabled={!playable} aria-label="Step back approximately 0.04 seconds" onClick={() => seek((video.current?.currentTime ?? time) - 0.04)}>← Step</button>
            <button type="button" disabled={!playable} aria-label="Step forward approximately 0.04 seconds" onClick={() => seek((video.current?.currentTime ?? time) + 0.04)}>Step →</button>
            <label className="vl-field"><span>Playback speed</span><select value={rate} disabled={!playable} onChange={(event) => { const value = Number(event.target.value); setRate(value); if (video.current) video.current.playbackRate = value; }}>{[0.25, 0.5, 1, 1.5, 2].map((value) => <option key={value} value={value}>{value}×</option>)}</select></label>
          </div>
          <p className="vl-help">Step ≈ 0.04 seconds, not frame-accurate. Focus this workbench (outside inputs and native video controls) for I / O marks.</p>
          <div className="vl-tag-panel">
            <div className="vl-tag-groups" role="tablist" aria-label="Tag groups">{CATEGORY_GROUPS.map((entry) => <button type="button" role="tab" key={entry.id} aria-selected={entry.id === activeGroup.id} className={entry.id === activeGroup.id ? "is-active" : ""} onClick={() => setGroup(entry.id)}>{entry.label}</button>)}</div>
            <div className="vl-presets" aria-label={`${activeGroup.label} tags for the current moment`}>{activeGroup.categories.map((category) => <button type="button" key={category} data-category={category} disabled={!playable || (doc?.annotations.length ?? 0) >= MAX_ANNOTATIONS} onClick={() => newMoment(category)}>+ {LABELS[category]}</button>)}</div>
          </div>
          <section className="vl-timeline" aria-label="Filtered review timeline">
            <h3>Review timeline <small>{reviewed.length} moments</small></h3>
            <div className="vl-timeline-track">
              {reviewed.map((item, index) => <button type="button" key={item.id} className="vl-marker" data-category={item.category}
                style={{ left: `${item.inSeconds / doc!.source.duration * 100}%`, width: `${(item.outSeconds - item.inSeconds) / doc!.source.duration * 100}%`, top: `${index % 3 * 24 + 4}px` }}
                title={`${item.title} · ${clock(item.inSeconds)}–${clock(item.outSeconds)}`}
                aria-label={`Review ${item.title}, ${clock(item.inSeconds)} to ${clock(item.outSeconds)}`}
                disabled={!playable} onClick={() => { setSelected(item.id); seek(item.inSeconds, item.outSeconds, true); }} />)}
              {doc && <span className="vl-timeline-cursor" style={{ left: `${time / doc.source.duration * 100}%` }} />}
            </div>
            <div className="vl-ruler"><span>0:00</span><span>Markers play to clip out · full accessible list below</span><span>{clock(doc?.source.duration ?? 0)}</span></div>
          </section>
        </div>
        <aside className="vl-editor" aria-label="Annotation notebook">
          <p className="vl-eyebrow">Analysis notebook</p>
          <h3>{draft.id ? "Edit reviewed moment" : "Capture a moment"}</h3>
          <p className="vl-help">Tags mark 3 s before and 5 s after the current frame. Adjust in / out, add players and notes, then save. Your notes become the on-screen caption in the highlights.</p>
          <fieldset disabled={fieldsLocked}>
            <div className="vl-mark-range vl-actions"><button type="button" onClick={() => mark("start")}>Mark in (I)</button><button type="button" onClick={() => mark("end")}>Mark out (O)</button></div>
            <div className="vl-field-row">
              <label className="vl-field"><span>In (seconds)</span><input type="number" min="0" max={doc?.source.duration} step="any" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} /></label>
              <label className="vl-field"><span>Out (seconds)</span><input type="number" min="0" max={doc?.source.duration} step="any" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} /></label>
            </div>
            <label className="vl-field"><span>Moment title</span><input maxLength={120} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="What should viewers notice?" /></label>
            <div className="vl-field-row">
              <label className="vl-field"><span>Event category</span><select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as Category })}>{CATEGORY_GROUPS.map((entry) => <optgroup key={entry.id} label={entry.label}>{entry.categories.map((category) => <option key={category} value={category}>{LABELS[category]}</option>)}</optgroup>)}</select></label>
              <label className="vl-field"><span>Team</span><select value={draft.team} onChange={(e) => setDraft({ ...draft, team: e.target.value as Team })}><option value="neutral">Neutral / both</option><option value="home">{teams.home || "Home"}</option><option value="away">{teams.away || "Away"}</option></select></label>
            </div>
            <label className="vl-field"><span>Players (comma-separated)</span><input maxLength={1238} value={draft.players} onChange={(e) => setDraft({ ...draft, players: e.target.value })} placeholder="e.g. #9, Alex" /></label>
            <label className="vl-field"><span>Observed outcome</span><select value={draft.outcome} onChange={(e) => setDraft({ ...draft, outcome: e.target.value as Outcome })}><option value="unknown">Unknown / not applicable</option><option value="success">Success</option><option value="unsuccessful">Unsuccessful</option></select></label>
            <label className="vl-field"><span>Pundit notes</span><textarea rows={4} maxLength={2000} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="What happened, why it matters, the talking point…" /></label>
            <div className="vl-actions"><button type="button" className="vl-primary" onClick={saveAnnotation} disabled={!draft.id && (doc?.annotations.length ?? 0) >= MAX_ANNOTATIONS}>{draft.id ? "Save changes" : "Save annotation"}</button><button type="button" onClick={() => { setDraft(emptyDraft()); setSelected(null); }}>Clear editor</button></div>
          </fieldset>
          {notice && <p role="status" className="vl-notice">{notice}</p>}
        </aside>
      </div>
      {doc && stats && <>
        <section className="vl-analysis" aria-label="Tagged observation analysis">
          <p className="vl-eyebrow">Detailed review, not match truth</p><h3>Tagged-observation analysis</h3>
          <p className="vl-help">All counts, timeline markers and library results use the same filters. Only saved tags count. No possession, xG or tracking is inferred.</p>
          <div className="vl-filterbar">
            <label className="vl-field"><span>Search reviewed moments</span><input maxLength={2000} value={doc.filters.query} onChange={(e) => changeFilters({ query: e.target.value })} placeholder="Title, notes, players…" /></label>
            <label className="vl-field"><span>Filter team</span><select value={doc.filters.team} onChange={(e) => changeFilters({ team: e.target.value as Filters["team"] })}><option value="all">All teams</option><option value="home">{teams.home || "Home"}</option><option value="away">{teams.away || "Away"}</option><option value="neutral">Neutral</option></select></label>
            <label className="vl-field"><span>Filter player</span><select value={doc.filters.player} onChange={(e) => changeFilters({ player: e.target.value })}><option value="">All players</option>{doc.filters.player && !playerOptions.some((p) => p.player === doc.filters.player) && <option value={doc.filters.player}>{doc.filters.player}</option>}{playerOptions.map((entry) => <option key={entry.player} value={entry.player}>{entry.player}</option>)}</select></label>
            <label className="vl-field"><span>Filter category</span><select value={doc.filters.category} onChange={(e) => changeFilters({ category: e.target.value as Filters["category"] })}><option value="all">All categories</option>{CATEGORY_GROUPS.map((entry) => <optgroup key={entry.id} label={entry.label}>{entry.categories.map((category) => <option key={category} value={category}>{LABELS[category]}</option>)}</optgroup>)}</select></label>
            <label className="vl-field"><span>Window from (s)</span><input type="number" step="any" min="0" max={doc.source.duration} value={timeWindow.from} onChange={(e) => setTimeWindow({ ...timeWindow, from: e.target.value })} /></label>
            <label className="vl-field"><span>Window to (s)</span><input type="number" step="any" min="0" max={doc.source.duration} value={timeWindow.to} onChange={(e) => setTimeWindow({ ...timeWindow, to: e.target.value })} /></label>
            <button type="button" onClick={() => {
              if (!timeWindow.from.trim() || !timeWindow.to.trim()) { setError("Enter both time-window boundaries."); return; }
              changeFilters({ from: Number(timeWindow.from), to: Number(timeWindow.to) });
            }}>Apply time window</button>
            <button type="button" onClick={() => { changeFilters(defaultFilters(doc.source.duration)); setTimeWindow({ from: "0", to: precise(doc.source.duration) }); }}>Reset filters</button>
          </div>
          <p className="vl-help">{stats.total} of {doc.annotations.length} annotations · Applied window {clock(doc.filters.from)}–{clock(doc.filters.to)} (overlapping clips; end exclusive). Goals do not imply extra shots. Defensive actions = tackle, interception, clearance, block, ball recovery, aerial duel, pressing, defensive shape.</p>
          <div className="vl-stats-grid">{[["Shots", stats.shots], ["Goals", stats.goals], ["Passes", stats.passes], ["Defensive actions", stats.defensiveActions]].map(([label, count]) => <div className="vl-stat" key={label}><span>{label}</span><strong>{count}</strong><small>Tagged observations</small></div>)}</div>
          <div className="vl-breakdowns">
            <div className="vl-breakdown"><h4>Team comparison</h4><div className="vl-comparison">{(["home", "away", "neutral"] as const).map((team) => <div className="vl-team-row" key={team}><span>{team}</span><progress className="vl-team-bar" aria-label={`${team} tagged observations`} max={Math.max(1, stats.total)} value={stats.teams[team]} /><strong>{stats.teams[team]}</strong></div>)}</div>
              <h4>Outcome breakdown</h4><div className="vl-outcomes">{(["success", "unsuccessful", "unknown"] as const).map((outcome) => <span className="vl-outcome" key={outcome}>{outcome}: <strong>{stats.outcomes[outcome]}</strong></span>)}</div>
              <p className="vl-help">Tagged pass success: {stats.passSuccess.percent === null ? "— (no known outcomes)" : `${stats.passSuccess.percent.toFixed(0)}% (${stats.passSuccess.success}/${stats.passSuccess.known} known)`}. Unknown passes excluded from denominator.</p>
            </div>
            <div className="vl-breakdown"><h4>Activity by clip start</h4><ul className="vl-activity">{stats.activity.map((bucket) => <li key={bucket.from}><span>{clock(bucket.from)}–{clock(bucket.to)}</span><progress aria-label={`Tagged activity ${clock(bucket.from)} to ${clock(bucket.to)}`} max={Math.max(1, ...stats.activity.map((entry) => entry.count))} value={bucket.count} /><strong>{bucket.count}</strong></li>)}</ul></div>
            <div className="vl-breakdown"><h4>Player tag counts</h4>{stats.players.length ? <ul className="vl-player-counts">{stats.players.map((entry) => <li key={entry.player}><span>{entry.player}</span><strong>{entry.count}</strong></li>)}</ul> : <p className="vl-help">No player tags in this selection. Add player names or shirt numbers in the notebook.</p>}<p className="vl-help">A player counts once per annotation. Counts reflect review coverage, not performance rankings.</p></div>
          </div>
        </section>
        <section className="vl-library" aria-label="Reviewed clip library">
          <div className="vl-library-heading"><div><p className="vl-eyebrow">Your tagged moments</p><h3>Clip library</h3></div><span>{reviewed.length} shown / {doc.annotations.length} saved / {MAX_ANNOTATIONS} max</span></div>
          <div className="vl-highlight-bar">
            <p className="vl-help">Every shown moment is in the highlights unless you untick it. Use the filters above to narrow the list, e.g. one player or one tag.</p>
            <button type="button" className="vl-primary" disabled={!highlightCount || !playable} onClick={generateHighlights}>Generate highlights ({highlightCount})</button>
          </div>
          {!reviewed.length ? <div className="vl-empty">{doc.annotations.length ? "No reviewed moments match these filters. Reset filters to see your collection." : "Your review starts with one moment. Watch, choose a preset, add a note, and save."}</div> :
            <ul className="vl-clip-list">{reviewed.map((item) => <li key={item.id} className={`vl-clip${selected === item.id ? " is-selected" : ""}`} data-category={item.category}>
              <div className="vl-clip-top"><span className="vl-origin">{LABELS[item.category]}</span>
                <label className="vl-include"><input type="checkbox" checked={!excluded.includes(item.id)} onChange={(event) => setExcluded(event.target.checked ? excluded.filter((id) => id !== item.id) : [...excluded, item.id])} /> In highlights</label></div>
              <h4><button type="button" className="vl-clip-title" onClick={() => edit(item)}>{item.title}</button></h4>
              <p className="vl-clip-meta">{clock(item.inSeconds)}–{clock(item.outSeconds)} · {item.team === "neutral" ? "Neutral" : teams[item.team] || item.team} · {item.outcome}</p>
              <p className="vl-clip-meta">{item.players.join(", ") || "No players tagged"}</p><p className="vl-clip-notes">{item.notes || "No note yet."}</p>
              <div className="vl-actions"><button type="button" disabled={!playable} onClick={() => { setSelected(item.id); seek(item.inSeconds, item.outSeconds, true); }}>Play clip</button><button type="button" onClick={() => edit(item)}>Edit / notes</button><button type="button" className="vl-danger" aria-label={`Delete annotation ${item.title}`} onClick={() => remove(item)}>Delete</button></div>
            </li>)}</ul>}
        </section>
        <section className="vl-backup" aria-label="Review backup and restore">
          <h3>Keep a copy of your analysis</h3><p className="vl-help">Browser-local, per-file, per-device data; not an account or cloud library. File identity uses name, size and last-modified time (not a content hash). Reselect the original file after reload. Backups contain annotations, not video.</p>
          <p role="status">{saved ? "Review saved on this browser." : "Review not fully saved — export a backup."}</p>
          <div className="vl-actions"><button type="button" onClick={exportReport}>Export JSON backup / report</button><button type="button" onClick={() => {
            try { download(annotationsCsv(reviewed), "video-lab-filtered-annotations.csv", "text/csv;charset=utf-8"); } catch (reason) { setError(message(reason)); }
          }}>Export filtered CSV</button>
            <label className="vl-field"><span>Load JSON backup for this source (1 MiB max)</span><input type="file" accept=".json,application/json" disabled={importing} onChange={(event) => { void readImport(event.target.files?.[0]); event.target.value = ""; }} /></label>
          </div><p className="vl-help">JSON includes all annotations, active filters and recomputed filtered statistics. CSV includes the filtered annotations; formula-like cells are escaped for spreadsheet safety.</p>
          {importing && <p role="status">Validating backup…</p>}
          {pendingImport && <div className="vl-import-preview"><p>Validated {pendingImport.annotations.length} annotations for this exact file fingerprint. Replace {doc.annotations.length} current annotations and filters? This does not upload video.</p><div className="vl-actions"><button type="button" onClick={() => {
            if (commit(pendingImport.annotations, pendingImport.filters)) {
              setTimeWindow({ from: precise(pendingImport.filters.from), to: precise(pendingImport.filters.to) });
              setPendingImport(null); setDraft(emptyDraft()); setSelected(null); clipOut.current = null;
              setNotice("Backup imported. Statistics were recomputed, not trusted from the file.");
            }
          }}>Replace review with validated import</button><button type="button" onClick={() => setPendingImport(null)}>Cancel import</button></div></div>}
        </section>
      </>}
    </section>
  );
}
