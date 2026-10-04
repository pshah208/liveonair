import { useMemo, useState } from "react";
import type { Language, MatchEvent, MatchFixture, MatchSnapshot, NarrativeResponse, StoryCard } from "../shared/types.js";
import type { ArchivePlayerProfile, RecapStoryboard, ReviewStorylineRequest, Storyline, StorylineStatus, VerifiedFact } from "../shared/platform.js";
import {
  chapterText,
  claimText,
  eventSecond,
  factText,
  formatClaimSource,
  formatClock,
  formatMinuteLabel,
  hasActiveSpinner,
  localizeText,
  outcomeLabel,
  relationLabel,
  spellClubName,
  statusTone,
  storyCardIsRadar,
  storylineText,
  structuralLabel,
  teamTint
} from "./utils.js";
import type { AppRoute, Theme } from "./utils.js";

export function BrandMark() {
  return (
    <svg viewBox="0 0 360 72" className="brandmark" role="img" aria-label="MatchLens wordmark">
      <rect x="6" y="10" width="46" height="46" rx="14" fill="var(--cp-surface)" stroke="var(--cp-accent)" strokeWidth="4" />
      <path d="M18 42 28 26l10 16 8-11" fill="none" stroke="var(--cp-accent)" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4.5" />
      <circle cx="41" cy="24" r="6" fill="var(--cp-warning)" />
      <text x="70" y="34" fill="var(--cp-text)" fontSize="28" fontWeight="800" letterSpacing="-1">MatchLens</text>
      <text x="71" y="53" fill="var(--cp-text-soft)" fontSize="12" fontWeight="700" letterSpacing="1.5">SYNTHETIC MATCH INTELLIGENCE</text>
    </svg>
  );
}

type NavHeaderProps = { route: AppRoute; theme: Theme; onNavigate: (route: AppRoute) => void; onToggleTheme: () => void; };
export function NavHeader({ route, theme, onNavigate, onToggleTheme }: NavHeaderProps) {
  return (
    <header className="hero panel app-header">
      <div className="app-header__top">
        <div>
          <BrandMark />
          <p className="hero-copy">Microsoft + Premier League hackathon UI for explainable synthetic football coverage.</p>
        </div>
        <div className="app-header__actions">
          <span className="tag tag--accent">Synthetic match feed</span>
          <button type="button" className="button button--ghost" onClick={onToggleTheme}>Theme: {theme}</button>
        </div>
      </div>
      <nav className="route-tabs" aria-label="Primary">
        <button type="button" className={`route-tabs__item${route === "/" ? " is-active" : ""}`} onClick={() => onNavigate("/")} aria-current={route === "/" ? "page" : undefined}>Fan</button>
        <button type="button" className={`route-tabs__item${route === "/studio" ? " is-active" : ""}`} onClick={() => onNavigate("/studio")} aria-current={route === "/studio" ? "page" : undefined}>Studio</button>
      </nav>
    </header>
  );
}

type ScorebugProps = { home: string; away: string; score: { home: number; away: number }; clock?: string; secondary?: string; compact?: boolean; };
export function Scorebug({ home, away, score, clock, secondary, compact = false }: ScorebugProps) {
  return (
    <div className={`scorebug${compact ? " scorebug--compact" : ""}`} aria-label="Scorebug">
      <div className="scorebug__teams"><span>{home}</span><strong>{score.home}–{score.away}</strong><span>{away}</span></div>
      {(clock || secondary) && <div className="scorebug__meta">{clock && <span>{clock}</span>}{secondary && <span>{secondary}</span>}</div>}
    </div>
  );
}

