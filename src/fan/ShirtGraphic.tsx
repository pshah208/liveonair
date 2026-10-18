// Shared shirt silhouette for the Player card (SVG on screen, Path2D on the exported canvas).
import { shirtStyle } from "../../shared/fanCards.js";
import type { TeamId } from "../../shared/types.js";

/** Simple short-sleeved shirt on a 100x100 grid. */
export const SHIRT_PATH = "M32 8 L10 20 L18 38 L28 33 L28 92 L72 92 L72 33 L82 38 L90 20 L68 8 C64 17 36 17 32 8 Z";

export function ShirtGraphic({ teamId, number }: { teamId: TeamId; number: number }) {
  const style = shirtStyle(teamId);
  return (
    <figure className="fan-card__shirt" aria-hidden="true">
      <svg viewBox="0 0 100 100" focusable="false">
        <path d={SHIRT_PATH} fill={style.fill} stroke="#09090b" strokeWidth="2" strokeLinejoin="round" />
        <text x="50" y="66" textAnchor="middle" fontSize="30" fontWeight="800" fontFamily="inherit" fill={style.number}
          {...(style.outline ? { stroke: style.number === "#ffffff" ? "#09090b" : "#ffffff", strokeWidth: 1.2, paintOrder: "stroke" } : {})}>{number}</text>
      </svg>
      <figcaption>Illustrative graphic</figcaption>
    </figure>
  );
}
