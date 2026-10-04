import { useEffect, useMemo, useRef, useState } from "react";
import type { LiveStatus } from "../shared/platform.js";
import type { MatchEvent, MatchFixture, TeamId } from "../shared/types.js";
import { DETECTABLE_EVENT_TYPES, MAX_MANUAL_TAGS, type DetectableEventType, type VideoJob, type VideoJobStage, type VideoJobSummary } from "../shared/video.js";
import { api, uploadVideo, type VideoHealth } from "./api.js";
import { Panel } from "./components.js";
import { formatClock, getErrorMessage, labelize } from "./utils.js";
import { latestRevisions } from "../shared/highlights.js";

export type VideoFootage = { fixtureId: string; url: string; name: string };

type VideoLabProps = {
  status: LiveStatus | null;
  liveFixture: MatchFixture | null;
  onStreamed: (status: LiveStatus) => void;
  onOpenDesk: () => void;
  /** The processed clip, so the recap can cut real footage around the tagged moments. */
  onFootage: (footage: VideoFootage | null) => void;
};

const TERMINAL: VideoJobStage[] = ["ready", "rejected", "failed"];
const ACCEPT = "video/mp4,video/quicktime,video/webm";

const STEPS: { stage: VideoJobStage; title: string; service: string }[] = [
  { stage: "queued", title: "Upload", service: "Container Apps API" },
  { stage: "probing", title: "Probe", service: "ffprobe" },
  { stage: "extracting", title: "Sample frames", service: "ffmpeg" },
  { stage: "analysing", title: "Tag events", service: "Azure OpenAI vision" },
  { stage: "building", title: "Apply rules", service: "Deterministic builder" },
  { stage: "ready", title: "Ready to stream", service: "Fabric Eventstream" }
];

function stepState(job: VideoJob | null, index: number): "done" | "active" | "todo" | "failed" {
  if (!job) return "todo";
  const current = job.stage === "rejected" || job.stage === "failed" ? -1 : STEPS.findIndex((step) => step.stage === job.stage);
  if (current === -1) {
    const reached = job.frames.length > 0 ? (job.batchesDone > 0 ? 3 : 2) : job.durationSeconds ? 1 : 0;
    return index < reached ? "done" : index === reached ? "failed" : "todo";
  }
  if (index < current || job.stage === "ready") return "done";
  return index === current ? "active" : "todo";
}

function eventSecond(event: MatchEvent): number {
  return event.minute * 60 + event.second;
}

/** Accepts "12", "0:12" or "1:05" and returns whole seconds. */
function parseClock(value: string): number | null {
  const match = value.trim().match(/^(?:(\d{1,2}):)?(\d{1,3})$/u);
  if (!match) return null;
  const minutes = Number(match[1] ?? 0);
  const seconds = Number(match[2]);
  if (match[1] !== undefined && seconds > 59) return null;
  return minutes * 60 + seconds;
}

function describeEvent(event: MatchEvent, fixture: MatchFixture | null, names?: { home: string; away: string }): string {
  const team = event.teamId === "home" ? fixture?.home.shortName ?? names?.home : fixture?.away.shortName ?? names?.away;
  const player = [...(fixture?.home.players ?? []), ...(fixture?.away.players ?? [])].find((item) => item.id === event.playerId);
  const shirt = event.playerId.match(/-(\d+)$/u)?.[1];
  return `${labelize(event.type)} · ${player?.name ?? `${team ?? event.teamId}${shirt ? ` #${shirt}` : ""}`}`;
}

