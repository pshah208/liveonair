import { useState } from "react";
import { momentCreditLine, type FanMoment, type FanMomentCredit } from "../../shared/fan.js";
import { momentMapPoint, TEAM_KIT } from "../../shared/fanCards.js";
import { latestRevisions } from "../../shared/highlights.js";
import type { MatchFixture } from "../../shared/types.js";
import { MiniMap } from "./MiniMap.js";
import { FAN_TEXT } from "./strings.js";

const INITIAL_VISIBLE = 3;

type MomentCardsProps = {
  fixture: MatchFixture;
  moments: FanMoment[];
  credits: ReadonlyMap<string, FanMomentCredit>;
  favoritePlayerId?: string;
};

/** Producer-approved moments, newest first. Tap a card to see why it matters, the evidence and who wrote it. */
export function MomentCards({ fixture, moments, credits, favoritePlayerId }: MomentCardsProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? moments : moments.slice(0, INITIAL_VISIBLE);
  const toggle = (id: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return (
    <section className="fan-p2-moments" aria-labelledby="fan-moments-title">
      <div className="fan-p2-section__head">
        <span className="eyebrow">{FAN_TEXT.approvedEyebrow}</span>
        <h2 id="fan-moments-title" className="fan-p2-section__title">{FAN_TEXT.momentsTitle}</h2>
        {moments.length > 0 && <span className="tag">{moments.length}</span>}
      </div>
      {moments.length === 0 ? <p className="fan-p2-empty">{FAN_TEXT.momentsEmpty}</p> : (
        <ul className="fan-p2-moments__list">
          {visible.map((moment) => (
            <MomentCard key={moment.id} fixture={fixture} moment={moment} credit={credits.get(moment.id)} expanded={open.has(moment.id)}
              onToggle={() => toggle(moment.id)} yourPlayer={Boolean(favoritePlayerId) && moment.playerId === favoritePlayerId} />
          ))}
        </ul>
      )}
      {moments.length > INITIAL_VISIBLE && (
        <button type="button" className="button button--ghost button--small fan-p2-moments__more" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>
          {showAll ? FAN_TEXT.showFewerMoments : FAN_TEXT.showAllMoments(moments.length)}
        </button>
      )}
    </section>
  );
}

function MomentCard({ fixture, moment, credit, expanded, onToggle, yourPlayer }: {
  fixture: MatchFixture; moment: FanMoment; credit?: FanMomentCredit; expanded: boolean; onToggle: () => void; yourPlayer: boolean;
}) {
  const bodyId = `fan-moment-${moment.id.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
  const corrected = moment.status === "corrected";
  const events = new Map(latestRevisions(fixture.events).map((event) => [event.id, event]));
  const players = new Map([...fixture.home.players, ...fixture.away.players].map((player) => [player.id, player]));
  const trigger = moment.eventIds.map((id) => events.get(id)).find(Boolean);
  const point = trigger ? momentMapPoint(fixture, trigger) : null;
  const team = moment.teamId ? fixture[moment.teamId] : undefined;
  const player = moment.playerId ? players.get(moment.playerId) : undefined;
  const sourceLabel = (source: { type: "event" | "archive"; id: string }) => {
    if (source.type === "archive") return FAN_TEXT.archiveSource;
    const event = events.get(source.id);
    if (!event) return FAN_TEXT.feedSource;
    const who = players.get(event.playerId)?.name;
    return `${event.minute}′ ${event.type.replace(/_/gu, " ")}${who ? ` · ${who}` : ""}${event.rescinded ? ` (${FAN_TEXT.correctedPill.toLowerCase()})` : ""}`;
  };
  return (
    <li className={`fan-p2-moment${corrected ? " is-corrected" : ""}`}>
      <button type="button" className="fan-p2-moment__toggle" aria-expanded={expanded} aria-controls={bodyId} onClick={onToggle}>
        <span className="fan-p2-moment__minute mono">{moment.minute}′</span>
        <span className={`fan-p2-pill${corrected ? " fan-p2-pill--corrected" : " fan-p2-pill--approved"}`}>{corrected ? FAN_TEXT.correctedPill : FAN_TEXT.approvedPill}</span>
        <span className="fan-p2-moment__headline">{corrected ? <s>{moment.headline}</s> : moment.headline}</span>
        <span className="fan-p2-moment__chevron" aria-hidden="true">{expanded ? "−" : "+"}</span>
        <span className="sr-only">{expanded ? FAN_TEXT.hideDetails : FAN_TEXT.showDetails}</span>
      </button>
      <div id={bodyId} className="fan-p2-moment__body" hidden={!expanded}>
        {corrected && <p className="fan-p2-moment__correction"><strong>{FAN_TEXT.correctedPill}:</strong> {moment.correction}</p>}
        <dl className="fan-p2-moment__facts">
          <dt>{FAN_TEXT.whyItMatters}</dt>
          <dd>{moment.whyItMatters || moment.headline}{moment.fallback && <span className="tag fan-p2-moment__fallback">{FAN_TEXT.englishFallback}</span>}</dd>
          <dt>{FAN_TEXT.minute}</dt>
          <dd>{moment.minute}′{team ? ` · ${team.name}` : ""}{player ? ` · ${player.name}` : ""}{yourPlayer && <span className="tag tag--accent fan-p2-inline-tag">{FAN_TEXT.yourPlayer}</span>}</dd>
          <dt>{FAN_TEXT.evidence}</dt>
          <dd>
            {moment.evidence.length === 0 ? FAN_TEXT.noEvidence : (
              <ul className="fan-p2-moment__evidence">
                {moment.evidence.map((item) => (
                  <li key={item.id}>
                    <span>{item.text}</span>
                    {item.sources.length > 0 && <span className="fan-p2-moment__sources">{item.sources.map(sourceLabel).join(" · ")}</span>}
                  </li>
                ))}
              </ul>
            )}
          </dd>
          <dt>{FAN_TEXT.writtenBy}</dt>
          <dd>{momentCreditLine(credit)}</dd>
        </dl>
        {point && <MiniMap point={point} color={moment.teamId ? TEAM_KIT[moment.teamId] : "currentColor"} />}
      </div>
    </li>
  );
}