type PitchProps = { fixture: MatchFixture; recentEvents: MatchEvent[]; selectedStory?: StoryCard | null; snapshotEvidence?: Record<string, MatchEvent>; title: string; subtitle: string; };
export function Pitch({ fixture, recentEvents, selectedStory, snapshotEvidence, title, subtitle }: PitchProps) {
  const highlightedEvents = useMemo(() => {
    if (selectedStory && snapshotEvidence) {
      const evidence = selectedStory.evidenceIds.map((id) => snapshotEvidence[id]).filter((event): event is MatchEvent => Boolean(event));
      if (evidence.length > 0) return evidence.slice(-8);
    }
    return recentEvents.slice(-8);
  }, [recentEvents, selectedStory, snapshotEvidence]);
  const latestEvent = highlightedEvents[highlightedEvents.length - 1] ?? null;
  return (
    <div className="panel pitch-panel">
      <div className="panel__header"><div><span className="eyebrow">{subtitle}</span><h2>{title}</h2></div><span className="tag">{latestEvent ? `${latestEvent.minute}' ${latestEvent.type.replaceAll("_", " ")}` : "Awaiting feed"}</span></div>
      <svg viewBox="0 0 100 68" className="pitch" role="img" aria-label={`${fixture.title} pitch map`}>
        <rect x="1" y="1" width="98" height="66" rx="4" fill="var(--cp-surface-soft)" stroke="var(--cp-border-strong)" strokeWidth="1.5" />
        <path d="M50 1v66M1 34h98" stroke="var(--cp-border)" strokeWidth="1" /><circle cx="50" cy="34" r="9.5" fill="none" stroke="var(--cp-border)" strokeWidth="1" /><circle cx="50" cy="34" r="0.85" fill="var(--cp-border-strong)" />
        <rect x="1" y="18" width="16" height="32" fill="none" stroke="var(--cp-border)" strokeWidth="1" /><rect x="83" y="18" width="16" height="32" fill="none" stroke="var(--cp-border)" strokeWidth="1" />
        <rect x="1" y="26" width="5" height="16" fill="none" stroke="var(--cp-border)" strokeWidth="1" /><rect x="94" y="26" width="5" height="16" fill="none" stroke="var(--cp-border)" strokeWidth="1" />
        <circle cx="12" cy="34" r="0.85" fill="var(--cp-border-strong)" /><circle cx="88" cy="34" r="0.85" fill="var(--cp-border-strong)" /><path d="M1 24a10 10 0 0 0 0 20M99 24a10 10 0 0 1 0 20" fill="none" stroke="var(--cp-border)" strokeWidth="1" />
        {highlightedEvents.slice().sort((a, b) => eventSecond(a) - eventSecond(b)).map((event, index, array) => {
          const active = array[array.length - 1]?.id === event.id;
          const x = event.x;
          const y = (event.y / 100) * 68;
          const endX = event.endX ?? event.x;
          const endY = ((event.endY ?? event.y) / 100) * 68;
          return (
            <g key={`${event.id}-${event.revision}`}>
              {(event.endX !== undefined || event.endY !== undefined) && <line x1={x} y1={y} x2={endX} y2={endY} stroke={teamTint(event.teamId)} strokeWidth={active ? 1.5 : 1} strokeDasharray={event.type === "pass" || event.type === "corner" ? "2.5 2" : undefined} opacity={0.88 - index * 0.08} />}
              <circle cx={x} cy={y} r={active ? 2.1 : 1.5} fill={teamTint(event.teamId)} className={active ? "pitch-pulse" : undefined} opacity={event.rescinded ? 0.35 : 0.96 - index * 0.08} />
            </g>
          );
        })}
      </svg>
      <div className="pitch-panel__legend"><span><i className="swatch swatch--home" /> {fixture.home.shortName}</span><span><i className="swatch swatch--away" /> {fixture.away.shortName}</span><span><i className="swatch swatch--selected" /> active evidence trail</span></div>
    </div>
  );
}

