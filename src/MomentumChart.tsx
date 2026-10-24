import { useEffect, useId, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { MomentumSeries } from "../shared/momentum.js";
import type { TeamId } from "../shared/types.js";
import { INSUFFICIENT_COVERAGE_MESSAGE, leadingSpells, momentumGeometry, momentumSummary, MOMENTUM_LABEL, resolveMomentumPalette } from "./momentumView.js";
import { WhyItMatters } from "./WhyItMatters.js";
import "./momentum.css";

export interface MomentumChartProps {
  series: MomentumSeries;
  homeName: string;
  awayName: string;
  homeColor?: string;
  awayColor?: string;
  compact?: boolean;
  explanation?: string;
}

const DEFAULT_WIDTH = 600;

/** Measures the rendered width so the SVG draws in real pixels (crisp markers and text from 320 px up). */
function useWidth(): [RefObject<HTMLElement | null>, number] {
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const update = () => setWidth(Math.max(240, Math.round(node.getBoundingClientRect().width)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export function MomentumChart({ series, homeName, awayName, homeColor, awayColor, compact = false, explanation }: MomentumChartProps) {
  const [ref, width] = useWidth();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const palette = resolveMomentumPalette(homeColor, awayColor);
  const insufficient = series.insufficientCoverage || series.points.length === 0;

  // One stable <figure> holds the measuring ref, so the chart keeps resizing after coverage arrives.
  return (
    <figure ref={ref as RefObject<HTMLElement>} className={`momentum${compact ? " momentum--compact" : ""}`} style={{ "--momentum-home": palette.home, "--momentum-away": palette.away } as CSSProperties}>
      <figcaption className="momentum__head">
        <span className="momentum__label">{MOMENTUM_LABEL}</span>
        {!insufficient && (
          <span className="momentum__legend" aria-hidden="true">
            <span className="momentum__key momentum__key--home">▲ {homeName}</span>
            <span className="momentum__key momentum__key--away">▼ {awayName}</span>
          </span>
        )}
      </figcaption>
      {insufficient
        ? <p className="momentum__empty" role="status">{INSUFFICIENT_COVERAGE_MESSAGE}</p>
        : <MomentumPlot series={series} homeName={homeName} awayName={awayName} width={width} height={compact ? 120 : 180} uid={uid} fallback={palette.fallback} />}
      {!insufficient && explanation && <WhyItMatters text={explanation} />}
    </figure>
  );
}

interface MomentumPlotProps {
  series: MomentumSeries;
  homeName: string;
  awayName: string;
  width: number;
  height: number;
  uid: string;
  fallback: boolean;
}

function MomentumPlot({ series, homeName, awayName, width, height, uid, fallback }: MomentumPlotProps) {
  const name = (teamId: TeamId) => (teamId === "home" ? homeName : awayName);
  const geo = momentumGeometry(series.points, width, height);
  const last = series.points[series.points.length - 1]!.minute;
  const spells = leadingSpells(series.points);
  const hatchId = `momentum-hatch-${uid}`;
  const markerTop = 7;
  const markerBottom = height - 7;
  const markerY = (teamId: TeamId) => (teamId === "home" ? markerTop : markerBottom);

  return (
    <>
      <svg className="momentum__svg" role="img" aria-label={momentumSummary(series, homeName, awayName)} width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <defs>
          <pattern id={hatchId} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" className="momentum__hatch" />
          </pattern>
        </defs>
        <path className="momentum__area momentum__area--home" d={geo.homeArea} />
        <path className="momentum__area momentum__area--away" d={geo.awayArea} />
        <path className="momentum__area momentum__area--hatch" d={geo.awayArea} fill={`url(#${hatchId})`} />
        <path className="momentum__line" d={geo.line} />
        <line className="momentum__zero" x1={geo.x(0)} x2={geo.x(geo.domainMax)} y1={geo.zeroY} y2={geo.zeroY} />
        {last >= 45 && (
          <g className="momentum__halftime">
            <line x1={geo.x(45)} x2={geo.x(45)} y1={4} y2={height - 4} />
            <text x={geo.x(45) + 3} y={geo.zeroY - 4}>HT</text>
          </g>
        )}
        {series.substitutions.map((sub) => {
          const down = sub.teamId === "home" ? 1 : -1;
          return <path key={sub.eventId} className={`momentum__sub momentum__sub--${sub.teamId}`} d={`M${geo.x(sub.minute) - 3},${markerY(sub.teamId) - 3 * down} l3,${6 * down} l3,${-6 * down}`} />;
        })}
        {series.goals.map((goal) => (
          <g key={goal.eventId} className={`momentum__goal momentum__goal--${goal.teamId}`}>
            <line x1={geo.x(goal.minute)} x2={geo.x(goal.minute)} y1={goal.teamId === "home" ? markerTop + 5 : geo.zeroY} y2={goal.teamId === "home" ? geo.zeroY : markerBottom - 5} />
            <circle cx={geo.x(goal.minute)} cy={markerY(goal.teamId)} r={5} />
            <text x={geo.x(goal.minute)} y={markerY(goal.teamId) + 3}>G</text>
          </g>
        ))}
        <text className="momentum__axis" x={geo.x(0)} y={height - 1}>0'</text>
        <text className="momentum__axis momentum__axis--end" x={geo.x(geo.domainMax)} y={height - 1}>{geo.domainMax}'</text>
      </svg>
      <p className="momentum__foot">
        <span>Above the line: {homeName}. Below, hatched: {awayName}.</span>
        <span>G goal · V substitution{last >= 45 ? " · HT half-time" : ""}{fallback ? " · colour-blind-safe colours" : ""}</span>
      </p>
      <table className="sr-only">
        <caption>Clear attacking-threat spells up to {last}'</caption>
        <thead><tr><th scope="col">Team</th><th scope="col">From</th><th scope="col">To</th></tr></thead>
        <tbody>
          {spells.length === 0
            ? <tr><td colSpan={3}>No clear spell for either side</td></tr>
            : spells.map((spell) => <tr key={`${spell.teamId}-${spell.startMinute}`}><td>{name(spell.teamId)}</td><td>{spell.startMinute}'</td><td>{spell.endMinute}'</td></tr>)}
          {series.goals.map((goal) => <tr key={goal.eventId}><td>{name(goal.teamId)} goal</td><td>{goal.minute}'</td><td>{goal.minute}'</td></tr>)}
        </tbody>
      </table>
    </>
  );
}
