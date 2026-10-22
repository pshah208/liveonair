import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ballRoute, buildBallPath, placeEvent, type BallPoint, type BallSegment } from "../shared/ballPath.js";
import { difficultyBand, metricOptions, passDifficulty, shotSpeedKmh } from "../shared/metrics.js";
import type { MatchEvent, MatchFixture } from "../shared/types.js";
import { labelize, teamTint } from "./utils.js";

type PitchProps = { fixture: MatchFixture; events: MatchEvent[] };
type Mode = "ball" | "areas";

const PITCH_H = 68;
const HOP_MS = 420;
const toY = (y: number) => (y / 100) * PITCH_H;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** Moves the ball marker along a list of points with requestAnimationFrame. */
function useBallMotion() {
  const [position, setPosition] = useState<BallPoint | null>(null);
  const [playing, setPlaying] = useState(false);
  const frame = useRef<number | null>(null);
  const positionRef = useRef<BallPoint | null>(null);
  positionRef.current = position;

  function stop() {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    setPlaying(false);
  }

  function animate(points: BallPoint[], hopMs = HOP_MS) {
    stop();
    const route = points.filter((point, index) => index === 0 || point.x !== points[index - 1]!.x || point.y !== points[index - 1]!.y);
    if (route.length < 2 || prefersReducedMotion()) {
      setPosition(route[route.length - 1] ?? null);
      return;
    }
    const total = (route.length - 1) * hopMs;
    const started = performance.now();
    setPlaying(true);
    const step = (now: number) => {
      // The first frame's timestamp can precede the start time, so clamp progress to 0–1.
      const progress = Math.min(1, Math.max(0, (now - started) / total));
      const scaled = progress * (route.length - 1);
      const index = Math.min(route.length - 2, Math.floor(scaled));
      const local = scaled - index;
      const eased = local < 0.5 ? 2 * local * local : 1 - (-2 * local + 2) ** 2 / 2;
      const from = route[index]!;
      const to = route[index + 1]!;
      setPosition({ x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased });
      if (progress < 1) frame.current = requestAnimationFrame(step);
      else { frame.current = null; setPlaying(false); }
    };
    frame.current = requestAnimationFrame(step);
  }

  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  return { position, positionRef, playing, animate, stop, setPosition };
}

function segmentStyle(segment: BallSegment, age: number, difficulty?: number) {
  const opacity = 0.12 + 0.88 * age * age;
  if (segment.inferred) return { stroke: "var(--cp-text-soft)", width: 0.35, dash: "0.6 1", opacity: opacity * 0.8 };
  if (segment.kind === "shot" || segment.kind === "goal") return { stroke: teamTint(segment.teamId), width: segment.kind === "goal" ? 1.1 : 0.85, dash: undefined, opacity };
  if (segment.kind === "pass" && difficulty !== undefined) return { stroke: DIFFICULTY_COLOUR[difficultyBand(difficulty)], width: 0.6, dash: undefined, opacity };
  return { stroke: teamTint(segment.teamId), width: 0.6, dash: segment.kind === "cross" ? "1.6 1" : undefined, opacity };
}

const DIFFICULTY_COLOUR = { easy: "var(--cp-success)", medium: "var(--cp-warning)", hard: "var(--cp-danger)" } as const;

