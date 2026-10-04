import type { MatchEvent, MatchFixture, TeamId } from "./types.js";
import type { Storyline } from "./platform.js";

/**
 * Deterministic highlight selection.
 *
 * MatchLens has no footage for synthetic matches, so a highlight "reel" is a list of clips in match
 * time. The same clip list drives two outputs: an animated data reel rendered in the browser, and a
 * cut list (timecodes + ffmpeg commands) that trims a licensed broadcast recording when one exists.
 */

export type HighlightKind = "goal" | "disallowed_goal" | "red_card" | "big_chance" | "key_save" | "booking";

export interface HighlightClip {
  id: string;
  kind: HighlightKind;
  keyEventId: string;
  /** Match-time window in seconds. */
  startSecond: number;
  endSecond: number;
  /** All feed events inside the window, chronological; used to animate the build-up. */
  eventIds: string[];
  minute: number;
  teamId: TeamId;
  playerId: string;
  title: string;
  caption: string;
  storylineId?: string;
  importance: number;
  scoreAfter: { home: number; away: number };
}

export interface HighlightReel {
  fixtureId: string;
  clips: HighlightClip[];
  /** Sum of clip windows in match seconds. */
  totalMatchSeconds: number;
}

export interface CutListOptions {
  /** Seconds into the recording at which kick-off happens. */
  kickoffOffsetSeconds?: number;
  /** Real-time length of the half-time break in the recording, added to second-half timecodes. */
  halftimeBreakSeconds?: number;
  sourceFile?: string;
}

export interface CutListEntry {
  clipId: string;
  title: string;
  in: string;
  out: string;
  inSeconds: number;
  outSeconds: number;
}

const WINDOWS: Record<HighlightKind, { pre: number; post: number; base: number }> = {
  goal: { pre: 16, post: 8, base: 100 },
  disallowed_goal: { pre: 12, post: 8, base: 75 },
  red_card: { pre: 10, post: 6, base: 80 },
  big_chance: { pre: 12, post: 5, base: 45 },
  key_save: { pre: 10, post: 5, base: 40 },
  booking: { pre: 6, post: 4, base: 12 }
};

const BIG_CHANCE_XG = 0.25;
const STORYLINE_BONUS = 20;
const DEFAULT_MAX_CLIPS = 8;

export function eventSecondOf(event: Pick<MatchEvent, "minute" | "second">): number {
  return event.minute * 60 + event.second;
}

/** Live views keep every revision of an event; keep only the latest revision of each id. */
export function latestRevisions(events: MatchEvent[]): MatchEvent[] {
  const byId = new Map<string, MatchEvent>();
  for (const event of events) {
    const previous = byId.get(event.id);
    if (!previous || event.revision >= previous.revision) byId.set(event.id, event);
  }
  return [...byId.values()].sort((a, b) => eventSecondOf(a) - eventSecondOf(b));
}

function classify(event: MatchEvent, byId: Map<string, MatchEvent>): { kind: HighlightKind; bonus: number } | null {
  if (event.type === "goal") return event.rescinded ? { kind: "disallowed_goal", bonus: 0 } : { kind: "goal", bonus: 0 };
  if (event.type === "red_card") return { kind: "red_card", bonus: 0 };
  if (event.type === "shot" && (event.xg ?? 0) >= BIG_CHANCE_XG) return { kind: "big_chance", bonus: Math.round((event.xg ?? 0) * 40) };
  if (event.type === "save") {
    const shot = event.relatedEventId ? byId.get(event.relatedEventId) : undefined;
    const xg = shot?.xg ?? 0;
    return xg >= 0.15 ? { kind: "key_save", bonus: Math.round(xg * 40) } : null;
  }
  if (event.type === "yellow_card") return { kind: "booking", bonus: 0 };
  return null;
}

function playerName(fixture: MatchFixture, playerId: string): string {
  return [...fixture.home.players, ...fixture.away.players].find((player) => player.id === playerId)?.name ?? "Unknown player";
}

