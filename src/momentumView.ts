// Pure view-model helpers for the momentum chart, control-vs-chaos card and simulated engagement panel.
// No DOM, no React: everything here is deterministic and unit-tested in tests/momentum-ui.test.ts.
import { computeMomentum, controlVsChaos, type ControlChaosWindow, type MomentumMarker, type MomentumPoint, type MomentumSeries } from "../shared/momentum.js";
import { EVENT_TYPES, type MatchEvent, type TeamId } from "../shared/types.js";

export const MOMENTUM_LABEL = "Illustrative attacking threat (synthetic)";
export const INSUFFICIENT_COVERAGE_MESSAGE = "Not enough match events yet to draw attacking threat. It appears once the event feed covers a few minutes of play (uploaded video clips are often too sparse).";
export const CONTROL_INSUFFICIENT_MESSAGE = "Not enough match events in the last five minutes to call control vs chaos yet.";
export const SPONSOR_NAME = "Northwind Sports";
export const SPONSOR_LABEL = `Momentum segment presented by ${SPONSOR_NAME}`;
export const SIMULATED_ENGAGEMENT_LABEL = "Simulated — no real users";

const ON_BALL = new Set<MatchEvent["type"]>(
  EVENT_TYPES.filter((type) => !["pressure", "foul", "yellow_card", "red_card", "substitution", "kickoff", "halftime", "fulltime"].includes(type)),
);
const MIN_EVENTS_PER_MINUTE = 1.2;
const MIN_ELAPSED_MINUTES = 3;
const SMOOTHING_MINUTES = 3;

const secondOf = (event: Pick<MatchEvent, "minute" | "second">) => event.minute * 60 + event.second;
const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

function latestOpenEvents(events: MatchEvent[]): MatchEvent[] {
  const latest = new Map<string, MatchEvent>();
  for (const event of events) {
    const previous = latest.get(event.id);
    if (!previous || event.revision >= previous.revision) latest.set(event.id, event);
  }
  return [...latest.values()].filter((event) => !event.rescinded);
}

export const EMPTY_MOMENTUM: MomentumSeries = { points: [], goals: [], substitutions: [], insufficientCoverage: true };

/**
 * Momentum up to the live minute. `computeMomentum` pads to 90 minutes and judges coverage over the whole
 * match; here the series is trimmed to the elapsed minutes, re-smoothed without the empty future, and coverage
 * is judged over elapsed time only. `uptoMinute = null` means the whole match (full time / replay).
 */
export function momentumUpTo(events: MatchEvent[], uptoMinute: number | null): MomentumSeries {
  const scoped = uptoMinute === null ? events : events.filter((event) => event.minute <= uptoMinute);
  const open = latestOpenEvents(scoped);
  if (open.length === 0) return EMPTY_MOMENTUM;
  const lastMinute = uptoMinute ?? Math.max(...open.map((event) => Math.floor(secondOf(event) / 60)));
  const series = computeMomentum(scoped, { smoothingMinutes: SMOOTHING_MINUTES });
  const raw = series.points.filter((point) => point.minute <= lastMinute);
  const radius = Math.floor(SMOOTHING_MINUTES / 2);
  const points: MomentumPoint[] = raw.map((point, index) => {
    const slice = raw.slice(Math.max(0, index - radius), Math.min(raw.length, index + radius + 1));
    const net = slice.reduce((sum, item) => sum + item.homeThreat - item.awayThreat, 0) / slice.length;
    return { ...point, netThreat: round(net) };
  });
  const elapsed = lastMinute + 1;
  const onBall = open.filter((event) => ON_BALL.has(event.type)).length;
  return {
    points,
    goals: series.goals.filter((marker) => marker.minute <= lastMinute),
    substitutions: series.substitutions.filter((marker) => marker.minute <= lastMinute),
    insufficientCoverage: elapsed < MIN_ELAPSED_MINUTES || onBall < elapsed * MIN_EVENTS_PER_MINUTE,
  };
}

// ---------------------------------------------------------------- palette

export interface MomentumPalette {
  home: string;
  away: string;
  /** True when the requested team colours were replaced by the colour-blind-safe blue/orange pair. */
  fallback: boolean;
}

/** Okabe–Ito blue and orange: distinguishable under the common colour-vision deficiencies. */
export const SAFE_HOME = "#0072B2";
export const SAFE_AWAY = "#E69F00";

export function parseHexColor(value: string | undefined): [number, number, number] | null {
  if (!value) return null;
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const hex = match[1]!.length === 3 ? [...match[1]!].map((char) => char + char).join("") : match[1]!;
  return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
}

function hueSat([r, g, b]: [number, number, number]): { hue: number; sat: number } {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const light = (max + min) / 2;
  const sat = delta === 0 ? 0 : delta / (1 - Math.abs(2 * light - 1));
  let hue = 0;
  if (delta !== 0) {
    if (max === rn) hue = 60 * (((gn - bn) / delta) % 6);
    else if (max === gn) hue = 60 * ((bn - rn) / delta + 2);
    else hue = 60 * ((rn - gn) / delta + 4);
  }
  return { hue: (hue + 360) % 360, sat };
}

