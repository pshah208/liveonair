import { useEffect, useState } from "react";

import type { Language, NarrativeSourceType, PostMatchStorylinesResponse } from "../shared/types.js";
import { ApiError, api } from "./api.js";
import { Panel } from "./components.js";
import { getErrorMessage } from "./utils.js";

export type PostMatchStorylinesProps = {
  matchId?: string;
  language: Language;
  favouriteClubId?: string;
  favouritePlayerId?: string;
  variant: "studio" | "fan";
  /** When omitted, the panel reads /api/health. Studio passes the health it already has. */
  aiReady?: boolean;
};

const BADGE: Record<NarrativeSourceType, string> = {
  match: "Match",
  history: "History",
  news_wire: "News wire (synthetic)",
  web: "Web",
};

export function PostMatchStorylines({
  matchId,
  language,
  favouriteClubId,
  favouritePlayerId,
  variant,
  aiReady,
}: PostMatchStorylinesProps) {
  const [ready, setReady] = useState(aiReady ?? true);
  const [result, setResult] = useState<PostMatchStorylinesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unconfigured, setUnconfigured] = useState(false);

  useEffect(() => {
    setResult(null);
    setError(null);
    setUnconfigured(false);
  }, [matchId, language, favouriteClubId, favouritePlayerId]);

  useEffect(() => {
    if (aiReady !== undefined) {
      setReady(aiReady);
      return;
    }
    const controller = new AbortController();
    api.getHealth(controller.signal).then((health) => {
      if (!controller.signal.aborted) setReady(Boolean(health?.ai.configured));
    }).catch(() => {
      if (!controller.signal.aborted) setReady(true);
    });
    return () => controller.abort();
  }, [aiReady]);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const next = await api.postMatchStorylines({
        language,
        persona: variant === "fan" ? "casual" : "analyst",
        ...(favouriteClubId ? { favouriteClubId } : {}),
        ...(favouritePlayerId ? { favouritePlayerId } : {}),
      });
      if (!next) throw new Error("Storylines were not returned.");
      setResult(next);
      setUnconfigured(false);
    } catch (caught: unknown) {
      if (caught instanceof ApiError && caught.status === 503) {
        setUnconfigured(true);
        setReady(false);
      }
      setError(getErrorMessage(caught));
    } finally {
      setLoading(false);
    }
  }

  const blocked = !matchId || !ready || unconfigured || loading;
  const title = result?.phase === "so_far" ? "Story so far" : "Post-match storylines";

  return (
    <Panel
      className={variant === "fan" ? "storylines storylines--fan" : "storylines"}
      eyebrow={variant === "fan" ? "Your match" : "Foundry narrator"}
      title={title}
      aside={result ? <span className="tag">{result.storylines.length} storylines</span> : undefined}
    >
      <div className="recap-controls">
        <button type="button" className="button button--primary" onClick={() => void generate()} disabled={blocked}>
          {loading ? "Writing…" : result ? "Regenerate" : "Generate storylines"}
        </button>
      </div>
      {!matchId && <div className="banner banner--info">Start a match to generate storylines.</div>}
      {matchId && (!ready || unconfigured) && <div className="banner banner--info">AI narration isn't configured on this server.</div>}
      {error && !unconfigured && <div className="banner banner--danger" role="alert">{error}</div>}
      {loading && !result && <div className="skeleton" aria-hidden="true" />}
      {result && (
        <div className={loading ? "recap is-stale" : "recap"}>
          <article className="storylines__article">
            <div className="recap__head">
              <h3>{result.headline}</h3>
              <span className="tag">{result.language}</span>
            </div>
            <p className="recap__script">{result.summary}</p>
            {result.audioUrl && <audio className="recap__audio" controls preload="none" src={result.audioUrl} aria-label="Listen to the post-match summary" />}
          </article>
          <ol className="storylines__list">
            {result.storylines.map((storyline) => (
              <li key={storyline.id} className="storyline-card">
                <div className="storyline-card__badges">
                  {storyline.sourceTypes.map((type) => (
                    <span key={type} className={type === "web" ? "tag tag--accent" : type === "news_wire" ? "tag tag--muted" : "tag"}>{BADGE[type]}</span>
                  ))}
                  {storyline.favourite && <span className="tag tag--accent">Favourite</span>}
                </div>
                <h3>{storyline.title}</h3>
                <p className="subtle-text">{storyline.angle}</p>
                <p>{storyline.narrative}</p>
                <div className="storyline-card__evidence">
                  {storyline.evidence.map((item) => item.url ? (
                    <a key={item.id} className="storyline-chip" href={item.url} target="_blank" rel="noopener noreferrer">{item.label}</a>
                  ) : (
                    <span key={item.id} className="storyline-chip">{item.synthetic ? `${item.label} · synthetic` : item.label}</span>
                  ))}
                </div>
              </li>
            ))}
          </ol>
          <section className="storylines__web" aria-label="Web context">
            <div className="storyline-card__badges">
              <span className="tag tag--accent">Web</span>
              <strong>{result.webContext.label}</strong>
            </div>
            {result.webContext.items.length === 0 ? (
              <p>No live page was cited for this recap.</p>
            ) : (
              <ul className="storylines__sources">
                {result.webContext.items.map((item) => (
                  <li key={item.url}>
                    <a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a>
                    <span className="subtle-text"> · {item.domain}</span>
                  </li>
                ))}
              </ul>
            )}
            {variant === "studio" && result.webContext.queries.length > 0 && (
              <details className="disclosure disclosure--compact">
                <summary>Search queries</summary>
                <ul>{result.webContext.queries.map((query) => <li key={query}>{query}</li>)}</ul>
              </details>
            )}
          </section>
        </div>
      )}
    </Panel>
  );
}
