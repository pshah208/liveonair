import type { MatchSnapshot } from "../shared/types.js";
import type { LiveMessage, LiveStatus, Storyline, VerifiedFact } from "../shared/platform.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLiveStatus(value: unknown): value is LiveStatus {
  return isRecord(value)
    && typeof value.state === "string"
    && typeof value.transport === "string"
    && typeof value.transportConfigured === "boolean"
    && typeof value.clockSecond === "number"
    && typeof value.speed === "number"
    && typeof value.eventsReceived === "number"
    && typeof value.duplicatesIgnored === "number"
    && typeof value.stress === "boolean";
}

function isSnapshot(value: unknown): value is MatchSnapshot {
  return isRecord(value)
    && typeof value.fixtureId === "string"
    && typeof value.atSecond === "number"
    && typeof value.stateVersion === "string"
    && isRecord(value.score)
    && Array.isArray(value.recentEvents)
    && Array.isArray(value.stories)
    && isRecord(value.evidence);
}

function isStoryline(value: unknown): value is Storyline {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.matchId === "string"
    && typeof value.status === "string"
    && isRecord(value.headline)
    && isRecord(value.onAirLine)
    && isRecord(value.overlay)
    && Array.isArray(value.claims)
    && Array.isArray(value.trace)
    && typeof value.version === "number";
}

function isVerifiedFact(value: unknown): value is VerifiedFact {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.matchId === "string"
    && typeof value.minute === "number"
    && isRecord(value.text)
    && Array.isArray(value.sources)
    && typeof value.createdAt === "string";
}

export function isLiveMessage(value: unknown): value is LiveMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "status": return isLiveStatus(value.status);
    case "snapshot": return isLiveStatus(value.status) && isSnapshot(value.snapshot);
    case "storyline": return isStoryline(value.storyline);
    case "fact": return isVerifiedFact(value.fact);
    case "heartbeat": return typeof value.at === "string";
    default: return false;
  }
}