const isRed = (hs: { hue: number; sat: number }) => hs.sat > 0.3 && (hs.hue <= 25 || hs.hue >= 335);
const isGreen = (hs: { hue: number; sat: number }) => hs.sat > 0.25 && hs.hue >= 70 && hs.hue <= 170;

/** Team colours when they are distinct and not a red/green pair; otherwise the safe blue/orange pair. */
export function resolveMomentumPalette(homeColor?: string, awayColor?: string): MomentumPalette {
  if (!homeColor && !awayColor) return { home: "var(--team-home)", away: "var(--team-away)", fallback: false };
  const home = parseHexColor(homeColor);
  const away = parseHexColor(awayColor);
  if (!home || !away) return { home: SAFE_HOME, away: SAFE_AWAY, fallback: true };
  const distance = Math.hypot(home[0] - away[0], home[1] - away[1], home[2] - away[2]);
  const a = hueSat(home);
  const b = hueSat(away);
  const hueGap = Math.min(Math.abs(a.hue - b.hue), 360 - Math.abs(a.hue - b.hue));
  const tooClose = distance < 120 || (a.sat > 0.25 && b.sat > 0.25 && hueGap < 35);
  const redGreen = (isRed(a) && isGreen(b)) || (isGreen(a) && isRed(b));
  if (tooClose || redGreen) return { home: SAFE_HOME, away: SAFE_AWAY, fallback: true };
  return { home: homeColor!, away: awayColor!, fallback: false };
}

// ---------------------------------------------------------------- geometry

export interface MomentumGeometry {
  homeArea: string;
  awayArea: string;
  line: string;
  zeroY: number;
  maxAbs: number;
  domainMax: number;
  x: (minute: number) => number;
}

const MIN_SCALE = 0.05;

/** SVG paths: the home area above the zero line, the away area below, split exactly at zero crossings. */
export function momentumGeometry(points: MomentumPoint[], width: number, height: number, pad = { left: 4, right: 4, top: 14, bottom: 14 }): MomentumGeometry {
  const domainMax = Math.max(90, ...points.map((point) => point.minute));
  const maxAbs = Math.max(MIN_SCALE, ...points.map((point) => Math.abs(point.netThreat)));
  const plotW = Math.max(1, width - pad.left - pad.right);
  const plotH = Math.max(1, height - pad.top - pad.bottom);
  const zeroY = pad.top + plotH / 2;
  const x = (minute: number) => round(pad.left + (minute / domainMax) * plotW, 2);
  const y = (value: number) => round(zeroY - (value / maxAbs) * (plotH / 2), 2);
  if (points.length === 0) return { homeArea: "", awayArea: "", line: "", zeroY, maxAbs, domainMax, x };

  const vertices: Array<[number, number]> = [];
  points.forEach((point, index) => {
    vertices.push([point.minute, point.netThreat]);
    const next = points[index + 1];
    if (next && Math.sign(point.netThreat) * Math.sign(next.netThreat) < 0) {
      const t = point.netThreat / (point.netThreat - next.netThreat);
      vertices.push([point.minute + t * (next.minute - point.minute), 0]);
    }
  });
  const area = (clip: (value: number) => number) => {
    const first = vertices[0]!;
    const last = vertices[vertices.length - 1]!;
    return `M${x(first[0])},${zeroY} ${vertices.map(([minute, value]) => `L${x(minute)},${y(clip(value))}`).join(" ")} L${x(last[0])},${zeroY} Z`;
  };
  return {
    homeArea: area((value) => Math.max(0, value)),
    awayArea: area((value) => Math.min(0, value)),
    line: vertices.map(([minute, value], index) => `${index === 0 ? "M" : "L"}${x(minute)},${y(value)}`).join(" "),
    zeroY,
    maxAbs,
    domainMax,
    x,
  };
}

// ---------------------------------------------------------------- spells and summary

export interface LeadingSpell {
  teamId: TeamId;
  startMinute: number;
  endMinute: number;
}

/** Spells of at least two consecutive minutes where one side clearly carried more attacking threat. */
export function leadingSpells(points: MomentumPoint[]): LeadingSpell[] {
  const meanAbs = points.length ? points.reduce((sum, point) => sum + Math.abs(point.netThreat), 0) / points.length : 0;
  // Relative to the typical swing, so one early peak doesn't hide every later spell.
  const threshold = Math.max(0.05, meanAbs);
  const spells: LeadingSpell[] = [];
  let open: LeadingSpell | null = null;
  for (const point of points) {
    const teamId: TeamId | null = point.netThreat >= threshold ? "home" : point.netThreat <= -threshold ? "away" : null;
    if (open && teamId === open.teamId && point.minute === open.endMinute + 1) {
      open.endMinute = point.minute;
      continue;
    }
    if (open && open.endMinute > open.startMinute) spells.push(open);
    open = teamId ? { teamId, startMinute: point.minute, endMinute: point.minute } : null;
  }
  if (open && open.endMinute > open.startMinute) spells.push(open);
  return spells;
}

