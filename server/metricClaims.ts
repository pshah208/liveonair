import type { Localized } from "../shared/platform.js";
import type { MatchEvent, MatchFixture } from "../shared/types.js";
import { metricOptions, passDifficulty, passDistanceM, shotSpeedKmh } from "../shared/metrics.js";

export const LIVE_METRICS = ["pass_distance", "pass_difficulty", "shot_speed"] as const;
export type LiveMetric = (typeof LIVE_METRICS)[number];

/**
 * Deterministic fact text for a `live_metric` claim. The computed number is written into every language so
 * producer copy such as "a 112 km/h strike" passes the number guard. Returns a reason string when the metric
 * does not apply (wrong event type, no timing data, camera-frame coordinates).
 */
export function liveMetricFact(fixture: MatchFixture, events: MatchEvent[], event: MatchEvent, metric: LiveMetric): { text: Localized } | { reason: string } {
  const options = metricOptions(fixture);
  if (options.camera) return { reason: "Metric unavailable: camera-frame coordinates have no metric scale" };
  const player = [...fixture.home.players, ...fixture.away.players].find((entry) => entry.id === event.playerId)?.name ?? "Unknown player";
  const team = event.teamId === "home" ? fixture.home.name : fixture.away.name;
  const minute = `${event.minute}'`;
  if (metric === "shot_speed") {
    const speed = shotSpeedKmh(event, options);
    if (speed === null) return { reason: event.type === "shot" ? "Shot has no measured speed or flight time" : "shot_speed needs a shot event" };
    const kmh = Math.round(speed);
    return { text: {
      en: `${minute} ${player} struck a shot at ${kmh} km/h for ${team}.`,
      es: `${minute} ${player} disparó a ${kmh} km/h para ${team}.`,
      fr: `${minute} ${player} a frappé à ${kmh} km/h pour ${team}.`,
      pt: `${minute} ${player} chutou a ${kmh} km/h pelo ${team}.`,
    } };
  }
  if (event.type !== "pass" && !(metric === "pass_distance" && event.type === "corner")) return { reason: `${metric} needs a pass event` };
  const distance = passDistanceM(event, options);
  if (distance === null) return { reason: "Pass has no end point" };
  const metres = Math.round(distance);
  if (metric === "pass_distance") {
    return { text: {
      en: `${minute} ${player} played a ${metres} m pass for ${team}.`,
      es: `${minute} ${player} dio un pase de ${metres} m para ${team}.`,
      fr: `${minute} ${player} a joué une passe de ${metres} m pour ${team}.`,
      pt: `${minute} ${player} deu um passe de ${metres} m pelo ${team}.`,
    } };
  }
  const difficulty = passDifficulty(event, events, options);
  if (!difficulty) return { reason: "Pass difficulty unavailable" };
  return { text: {
    en: `${minute} ${player}'s ${metres} m pass for ${team} rated ${difficulty.score}/100 on the published difficulty scale.`,
    es: `${minute} el pase de ${metres} m de ${player} para ${team} tuvo una dificultad de ${difficulty.score}/100 en la escala publicada.`,
    fr: `${minute} la passe de ${metres} m de ${player} pour ${team} est notée ${difficulty.score}/100 sur l'échelle de difficulté publiée.`,
    pt: `${minute} o passe de ${metres} m de ${player} pelo ${team} teve dificuldade ${difficulty.score}/100 na escala publicada.`,
  } };
}
