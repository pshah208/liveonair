import { useEffect, useMemo, useRef, useState } from "react";

import { TRACKING_DELAY_SECONDS, TRACKING_PITCH_WIDTH_M, type TrackingFrame, isTrackingStreamMessage, trackingMarkerHorizon } from "../shared/tracking.js";
import type { MatchFixture } from "../shared/types.js";
import { teamTint } from "./utils.js";

type TrackingLayerProps = {
  fixture: MatchFixture;
  /** Latest tracked second (+ one step) while the overlay is shown, null when hidden. */
  onHorizonChange?: (horizonSecond: number | null) => void;
};

function reducedMotionNow(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function interpolateFrame(from: TrackingFrame, to: TrackingFrame, t: number): TrackingFrame {
  const byId = new Map(from.players.map((player) => [player.id, player]));
  const players = to.players.map((player) => {
    const previous = byId.get(player.id);
    if (!previous) return player;
    return {
      ...player,
      x: previous.x + (player.x - previous.x) * t,
      y: previous.y + (player.y - previous.y) * t,
    };
  });
  return {
    ...to,
    players,
    ball: {
      x: from.ball.x + (to.ball.x - from.ball.x) * t,
      y: from.ball.y + (to.ball.y - from.ball.y) * t,
    },
  };
}

export function TrackingLayer({ fixture, onHorizonChange }: TrackingLayerProps) {
  const [statusText, setStatusText] = useState("Connecting synthetic tracking…");
  const [connected, setConnected] = useState(false);
  const [sourceFrame, setSourceFrame] = useState<TrackingFrame | null>(null);
  const [renderFrame, setRenderFrame] = useState<TrackingFrame | null>(null);
  const [manualEnabled, setManualEnabled] = useState<boolean | null>(null);
  const reduced = useMemo(reducedMotionNow, []);
  const rafRef = useRef<number | null>(null);
  const reducedGateRef = useRef(0);

  const enabled = manualEnabled ?? connected;
  const horizonSecond = enabled && sourceFrame ? trackingMarkerHorizon(sourceFrame.second) : null;

  useEffect(() => {
    onHorizonChange?.(horizonSecond);
  }, [horizonSecond, onHorizonChange]);

  useEffect(() => () => onHorizonChange?.(null), [onHorizonChange]);

  useEffect(() => {
    let cancelled = false;
    setSourceFrame(null);
    setRenderFrame(null);
    const source = new EventSource("/api/live/tracking/stream");
    setConnected(false);
    setStatusText("Connecting synthetic tracking…");
    source.onopen = () => {
      if (!cancelled) setStatusText("Tracking stream connected.");
    };
    source.onmessage = (event) => {
      if (cancelled) return;
      try {
        const payload = JSON.parse(event.data) as unknown;
        if (!isTrackingStreamMessage(payload)) return;
        if (payload.type === "status") {
          if (payload.status === "no_data") {
            setConnected(false);
            setSourceFrame(null);
            setRenderFrame(null);
          }
          setStatusText(payload.message);
          return;
        }
        if (payload.type === "frame" && payload.frame.fixtureId === fixture.id) {
          setConnected(true);
          setStatusText("Synthetic tracking");
          setSourceFrame(payload.frame);
        }
      } catch {
        setStatusText("Tracking stream error.");
      }
    };
    source.onerror = () => {
      if (!cancelled) {
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

  useEffect(() => {
    if (!sourceFrame) return;
    if (reduced) {
      const now = performance.now();
      if (now - reducedGateRef.current >= 950 || !renderFrame) {
        reducedGateRef.current = now;
        setRenderFrame(sourceFrame);
      }
      return;
    }
    const from = renderFrame ?? sourceFrame;
    const to = sourceFrame;
    const start = performance.now();
    const durationMs = 180;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    const animate = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      setRenderFrame(interpolateFrame(from, to, t));
      if (t < 1) rafRef.current = requestAnimationFrame(animate);
      else rafRef.current = null;
    };
    rafRef.current = requestAnimationFrame(animate);
  }, [sourceFrame, reduced]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!enabled || !renderFrame) {
    return (
      <div className="tracking-overlay__controls">
        <span className="tag">Synthetic tracking</span>
        <span className="subtle-text">Tracking ~{TRACKING_DELAY_SECONDS}s behind live</span>
        <label className="switch">
          <input type="checkbox" checked={enabled} onChange={(event) => setManualEnabled(event.target.checked)} />
          <span>Show tracking</span>
        </label>
        <span className="subtle-text">{statusText}</span>
      </div>
    );
  }

  return (
    <>
      <div className="tracking-overlay__controls">
        <span className="tag">Synthetic tracking</span>
        <span className="subtle-text">Tracking ~{TRACKING_DELAY_SECONDS}s behind live</span>
        <label className="switch">
          <input type="checkbox" checked={enabled} onChange={(event) => setManualEnabled(event.target.checked)} />
          <span>Show tracking</span>
        </label>
        <span className="subtle-text">{statusText}</span>
      </div>
      <svg className="tracking-overlay__svg" viewBox="0 0 105 68" aria-hidden="true">
        <g>
          {renderFrame.players.map((player) => (
            <g key={player.id} transform={`translate(${player.x} ${TRACKING_PITCH_WIDTH_M - player.y})`}>
              <circle r="1.12" fill={teamTint(player.teamId)} stroke="var(--cp-bg)" strokeWidth="0.24" />
              <text y="0.28" textAnchor="middle" className="tracking-overlay__number">{player.number}</text>
            </g>
          ))}
          <g transform={`translate(${renderFrame.ball.x} ${TRACKING_PITCH_WIDTH_M - renderFrame.ball.y})`}>
            <circle r="0.52" fill="#ffffff" stroke="#111114" strokeWidth="0.2" />
          </g>
        </g>
      </svg>
    </>
  );
}