type RecentEventsListProps = { fixture: MatchFixture; events: MatchEvent[]; title: string; subtitle: string; emptyMessage: string; };
export function RecentEventsList({ fixture, events, title, subtitle, emptyMessage }: RecentEventsListProps) {
  const players = new Map([...fixture.home.players, ...fixture.away.players].map((player) => [player.id, player]));
  return (
    <div className="panel">
      <div className="panel__header"><div><span className="eyebrow">{subtitle}</span><h2>{title}</h2></div><span className="tag">{events.length} items</span></div>
      {events.length > 0 ? <div className="feed" role="region" aria-label={title} tabIndex={0}>{events.slice().sort((a, b) => eventSecond(b) - eventSecond(a)).map((event) => <article className={`feed-item${event.rescinded ? " is-muted" : ""}`} key={`${event.id}-${event.revision}`}><div className="feed-item__line"><span className="feed-item__time">{formatClock(eventSecond(event))}</span><span className="feed-item__type">{event.type.replaceAll("_", " ")}</span></div><strong>{players.get(event.playerId)?.name ?? "Unknown player"}</strong><p>{outcomeLabel(event)} · {event.teamId === "home" ? fixture.home.name : fixture.away.name}</p></article>)}</div> : <div className="empty-state">{emptyMessage}</div>}
    </div>
  );
}

type ReplayStoryRailProps = { snapshot: MatchSnapshot | null; selectedStoryId: string | null; onSelect: (storyId: string) => void; };
export function ReplayStoryRail({ snapshot, selectedStoryId, onSelect }: ReplayStoryRailProps) {
  const stories = snapshot?.stories ?? [];
  return (
    <div className="panel">
      <div className="panel__header"><div><span className="eyebrow">Story rail</span><h2>Editorial angles</h2></div><span className="tag">{stories.length} cards</span></div>
      {stories.length > 0 ? <div className="story-rail" role="list">{stories.map((story) => <button type="button" key={story.id} className={`story-card${selectedStoryId === story.id ? " is-active" : ""}${storyCardIsRadar(story) ? " story-card--radar" : ""}`} onClick={() => onSelect(story.id)} aria-pressed={selectedStoryId === story.id}><div className="story-card__meta"><span>{story.kind.replaceAll("_", " ")}</span><span>{formatMinuteLabel(story.windowStart)}–{formatMinuteLabel(story.windowEnd)}</span></div><h3>{story.title}</h3><p>{story.summary}</p>{storyCardIsRadar(story) && <div className="radar-cue">Watch next corner · {story.summary}</div>}<div className="story-card__footer"><span>{story.evidenceIds.length} evidence links</span><span>{structuralLabel(story)}</span></div></button>)}</div> : <div className="empty-state">Analysis stories appear after the selected replay state resolves.</div>}
    </div>
  );
}

type EvidenceDrawerProps = { fixture: MatchFixture; story: StoryCard | null; evidence: MatchEvent[]; coverage: number; };
export function EvidenceDrawer({ fixture, story, evidence, coverage }: EvidenceDrawerProps) {
  const players = new Map([...fixture.home.players, ...fixture.away.players].map((player) => [player.id, player]));
  return (
    <div className="panel">
      <div className="panel__header"><div><span className="eyebrow">Evidence drawer</span><h2>{story ? story.title : "Choose a story"}</h2></div><span className="tag">Coverage {Math.round(coverage)}%</span></div>
      {story ? <div className="evidence-drawer">{evidence.length > 0 ? evidence.slice().sort((a, b) => eventSecond(a) - eventSecond(b)).map((event) => <article className="evidence-item" key={`${event.id}-${event.revision}`}><div className="evidence-item__meta"><span>{formatClock(eventSecond(event))}</span><span>{event.type.replaceAll("_", " ")}</span><span>rev {event.revision}</span></div><strong>{players.get(event.playerId)?.name ?? "Unknown player"}</strong><p>{outcomeLabel(event)} · {event.teamId === "home" ? fixture.home.shortName : fixture.away.shortName}</p><div className="evidence-item__footer"><span>({event.x.toFixed(1)}, {event.y.toFixed(1)})</span><span>{structuralLabel(story)}</span></div></article>) : <div className="empty-state">No linked evidence is available for this story yet.</div>}</div> : <div className="empty-state">Pin a story card to inspect its supporting synthetic events.</div>}
    </div>
  );
}

