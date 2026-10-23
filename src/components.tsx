import { useMemo, useState } from "react";
import type { Language, MatchEvent, MatchFixture, MatchSnapshot, NarrativeResponse, TeamStats } from "../shared/types.js";
import type { RecapStoryboard, ReviewStorylineRequest, Storyline, StorylineHandoff, StorylineStatus, VerifiedFact } from "../shared/platform.js";
import { latestRevisions } from "../shared/highlights.js";
import { placeEvent } from "../shared/ballPath.js";
import {
  chapterText,
  claimText,
  eventSecond,
  factText,
  formatClaimSource,
  formatClock,
  hasActiveSpinner,
  labelize,
  localizeText,
  outcomeLabel,
  statusTone,
  storylineText,
  teamTint,
  transportBadge,
  SYNTHETIC_BADGE_TEXT,
  type Theme
} from "./utils.js";

// ------------------------------------------------------------------ shell

export function BrandMark() {
  return (
    <svg viewBox="0 0 240 44" className="brandmark" role="img" aria-label="Live on Air">
      <rect x="2" y="4" width="36" height="36" rx="8" fill="var(--cp-accent)" />
      <path d="M11 30 19 17l8 13 6-9" fill="none" stroke="var(--cp-accent-fg)" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.5" />
      <circle cx="30" cy="14" r="4.5" fill="var(--team-away)" />
      <text x="50" y="30" fill="var(--cp-text)" fontSize="24" fontWeight="700" letterSpacing="-0.5" fontFamily="var(--font)">Live on Air</text>
    </svg>
  );
}

type AppHeaderProps = { theme: Theme; onToggleTheme: () => void; infraOpen: boolean; onToggleInfra: () => void; desk: "studio" | "fan"; onDesk: (desk: "studio" | "fan") => void };
const DESK_TAGLINE: Record<AppHeaderProps["desk"], string> = {
  studio: "Live storylines, recaps and highlights from a verified match feed",
  fan: "Your match: personal insights from the same verified live feed"
};

/** Small persistent disclosure: the match, clubs and players are fictional and analytics are illustrative. */
export function SyntheticBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`synthetic-badge${compact ? " synthetic-badge--compact" : ""}`} role="note" aria-label={SYNTHETIC_BADGE_TEXT}>
      {SYNTHETIC_BADGE_TEXT}
    </span>
  );
}

/** Shows the live `transport` and `source` from /api/live/status. Renders nothing when neither is known. */
export function TransportSourceBadge({ status }: { status: unknown }) {
  const badge = transportBadge(status);
  if (!badge.transport && !badge.source) return null;
  return (
    <span className="tag transport-badge" data-transport={badge.transport ?? "unknown"}>
      {badge.transport ? `Transport: ${badge.transport}` : "Transport: unknown"}
      {badge.source ? ` · Source: ${badge.source}` : ""}
    </span>
  );
}

