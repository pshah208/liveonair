import type { MiniMapPoint } from "../../shared/fanCards.js";

/** Small canonical 105x68 pitch with an event (and its end point, if any), in metres. Not flipped. */
export function MiniMap({ point, color, label = "Where it happened on the pitch" }: { point: MiniMapPoint; color: string; label?: string }) {
  const sx = (value: number) => Math.max(0, Math.min(105, value));
  const sy = (value: number) => Math.max(0, Math.min(68, value));
  const hasEnd = point.endX !== undefined && point.endY !== undefined;
  return (
    <svg className="fan-moment__map" viewBox="0 0 105 68" role="img" aria-label={label}>
      <rect x="0.5" y="0.5" width="104" height="67" fill="none" stroke="currentColor" strokeWidth="0.6" />
      <line x1="52.5" y1="0.5" x2="52.5" y2="67.5" stroke="currentColor" strokeWidth="0.5" />
      <circle cx="52.5" cy="34" r="9.15" fill="none" stroke="currentColor" strokeWidth="0.5" />
      <rect x="0.5" y="13.85" width="16.5" height="40.3" fill="none" stroke="currentColor" strokeWidth="0.5" />
      <rect x="88" y="13.85" width="16.5" height="40.3" fill="none" stroke="currentColor" strokeWidth="0.5" />
      {hasEnd && <line x1={sx(point.x)} y1={sy(point.y)} x2={sx(point.endX!)} y2={sy(point.endY!)} stroke={color} strokeWidth="1.2" strokeDasharray="2 1.5" />}
      {hasEnd && <circle cx={sx(point.endX!)} cy={sy(point.endY!)} r="1.6" fill="none" stroke={color} strokeWidth="1" />}
      <circle cx={sx(point.x)} cy={sy(point.y)} r="2.4" fill={color} stroke="currentColor" strokeWidth="0.5" />
    </svg>
  );
}