function teamShort(fixture: MatchFixture, teamId: TeamId): string {
  return teamId === "home" ? fixture.home.shortName : fixture.away.shortName;
}

function defaultTitle(kind: HighlightKind, minute: number, name: string, team: string): string {
  switch (kind) {
    case "goal": return `${minute}' GOAL · ${name} (${team})`;
    case "disallowed_goal": return `${minute}' Goal ruled out · ${name} (${team})`;
    case "red_card": return `${minute}' Red card · ${name} (${team})`;
    case "big_chance": return `${minute}' Big chance · ${name} (${team})`;
    case "key_save": return `${minute}' Key save · ${name} (${team})`;
    case "booking": return `${minute}' Booking · ${name} (${team})`;
  }
}

function defaultCaption(kind: HighlightKind, event: MatchEvent, name: string, byId: Map<string, MatchEvent>): string {
  switch (kind) {
    case "goal": return `${name} scores${event.xg !== undefined ? ` from a ${event.xg.toFixed(2)} xG chance` : ""}.`;
    case "disallowed_goal": return `${name}'s goal is ruled out after review; the score is corrected.`;
    case "red_card": return `${name} is sent off.`;
    case "big_chance": return `${name} goes close: ${(event.xg ?? 0).toFixed(2)} xG, ${event.outcome}.`;
    case "key_save": {
      const shot = event.relatedEventId ? byId.get(event.relatedEventId) : undefined;
      return `${name} denies a ${(shot?.xg ?? 0).toFixed(2)} xG chance.`;
    }
    case "booking": return `${name} is booked.`;
  }
}

function scoreAt(events: MatchEvent[], second: number): { home: number; away: number } {
  const score = { home: 0, away: 0 };
  for (const event of events) {
    if (event.type === "goal" && !event.rescinded && eventSecondOf(event) <= second) score[event.teamId] += 1;
  }
  return score;
}

function onAirStorylines(storylines: Storyline[]): Storyline[] {
  return storylines.filter((storyline) => storyline.status === "approved" || storyline.status === "needs_review");
}

export function buildHighlightReel(
  fixture: MatchFixture,
  storylines: Storyline[] = [],
  options: { maxClips?: number; uptoSecond?: number } = {}
): HighlightReel {
  const maxClips = Math.max(1, options.maxClips ?? DEFAULT_MAX_CLIPS);
  const upto = options.uptoSecond ?? fixture.durationSeconds;
  const events = latestRevisions(fixture.events).filter((event) => eventSecondOf(event) <= upto);
  const byId = new Map(events.map((event) => [event.id, event]));
  const storylineByEvent = new Map<string, Storyline>();
  for (const storyline of onAirStorylines(storylines)) {
    for (const eventId of storyline.triggerEventIds) {
      const existing = storylineByEvent.get(eventId);
      if (!existing || (existing.status !== "approved" && storyline.status === "approved")) storylineByEvent.set(eventId, storyline);
    }
  }

  type Candidate = { event: MatchEvent; kind: HighlightKind; importance: number; start: number; end: number };
  const candidates: Candidate[] = [];
  for (const event of events) {
    const classified = classify(event, byId);
    if (!classified) continue;
    const window = WINDOWS[classified.kind];
    const at = eventSecondOf(event);
    const importance = window.base + classified.bonus + (storylineByEvent.has(event.id) ? STORYLINE_BONUS : 0);
    candidates.push({ event, kind: classified.kind, importance, start: Math.max(0, at - window.pre), end: Math.min(fixture.durationSeconds, at + window.post) });
  }

  // Highest importance first; ties go to the earlier moment so selection is stable.
  candidates.sort((a, b) => b.importance - a.importance || eventSecondOf(a.event) - eventSecondOf(b.event));
  const chosen: Candidate[] = [];
  for (const candidate of candidates) {
    if (chosen.length >= maxClips) break;
    const overlapping = chosen.find((item) => candidate.start < item.end && item.start < candidate.end);
    if (overlapping) {
      // Overlapping moments become one clip anchored on the more important event.
      overlapping.start = Math.min(overlapping.start, candidate.start);
      overlapping.end = Math.max(overlapping.end, candidate.end);
      continue;
    }
    chosen.push({ ...candidate });
  }

  // Expanded windows can touch neighbours; coalesce so the reel never repeats footage.
  const ordered = chosen.sort((a, b) => a.start - b.start).reduce<Candidate[]>((merged, candidate) => {
    const previous = merged[merged.length - 1];
    if (previous && candidate.start < previous.end) {
      const keep = candidate.importance > previous.importance ? candidate : previous;
      merged[merged.length - 1] = { ...keep, start: previous.start, end: Math.max(previous.end, candidate.end) };
      return merged;
    }
    merged.push(candidate);
    return merged;
  }, []);

  const clips = ordered
    .map((candidate, index): HighlightClip => {
      const { event, kind } = candidate;
      const name = playerName(fixture, event.playerId);
      const storyline = storylineByEvent.get(event.id);
      const caption = storyline?.overlay.en?.trim() || storyline?.headline.en?.trim() || defaultCaption(kind, event, name, byId);
      return {
        id: `clip-${String(index + 1).padStart(2, "0")}`,
        kind,
        keyEventId: event.id,
        startSecond: candidate.start,
        endSecond: candidate.end,
        eventIds: events.filter((item) => {
          const at = eventSecondOf(item);
          return at >= candidate.start && at <= candidate.end;
        }).map((item) => item.id),
        minute: event.minute,
        teamId: event.teamId,
        playerId: event.playerId,
        title: defaultTitle(kind, event.minute, name, teamShort(fixture, event.teamId)),
        caption,
        storylineId: storyline?.id,
        importance: candidate.importance,
        scoreAfter: scoreAt(events, candidate.end)
      };
    });

  return {
    fixtureId: fixture.id,
    clips,
    totalMatchSeconds: clips.reduce((sum, clip) => sum + (clip.endSecond - clip.startSecond), 0)
  };
}

