import { useEffect, useMemo, useRef, useState } from "react";

import { TRACKING_DELAY_SECONDS, TRACKING_PITCH_WIDTH_M, type TrackingFrame, isTrackingStreamMessage, trackingMarkerHorizon } from "../shared/tracking.js";
import type { MatchFixture } from "../shared/types.js";
import { TRACKING_BALL_TRAIL_MS, TRACKING_LERP_MS, type TrailPoint, crowdedPlayerIds, interpolateFrame, pushTrail, shouldSnap } from "./trackingRender.js";

type TrackingLayerProps = {
  fixture: MatchFixture;
  /** Latest tracked second (+ one step) while the overlay is shown, null when hidden. */
  onHorizonChange?: (horizonSecond: number | null) => void;
};

type TrackingView = { frame: TrackingFrame; trail: TrailPoint[] };

const DOT_RADIUS_M = 0.95;
const BALL_RADIUS_M = 0.8;
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
  const [view, setView] = useState<TrackingView | null>(null);
  const [manualEnabled, setManualEnabled] = useState<boolean | null>(null);
  const reduced = useMemo(reducedMotionNow, []);
  const rafRef = useRef<number | null>(null);
  const drawnRef = useRef<TrackingFrame | null>(null);
  const trailRef = useRef<TrailPoint[]>([]);
  const reducedGateRef = useRef(0);

  const enabled = manualEnabled ?? connected;
  const horizonSecond = enabled && sourceFrame ? trackingMarkerHorizon(sourceFrame.second) : null;
  const goalkeeperIds = useMemo(() => new Set(
    [...fixture.home.players, ...fixture.away.players].filter((player) => player.position.toUpperCase() === "GK").map((player) => player.id),
  ), [fixture]);

  useEffect(() => {
    onHorizonChange?.(horizonSecond);
  }, [horizonSecond, onHorizonChange]);

  useEffect(() => () => onHorizonChange?.(null), [onHorizonChange]);

  useEffect(() => {
    let cancelled = false;
    const reset = () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      drawnRef.current = null;
      trailRef.current = [];
      setSourceFrame(null);
      setView(null);
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
  useEffect(() => {
    if (!sourceFrame) return;
    const draw = (frame: TrackingFrame, at: number, restartTrail: boolean) => {
      drawnRef.current = frame;
      trailRef.current = reduced ? [] : restartTrail ? [{ ...frame.ball, at }] : pushTrail(trailRef.current, { ...frame.ball, at });
      setView({ frame, trail: trailRef.current });
    };
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    const now = performance.now();
    const from = drawnRef.current;
    if (reduced) {
      if (!from || now - reducedGateRef.current >= REDUCED_MOTION_GATE_MS) {
        reducedGateRef.current = now;
        draw(sourceFrame, now, true);
      }
      return;
    }
    if (shouldSnap(from, sourceFrame, reduced)) {
      draw(sourceFrame, now, true);
      return;
    }
    const start = now;
    const step = (time: number) => {
      const t = Math.min(1, Math.max(0, (time - start) / TRACKING_LERP_MS));
      draw(interpolateFrame(from!, sourceFrame, t), time, false);
      rafRef.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    rafRef.current = requestAnimationFrame(step);
  }, [sourceFrame, reduced]);

  const frame = enabled ? view?.frame ?? null : null;
  const crowdedRef = useRef<Set<string>>(new Set());
  const crowded = useMemo(() => {
    // Hysteresis via the previous result: hide below 2 m, show again only above 2.5 m.
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

  const trail = view?.trail ?? [];
  const latestAt = trail[trail.length - 1]?.at ?? 0;

  return (
    <>
      {controls}
      <svg className="tracking-overlay__svg" viewBox="0 0 105 68" role="img" aria-label={`Synthetic tracking, about ${TRACKING_DELAY_SECONDS} seconds behind live: ${frame.players.length} player dots and the ball`}>
        <g>
          {frame.players.map((player) => {
            const goalkeeper = goalkeeperIds.has(player.id) || player.id.endsWith("-GK");
            return (
              <g key={player.id} transform={`translate(${player.x} ${flipY(player.y)})`}>
                <circle r={DOT_RADIUS_M} className={`tracking-dot tracking-dot--${player.teamId}${goalkeeper ? " tracking-dot--gk" : ""}`} />
                {!crowded.has(player.id) && <text y="0.5" textAnchor="middle" className="tracking-overlay__number">{player.number}</text>}
              </g>
            );
          })}
          {trail.slice(0, -1).map((point) => {
            const fresh = Math.min(1, Math.max(0, 1 - (latestAt - point.at) / TRACKING_BALL_TRAIL_MS));
            return <circle key={point.at} cx={point.x} cy={flipY(point.y)} r={BALL_RADIUS_M * (0.35 + 0.45 * fresh)} className="tracking-ball-trail" opacity={0.45 * fresh} />;
          })}
          <g transform={`translate(${frame.ball.x} ${flipY(frame.ball.y)})`}>
            <circle r={BALL_RADIUS_M} className="tracking-ball" />
          </g>
        </g>
      </svg>
    </>
  );
}