type PlayerBioCardProps = { loading: boolean; error: string | null; profile: ArchivePlayerProfile | null; favoritePlayerName?: string; };
export function PlayerBioCard({ loading, error, profile, favoritePlayerName }: PlayerBioCardProps) {
  return (
    <div className="panel"><div className="panel__header"><div><span className="eyebrow">PlayerLens</span><h2>{profile?.person.name ?? favoritePlayerName ?? "Archive biography"}</h2></div></div>{loading ? <div className="skeleton skeleton--medium" /> : error ? <div className="banner banner--danger">{error}</div> : profile ? <div className="bio-card"><div className="bio-card__hero"><div><strong>{profile.person.position}</strong><p>Hometown: {profile.person.hometown}</p><p>Career goals: {profile.careerGoals}</p></div><span className="tag">Synthetic archive facts</span></div><div className="table-scroll"><table className="data-table"><caption>Career spells</caption><thead><tr><th scope="col">Club</th><th scope="col">Years</th><th scope="col">Apps</th><th scope="col">Goals</th></tr></thead><tbody>{profile.person.career.map((spell) => <tr key={`${spell.clubId}-${spell.fromYear}`}><td>{spellClubName(profile, spell.clubId)}</td><td>{spell.fromYear}–{spell.toYear ?? "present"}</td><td>{spell.appearances}</td><td>{spell.goals}</td></tr>)}</tbody></table></div><div className="bio-card__grid"><section><h3>Relatives</h3>{profile.relatives.length > 0 ? <ul className="plain-list">{profile.relatives.map((person) => { const relation = profile.person.relations.find((item) => item.personId === person.id); return <li key={person.id}>{person.name} · {relation ? relationLabel(relation.kind) : "relative"}</li>; })}</ul> : <p className="subtle-text">No linked relatives in the synthetic archive.</p>}</section><section><h3>Linked documents</h3>{profile.documents.length > 0 ? <ul className="plain-list">{profile.documents.map((document) => <li key={document.id}>{document.title}</li>)}</ul> : <p className="subtle-text">No archive documents linked to this player.</p>}</section></div></div> : <div className="empty-state">In player persona, MatchLens will pin a synthetic archive profile when the selected favorite player has an archive ID.</div>}</div>
  );
}