export function Pitch({ fixture, events }: PitchProps) {
  // Studio and Fan can both mount a Pitch, so SVG ids are namespaced per instance. useId yields colons, which break url(#...).
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const arrowId = (key: string) => `ball-arrow-${uid}-${key}`;
  const glowId = `ball-glow-${uid}`;
  const [mode, setMode] = useState<Mode>("ball");
  const shown = events;
  // Difficulty and speed come from each event's own data; pressure context is whatever the shown feed contains.
  const metrics = useMemo(() => {
    const options = metricOptions(fixture);
    const difficulty = new Map<string, number>();
    const speed = new Map<string, number>();
    for (const event of shown) {
      if (event.type === "pass") {
        const score = passDifficulty(event, shown, options)?.score;
        if (score !== undefined) difficulty.set(event.id, score);
      } else if (event.type === "shot") {
        const kmh = shotSpeedKmh(event, options);
        if (kmh !== null) speed.set(event.id, kmh);
      }
    }
    return { difficulty, speed };
  }, [fixture, shown]);
  const path = useMemo(() => buildBallPath(fixture, shown, { limit: 9 }), [fixture, shown]);
  const route = useMemo(() => ballRoute(path), [path]);
  const areaEvents = useMemo(() => shown.slice(-8).slice().sort((a, b) => a.minute * 60 + a.second - (b.minute * 60 + b.second)), [shown]);
  const latestTouch = path.touches[path.touches.length - 1];
  const latestEvent = areaEvents[areaEvents.length - 1];
  const motion = useBallMotion();
  const lastAnimated = useRef<{ fixtureId: string; second: number } | null>(null);

  // When new events arrive, the ball travels through just the new part of the route.
  useEffect(() => {
    const previous = lastAnimated.current;
    const sameMatch = previous?.fixtureId === fixture.id;
    const fresh = path.segments.filter((segment) => !sameMatch || segment.second > previous!.second);
    lastAnimated.current = { fixtureId: fixture.id, second: latestTouch?.second ?? -1 };
    if (!path.ball) { motion.stop(); motion.setPosition(null); return; }
    if (!sameMatch || fresh.length === 0) {
      if (!motion.positionRef.current || !sameMatch) motion.animate([path.ball]);
      else if (motion.positionRef.current.x !== path.ball.x || motion.positionRef.current.y !== path.ball.y) motion.animate([motion.positionRef.current, path.ball]);
      return;
    }
    const points: BallPoint[] = [motion.positionRef.current ?? fresh[0]!.from];
    for (const segment of fresh) points.push(segment.from, segment.to);
    points.push(path.ball);
    motion.animate(points);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, fixture.id]);

  const replay = () => motion.animate([...route, ...(path.ball ? [path.ball] : [])], HOP_MS + 80);
  const camera = path.frame === "camera";
  const ball = motion.position;

  return (
    <figure className="pitch-figure">
      <div className="pitch-toolbar">
        <div className="segmented segmented--compact" role="radiogroup" aria-label="Live board view">
          {(["ball", "areas"] as Mode[]).map((item) => (
            <button key={item} type="button" role="radio" aria-checked={mode === item} className={`segmented__item${mode === item ? " is-active" : ""}`} onClick={() => setMode(item)}>
              {item === "ball" ? "Ball movement" : "Action areas"}
            </button>
          ))}
        </div>
        {mode === "ball" && <button type="button" className="link-button" onClick={replay} disabled={route.length < 2 || motion.playing}>{motion.playing ? "Playing…" : "↻ Replay sequence"}</button>}
      </div>
      <svg viewBox="0 0 100 68" className="pitch" role="img" aria-label={`${fixture.title} ${mode === "ball" ? "ball movement" : "action areas"}`}>
        <defs>
          {(["home", "away"] as const).map((team) => (
            <marker key={team} id={arrowId(team)} viewBox="0 0 6 6" refX="5" refY="3" markerWidth="3.2" markerHeight="3.2" orient="auto-start-reverse">
              <path d="M0 0 6 3 0 6z" fill={teamTint(team)} />
            </marker>
          ))}
          {(["easy", "medium", "hard"] as const).map((band) => (
            <marker key={band} id={arrowId(band)} viewBox="0 0 6 6" refX="5" refY="3" markerWidth="3.2" markerHeight="3.2" orient="auto-start-reverse">
              <path d="M0 0 6 3 0 6z" fill={DIFFICULTY_COLOUR[band]} />
            </marker>
          ))}
          <radialGradient id={glowId}>
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect x="1" y="1" width="98" height="66" rx="3" fill="var(--cp-surface-soft)" stroke="var(--cp-border-strong)" strokeWidth="0.8" />
        <path d="M50 1v66" stroke="var(--cp-border)" strokeWidth="0.6" />
        <circle cx="50" cy="34" r="9" fill="none" stroke="var(--cp-border)" strokeWidth="0.6" />
        <circle cx="50" cy="34" r="0.6" fill="var(--cp-border-strong)" />
        <rect x="1" y="18" width="16" height="32" fill="none" stroke="var(--cp-border)" strokeWidth="0.6" />
        <rect x="83" y="18" width="16" height="32" fill="none" stroke="var(--cp-border)" strokeWidth="0.6" />
        <rect x="1" y="26" width="5" height="16" fill="none" stroke="var(--cp-border)" strokeWidth="0.6" />
        <rect x="94" y="26" width="5" height="16" fill="none" stroke="var(--cp-border)" strokeWidth="0.6" />
        <rect x="-0.6" y="30.6" width="1.6" height="6.8" fill="none" stroke="var(--cp-border-strong)" strokeWidth="0.5" />
        <rect x="99" y="30.6" width="1.6" height="6.8" fill="none" stroke="var(--cp-border-strong)" strokeWidth="0.5" />

        {mode === "ball" ? (
          <g>
            {path.segments.map((segment, index) => {
              const difficulty = segment.kind === "pass" && !segment.inferred ? metrics.difficulty.get(segment.eventId) : undefined;
              const style = segmentStyle(segment, (index + 1) / path.segments.length, difficulty);
              const arrow = segment.inferred ? undefined : difficulty !== undefined ? `url(#${arrowId(difficultyBand(difficulty))})` : `url(#${arrowId(segment.teamId)})`;
              return (
                <line key={`${segment.eventId}-${segment.kind}-${index}`} x1={segment.from.x} y1={toY(segment.from.y)} x2={segment.to.x} y2={toY(segment.to.y)}
                  stroke={style.stroke} strokeWidth={style.width} strokeDasharray={style.dash} strokeLinecap="round" opacity={style.opacity} markerEnd={arrow}>
                  {difficulty !== undefined && <title>{`Pass difficulty ${difficulty}/100 (illustrative, uncalibrated)`}</title>}
                </line>
              );
            })}
            {path.segments.filter((segment) => !segment.inferred && (segment.kind === "shot" || segment.kind === "goal") && metrics.speed.has(segment.eventId)).map((segment) => (
              <text key={`speed-${segment.eventId}-${segment.kind}`} x={Math.min(94, Math.max(6, segment.from.x))} y={Math.min(66, toY(segment.from.y) + 4)} className="pitch-label pitch-speed-badge" textAnchor="middle">
                {Math.round(metrics.speed.get(segment.eventId)!)} km/h
              </text>
            ))}
            {path.touches.map((touch, index) => {
              const last = index === path.touches.length - 1;
              return (
                <g key={`${touch.eventId}-${index}`} opacity={0.35 + (0.65 * (index + 1)) / path.touches.length}>
                  <circle cx={touch.x} cy={toY(touch.y)} r={last ? 1.25 : 0.9} fill={teamTint(touch.teamId)} />
                  {touch.type === "goal" && <circle cx={touch.x} cy={toY(touch.y)} r="2.4" fill="none" stroke={teamTint(touch.teamId)} strokeWidth="0.4" />}
                </g>
              );
            })}
            {latestTouch && (
              <text x={Math.min(92, Math.max(8, latestTouch.x))} y={Math.max(4, toY(latestTouch.y) - 3)} className="pitch-label" textAnchor="middle">
                {latestTouch.minute}' {labelize(latestTouch.type)}
              </text>
            )}
            {ball && (
              <g className="pitch-ball" transform={`translate(${ball.x} ${toY(ball.y)})`}>
                <circle r="3" fill={`url(#${glowId})`} />
                <circle r="1.15" fill="#ffffff" stroke="#111114" strokeWidth="0.35" />
                <path d="M-0.45 -0.2 0 -0.55 0.45 -0.2 0.28 0.38 -0.28 0.38z" fill="#111114" />
              </g>
            )}
          </g>
        ) : (
          <g>
            {areaEvents.map((event, index) => {
              const active = event.id === latestEvent?.id;
              const start = placeEvent(fixture, event);
              const end = event.endX !== undefined && event.endY !== undefined ? placeEvent(fixture, event, event.endX, event.endY) : null;
              const opacity = event.rescinded ? 0.3 : 0.45 + (0.55 * (index + 1)) / areaEvents.length;
              return (
                <g key={`${event.id}-${event.revision}`} opacity={opacity}>
                  {end && <line x1={start.x} y1={toY(start.y)} x2={end.x} y2={toY(end.y)} stroke={teamTint(event.teamId)} strokeWidth={active ? 1 : 0.7} strokeDasharray={event.type === "pass" || event.type === "corner" ? "2 1.6" : undefined} />}
                  <circle cx={start.x} cy={toY(start.y)} r={active ? 1.9 : 1.3} fill={teamTint(event.teamId)} className={active ? "pitch-pulse" : undefined} />
                </g>
              );
            })}
          </g>
        )}
      </svg>
      <figcaption className="pitch-legend">
        <span><i className="swatch swatch--home" />{camera ? fixture.home.shortName : `${fixture.home.shortName} attacks →`}</span>
        {mode === "ball" && <span className="subtle-text">{camera ? "Camera-view positions · route between events inferred" : "Solid: pass / shot · dotted: inferred route between logged events"}</span>}
        {mode === "ball" && !camera && metrics.difficulty.size > 0 && (
          <span className="subtle-text pitch-difficulty-legend">
                      Pass difficulty (illustrative, uncalibrated heuristic): <i className="swatch" style={{ background: DIFFICULTY_COLOUR.easy }} />easy <i className="swatch" style={{ background: DIFFICULTY_COLOUR.medium }} />medium <i className="swatch" style={{ background: DIFFICULTY_COLOUR.hard }} />hard
          </span>
        )}
        <span>{camera ? fixture.away.shortName : `← ${fixture.away.shortName}`} <i className="swatch swatch--away" /></span>
        <span className="subtle-text">{(mode === "ball" ? latestTouch : latestEvent) ? `${(mode === "ball" ? latestTouch : latestEvent)!.minute}' ${labelize((mode === "ball" ? latestTouch : latestEvent)!.type)}` : "Awaiting feed"}</span>
      </figcaption>
    </figure>
  );
}