export function momentumSummary(series: MomentumSeries, homeName: string, awayName: string): string {
  if (series.insufficientCoverage || series.points.length === 0) return `${MOMENTUM_LABEL}: not enough match events yet.`;
  const last = series.points[series.points.length - 1]!.minute;
  const homeMinutes = series.points.filter((point) => point.netThreat > 0).length;
  const awayMinutes = series.points.filter((point) => point.netThreat < 0).length;
  const spells = leadingSpells(series.points);
  const latest = spells[spells.length - 1];
  const name = (teamId: TeamId) => (teamId === "home" ? homeName : awayName);
  const parts = [
    `${MOMENTUM_LABEL} up to ${last}'.`,
    `${homeName} ahead on threat for ${homeMinutes} minutes, ${awayName} for ${awayMinutes} minutes.`,
    latest ? `Latest clear spell: ${name(latest.teamId)}, ${latest.startMinute}' to ${latest.endMinute}'.` : "No clear spell for either side.",
    series.goals.length ? `Goals: ${series.goals.map((goal) => `${name(goal.teamId)} ${goal.minute}'`).join(", ")}.` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- control vs chaos

export interface ControlWindowView {
  current: ControlChaosWindow | null;
  previous: ControlChaosWindow | null;
}

/** The latest completed five-minute window up to the live minute (`null` = whole match). */
export function latestControlWindow(events: MatchEvent[], uptoMinute: number | null, windowMinutes = 5): ControlWindowView {
  const scoped = uptoMinute === null ? events : events.filter((event) => event.minute <= uptoMinute);
  if (latestOpenEvents(scoped).length === 0) return { current: null, previous: null };
  // Live: a window counts once the clock has passed its end. Full time: the last event's minute closes its window.
  const limit = uptoMinute ?? Math.max(...scoped.map((event) => event.minute)) + 1;
  const windows = controlVsChaos(scoped, windowMinutes).filter((window) => window.endMinute <= limit && window.endMinute - window.startMinute === windowMinutes);
  return { current: windows[windows.length - 1] ?? null, previous: windows[windows.length - 2] ?? null };
}

export const CONTROL_LABEL: Record<ControlChaosWindow["label"], string> = {
  controlled: "Controlled passage",
  chaotic: "Chaotic passage",
  mixed: "Mixed passage",
};

export function pressureChangeText(delta: number | null): string {
  if (delta === null) return "No previous window to compare";
  if (delta === 0) return "Same number of pressing actions as the previous five minutes";
  const n = Math.abs(delta);
  return `${n} ${n === 1 ? "pressing action" : "pressing actions"} ${delta > 0 ? "more" : "fewer"} than the previous five minutes`;
}

// ---------------------------------------------------------------- simulated engagement

export interface EngagementDropOff {
  minute: number;
  moment: string;
  dropPercent: number;
}

export interface SimulatedEngagement {
  optIns: number;
  avgMinutesEngaged: number;
  dropOffs: EngagementDropOff[];
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Synthetic second-screen numbers for the Studio demo. Deterministic for a match key and minute; no real users,
 * no tracking, no network calls.
 */
export function simulatedEngagement(matchKey: string, minute: number, goals: MomentumMarker[], teamName: (teamId: TeamId) => string): SimulatedEngagement {
  const hash = hashString(matchKey || "matchlens");
  const played = Math.max(0, Math.min(95, Math.floor(minute)));
  const base = 800 + (hash % 800);
  const growth = 6 + ((hash >>> 10) % 9);
  const optIns = base + played * growth;
  const avgMinutesEngaged = played === 0 ? 0 : Math.min(played, Math.round(played * 0.55 + ((hash >>> 4) % 6)));
  const dropOffs: EngagementDropOff[] = [];
  for (const goal of goals) {
    if (goal.minute > played) continue;
    dropOffs.push({ minute: goal.minute, moment: `After the ${teamName(goal.teamId)} goal`, dropPercent: 1 + ((hash >>> (goal.minute % 16)) + goal.minute) % 4 });
  }
  if (played >= 45) dropOffs.push({ minute: 45, moment: "Half-time break", dropPercent: 8 + ((hash >>> 6) % 7) });
  if (played >= 90) dropOffs.push({ minute: 90, moment: "Final whistle", dropPercent: 25 + ((hash >>> 3) % 11) });
  dropOffs.sort((a, b) => a.minute - b.minute || a.moment.localeCompare(b.moment));
  return { optIns, avgMinutesEngaged, dropOffs: dropOffs.slice(-4) };
}