type FactTickerProps = { facts: VerifiedFact[]; language: Language; title?: string; };
export function FactTicker({ facts, language, title = "Verified facts" }: FactTickerProps) {
  return (
    <div className="panel"><div className="panel__header"><div><span className="eyebrow">Fact desk</span><h2>{title}</h2></div><span className="tag">{facts.length} facts</span></div>{facts.length > 0 ? <div className="ticker" role="log" aria-live="polite">{facts.map((fact) => { const localized = factText(fact, language); return <article className={`ticker__item${fact.retracted ? " is-muted" : ""}`} key={fact.id}><strong>{fact.minute}'</strong><p>{localized.text}</p><div className="ticker__meta">{localized.fallback && <span className="tag tag--ghost">translation unavailable</span>}{fact.retracted && <span className="tag tag--ghost">retracted</span>}</div></article>; })}</div> : <div className="empty-state">No verified facts have been published yet.</div>}</div>
  );
}

type NarrativePanelProps = { narrative: NarrativeResponse | null; loading: boolean; error: string | null; aiReady: boolean; onCurrentRecap: () => void; onFulltimeRecap: () => void; onCopy: () => void; copyMessage: string | null; };
export function NarrativePanel({ narrative, loading, error, aiReady, onCurrentRecap, onFulltimeRecap, onCopy, copyMessage }: NarrativePanelProps) {
  return (
    <div className="panel"><div className="panel__header"><div><span className="eyebrow">Narration</span><h2>Evidence-first recap</h2></div></div><div className="control-row"><button type="button" className="button button--primary" onClick={onCurrentRecap} disabled={!aiReady || loading}>Generate recap now</button><button type="button" className="button" onClick={onFulltimeRecap} disabled={!aiReady || loading}>Generate full-time recap</button></div>{!aiReady && <div className="banner banner--info">AI narration is not configured on the server.</div>}{loading && <div className="skeleton skeleton--tall" />}{error && <div className="banner banner--danger">{error}</div>}{narrative && !loading && <div className="narrative-panel"><div className="narrative-panel__top"><div><h3>{narrative.title}</h3><p>{narrative.script}</p></div><button type="button" className="button button--ghost" onClick={onCopy}>Copy recap</button></div>{copyMessage && <div className="banner banner--info">{copyMessage}</div>}<div className="claim-list">{narrative.claims.map((claim, index) => <article className="claim" key={`${claim.text}-${index}`}><p>{claim.text}</p><span>{claim.evidenceIds.length} linked evidence IDs</span></article>)}</div><div className="trace-panel"><div className="trace-panel__summary"><span>{narrative.source}</span><span>{narrative.model}</span><span>{narrative.cached ? "cached" : "fresh"}</span><span>{narrative.latencyMs} ms</span></div><div className="trace-grid">{narrative.trace.map((step, index) => <div className="trace-step" key={`${step.role}-${index}`}><strong>{step.role}</strong><span>{step.durationMs} ms</span><p>{step.detail}</p></div>)}</div></div></div>}</div>
  );
}

type OverlayPreviewProps = { storyline: Storyline | null; language: Language; onLanguageChange: (language: Language) => void; onExport: () => void; };
export function OverlayPreview({ storyline, language, onLanguageChange, onExport }: OverlayPreviewProps) {
  const headline = storyline ? storylineText(storyline.headline, language) : null;
  const overlay = storyline ? storylineText(storyline.overlay, language) : null;
  return (
    <div className="panel"><div className="panel__header"><div><span className="eyebrow">Overlay preview</span><h2>Broadcast lower-third</h2></div><div className="inline-select"><label><span className="sr-only">Overlay language</span><select value={language} onChange={(event) => onLanguageChange(event.target.value as Language)}><option value="en">EN</option><option value="es">ES</option><option value="fr">FR</option></select></label></div></div>{storyline ? <div className="overlay-preview"><div className="lower-third"><span className="lower-third__label">Synthetic match feed</span><strong>{headline?.text}</strong><p>{overlay?.text}</p></div><div className="ticker__meta">{headline?.fallback && <span className="tag tag--ghost">headline translation unavailable</span>}{overlay?.fallback && <span className="tag tag--ghost">overlay translation unavailable</span>}</div><button type="button" className="button button--primary" onClick={onExport}>Export overlay JSON</button></div> : <div className="empty-state">Select an approved storyline to preview a lower-third graphic.</div>}</div>
  );
}

const GROUPS: { key: StorylineStatus | "in_progress"; title: string }[] = [
  { key: "needs_review", title: "Needs review" },
  { key: "in_progress", title: "In progress" },
  { key: "approved", title: "Approved" },
  { key: "failed", title: "Failed" },
  { key: "rejected", title: "Rejected" },
  { key: "retracted", title: "Retracted" }
];

type StorylineQueueProps = { storylines: Storyline[]; selectedStorylineId: string | null; onSelect: (storylineId: string) => void; onReview: (storylineId: string, request: ReviewStorylineRequest) => Promise<void>; loadingById: Record<string, boolean>; errorById: Record<string, string | undefined>; };
export function StorylineQueue({ storylines, selectedStorylineId, onSelect, onReview, loadingById, errorById }: StorylineQueueProps) {
  const [languageById, setLanguageById] = useState<Record<string, Language>>({});
  const [editId, setEditId] = useState<string | null>(null);
  const [editValueById, setEditValueById] = useState<Record<string, string>>({});
  const [noteValueById, setNoteValueById] = useState<Record<string, string>>({});
  const inProgress = storylines.filter((item) => ["researching", "checking", "drafting"].includes(item.status));
  return (
    <div className="panel"><div className="panel__header"><div><span className="eyebrow">Storyline queue</span><h2>Broadcast producer review</h2></div><span className="tag">{storylines.length} items</span></div><div className="storyline-groups" role="log" aria-live="polite">{GROUPS.map((group) => {
      const items = group.key === "in_progress" ? inProgress : storylines.filter((storyline) => storyline.status === group.key);
      if (items.length === 0) return null;
      return <section key={group.key}><div className="queue-group__heading"><h3>{group.title}</h3><span className="tag tag--ghost">{items.length}</span></div><div className="story-rail">{items.map((storyline) => {
        const language = languageById[storyline.id] ?? "en";
        const headline = localizeText(storyline.headline, language);
        const onAirLine = localizeText(storyline.onAirLine, language);
        const overlay = localizeText(storyline.overlay, language);
        const isEditing = editId === storyline.id;
        const pending = loadingById[storyline.id];
        const editValue = editValueById[storyline.id] ?? storyline.onAirLine.en;
        const noteValue = noteValueById[storyline.id] ?? "";
        return <article className={`story-card story-card--queue${selectedStorylineId === storyline.id ? " is-active" : ""}`} key={storyline.id}><button type="button" className="story-card__select" onClick={() => onSelect(storyline.id)}><div className="story-card__meta"><span>{storyline.triggerMinute}'</span><span className={`status-pill status-pill--${statusTone(storyline.status)}`}>{storyline.status.replaceAll("_", " ")}</span></div><h3>{headline.text}</h3></button><div className="language-tabs" role="tablist" aria-label={`Language tabs for ${storyline.id}`}>{(["en", "es", "fr"] as Language[]).map((item) => <button type="button" key={item} className={`segmented__item${language === item ? " is-active" : ""}`} onClick={() => setLanguageById((current) => ({ ...current, [storyline.id]: item }))}>{item.toUpperCase()}</button>)}</div><p>{onAirLine.text}</p>{onAirLine.fallback && <span className="tag tag--ghost">translation unavailable</span>}<div className="story-card__footer"><span>Overlay: {overlay.text}</span><span>Priority {storyline.priority}</span></div><div className="claim-list">{storyline.claims.map((claim) => { const text = claimText(claim, language); return <article className="claim" key={claim.id}><div className="feed-item__line"><strong>{text.text}</strong><span className={`status-pill status-pill--${claim.status === "verified" ? "success" : "danger"}`}>{claim.status}</span></div>{text.fallback && <span className="tag tag--ghost">translation unavailable</span>}<div className="chips">{claim.sources.map((source) => <span className="tag tag--ghost" key={formatClaimSource(source)}>{formatClaimSource(source)}</span>)}</div>{claim.reason && <p className="subtle-text">{claim.reason}</p>}</article>; })}</div><div className="trace-grid">{storyline.trace.map((step, index) => <div className="trace-step" key={`${storyline.id}-${step.role}-${index}`}><div className="feed-item__line"><strong>{step.role}</strong><span>{step.durationMs} ms</span></div><p>{step.detail}</p><span>{step.status}</span></div>)}</div>{storyline.failureReason && <div className="banner banner--danger">{storyline.failureReason}</div>}{storyline.retractionReason && <div className="banner banner--warning">{storyline.retractionReason}</div>}{errorById[storyline.id] && <div className="banner banner--danger">{errorById[storyline.id]}</div>}{storyline.status === "needs_review" && <div className="review-box"><div className="control-row"><button type="button" className="button button--primary" disabled={pending} onClick={() => void onReview(storyline.id, { decision: "approve" })}>Approve</button><button type="button" className="button" disabled={pending} onClick={() => setEditId((current) => current === storyline.id ? null : storyline.id)}>Edit</button><button type="button" className="button" disabled={pending} onClick={() => void onReview(storyline.id, { decision: "reject", note: noteValue || undefined })}>Reject</button></div><label className="field"><span>Reviewer note</span><textarea value={noteValue} onChange={(event) => setNoteValueById((current) => ({ ...current, [storyline.id]: event.target.value }))} /></label>{isEditing && <div className="edit-box"><label className="field"><span>Edit English on-air line</span><textarea value={editValue} onChange={(event) => setEditValueById((current) => ({ ...current, [storyline.id]: event.target.value }))} /></label><button type="button" className="button button--primary" disabled={pending} onClick={() => void onReview(storyline.id, { decision: "edit", onAirLine: editValue, note: noteValue || undefined })}>Submit edit</button></div>}</div>}{hasActiveSpinner(storyline.status) && <div className="inline-progress" aria-hidden="true" />}</article>;
      })}</div></section>;
    })}</div></div>
  );
}

type StoryboardProps = { storyboard: RecapStoryboard | null; fixture: MatchFixture | null; storylines: Storyline[]; language: Language; loading: boolean; error: string | null; onRefresh: () => void; };
export function Storyboard({ storyboard, fixture, storylines, language, loading, error, onRefresh }: StoryboardProps) {
  const storylineMap = new Map(storylines.map((storyline) => [storyline.id, storyline]));
  return (
    <div className="panel"><div className="panel__header"><div><span className="eyebrow">Recap storyboard</span><h2>Chaptered match recap</h2></div><button type="button" className="button" onClick={onRefresh} disabled={loading}>Refresh</button></div>{loading && <div className="skeleton skeleton--medium" />}{error && <div className="banner banner--danger">{error}</div>}{storyboard && fixture ? <div className="storyboard-grid">{storyboard.chapters.map((chapter) => { const copy = chapterText(chapter, language); const events = fixture.events.filter((event) => chapter.eventIds.includes(event.id)).sort((a, b) => eventSecond(a) - eventSecond(b)); return <article className="storyboard-card" key={chapter.id}><div className="feed-item__line"><strong>{copy.title}</strong><span>{formatClock(chapter.startSecond)}–{formatClock(chapter.endSecond)}</span></div><p>{copy.summary}</p>{(copy.titleFallback || copy.summaryFallback) && <span className="tag tag--ghost">translation unavailable</span>}<MiniPitchSequence events={events} /><div className="chips">{chapter.storylineIds.map((storylineId) => <span className="tag tag--ghost" key={storylineId}>{storylineMap.get(storylineId)?.headline.en ?? storylineId}</span>)}</div></article>; })}</div> : !loading ? <div className="empty-state">Run or finish a synthetic live match to build the recap storyboard.</div> : null}</div>
  );
}

function MiniPitchSequence({ events }: { events: MatchEvent[] }) {
  return (
    <svg viewBox="0 0 100 68" className="mini-pitch" role="img" aria-label="Chapter mini pitch sequence">
      <rect x="1" y="1" width="98" height="66" rx="4" fill="var(--cp-surface-soft)" stroke="var(--cp-border-strong)" strokeWidth="1.2" />
      <path d="M50 1v66M1 34h98" stroke="var(--cp-border)" strokeWidth="1" /><circle cx="50" cy="34" r="8" fill="none" stroke="var(--cp-border)" strokeWidth="1" />
      {events.slice(0, 12).map((event, index) => { const x = event.x; const y = (event.y / 100) * 68; const endX = event.endX ?? event.x; const endY = ((event.endY ?? event.y) / 100) * 68; return <g key={`${event.id}-${index}`} className="mini-pitch__event" style={{ animationDelay: `${index * 160}ms` }}>{(event.endX !== undefined || event.endY !== undefined) && <line x1={x} y1={y} x2={endX} y2={endY} stroke={teamTint(event.teamId)} strokeWidth="1" opacity="0.8" />}<circle cx={x} cy={y} r="1.7" fill={teamTint(event.teamId)} opacity={event.rescinded ? 0.35 : 0.95} /></g>; })}
    </svg>
  );
}
