import type { MatchEvent, MatchFixture, Player, Team, TeamId } from "../../shared/types.js";
import type { ManualTag, VideoEventEvidence, VideoFrame, VideoJobRequest, VisionDetection } from "../../shared/video.js";

/**
 * Turns raw vision detections into a Live on Air fixture. Everything here is deterministic code: the model
 * only reports what it saw; thresholds, de-duplication and football consistency rules live here.
 */

export const MIN_CONFIDENCE = 0.5;

/** A second report of the same moment inside this window is treated as the same event. */
const DEDUPE_SECONDS: Partial<Record<MatchEvent["type"], number>> = {
  goal: 20,
  yellow_card: 10,
  red_card: 10,
  corner: 8,
};
const DEFAULT_DEDUPE_SECONDS = 3;
const SHOT_BEFORE_GOAL_SECONDS = 6;
const SHOT_BEFORE_SAVE_SECONDS = 6;

type Accepted = { detection: VisionDetection; team: TeamId; second: number; timestampSeconds: number; tagId?: string };

export interface BuiltVideoFixture {
  fixture: MatchFixture;
  evidence: VideoEventEvidence[];
  rawCount: number;
  acceptedCount: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : (min + max) / 2));
}

export function teamShortName(name: string): string {
  const letters = name.replace(/[^A-Za-z]/gu, "").toUpperCase();
  return (letters.slice(0, 3) || "TM").padEnd(3, "X");
}

function playerId(team: TeamId, shirtNumber: number | null): string {
  return shirtNumber === null ? `${team}-unidentified` : `${team}-${shirtNumber}`;
}

function normaliseOutcome(detection: VisionDetection): MatchEvent["outcome"] {
  const { type, outcome } = detection;
  if (type === "pass") return outcome === "incomplete" ? "incomplete" : "complete";
  if (type === "goal") return "success";
  if (type === "shot") return ["miss", "blocked", "saved", "success"].includes(outcome) ? outcome : "miss";
  if (type === "tackle") return outcome === "incomplete" || outcome === "miss" ? "fail" : "success";
  return "none";
}

function toEvent(id: string, second: number, team: TeamId, type: MatchEvent["type"], detection: Pick<VisionDetection, "shirtNumber" | "x" | "y">, outcome: MatchEvent["outcome"]): MatchEvent {
  return {
    id,
    revision: 1,
    minute: Math.floor(second / 60),
    second: second % 60,
    type,
    teamId: team,
    playerId: playerId(team, detection.shirtNumber),
    outcome,
    x: Math.round(clamp(detection.x, 0, 100)),
    y: Math.round(clamp(detection.y, 0, 100)),
  };
}

function secondOf(event: MatchEvent): number {
  return event.minute * 60 + event.second;
}

function buildTeam(id: TeamId, name: string, events: MatchEvent[]): Team {
  const short = teamShortName(name);
  const ids = [...new Set(events.filter((event) => event.teamId === id).map((event) => event.playerId))];
  if (!ids.includes(`${id}-unidentified`)) ids.push(`${id}-unidentified`);
  const players: Player[] = ids.map((pid) => {
    const shirt = pid.endsWith("-unidentified") ? null : Number(pid.split("-").pop());
    return {
      id: pid,
      name: shirt === null ? `Unidentified ${short} player` : `${short} #${shirt}`,
      number: shirt ?? 0,
      position: "Unknown",
      teamId: id,
    };
  });
  return { id, name, shortName: short, players };
}