export function VideoLab({ status, liveFixture, onStreamed, onOpenDesk, onFootage }: VideoLabProps) {
  const [health, setHealth] = useState<VideoHealth | null>(null);
  const [attested, setAttested] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [homeName, setHomeName] = useState("Home");
  const [homeKit, setHomeKit] = useState("");
  const [awayName, setAwayName] = useState("Away");
  const [awayKit, setAwayKit] = useState("");
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [job, setJob] = useState<VideoJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [videoTime, setVideoTime] = useState(0);
  const [frameIndex, setFrameIndex] = useState<number | null>(null);
  const [tagType, setTagType] = useState<DetectableEventType>("goal");
  const [tagTeam, setTagTeam] = useState<TeamId>("home");
  const [tagTime, setTagTime] = useState("");
  const [tagShirt, setTagShirt] = useState("");
  const [tagNote, setTagNote] = useState("");
  const [tagging, setTagging] = useState(false);
  const [library, setLibrary] = useState<VideoJobSummary[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  function refreshLibrary() {
    api.listVideoJobs().then((list) => setLibrary(list ?? [])).catch(() => undefined);
  }

  async function deleteClip(id: string) {
    setDeleting(true);
    setError(null);
    try {
      await api.deleteVideoJob(id);
      if (job?.id === id) { setJob(null); setFile(null); setFileUrl(null); setFrameIndex(null); }
      setConfirmDelete(null);
      refreshLibrary();
    } catch (reason: unknown) {
      setError(getErrorMessage(reason));
    } finally {
      setDeleting(false);
    }
  }
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.getVideoHealth(controller.signal).then(setHealth).catch(() => setHealth(null));
    return () => controller.abort();
  }, []);

  useEffect(() => () => { if (fileUrl) URL.revokeObjectURL(fileUrl); }, [fileUrl]);

  const readyFixtureId = job?.stage === "ready" ? job.fixtureId : undefined;
  useEffect(() => {
    onFootage(readyFixtureId && fileUrl && file ? { fixtureId: readyFixtureId, url: fileUrl, name: file.name } : null);
  }, [readyFixtureId, fileUrl, file]);

  // The library refreshes on open and whenever a job is created or settles.
  useEffect(() => { refreshLibrary(); }, [job?.id, job?.stage, job?.manualTags.length]);

  // Poll the worker until the job reaches a terminal stage.
  useEffect(() => {
    if (!job || TERMINAL.includes(job.stage)) return;
    const timer = window.setInterval(() => {
      api.getVideoJob(job.id).then((next) => { if (next) setJob(next); }).catch((reason: unknown) => setError(getErrorMessage(reason)));
    }, 1_200);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.stage]);

  function chooseFile(next: File | undefined) {
    if (!next) return;
    setError(null);
    setJob(null);
    setFile(next);
    setFileUrl(URL.createObjectURL(next));
    setVideoTime(0);
  }

  async function startProcessing() {
    if (!file) return;
    setError(null);
    setUploadProgress(0);
    try {
      const created = await uploadVideo(file, { home: { name: homeName.trim() || "Home", kit: homeKit.trim() }, away: { name: awayName.trim() || "Away", kit: awayKit.trim() } }, setUploadProgress);
      setJob(created);
    } catch (reason: unknown) {
      setError(getErrorMessage(reason));
    } finally {
      setUploadProgress(null);
    }
  }

  async function swapTeams() {
    if (!job) return;
    setError(null);
    try {
      const next = await api.swapVideoTeams(job.id);
      if (next) setJob(next);
    } catch (reason: unknown) {
      setError(getErrorMessage(reason));
    }
  }

  async function addTag() {
    if (!job) return;
    const second = tagTime.trim() === "" ? Math.floor(videoTime) : parseClock(tagTime);
    if (second === null) { setError("Enter the time as seconds or m:ss, e.g. 12 or 0:12."); return; }
    const shirt = tagShirt.trim() === "" ? null : Number(tagShirt);
    if (shirt !== null && !(Number.isInteger(shirt) && shirt >= 1 && shirt <= 99)) { setError("Shirt number must be 1–99."); return; }
    setTagging(true);
    setError(null);
    try {
      const next = await api.addVideoTag(job.id, { type: tagType, team: tagTeam, second, shirtNumber: shirt, ...(tagNote.trim() ? { note: tagNote.trim() } : {}) });
      if (next) setJob(next);
      setTagTime("");
      setTagShirt("");
      setTagNote("");
    } catch (reason: unknown) {
      setError(getErrorMessage(reason));
    } finally {
      setTagging(false);
    }
  }

  async function removeTag(tagId: string) {
    if (!job) return;
    setError(null);
    try {
      const next = await api.removeVideoTag(job.id, tagId);
      if (next) setJob(next);
    } catch (reason: unknown) {
      setError(getErrorMessage(reason));
    }
  }

  async function streamToDesk() {
    if (!job) return;
    setStreaming(true);
    setError(null);
    try {
      const next = await api.startVideoLive(job.id);
      if (next) onStreamed(next);
      const video = videoRef.current;
      if (video) {
        video.currentTime = 0;
        await video.play().catch(() => undefined);
      }
    } catch (reason: unknown) {
      setError(getErrorMessage(reason));
    } finally {
      setStreaming(false);
    }
  }

  const isLiveForJob = Boolean(job?.fixtureId && liveFixture?.id === job.fixtureId);
  const liveLocked = isLiveForJob && status?.state === "running";
  // Overlays only use events that came back through the live pipeline, so they prove the round trip.
  const streamed = useMemo(() => (isLiveForJob && liveFixture ? latestRevisions(liveFixture.events) : []), [isLiveForJob, liveFixture]);
  const shown = streamed.filter((event) => eventSecond(event) <= videoTime && !["kickoff", "fulltime"].includes(event.type));
  const score = shown.reduce((acc, event) => (event.type === "goal" && !event.rescinded ? { ...acc, [event.teamId]: acc[event.teamId] + 1 } : acc), { home: 0, away: 0 });
  const latest = shown.at(-1);
  const latestFresh = latest && videoTime - eventSecond(latest) <= 4;
  const evidenceById = new Map(job?.evidence.map((item) => [item.eventId, item]) ?? []);
  const detected = (job?.events ?? []).filter((event) => !["kickoff", "fulltime"].includes(event.type));
  const busy = uploadProgress !== null || (job !== null && !TERMINAL.includes(job.stage));
  const unavailable = health !== null && (!health.visionConfigured || !health.ffmpeg);

  return (
    <div className="recap-grid video-lab">
      <div className="desk-col">
        <Panel eyebrow="Video lab" title="Process your own clip" aside={<span className="tag tag--accent">Experimental</span>}>
          <p className="lede">
            Upload a short clip (up to 3 minutes, 100 MB). The video worker samples frames with ffmpeg, a vision model tags passes, shots,
            goals, saves, fouls and cards, and deterministic rules turn them into match events. Tag up to {MAX_MANUAL_TAGS} moments it missed yourself.
            Stream them through Fabric Eventstream and the live desk, storyline agents and highlight reel run on what the camera saw;
            Recap and highlights then cuts a video recap from this clip.
          </p>
          {unavailable && <div className="banner banner--warning">Video processing isn't available on this server ({!health?.ffmpeg ? "ffmpeg missing" : "vision model not configured"}).</div>}

          <div className="video-stage">
            {fileUrl ? (
              <div className="video-frame">
                <video ref={videoRef} src={fileUrl} controls playsInline className="video-frame__video" onTimeUpdate={(event) => setVideoTime(event.currentTarget.currentTime)} onSeeked={(event) => setVideoTime(event.currentTarget.currentTime)} />
                {isLiveForJob && liveFixture && (
                  <div className="video-overlay" aria-live="polite">
                    <div className="video-overlay__bug">
                      <span>{liveFixture.home.shortName}</span>
                      <strong className="mono">{score.home}–{score.away}</strong>
                      <span>{liveFixture.away.shortName}</span>
                      <span className="mono video-overlay__clock">{formatClock(videoTime)}</span>
                    </div>
                    {latestFresh && latest && (
                      <div className={`video-overlay__event video-overlay__event--${latest.type}`} key={latest.id}>
                        <span className="eyebrow">Via Eventstream · {formatClock(eventSecond(latest))}</span>
                        <strong>{describeEvent(latest, liveFixture)}</strong>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="footage__intake">
                <label className="checkbox">
                  <input type="checkbox" checked={attested} onChange={(event) => setAttested(event.target.checked)} />
                  <span>I filmed this clip myself or have a licence to use it. It contains no Premier League, broadcaster or other third-party footage.</span>
                </label>
                <label className={`button button--primary footage__file${attested && !unavailable ? "" : " is-disabled"}`}>
                  Choose video file
                  <input type="file" accept={ACCEPT} disabled={!attested || unavailable} onChange={(event) => chooseFile(event.target.files?.[0])} />
                </label>
                <p className="subtle-text">The clip is uploaded to this app's worker and deleted when processing finishes. The sampled frames are kept as evidence for this session.</p>
              </div>
            )}
          </div>

          {file && !job && (
            <>
              <div className="field-grid">
                <label className="field"><span>Home team</span><input type="text" maxLength={40} value={homeName} onChange={(event) => setHomeName(event.target.value)} /></label>
                <label className="field"><span>Home kit (optional)</span><input type="text" maxLength={60} placeholder="e.g. red shirts" value={homeKit} onChange={(event) => setHomeKit(event.target.value)} /></label>
                <label className="field"><span>Away team</span><input type="text" maxLength={40} value={awayName} onChange={(event) => setAwayName(event.target.value)} /></label>
                <label className="field"><span>Away kit (optional)</span><input type="text" maxLength={60} placeholder="e.g. white shirts" value={awayKit} onChange={(event) => setAwayKit(event.target.value)} /></label>
              </div>
              <div className="control-row">
                <button type="button" className="button button--primary" onClick={() => void startProcessing()} disabled={busy || unavailable}>
                  {uploadProgress !== null ? `Uploading ${Math.round(uploadProgress * 100)}%` : "Process video"}
                </button>
                <button type="button" className="button button--ghost" onClick={() => { setFile(null); setFileUrl(null); }} disabled={busy}>Choose another file</button>
                <span className="subtle-text footage__name">{file.name} · {(file.size / 1_048_576).toFixed(1)} MB</span>
              </div>
              <p className="subtle-text">Kit colours help the model tell the teams apart. Without them it describes the kits itself from the first frames.</p>
            </>
          )}

          {job?.stage === "ready" && (
            <div className="control-row">
              <button type="button" className="button button--primary" onClick={() => void streamToDesk()} disabled={streaming || status?.state === "running"}>
                {isLiveForJob && status?.state === "running" ? "Streaming…" : "Stream to live desk"}
              </button>
              <button type="button" className="button" onClick={onOpenDesk}>Open live desk</button>
              <button type="button" className="button button--ghost" onClick={() => void swapTeams()} disabled={streaming || (status?.state === "running" && isLiveForJob)} title="Use this if the model put the teams on the wrong sides">Swap teams</button>
              <button type="button" className="button button--ghost" onClick={() => { setJob(null); setFile(null); setFileUrl(null); }} disabled={status?.state === "running" && isLiveForJob}>New clip</button>
            </div>
          )}
          {job?.stage === "ready" && status?.state === "running" && !isLiveForJob && <p className="subtle-text">Another match is live. Stop it on the live desk to stream this clip.</p>}
          {job && TERMINAL.includes(job.stage) && job.stage !== "ready" && (
            <div className="control-row"><button type="button" className="button" onClick={() => { setJob(null); setFile(null); setFileUrl(null); }}>Try another clip</button></div>
          )}
          {error && <div className="banner banner--danger" role="alert">{error}</div>}
        </Panel>

        <Panel eyebrow="Evidence" title="Detected events" aside={job && <span className="tag">{job.detectionsAccepted} of {job.detectionsRaw} accepted</span>}>
          {detected.length > 0 ? (
            <div className="table-scroll">
              <table className="data-table video-events">
                <thead><tr><th scope="col">Time</th><th scope="col">Event</th><th scope="col">Confidence</th><th scope="col">What the model saw</th><th scope="col">Frame</th></tr></thead>
                <tbody>
                  {detected.map((event) => {
                    const proof = evidenceById.get(event.id);
                    const manual = proof?.source === "manual";
                    const arrived = streamed.some((item) => item.id === event.id);
                    return (
                      <tr key={event.id} className={arrived ? "is-streamed" : undefined}>
                        <td className="mono">{formatClock(eventSecond(event))}</td>
                        <td><span className={`swatch swatch--${event.teamId}`} aria-hidden="true" /> {describeEvent(event, liveFixture?.id === job?.fixtureId ? liveFixture : null, job ? { home: job.request.home.name, away: job.request.away.name } : undefined)}{!proof && <span className="tag tag--ghost">rule</span>}{manual && <span className="tag tag--accent">you</span>}</td>
                        <td className="mono">{manual ? "Tagged" : proof ? `${Math.round(proof.confidence * 100)}%` : "—"}</td>
                        <td className="subtle-text">{proof?.description ?? (event.type === "shot" ? "Added: a goal needs a shot." : "")}</td>
                        <td>
                          {proof && proof.frameIndex >= 0 && <button type="button" className="link-button" onClick={() => setFrameIndex(proof.frameIndex)} title={manual ? "Nearest sampled frame" : undefined}>#{proof.frameIndex}</button>}
                          {manual && proof.tagId && <button type="button" className="link-button video-events__remove" onClick={() => void removeTag(proof.tagId!)} disabled={liveLocked} aria-label={`Remove your ${labelize(event.type)} tag at ${formatClock(eventSecond(event))}`}>Remove</button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">{job?.stage === "ready" ? "No events passed the confidence and team rules. Try a clip with clearer action or add kit colours." : "Events appear here once the worker has processed a clip."}</div>
          )}
          {job?.stage === "ready" && (
            <div className="video-tagger">
              <div className="video-tagger__head">
                <strong>Tag a missed moment</strong>
                <span className="tag mono">{job.manualTags.length}/{MAX_MANUAL_TAGS}</span>
              </div>
              <p className="subtle-text">The model only sees sampled frames. Pause the clip where it missed something and add it here. Your tags go through the same rules and stream like any other event.</p>
              <div className="video-tagger__grid">
                <label className="field"><span>Event</span>
                  <select value={tagType} onChange={(event) => setTagType(event.target.value as DetectableEventType)}>{DETECTABLE_EVENT_TYPES.map((type) => <option key={type} value={type}>{labelize(type)}</option>)}</select>
                </label>
                <label className="field"><span>Team</span>
                  <select value={tagTeam} onChange={(event) => setTagTeam(event.target.value as TeamId)}>
                    <option value="home">{job.request.home.name}</option>
                    <option value="away">{job.request.away.name}</option>
                  </select>
                </label>
                <label className="field"><span>Time</span>
                  <input type="text" inputMode="numeric" maxLength={6} placeholder={formatClock(Math.floor(videoTime))} value={tagTime} onChange={(event) => setTagTime(event.target.value)} aria-describedby="tag-time-hint" />
                </label>
                <label className="field"><span>Shirt # (optional)</span>
                  <input type="text" inputMode="numeric" maxLength={2} value={tagShirt} onChange={(event) => setTagShirt(event.target.value.replace(/\D/gu, ""))} />
                </label>
                <label className="field video-tagger__note"><span>Note (optional)</span>
                  <input type="text" maxLength={120} placeholder="e.g. header at the far post" value={tagNote} onChange={(event) => setTagNote(event.target.value)} />
                </label>
              </div>
              <div className="control-row">
                <button type="button" className="button button--primary" onClick={() => void addTag()} disabled={tagging || liveLocked || job.manualTags.length >= MAX_MANUAL_TAGS}>
                  {tagging ? "Adding…" : `Add ${labelize(tagType).toLowerCase()} at ${tagTime.trim() || formatClock(Math.floor(videoTime))}`}
                </button>
                <span id="tag-time-hint" className="subtle-text">
                  {liveLocked ? "Stop the live stream to change tags." : job.manualTags.length >= MAX_MANUAL_TAGS ? `Limit reached — remove a tag to add another.` : "Leave Time empty to use where the video is paused."}
                </span>
              </div>
            </div>
          )}
          {job && frameIndex !== null && (
            <figure className="video-evidence">
              <img src={`/api/video/jobs/${job.id}/frames/${frameIndex}`} alt={`Sampled frame ${frameIndex}`} />
              <figcaption className="subtle-text">Frame #{frameIndex} at {formatClock(job.frames.find((frame) => frame.index === frameIndex)?.timestampSeconds ?? 0)} · exactly what the model was shown. <button type="button" className="link-button" onClick={() => setFrameIndex(null)}>Close</button></figcaption>
            </figure>
          )}
        </Panel>
      </div>

      <div className="desk-col">
        <Panel eyebrow="Video worker" title={job ? labelize(job.stage) : "Waiting for a clip"} aside={job && <span className="tag mono">{job.progress}%</span>}>
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
                    {step.stage === "extracting" && job && job.frames.length > 0 && <span className="subtle-text">{job.frames.length} frames</span>}
                    {step.stage === "analysing" && job && job.batchesTotal > 0 && <span className="subtle-text">Batch {job.batchesDone}/{job.batchesTotal} · {job.model}</span>}
                  </div>
                </li>
              );
            })}
          </ol>
          {job?.error && <div className={`banner ${job.stage === "rejected" ? "banner--warning" : "banner--danger"}`}>{job.stage === "rejected" ? "Rejected by the footage check: " : ""}{job.error}</div>}
          {job && (
            <dl className="meta-grid">
              <div><dt>Clip</dt><dd>{job.durationSeconds ? `${job.durationSeconds} s` : "—"}{job.width ? ` · ${job.width}×${job.height}` : ""}</dd></div>
              <div><dt>Tokens</dt><dd className="mono">{job.usage.inputTokens.toLocaleString()} in · {job.usage.outputTokens.toLocaleString()} out</dd></div>
              <div><dt>Kits</dt><dd>{job.kits ? `${job.kits.home} / ${job.kits.away}` : "—"}</dd></div>
              <div><dt>Fixture</dt><dd className="mono">{job.fixtureId ?? "—"}</dd></div>
            </dl>
          )}
          {job && (
            <details className="disclosure">
              <summary>Worker log ({job.log.length})</summary>
              <ol className="worker-log">{job.log.map((entry, index) => <li key={index}><span className="mono subtle-text">{new Date(entry.at).toLocaleTimeString()}</span> {entry.message}</li>)}</ol>
            </details>
          )}
        </Panel>

        <Panel eyebrow="Library" title="Uploaded clips" aside={<span className="tag">{library.length}</span>}>
          {library.length > 0 ? (
            <ul className="clip-library">
              {library.map((item) => {
                const locked = (status?.state === "running" && item.fixtureId !== undefined && status.fixtureId === item.fixtureId) || !TERMINAL.includes(item.stage);
                return (
                  <li key={item.id} className={`clip-library__item${item.id === job?.id ? " is-current" : ""}`}>
                    <div className="clip-library__main">
                      <strong>{item.title}</strong>
                      <span className="subtle-text">{item.fileName} · {new Date(item.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
                      <span className="chips chips--start">
                        <span className={`tag${item.stage === "ready" ? " tag--success" : item.stage === "failed" || item.stage === "rejected" ? " tag--danger" : ""}`}>{labelize(item.stage)}</span>
                        {item.durationSeconds !== undefined && <span className="tag mono">{Math.round(item.durationSeconds)} s</span>}
                        {item.stage === "ready" && <span className="tag">{item.eventCount} events{item.manualTagCount ? ` · ${item.manualTagCount} yours` : ""}</span>}
                        {item.id === job?.id && <span className="tag tag--accent">Open</span>}
                      </span>
                    </div>
                    {confirmDelete === item.id ? (
                      <div className="clip-library__actions">
                        <button type="button" className="button button--small button--danger" onClick={() => void deleteClip(item.id)} disabled={deleting}>{deleting ? "Deleting…" : "Delete"}</button>
                        <button type="button" className="button button--small button--ghost" onClick={() => setConfirmDelete(null)} disabled={deleting}>Cancel</button>
                      </div>
                    ) : (
                      <button type="button" className="button button--small button--ghost" onClick={() => setConfirmDelete(item.id)} disabled={locked} title={locked ? "Stop the stream or wait for processing to finish" : "Delete the frames, events and fixture for this clip"} aria-label={`Delete ${item.title} (${item.fileName})`}>Delete</button>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="empty-state">No clips yet. Processed clips stay here (frames, events and the match) until you delete them or the server restarts.</div>
          )}
          <p className="subtle-text">The source video is already removed after processing. Deleting a clip also removes its sampled frames, detected events, your tags and its match from the fixture list. The worker keeps the six most recent clips.</p>
        </Panel>

        <Panel eyebrow="Honest limits" title="What the worker can and can't see">
          <ul className="plain-list">
            <li>It looks at one frame every 1–3 seconds (60 frames at most), so quick passes between frames are missed.</li>
            <li>Teams come from kit colours; players only get a number when it is legible.</li>
            <li>Positions are where the action is in the frame, not tracked pitch coordinates.</li>
            <li>Only detections at 50% confidence or more with a known team become events. A goal always gets a matching shot.</li>
            <li>Diagrams, animations, games and test patterns are rejected before any events are made.</li>
            <li>A live data feed such as Opta would replace this step in production; the rest of the pipeline is the same.</li>
          </ul>
        </Panel>
      </div>
    </div>
  );
}
