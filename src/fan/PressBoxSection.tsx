import { useEffect, useMemo, useRef, useState } from "react";
import { buildAllPressPosts, compactCount, postTimeLabel, PRESS_BOX_LABEL, selectPressPosts, type PressOrder, type PressPost } from "../../shared/pressBox.js";
import type { MatchFixture, TeamId } from "../../shared/types.js";

interface PressBoxProps {
  fixture: MatchFixture;
  uptoSecond: number;
  clockSecond: number;
  /** Favourite team in this match, if any. Enables the "My team" filter. */
  focusTeamId?: TeamId;
}

type Scope = "all" | "mine";

/** Social Media Posts: synthetic posts from fictional accounts, streamed with the match clock. Always labelled. */
export function PressBoxSection({ fixture, uptoSecond, clockSecond, focusTeamId }: PressBoxProps) {
  const [scope, setScope] = useState<Scope>("all");
  const [order, setOrder] = useState<PressOrder>("top");
  const effective: Scope = focusTeamId ? scope : "all";
  const all = useMemo(() => buildAllPressPosts(fixture, uptoSecond), [fixture, uptoSecond]);
  const posts = useMemo(() => selectPressPosts(fixture, uptoSecond, order, effective === "mine" ? focusTeamId : undefined), [fixture, uptoSecond, order, effective, focusTeamId]);

  // Announce only the newest post, never the whole list. The first render is silent.
  const seen = useRef<Set<string> | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (seen.current === null) {
      seen.current = new Set(all.map((post) => post.id));
      return;
    }
    const added = all.filter((post) => !seen.current!.has(post.id));
    for (const post of all) seen.current.add(post.id);
    if (added.length === 0) return;
    setFresh(new Set(added.map((post) => post.id)));
    const newest = added[0]!;
    setAnnouncement(`New synthetic post from ${newest.persona.name}: ${newest.text}`);
  }, [all]);

  return (
    <section className="press-box fan-card" aria-label="Social Media Posts">
      <header className="press-box__head">
        <div className="press-box__title">
          <p className="eyebrow">Social</p>
          <h2 className="press-box__heading">Social Media Posts <span className="press-box__synthetic">Synthetic</span></h2>
          <p className="press-box__label">{PRESS_BOX_LABEL}</p>
        </div>
        <div className="press-box__controls">
          <div className="press-box__filter" role="group" aria-label="Order posts">
            <button type="button" className="press-box__chip" aria-pressed={order === "top"} onClick={() => setOrder("top")}>Top</button>
            <button type="button" className="press-box__chip" aria-pressed={order === "latest"} onClick={() => setOrder("latest")}>Latest</button>
          </div>
          {focusTeamId && (
            <div className="press-box__filter" role="group" aria-label="Filter posts">
              <button type="button" className="press-box__chip" aria-pressed={effective === "all"} onClick={() => setScope("all")}>All</button>
              <button type="button" className="press-box__chip" aria-pressed={effective === "mine"} onClick={() => setScope("mine")}>My team</button>
            </div>
          )}
        </div>
      </header>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
      {posts.length === 0 ? (
        <div className="empty-state">Posts appear here as the match unfolds.</div>
      ) : (
        <div className="press-scroll" tabIndex={0} role="region" aria-label="Social media posts, scrollable">
          <ul className="press-list">
            {posts.map((post) => <PressCard key={post.id} post={post} clockSecond={clockSecond} isNew={fresh.has(post.id)} />)}
          </ul>
        </div>
      )}
    </section>
  );
}

function Icon({ d }: { d: string }) {
  return <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
}

function PressCard({ post, clockSecond, isNew }: { post: PressPost; clockSecond: number; isNew: boolean }) {
  const { persona } = post;
  const age = postTimeLabel(post.second, clockSecond);
  return (
    <li className={`press-card${post.ruledOut ? " is-ruled-out" : ""}${isNew ? " is-new" : ""}`}>
      <div className="press-card__head">
        <span className="press-card__avatar" aria-hidden="true">{persona.initials}</span>
        <div className="press-card__who">
          <span className="press-card__name">
            {persona.name}
            {persona.verified && (
              <svg className="press-card__badge" viewBox="0 0 24 24" width="14" height="14" role="img" aria-label="Verified (fictional)">
                <circle cx="12" cy="12" r="11" fill="currentColor" />
                <path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </span>
          <span className="press-card__meta">{persona.handle} · <time>{age}</time></span>
        </div>
      </div>
      <p className="press-card__text">{post.text}</p>
      {post.ruledOut && <p className="press-card__flag">Ruled out</p>}
      {post.quoted && (
        <blockquote className="press-card__quote">
          <span className="press-card__quote-who">{post.quoted.personaHandle}</span>
          <span>{post.quoted.text}</span>
        </blockquote>
      )}
      <ul className="press-card__stats" aria-label={`${post.replies} replies, ${post.reposts} reposts, ${post.likes} likes, ${post.views} views`}>
        <li><Icon d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" /><span aria-hidden="true">{compactCount(post.replies)}</span></li>
        <li><Icon d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" /><span aria-hidden="true">{compactCount(post.reposts)}</span></li>
        <li><Icon d="M12 21s-8-5.3-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.7-8 11-8 11z" /><span aria-hidden="true">{compactCount(post.likes)}</span></li>
        <li><Icon d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" /><span aria-hidden="true">{compactCount(post.views)}</span></li>
      </ul>
    </li>
  );
}