export function buildVideoFixture(input: {
  jobId: string;
  request: VideoJobRequest;
  durationSeconds: number;
  frames: VideoFrame[];
  detections: VisionDetection[];
  manualTags?: ManualTag[];
}): BuiltVideoFixture {
  const duration = Math.max(2, Math.ceil(input.durationSeconds));
  const fixtureId = `video-${input.jobId}`;
  const frameTime = new Map(input.frames.map((frame) => [frame.index, frame.timestampSeconds]));
  const clampSecond = (value: number) => Math.min(duration - 1, Math.max(1, Math.floor(value)));

  // 0. Producer tags are trusted: they are accepted first and win over model reports of the same moment.
  const manual: Accepted[] = (input.manualTags ?? []).map((tag) => {
    const second = clampSecond(tag.second);
    const nearest = input.frames.reduce<VideoFrame | undefined>((best, frame) => (!best || Math.abs(frame.timestampSeconds - second) < Math.abs(best.timestampSeconds - second) ? frame : best), undefined);
    return {
      team: tag.team,
      second,
      timestampSeconds: second,
      tagId: tag.id,
      detection: {
        frameIndex: nearest?.index ?? -1,
        type: tag.type,
        team: tag.team,
        shirtNumber: tag.shirtNumber,
        outcome: tag.type === "shot" ? "miss" : "none",
        x: 50,
        y: 50,
        confidence: 1,
        description: tag.note.trim() || "Tagged by the producer",
      },
    };
  });

  // 1. Confidence, team and frame gates.
  const candidates: Accepted[] = [];
  for (const detection of input.detections) {
    const timestampSeconds = frameTime.get(detection.frameIndex);
    if (timestampSeconds === undefined) continue;
    if (detection.team === "unknown" || !(detection.confidence >= MIN_CONFIDENCE)) continue;
    candidates.push({ detection, team: detection.team, timestampSeconds, second: clampSecond(timestampSeconds) });
  }
  candidates.sort((a, b) => a.second - b.second || b.detection.confidence - a.detection.confidence);

  // 2. One report per moment: drop repeats of the same type for the same team inside the window.
  const accepted: Accepted[] = [...manual];
  for (const candidate of candidates) {
    const window = DEDUPE_SECONDS[candidate.detection.type] ?? DEFAULT_DEDUPE_SECONDS;
    const duplicate = accepted.some((item) => item.detection.type === candidate.detection.type && item.team === candidate.team && Math.abs(item.second - candidate.second) <= window);
    if (!duplicate) accepted.push(candidate);
  }
  accepted.sort((a, b) => a.second - b.second || Number(Boolean(b.tagId)) - Number(Boolean(a.tagId)));

  // 3. Build events and apply football consistency rules.
  const events: MatchEvent[] = [];
  const evidence: VideoEventEvidence[] = [];
  let counter = 0;
  const nextId = () => `${fixtureId}-e${String(++counter).padStart(3, "0")}`;
  const centre = { shirtNumber: null, x: 50, y: 50 };

  events.push(toEvent(nextId(), 0, "home", "kickoff", centre, "none"));

  for (const item of accepted) {
    const { detection, team, second } = item;
    if (detection.type === "goal") {
      const shot = [...events].reverse().find((event) => event.type === "shot" && event.teamId === team && secondOf(event) <= second && second - secondOf(event) <= SHOT_BEFORE_GOAL_SECONDS);
      if (shot) {
        shot.outcome = "success";
      } else {
        // A goal needs a shot; the model often only catches the ball already in the net.
        events.push(toEvent(nextId(), Math.max(1, second - 1), team, "shot", detection, "success"));
      }
    }
    const event = toEvent(nextId(), second, team, detection.type, detection, normaliseOutcome(detection));
    if (detection.type === "save") {
      const shot = [...events].reverse().find((candidate) => candidate.type === "shot" && candidate.teamId !== team && secondOf(candidate) <= second && second - secondOf(candidate) <= SHOT_BEFORE_SAVE_SECONDS);
      if (shot) {
        event.relatedEventId = shot.id;
        if (shot.outcome === "miss") shot.outcome = "saved";
      }
    }
    events.push(event);
    evidence.push({
      eventId: event.id,
      frameIndex: detection.frameIndex,
      timestampSeconds: item.timestampSeconds,
      confidence: Math.round(detection.confidence * 100) / 100,
      description: detection.description.slice(0, 240),
      source: item.tagId ? "manual" : "vision",
      ...(item.tagId ? { tagId: item.tagId } : {}),
    });
  }

  events.push(toEvent(nextId(), duration, "home", "fulltime", centre, "none"));
  events.sort((a, b) => secondOf(a) - secondOf(b) || a.id.localeCompare(b.id));

  const firstGoal = events.find((event) => event.type === "goal");
  return {
    fixture: {
      id: fixtureId,
      seed: 1,
      title: `${input.request.home.name} vs ${input.request.away.name} (video)`,
      description: "Events detected by the Live on Air video worker from an uploaded clip. Positions are approximate frame positions, not tracking data.",
      home: buildTeam("home", input.request.home.name, events),
      away: buildTeam("away", input.request.away.name, events),
      events,
      durationSeconds: duration,
      correctionEventId: firstGoal?.id ?? "",
      correctionAvailableAt: duration,
    },
    evidence,
    rawCount: input.detections.length,
    acceptedCount: accepted.filter((item) => !item.tagId).length,
  };
}
