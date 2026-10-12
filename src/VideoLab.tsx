import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { MAX_MANUAL_TAGS, MAX_UPLOAD_BYTES, MAX_VIDEO_SECONDS, type VideoJob } from "../shared/video.js";
import type { LiveStatus } from "../shared/platform.js";
import {
  CATEGORIES, MAX_ANNOTATIONS, MAX_LAB_JSON_BYTES, annotationsCsv, defaultFilters, deriveStats, deskTagFor, deskTagSent,
  filterAnnotations, labStorageKey, mergeAnnotations, paddedRange, parseLabReport,
  serializeLabReport, suggestionAnnotations, validateAnnotations, validateFilters, validateSource,
  type Annotation, type Category, type Filters, type LabReport, type LabSource, type Outcome, type Team,
} from "../shared/videoLab.js";
import { api, uploadVideo } from "./api.js";
import "./videoLab.css";

export type VideoFootage = { fixtureId: string; url: string; name: string };
type Props = { active: boolean; onFootage: (footage: VideoFootage | null) => void; status: LiveStatus | null; onStreamed: (status: LiveStatus) => void };
type Document = { source: LabSource; annotations: Annotation[]; filters: Filters };
type Draft = { id: string | null; title: string; category: Category; team: Team; players: string; outcome: Outcome; notes: string; start: string; end: string };
const LABELS: Record<Category, string> = {
  goal: "Goal", shot: "Shot", pass: "Pass", tackle: "Tackle", pressing: "Pressing", set_piece: "Set piece", defensive_shape: "Defensive shape", custom: "Custom",
  save: "Save", foul: "Foul", yellow_card: "Yellow card", red_card: "Red card",
};
const TERMINAL = ["ready", "failed", "rejected"];
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

