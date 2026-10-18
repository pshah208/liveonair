import { useMemo, useState } from "react";
import { castVote, FAN_VOTE_KEY, parseVotes, serializeVotes, voteCandidates, votePhase, type VoteStore } from "../../shared/fanCards.js";
import type { MatchFixture } from "../../shared/types.js";

function storage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

/** Player of the match vote: local only, opens at 60', locks at full time. No community tallies. */
export function PotmVote({ fixture, matchId, uptoSecond, clockSecond, finished }: { fixture: MatchFixture; matchId: string; uptoSecond: number; clockSecond: number; finished: boolean }) {
  const [votes, setVotes] = useState<VoteStore>(() => { try { return parseVotes(storage()?.getItem(FAN_VOTE_KEY) ?? null); } catch { return {}; } });
  const phase = votePhase(clockSecond, finished);
  const candidates = useMemo(() => (phase === "not_open" ? { home: [], away: [] } : voteCandidates(fixture, uptoSecond)), [fixture, uptoSecond, phase]);
  const mine = votes[matchId];

  function vote(playerId: string) {
    const next = castVote(votes, matchId, playerId, phase, candidates);
    if (next === votes) return;
    setVotes(next);
    try { storage()?.setItem(FAN_VOTE_KEY, serializeVotes(next)); } catch { /* storage unavailable: the pick lasts for this session */ }
  }

  return (
    <section className="fan-card fan-card--vote" aria-label="Player of the match vote">
      <h3 className="fan-card__title fan-card__title--small">Player of the match</h3>
      {phase === "not_open" ? <p className="fan-card__empty">Voting opens at 60′.</p> : (
        <>
          <p className="fan-card__hint">{phase === "locked" ? "Voting is closed." : "Your pick (just for you)."} Top three per team by impact. Nothing is sent anywhere.</p>
          <div className="fan-vote">
            {(["home", "away"] as const).map((side) => (
              <fieldset key={side} className="fan-vote__side" disabled={phase === "locked"}>
                <legend>{fixture[side].name}</legend>
                {candidates[side].length === 0 && <p className="fan-card__hint">No candidates yet.</p>}
                {candidates[side].map((candidate) => (
                  <button key={candidate.playerId} type="button" className={`fan-vote__option${mine === candidate.playerId ? " is-picked" : ""}`} aria-pressed={mine === candidate.playerId} onClick={() => vote(candidate.playerId)}>
                    <span className="mono">#{candidate.number}</span> {candidate.name} <small>{candidate.rating.toFixed(1)}</small>
                  </button>
                ))}
              </fieldset>
            ))}
          </div>
          {mine && <p className="fan-card__hint" role="status">Your pick (just for you): {[...candidates.home, ...candidates.away].find((item) => item.playerId === mine)?.name ?? "saved"}.</p>}
        </>
      )}
    </section>
  );
}