export function formatTimecode(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = Math.floor(safe % 60);
  const millis = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/** Maps match time to recording time, accounting for kick-off offset and the half-time break. */
export function toRecordingSeconds(matchSecond: number, options: CutListOptions = {}): number {
  const kickoff = options.kickoffOffsetSeconds ?? 0;
  const breakSeconds = matchSecond >= 45 * 60 ? options.halftimeBreakSeconds ?? 0 : 0;
  return kickoff + matchSecond + breakSeconds;
}

export function buildCutList(reel: HighlightReel, options: CutListOptions = {}): CutListEntry[] {
  return reel.clips.map((clip) => {
    const inSeconds = toRecordingSeconds(clip.startSecond, options);
    const outSeconds = toRecordingSeconds(clip.endSecond, options);
    return { clipId: clip.id, title: clip.title, in: formatTimecode(inSeconds), out: formatTimecode(outSeconds), inSeconds, outSeconds };
  });
}

export function buildFfmpegScript(reel: HighlightReel, options: CutListOptions = {}): string {
  const source = options.sourceFile ?? "match-recording.mp4";
  const entries = buildCutList(reel, options);
  const lines = [
    "#!/usr/bin/env bash",
    "# MatchLens highlight cut list. Point SOURCE at a licensed recording of this match.",
    `# Kick-off offset: ${options.kickoffOffsetSeconds ?? 0}s, half-time break: ${options.halftimeBreakSeconds ?? 0}s.`,
    "set -euo pipefail",
    `SOURCE="\${1:-${source}}"`,
    ": > clips.txt"
  ];
  for (const entry of entries) {
    lines.push(`# ${entry.title.replaceAll("\n", " ")}`);
    lines.push(`ffmpeg -y -ss ${entry.in} -to ${entry.out} -i "$SOURCE" -c:v libx264 -c:a aac ${entry.clipId}.mp4`);
    lines.push(`echo "file '${entry.clipId}.mp4'" >> clips.txt`);
  }
  lines.push("ffmpeg -y -f concat -safe 0 -i clips.txt -c copy highlights.mp4");
  return `${lines.join("\n")}\n`;
}
