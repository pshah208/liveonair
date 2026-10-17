import type { MatchEvent, StoryCard } from "../../../shared/types.js";
import type { ClaimProposal } from "../claims.js";
import { createPromptAgentDefinition, TACTICS_ANALYST_AGENT_NAME, type DeskAgentSpec } from "./shared.js";

export type TacticsCard = Pick<StoryCard, "id" | "kind" | "title" | "summary" | "evidenceIds" | "importance" | "windowStart" | "windowEnd" | "teamId">;

export type TacticsInput = {
  trigger: MatchEvent;
  cards: TacticsCard[];
  /** Active, non-future events at the trigger clock. */
  events: MatchEvent[];
  /** Proposals already on the workspace, so tactics never duplicates them. */
  existing: ClaimProposal[];
};

export const TACTICS_CARD_KINDS: readonly StoryCard["kind"][] = ["pressure", "rhythm", "turning_point", "set_piece", "player"];
const MAX_TACTICS_PROPOSALS = 3;

function eventSecond(event: Pick<MatchEvent, "minute" | "second">): number {
  return event.minute * 60 + event.second;
}

/** Engine story cards whose window overlaps the build-up to the trigger event. */
export function cardsForTrigger(stories: StoryCard[], trigger: MatchEvent, windowSeconds = 900): TacticsCard[] {
  const end = eventSecond(trigger);
  return stories
    .filter((story) => TACTICS_CARD_KINDS.includes(story.kind))
    .filter((story) => story.windowEnd >= end - windowSeconds && story.windowStart <= end)
    .sort((left, right) => right.importance - left.importance)
    .slice(0, 6)
    .map(({ id, kind, title, summary, evidenceIds, importance, windowStart, windowEnd, teamId }) => ({
      id, kind, title, summary, evidenceIds, importance, windowStart, windowEnd, teamId,
    }));
}

/**
 * Turns tactical cards into claim proposals of verifiable kinds. Tactical interpretation itself is not
 * verifiable, so only the events the cards rest on become claims: goals and red cards as `live_event`, and
 * the scoreline as `match_state` when nothing else carries it. The deterministic verifier still decides.
 */
export function deriveTacticsProposals(cards: TacticsCard[], input: Pick<TacticsInput, "events" | "existing">): ClaimProposal[] {
  const eventsById = new Map(input.events.filter((event) => !event.rescinded).map((event) => [event.id, event]));
  const claimedEvents = new Set(input.existing.flatMap((proposal) => proposal.kind === "live_event" ? [proposal.params.eventId] : []));
  const hasMatchState = input.existing.some((proposal) => proposal.kind === "match_state");
  const proposals: ClaimProposal[] = [];
  for (const card of cards) {
    for (const eventId of card.evidenceIds) {
      const event = eventsById.get(eventId);
      if (!event || claimedEvents.has(eventId) || (event.type !== "goal" && event.type !== "red_card")) continue;
      claimedEvents.add(eventId);
      proposals.push({ kind: "live_event", params: { eventId }, sources: [{ type: "event", id: eventId }] });
      if (proposals.length >= MAX_TACTICS_PROPOSALS) return proposals;
    }
  }
  if (!hasMatchState) {
    const anchor = cards.flatMap((card) => card.evidenceIds).filter((id) => eventsById.has(id)).slice(0, 12);
    if (anchor.length > 0) {
      proposals.push({
        kind: "match_state",
        params: { eventIds: anchor },
        sources: anchor.slice(0, 8).map((id) => ({ type: "event" as const, id })),
      });
    }
  }
  return proposals.slice(0, MAX_TACTICS_PROPOSALS);
}

export const tacticsAnalystResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    selections: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          cardId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["cardId", "reason"],
      },
    },
  },
  required: ["selections"],
} as const;

export const tacticsAnalystAgentSpec: DeskAgentSpec = {
  name: TACTICS_ANALYST_AGENT_NAME,
  definition: createPromptAgentDefinition(
    [
      "You are the Live on Air tactics analyst.",
      "Input: the trigger event and deterministic engine story cards (pressure, rhythm, turning_point, set_piece, player)",
      "for the minutes before it. Each card lists the event IDs it rests on.",
      "Select up to three cards that best explain how the trigger moment came about (e.g. sustained pressure before a goal,",
      "a turning point that changed the rhythm). Prefer observed cards and higher importance.",
      "Return only JSON: selections of { cardId, reason }. Use only card IDs from the input; never invent events.",
      "Your selections are turned into claims that a deterministic verifier checks against the event log.",
    ].join("\n"),
    undefined,
    tacticsAnalystResponseSchema as unknown as Record<string, unknown>,
  ),
};
