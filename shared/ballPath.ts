import type { MatchEvent, MatchFixture, TeamId } from "./types.js";

/**
 * Reconstructs where the ball went from the logged events, on a single pitch frame where the home
 * side attacks left to right. Feeds record each team's events in its own attacking frame (x = 100 is
 * the goal it attacks), so away coordinates are mirrored. Between two events the ball is assumed to
 * travel in a straight line, which is an inference: the feed only knows where events happened.
 * Video-derived fixtures report camera-frame positions, which are drawn as-is.
 */

export type BallFrame = "pitch" | "camera";
export type SegmentKind = "pass" | "carry" | "shot" | "cross" | "goal";

export interface BallPoint {
  x: number;
  y: number;
}

export interface BallSegment {
  eventId: string;
  teamId: TeamId;
  kind: SegmentKind;
  from: BallPoint;
  to: BallPoint;
  /** True for the gap between two logged events, where the route is inferred. */
  inferred: boolean;
  second: number;
}

export interface BallTouch extends BallPoint {
  eventId: string;
  teamId: TeamId;
  type: MatchEvent["type"];
  minute: number;
  second: number;
}

export interface BallPath {
  frame: BallFrame;
  segments: BallSegment[];
  touches: BallTouch[];
  /** Where the ball is after the last logged event. */
  ball: BallPoint | null;
}

const LIFECYCLE = new Set<MatchEvent["type"]>(["kickoff", "halftime", "fulltime"]);
const OFF_BALL = new Set<MatchEvent["type"]>(["substitution", "yellow_card", "red_card"]);
/** Longer gaps than this are not bridged: the ball has clearly done things the feed did not log. */
const MAX_BRIDGE_SECONDS = 60;
const CENTRE: BallPoint = { x: 50, y: 50 };

const clamp = (value: number) => Math.min(100, Math.max(0, value));
const secondOf = (event: Pick<MatchEvent, "minute" | "second">) => event.minute * 60 + event.second;
const other = (team: TeamId): TeamId => (team === "home" ? "away" : "home");

export function isCameraFixture(fixture: Pick<MatchFixture, "id">): boolean {
  return fixture.id.startsWith("video-");
}

/** An event's own position on the shared pitch frame (home attacks left to right). */
export function placeEvent(fixture: Pick<MatchFixture, "id">, event: MatchEvent, x = event.x, y = event.y): BallPoint {
  return framer(isCameraFixture(fixture) ? "camera" : "pitch")(event, x, y);
}

/** A save is recorded in the shooter's frame, so it is framed by the attacking (other) team. */
function attackingTeam(event: MatchEvent): TeamId {
  return event.type === "save" ? other(event.teamId) : event.teamId;
}

function framer(frame: BallFrame) {
  return (event: MatchEvent, x: number, y: number): BallPoint => {
    if (frame === "camera" || attackingTeam(event) === "home") return { x: clamp(x), y: clamp(y) };
    return { x: clamp(100 - x), y: clamp(100 - y) };
  };
}

/** Where the ball ends up after a shot, in the attacking frame. */
function shotTarget(event: MatchEvent): { x: number; y: number } {
  const y = clamp(event.y);
  if (event.outcome === "success") return { x: 100, y: Math.min(55, Math.max(45, y)) };
  if (event.outcome === "saved") return { x: 97, y: Math.min(56, Math.max(44, y)) };
  if (event.outcome === "blocked") return { x: clamp(event.x + 4), y };
  return { x: 100, y: y < 50 ? Math.max(0, Math.min(40, y - 8)) : Math.min(100, Math.max(60, y + 8)) };
}

export function buildBallPath(fixture: Pick<MatchFixture, "id">, events: MatchEvent[], options: { limit?: number } = {}): BallPath {
  const frame: BallFrame = isCameraFixture(fixture) ? "camera" : "pitch";
  const place = framer(frame);
  const latest = new Map<string, MatchEvent>();
  for (const event of events) {
    const previous = latest.get(event.id);
    if (!previous || event.revision >= previous.revision) latest.set(event.id, event);
  }
  const ordered = [...latest.values()]
    .filter((event) => !event.rescinded && !OFF_BALL.has(event.type))
    .sort((a, b) => secondOf(a) - secondOf(b) || a.id.localeCompare(b.id))
    .slice(-(options.limit ?? 14));

  const segments: BallSegment[] = [];
  const touches: BallTouch[] = [];
  let ball: BallPoint | null = null;
  let ballSecond = -Infinity;
  const scoringShots = new Set<string>();
  for (const event of ordered) {
    const at = secondOf(event);
    if (LIFECYCLE.has(event.type)) {
      ball = event.type === "fulltime" ? ball : CENTRE;
      ballSecond = event.type === "fulltime" ? -Infinity : at;
      continue;
    }
    // Corners restart from the flag on the attacking side, whatever side the feed logged.
    const start = event.type === "corner"
      ? place(event, 100, event.y < 50 ? 1 : 99)
      : place(event, event.x, event.y);
    // A goal that follows its own logged shot is already drawn: the shot line ends in the net.
    if (event.type === "goal" && event.relatedEventId && scoringShots.has(event.relatedEventId)) {
      touches.push({ ...place(event, event.x, event.y), eventId: event.id, teamId: event.teamId, type: event.type, minute: event.minute, second: at });
      ball = CENTRE;
      ballSecond = at;
      continue;
    }
    if (ball && at - ballSecond <= MAX_BRIDGE_SECONDS && event.type !== "corner"
      && (Math.abs(ball.x - start.x) > 0.5 || Math.abs(ball.y - start.y) > 0.5)) {
      segments.push({ eventId: event.id, teamId: attackingTeam(event), kind: "carry", from: ball, to: start, inferred: true, second: at });
    }
    touches.push({ ...start, eventId: event.id, teamId: event.teamId, type: event.type, minute: event.minute, second: at });
    let end = start;
    if (event.type === "shot") {
      const target = shotTarget(event);
      end = place(event, target.x, target.y);
      segments.push({ eventId: event.id, teamId: event.teamId, kind: event.outcome === "success" ? "goal" : "shot", from: start, to: end, inferred: false, second: at });
      if (event.outcome === "success") scoringShots.add(event.id);
    } else if (event.type === "goal") {
      end = place(event, 100, Math.min(54, Math.max(46, event.y)));
      segments.push({ eventId: event.id, teamId: event.teamId, kind: "goal", from: start, to: end, inferred: false, second: at });
    } else if (event.endX !== undefined && event.endY !== undefined) {
      end = place(event, event.endX, event.endY);
      segments.push({ eventId: event.id, teamId: event.teamId, kind: event.type === "corner" ? "cross" : "pass", from: start, to: end, inferred: false, second: at });
    }
    ball = end;
    ballSecond = at;
    // After a goal the ball goes back to the centre spot for the restart.
    if (event.type === "goal") {
      ball = CENTRE;
    }
  }
  return { frame, segments, touches, ball };
}

/** The ball's route as one list of points, used to animate it along the trail. */
export function ballRoute(path: BallPath): BallPoint[] {
  const route: BallPoint[] = [];
  for (const segment of path.segments) {
    const last = route[route.length - 1];
    if (!last || last.x !== segment.from.x || last.y !== segment.from.y) route.push(segment.from);
    route.push(segment.to);
  }
  return route;
}