export function AppHeader({ theme, onToggleTheme, infraOpen, onToggleInfra, desk, onDesk }: AppHeaderProps) {
  return (
    <header className="app-header">
      <div className="app-header__brand">
        <BrandMark />
        <div className="desk-switch" role="group" aria-label="Desk">
          <button type="button" className={`desk-switch__item${desk === "studio" ? " is-active" : ""}`} aria-pressed={desk === "studio"} onClick={() => onDesk("studio")}>Studio Desk</button>
          <button type="button" className={`desk-switch__item${desk === "fan" ? " is-active" : ""}`} aria-pressed={desk === "fan"} onClick={() => onDesk("fan")}>Fan View</button>
        </div>
        <span className="app-header__tagline">{DESK_TAGLINE[desk]}</span>
      </div>
      <div className="app-header__actions">
        <SyntheticBadge />
        {desk === "studio" && (
          <button type="button" className="button button--ghost" onClick={onToggleInfra} aria-pressed={infraOpen}>
            {infraOpen ? "Hide architecture" : "How it works"}
          </button>
        )}
        <button type="button" className="button button--ghost" onClick={onToggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
          {theme === "dark" ? "Light theme" : "Dark theme"}
        </button>
      </div>
    </header>
  );
}

type PanelProps = { eyebrow?: string; title: string; aside?: React.ReactNode; children: React.ReactNode; className?: string };
export function Panel({ eyebrow, title, aside, children, className }: PanelProps) {
  return (
    <section className={`panel${className ? ` ${className}` : ""}`}>
      <header className="panel__header">
        <div>
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          <h2>{title}</h2>
        </div>
        {aside && <div className="chips">{aside}</div>}
      </header>
      {children}
    </section>
  );
}

// ------------------------------------------------------------------ broadcast bar

type BroadcastBarProps = {
  fixture: MatchFixture | null;
  score: { home: number; away: number };
  clockSecond: number;
  state: "idle" | "running" | "finished";
  transport: string;
  /** Raw /api/live/status payload, used for the transport/source badge. */
  status?: unknown;
  lagMs?: number;
  eventsReceived: number;
};
export function BroadcastBar({ fixture, score, clockSecond, state, transport, status, lagMs, eventsReceived }: BroadcastBarProps) {
  return (
    <section className="broadcast-bar" aria-label="Match status">
      <div className="broadcast-bar__score">
        <span className="broadcast-bar__team">{fixture?.home.name ?? "Home"}</span>
        <strong className="broadcast-bar__digits">{score.home} – {score.away}</strong>
        <span className="broadcast-bar__team">{fixture?.away.name ?? "Away"}</span>
      </div>
      <div className="broadcast-bar__meta">
        <span className={`live-pill live-pill--${state}`}>{state === "running" ? "Live" : state === "finished" ? "Full time" : "Idle"}</span>
        <span className="mono broadcast-bar__clock">{formatClock(clockSecond)}</span>
        <span className="tag">{transport}</span>
        <TransportSourceBadge status={status} />
        {lagMs !== undefined && <span className="tag">{lagMs} ms lag</span>}
        <span className="tag">{eventsReceived} events</span>
        <SyntheticBadge compact />
      </div>
    </section>
  );
}

export function Scorebug({ home, away, score, clock }: { home: string; away: string; score: { home: number; away: number }; clock?: string }) {
  return (
    <div className="scorebug" aria-label="Scorebug">
      <span>{home}</span>
      <strong>{score.home}–{score.away}</strong>
      <span>{away}</span>
      {clock && <span className="scorebug__clock mono">{clock}</span>}
    </div>
  );
}

// ------------------------------------------------------------------ pitch

export { Pitch } from "./LivePitch.js";

// ------------------------------------------------------------------ stats

const STAT_ROWS: { label: string; hint?: string; get: (stats: TeamStats) => number | null | undefined; format?: (value: number) => string; bar?: boolean }[] = [
  { label: "Shots", get: (stats) => stats.shots },
  { label: "illustrative xG", get: (stats) => stats.illustrativeXg, format: (value) => value.toFixed(2) },
  { label: "Pass accuracy", get: (stats) => stats.passAccuracy, format: (value) => `${Math.round(value)}%` },
  { label: "Avg pass length", hint: "Mean pass length on a 105 × 68 m pitch", get: (stats) => stats.avgPassDistanceM, format: (value) => `${value.toFixed(1)} m` },
  { label: "Long-pass accuracy", hint: "Completion of passes longer than 30 m", get: (stats) => stats.longPassAccuracy, format: (value) => `${Math.round(value)}%` },
  { label: "Avg pass difficulty (illustrative, uncalibrated)", hint: "0–100 heuristic: distance, forward progress, destination, pressure, switch, cross", get: (stats) => stats.avgPassDifficulty, format: (value) => value.toFixed(0) },
  { label: "Completion vs heuristic (illustrative, uncalibrated)", hint: "Completed passes minus an uncalibrated heuristic baseline, percentage points of attempts", get: (stats) => stats.completionOverExpected, format: (value) => `${value > 0 ? "+" : ""}${value.toFixed(1)} pp`, bar: false },
  { label: "Fastest shot", hint: "Shot's recorded speed, or goal-distance divided by its own flight time; unavailable without either", get: (stats) => stats.fastestShotKmh, format: (value) => `${Math.round(value)} km/h` },
  { label: "Corners", get: (stats) => stats.corners },
  { label: "Cards", get: (stats) => stats.yellowCards + stats.redCards }
];

export function LiveStats({ snapshot, fixture }: { snapshot: MatchSnapshot | null; fixture: MatchFixture }) {
  if (!snapshot) return <div className="empty-state">Stats appear with the first live snapshot.</div>;
  return (
    <table className="stat-table">
      <thead>
        <tr><th scope="col">{fixture.home.shortName}</th><th scope="col"><span className="sr-only">Statistic</span></th><th scope="col">{fixture.away.shortName}</th></tr>
      </thead>
      <tbody>
        {STAT_ROWS.map((row) => {
          const homeValue = row.get(snapshot.stats.home);
          const awayValue = row.get(snapshot.stats.away);
          // Metric rows are absent on older snapshots and null when unavailable (e.g. camera-frame clips).
          if (homeValue === undefined && awayValue === undefined) return null;
          const home = homeValue ?? 0;
          const away = awayValue ?? 0;
          const total = row.bar === false || homeValue == null || awayValue == null ? 0 : home + away;
          const base = row.format ?? ((value: number) => String(value));
          const format = (value: number | null | undefined) => (value == null ? "—" : base(value));
          return (
            <tr key={row.label}>
              <td className="mono">{format(homeValue)}</td>
              <td>
                <span className="stat-table__label">{row.label}</span>
                {row.hint && <small className="stat-table__hint">{row.hint}</small>}
                <span className={`stat-bar${total <= 0 ? " stat-bar--empty" : ""}`} aria-hidden="true"><span className="stat-bar__home" style={{ width: `${total <= 0 ? 50 : (home / total) * 100}%` }} /></span>
              </td>
              <td className="mono">{format(awayValue)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ------------------------------------------------------------------ event feed

type EventFeedProps = { fixture: MatchFixture; onCorrect?: (eventId: string) => void; correctingId?: string | null };
const NOTABLE = new Set(["goal", "shot", "save", "yellow_card", "red_card", "corner", "kickoff", "halftime", "fulltime", "substitution"]);
export function EventFeed({ fixture, onCorrect, correctingId }: EventFeedProps) {
  const [showAll, setShowAll] = useState(false);
  const players = useMemo(() => new Map([...fixture.home.players, ...fixture.away.players].map((player) => [player.id, player.name])), [fixture]);
  const events = latestRevisions(fixture.events)
    .filter((event) => showAll || NOTABLE.has(event.type))
    .slice()
    .sort((a, b) => eventSecond(b) - eventSecond(a))
    .slice(0, 40);
  return (
    <div className="event-feed">
      <label className="switch">
        <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />
        <span>Show passes, pressures and tackles</span>
      </label>
      {events.length === 0 ? (
        <div className="empty-state">Events appear here as the feed arrives.</div>
      ) : (
        <ol className="event-list" aria-live="polite">
          {events.map((event) => (
            <li key={`${event.id}-${event.revision}`} className={`event-row event-row--${event.type}${event.rescinded ? " is-rescinded" : ""}`}>
              <span className="event-row__time mono">{formatClock(eventSecond(event))}</span>
              <span className="event-row__team" style={{ background: teamTint(event.teamId) }} aria-hidden="true" />
              <span className="event-row__body">
                <strong>{labelize(event.type)}</strong>
                <span>{players.get(event.playerId) ?? "Unknown player"} · {outcomeLabel(event)}{event.xg !== undefined && (event.type === "shot" || event.type === "goal") ? ` · ${event.xg.toFixed(2)} illustrative xG` : ""}</span>
              </span>
              {event.type === "goal" && !event.rescinded && onCorrect && (
                <button type="button" className="button button--small" onClick={() => onCorrect(event.id)} disabled={correctingId === event.id}>Rule out</button>
              )}
              {event.rescinded && <span className="tag tag--danger">Ruled out</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ facts

export function FactTicker({ facts, language }: { facts: VerifiedFact[]; language: Language }) {
  if (facts.length === 0) return <div className="empty-state">Verified facts appear as the desk checks each moment.</div>;
  return (
    <ol className="fact-list" aria-live="polite">
      {facts.slice(0, 12).map((fact) => {
        const text = factText(fact, language);
        return (
          <li key={fact.id} className={`fact${fact.retracted ? " is-retracted" : ""}`}>
            <span className="fact__minute mono">{fact.minute}'</span>
            <span>{text.text}{fact.retracted && <span className="tag tag--danger">retracted</span>}</span>
          </li>
        );
      })}
    </ol>
  );
}

// ------------------------------------------------------------------ storyline queue

const QUEUE_ORDER: { key: StorylineStatus | "working"; title: string }[] = [
  { key: "needs_review", title: "Needs review" },
  { key: "working", title: "Agents working" },
  { key: "approved", title: "On air" },
  { key: "retracted", title: "Retracted" },
  { key: "failed", title: "Blocked by guardrails" },
  { key: "rejected", title: "Rejected" }
];

type StorylineQueueProps = {
  storylines: Storyline[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onReview: (id: string, request: ReviewStorylineRequest) => Promise<void>;
  pendingById: Record<string, boolean>;
  errorById: Record<string, string | undefined>;
  language: Language;
};
export function StorylineQueue({ storylines, selectedId, onSelect, onReview, pendingById, errorById, language }: StorylineQueueProps) {
  if (storylines.length === 0) {
    return <div className="empty-state">When a goal or big moment lands, the agents research it and a storyline appears here for review.</div>;
  }
  return (
    <div className="queue" role="log" aria-live="polite">
      {QUEUE_ORDER.map((group) => {
        const items = storylines.filter((storyline) => (group.key === "working" ? hasActiveSpinner(storyline.status) : storyline.status === group.key));
        if (items.length === 0) return null;
        return (
          <section key={group.key} className="queue__group">
            <h3 className="queue__heading">{group.title} <span className="count">{items.length}</span></h3>
            {items.map((storyline) => (
              <StorylineCard key={storyline.id} storyline={storyline} selected={selectedId === storyline.id} onSelect={onSelect} onReview={onReview} pending={Boolean(pendingById[storyline.id])} error={errorById[storyline.id]} language={language} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

type StorylineCardProps = { storyline: Storyline; selected: boolean; onSelect: (id: string) => void; onReview: (id: string, request: ReviewStorylineRequest) => Promise<void>; pending: boolean; error?: string; language: Language };
function StorylineCard({ storyline, selected, onSelect, onReview, pending, error, language }: StorylineCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(storyline.onAirLine.en);
  const headline = localizeText(storyline.headline, language);
  const onAir = localizeText(storyline.onAirLine, language);
  const verified = storyline.claims.filter((claim) => claim.status === "verified").length;
  return (
    <article className={`story${selected ? " is-active" : ""}${storyline.status === "retracted" ? " is-retracted" : ""}`}>
      <button type="button" className="story__select" onClick={() => onSelect(storyline.id)} aria-pressed={selected}>
        <span className="story__meta">
          <span className="mono">{storyline.triggerMinute}'</span>
          <span className={`status-pill status-pill--${statusTone(storyline.status)}`}>{labelize(storyline.status)}</span>
        </span>
        <strong className="story__headline">{headline.text || (hasActiveSpinner(storyline.status) ? "Researching this moment…" : `No copy drafted for the ${storyline.triggerMinute}' moment`)}</strong>
        {onAir.text && <span className="story__line">{onAir.text}</span>}
        {(headline.fallback || onAir.fallback) && <span className="tag tag--ghost">translation unavailable</span>}
      </button>
      {hasActiveSpinner(storyline.status) && <div className="inline-progress" aria-hidden="true" />}
      {storyline.failureReason && <p className="story__note story__note--danger">{storyline.failureReason}</p>}
      {storyline.retractionReason && <p className="story__note story__note--warning">{storyline.retractionReason}</p>}
      {error && <p className="story__note story__note--danger">{error}</p>}

      {storyline.status === "needs_review" && (
        <div className="story__actions">
          <button type="button" className="button button--primary button--small" disabled={pending} onClick={() => void onReview(storyline.id, { decision: "approve" })}>Approve</button>
          <button type="button" className="button button--small" disabled={pending} onClick={() => setEditing((current) => !current)}>{editing ? "Cancel edit" : "Edit"}</button>
          <button type="button" className="button button--small button--ghost" disabled={pending} onClick={() => void onReview(storyline.id, { decision: "reject" })}>Reject</button>
        </div>
      )}
      {editing && (
        <div className="story__edit">
          <label className="field"><span>On-air line (English, re-checked before approval)</span><textarea value={draft} onChange={(event) => setDraft(event.target.value)} /></label>
          <button type="button" className="button button--primary button--small" disabled={pending} onClick={() => void onReview(storyline.id, { decision: "edit", onAirLine: draft }).then(() => setEditing(false))}>Submit edit</button>
        </div>
      )}

      {(storyline.claims.length > 0 || (storyline.handoffs?.length ?? 0) > 0) && (
        <details className="disclosure disclosure--compact">
          <summary>Evidence: {verified}/{storyline.claims.length} claims verified · agent handoffs &amp; trace</summary>
          <ul className="claim-list">
            {storyline.claims.map((claim) => {
              const text = claimText(claim, language);
              return (
                <li key={claim.id} className={`claim claim--${claim.status}`}>
                  <span>{text.text}</span>
                  <span className="claim__sources">{claim.sources.map((source) => <code key={formatClaimSource(source)}>{formatClaimSource(source)}</code>)}</span>
                  {claim.reason && <span className="subtle-text">{claim.reason}</span>}
                </li>
              );
            })}
          </ul>
          <HandoffTimeline handoffs={storyline.handoffs} />
          <TraceTable steps={storyline.trace} />
        </details>
      )}
    </article>
  );
}

const HANDOFF_TONE: Record<StorylineHandoff["outcome"], "success" | "info" | "warning" | "danger"> = {
  ok: "success",
  retry: "warning",
  fallback: "warning",
  skipped: "warning",
  escalated: "info",
  failed: "danger",
};

/** Coordinator handoff log: which agent handed to which, why, and whether it was a recovery. */
export function HandoffTimeline({ handoffs }: { handoffs?: StorylineHandoff[] }) {
  if (!handoffs || handoffs.length === 0) return null;
  const recoveries = handoffs.filter((handoff) => handoff.recovery).length;
  return (
    <section className="handoff-timeline" aria-label="Agent handoffs">
      <h4 className="handoff-timeline__title">
        Handoffs <span className="count">{handoffs.length}</span>
        {recoveries > 0 && <span className="tag tag--danger">{recoveries} {recoveries === 1 ? "recovery" : "recoveries"}</span>}
      </h4>
      <ol className="handoff-timeline__list">
        {handoffs.map((handoff, index) => (
          <li key={`${handoff.at}-${index}`} className={`handoff handoff--${handoff.outcome}${handoff.recovery ? " handoff--recovery" : ""}`}>
            <span className="handoff__route">
              <strong>{labelize(handoff.from)}</strong>
              <span aria-hidden="true"> → </span><span className="sr-only"> hands off to </span>
              <strong>{labelize(handoff.to)}</strong>
            </span>
            <span className={`status-pill status-pill--${HANDOFF_TONE[handoff.outcome] ?? "info"}`}>{handoff.outcome}</span>
            {handoff.decidedBy === "director" && <span className="tag tag--accent">director</span>}
            {handoff.recovery && (
              <span className="tag tag--danger handoff__recovery">recovery: {labelize(handoff.recovery)}{handoff.errorClass ? ` · ${labelize(handoff.errorClass)}` : ""}</span>
            )}
            <span className="handoff__reason">{handoff.reason}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function TraceTable({ steps }: { steps: { role: string; status?: string; detail: string; durationMs: number }[] }) {
  if (steps.length === 0) return null;
  return (
    <table className="trace-table">
      <thead><tr><th scope="col">Step</th><th scope="col">Result</th><th scope="col" className="num">Time</th></tr></thead>
      <tbody>
        {steps.map((step, index) => (
          <tr key={`${step.role}-${index}`}>
            <th scope="row">{labelize(step.role)}{step.status && step.status !== "complete" ? <span className="status-pill status-pill--danger">{step.status}</span> : null}</th>
            <td>{step.detail}</td>
            <td className="num mono">{step.durationMs.toLocaleString()} ms</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ------------------------------------------------------------------ overlay preview

type OverlayPreviewProps = { storyline: Storyline | null; language: Language; onExport: () => void };
export function OverlayPreview({ storyline, language, onExport }: OverlayPreviewProps) {
  if (!storyline) return <div className="empty-state">Approve a storyline to preview its lower-third.</div>;
  const headline = storylineText(storyline.headline, language);
  const overlay = storylineText(storyline.overlay, language);
  return (
    <div className="overlay-preview">
      <div className="lower-third">
        <span className="lower-third__label">{storyline.triggerMinute}' · Live on Air</span>
        <strong>{headline.text}</strong>
        <span>{overlay.text}</span>
      </div>
      <div className="control-row control-row--start">
        <button type="button" className="button button--small" onClick={onExport}>Export overlay JSON</button>
        {(headline.fallback || overlay.fallback) && <span className="tag tag--ghost">translation unavailable</span>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ recap

type RecapPanelProps = {
  narrative: NarrativeResponse | null;
  loading: boolean;
  error: string | null;
  aiReady: boolean;
  disabled: boolean;
  onGenerate: () => void;
  controls: React.ReactNode;
};
export function RecapPanel({ narrative, loading, error, aiReady, disabled, onGenerate, controls }: RecapPanelProps) {
  const [copied, setCopied] = useState<string | null>(null);
  async function copy() {
    if (!narrative) return;
    try {
      await navigator.clipboard.writeText(`${narrative.title}\n\n${narrative.script}`);
      setCopied("Copied");
    } catch {
      setCopied("Copy failed");
    }
    window.setTimeout(() => setCopied(null), 2000);
  }
  return (
    <Panel eyebrow="Foundry narrator" title="Written recap" aside={narrative && <span className="tag">{narrative.claims.length} grounded claims</span>}>
      <div className="recap-controls">
        {controls}
        <button type="button" className="button button--primary" onClick={onGenerate} disabled={!aiReady || loading || disabled}>{loading ? "Writing…" : narrative ? "Regenerate" : "Generate recap"}</button>
      </div>
      {!aiReady && <div className="banner banner--info">AI narration isn't configured on this server.</div>}
      {error && <div className="banner banner--danger">{error}</div>}
      {loading && !narrative && <div className="skeleton" />}
      {narrative && (
        <article className={`recap${loading ? " is-stale" : ""}`}>
          <div className="recap__head">
            <h3>{narrative.title}</h3>
            <button type="button" className="button button--ghost button--small" onClick={() => void copy()}>{copied ?? "Copy"}</button>
          </div>
          <p className="recap__script">{narrative.script}</p>
          {narrative.audioUrl && <audio className="recap__audio" controls preload="none" src={narrative.audioUrl} aria-label="Listen to the recap" />}
          <details className="disclosure disclosure--compact">
            <summary>How this recap was generated</summary>
            <dl className="meta-grid">
              <div><dt>Model</dt><dd>{narrative.model}</dd></div>
              <div><dt>Total time</dt><dd className="mono">{narrative.latencyMs.toLocaleString()} ms</dd></div>
              <div><dt>Tokens</dt><dd className="mono">{narrative.usage.inputTokens} in · {narrative.usage.outputTokens} out</dd></div>
              <div><dt>Cache</dt><dd>{narrative.cached ? "Cached" : "Fresh"}</dd></div>
            </dl>
            <TraceTable steps={narrative.trace} />
            <h4>Claims and evidence</h4>
            <ul className="claim-list">
              {narrative.claims.map((claim, index) => (
                <li key={`${claim.text}-${index}`} className="claim claim--verified">
                  <span>{claim.text}</span>
                  <span className="claim__sources">{claim.evidenceIds.map((id) => <code key={id}>{id}</code>)}</span>
                </li>
              ))}
            </ul>
          </details>
        </article>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ storyboard

type StoryboardProps = { storyboard: RecapStoryboard | null; fixture: MatchFixture; storylines: Storyline[]; language: Language };
export function Storyboard({ storyboard, fixture, storylines, language }: StoryboardProps) {
  const storylineMap = new Map(storylines.map((storyline) => [storyline.id, storyline]));
  if (!storyboard || storyboard.chapters.length === 0) return <div className="empty-state">Chapters are built from event windows as the match progresses.</div>;
  return (
    <ol className="chapters">
      {storyboard.chapters.map((chapter, index) => {
        const copy = chapterText(chapter, language);
        const events = latestRevisions(fixture.events).filter((event) => chapter.eventIds.includes(event.id)).sort((a, b) => eventSecond(a) - eventSecond(b));
        return (
          <li className="chapter" key={chapter.id}>
            <span className="chapter__index mono">{String(index + 1).padStart(2, "0")}</span>
            <div className="chapter__body">
              <div className="chapter__head"><strong>{copy.title}</strong><span className="mono subtle-text">{formatClock(chapter.startSecond)}–{formatClock(chapter.endSecond)}</span></div>
              <p>{copy.summary}</p>
              {chapter.storylineIds.length > 0 && (
                <div className="chips">{chapter.storylineIds.map((id) => <span className="tag" key={id}>{storylineMap.get(id) ? localizeText(storylineMap.get(id)!.headline, language).text : id}</span>)}</div>
              )}
            </div>
            <MiniPitch fixture={fixture} events={events} />
          </li>
        );
      })}
    </ol>
  );
}

function MiniPitch({ fixture, events }: { fixture: MatchFixture; events: MatchEvent[] }) {
  return (
    <svg viewBox="0 0 100 68" className="mini-pitch" role="img" aria-label="Chapter events on the pitch">
      <rect x="1" y="1" width="98" height="66" rx="3" fill="var(--cp-surface-soft)" stroke="var(--cp-border-strong)" strokeWidth="0.8" />
      <path d="M50 1v66" stroke="var(--cp-border)" strokeWidth="0.6" />
      {events.slice(0, 14).map((event, index) => {
        const point = placeEvent(fixture, event);
        return (
          <circle key={`${event.id}-${index}`} cx={point.x} cy={(point.y / 100) * 68} r="2" fill={teamTint(event.teamId)} opacity={event.rescinded ? 0.3 : 0.9} />
        );
      })}
    </svg>
  );
}
