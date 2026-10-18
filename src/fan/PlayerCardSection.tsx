import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  buildPlayerCard,
  cardPhase,
  phaseChip,
  rankAria,
  rankChangeAnnouncement,
  rankText,
  rankingPool,
  QUIET_CARD_MESSAGE,
  shouldAnnounce,
  SYNTHETIC_FOOTER,
  topByImpact,
  type PlayerCardModel,
  type RankedStat
} from "../../shared/fanCards.js";
import type { Language, MatchFixture, Player } from "../../shared/types.js";
import { exportPlayerCard, type ExportResult } from "./exportPlayerCard.js";
import { ShirtGraphic } from "./ShirtGraphic.js";

export interface PlayerCardSectionProps {
  fixture: MatchFixture;
  uptoSecond: number;
  clockSecond: number;
  finished: boolean;
  matchId: string;
  /** Resolved favourite for this match (never a substitute). */
  favorite: { player?: Player; inMatch: boolean };
  hasFavorite: boolean;
  savedName?: string;
  language: Language;
  onPickFavorite: (player: Player) => void;
}

const SAVE_MESSAGE: Record<ExportResult, string> = {
  shared: "Card shared.",
  downloaded: "Card saved as a picture.",
  cancelled: "",
  unsupported: "Your browser can't save this picture."
};

/** Player card: the headline Fan View card (ranking table, shirt graphic, live recompute, save as picture). */
export function PlayerCardSection(props: PlayerCardSectionProps) {
  const { fixture, uptoSecond, clockSecond, finished, matchId, favorite, hasFavorite, savedName, language, onPickFavorite } = props;
  const phase = cardPhase(clockSecond, finished);
  const chip = phaseChip(phase, clockSecond);
  const top3 = useMemo(() => (phase === "pre" ? [] : topByImpact(fixture, uptoSecond, 3)), [fixture, uptoSecond, phase]);
  const hasPool = useMemo(() => rankingPool(fixture, uptoSecond).length > 0, [fixture, uptoSecond]);

  let body: ReactNode;
  if (phase === "pre") {
    body = <p className="fan-card__empty">Card unlocks at kickoff.</p>;
  } else if (!hasFavorite) {
    body = (
      <div className="fan-card__prompt">
        <p>Pick your player from the menu at the top to see their card.</p>
        {top3.length > 0 && (
          <>
            <p className="fan-card__hint">Or start with the players having the biggest impact:</p>
            <ul className="fan-card__picks">
              {top3.map((entry) => (
                <li key={entry.player.id}>
                  <button type="button" className="fan-card__pick" onClick={() => onPickFavorite(entry.player)}>
                    <span className="mono">#{entry.player.number}</span> {entry.player.name}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  } else if (!favorite.inMatch || !favorite.player) {
    const spotlight = top3[0];
    body = (
      <div className="fan-card__prompt">
        <p>Your player isn't playing in this match{savedName ? ` (${savedName})` : ""}.</p>
        {spotlight && hasPool
          ? <PlayerCardBody {...props} playerId={spotlight.player.id} chip={chip} spotlight />
          : <p className="fan-card__hint">Nothing logged yet to spotlight.</p>}
      </div>
    );
  } else {
    body = <PlayerCardBody {...props} playerId={favorite.player.id} chip={chip} spotlight={false} />;
  }
  return (
    <section className="fan-card fan-card--player" aria-label="Player card" data-matchid={matchId} data-language={language}>
      {body}
    </section>
  );
}

function PlayerCardBody({ fixture, uptoSecond, clockSecond, matchId, language, playerId, chip, spotlight }: PlayerCardSectionProps & { playerId: string; chip: string | null; spotlight: boolean }) {
  const model: PlayerCardModel | null = useMemo(() => buildPlayerCard(fixture, playerId, uptoSecond), [fixture, playerId, uptoSecond]);
  const [announcement, setAnnouncement] = useState("");
  const previousRows = useRef<{ playerId: string; rows: RankedStat[] } | null>(null);
  const lastAnnounced = useRef<number | null>(null);
  const [saveMessage, setSaveMessage] = useState("");
  const [saving, setSaving] = useState(false);

  // Polite, throttled rank-change announcements (never more often than every 10 s).
  useEffect(() => {
    if (!model) return;
    const before = previousRows.current;
    previousRows.current = { playerId, rows: model.rows };
    if (!before || before.playerId !== playerId) return;
    const message = rankChangeAnnouncement(before.rows, model.rows, language);
    const now = Date.now();
    if (message && shouldAnnounce(lastAnnounced.current, now)) {
      lastAnnounced.current = now;
      setAnnouncement(message);
    }
  }, [model, playerId, language]);

  if (!model) return <p className="fan-card__empty">This player isn't in this match.</p>;

  async function save() {
    if (!model) return;
    setSaving(true);
    setSaveMessage("");
    try {
      setSaveMessage(SAVE_MESSAGE[await exportPlayerCard(model, { matchId, matchTitle: fixture.title, chip, minute: Math.floor(clockSecond / 60), language })]);
    } catch {
      setSaveMessage("Couldn't save the picture. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {spotlight && <p className="fan-card__badge" role="note">Spotlight instead: the top-impact player right now</p>}
      <div className="fan-card__head">
        <div className="fan-card__headtext">
          <h3 className="fan-card__title">{model.title}</h3>
          <p className="fan-card__subtitle">{model.subtitle}</p>
        </div>
        <ShirtGraphic teamId={model.teamId} number={model.player.number} />
      </div>
      {model.state === "no-data" ? <p className="fan-card__empty">{QUIET_CARD_MESSAGE}</p> : (
        <>
          {model.quiet && <p className="fan-card__quiet">{QUIET_CARD_MESSAGE}</p>}
          <table className="fan-card__table">
            <caption className="sr-only">{model.player.name}: ranking among the {model.poolSize} players in this match</caption>
            <thead>
              <tr><th scope="col">Stat</th><th scope="col">Ranking</th><th scope="col" className="fan-card__num-head">Value</th></tr>
            </thead>
            <tbody>
              {model.rows.map((row) => (
                <tr key={row.key}>
                  <th scope="row">{row.label}{row.note && <small className="fan-card__note">{row.note}</small>}</th>
                  <td>
                    <span className={`fan-card__pill fan-card__pill--${row.rank !== null && row.rank <= 3 ? row.rank : "n"}`} aria-label={row.rank === null ? "not ranked" : `${rankAria(row, language)} of ${row.of}`}>
                      {rankText(row, language)}
                    </span>
                  </td>
                  <td className="fan-card__value">{row.display}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="fan-card__foot">Ranked among the {model.poolSize} players with at least one logged action in this match.</p>
        </>
      )}
      <div className="fan-card__footer">
        <span>{SYNTHETIC_FOOTER} · {fixture.title}</span>
        {chip && <span className="fan-card__chip">{chip}</span>}
      </div>
      <div className="fan-card__actions">
        <button type="button" className="button button--primary fan-card__save" onClick={() => void save()} disabled={saving || model.state === "no-data"}>{saving ? "Saving…" : "Save as picture"}</button>
        <span className="fan-card__savemsg" role="status">{saveMessage}</span>
      </div>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    </>
  );
}
