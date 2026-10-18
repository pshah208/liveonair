import { useRef } from "react";
import { pickBigMoment, TEAM_KIT, type BigMoment as BigMomentModel, type MiniMapPoint } from "../../shared/fanCards.js";
import type { Storyline } from "../../shared/platform.js";
import type { Language, MatchFixture } from "../../shared/types.js";

const KIND_LABEL = { goal: "Goal", red_card: "Red card", latest: "Latest" } as const;

/** Small canonical 105x68 pitch with the linked event (and its end point, if any). Not flipped. */
function MiniMap({ point, color }: { point: MiniMapPoint; color: string }) {
  const hasEnd = point.endX !== undefined && point.endY !== undefined;
  return (
    <svg className="fan-moment__map" viewBox="0 0 105 68" role="img" aria-label="Where it happened on the pitch">
      <rect x="0.5" y="0.5" width="104" height="67" fill="none" stroke="currentColor" strokeWidth="0.6" />
      <line x1="52.5" y1="0.5" x2="52.5" y2="67.5" stroke="currentColor" strokeWidth="0.5" />
      <circle cx="52.5" cy="34" r="9.15" fill="none" stroke="currentColor" strokeWidth="0.5" />
      <rect x="0.5" y="13.85" width="16.5" height="40.3" fill="none" stroke="currentColor" strokeWidth="0.5" />
      <rect x="88" y="13.85" width="16.5" height="40.3" fill="none" stroke="currentColor" strokeWidth="0.5" />
      {hasEnd && <line x1={point.x} y1={point.y} x2={point.endX} y2={point.endY} stroke={color} strokeWidth="1.2" strokeDasharray="2 1.5" />}
      {hasEnd && <circle cx={point.endX} cy={point.endY} r="1.6" fill="none" stroke={color} strokeWidth="1" />}
      <circle cx={point.x} cy={point.y} r="2.4" fill={color} />
    </svg>
  );
}

export function BigMomentCard({ fixture, storylines, language }: { fixture: MatchFixture; storylines: Storyline[]; language: Language }) {
  // Remember the last moment shown so a later retraction says "updated" instead of silently vanishing.
  const lastShown = useRef<string | undefined>(undefined);
  const moment: BigMomentModel = pickBigMoment(fixture, storylines, language, lastShown.current);
  if (moment.state === "moment") lastShown.current = moment.storylineId;
  else if (moment.state === "empty") lastShown.current = undefined;
  const players = new Map([...fixture.home.players, ...fixture.away.players].map((player) => [player.id, player]));
  const team = moment.teamId ? fixture[moment.teamId] : undefined;
  const player = moment.playerId ? players.get(moment.playerId) : undefined;
  return (
    <section className="fan-card fan-card--moment" aria-label="Big moment">
      <h3 className="fan-card__title fan-card__title--small">Big moment</h3>
      {moment.state === "empty" && <p className="fan-card__empty">No big moment yet. We'll flag the next one.</p>}
      {moment.state === "updated" && <p className="fan-card__empty" role="status">This moment was updated.</p>}
      {moment.state === "moment" && (
        <div className="fan-moment">
          <div className="fan-moment__meta">
            <span className="fan-moment__minute mono">{moment.minute}′</span>
            <span className="fan-card__pill fan-card__pill--n">{KIND_LABEL[moment.kind ?? "latest"]}</span>
            {team && <span className="fan-card__chip" style={{ borderColor: TEAM_KIT[moment.teamId!] }}>{team.shortName}{player ? ` · ${player.name}` : ""}</span>}
          </div>
          <p className="fan-moment__headline">{moment.headline}</p>
          {moment.map && <MiniMap point={moment.map} color={moment.teamId ? TEAM_KIT[moment.teamId] : "currentColor"} />}
          {moment.cameraView && <p className="fan-card__hint">Camera view: no pitch location available.</p>}
        </div>
      )}
      <p className="fan-card__foot">Producer-approved stories only.</p>
    </section>
  );
}
