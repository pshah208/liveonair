import { isCameraFixture } from "./ballPath.js";
import type { MatchEvent, MatchFixture, MatchPeriod, PeriodScope } from "./types.js";

export type { MatchPeriod, PeriodScope };

export const MATCH_PERIODS: readonly MatchPeriod[] = ["full", "first", "second"];
export const PERIOD_LABEL: Record<MatchPeriod, string> = { full: "Full match", first: "1st half", second: "2nd half" };

export function isMatchPeriod(value: unknown): value is MatchPeriod {
  return typeof value === "string" && (MATCH_PERIODS as readonly string[]).includes(value);
}

export interface PeriodBoundary {
  available: boolean;
  /** Last second of the first half on the match clock, when known. */
  halftimeSecond: number | null;
}

const secondOf = (event: Pick<MatchEvent, "minute" | "second">) => event.minute * 60 + event.second;

/**
 * How a fixture's events split into halves:
 * - Clip-derived (video) fixtures have no reliable halves: unavailable. Never split by clip length or a 45' cutoff.
 * - Otherwise the boundary is `fixture.periods.halftimeSecond`, else the latest non-rescinded halftime event.
 * - Without a boundary, explicit event periods still make halves available; with neither, halves are unavailable.
 */
export function periodBoundary(fixture: Pick<MatchFixture, "id" | "events" | "periods">): PeriodBoundary {
  if (isCameraFixture(fixture) || fixture.periods?.source === "video_unknown") return { available: false, halftimeSecond: null };
  if (typeof fixture.periods?.halftimeSecond === "number") return { available: true, halftimeSecond: fixture.periods.halftimeSecond };
  const latest = new Map<string, MatchEvent>();
  for (const event of fixture.events) {
    const previous = latest.get(event.id);
    if (!previous || event.revision >= previous.revision) latest.set(event.id, event);
  }
  const halftime = [...latest.values()].filter((event) => event.type === "halftime" && !event.rescinded).sort((a, b) => secondOf(a) - secondOf(b))[0];
  if (halftime) return { available: true, halftimeSecond: secondOf(halftime) };
  return { available: fixture.events.some((event) => event.period !== undefined), halftimeSecond: null };
}

/**
 * The half an event belongs to. An explicit `event.period` wins. Otherwise events at or before the halftime
 * second are first half (ties go to the first half), so 45+N stoppage time logged before the whistle stays
 * in the first half. Returns undefined when the half cannot be established.
 */
export function eventPeriod(event: MatchEvent, boundary: PeriodBoundary): 1 | 2 | undefined {
  if (!boundary.available) return undefined;
  if (event.period === 1 || event.period === 2) return event.period;
  if (boundary.halftimeSecond === null) return undefined;
  return secondOf(event) <= boundary.halftimeSecond ? 1 : 2;
}

/** Filters already-reconciled events to a period, so late corrections still land in the original half. */
export function filterByPeriod(events: MatchEvent[], period: MatchPeriod, boundary: PeriodBoundary): MatchEvent[] {
  if (period === "full") return events;
  const half = period === "first" ? 1 : 2;
  return events.filter((event) => eventPeriod(event, boundary) === half);
}

/** True when both events are known to be in the same half, or halves are unknown. */
export function sameHalf(a: MatchEvent, b: MatchEvent, boundary: PeriodBoundary): boolean {
  return !boundary.available || eventPeriod(a, boundary) === eventPeriod(b, boundary);
}

/** Whether the selected scope has data to show at `atSecond`: future halves are "not_started", unknown halves "unavailable". */
export function periodScope(fixture: Pick<MatchFixture, "id" | "events" | "periods">, period: MatchPeriod, atSecond: number, boundary = periodBoundary(fixture)): PeriodScope {
  if (period === "full") return { period, available: true };
  if (!boundary.available) return { period, available: false, reason: "unavailable" };
  if (period === "first") return { period, available: true };
  const started = boundary.halftimeSecond !== null
    ? atSecond > boundary.halftimeSecond
    : fixture.events.some((event) => event.period === 2 && secondOf(event) <= atSecond);
  return started ? { period, available: true } : { period, available: false, reason: "not_started" };
}

/** Clock window [start, end] of the selected period, bounded by the analysed watermark. */
export function periodWindow(period: MatchPeriod, boundary: PeriodBoundary, atSecond: number, scopedEvents: MatchEvent[] = []): { start: number; end: number } {
  if (period === "full" || !boundary.available) return { start: 0, end: atSecond };
  const seconds = scopedEvents.map(secondOf);
  const ht = boundary.halftimeSecond;
  if (period === "first") {
    const end = Math.max(ht ?? 0, ...seconds);
    return { start: 0, end: Math.min(atSecond, ht === null && seconds.length === 0 ? atSecond : end) };
  }
  const start = Math.min(atSecond, ht !== null ? ht + 1 : Number.POSITIVE_INFINITY, ...seconds);
  return { start, end: atSecond };
}
