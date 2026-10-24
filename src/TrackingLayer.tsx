import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { TRACKING_DELAY_SECONDS, TRACKING_PITCH_WIDTH_M, type TrackingFrame, isTrackingStreamMessage, trackingMarkerHorizon } from "../shared/tracking.js";
import type { MatchFixture } from "../shared/types.js";
import { PITCH_VIEWBOX, svgTranslate } from "./pitchGeometry.js";
import { TRACKING_LERP_MS, type TrailPoint, crowdedPlayerIds, interpolateFrame, pushTrail, shouldSnap } from "./trackingRender.js";

type TrackingLayerProps = {
  fixture: MatchFixture;
  /** Latest tracked second (+ one step) while the overlay is shown, null when hidden. */
  onHorizonChange?: (horizonSecond: number | null) => void;
};

const DOT_RADIUS_M = 1.05;
const BALL_RADIUS_M = 0.75;
/** With reduced motion, positions update at most about once a second and never glide. */
const REDUCED_MOTION_GATE_MS = 950;

function reducedMotionNow(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

const flipY = (y: number) => TRACKING_PITCH_WIDTH_M - y;

export function TrackingLayer({ fixture, onHorizonChange }: TrackingLayerProps) {
  const [statusText, setStatusText] = useState("Connecting…");
  const [connected, setConnected] = useState(false);
  const [sourceFrame, setSourceFrame] = useState<TrackingFrame | null>(null);
  const [manualEnabled, setManualEnabled] = useState<boolean | null>(null);
  const reduced = useMemo(reducedMotionNow, []);
  const rafRef = useRef<number | null>(null);
  const drawnRef = useRef<TrackingFrame | null>(null);
  const trailRef = useRef<TrailPoint[]>([]);
  const reducedGateRef = useRef(0);
  // Animation frames move existing SVG nodes directly. React only re-renders when a
  // 5 Hz source frame arrives, never at 60 fps (that was the cause of the board lag).
  const playerNodes = useRef(new Map<string, SVGGElement>());
  const ballNode = useRef<SVGGElement | null>(null);
  const trailNode = useRef<SVGPolylineElement | null>(null);

  const enabled = manualEnabled ?? connected;
  const horizonSecond = enabled && sourceFrame ? trackingMarkerHorizon(sourceFrame.second) : null;
  const goalkeeperIds = useMemo(() => new Set(
    [...fixture.home.players, ...fixture.away.players].filter((player) => player.position.toUpperCase() === "GK").map((player) => player.id),
  ), [fixture]);

  useEffect(() => {
    onHorizonChange?.(horizonSecond);
  }, [horizonSecond, onHorizonChange]);

  useEffect(() => () => onHorizonChange?.(null), [onHorizonChange]);

  const paint = (frame: TrackingFrame, trail: TrailPoint[]) => {
    for (const player of frame.players) playerNodes.current.get(player.id)?.setAttribute("transform", svgTranslate(player.x, flipY(player.y)));
    ballNode.current?.setAttribute("transform", svgTranslate(frame.ball.x, flipY(frame.ball.y)));
    trailNode.current?.setAttribute("points", trail.map((point) => `${point.x.toFixed(2)},${flipY(point.y).toFixed(2)}`).join(" "));
  };

  useEffect(() => {
    let cancelled = false;
    const reset = () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      drawnRef.current = null;
      trailRef.current = [];
      setSourceFrame(null);
    };
    reset();
    const source = new EventSource("/api/live/tracking/stream");
    setConnected(false);
    setStatusText("Connecting…");
    source.onopen = () => {
      if (!cancelled) setStatusText("Waiting for frames…");
    };
    source.onmessage = (event) => {
      if (cancelled) return;
      try {
        const payload = JSON.parse(event.data) as unknown;
        if (!isTrackingStreamMessage(payload)) return;
        if (payload.type === "status") {
          if (payload.status === "no_data") {
            setConnected(false);
            reset();
          }
          setStatusText(payload.message);
          return;
        }
        if (payload.type === "frame" && payload.frame.fixtureId === fixture.id) {
          setConnected(true);
          // The strip already says "Synthetic tracking"; a live stream needs no extra status text.
          setStatusText("");
          setSourceFrame(payload.frame);
        }
      } catch {
        setStatusText("Tracking stream error.");
      }
    };
    source.onerror = () => {
      if (!cancelled) {
        // Drop the stale frame so the board falls back to arrows; EventSource reconnects
        // on its own and the next frame repopulates the overlay.
        reset();
        setConnected(false);
        setStatusText("Tracking unavailable.");
      }
    };
    return () => {
      cancelled = true;
      source.close();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [fixture.id]);

  // Interpolate dot positions with requestAnimationFrame: lerp from what is drawn now
  // to the latest 5 Hz frame over TRACKING_LERP_MS; snap on big jumps and under reduced motion.
  // Layout effect: newly mounted dots get a position before the browser paints them.
  useLayoutEffect(() => {
    if (!sourceFrame) return;
    const draw = (frame: TrackingFrame, at: number, restartTrail: boolean) => {
      drawnRef.current = frame;
      trailRef.current = reduced ? [] : restartTrail ? [{ ...frame.ball, at }] : pushTrail(trailRef.current, { ...frame.ball, at });
      paint(frame, trailRef.current);
    };
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    const now = performance.now();
    const from = drawnRef.current;
    if (reduced) {
      if (!from || now - reducedGateRef.current >= REDUCED_MOTION_GATE_MS) {
        reducedGateRef.current = now;
        draw(sourceFrame, now, true);
      } else paint(from, trailRef.current);
      return;
    }
    if (shouldSnap(from, sourceFrame, reduced)) {
      draw(sourceFrame, now, true);
      return;
    }
    draw(interpolateFrame(from!, sourceFrame, 0), now, false);
    const start = now;
    const step = (time: number) => {
      const t = Math.min(1, Math.max(0, (time - start) / TRACKING_LERP_MS));
      draw(interpolateFrame(from!, sourceFrame, t), time, false);
      rafRef.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    rafRef.current = requestAnimationFrame(step);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceFrame, reduced]);

  // Turning the overlay back on mounts fresh nodes: place them where play currently is.
  useLayoutEffect(() => {
    if (enabled && drawnRef.current) paint(drawnRef.current, trailRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const frame = enabled ? sourceFrame : null;
  const crowdedRef = useRef<Set<string>>(new Set());
  const crowded = useMemo(() => {
    // Hysteresis via the previous result: hide below 2 m, show again only above 2.5 m.
    // Computed per 5 Hz source frame; dots move < 1.5 m between frames.
    crowdedRef.current = frame ? crowdedPlayerIds(frame.players, undefined, crowdedRef.current) : new Set<string>();
    return crowdedRef.current;
  }, [frame]);

  const controls = (
    <div className="tracking-overlay__controls" role="group" aria-label="Tracking overlay controls">
      <span className="tracking-overlay__title">Synthetic tracking</span>
      <span className="tracking-overlay__sep" aria-hidden="true">·</span>
      <span className="subtle-text">~{TRACKING_DELAY_SECONDS}s behind live</span>
      <span className="tracking-overlay__sep" aria-hidden="true">·</span>
      <label className="switch">
        <input type="checkbox" checked={enabled} onChange={(event) => setManualEnabled(event.target.checked)} />
        <span>Show tracking</span>
      </label>
      {statusText && <span className="subtle-text tracking-overlay__status" role="status">{statusText}</span>}
    </div>
  );

  if (!frame) return controls;

  return (
    <>
      {controls}
      <svg className="pitch-plane tracking-overlay__svg" viewBox={PITCH_VIEWBOX} role="img" aria-label={`Synthetic tracking, about ${TRACKING_DELAY_SECONDS} seconds behind live: ${frame.players.length} player dots and the ball`}>
        <polyline ref={trailNode} className="tracking-ball-trail" fill="none" />
        {frame.players.map((player) => {
          const goalkeeper = goalkeeperIds.has(player.id) || player.id.endsWith("-GK");
          return (
            <g key={player.id} ref={(node) => { if (node) playerNodes.current.set(player.id, node); else playerNodes.current.delete(player.id); }}>
              <circle r={DOT_RADIUS_M} className={`tracking-dot tracking-dot--${player.teamId}${goalkeeper ? " tracking-dot--gk" : ""}`} />
              {!crowded.has(player.id) && <text y="0.5" textAnchor="middle" className="tracking-overlay__number">{player.number}</text>}
            </g>
          );
        })}
        <g ref={ballNode}>
          <circle r={BALL_RADIUS_M} className="tracking-ball" />
        </g>
      </svg>
    </>
  );
}