export function VideoLab({ active, onFootage, status, onStreamed }: Props) {
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
  const [job, setJob] = useState<VideoJob | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [aiError, setAiError] = useState("");
  const [permission, setPermission] = useState(false);
  const [teams, setTeams] = useState({ homeName: "Home", homeKit: "", awayName: "Away", awayKit: "" });
  const [chosenAI, setChosenAI] = useState<string[]>([]);
  const [chosenDesk, setChosenDesk] = useState<string[]>([]);
  const [deskBusy, setDeskBusy] = useState(false);
  const [deskError, setDeskError] = useState("");
  const [confirmReplace, setConfirmReplace] = useState(false);
  const aiPanel = useRef<HTMLDetailsElement>(null);
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
  const onFootageRef = useRef(onFootage);
  localRef.current = local;
  docRef.current = doc;
  onFootageRef.current = onFootage;
  const busy = uploading || Boolean(job && !TERMINAL.includes(job.stage));
  const playable = Boolean(doc && !decodeError);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; onFootageRef.current(null); };
  }, []);
  useEffect(() => () => { if (local) URL.revokeObjectURL(local.url); }, [local]);
  useEffect(() => {
    if (!active) video.current?.pause();
  }, [active]);
  useEffect(() => {
    onFootageRef.current(job?.stage === "ready" && job.fixtureId && local && doc && !decodeError
      ? { fixtureId: job.fixtureId, url: local.url, name: local.file.name } : null);
  }, [job?.stage, job?.fixtureId, local, doc?.source, decodeError]);

  useEffect(() => {
    if (!job || TERMINAL.includes(job.stage)) return;
    const controller = new AbortController();
    const token = generation.current;
    let timer: number | undefined;
    async function poll() {
      try {
        const next = await api.getVideoJob(job!.id, controller.signal);
        if (controller.signal.aborted || token !== generation.current) return;
        if (!next || next.id !== job!.id) throw new Error("Analysis status is unavailable.");
        setJob(next);
        setAiError("");
        if (!TERMINAL.includes(next.stage)) timer = window.setTimeout(poll, 1500);
      } catch (reason) {
        if (controller.signal.aborted || token !== generation.current) return;
        setAiError(`${message(reason)} Retrying status in 4 seconds; local tagging is still available.`);
        timer = window.setTimeout(poll, 4000);
      }
    }
    timer = window.setTimeout(poll, 1000);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [job?.id, job?.stage]);

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
    onFootageRef.current(null);
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
    setJob(null);
    setChosenAI([]);
    setChosenDesk([]);
    setDeskError("");
    setDeskBusy(false);
    setConfirmReplace(false);
    setAiError("");
    setPermission(false);
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
      setNotice("Annotation saved to the review timeline. Live scores and events are unchanged.");
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

  async function startAI() {
    if (!local || !doc || !permission || busy || !playable) return;
    const token = ++generation.current;
    setUploading(true);
    setUploadProgress(0);
    setJob(null);
    setChosenAI([]);
    setAiError("");
    try {
      const created = await uploadVideo(local.file, {
        home: { name: teams.homeName.trim(), kit: teams.homeKit.trim() },
        away: { name: teams.awayName.trim(), kit: teams.awayKit.trim() },
      }, (progress) => { if (mounted.current && generation.current === token) setUploadProgress(progress); });
      if (mounted.current && generation.current === token) setJob(created);
    } catch (reason) {
      if (mounted.current && generation.current === token) setAiError(message(reason));
    } finally {
      if (mounted.current && generation.current === token) setUploading(false);
    }
  }

  async function sendToDesk() {
    if (!job || job.stage !== "ready" || !doc || deskBusy) return;
    const token = generation.current;
    setDeskBusy(true);
    setDeskError("");
    let current = job;
    let sent = 0;
    try {
      for (const item of doc.annotations.filter((entry) => chosenDesk.includes(entry.id))) {
        const mapped = deskTagFor(item, current.durationSeconds ?? doc.source.duration);
        if (!("tag" in mapped) || deskTagSent(current, mapped.tag)) continue;
        const next = await api.addVideoTag(current.id, mapped.tag);
        if (!next || token !== generation.current || !mounted.current) return;
        current = next;
        sent++;
      }
      setChosenDesk([]);
      setNotice(`${sent} moment${sent === 1 ? "" : "s"} added to the match feed. They stream to the live desk with the AI-detected events.`);
    } catch (reason) {
      if (token === generation.current && mounted.current) setDeskError(message(reason));
    } finally {
      if (token === generation.current && mounted.current) { setJob(current); setDeskBusy(false); }
    }
  }

  async function removeDeskTag(tagId: string) {
    if (!job || deskBusy) return;
    const token = generation.current;
    setDeskBusy(true);
    setDeskError("");
    try {
      const next = await api.removeVideoTag(job.id, tagId);
      if (next && token === generation.current && mounted.current) setJob(next);
    } catch (reason) {
      if (token === generation.current && mounted.current) setDeskError(message(reason));
    } finally {
      if (token === generation.current && mounted.current) setDeskBusy(false);
    }
  }

  async function goLive() {
    if (!job || job.stage !== "ready" || deskBusy) return;
    if (status?.state === "running" && status.fixtureId !== job.fixtureId && !confirmReplace) { setConfirmReplace(true); return; }
    setDeskBusy(true);
    setDeskError("");
    setConfirmReplace(false);
    try {
      const next = await api.startVideoLive(job.id);
      if (!next || !mounted.current) return;
      video.current?.pause();
      onStreamed(next);
    } catch (reason) {
      if (mounted.current) setDeskError(message(reason));
    } finally {
      if (mounted.current) setDeskBusy(false);
    }
  }

  function openAI() {
    if (aiPanel.current) aiPanel.current.open = true;
    aiPanel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const reviewed = useMemo(() => doc ? filterAnnotations(doc.annotations, doc.filters) : [], [doc]);
  const stats = useMemo(() => doc ? deriveStats(reviewed, doc.source.duration) : null, [doc, reviewed]);
  const suggestions = useMemo(() => {
    if (job?.stage !== "ready" || !doc) return { items: [] as Annotation[], error: "" };
    try { return { items: suggestionAnnotations(job, doc.source.duration), error: "" }; }
    catch (reason) { return { items: [] as Annotation[], error: `Suggestions could not be validated: ${message(reason)}` }; }
  }, [job, doc?.source]);
  const isImported = (item: Annotation) => item.source.kind === "ai" && doc?.annotations.some((entry) =>
    entry.source.kind === "ai" && item.source.kind === "ai" && entry.source.jobId === item.source.jobId && entry.source.eventId === item.source.eventId);
  const selectedItem = doc?.annotations.find((entry) => entry.id === (draft.id ?? selected));
  const playerOptions = useMemo(() => doc ? deriveStats(doc.annotations, doc.source.duration).players : [], [doc]);
  const fieldsLocked = !playable;
  const jobReady = job?.stage === "ready" && Boolean(job.fixtureId);
  const streamingThis = Boolean(job?.fixtureId && status?.state === "running" && status.fixtureId === job.fixtureId);
  const tagsUsed = job?.manualTags.length ?? 0;
  const deskCandidates = useMemo(() => doc
    ? doc.annotations.filter((item) => item.source.kind === "manual")
      .map((item) => ({ item, mapped: deskTagFor(item, job?.durationSeconds ?? doc.source.duration) }))
      .sort((a, b) => a.item.inSeconds - b.item.inSeconds)
    : [], [doc, job?.durationSeconds]);
  const steps = [
    { title: "Mark moments", detail: doc?.annotations.length ? `${doc.annotations.length} saved` : "Watch, tag, add notes", done: Boolean(doc?.annotations.length) },
    { title: "Build the match feed", detail: jobReady ? `${job!.events.length} events detected` : busy ? `AI analysis ${job?.progress ?? 0}%` : "AI detection turns the clip into events", done: jobReady },
    { title: "Add your key calls", detail: `${tagsUsed}/${MAX_MANUAL_TAGS} producer tags`, done: tagsUsed > 0 },
    { title: "Go live on the desk", detail: streamingThis ? "Streaming now" : "Storylines, highlights, recap", done: streamingThis },
  ];

  return (
    <section className="video-lab-workbench" aria-label="Video Lab analysis workbench" ref={root} tabIndex={0} onKeyDown={shortcut}>
      <header className="vl-header">
        <div><p className="vl-eyebrow">Watch / mark / send to air</p><h2>Video Lab</h2><p>The pundit's review desk: mark the moments that matter, add your analysis, then send them to the live desk for storylines, highlights and the recap.</p></div>
        <span className="vl-local">Pundit analysis desk</span>
      </header>
      <ol className="vl-steps" aria-label="Video Lab workflow">
        {steps.map((step, index) => (
          <li key={step.title} className={`vl-step${step.done ? " is-done" : ""}`}>
            <span className="vl-step-index" aria-hidden="true">{step.done ? "✓" : index + 1}</span>
            <span><strong>{step.title}</strong><small>{step.detail}</small></span>
          </li>
        ))}
      </ol>
      <div className="vl-source">
        <label className="vl-field"><span>Choose footage for local review</span>
          <input type="file" accept=".mp4,.webm,.mov,video/mp4,video/webm,video/quicktime" disabled={busy || importing}
            onChange={(event) => { chooseFile(event.target.files?.[0]); event.target.value = ""; }} />
        </label>
        <p className="vl-help">Up to 15 minutes / 500 MB (500 MiB). Start tagging without cloud setup or upload permission. Browser codec support varies.</p>
        <p className="vl-source-meta">{local ? `${local.file.name} · ${(local.file.size / 1048576).toFixed(1)} MiB${doc ? ` · ${clock(doc.source.duration)}` : " · Reading video metadata…"}` : "Your original file stays on this device. After a reload, reselect the same file to restore its review."}</p>
        {busy && <p role="status" className="vl-notice">AI analysis is using this source. File changes are locked until upload and analysis finish; you can keep tagging.</p>}
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
            /> : <div className="vl-empty-video"><span className="vl-eyebrow">Your footage, your analysis</span><h3>See the whole picture.<br />Save the important moments.</h3><p>Choose a local match clip to begin. Mark moments, then send them to the live desk.</p></div>}
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
          <div className="vl-presets" aria-label="Tag current moment presets">{CATEGORIES.map((category) => <button type="button" key={category} data-category={category} disabled={!playable || (doc?.annotations.length ?? 0) >= MAX_ANNOTATIONS} onClick={() => newMoment(category)}>+ {LABELS[category]}</button>)}</div>
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
          <p className="vl-help">Presets mark 3 s before and 5 s after the current frame. Nothing counts until you save. A goal tag only reaches the score once you send it to the desk.</p>
          <fieldset disabled={fieldsLocked}>
            <div className="vl-mark-range vl-actions"><button type="button" onClick={() => mark("start")}>Mark in (I)</button><button type="button" onClick={() => mark("end")}>Mark out (O)</button></div>
            <div className="vl-field-row">
              <label className="vl-field"><span>In (seconds)</span><input type="number" min="0" max={doc?.source.duration} step="any" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} /></label>
              <label className="vl-field"><span>Out (seconds)</span><input type="number" min="0" max={doc?.source.duration} step="any" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} /></label>
            </div>
            <label className="vl-field"><span>Moment title</span><input maxLength={120} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="What should viewers notice?" /></label>
            <div className="vl-field-row">
              <label className="vl-field"><span>Event category</span><select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as Category })}>{CATEGORIES.map((category) => <option key={category} value={category}>{LABELS[category]}</option>)}</select></label>
              <label className="vl-field"><span>Team</span><select value={draft.team} onChange={(e) => setDraft({ ...draft, team: e.target.value as Team })}><option value="neutral">Neutral / both</option><option value="home">Home</option><option value="away">Away</option></select></label>
            </div>
            <label className="vl-field"><span>Players (comma-separated)</span><input maxLength={1238} value={draft.players} onChange={(e) => setDraft({ ...draft, players: e.target.value })} placeholder="e.g. #9, Alex" /></label>
            <label className="vl-field"><span>Observed outcome</span><select value={draft.outcome} onChange={(e) => setDraft({ ...draft, outcome: e.target.value as Outcome })}><option value="unknown">Unknown / not applicable</option><option value="success">Success</option><option value="unsuccessful">Unsuccessful</option></select></label>
            <label className="vl-field"><span>Pundit notes</span><textarea rows={4} maxLength={2000} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="What happened, why it matters, the talking point…" /></label>
            <div className="vl-actions"><button type="button" className="vl-primary" onClick={saveAnnotation} disabled={!draft.id && (doc?.annotations.length ?? 0) >= MAX_ANNOTATIONS}>{draft.id ? "Save changes" : "Save annotation"}</button><button type="button" onClick={() => { setDraft(emptyDraft()); setSelected(null); }}>Clear editor</button></div>
          </fieldset>
          {selectedItem?.source.kind === "ai" && <div className="vl-evidence"><h4>Immutable AI provenance</h4><p>{selectedItem.source.jobId} / {selectedItem.source.eventId}</p><p>{selectedItem.source.evidence}</p><p>{selectedItem.source.confidence === null ? "No measured confidence" : `Model confidence ${(selectedItem.source.confidence * 100).toFixed(0)}%`}</p><button type="button" disabled={!playable} onClick={() => seek(selectedItem.source.kind === "ai" ? selectedItem.source.timestampSeconds : 0)}>{selectedItem.source.inferred ? "Seek inferred time (no frame evidence)" : `Seek evidence frame at ${clock(selectedItem.source.timestampSeconds)}`}</button></div>}
          {notice && <p role="status" className="vl-notice">{notice}</p>}
        </aside>
      </div>
      {doc && <section className="vl-handoff" aria-label="Send moments to the live desk">
        <div className="vl-library-heading">
          <div><p className="vl-eyebrow">What happens after you mark moments</p><h3>Send to the live desk</h3></div>
          {streamingThis && <span className="vl-live-pill">● Live on the desk</span>}
        </div>
        <div className="vl-handoff-grid">
          <article className="vl-handoff-card">
            <span className="vl-step-index" aria-hidden="true">1</span>
            <h4>Build the match feed</h4>
            <p className="vl-help">AI detection reads sampled frames and turns the clip into match events (goals, cards, chances). That feed is what the live desk, storylines and highlights run on.</p>
            {jobReady ? <p className="vl-ok">Ready · {job!.events.length} events · {job!.evidence.filter((entry) => entry.source === "vision").length} from vision</p>
              : <button type="button" className="vl-primary" onClick={openAI} disabled={!playable}>{busy ? `Analysing… ${job?.progress ?? 0}%` : "Set up AI detection"}</button>}
          </article>
          <article className="vl-handoff-card">
            <span className="vl-step-index" aria-hidden="true">2</span>
            <h4>Add your key calls</h4>
            <p className="vl-help">Send up to {MAX_MANUAL_TAGS} of your own marked moments (goal, red card, save…) as producer tags. Set Home or Away first; pressing, shape and custom notes stay as analysis only.</p>
            {!deskCandidates.length ? <p className="vl-help">Mark a moment above to send it.</p> : <ul className="vl-desk-list">
              {deskCandidates.map(({ item, mapped }) => {
                const sent = "tag" in mapped && job ? deskTagSent(job, mapped.tag) : false;
                const full = !chosenDesk.includes(item.id) && tagsUsed + chosenDesk.length >= MAX_MANUAL_TAGS;
                return <li key={item.id} data-category={item.category}>
                  <label className="vl-consent">
                    <input type="checkbox" checked={sent || chosenDesk.includes(item.id)} disabled={!jobReady || streamingThis || deskBusy || sent || !("tag" in mapped) || full}
                      onChange={(event) => setChosenDesk(event.target.checked ? [...chosenDesk, item.id] : chosenDesk.filter((id) => id !== item.id))} />
                    <span><strong>{item.title}</strong> · {LABELS[item.category]} · {clock(item.inSeconds)}{sent ? " · On the feed" : ""}</span>
                  </label>
                  {"reason" in mapped && <small className="vl-help">{mapped.reason}</small>}
                </li>;
              })}
            </ul>}
            {!jobReady && deskCandidates.length > 0 && <p className="vl-help">Available once the match feed is built (step 1).</p>}
            <button type="button" className="vl-primary" disabled={!jobReady || streamingThis || deskBusy || !chosenDesk.length} onClick={() => void sendToDesk()}>Add {chosenDesk.length || ""} to the match feed</button>
            {!!job?.manualTags.length && <ul className="vl-desk-list vl-desk-list--sent">
              {job.manualTags.map((tag) => <li key={tag.id}>
                <span>{LABELS[tag.type === "corner" ? "set_piece" : tag.type as Category]} · {tag.team === "home" ? job.request.home.name : job.request.away.name} · {clock(tag.second)}{tag.note ? ` · ${tag.note}` : ""}</span>
                <button type="button" disabled={streamingThis || deskBusy} onClick={() => void removeDeskTag(tag.id)}>Remove</button>
              </li>)}
            </ul>}
          </article>
          <article className="vl-handoff-card">
            <span className="vl-step-index" aria-hidden="true">3</span>
            <h4>Go live on the desk</h4>
            <p className="vl-help">Events stream in real time. Agents draft storylines for goals and red cards; you approve them on the live desk. Approved moments and every red card land in the highlights and recap, cut from this footage.</p>
            {confirmReplace && <p className="vl-error" role="alert">Another match is live. Going live replaces it. <button type="button" onClick={() => void goLive()}>Replace and go live</button> <button type="button" onClick={() => setConfirmReplace(false)}>Cancel</button></p>}
            <button type="button" className="vl-primary" disabled={!jobReady || streamingThis || deskBusy} onClick={() => void goLive()}>{streamingThis ? "Streaming to the desk" : "Go live on the desk"}</button>
          </article>
        </div>
        {deskError && <p className="vl-error" role="alert">{deskError}</p>}
      </section>}
      {doc && stats && <>
        <section className="vl-analysis" aria-label="Tagged observation analysis">
          <p className="vl-eyebrow">Detailed review, not match truth</p><h3>Tagged-observation analysis</h3>
          <p className="vl-help">All counts, timeline markers and library results use the same filters. Only saved manual tags and intentionally imported AI suggestions count. No possession, xG or tracking is inferred.</p>
          <div className="vl-filterbar">
            <label className="vl-field"><span>Search reviewed moments</span><input maxLength={2000} value={doc.filters.query} onChange={(e) => changeFilters({ query: e.target.value })} placeholder="Title, notes, players…" /></label>
            <label className="vl-field"><span>Filter team</span><select value={doc.filters.team} onChange={(e) => changeFilters({ team: e.target.value as Filters["team"] })}><option value="all">All teams</option><option value="home">Home</option><option value="away">Away</option><option value="neutral">Neutral</option></select></label>
            <label className="vl-field"><span>Filter player</span><select value={doc.filters.player} onChange={(e) => changeFilters({ player: e.target.value })}><option value="">All players</option>{doc.filters.player && !playerOptions.some((p) => p.player === doc.filters.player) && <option value={doc.filters.player}>{doc.filters.player}</option>}{playerOptions.map((entry) => <option key={entry.player} value={entry.player}>{entry.player}</option>)}</select></label>
            <label className="vl-field"><span>Filter category</span><select value={doc.filters.category} onChange={(e) => changeFilters({ category: e.target.value as Filters["category"] })}><option value="all">All categories</option>{CATEGORIES.map((category) => <option key={category} value={category}>{LABELS[category]}</option>)}</select></label>
            <label className="vl-field"><span>Filter origin</span><select value={doc.filters.source} onChange={(e) => changeFilters({ source: e.target.value as Filters["source"] })}><option value="all">All reviewed</option><option value="manual">Manual</option><option value="ai">AI · reviewed</option></select></label>
            <label className="vl-field"><span>Window from (s)</span><input type="number" step="any" min="0" max={doc.source.duration} value={timeWindow.from} onChange={(e) => setTimeWindow({ ...timeWindow, from: e.target.value })} /></label>
            <label className="vl-field"><span>Window to (s)</span><input type="number" step="any" min="0" max={doc.source.duration} value={timeWindow.to} onChange={(e) => setTimeWindow({ ...timeWindow, to: e.target.value })} /></label>
            <button type="button" onClick={() => {
              if (!timeWindow.from.trim() || !timeWindow.to.trim()) { setError("Enter both time-window boundaries."); return; }
              changeFilters({ from: Number(timeWindow.from), to: Number(timeWindow.to) });
            }}>Apply time window</button>
            <button type="button" onClick={() => { changeFilters(defaultFilters(doc.source.duration)); setTimeWindow({ from: "0", to: precise(doc.source.duration) }); }}>Reset filters</button>
          </div>
          <p className="vl-help">{stats.total} of {doc.annotations.length} annotations · Applied window {clock(doc.filters.from)}–{clock(doc.filters.to)} (overlapping clips; end exclusive). Goals do not imply extra shots. Defensive actions = tackle, pressing, defensive shape.</p>
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
          <div className="vl-library-heading"><div><p className="vl-eyebrow">Your marked moments</p><h3>Reviewed clip library</h3></div><span>{reviewed.length} shown / {doc.annotations.length} saved / {MAX_ANNOTATIONS} max</span></div>
          {!reviewed.length ? <div className="vl-empty">{doc.annotations.length ? "No reviewed moments match these filters. Reset filters to see your collection." : "Your review starts with one moment. Watch, choose a preset, add a note, and save."}</div> :
            <ul className="vl-clip-list">{reviewed.map((item) => <li key={item.id} className={`vl-clip${selected === item.id ? " is-selected" : ""}`} data-category={item.category}>
              <span className="vl-origin">{item.source.kind === "manual" ? "Manual" : item.source.inferred ? "AI · rule-inferred · reviewed" : "AI · reviewed"}</span>
              <h4><button type="button" className="vl-clip-title" onClick={() => edit(item)}>{item.title}</button></h4>
              <p className="vl-clip-meta">{clock(item.inSeconds)}–{clock(item.outSeconds)} · {LABELS[item.category]} · {item.team} · {item.outcome}</p>
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
      <details className="vl-ai" ref={aiPanel}>
        <summary>AI-assisted event detection <span>Optional · upload required</span></summary>
        <p>Builds the match feed from sampled frames. Review suggestions before adding any to your timeline. Manual tagging never waits for AI.</p>
        <p className="vl-help">This optional action uploads the full original video to the analysis server. Its uploaded source is removed after analysis; your local file remains the playback source. Requires configured vision and video processing. Nothing goes live until you choose Go live on the desk.</p>
        <fieldset disabled={busy}>
          <div className="vl-ai-setup">
            <label className="vl-field"><span>Home team name</span><input maxLength={40} value={teams.homeName} onChange={(e) => setTeams({ ...teams, homeName: e.target.value })} /></label>
            <label className="vl-field"><span>Home kit description</span><input maxLength={60} value={teams.homeKit} onChange={(e) => setTeams({ ...teams, homeKit: e.target.value })} placeholder="e.g. blue shirts, white shorts" /></label>
            <label className="vl-field"><span>Away team name</span><input maxLength={40} value={teams.awayName} onChange={(e) => setTeams({ ...teams, awayName: e.target.value })} /></label>
            <label className="vl-field"><span>Away kit description</span><input maxLength={60} value={teams.awayKit} onChange={(e) => setTeams({ ...teams, awayKit: e.target.value })} placeholder="e.g. red shirts, black shorts" /></label>
          </div>
          <label className="vl-consent"><input type="checkbox" checked={permission} onChange={(e) => setPermission(e.target.checked)} /><span>I have permission to use this footage and explicitly authorize uploading it for AI analysis.</span></label>
          <button type="button" className="vl-primary" disabled={!playable || !permission || Object.values(teams).some((value) => !value.trim())} onClick={() => void startAI()}>Upload for optional AI detection</button>
        </fieldset>
        {uploading && <label className="vl-field"><span>Uploading {Math.round(uploadProgress * 100)}%</span><progress className="vl-progress" max={1} value={uploadProgress} /></label>}
        {job && <div className="vl-notice" role="status"><p>Analysis: {job.stage} · {job.progress}%</p>{!TERMINAL.includes(job.stage) && <>
          <progress className="vl-progress" aria-label="AI analysis progress" max={100} value={job.progress} />
          <p className="vl-help">If you stop waiting, server analysis may still finish, but its results will no longer attach to this review. Local annotations are retained.</p>
          <button type="button" onClick={() => {
            generation.current++;
            setJob(null);
            setChosenAI([]);
            setChosenDesk([]);
            setAiError("");
            setNotice("Stopped waiting for AI results. Local annotations are unchanged; you can now switch files. This does not cancel server processing.");
          }}>Stop waiting and unlock source</button>
        </>}{job.error && <p>{job.error}</p>}</div>}
        {aiError && <p className="vl-error" role="alert">{aiError}</p>}
        {suggestions.error && <p className="vl-error" role="alert">{suggestions.error}</p>}
        {job?.stage === "ready" && !suggestions.error && <>
          <h3>Suggestions awaiting your review</h3><p className="vl-help">Model confidence is not certainty. Shots added only by builder rules are explicitly marked and have no visual evidence. Imported suggestions retain immutable job/event provenance; repeated import cannot add the same event twice. Up to 200 suggestions are displayed.</p>
          {!suggestions.items.length ? <p className="vl-empty">No supported suggestions in this source. Continue with manual annotations.</p> : <>
            <ul className="vl-ai-list">{suggestions.items.map((item) => <li className="vl-ai-suggestion" key={item.id}>
              <label className="vl-consent"><input type="checkbox" checked={chosenAI.includes(item.id)} disabled={isImported(item)} onChange={(event) => setChosenAI(event.target.checked ? [...chosenAI, item.id] : chosenAI.filter((id) => id !== item.id))} /><span>{item.title} · {item.team} {isImported(item) ? "· Already reviewed" : ""}</span></label>
              {item.source.kind === "ai" && <><p className="vl-clip-meta">{clock(item.source.timestampSeconds)} · {item.source.confidence === null ? "No measured confidence" : `Model confidence ${(item.source.confidence * 100).toFixed(0)}%`} · {item.source.inferred ? "Rule-inferred, not a real detection" : `Evidence frame ${item.source.frameIndex ?? "unavailable"}`}</p><p className="vl-evidence">{item.source.evidence}</p><button type="button" disabled={!playable} onClick={() => seek(item.source.kind === "ai" ? item.source.timestampSeconds : 0)}>{item.source.inferred ? "Seek inferred time" : "Seek evidence frame"}</button></>}
            </li>)}</ul>
            <button type="button" className="vl-primary" disabled={!chosenAI.length || !doc} onClick={() => {
              if (!doc) return;
              try {
                const incoming = suggestions.items.filter((item) => chosenAI.includes(item.id));
                if (commit(mergeAnnotations(doc.annotations, incoming, doc.source.duration))) {
                  setChosenAI([]); setNotice("Selected AI suggestions added to the review timeline. Only these reviewed observations now count.");
                }
              } catch (reason) { setError(message(reason)); }
            }}>Add to review timeline ({chosenAI.length} selected)</button>
          </>}
        </>}
      </details>
    </section>
  );
}
