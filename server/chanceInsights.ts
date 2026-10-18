import type { ChanceInsight } from "../shared/chanceSequence.js";
import { eventSecond, isChanceFixtureCamera, recomputeChanceInsights } from "../shared/chanceSequence.js";
import type { MatchEvent } from "../shared/types.js";
import type { LiveListener, LiveMatchView } from "./contracts.js";

export interface ChanceInsightFeed extends LiveListener {
  list(matchId: string): ChanceInsight[];
  subscribe(listener: (insight: ChanceInsight) => void): () => void;
}

/**
 * In-memory insight lifecycle for the live match. Recomputes on every accepted event, including
 * corrections. Listeners receive only insights whose status or revision changed.
 */
export function createChanceInsightFeed(): ChanceInsightFeed {
  const byMatch = new Map<string, ChanceInsight[]>();
  const listeners = new Set<(insight: ChanceInsight) => void>();

  function emit(insight: ChanceInsight): void {
    for (const listener of listeners) listener(insight);
  }

  function recompute(view: LiveMatchView, event: MatchEvent): void {
    const previous = byMatch.get(view.matchId) ?? [];
    const { insights, changed } = recomputeChanceInsights({
      previous,
      events: view.fixture.events,
      matchId: view.matchId,
      atSecond: Math.max(view.clockSecond, eventSecond(event)),
      camera: isChanceFixtureCamera(view.fixture),
      effectiveSecond: eventSecond(event),
    });
    byMatch.set(view.matchId, insights);
    for (const insight of changed) emit(insight);
  }

  return {
    onMatchStart(view) {
      byMatch.set(view.matchId, []);
      const stale = [...byMatch.keys()].filter((matchId) => matchId !== view.matchId);
      for (const matchId of stale.slice(0, Math.max(0, stale.length - 1))) byMatch.delete(matchId);
    },
    onEvent(view, event) {
      recompute(view, event);
    },
    onMatchEnd() {},
    list(matchId) {
      return structuredClone(byMatch.get(matchId) ?? []);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
